// Runner: pure logic, engine flows with fake bridge/signer/chain (real evidence), HTTP + SSE + Origin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../../scripts/lib/common.mjs";
import { listInvoices, matchInvoice, parseRequest, toUnits } from "../runner/logic.mjs";
import { createRunner } from "../runner/engine.mjs";
import { startRunnerServer } from "../runner/index.mjs";

const cfg = loadConfig();
const INV3 = "EBQy-FlPtaa6_kh-BZI5Cn-ndtJ2It5Q3JNDMH3oYY1z"; // 0.084
const INV4 = "EHusycc5UI7q2qRnfHhY-5fc0M9xkxB0nixx9Vs7m1qr"; // 0.1575
// Fixture: the real export reduced to INV-2026-0003/0004, so tests do not depend on how many invoices exist.
const evidence = (() => {
  const ev = JSON.parse(readFileSync(cfg.paths.evidence, "utf8"));
  ev.invoices = ev.invoices.filter((i) => i.said === INV3 || i.said === INV4);
  ev.invoice = ev.invoices[0];
  return ev;
})();
const P = { decimals: 6, demoScale: 1000000 };
const AGENT = "chainaim-tommy-buyer-agent.testnet";

// ------------------------------------------------------------------ logic

test("toUnits: exact string math", () => {
  assert.equal(toUnits("0.12", 6), 120000n);
  assert.equal(toUnits("120,000", 6), 120000000000n);
  assert.equal(toUnits("0.0000001", 6), null);
  assert.equal(toUnits("abc", 6), null);
});

test("parseRequest: token amount, real amount, invoice number, quantity", () => {
  assert.equal(parseRequest("pay 0.12 USDC", P).amountUnits, "120000");
  const real = parseRequest("Need cotton t-shirts worth $120,000, deliver in 30 days", P);
  assert.equal(real.amountUnits, "120000");
  assert.equal(real.amountKind, "real");
  assert.equal(real.quantity, undefined, "'30 days' is not a quantity");
  assert.equal(parseRequest("157,500 USD order", P).amountUnits, "157500");
  assert.equal(parseRequest("pay INV-2026-0005", P).invoiceNumber, "INV-2026-0005");
  const q = parseRequest("Need 8,000 cotton t-shirts, deliver in 30 days", P);
  assert.equal(q.quantity, 8000);
  assert.equal(q.item, "cotton t-shirts");
  assert.equal(q.amountUnits, undefined);
  assert.match(parseRequest("$0.5 please", P).amountError, /does not convert exactly/);
});

test("listInvoices: runnable unless paid/pending/rejected", () => {
  const list = listInvoices(evidence, { [INV3]: { status: "paid" }, [INV4]: null }, P);
  const i3 = list.find((i) => i.said === INV3);
  const i4 = list.find((i) => i.said === INV4);
  assert.equal(i3.runnable, false);
  assert.equal(i3.reason, "invoice is paid");
  assert.equal(i3.amount, "0.084");
  assert.equal(i3.realAmount, "84,000 USD");
  assert.equal(i4.status, "unregistered");
  assert.equal(i4.runnable, true);
  assert.equal(i4.amountUnits, "157500");
  for (const s of ["registered"]) assert.equal(listInvoices(evidence, { [INV3]: { status: s } }, P)[0].runnable, true);
  for (const s of ["pending", "rejected"]) assert.equal(listInvoices(evidence, { [INV3]: { status: s } }, P)[0].runnable, false);
});

test("matchInvoice: never invents, honest refusals", () => {
  const list = listInvoices(evidence, { [INV3]: { status: "paid" }, [INV4]: null }, P);
  assert.equal(matchInvoice(list, parseRequest("0.1575 USDC", P)).invoice.said, INV4);
  assert.equal(matchInvoice(list, parseRequest("INV-2026-0004", P)).invoice.said, INV4);
  assert.match(matchInvoice(list, parseRequest("0.084 USDC", P)).error, /No issued unpaid invoice for 0.084/);
  assert.match(matchInvoice(list, parseRequest("INV-2026-0003", P)).error, /is paid/);
  assert.match(matchInvoice(list, parseRequest("INV-2026-0099", P)).error, /No issued invoice INV-2026-0099/);
  assert.match(matchInvoice(list, parseRequest("INV-2026-0004 for 0.12 USDC", P)).error, /not 0.12/);
  assert.match(matchInvoice(list, parseRequest("Need 8,000 t-shirts", P)).error, /names no amount/);
});

