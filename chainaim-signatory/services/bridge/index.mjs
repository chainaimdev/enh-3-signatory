#!/usr/bin/env node
// S-5 bridge — checks a vLEI-proven invoice (SAID recompute + R-IPEX) and registers it in the contract.
// Run in WSL Ubuntu next to ~/.near-credentials:
//   node bridge/index.mjs [--port 8772] [--config ../config/signatory.json] [--credentials ~/.near-credentials]
//                         [--allow-origin http://127.0.0.1:8765] [--evidence <path>] [--seller-agent jupiterSellerAgent]
//                         [--no-send]
// --evidence: use another evidence file (e.g. a copy with admitSuccess:false for P6).
// --no-send : start without loading the registrar key; /check works, /register answers 503.
//                         [--commits-dir <path>]
//                         [--ap2 on|off]
// --commits-dir: where the off-chain commitment records (with salts) are written; default config commitsPath.
// --ap2 on (change #3, default off): loads Jupiter's ES256 merchant key (config ap2.merchantKeyPath) and serves
//   POST /checkout {said} → the vLEI invoice as a UCP checkout signed as AP2 merchant_authorization (rules must pass).
//   /register then binds the checkout hash into the commitment. With --ap2 off nothing changes.
// Endpoints: GET /health · POST /check {said, tamperField?} (rules only, nothing sent)
//            POST /register {said, tamperField?} → {ok, txHash, txUrl, checks} | {ok:false, reason, checks}
// Change #2 (privacy): /register sends only register_invoice {said, commit}. The commitment record
// (said, payee, amount, buyer agent, salt) is written to the commits dir BEFORE the transaction, so the
// signer can reveal it at payment. LEIs and due date are checked here and never sent.
// Loads only the registrar key. Refusal sends nothing. Evidence is re-read on every request.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, view } from "../../scripts/lib/common.mjs";
import { HttpError, log, startServer } from "../shared/http.mjs";
import { defaultCredentialsDir, isSaid, loadAccount, sendCall, startupChecks, txUrl } from "../shared/near.mjs";
import { buildCheckout, checkoutHash, readAp2Record, signerFromPemFile, signMerchantAuthorization, writeAp2Record } from "../shared/ap2.mjs";
import { buyerAgentAccount, commitmentHex, newSalt, readCommitRecord, writeCommitRecord } from "../shared/commit.mjs";
import { checkInvoice, evidenceInvoices } from "./rules.mjs";

const SERVICE = "bridge";
const { values: flags } = parseArgs({
  options: {
    port: { type: "string" },
    config: { type: "string" },
    credentials: { type: "string" },
    "allow-origin": { type: "string" },
    evidence: { type: "string" },
    "seller-agent": { type: "string" },
    "commits-dir": { type: "string" },
    ap2: { type: "string" },
    "no-send": { type: "boolean", default: false },
  },
});

const cfg = loadConfig(flags.config);
const port = Number(flags.port ?? cfg.ports?.bridge ?? 8772);
const allowOrigin = flags["allow-origin"] ?? cfg.allowOrigin;
const credentialsDir = flags.credentials ?? defaultCredentialsDir();
const evidencePath = flags.evidence ? resolve(flags.evidence) : cfg.paths.evidence;
const sellerAgent = flags["seller-agent"] ?? cfg.sellerAgent ?? "jupiterSellerAgent";
const network = cfg.network || "testnet";
const noSend = flags["no-send"];
const REGISTRAR = cfg.accounts.registrar;
const BUYER_AGENT = buyerAgentAccount(cfg.accounts);
const commitsDir = flags["commits-dir"] ? resolve(flags["commits-dir"]) : cfg.paths.commits;
const GAS_REGISTER_TGAS = 30;

if (!commitsDir) {
  console.error("bridge: no commits dir (set commitsPath in config/signatory.json or pass --commits-dir)");
  process.exit(64);
}
const ap2On = (flags.ap2 ?? "off") === "on";
if (!["on", "off"].includes(flags.ap2 ?? "off")) {
  console.error("bridge: --ap2 must be on or off");
  process.exit(64);
}
const ap2Dir = cfg.paths.ap2Records;
const checkoutTtlMs = Number(cfg.ap2?.checkoutTtlMinutes ?? 15) * 60000;
let merchant = null; // ES256 signer (loaded in main when --ap2 on)

