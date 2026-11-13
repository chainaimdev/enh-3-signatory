#!/usr/bin/env node
// S-7 runner — Phase A (pay a pre-issued invoice) and Phase B (issue a new vLEI invoice per request).
// Holds no keys: it calls the existing bridge (/register) and signer (/pay, /approve, /reject) over 127.0.0.1,
// and (Phase B) the existing vLEI tools: Ubuntu bash issue-additional-invoice.sh, Windows node.exe exporter.
//   node runner/index.mjs [--port 8774] [--config ../config/signatory.json] [--allow-origin http://127.0.0.1:8765]
//     [--signer-url http://127.0.0.1:8771] [--bridge-url http://127.0.0.1:8772] [--evidence <path>]
//     [--poll-ms 2000] [--wait-minutes 15]
//     Phase B: [--vlei-dir ../legentvLEI] [--export-node "/mnt/c/Program Files/nodejs/node.exe"]
//              [--issue-timeout-s 360] [--export-timeout-s 120] [--max-amount 0.25]
//              [--invoice-template appconfig/invoiceConfig-near-2.json] [--invoice-year 2026]
//              [--keria-container keria] [--shell-container tsx_shell]
// Endpoints:
//   GET  /health · GET /invoices · GET /preflight · GET /next-invoice[?text=…]
//   POST /run {said} | {text} | {text, mode:"issue"}  → {ok, runId, eventsUrl, mode, state, result?}
//   GET  /runs/:id · GET /runs/:id/events (SSE) · POST /runs/:id/decide {decision} · POST /runs/:id/cancel
// Origin rule (P8): an Origin header other than allowOrigin → 403; no Origin → allowed (127.0.0.1 bind).
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { loadConfig, ROOT, rpc, view } from "../../scripts/lib/common.mjs";
import { HttpError, log } from "../shared/http.mjs";
import { isSaid } from "../shared/near.mjs";
import { createRunner, RunnerError } from "./engine.mjs";
import { parseRequest, toUnits } from "./logic.mjs";
import { nextInvoiceNumber, preflight, readGrantInfo, runProcess, writeInvoiceConfig } from "./vlei.mjs";

const SERVICE = "runner";
const MAX_BODY = 16 * 1024;

export async function probe(url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return { up: r.ok && j.ok === true, url, keysLoaded: j.keysLoaded, httpStatus: r.status };
  } catch {
    return { up: false, url, httpStatus: null };
  }
}