// ------------------------------------------------------------------ engine

function fakeDeps(over = {}) {
  const chain = { [INV3]: null, [INV4]: null, ...(over.chain || {}) };
  const calls = [];
  const deps = {
    loadEvidence: () => evidence,
    getInvoice: async (s) => chain[s] ?? null,
    getMandate: async () => ({ limit_units: "100000", revoked: !!over.revoked, approver: "chainaim-tommy-cpo.testnet" }),
    bridgeRegister: async (said) => {
      calls.push(["register", said]);
      if (over.register) return over.register(said, chain);
      chain[said] = { status: "registered" };
      return { ok: true, sent: true, txHash: "TXREG", txUrl: "https://x/txns/TXREG", checks: [] };
    },
    signerPay: async (said) => {
      calls.push(["pay", said]);
      if (over.pay) return over.pay(said, chain);
      if (over.revoked) return { ok: true, txHash: "TXPAY", txUrl: "u/TXPAY", outcome: { event: "payment_refused", reason: "mandate revoked" }, usedUnits: "0", refundedUnits: "84000" };
      if (said === INV3) {
        chain[said] = { status: "paid" };
        return { ok: true, txHash: "TXPAY", txUrl: "u/TXPAY", outcome: { event: "paid", via: "within_limit", amount_units: "84000" }, usedUnits: "84000", refundedUnits: "0" };
      }
      chain[said] = { status: "pending" };
      return { ok: true, txHash: "TXPAY", txUrl: "u/TXPAY", outcome: { event: "payment_pending", limit_units: "100000", approver: "chainaim-tommy-cpo.testnet", amount_units: "157500" } };
    },
    signerDecide: async (kind, said) => {
      calls.push([kind, said]);
      if (over.decide) return over.decide(kind, said, chain);
      chain[said] = { status: kind === "approve" ? "paid" : "rejected" };
      return { ok: true, txHash: "TXDEC", txUrl: "u/TXDEC" };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };
  return { deps, chain, calls };
}

async function until(run, pred, ms = 2000) {
  const t0 = Date.now();
  while (!pred(run)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout; events: ${run.events.map((e) => e.data.step || e.data.state).join(",")}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const finished = (r) => r.state === "finished";
const waiting = (r) => r.state === "waiting" && r.waiter;
const steps = (run) => run.events.filter((e) => e.type === "step").map((e) => `${e.data.step}:${e.data.status}`);

test("scene 1: offer → accept → register → pay → paid", async () => {
  const { deps, calls } = fakeDeps();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ said: INV3 });
  await until(run, finished);
  assert.deepEqual(steps(run), ["offer:done", "accept:done", "register:running", "register:done", "pay:running", "pay:done", "outcome:done"]);
  assert.equal(run.result, "paid");
  assert.deepEqual(calls, [["register", INV3], ["pay", INV3]]);
  const started = run.events[0].data;
  assert.equal(started.state, "started");
  assert.equal(started.invoice.invoiceNumber, "INV-2026-0003");
  assert.equal(started.mandate.limit, "0.1");
  const reg = run.events.find((e) => e.data.step === "register" && e.data.status === "done").data;
  assert.equal(reg.txUrl, "https://x/txns/TXREG");
  assert.equal(reg.actor.account, cfg.accounts.registrar);
  assert.equal(reg.target.account, cfg.contractId);
  const offer = run.events.find((e) => e.data.step === "offer").data;
  assert.equal(offer.history, true);
  assert.equal(offer.actor.id, "jupiterSellerAgent");
  assert.equal(offer.target.id, "tommyBuyerAgent");
  assert.equal(offer.index, 1);
  assert.deepEqual(run.events.map((e) => e.data.seq), run.events.map((_, i) => i + 1));
  assert.equal(runner.active, null, "lock released");
});

test("scene 2: pending → escalation waits → user approves via runner → paid", async () => {
  const { deps, calls } = fakeDeps();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ said: INV4 });
  await until(run, waiting);
  const out = run.events.find((e) => e.data.step === "outcome").data;
  assert.equal(out.status, "waiting");
  assert.equal(out.target.id, "Tommy_Chief_Procurement_Officer");
  assert.match(out.text, /0\.1575 USDC > 0\.1/);
  await assert.rejects(runner.start({ said: INV3 }), /already active/);
  const r = await runner.decide(run.id, "approve");
  assert.equal(r.ok, true);
  await until(run, finished);
  assert.equal(run.result, "paid");
  const dec = run.events.find((e) => e.data.step === "decision").data;
  assert.equal(dec.txUrl, "u/TXDEC");
  assert.equal(dec.data.via, "approved");
  assert.deepEqual(calls.at(-1), ["approve", INV4]);
});

