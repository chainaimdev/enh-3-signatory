// AP2 mandates over UCP checkout for Signatory (change #3, 2026-11-14).
// Port of chainaim-private-ai packages/ap2/src/index.ts (privateAI-design-33 ARCH-626): JCS (RFC 8785), JWS with
// detached content (RFC 7515 Appendix F) in ES256 / IEEE P1363 form, EC P-256 JWK with RFC 7638 thumbprint key ids,
// and the UCP AP2 error codes. AP2 v0.2 allows ECDSA only (ES256/ES384/ES512); ES256 is implemented.
//
// Signatory use:
//   * checkout (merchant side, signed by Jupiter's key in the bridge): the vLEI invoice as a UCP checkout, with a
//     `dev.chainaim.invoice` block binding said, payee, amount, network, token and the mandate contract.
//   * payment mandate (buyer side, signed by the buyer agent's key in the signer) over the checkout hash and the same
//     payment fields. The mandate object is ChainAim's (same JWS scheme as the merchant authorization); its field names
//     are not taken from an AP2 schema.
//   * receipt hash = sha256(JCS({checkout_hash, merchant_authorization_sha256, mandate_sha256})) goes on-chain with the
//     payment; the full bundle stays off-chain (private/ap2). The checkout hash is also inside the invoice commitment (#2).
// Nothing here logs. Error messages name fields and codes, never a key or a payload.
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const AP2_CAPABILITY = "dev.ucp.common.payment.ap2_mandate";
export const UCP_VERSION = "2026-08-25";
export const AP2_ERROR_CODES = [
  "mandate_required",
  "agent_missing_key",
  "mandate_invalid_signature",
  "mandate_expired",
  "mandate_scope_mismatch",
  "merchant_authorization_invalid",
  "merchant_authorization_missing",
];
export const AP2_ALGS = ["ES256"];
export const MANDATE_TYPE = "chainaim.signatory.payment_mandate";
/** UCP payment handler name (reverse-domain style, ours; informational for the agent, like design-33's x402.near.exact). */
export const PAYMENT_HANDLER = "dev.chainaim.near.signatory_mandate";

// ---- JCS (RFC 8785) — identical to packages/ap2 ------------------------------------------------------------------------

export function jcs(value, path = "$") {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error(`${path} is not a finite number`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v, i) => jcs(v, `${path}[${i}]`)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error(`${path} is not a plain object`);
      const names = Object.keys(value).sort();
      return `{${names.map((n) => `${JSON.stringify(n)}:${jcs(value[n], `${path}.${n}`)}`).join(",")}}`;
    }
    default:
      throw new Error(`${path} is ${typeof value}, which has no JSON form`);
  }
}

// ---- base64url ----------------------------------------------------------------------------------------------------------

export const B64URL = /^[A-Za-z0-9_-]*$/;
export const b64u = (data) => Buffer.from(typeof data === "string" ? Buffer.from(data, "utf8") : data).toString("base64url");
export function fromB64u(s) {
  if (!B64URL.test(s)) throw new Error("not base64url");
  return Buffer.from(s, "base64url");
}
export const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// ---- keys — identical to packages/ap2 -----------------------------------------------------------------------------------

