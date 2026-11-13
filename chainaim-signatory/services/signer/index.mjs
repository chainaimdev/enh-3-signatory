#!/usr/bin/env node
// S-4 signer — sends transactions for the buyer agent (pay) and the CPO (approve/reject/revoke).
// Run in WSL Ubuntu next to ~/.near-credentials:
//   node signer/index.mjs [--port 8771] [--config ../config/signatory.json] [--credentials ~/.near-credentials]
//                         [--allow-origin http://127.0.0.1:8765] [--gas-tgas 150] [--no-send]
//                         [--commits-dir <path>]
// --no-send: start without loading keys (health/CORS testing); every action answers 503.
// --commits-dir: off-chain commitment records written by the bridge (default config commitsPath).
// Endpoints: GET /health · POST /pay {said, receiptHash?} · /approve {said} · /reject {said} · /revoke {account}
// Change #2 (privacy): /pay reads amount, payee and salt from the bridge's commitment record (they are not
// on-chain before payment) and reveals them in the ft_transfer_call msg; the contract re-checks the commitment.
// Change #3 [--ap2 on|off, default off]: loads the buyer agent's ES256 key and Jupiter's pinned public JWK.
//   POST /mandate {said, checkout, merchantAuthorization}: verifies the merchant signature with the PINNED key (never one
//   sent with the request) and the payment fields, then signs the payment mandate (AP2 error codes on refusal).
//   /pay then requires that mandate (mandate_required), checks it matches the commitment (amount, payee, checkout hash),
//   sends its receipt hash on-chain, and writes the receipt bundle (checkout, signatures, tx) to private/ap2.
// Response: {ok, txHash, txUrl, outcome?} or {ok:false, error} (contract error verbatim).
// Loads only the buyer-agent and CPO keys. Binds 127.0.0.1. Never returns or logs keys.
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, view } from "../../scripts/lib/common.mjs";
import {
  buildPaymentMandate,
  checkCheckoutForMandate,
  readAp2Record,
  readPublicJwkFile,
  receiptHash as ap2ReceiptHash,
  sha256Hex,
  jcs,
  signerFromPemFile,
  signMandate,
  writeAp2Record,
} from "../shared/ap2.mjs";
import { isHex64, readCommitRecord } from "../shared/commit.mjs";
import { HttpError, log, startServer } from "../shared/http.mjs";
import {
  defaultCredentialsDir,
  isAccountId,
  isSaid,
  lastEvent,
  loadAccount,
  sendCall,
  startupChecks,
  txUrl,
} from "../shared/near.mjs";

const SERVICE = "signer";
const { values: flags } = parseArgs({
  options: {
    port: { type: "string" },
    config: { type: "string" },
    credentials: { type: "string" },
    "allow-origin": { type: "string" },
    "gas-tgas": { type: "string" },
    "commits-dir": { type: "string" },
    ap2: { type: "string" },
    "no-send": { type: "boolean", default: false },
  },
});

const cfg = loadConfig(flags.config);
const port = Number(flags.port ?? cfg.ports?.signer ?? 8771);
const allowOrigin = flags["allow-origin"] ?? cfg.allowOrigin;
const gasTgas = Number(flags["gas-tgas"] ?? cfg.gasTgas ?? 150);
const credentialsDir = flags.credentials ?? defaultCredentialsDir();
const network = cfg.network || "testnet";
const noSend = flags["no-send"];
const commitsDir = flags["commits-dir"] ? resolve(flags["commits-dir"]) : cfg.paths.commits;

if (!commitsDir) {
  console.error("signer: no commits dir (set commitsPath in config/signatory.json or pass --commits-dir)");
  process.exit(64);
}
if (!["on", "off"].includes(flags.ap2 ?? "off")) {
  console.error("signer: --ap2 must be on or off");
  process.exit(64);
}
const ap2On = (flags.ap2 ?? "off") === "on";
const ap2Dir = cfg.paths.ap2Records;
let buyerAp2 = null; // ES256 signer of the buyer agent (loaded in main when --ap2 on)
let merchantJwk = null; // Jupiter's pinned public JWK

if (!Number.isInteger(gasTgas) || gasTgas < 100 || gasTgas > 300) {
  console.error(`signer: --gas-tgas must be an integer 100..300 (S-2a #7), got ${flags["gas-tgas"]}`);
  process.exit(64);
}

const byRole = (role) => {
  const list = Object.entries(cfg.accounts.aliases).filter(([, e]) => e.role === role);
  if (list.length !== 1) throw new Error(`accounts.json must have exactly one alias with role ${role}`);
  return { alias: list[0][0], account: list[0][1].account };
};
const AGENT = byRole("buyer_agent");
const CPO = byRole("cpo");

const PAY_EVENTS = ["paid", "payment_pending", "payment_refused"];

