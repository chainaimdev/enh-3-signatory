#!/usr/bin/env node
// S-5 bridge — checks a vLEI-proven invoice (SAID recompute + R-IPEX) and registers it in the contract.
// Run in WSL Ubuntu next to ~/.near-credentials:
//   node bridge/index.mjs [--port 8772] [--config ../config/signatory.json] [--credentials ~/.near-credentials]
//                         [--allow-origin http://127.0.0.1:8765] [--evidence <path>] [--seller-agent jupiterSellerAgent]
//                         [--no-send]
// --evidence: use another evidence file (e.g. a copy with admitSuccess:false for P6).
// --no-send : start without loading the registrar key; /check works, /register answers 503.
// Endpoints: GET /health · POST /check {said, tamperField?} (rules only, nothing sent)
//            POST /register {said, tamperField?} → {ok, txHash, txUrl, checks} | {ok:false, reason, checks}
// Loads only the registrar key. Refusal sends nothing. Evidence is re-read on every request.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, view } from "../../scripts/lib/common.mjs";
import { HttpError, log, startServer } from "../shared/http.mjs";
import { defaultCredentialsDir, isSaid, loadAccount, sendCall, startupChecks, txUrl } from "../shared/near.mjs";
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
const GAS_REGISTER_TGAS = 30;

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
    return [200, { ok: true, service: SERVICE, network, contractId: cfg.contractId, registrar: REGISTRAR, sellerAgent, evidencePath, evidence, keysLoaded: !noSend }];
  },

  "POST /check": async (body) => {
    const c = runChecks(body);
    const onChain = c.demo ? undefined : await view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said: body.said });
    const { registerArgs, ...rest } = c;
    return [200, { ...rest, ...(registerArgs ? { wouldRegister: registerArgs } : {}), ...(onChain !== undefined ? { onChain } : {}) }];
  },

  "POST /register": async (body) => {
    const c = runChecks(body);
    const { registerArgs, ...rest } = c;
    if (!c.ok) return [422, { ...rest, ok: false, sent: false }];
    if (noSend) throw new HttpError(503, "bridge started with --no-send (no key loaded); checks passed, nothing sent");
    const existing = await view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said: body.said });
    if (existing) return [200, { ...rest, ok: true, sent: false, alreadyRegistered: true, invoice: existing }];
    const r = await sendCall(registrar, {
      receiverId: cfg.contractId,
      method: "register_invoice",
      args: registerArgs,
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
  if (!noSend) registrar = await loadAccount({ credentialsDir, network, accountId: REGISTRAR, rpcUrl: cfg.rpcUrl });
  log(SERVICE, { event: "ready", contractId: cfg.contractId, registrar: REGISTRAR, evidencePath, sellerAgent, keysLoaded: !noSend, allowOrigin });
  startServer({ service: SERVICE, port, allowOrigin, routes });
}

main().catch((e) => {
  log(SERVICE, { event: "startup_failed", error: e.message });
  process.exit(1);
});