export function thumbprintInput(jwk) {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}
export function kidOf(jwk) {
  return createHash("sha256").update(thumbprintInput(jwk), "utf8").digest("hex").slice(0, 32);
}
function assertP256(key, what) {
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error(`${what} must be an EC P-256 key (ES256)`);
}
export function publicJwkOf(key) {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  assertP256(pub, "the key");
  const j = pub.export({ format: "jwk" });
  if (j.kty !== "EC" || j.crv !== "P-256" || typeof j.x !== "string" || typeof j.y !== "string") throw new Error("the key could not be exported as an EC P-256 JWK");
  return { kid: kidOf({ crv: j.crv, kty: j.kty, x: j.x, y: j.y }), kty: "EC", crv: "P-256", x: j.x, y: j.y, use: "sig", alg: "ES256" };
}
export function keyFromJwk(jwk) {
  const j = jwk;
  if (typeof j !== "object" || j === null) throw new Error("the key must be a JWK object");
  if (j.kty !== "EC" || j.crv !== "P-256") throw new Error("the key must be kty EC, crv P-256");
  for (const m of ["x", "y"]) {
    if (typeof j[m] !== "string" || !B64URL.test(j[m]) || fromB64u(j[m]).length !== 32) throw new Error(`the key's ${m} must be 32 bytes, base64url`);
  }
  if (j.use !== undefined && j.use !== "sig") throw new Error("the key's use must be sig");
  if (j.alg !== undefined && j.alg !== "ES256") throw new Error("the key's alg must be ES256");
  if ("d" in j) throw new Error("the key is a private key; only public keys are published or pinned");
  const kid = kidOf({ crv: "P-256", kty: "EC", x: j.x, y: j.y });
  if (j.kid !== kid) throw new Error("the key's kid is not its RFC 7638 thumbprint id");
  let key;
  try {
    key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: j.x, y: j.y }, format: "jwk" });
  } catch {
    throw new Error("the key is not a point on P-256");
  }
  return { kid, key };
}
export function signerFromKey(privateKey) {
  if (privateKey.type !== "private") throw new Error("the AP2 signing key must be a private key");
  assertP256(privateKey, "the AP2 signing key");
  const publicJwk = publicJwkOf(privateKey);
  return {
    kid: publicJwk.kid,
    alg: "ES256",
    publicJwk,
    signBytes: (data) => sign("sha256", Buffer.from(data, "ascii"), { key: privateKey, dsaEncoding: "ieee-p1363" }),
  };
}

/** Signer from a PKCS#8 PEM P-256 private key file (written by scripts/ap2-keys.mjs). Errors name the file only. */
export function signerFromPemFile(path, what) {
  if (!path || !existsSync(path)) throw new Error(`${what}: key file not found at ${path} (create it with: node scripts/ap2-keys.mjs --party ...)`);
  let key;
  try {
    key = createPrivateKey({ key: readFileSync(path, "utf8"), format: "pem" });
  } catch {
    throw new Error(`${what}: ${path} is not a PEM private key`);
  }
  return signerFromKey(key);
}

/** A pinned public JWK file, checked by keyFromJwk. Returns the JWK object. */
export function readPublicJwkFile(path, what) {
  if (!path || !existsSync(path)) throw new Error(`${what}: public key file not found at ${path}`);
  const jwk = JSON.parse(readFileSync(path, "utf8"));
  keyFromJwk(jwk);
  return jwk;
}

// ---- detached JWS — the packages/ap2 construction, used for both the checkout and the mandate -------------------------

export const DETACHED_JWS = /^([A-Za-z0-9_-]+)\.\.([A-Za-z0-9_-]+)$/;

export function signDetached(payloadObj, signer) {
  const header = b64u(jcs({ alg: signer.alg, kid: signer.kid }));
  const payload = b64u(jcs(payloadObj));
  return `${header}..${b64u(signer.signBytes(`${header}.${payload}`))}`;
}

/**
 * Verifies a detached JWS over payloadObj with one of `keys` (public JWKs). Same rules as packages/ap2
 * verifyMerchantAuthorization: header of exactly alg + kid, alg in allowedAlgs, known kid, 64-byte signature.
 * missingCode / invalidCode select the AP2 error codes for the merchant or the mandate side.
 */