let agent = null;
let cpo = null;
let token = null;

function requireSend() {
  if (noSend) throw new HttpError(503, "signer started with --no-send (no keys loaded)");
}

function requireSaid(body) {
  if (!isSaid(body.said)) throw new HttpError(400, "said must be a SAID string");
  return body.said;
}

/** Common reply for a contract call. */
function reply(r, extra = {}) {
  const base = { txHash: r.txHash, txUrl: txUrl(cfg, r.txHash) };
  if (!r.ok) {
    const contractError = r.failures.find((f) => f.executor === cfg.contractId)?.error;
    return [422, { ok: false, ...base, error: r.error || contractError || "transaction failed", ...extra }];
  }
  return [200, { ok: true, ...base, ...extra }];
}

const routes = {
  "GET /health": async () => [
    200,
    {
      ok: true,
      service: SERVICE,
      network,
      contractId: cfg.contractId,
      token: cfg.token,
      tokenSymbol: token?.symbol,
      agent: AGENT.account,
      approver: CPO.account,
      gasTgas,
      commitsDir,
      keysLoaded: !noSend,
    },
  ],

  "POST /pay": async (body) => {
    const said = requireSaid(body);
    if (body.receiptHash !== undefined && !isHex64(body.receiptHash)) {
      throw new HttpError(400, "receiptHash must be 64 lowercase hex characters (sha256)");
    }
    requireSend();
    const inv = await view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said });
    if (!inv) return [422, { ok: false, error: "invoice not registered" }];
    let rec;
    try {
      rec = readCommitRecord(commitsDir, said);
    } catch (e) {
      return [409, { ok: false, error: e.message }];
    }
    if (!rec) return [409, { ok: false, error: `no commitment record for ${said} in ${commitsDir} (it is written by the bridge at /register)` }];
    if (rec.commit !== inv.commit) return [409, { ok: false, error: "local commitment record does not match the contract's commit" }];
    if (rec.buyerAgent !== AGENT.account) return [409, { ok: false, error: `commitment names buyer agent ${rec.buyerAgent}, signer pays as ${AGENT.account}` }];
    // change #3: with --ap2 on the agent pays only under a signed mandate that matches the commitment
    const md = ap2Dir ? readAp2Record(ap2Dir, said, "mandate") : null;
    if (ap2On && !md) return [409, { ok: false, code: "mandate_required", error: `no signed payment mandate for ${said} (POST /mandate first)` }];
    if (md) {
      const m = md.mandate;
      if (m.amount_units !== rec.amountUnits || m.payee !== rec.payee || m.checkout_hash !== (rec.checkoutHash || "") || m.payer !== AGENT.account) {
        return [409, { ok: false, code: "mandate_scope_mismatch", error: "the signed mandate does not match the registered commitment (amount, payee, checkout hash or payer)" }];
      }
      if (body.receiptHash !== undefined && body.receiptHash !== md.receiptHash) {
        return [409, { ok: false, code: "mandate_scope_mismatch", error: "receiptHash differs from the signed mandate's receipt hash" }];
      }
    }
    const receiptHashHex = md ? md.receiptHash : body.receiptHash;
    const msg = { invoice: said, payee: rec.payee, salt: rec.salt, checkout_hash: rec.checkoutHash || "", ...(receiptHashHex ? { receipt_hash: receiptHashHex } : {}) };
    const r = await sendCall(agent, {
      receiverId: cfg.token,
      method: "ft_transfer_call",
      args: { receiver_id: cfg.contractId, amount: rec.amountUnits, msg: JSON.stringify(msg) },
      gasTgas,
      depositYocto: 1n,
    });
    const outcome = lastEvent(r.events, PAY_EVENTS);
    // ft_transfer_call returns the amount the receiver kept; the rest went back to the agent.
    const usedUnits = r.ok && r.value !== undefined && r.value !== null ? String(r.value) : undefined;
    const refundedUnits = usedUnits !== undefined ? (BigInt(rec.amountUnits) - BigInt(usedUnits)).toString() : undefined;
    if (r.ok && !outcome) {
      return [422, { ok: false, txHash: r.txHash, txUrl: txUrl(cfg, r.txHash), error: "no signatory event in tx logs", failures: r.failures }];
    }
    if (md && r.ok) {
      // off-chain receipt bundle: what was agreed and signed, plus the transaction that carried its hash
      const co = readAp2Record(ap2Dir, said, "checkout");
      writeAp2Record(ap2Dir, said, "receipt", {
        said,
        receiptHash: md.receiptHash,
        checkout: co?.checkout ?? null,
        merchantAuthorization: md.merchantAuthorization,
        merchantKid: md.mandate.merchant_kid,
        mandate: md.mandate,
        mandateJws: md.mandateJws,
        buyerKid: md.kid,
        tx: { hash: r.txHash, url: txUrl(cfg, r.txHash), outcome: outcome?.event ?? null },
        writtenAt: new Date().toISOString(),
      });
    }
    return reply(r, {
      ...(md ? { receiptHash: md.receiptHash } : {}),
      payer: AGENT.account,
      amountUnits: rec.amountUnits,
      ...(outcome ? { outcome } : {}),
      ...(usedUnits !== undefined ? { usedUnits, refundedUnits } : {}),
    });
  },

  // change #3: the buyer agent checks Jupiter's signed checkout and signs the payment mandate (nothing on-chain).
  "POST /mandate": async (body) => {
    if (!ap2On) throw new HttpError(501, "signer started without --ap2 on");
    const said = requireSaid(body);
    if (typeof body.checkout !== "object" || body.checkout === null) throw new HttpError(400, "checkout must be the UCP checkout object");
    const v = checkCheckoutForMandate(body.checkout, body.merchantAuthorization, [merchantJwk], {
      said,
      payee: cfg.accounts.payee,
      network,
      asset: cfg.token,
      contract: cfg.contractId,
    });
    if (!v.ok) return [422, { ok: false, code: v.code, error: v.reason }];
    const mandate = buildPaymentMandate({ checkout: body.checkout, merchantKid: v.kid, payer: AGENT.account, createdAt: new Date().toISOString() });
    const mandateJws = signMandate(mandate, buyerAp2);
    const receiptHash = ap2ReceiptHash({ checkoutHashHex: mandate.checkout_hash, merchantAuthorization: body.merchantAuthorization, mandate });
    writeAp2Record(ap2Dir, said, "mandate", { said, kid: buyerAp2.kid, mandate, mandateJws, merchantAuthorization: body.merchantAuthorization, receiptHash, createdAt: mandate.created_at });
    return [200, { ok: true, said, merchantKid: v.kid, kid: buyerAp2.kid, mandate, mandate_jws: mandateJws, mandateHash: sha256Hex(jcs(mandate)), receiptHash }];
  },

  "POST /approve": async (body) => settle("approve", requireSaid(body)),
  "POST /reject": async (body) => settle("reject", requireSaid(body)),

  "POST /revoke": async (body) => {
    if (!isAccountId(body.account)) throw new HttpError(400, "account must be a NEAR account id");
    requireSend();
    const r = await sendCall(cpo, {
      receiverId: cfg.contractId,
      method: "revoke",
      args: { account: body.account },
      gasTgas: 30,
    });
    return reply(r, { by: CPO.account, ...(r.ok ? { outcome: lastEvent(r.events, ["agent_revoked"]) } : {}) });
  },
};

