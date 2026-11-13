#!/usr/bin/env node
// S-4 signer — sends transactions for the buyer agent (pay) and the CPO (approve/reject/revoke).
// Run in WSL Ubuntu next to ~/.near-credentials:
//   node signer/index.mjs [--port 8771] [--config ../config/signatory.json] [--credentials ~/.near-credentials]
//                         [--allow-origin http://127.0.0.1:8765] [--gas-tgas 150] [--no-send]
// --no-send: start without loading keys (health/CORS testing); every action answers 503.
// Endpoints: GET /health · POST /pay {said} · /approve {said} · /reject {said} · /revoke {account}
// Response: {ok, txHash, txUrl, outcome?} or {ok:false, error} (contract error verbatim).
// Loads only the buyer-agent and CPO keys. Binds 127.0.0.1. Never returns or logs keys.
import { parseArgs } from "node:util";
import { loadConfig, view } from "../../scripts/lib/common.mjs";
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
      keysLoaded: !noSend,
    },
  ],

  "POST /pay": async (body) => {
    const said = requireSaid(body);
    requireSend();
    const inv = await view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said });
    if (!inv) return [422, { ok: false, error: "invoice not registered" }];
    const r = await sendCall(agent, {
      receiverId: cfg.token,
      method: "ft_transfer_call",
      args: { receiver_id: cfg.contractId, amount: inv.amount_units, msg: JSON.stringify({ invoice: said }) },
      gasTgas,
      depositYocto: 1n,
    });
    const outcome = lastEvent(r.events, PAY_EVENTS);
    // ft_transfer_call returns the amount the receiver kept; the rest went back to the agent.
    const usedUnits = r.ok && r.value !== undefined && r.value !== null ? String(r.value) : undefined;
    const refundedUnits = usedUnits !== undefined ? (BigInt(inv.amount_units) - BigInt(usedUnits)).toString() : undefined;
    if (r.ok && !outcome) {
      return [422, { ok: false, txHash: r.txHash, txUrl: txUrl(cfg, r.txHash), error: "no signatory event in tx logs", failures: r.failures }];
    }
    return reply(r, {
      payer: AGENT.account,
      amountUnits: inv.amount_units,
      ...(outcome ? { outcome } : {}),
      ...(usedUnits !== undefined ? { usedUnits, refundedUnits } : {}),
    });
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
    allowOrigin,
  });
  startServer({ service: SERVICE, port, allowOrigin, routes });
}

main().catch((e) => {
  log(SERVICE, { event: "startup_failed", error: e.message });
  process.exit(1);
});