export function verifyDetached(jws, payloadObj, keys, { missingCode, invalidCode, what }, allowedAlgs = AP2_ALGS) {
  const bad = (reason) => ({ ok: false, code: invalidCode, reason });
  if (jws === undefined || jws === null || jws === "") return { ok: false, code: missingCode, reason: `no ${what}` };
  if (typeof jws !== "string") return bad(`${what} must be a string`);
  const m = DETACHED_JWS.exec(jws);
  if (!m) return bad(`${what} must be a detached JWS <header>..<signature>`);
  let header;
  try {
    header = JSON.parse(fromB64u(m[1]).toString("utf8"));
  } catch {
    return bad("the JWS header is not base64url JSON");
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) return bad("the JWS header must be a JSON object");
  const members = Object.keys(header).sort();
  if (members.length !== 2 || members[0] !== "alg" || members[1] !== "kid") return bad("the JWS header must hold exactly alg and kid");
  if (!allowedAlgs.includes(header.alg)) return bad(`the JWS alg must be one of ${allowedAlgs.join(", ")}`);
  if (typeof header.kid !== "string" || header.kid === "") return bad("the JWS kid must be a non-empty string");
  let key;
  for (const k of keys) {
    let parsed;
    try {
      parsed = keyFromJwk(k);
    } catch {
      continue;
    }
    if (parsed.kid === header.kid) {
      key = parsed.key;
      break;
    }
  }
  if (!key) return bad("the JWS kid names no key this verifier holds");
  const sig = fromB64u(m[2]);
  if (sig.length !== 64) return bad("the ES256 signature must be 64 bytes (IEEE P1363 r||s)");
  let payload;
  try {
    payload = b64u(jcs(payloadObj));
  } catch (e) {
    return bad(`the payload has no JCS form: ${e.message}`);
  }
  const ok = verify("sha256", Buffer.from(`${m[1]}.${payload}`, "ascii"), { key, dsaEncoding: "ieee-p1363" }, sig);
  if (!ok) return bad(`the ${what} signature does not verify`);
  return { ok: true, kid: header.kid, alg: header.alg };
}

/** The value a merchant authorization signs: the checkout with its `ap2` member removed (UCP AP2). */
export function checkoutPayload(checkout) {
  if (typeof checkout !== "object" || checkout === null || Array.isArray(checkout)) throw new Error("the checkout must be a JSON object");
  const { ap2: _ap2, ...rest } = checkout;
  return rest;
}
export const signMerchantAuthorization = (checkout, signer) => signDetached(checkoutPayload(checkout), signer);
export const verifyMerchantAuthorization = (auth, checkout, keys) =>
  verifyDetached(auth, checkoutPayload(checkout), keys, { missingCode: "merchant_authorization_missing", invalidCode: "merchant_authorization_invalid", what: "merchant_authorization" });
export const checkoutHash = (checkout) => sha256Hex(jcs(checkoutPayload(checkout)));

// ---- Signatory checkout and payment mandate ------------------------------------------------------------------------------

