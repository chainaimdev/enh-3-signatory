// Q7 (SIGNATORY-quote-flow-design-01 S-6): runner mode "quote" — Tommy's RFQ → Jupiter's quote through OutcomeAI
// (recorded answers replayed), escalation through the runner's existing waiter + decide(), then treasury and the
// existing invoice → NEAR pay tail. No network, no keys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, ROOT } from "../../scripts/lib/common.mjs";
import { FIXTURE_EVIDENCE } from "./fixture.mjs";
import { createRunner, RunnerError, STEPS_Q } from "../runner/engine.mjs";
import { createRuleBuyer } from "../runner/quote-buyer.mjs";
import { createOutcomeBuyer } from "../runner/quote-buyer-outcome.mjs";
import { loadQuotePolicy } from "../runner/quote-flow.mjs";

const cfg = loadConfig();
const evidence = JSON.parse(readFileSync(FIXTURE_EVIDENCE, "utf8"));
const policy = loadQuotePolicy(resolve(ROOT, "config", "quote-authority.json"));
const inquiries = JSON.parse(readFileSync(resolve(ROOT, "data", "quote", "inquiries.json"), "utf8")).inquiries;
const FIX = resolve(ROOT, "services", "test", "fixtures", "quote-agent-responses");
const MANDATE = { limit_units: "100000", revoked: false, approver: "chainaim-tommy-cpo.testnet" };
const INV = "EBQy-FlPtaa6_kh-BZI5Cn-ndtJ2It5Q3JNDMH3oYY1z";

/** One client that replays every inquiry's recorded OutcomeAI answers by (alias, path, body). */
function replayAll() {
  const byKey = new Map();
  for (const f of readdirSync(FIX)) {
    for (const c of JSON.parse(readFileSync(join(FIX, f), "utf8")).calls) byKey.set(`${c.alias}|${c.path}|${JSON.stringify(c.request)}`, c);
  }
  const calls = [];
  return {
    calls,
    async call(alias, path, body) {
      calls.push({ alias, path });
      const c = byKey.get(`${alias}|${path}|${JSON.stringify(body)}`);
      if (!c) throw new Error(`no recorded answer for ${alias} ${path}`);
      return { body: structuredClone(c.response), api: { service: "outcome", method: "POST", path, alias, httpStatus: c.httpStatus, ms: 0 } };
    },
  };
}