test("scene 2b: user rejects via runner → rejected, refunded", async () => {
  const { deps } = fakeDeps();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ said: INV4 });
  await until(run, waiting);
  await runner.decide(run.id, "reject");
  await until(run, finished);
  assert.equal(run.result, "rejected");
  assert.match(run.events.find((e) => e.data.step === "decision").data.text, /refunded to the agent/);
});

test("decision made outside the runner (UI → signer directly) is picked up by polling", async () => {
  const { deps, chain } = fakeDeps();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ said: INV4 });
  await until(run, waiting);
  chain[INV4] = { status: "rejected" };
  await until(run, finished);
  assert.equal(run.result, "rejected");
  const dec = run.events.find((e) => e.data.step === "decision").data;
  assert.equal(dec.txUrl, undefined);
  assert.match(dec.text, /decided outside the runner/);
});

test("failed approve keeps waiting (verbatim error), then reject works", async () => {
  let first = true;
  const { deps } = fakeDeps({
    decide: (kind, said, chain) => {
      if (first) {
        first = false;
        return { ok: false, error: "Smart contract panicked: amount 157500 exceeds approver limit 150000", txUrl: "u/F" };
      }
      chain[said] = { status: "rejected" };
      return { ok: true, txUrl: "u/OK" };
    },
  });
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ said: INV4 });
  await until(run, waiting);
  const r1 = await runner.decide(run.id, "approve");
  assert.equal(r1.ok, false);
  assert.equal(run.state, "waiting");
  assert.match(steps(run).at(-1), /decision:failed/);
  await runner.decide(run.id, "reject");
  await until(run, finished);
  assert.equal(run.result, "rejected");
});

test("scene 4: revoked agent → refused with reason and refund", async () => {
  const { deps } = fakeDeps({ revoked: true });
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ said: INV3 });
  await until(run, finished);
  assert.equal(run.result, "refused");
  const out = run.events.find((e) => e.data.step === "outcome").data;
  assert.equal(out.status, "failed");
  assert.match(out.text, /mandate revoked — 0.084 USDC returned to the agent/);
  assert.equal(run.events[0].data.mandate.revoked, true);
});

test("bridge refusal stops the run before any payment", async () => {
  const { deps, calls } = fakeDeps({ register: () => ({ ok: false, reason: "admit: admitSuccess=false", checks: [] }) });
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ said: INV3 });
  await until(run, finished);
  assert.equal(run.result, "register_refused");
  assert.ok(!calls.some(([k]) => k === "pay"), "no payment after a refusal");
});

test("already registered → register skipped; signer down → error, lock released", async () => {
  const { deps } = fakeDeps({
    register: () => ({ ok: true, alreadyRegistered: true, checks: [] }),
    pay: () => ({ ok: false, error: "http://127.0.0.1:8771 not reachable (fetch failed)" }),
  });
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ said: INV3 });
  await until(run, finished);
  assert.ok(steps(run).includes("register:skipped"));
  assert.equal(run.result, "error");
  assert.equal(runner.active, null);
});