async function settle(method, said) {
  requireSend();
  const r = await sendCall(cpo, { receiverId: cfg.contractId, method, args: { said }, gasTgas });
  const names = method === "approve" ? ["payment_approved", "paid"] : ["payment_rejected"];
  const outcome = lastEvent(r.events, names);
  if (r.ok && r.value === false) {
    // on_settle returned false: the token transfer failed, invoice back to pending (S-2a #3).
    const line = r.logs.find((l) => l.executor === cfg.contractId)?.log;
    return [422, { ok: false, txHash: r.txHash, txUrl: txUrl(cfg, r.txHash), error: line || `${method} transfer failed; invoice back to pending` }];
  }
  return reply(r, { by: CPO.account, ...(outcome ? { outcome } : {}) });
}

async function main() {
  token = await startupChecks(cfg);
  if (ap2On) {
    if (!ap2Dir) throw new Error("config ap2.recordsPath missing (needed with --ap2 on)");
    buyerAp2 = signerFromPemFile(cfg.paths.ap2BuyerKey, "AP2 buyer-agent key");
    merchantJwk = readPublicJwkFile(cfg.paths.ap2MerchantPublicJwk, "AP2 merchant public key (pinned)");
  }
  if (!noSend) {
    agent = await loadAccount({ credentialsDir, network, accountId: AGENT.account, rpcUrl: cfg.rpcUrl });
    cpo = await loadAccount({ credentialsDir, network, accountId: CPO.account, rpcUrl: cfg.rpcUrl });
  }
  log(SERVICE, {
    event: "ready",
    contractId: cfg.contractId,
    agent: AGENT.account,
    approver: CPO.account,
    gasTgas,
    keysLoaded: !noSend,
    ap2: ap2On ? { buyerKid: buyerAp2.kid, merchantKid: merchantJwk.kid } : "off",
    allowOrigin,
  });
  startServer({ service: SERVICE, port, allowOrigin, routes });
}

main().catch((e) => {
  log(SERVICE, { event: "startup_failed", error: e.message });
  process.exit(1);
});