function fakeDeps({ tail = false, ai = true, client = replayAll(), pending = true } = {}) {
  const chain = {};
  const calls = [];
  const recordsDir = mkdtempSync(join(tmpdir(), "quote-runner-"));
  const deps = {
    loadEvidence: () => evidence,
    getInvoice: async (s) => chain[s] ?? null,
    getMandate: async () => MANDATE,
    preflight: async () => ({ ok: true, checks: [{ name: "bridge", ok: true, detail: "up", api: { service: "bridge" } }], mandate: MANDATE }),
    nextInvoiceNumber: () => ({ invoiceNumber: "INV-2026-0003", highest: {} }),
    writeInvoiceConfig: (n, units, meta = {}) => {
      calls.push(["config", n, units.toString(), meta.quantity ?? null]);
      return { path: "/x", relPath: "./appconfig/generated-runs/x.json", description: "desc" };
    },
    runIssue: async () => ({ exitCode: 0, stdout: `✓ INV-2026-0003 (${INV}) issued, granted, admitted and held by tommyBuyerAgent\n`, stderr: "", ms: 1 }),
    readGrantInfo: () => ({ grantSaid: "EGRANT", path: "/g", timestamp: "t" }),
    runVerifyBuyer: async () => {
      calls.push(["verify_buyer"]);
      return { exitCode: 0, stdout: "All checks passed.\n", stderr: "", ms: 1, cmd: "x", evidence };
    },
    runExport: async () => ({ exitCode: 0, stdout: "All checks passed.\n", stderr: "", ms: 1 }),
    bridgeRegister: async (said) => {
      chain[said] = { status: "registered" };
      return { ok: true, sent: true, txHash: "TXREG", txUrl: "u/TXREG", checks: [] };
    },
    signerPay: async (said, units) => {
      calls.push(["pay"]);
      chain[said] = { status: pending ? "pending" : "paid" };
      return pending
        ? { ok: true, txHash: "TXPAY", txUrl: "u/TXPAY", outcome: { event: "payment_pending", limit_units: "100000", approver: MANDATE.approver, amount_units: "123900" } }
        : { ok: true, txHash: "TXPAY", txUrl: "u/TXPAY", outcome: { event: "paid", via: "within_limit", amount_units: "85000" } };
    },
    signerDecide: async (kind, said) => {
      chain[said] = { status: kind === "approve" ? "paid" : "rejected" };
      return { ok: true, txHash: "TXDEC", txUrl: "u/TXDEC" };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
    quote: {
      inquiries,
      policy,
      outcomeUrl: "http://127.0.0.1:8785",
      ai,
      tail,
      client,
      buyerFor: (q) => createRuleBuyer(q.buyerSim, q.rfq.items[0].custom_target_rate_cents),
      recorder: (rfqName, runId) => {
        const dir = join(recordsDir, `${rfqName}.${runId}`);
        mkdirSync(dir, { recursive: true });
        return async (file, obj) => writeFileSync(join(dir, file), JSON.stringify(obj, null, 2) + "\n");
      },
    },
  };
  return { deps, calls, recordsDir };
}

async function until(run, pred, ms = 5000) {
  const t0 = Date.now();
  while (!pred(run)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout; events: ${run.events.map((e) => (e.data.step ? `${e.data.step}:${e.data.status}` : e.data.state)).join(",")}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const finished = (r) => r.state === "finished";
const waiting = (r) => r.state === "waiting" && r.waiter;
const lastOf = (run, name) => [...run.events].reverse().find((e) => e.type === "step" && e.data.step === name)?.data;
const runEvent = (run, state) => run.events.find((e) => e.type === "run" && e.data.state === state)?.data;

test("quote T01: request → verify_buyer → consult (OutcomeAI) → accept in round 1 → treasury; --quote-tail off stops after agreement", async () => {
  const { deps, recordsDir } = fakeDeps({ tail: false });
  const runner = createRunner({ cfg, deps });
  const run = await runner.start({ mode: "quote", inquiry: "T01" });
  assert.deepEqual(run.plan, STEPS_Q);
  await until(run, finished);
  const end = runEvent(run, "finished");
  assert.equal(end.result, "agreed", end.text);
  assert.equal(end.quote.decision, "ACCEPT");
  assert.equal(end.quote.priceCents, 425);
  assert.equal(lastOf(run, "request").status, "done");
  assert.equal(lastOf(run, "verify_buyer").status, "done");
  assert.equal(lastOf(run, "consult").status, "done");
  assert.equal(lastOf(run, "negotiate").status, "done");
  assert.equal(lastOf(run, "escalation").status, "skipped");
  const tr = lastOf(run, "treasury");
  assert.equal(tr.status, "done");
  assert.equal(tr.data.units, "85000"); // 20 000 × $4.25 = $85 000 → 0.085 USDC at 1:1e6
  assert.match(tr.text, /the agent can pay/);
  // consult steps are made as the Jupiter sub-agent aliases, against OutcomeAI
  const consultActors = new Set(run.events.filter((e) => e.data.step === "consult" && e.data.data?.alias).map((e) => e.data.actor.id));
  for (const a of ["JupiterInventoryAgent", "JupiterLogisticsAgent", "JupiterTreasuryAgent"]) assert.ok(consultActors.has(a), `consult as ${a}`);
  // records written per run
  const dir = readdirSync(recordsDir).find((d) => d.startsWith("RFQ-T01."));
  assert.ok(dir, "record dir");
  const files = readdirSync(join(recordsDir, dir));
  for (const f of ["inquiry.json", "consults.json", "final.quote.json", "jupiter-internal.json"]) assert.ok(files.includes(f), f);
});

test("quote T06: no deal in 3 rounds → waits for Jupiter_Chief_Sales_Officer on /decide → approve → agreed at 410", async () => {
  const { deps } = fakeDeps({ tail: false });
  const runner = createRunner({ cfg, deps });
  const run = await runner.start({ mode: "quote", inquiry: "T06" });
  await until(run, waiting);
  const esc = lastOf(run, "escalation");
  assert.equal(esc.status, "waiting");
  assert.equal(esc.data.kind, "quote");
  assert.equal(esc.data.level, "SALES_OFFICER");
  assert.equal(esc.target.id, "Jupiter_Chief_Sales_Officer");
  assert.equal(esc.data.signed, false);
  await runner.decide(run.id, "approve");
  await until(run, finished);
  const end = runEvent(run, "finished");
  assert.equal(end.result, "agreed", end.text);
  assert.equal(end.quote.priceCents, 410);
  assert.equal(end.quote.decidedBy, "SALES_OFFICER");
});

test("quote T06: the Sales Officer rejects → no deal, nothing issued", async () => {
  const { deps, calls } = fakeDeps({ tail: true });
  const runner = createRunner({ cfg, deps });
  const run = await runner.start({ mode: "quote", inquiry: "T06" });
  await until(run, waiting);
  await runner.decide(run.id, "reject");
  await until(run, finished);
  assert.equal(runEvent(run, "finished").result, "no_deal");
  assert.ok(!calls.some((c) => c[0] === "config" || c[0] === "pay"), "no invoice, no payment");
});

test("quote T08: below the absolute floor → declined after escalation; nothing issued", async () => {
  const { deps, calls } = fakeDeps({ tail: true });
  const runner = createRunner({ cfg, deps });
  const run = await runner.start({ mode: "quote", inquiry: "T08" });
  for (let i = 0; i < 4 && !finished(run); i++) {
    await until(run, (r) => finished(r) || waiting(r));
    if (waiting(run)) await runner.decide(run.id, "approve");
  }
  await until(run, finished);
  const end = runEvent(run, "finished");
  assert.equal(end.result, "no_deal");
  assert.equal(end.quote.decision, "DECLINE");
  assert.equal(lastOf(run, "negotiate").status, "no_deal");
  assert.ok(!calls.some((c) => c[0] === "config" || c[0] === "pay"), "no invoice, no payment");
});

test("quote T03 with the tail on: agreed total → vLEI invoice → pay → held for the CPO (above the agent mandate)", async () => {
  const { deps, calls } = fakeDeps({ tail: true, pending: true });
  const runner = createRunner({ cfg, deps });
  const run = await runner.start({ mode: "quote", inquiry: "T03" });
  await until(run, waiting, 8000); // held by the contract for the CPO
  assert.ok(calls.some((c) => c[0] === "pay"), "paid through the signer");
  const tr = lastOf(run, "treasury");
  assert.equal(tr.status, "done");
  assert.equal(tr.data.units, "123900"); // 30 000 × $4.13
  assert.match(tr.text, /approves on NEAR/);
  const cfgCall = calls.find((c) => c[0] === "config");
  assert.ok(cfgCall, "invoice config written");
  assert.equal(cfgCall[2], "123900");
  assert.equal(cfgCall[3], 30000);
  await runner.cancel(run.id); // leave the CPO decision to the order-mode tests
  await until(run, finished);
});

test("quote mode errors: unknown inquiry 404, missing inquiry 400, not configured 501", async () => {
  const { deps } = fakeDeps();
  const runner = createRunner({ cfg, deps });
  await assert.rejects(runner.start({ mode: "quote", inquiry: "T99" }), (e) => e instanceof RunnerError && e.status === 404);
  await assert.rejects(runner.start({ mode: "quote" }), (e) => e instanceof RunnerError && e.status === 400);
  const bare = { ...deps };
  delete bare.quote;
  await assert.rejects(createRunner({ cfg, deps: bare }).start({ mode: "quote", inquiry: "T01" }), (e) => e instanceof RunnerError && e.status === 501);
});

test("quote: OutcomeAI failure stops the run with a failed step (no invoice)", async () => {
  const broken = { calls: [], async call() { throw new Error("OutcomeAI not reachable at http://127.0.0.1:8785 (ECONNREFUSED)"); } };
  const { deps, calls } = fakeDeps({ tail: true, client: broken });
  const runner = createRunner({ cfg, deps });
  const run = await runner.start({ mode: "quote", inquiry: "T01" });
  await until(run, finished);
  const end = runEvent(run, "finished");
  assert.equal(end.result, "error");
  assert.match(end.text, /OutcomeAI not reachable/);
  assert.ok(!calls.some((c) => c[0] === "config"));
});

test("quote S02 with --quote-buyer outcome: Tommy's OutcomeAI treasury before the RFQ, buyer/synthesize per move → agreed at 300", async () => {
  const rig = JSON.parse(readFileSync(resolve(ROOT, "data", "quote", "rig-scenarios.json"), "utf8")).inquiries;
  const tommyCalls = [];
  const byKey = new Map(JSON.parse(readFileSync(resolve(ROOT, "services", "test", "fixtures", "quote-buyer-responses", "S02.json"), "utf8")).calls.map((c) => [`${c.alias}|${c.path}|${JSON.stringify(c.request)}`, c]));
  const tommy = {
    async call(alias, path, body) {
      tommyCalls.push(`${alias} ${path}`);
      const c = byKey.get(`${alias}|${path}|${JSON.stringify(body)}`);
      if (!c) throw new Error(`no recorded Tommy answer for ${alias} ${path}`);
      return { body: structuredClone(c.response), api: { httpStatus: 200, ms: 0 } };
    },
  };
  const { deps } = fakeDeps({ tail: false });
  deps.quote.inquiries = rig;
  deps.quote.buyerFor = (q) => createOutcomeBuyer({ client: tommy, rfq: q.rfq });
  const runner = createRunner({ cfg, deps });
  const run = await runner.start({ mode: "quote", inquiry: "S02" });
  await until(run, finished);
  const end = runEvent(run, "finished");
  assert.equal(end.result, "agreed", end.text);
  assert.equal(end.quote.priceCents, 300);
  assert.equal(lastOf(run, "request").data.tommyTreasury.approval, "AGENT");
  assert.match(lastOf(run, "request").text, /Tommy's private-AI treasury: opening price within budget/);
  assert.deepEqual(tommyCalls, ["TommyTreasuryAgent agents/treasury", "tommyBuyerAgent buyer/synthesize", "tommyBuyerAgent buyer/synthesize"]);
});