test("text request: matched, and honest no_match", async () => {
  const { deps } = fakeDeps({ chain: { [INV3]: { status: "paid" } } });
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const nm = await runner.start({ text: "Need 8,000 cotton t-shirts, deliver in 30 days" });
  assert.equal(nm.result, "no_match");
  assert.equal(nm.events.length, 2);
  assert.equal(nm.events[0].data.request.parsed.quantity, 8000);
  assert.match(nm.events[1].data.text, /names no amount/);
  const run = await runner.start({ text: "order worth $157,500" });
  await until(run, waiting);
  assert.equal(run.said, INV4);
  runner.cancel(run.id);
  await until(run, finished);
});

test("not runnable / unknown said are refused before a run starts", async () => {
  const { deps } = fakeDeps({ chain: { [INV3]: { status: "paid" } } });
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  await assert.rejects(runner.start({ said: INV3 }), (e) => e.status === 409 && /is paid/.test(e.message));
  await assert.rejects(runner.start({ said: "Eunknown" }), (e) => e.status === 404);
  await assert.rejects(runner.start({}), (e) => e.status === 400);
  assert.equal(runner.active, null);
});

test("cancel and timeout release the lock, invoice stays pending", async () => {
  const { deps } = fakeDeps();
  let runner = createRunner({ cfg, deps, pollMs: 1 });
  let run = await runner.start({ said: INV4 });
  await until(run, waiting);
  runner.cancel(run.id);
  await until(run, finished);
  assert.equal(run.result, "cancelled");
  assert.equal(runner.active, null);
  assert.throws(() => runner.cancel(run.id), /not waiting|finished/);

  const f2 = fakeDeps();
  runner = createRunner({ cfg, deps: f2.deps, pollMs: 1, waitTimeoutMs: 30 });
  run = await runner.start({ said: INV4 });
  await until(run, finished);
  assert.equal(run.result, "timeout");
});

// ------------------------------------------------------------------ HTTP + SSE

test("HTTP: P8 origin rule, /run, SSE replay with Last-Event-ID, decide", async () => {
  const allow = "http://127.0.0.1:8765";
  const { deps } = fakeDeps();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const server = startRunnerServer({ cfg, runner, port: 0, allowOrigin: allow, signerUrl: "http://127.0.0.1:1", bridgeUrl: "http://127.0.0.1:1" });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/invoices`, { headers: { origin: "http://evil.example" } })).status, 403);
    const inv = await fetch(`${base}/invoices`, { headers: { origin: allow } });
    assert.equal(inv.headers.get("access-control-allow-origin"), allow);
    assert.equal((await inv.json()).invoices.length, 2);
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.signer.up, false);
    assert.equal(h.activeRun, null);

    const post = (p, b) => fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    assert.equal((await post("/run", { said: "bad said" })).status, 400);
    const started = await (await post("/run", { said: INV4 })).json();
    assert.equal(started.ok, true);
    const run = runner.get(started.runId);
    await until(run, waiting);
    assert.equal((await post("/run", { said: INV3 })).status, 409);

    // SSE: replay from Last-Event-ID 2, read until the outcome event
    const ctl = new AbortController();
    const sse = await fetch(`${base}${started.eventsUrl}`, { headers: { "last-event-id": "2", origin: allow }, signal: ctl.signal });
    assert.equal(sse.headers.get("content-type"), "text/event-stream; charset=utf-8");
    const reader = sse.body.getReader();
    let text = "";
    while (!text.includes('"step":"outcome"')) text += new TextDecoder().decode((await reader.read()).value);
    ctl.abort();
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.equal(ids[0], 3, "replay starts after Last-Event-ID");
    assert.match(text, /^event: step$/m);
    const firstData = JSON.parse(/^data: (.*)$/m.exec(text)[1]);
    assert.equal(firstData.runId, started.runId);
    assert.equal(firstData.seq, 3);

    assert.equal((await post(`/runs/${started.runId}/decide`, { decision: "maybe" })).status, 400);
    const d = await (await post(`/runs/${started.runId}/decide`, { decision: "approve" })).json();
    assert.equal(d.ok, true);
    await until(run, finished);
    const summary = await (await fetch(`${base}/runs/${started.runId}`)).json();
    assert.equal(summary.result, "paid");
    assert.equal(summary.events.at(-1).event, "run");
    assert.equal(summary.events.at(-1).state, "finished");
    assert.equal((await fetch(`${base}/runs/nope`)).status, 404);
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});