/** The checkout hash to bind into a new commitment: from this invoice's signed checkout record, if there is one. */
function checkoutHashFor(said) {
  if (!ap2Dir) return "";
  const co = readAp2Record(ap2Dir, said, "checkout");
  return co?.checkoutHash ?? "";
}

/** The existing local record for this reveal, or a new one with a fresh salt (not yet written). */
function commitRecordFor(reveal) {
  const coHash = checkoutHashFor(reveal.said);
  const existing = readCommitRecord(commitsDir, reveal.said);
  if (existing) {
    if (existing.payee !== reveal.payee || existing.amountUnits !== reveal.amountUnits || existing.buyerAgent !== BUYER_AGENT || (existing.checkoutHash || "") !== coHash) {
      throw new HttpError(409, `a commitment record for ${reveal.said} exists with different payee, amount, buyer agent or checkout`);
    }
    return { rec: existing, isNew: false };
  }
  const rec = { said: reveal.said, payee: reveal.payee, amountUnits: reveal.amountUnits, buyerAgent: BUYER_AGENT, salt: newSalt(), checkoutHash: coHash };
  rec.commit = commitmentHex(rec);
  return { rec: { ...rec, contractId: cfg.contractId, createdAt: new Date().toISOString() }, isNew: true };
}

let registrar = null;