/** cents of the real (demo-scaled) USD value: units × demoScale × 100 / 10^decimals, exact or refused. */
export function realCents(amountUnits, decimals, demoScale) {
  const num = BigInt(amountUnits) * BigInt(demoScale) * 100n;
  const den = 10n ** BigInt(decimals);
  if (num % den !== 0n) throw new Error("amount does not scale to whole cents");
  const c = num / den;
  if (c > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("amount too large for a JSON number of cents");
  return Number(c);
}

export function buildCheckout({ said, invoiceNumber, payee, amountUnits, decimals, demoScale, network, asset, contract, expiresAt }) {
  const cents = realCents(amountUnits, decimals, demoScale);
  const totals = [
    { type: "subtotal", amount: cents },
    { type: "total", amount: cents },
  ];
  return {
    ucp: {
      version: UCP_VERSION,
      capabilities: { "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }], [AP2_CAPABILITY]: [{ version: UCP_VERSION }] },
      payment_handlers: { [PAYMENT_HANDLER]: [{ id: "signatory_mandate_contract", version: UCP_VERSION }] },
    },
    id: said,
    status: "ready_for_complete",
    currency: "USD",
    line_items: [{ id: "invoice", quantity: 1, item: { id: `chainaim.signatory.${invoiceNumber}`, title: `Invoice ${invoiceNumber}`, price: cents }, totals }],
    totals,
    expires_at: expiresAt,
    "dev.chainaim.invoice": {
      said,
      invoiceNumber,
      network: `near:${network}`,
      asset,
      contract,
      payTo: payee,
      amountUnits: String(amountUnits),
      decimals,
      demoScale,
    },
  };
}

/**
 * The buyer agent's checks before signing a mandate. Returns {ok:true, kid, invoice} or {ok:false, code, reason}.
 * expect = {said, payee, network, asset, contract, maxUnits?}; now = Date.
 */
export function checkCheckoutForMandate(checkout, merchantAuthorization, merchantKeys, expect, now = new Date()) {
  const v = verifyMerchantAuthorization(merchantAuthorization, checkout, merchantKeys);
  if (!v.ok) return v;
  const scope = (reason) => ({ ok: false, code: "mandate_scope_mismatch", reason });
  const inv = checkout["dev.chainaim.invoice"];
  if (!inv || typeof inv !== "object") return scope("checkout has no dev.chainaim.invoice block");
  if (checkout.id !== expect.said || inv.said !== expect.said) return scope("checkout is for another invoice");
  if (inv.payTo !== expect.payee) return scope("checkout payTo is not the configured payee");
  if (inv.network !== `near:${expect.network}`) return scope("checkout network differs");
  if (inv.asset !== expect.asset) return scope("checkout asset is not the configured token");
  if (inv.contract !== expect.contract) return scope("checkout names another mandate contract");
  if (!/^[0-9]+$/.test(inv.amountUnits) || BigInt(inv.amountUnits) <= 0n) return scope("checkout amountUnits must be a positive integer");
  if (expect.maxUnits !== undefined && BigInt(inv.amountUnits) > BigInt(expect.maxUnits)) return scope("checkout amount exceeds this agent's mandate ceiling");
  const exp = Date.parse(checkout.expires_at);
  if (!Number.isFinite(exp)) return scope("checkout expires_at is not a date");
  if (exp <= now.getTime()) return { ok: false, code: "mandate_expired", reason: "the checkout has expired" };
  return { ok: true, kid: v.kid, invoice: inv };
}

export function buildPaymentMandate({ checkout, merchantKid, payer, createdAt }) {
  const inv = checkout["dev.chainaim.invoice"];
  return {
    type: MANDATE_TYPE,
    version: "1",
    checkout_id: checkout.id,
    checkout_hash: checkoutHash(checkout),
    merchant_kid: merchantKid,
    said: inv.said,
    payer,
    payee: inv.payTo,
    amount_units: inv.amountUnits,
    network: inv.network,
    asset: inv.asset,
    contract: inv.contract,
    created_at: createdAt,
  };
}
export const signMandate = (mandate, signer) => signDetached(mandate, signer);
export const verifyMandate = (jws, mandate, keys) =>
  verifyDetached(jws, mandate, keys, { missingCode: "mandate_required", invalidCode: "mandate_invalid_signature", what: "payment mandate" });

/** On-chain receipt hash: binds the checkout, the merchant signature and the mandate. */
export function receiptHash({ checkoutHashHex, merchantAuthorization, mandate }) {
  return sha256Hex(jcs({ checkout_hash: checkoutHashHex, merchant_authorization_sha256: sha256Hex(merchantAuthorization), mandate_sha256: sha256Hex(jcs(mandate)) }));
}

// ---- off-chain records (private/ap2, git-ignored) -------------------------------------------------------------------------

const SAID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const KINDS = ["checkout", "mandate", "receipt"];
function recPath(dir, said, kind) {
  if (!SAID_RE.test(said)) throw new Error("ap2 record: said must be base64url, 1..128 characters");
  if (!KINDS.includes(kind)) throw new Error(`ap2 record: kind must be one of ${KINDS.join(", ")}`);
  return join(dir, `${said}.${kind}.json`);
}
export function readAp2Record(dir, said, kind) {
  const p = recPath(dir, said, kind);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
export function writeAp2Record(dir, said, kind, rec) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(recPath(dir, said, kind), JSON.stringify(rec, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  return rec;
}
