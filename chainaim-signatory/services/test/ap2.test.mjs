// Change #3: AP2 checkout (merchant) + payment mandate (buyer agent), ES256 / JCS / detached JWS. No files, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  buildCheckout,
  buildPaymentMandate,
  checkCheckoutForMandate,
  checkoutHash,
  jcs,
  kidOf,
  keyFromJwk,
  publicJwkOf,
  realCents,
  receiptHash,
  sha256Hex,
  signerFromKey,
  signMandate,
  signMerchantAuthorization,
  verifyMandate,
  verifyMerchantAuthorization,
} from "../shared/ap2.mjs";

const newSigner = () => signerFromKey(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
const merchant = newSigner();
const buyer = newSigner();
const SAID = "EF2xJE7wjseUicFCAR5vHx9lddlrfo31Sy0_vcTh7Qzh";
const EXPECT = {
  said: SAID,
  payee: "chainaim-jupiter-payee.testnet",
  network: "testnet",
  asset: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  contract: "chainaim-signatory-v2.testnet",
};
const later = new Date(Date.now() + 15 * 60000).toISOString();
const co = (over = {}) =>
  buildCheckout({ said: SAID, invoiceNumber: "INV-2026-0017", payee: EXPECT.payee, amountUnits: "84000", decimals: 6, demoScale: 1000000, network: "testnet", asset: EXPECT.asset, contract: EXPECT.contract, expiresAt: later, ...over });

test("JCS sorts members and refuses values with no JSON form", () => {
  assert.equal(jcs({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => jcs({ a: undefined }), /\$\.a is undefined/);
  assert.throws(() => jcs({ a: 1n }), /bigint/);
  assert.throws(() => jcs({ a: Infinity }), /finite/);
});

test("key ids are RFC 7638 thumbprint ids; a relabelled or private key is refused", () => {
  const jwk = merchant.publicJwk;
  assert.equal(jwk.kid, kidOf(jwk));
  assert.equal(keyFromJwk(jwk).kid, jwk.kid);
  assert.throws(() => keyFromJwk({ ...jwk, kid: "0".repeat(32) }), /thumbprint/);
  assert.throws(() => keyFromJwk({ ...jwk, d: "x" }), /private key/);
  assert.equal(publicJwkOf(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey).alg, "ES256");
});

test("checkout: real cents from the demo scale, invoice block binds payee, amount, token and contract", () => {
  assert.equal(realCents("84000", 6, 1000000), 8400000); // 0.084 USDC on-chain = $84,000.00
  assert.equal(realCents("157500", 6, 1000000), 15750000);
  const c = co();
  assert.equal(c.id, SAID);
  assert.equal(c.totals[1].amount, 8400000);
  assert.deepEqual(c["dev.chainaim.invoice"], {
    said: SAID, invoiceNumber: "INV-2026-0017", network: "near:testnet", asset: EXPECT.asset, contract: EXPECT.contract,
    payTo: EXPECT.payee, amountUnits: "84000", decimals: 6, demoScale: 1000000,
  });
});

test("merchant authorization: signs, verifies with the pinned key, refuses tampering and unknown keys", () => {
  const c = co();
  const auth = signMerchantAuthorization(c, merchant);
  assert.match(auth, /^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(verifyMerchantAuthorization(auth, c, [merchant.publicJwk]), { ok: true, kid: merchant.kid, alg: "ES256" });
  // an `ap2` member is not part of the signed bytes (UCP AP2)
  assert.equal(verifyMerchantAuthorization(auth, { ...c, ap2: { merchant_authorization: auth } }, [merchant.publicJwk]).ok, true);
  const tampered = co({ payee: "attacker.testnet" });
  assert.equal(verifyMerchantAuthorization(auth, tampered, [merchant.publicJwk]).code, "merchant_authorization_invalid");
  assert.equal(verifyMerchantAuthorization(auth, c, [buyer.publicJwk]).code, "merchant_authorization_invalid", "wrong key");
  assert.equal(verifyMerchantAuthorization("", c, [merchant.publicJwk]).code, "merchant_authorization_missing");
  assert.equal(checkoutHash(c), sha256Hex(jcs(c)));
});

test("buyer checks before signing: payee, token, contract, network, invoice and expiry", () => {
  const c = co();
  const auth = signMerchantAuthorization(c, merchant);
  const ok = checkCheckoutForMandate(c, auth, [merchant.publicJwk], EXPECT);
  assert.equal(ok.ok, true);
  assert.equal(ok.kid, merchant.kid);
  for (const [over, why] of [
    [{ payee: "someone.testnet" }, "payee"],
    [{ asset: "fake-usdc.testnet" }, "asset"],
    [{ contract: "other.testnet" }, "contract"],
    [{ network: "mainnet" }, "network"],
  ]) {
    const x = co(over);
    const r = checkCheckoutForMandate(x, signMerchantAuthorization(x, merchant), [merchant.publicJwk], EXPECT);
    assert.equal(r.code, "mandate_scope_mismatch", why);
  }
  const other = { ...EXPECT, said: "Eother" };
  assert.equal(checkCheckoutForMandate(c, auth, [merchant.publicJwk], other).code, "mandate_scope_mismatch");
  const old = co({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal(checkCheckoutForMandate(old, signMerchantAuthorization(old, merchant), [merchant.publicJwk], EXPECT).code, "mandate_expired");
  // a checkout signed by a key that is not the pinned merchant key
  assert.equal(checkCheckoutForMandate(c, signMerchantAuthorization(c, buyer), [merchant.publicJwk], EXPECT).code, "merchant_authorization_invalid");
});

test("payment mandate: binds the checkout hash and payment fields, verifies, and the receipt hash binds all three", () => {
  const c = co();
  const auth = signMerchantAuthorization(c, merchant);
  const m = buildPaymentMandate({ checkout: c, merchantKid: merchant.kid, payer: "chainaim-tommy-buyer-agent.testnet", createdAt: "2026-11-14T00:00:00.000Z" });
  assert.equal(m.checkout_hash, checkoutHash(c));
  assert.equal(m.amount_units, "84000");
  assert.equal(m.payee, EXPECT.payee);
  const jws = signMandate(m, buyer);
  assert.equal(verifyMandate(jws, m, [buyer.publicJwk]).ok, true);
  assert.equal(verifyMandate(jws, { ...m, amount_units: "84001" }, [buyer.publicJwk]).code, "mandate_invalid_signature");
  assert.equal(verifyMandate(undefined, m, [buyer.publicJwk]).code, "mandate_required");
  const r1 = receiptHash({ checkoutHashHex: m.checkout_hash, merchantAuthorization: auth, mandate: m });
  assert.match(r1, /^[0-9a-f]{64}$/);
  assert.notEqual(r1, receiptHash({ checkoutHashHex: m.checkout_hash, merchantAuthorization: auth, mandate: { ...m, payer: "x.testnet" } }));
  assert.notEqual(r1, receiptHash({ checkoutHashHex: "00".repeat(32), merchantAuthorization: auth, mandate: m }));
});