function loadEvidence() {
  try {
    return JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch (e) {
    throw new HttpError(503, `evidence not readable at ${evidencePath} (${e.code || "invalid JSON"})`);
  }
}

function runChecks(body) {
  if (!isSaid(body.said)) throw new HttpError(400, "said must be a SAID string");
  if (body.tamperField !== undefined && typeof body.tamperField !== "string") {
    throw new HttpError(400, "tamperField must be a string (an invoice attribute, e.g. paymentWalletAddress)");
  }
  try {
    return checkInvoice(loadEvidence(), {
      said: body.said,
      tamperField: body.tamperField,
      payee: cfg.accounts.payee,
      network,
      sellerAgent,
      decimals: cfg.tokenDecimals,
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, e.message);
  }
}

const routes = {
  "GET /health": async () => {
    let evidence = null;
    try {
      const ev = loadEvidence();
      evidence = { generatedAt: ev.generatedAt, invoices: evidenceInvoices(ev).map((i) => i.said) };
    } catch (e) {
      evidence = { error: e.message };
    }
    return [200, { ok: true, service: SERVICE, network, contractId: cfg.contractId, registrar: REGISTRAR, sellerAgent, buyerAgent: BUYER_AGENT, evidencePath, commitsDir, evidence, keysLoaded: !noSend, ap2: ap2On ? { merchantKid: merchant?.kid ?? null } : "off" }]; // 0b: ap2
  },

  "POST /check": async (body) => {
    const c = runChecks(body);
    const onChain = c.demo ? undefined : await view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said: body.said });
    const { reveal, ...rest } = c;
    const wouldRegister = reveal
      ? { said: reveal.said, onChain: "commit only (sha256 with a fresh random salt, computed at /register)", offChain: { payee: reveal.payee, amountUnits: reveal.amountUnits, buyerAgent: BUYER_AGENT } }
      : undefined;
    return [200, { ...rest, ...(wouldRegister ? { wouldRegister } : {}), ...(onChain !== undefined ? { onChain } : {}) }];
  },

  // change #3: Jupiter signs the vLEI invoice as a UCP checkout (AP2 merchant_authorization). Nothing goes on-chain.
  "POST /checkout": async (body) => {
    if (!ap2On) throw new HttpError(501, "bridge started without --ap2 on");
    if (body.tamperField !== undefined) throw new HttpError(400, "a tampered invoice is never signed as a checkout");
    const c = runChecks(body);
    const { reveal, ...rest } = c;
    if (!c.ok) return [422, { ...rest, ok: false, signed: false }];
    const existing = readAp2Record(ap2Dir, reveal.said, "checkout");
    const inv = existing?.checkout?.["dev.chainaim.invoice"];
    if (existing && inv?.payTo === reveal.payee && inv?.amountUnits === reveal.amountUnits && Date.parse(existing.checkout.expires_at) > Date.now()) {
      return [200, { ok: true, said: reveal.said, reused: true, kid: existing.kid, checkoutHash: existing.checkoutHash, checkout: existing.checkout, merchant_authorization: existing.merchantAuthorization }];
    }
    if (readCommitRecord(commitsDir, reveal.said)) {
      throw new HttpError(409, `${reveal.said} is already committed without this checkout; a new checkout cannot be bound to it`);
    }
    const checkout = buildCheckout({
      said: reveal.said,
      invoiceNumber: rest.info?.invoiceNumber ?? reveal.said,
      payee: reveal.payee,
      amountUnits: reveal.amountUnits,
      decimals: cfg.tokenDecimals,
      demoScale: cfg.demoScale,
      network,
      asset: cfg.token,
      contract: cfg.contractId,
      expiresAt: new Date(Date.now() + checkoutTtlMs).toISOString(),
    });
    const merchantAuthorization = signMerchantAuthorization(checkout, merchant);
    const rec = { said: reveal.said, kid: merchant.kid, checkoutHash: checkoutHash(checkout), checkout, merchantAuthorization, createdAt: new Date().toISOString() };
    writeAp2Record(ap2Dir, reveal.said, "checkout", rec);
    return [200, { ok: true, said: reveal.said, reused: false, kid: rec.kid, checkoutHash: rec.checkoutHash, checkout, merchant_authorization: merchantAuthorization }];
  },

  "POST /register": async (body) => {
    const c = runChecks(body);
    const { reveal, ...rest } = c;
    if (!c.ok) return [422, { ...rest, ok: false, sent: false }];
    if (noSend) throw new HttpError(503, "bridge started with --no-send (no key loaded); checks passed, nothing sent");
    const existing = await view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said: body.said });
    if (existing) {
      const local = readCommitRecord(commitsDir, body.said);
      const commitRecord = !local ? "missing" : local.commit === existing.commit ? "matches" : "differs";
      return [200, { ...rest, ok: true, sent: false, alreadyRegistered: true, commitRecord, invoice: existing }];
    }
    const { rec, isNew } = commitRecordFor(reveal);
    // Written before the transaction: if the tx succeeds, the signer can always reveal it.
    if (isNew) writeCommitRecord(commitsDir, rec);
    const r = await sendCall(registrar, {
      receiverId: cfg.contractId,
      method: "register_invoice",
      args: { said: rec.said, commit: rec.commit },
      gasTgas: GAS_REGISTER_TGAS,
    });
    const base = { ...rest, txHash: r.txHash, txUrl: txUrl(cfg, r.txHash) };
    if (!r.ok) return [422, { ...base, ok: false, sent: true, reason: `contract: ${r.error}` }];
    const invoice = await view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said: body.said });
    return [200, { ...base, ok: true, sent: true, invoice }];
  },
};

async function main() {
  await startupChecks(cfg, { expectRegistrar: REGISTRAR });
  loadEvidence();
  if (ap2On) {
    if (!ap2Dir) throw new Error("config ap2.recordsPath missing (needed with --ap2 on)");
    merchant = signerFromPemFile(cfg.paths.ap2MerchantKey, "AP2 merchant key");
  }
  if (!noSend) registrar = await loadAccount({ credentialsDir, network, accountId: REGISTRAR, rpcUrl: cfg.rpcUrl });
  log(SERVICE, { event: "ready", contractId: cfg.contractId, registrar: REGISTRAR, evidencePath, commitsDir, sellerAgent, keysLoaded: !noSend, ap2: ap2On ? { merchantKid: merchant.kid } : "off", allowOrigin });
  startServer({ service: SERVICE, port, allowOrigin, routes });
}

main().catch((e) => {
  log(SERVICE, { event: "startup_failed", error: e.message });
  process.exit(1);
});