/** opts: {cfg, evidencePath, signerUrl, bridgeUrl, vlei?: {dir, exportNode, issueTimeoutMs, exportTimeoutMs, template, year, keriaContainer, shellContainer}} */
export function buildDeps({ cfg, evidencePath, signerUrl, bridgeUrl, vlei, fetchImpl = fetch, run = runProcess }) {
  const post = async (base, path, body) => {
    const t0 = Date.now();
    try {
      const r = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status} without JSON` }));
      return { ...j, _http: { status: r.status, ms: Date.now() - t0, url: base } };
    } catch (e) {
      return { ok: false, error: `${base} not reachable (${e.name === "TimeoutError" ? "timeout" : e.message})`, _http: { status: null, ms: Date.now() - t0, url: base } };
    }
  };
  const loadEvidence = () => {
    try {
      return JSON.parse(readFileSync(evidencePath, "utf8"));
    } catch (e) {
      throw new HttpError(503, `evidence not readable at ${evidencePath} (${e.code || "invalid JSON"})`);
    }
  };
  const getMandate = (account) => view(cfg.rpcUrl, cfg.contractId, "get_mandate", { account });
  const deps = {
    loadEvidence,
    getInvoice: (said) => view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said }),
    getMandate,
    bridgeRegister: (said) => post(bridgeUrl, "/register", { said }),
    signerPay: (said) => post(signerUrl, "/pay", { said }),
    signerDecide: (kind, said) => post(signerUrl, `/${kind}`, { said }),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  if (vlei) {
    const sellerAgent = cfg.sellerAgent ?? "jupiterSellerAgent";
    const agentAccount = Object.values(cfg.accounts.aliases).find((e) => e.role === "buyer_agent")?.account;
    const outRel = relative(vlei.dir, evidencePath).split("\\").join("/");
    Object.assign(deps, {
      exportCmd: `"${vlei.exportNode}" export-signatory-evidence.js --strict --out ${outRel}`,
      preflight: () =>
        preflight({
          cfg, vleiDir: vlei.dir, exportNode: vlei.exportNode, signerUrl, bridgeUrl, agentAccount,
          keriaContainer: vlei.keriaContainer, shellContainer: vlei.shellContainer,
          deps: { probe, rpcStatus: async () => (await rpc(cfg.rpcUrl, "status", [])).chain_id, run, getMandate, loadEvidence },
        }),
      nextInvoiceNumber: (evidence) => nextInvoiceNumber({ vleiDir: vlei.dir, evidence, sellerAgent, year: vlei.year }),
      writeInvoiceConfig: (invoiceNumber, units, { item, quantity } = {}) =>
        writeInvoiceConfig({ vleiDir: vlei.dir, template: vlei.template, invoiceNumber, units, item, quantity, decimals: cfg.tokenDecimals, demoScale: cfg.demoScale ?? 1000000 }),
      runIssue: (relPath) => run("bash", ["issue-additional-invoice.sh", "--invoice-config", relPath], { cwd: vlei.dir, timeoutMs: vlei.issueTimeoutMs }),
      runExport: () => run(vlei.exportNode, ["export-signatory-evidence.js", "--strict", "--out", outRel], { cwd: vlei.dir, timeoutMs: vlei.exportTimeoutMs }),
      // S-7C verify_buyer: the same existing exporter (strict), written to a runner work file so the UI evidence is
      // untouched; read back as JSON for agentChain(), then deleted. No new invoice needed (V-READ 13 Nov).
      verifyBuyerCmd: `"${vlei.exportNode}" export-signatory-evidence.js --strict --out <services/runner/.work/verify-buyer-<runId>.json>`,
      runVerifyBuyer: async (runId) => {
        const workDir = resolve(ROOT, "services", "runner", ".work");
        mkdirSync(workDir, { recursive: true });
        const file = resolve(workDir, `verify-buyer-${runId}.json`);
        const rel = relative(vlei.dir, file).split("\\").join("/");
        const r = await run(vlei.exportNode, ["export-signatory-evidence.js", "--strict", "--out", rel], { cwd: vlei.dir, timeoutMs: vlei.exportTimeoutMs });
        let evidence = null;
        try {
          evidence = JSON.parse(readFileSync(file, "utf8"));
        } catch {
          evidence = null;
        }
        try {
          rmSync(file, { force: true });
        } catch {
          /* ignore */
        }
        return { ...r, cmd: `"${vlei.exportNode}" export-signatory-evidence.js --strict --out ${rel}`, evidence };
      },
      readGrantInfo: (said) => readGrantInfo({ vleiDir: vlei.dir, sellerAgent, said }),
    });
  }
  return deps;
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

/** Starts the runner HTTP server. */
export function startRunnerServer({ cfg, runner, deps = {}, port, allowOrigin, signerUrl, bridgeUrl, host = "127.0.0.1" }) {
  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    const origin = req.headers.origin;
    const cors = origin === allowOrigin ? { "access-control-allow-origin": allowOrigin, vary: "Origin" } : {};
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors });
      res.end(JSON.stringify(body));
      log(SERVICE, { method: req.method, path, status, ms: Date.now() - t0, ...(body.ok === false ? { error: body.error } : {}), ...(body.runId ? { runId: body.runId } : {}) });
    };

    if (origin !== undefined && origin !== allowOrigin) return send(403, { ok: false, error: `origin not allowed: ${origin}` });
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, last-event-id", "access-control-max-age": "600" });
      return res.end();
    }

    try {
      const m = /^\/runs\/([A-Za-z0-9-]{1,64})(\/events|\/decide|\/cancel)?$/.exec(path);
      if (req.method === "GET" && path === "/health") {
        const [signer, bridge] = await Promise.all([probe(signerUrl), probe(bridgeUrl)]);
        return send(200, { ok: true, service: SERVICE, contractId: cfg.contractId, modes: deps.preflight ? ["invoice", "issue"] : ["invoice"], activeRun: runner.summary(runner.active) || null, signer, bridge });
      }
      if (req.method === "GET" && path === "/invoices") {
        return send(200, { ok: true, invoices: await runner.invoices() });
      }
      if (req.method === "GET" && path === "/preflight") {
        if (!deps.preflight) throw new HttpError(501, "issue mode not configured");
        const p = await deps.preflight();
        return send(200, { ok: p.ok, checks: p.checks, mandate: p.mandate ?? null });
      }
      if (req.method === "GET" && path === "/next-invoice") {
        if (!deps.nextInvoiceNumber) throw new HttpError(501, "issue mode not configured");
        const n = deps.nextInvoiceNumber(deps.loadEvidence());
        const text = url.searchParams.get("text");
        let amount;
        if (text !== null) {
          const parsed = parseRequest(text, { decimals: cfg.tokenDecimals, demoScale: cfg.demoScale ?? 1000000 });
          const a = runner.issueAmount(parsed);
          amount = a.units !== undefined ? { ok: true, amountUnits: a.units.toString(), amount: parsed.amount, parsed } : { ok: false, result: a.result, error: a.error, parsed };
        }
        return send(200, { ok: true, invoiceNumber: n.invoiceNumber, highest: n.highest, ...(amount ? { amount } : {}), readOnly: true });
      }
      if (req.method === "POST" && path === "/run") {
        const body = await readJsonBody(req);
        if (body.said !== undefined && !isSaid(body.said)) throw new HttpError(400, "said must be a SAID string");
        if (body.mode === "issue" && !deps.preflight) throw new HttpError(501, "issue mode not configured");
        const run = await runner.start({ said: body.said, text: body.text, mode: body.mode });
        return send(200, { ok: true, runId: run.id, eventsUrl: `/runs/${run.id}/events`, mode: run.mode, state: run.state, result: run.result });
      }
      if (m && req.method === "GET" && !m[2]) {
        const run = runner.get(m[1]);
        if (!run) throw new RunnerError(404, "no such run");
        return send(200, { ok: true, ...runner.summary(run), events: run.events.map((e) => ({ event: e.type, ...e.data })) });
      }
      if (m && req.method === "GET" && m[2] === "/events") {
        const after = Number(req.headers["last-event-id"] || 0) || 0;
        if (!runner.get(m[1])) throw new RunnerError(404, "no such run");
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", ...cors });
        res.write("retry: 3000\n\n");
        const unsubscribe = runner.subscribe(m[1], (ev) => res.write(`id: ${ev.data.seq}\nevent: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`), after);
        const ping = setInterval(() => res.write(": ping\n\n"), 15000);
        ping.unref();
        res.on("close", () => {
          clearInterval(ping);
          unsubscribe();
        });
        log(SERVICE, { method: "GET", path, status: 200, sse: true });
        return;
      }
      if (m && req.method === "POST" && m[2] === "/decide") {
        const body = await readJsonBody(req);
        const r = await runner.decide(m[1], body.decision);
        return send(r.ok ? 200 : 422, { runId: m[1], ...r });
      }
      if (m && req.method === "POST" && m[2] === "/cancel") {
        return send(200, { runId: m[1], ...runner.cancel(m[1]) });
      }
      return send(404, { ok: false, error: `no route ${req.method} ${path}` });
    } catch (e) {
      const status = e instanceof HttpError || e instanceof RunnerError ? e.status : 500;
      return send(status, { ok: false, error: e.message, ...(e.extra || {}) });
    }
  });
  server.listen(port, host, () => log(SERVICE, { event: "listening", url: `http://${host}:${server.address().port}` }));
  return server;
}

async function main() {
  const { values: flags } = parseArgs({
    options: {
      port: { type: "string" },
      config: { type: "string" },
      "allow-origin": { type: "string" },
      "signer-url": { type: "string" },
      "bridge-url": { type: "string" },
      evidence: { type: "string" },
      "poll-ms": { type: "string" },
      "wait-minutes": { type: "string" },
      "vlei-dir": { type: "string" },
      "export-node": { type: "string" },
      "issue-timeout-s": { type: "string" },
      "export-timeout-s": { type: "string" },
      "max-amount": { type: "string" },
      "invoice-template": { type: "string" },
      "invoice-year": { type: "string" },
      "keria-container": { type: "string" },
      "shell-container": { type: "string" },
    },
  });
  const cfg = loadConfig(flags.config);
  const port = Number(flags.port ?? cfg.ports?.runner ?? 8774);
  const allowOrigin = flags["allow-origin"] ?? cfg.allowOrigin;
  const signerUrl = flags["signer-url"] ?? `http://127.0.0.1:${cfg.ports?.signer ?? 8771}`;
  const bridgeUrl = flags["bridge-url"] ?? `http://127.0.0.1:${cfg.ports?.bridge ?? 8772}`;
  const evidencePath = flags.evidence ? resolve(flags.evidence) : cfg.paths.evidence;
  const pollMs = Number(flags["poll-ms"] ?? 2000);
  const waitMinutes = Number(flags["wait-minutes"] ?? 15);
  const maxUnits = toUnits(flags["max-amount"] ?? "0.25", cfg.tokenDecimals);
  if (maxUnits === null || maxUnits < 100n) throw new Error(`--max-amount must be a decimal ≥ 0.0001 with ≤ ${cfg.tokenDecimals} decimals`);
  const vlei = {
    dir: resolve(flags["vlei-dir"] ?? resolve(ROOT, "..", "legentvLEI")),
    exportNode: flags["export-node"] ?? "/mnt/c/Program Files/nodejs/node.exe",
    issueTimeoutMs: Number(flags["issue-timeout-s"] ?? 360) * 1000,
    exportTimeoutMs: Number(flags["export-timeout-s"] ?? 120) * 1000,
    template: flags["invoice-template"] ?? "appconfig/invoiceConfig-near-2.json",
    year: flags["invoice-year"] ?? "2026",
    keriaContainer: flags["keria-container"] ?? "keria",
    shellContainer: flags["shell-container"] ?? "tsx_shell",
  };

  const deps = buildDeps({ cfg, evidencePath, signerUrl, bridgeUrl, vlei });
  const md = await view(cfg.rpcUrl, cfg.token, "ft_metadata");
  if (md.decimals !== cfg.tokenDecimals) throw new Error(`token decimals ${md.decimals} ≠ config ${cfg.tokenDecimals} (G-39)`);
  await view(cfg.rpcUrl, cfg.contractId, "get_config");
  deps.loadEvidence();
  const runner = createRunner({ cfg, deps, pollMs, waitTimeoutMs: waitMinutes * 60000, maxUnits, onLog: (f) => log(SERVICE, f) });
  log(SERVICE, {
    event: "ready", contractId: cfg.contractId, signerUrl, bridgeUrl, evidencePath, pollMs, waitMinutes, allowOrigin,
    vleiDir: vlei.dir, exportNode: vlei.exportNode, issueTimeoutS: vlei.issueTimeoutMs / 1000, exportTimeoutS: vlei.exportTimeoutMs / 1000,
    maxAmount: flags["max-amount"] ?? "0.25", template: vlei.template,
  });
  startRunnerServer({ cfg, runner, deps, port, allowOrigin, signerUrl, bridgeUrl });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    log(SERVICE, { event: "startup_failed", error: e.message });
    process.exit(1);
  });
}
