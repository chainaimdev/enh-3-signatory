// Change #4: purchase order → swarm → negotiation (DD5 rules + guard, optional AI proposer) → treasury → Phase B tail.
// No keys, no KERIA, no NEAR writes, no AI calls: the AI proposer is exercised with explicit proposals / a local fetch stub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, ROOT } from "../../scripts/lib/common.mjs";
import { FIXTURE_EVIDENCE } from "./fixture.mjs";
import { createRunner, STEPS_C } from "../runner/engine.mjs";
import { loadOrderBook, preDealChecks, sellerTreasury, treasuryChecks } from "../runner/swarm.mjs";
import { buyerGuard, negotiate, sellerGuard, totalCents, unitsFromCents } from "../shared/negotiate.mjs";
import { createLlmProposer, parseProposal } from "../shared/llm.mjs";

const cfg = loadConfig();
const book = loadOrderBook(resolve(ROOT, "data"));
const order = (id) => book.orders.find((o) => o.id === id);
const evidence = JSON.parse(readFileSync(FIXTURE_EVIDENCE, "utf8"));
const trail = (r) => r.moves.map((m) => `${m.from[0]}${m.action[0]}${m.price ?? ""}`).join(" ");
const MANDATE = { limit_units: "100000", revoked: false, approver: "chainaim-tommy-cpo.testnet" };

// ------------------------------------------------------------------ negotiation (DD5 rules)

test("N1–N4 with the DD5 rules: exact rounds, prices and outcome", async () => {
  const r = {};
  for (const id of ["N1", "N2", "N3", "N4"]) r[id] = await negotiate({ order: order(id), rules: book });
  assert.deepEqual([r.N1.deal, r.N1.priceCents, r.N1.round, trail(r.N1)], [true, 385, 1, "bO385 sA"]);
  assert.deepEqual([r.N2.deal, r.N2.priceCents, r.N2.round, trail(r.N2)], [true, 373, 2, "bO330 sC438 bC373 sA"]);
  assert.deepEqual([r.N3.deal, r.N3.priceCents, r.N3.round, trail(r.N3)], [true, 383, 3, "bO280 sC438 bC343 sC410 bC383 sA"]);
  assert.deepEqual([r.N4.deal, r.N4.round, r.N4.lastSellerCents, r.N4.lastBuyerCents, trail(r.N4)], [false, 3, 410, 345, "bO300 sC438 bC345 sC410 bC345 sR"]);
  for (const id of ["N1", "N2", "N3", "N4"]) for (const m of r[id].moves.slice(1)) assert.equal(m.source, "rules");
});

test("amounts: N1/N3 within the agent mandate, N2 above it (CPO), all whole dollars", () => {
  const units = (id, p) => unitsFromCents(totalCents(order(id).quantity, p), 6, 1000000);
  assert.equal(units("N1", 385), 77000n); // $77,000 → 0.077 USDC
  assert.equal(units("N2", 373), 149200n); // $149,200 → 0.1492 USDC
  assert.equal(units("N3", 383), 76600n);
  // every price the guard allows lands in the same tier
  for (let p = 355; p <= 415; p++) {
    assert.ok(units("N1", p) <= 100000n && units("N3", p) <= 100000n, `N1/N3 at ${p}`);
    assert.ok(units("N2", p) > 100000n && units("N2", p) <= 250000n, `N2 at ${p}`);
  }
  assert.equal(unitsFromCents(12345n, 6, 1000000), null, "not whole dollars → refused");
});

test("guard: the seller never accepts below $3.55, never raises a counter, never counters under the floor", () => {
  const sp = book.seller;
  let g = sellerGuard(sp, { round: 1, lastBuyer: 340, lastSeller: null }, { action: "ACCEPT" });
  assert.deepEqual([g.decision.action, g.decision.price, g.changed], ["COUNTER", 355, true]);
  g = sellerGuard(sp, { round: 3, lastBuyer: 340, lastSeller: 410 }, { action: "ACCEPT" });
  assert.equal(g.decision.action, "REJECT");
  g = sellerGuard(sp, { round: 2, lastBuyer: 340, lastSeller: 410 }, { action: "COUNTER", price: 300 });
  assert.equal(g.decision.price, 355);
  g = sellerGuard(sp, { round: 2, lastBuyer: 340, lastSeller: 410 }, { action: "COUNTER", price: 450 });
  assert.equal(g.decision.price, 405);
  assert.equal(sellerGuard(sp, { round: 2, lastBuyer: 340, lastSeller: 410 }, { action: "COUNTER" }), null);
  assert.equal(sellerGuard(sp, { round: 2, lastBuyer: 340 }, { action: "MAYBE" }), null);
});

test("guard: the buyer never accepts above its budget or with a > 30% jump; counters stay in [last offer, budget]", () => {
  const bp = book.buyer;
  let g = buyerGuard(bp, { round: 3, budget: 345, lastBuyer: 345, lastSeller: 410 }, { action: "ACCEPT" });
  assert.equal(g.decision.action, "REJECT");
  g = buyerGuard(bp, { round: 2, budget: 415, lastBuyer: 280, lastSeller: 410 }, { action: "ACCEPT" });
  assert.deepEqual([g.decision.action, g.decision.price], ["COUNTER", 345]);
  g = buyerGuard(bp, { round: 2, budget: 395, lastBuyer: 300, lastSeller: 410 }, { action: "COUNTER", price: 500 });
  assert.equal(g.decision.price, 395);
  g = buyerGuard(bp, { round: 2, budget: 395, lastBuyer: 300, lastSeller: 410 }, { action: "COUNTER", price: 250 });
  assert.equal(g.decision.price, 300);
});

test("AI proposals: used when valid, corrected by the guard, rules when unusable or unreachable; private limits stay private", async () => {
  const seen = [];
  const propose = async (role, st) => {
    seen.push([role, st]);
    if (role === "seller" && st.round === 1) return { action: "ACCEPT", reasoning: "take it", model: "m", ms: 3 }; // 300 < 355 → guard
    if (role === "buyer") throw new Error("AI not reachable (timeout)");
    return { action: "COUNTER", price: 999, reasoning: "x", model: "m", ms: 3 }; // raise → guard
  };
  const r = await negotiate({ order: order("N4"), rules: book, propose });
  const s1 = r.moves[1];
  assert.deepEqual([s1.from, s1.action, s1.price, s1.source], ["seller", "COUNTER", 355, "ai+guard"]);
  assert.match(s1.guard, /below the seller minimum/);
  assert.equal(s1.ai.action, "ACCEPT");
  const b2 = r.moves[2];
  assert.deepEqual([b2.from, b2.source], ["buyer", "rules"]);
  assert.match(b2.ai.error, /not reachable/);
  assert.equal(r.deal, false, "N4 can never close: budget $3.45 < seller minimum $3.55");
  for (const [role, st] of seen) {
    if (role === "buyer") assert.equal(st.private.floorCents, undefined);
    else assert.equal(st.private.budgetCents, undefined);
  }
  const ok = await negotiate({ order: order("N1"), rules: book, propose: async () => ({ action: "ACCEPT", reasoning: "meets target", model: "m", ms: 1 }) });
  assert.deepEqual([ok.deal, ok.priceCents, ok.moves[1].source, ok.moves[1].guard], [true, 385, "ai", "kept"]);
});

test("llm.mjs: JSON reply parsing; key only from the env; errors throw (→ rules)", async () => {
  assert.deepEqual(parseProposal('Sure: {"action":"counter","price":402,"reasoning":"meet halfway"}'), { action: "COUNTER", price: 402, reasoning: "meet halfway" });
  assert.throws(() => parseProposal('{"action":"COUNTER","price":"abc"}'), /integer price/);
  assert.throws(() => parseProposal("no json"), /no JSON/);
  assert.equal(createLlmProposer({}), null, "not configured → no proposer");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.authorization, JSON.parse(init.body)]);
    return { ok: true, json: async () => ({ model: "gw-model", choices: [{ message: { content: '{"action":"ACCEPT","reasoning":"fine"}' } }] }) };
  };
  const p = createLlmProposer({ baseUrl: "http://127.0.0.1:9/", model: "x", env: { SIGNATORY_LLM_API_KEY: "k-test" }, fetchImpl });
  const out = await p("seller", { round: 1 });
  assert.deepEqual([out.action, out.model], ["ACCEPT", "gw-model"]);
  assert.equal(calls[0][0], "http://127.0.0.1:9/v1/chat/completions");
  assert.equal(calls[0][1], "Bearer k-test");
  assert.doesNotMatch(JSON.stringify(out), /k-test/);
  await assert.rejects(createLlmProposer({ baseUrl: "http://x", env: {}, fetchImpl })("seller", {}), /SIGNATORY_LLM_API_KEY is not set/);
  const bad = createLlmProposer({ baseUrl: "http://x", env: { SIGNATORY_LLM_API_KEY: "k" }, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(bad("buyer", {}), /HTTP 503/);
});

// ------------------------------------------------------------------ swarm

test("swarm: inventory, logistics and both treasuries from the DD5 data + the mandate; identities from the vLEI evidence", () => {
  const [inv, lg] = preDealChecks({ book, order: order("N1"), evidence });
  assert.equal(inv.data.shortfall, 0);
  assert.equal(inv.identity.alias, "JupiterInventoryAgent");
  assert.equal(lg.identity.alias, "JupiterLogisticsAgent"); // #14 (not in the frozen fixture → shown unverified)
  assert.equal(lg.identity.verified, false);
  assert.match(lg.identity.note, /not in the export/);
  assert.equal(lg.data.cheapest.scac, "MSCU");
  assert.equal(lg.data.fastest.scac, "MAEU");
  const [inv2] = preDealChecks({ book, order: order("N2"), evidence });
  assert.deepEqual([inv2.data.shortfall, inv2.data.leadTimeDays], [5000, 30]);
  const st = sellerTreasury(book.sellerTreasury, 20000, 385);
  assert.equal(st.approved, true);
  assert.equal(st.revenueCents, 7700000);
  assert.equal(st.costCents, 20000 * 330 + 30000);
  const t1 = treasuryChecks({ book, order: order("N1"), priceCents: 385, evidence, mandate: MANDATE, maxUnits: 250000n, decimals: 6, demoScale: 1000000 });
  assert.deepEqual([t1.ok, t1.units, t1.checks[1].data.route], [true, 77000n, "agent"]);
  const t2 = treasuryChecks({ book, order: order("N2"), priceCents: 373, evidence, mandate: MANDATE, maxUnits: 250000n, decimals: 6, demoScale: 1000000 });
  assert.equal(t2.checks[1].data.route, "cpo");
  const t3 = treasuryChecks({ book, order: order("N2"), priceCents: 373, evidence, mandate: MANDATE, maxUnits: 100000n, decimals: 6, demoScale: 1000000 });
  assert.deepEqual([t3.ok, t3.checks[1].data.route], [false, "blocked"]);
  assert.equal(t1.checks[0].identity.alias, "JupiterTreasuryAgent");
  assert.equal(t1.checks[1].identity.alias, "TommyTreasuryAgent");
});

// ------------------------------------------------------------------ engine mode "order"

const INV3 = "EBQy-FlPtaa6_kh-BZI5Cn-ndtJ2It5Q3JNDMH3oYY1z";
function fakeOrder({ pending = false } = {}) {
  const chain = {};
  const calls = [];
  const ev = evidence;
  const deps = {
    orderBook: book,
    negotiator: "rules",
    propose: null,
    loadEvidence: () => ev,
    getInvoice: async (s) => chain[s] ?? null,
    getMandate: async () => MANDATE,
    preflight: async () => {
      calls.push(["preflight"]);
      return { ok: true, checks: [{ name: "bridge", ok: true, detail: "up", api: { service: "bridge" } }], mandate: MANDATE };
    },
    nextInvoiceNumber: () => ({ invoiceNumber: "INV-2026-0003", highest: {} }),
    writeInvoiceConfig: (n, units, meta = {}) => {
      calls.push(["config", n, units.toString(), meta.item ?? null, meta.quantity ?? null]);
      return { path: "/x", relPath: "./appconfig/generated-runs/x.json", description: "desc" };
    },
    runIssue: async () => {
      calls.push(["issue"]);
      return { exitCode: 0, stdout: `✓ INV-2026-0003 (${INV3}) issued, granted, admitted and held by tommyBuyerAgent\n`, stderr: "", ms: 1 };
    },
    readGrantInfo: () => ({ grantSaid: "EGRANT", path: "/g", timestamp: "t" }),
    runVerifyBuyer: async () => {
      calls.push(["verify_buyer"]);
      return { exitCode: 0, stdout: "All checks passed.\n", stderr: "", ms: 1, cmd: "x", evidence: ev };
    },
    runExport: async () => {
      calls.push(["export"]);
      return { exitCode: 0, stdout: "All checks passed.\n", stderr: "", ms: 1 };
    },
    bridgeRegister: async (said) => {
      calls.push(["register"]);
      chain[said] = { status: "registered" };
      return { ok: true, sent: true, txHash: "TXREG", txUrl: "u/TXREG", checks: [] };
    },
    signerPay: async (said) => {
      calls.push(["pay"]);
      if (pending) {
        chain[said] = { status: "pending" };
        return { ok: true, txHash: "TXPAY", txUrl: "u/TXPAY", outcome: { event: "payment_pending", limit_units: "100000", approver: MANDATE.approver, amount_units: "149200" } };
      }
      chain[said] = { status: "paid" };
      return { ok: true, txHash: "TXPAY", txUrl: "u/TXPAY", outcome: { event: "paid", via: "within_limit", amount_units: "77000" } };
    },
    signerDecide: async (kind, said) => {
      calls.push([kind]);
      chain[said] = { status: kind === "approve" ? "paid" : "rejected" };
      return { ok: true, txHash: "TXDEC", txUrl: "u/TXDEC" };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };
  return { deps, calls };
}
async function until(run, pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred(run)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout; events: ${run.events.map((e) => (e.data.step ? `${e.data.step}:${e.data.status}` : e.data.state)).join(",")}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const finished = (r) => r.state === "finished";
const waiting = (r) => r.state === "waiting" && r.waiter;
const finals = (run) => run.events.filter((e) => e.type === "step" && e.data.status !== "running").map((e) => `${e.data.index}:${e.data.step}:${e.data.status}`);

test("order N1: swarm → negotiate (round 1) → treasury → verify/issue/… → paid; invoice amount = negotiated total", async () => {
  const { deps, calls } = fakeOrder();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ mode: "order", order: "N1" });
  await until(run, finished);
  assert.equal(run.result, "paid", JSON.stringify(run.events).slice(0, 1500));
  assert.deepEqual(run.events[0].data.steps, STEPS_C);
  assert.deepEqual(finals(run), [
    "1:request:done", "2:verify_buyer:done", "3:swarm:done", "5:verify_seller_agent:done", "4:negotiate:done", "6:escalation:skipped",
    "7:treasury:done", "8:issue:done", "9:offer:done", "10:verify_seller:done", "11:accept:done", "12:register:done", "13:pay:done", "14:outcome:done",
  ]);
  // #4c-2: the buyer verifies the seller agent when the seller's first answer arrives (N1: its round-1 ACCEPT)
  assert.equal(run.events.find((e) => e.data.step === "verify_seller_agent" && e.data.status === "done").data.data.trigger, "jupiterSellerAgent's round 1 accept");
  // #4c: verified BEFORE any price talk, and the buyer is verified only once
  assert.deepEqual(calls.map((c) => c[0]).slice(0, 2), ["preflight", "verify_buyer"]);
  assert.equal(calls.filter((c) => c[0] === "verify_buyer").length, 1);
  const vsa = run.events.find((e) => e.data.step === "verify_seller_agent" && e.data.status === "done").data;
  assert.deepEqual([vsa.actor.id, vsa.target.id, vsa.data.officer], ["tommyBuyerAgent", "jupiterSellerAgent", "Jupiter_Chief_Sales_Officer"]);
  assert.deepEqual(calls.find((c) => c[0] === "config"), ["config", "INV-2026-0003", "77000", "cotton fabric", 20000]);
  const neg = run.events.find((e) => e.data.step === "negotiate" && e.data.status === "done").data;
  assert.equal(neg.data.priceCents, 385);
  assert.equal(neg.data.negotiator, "rules");
  for (const e of run.events.filter((x) => x.type === "step")) assert.equal(e.data.api.orchestrator, "runner (no keys)");
});

test("order N2: above the agent mandate → on-chain pending → CPO approves → paid", async () => {
  const { deps, calls } = fakeOrder({ pending: true });
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ mode: "order", order: "N2" });
  await until(run, waiting);
  assert.equal(run.events.find((e) => e.data.step === "treasury").data.data.checks[1].data.route, "cpo");
  assert.deepEqual(calls.find((c) => c[0] === "config").slice(2), ["149200", "cotton fabric", 40000]);
  await runner.decide(run.id, "approve");
  await until(run, finished);
  assert.equal(run.result, "paid");
});

test("order N4: no deal → escalation waits for the officer; reject = nothing issued; approve = buy at the seller's last price", async () => {
  {
    const { deps, calls } = fakeOrder();
    const runner = createRunner({ cfg, deps, pollMs: 1 });
    const run = await runner.start({ mode: "order", order: "N4" });
    await until(run, waiting);
    const esc = run.events.find((e) => e.data.step === "escalation").data;
    assert.deepEqual([esc.status, esc.data.proposedCents, esc.data.signed], ["waiting", 410, false]);
    assert.deepEqual(await runner.decide(run.id, "reject"), { ok: true, decision: "reject" });
    await until(run, finished);
    assert.equal(run.result, "no_deal");
    assert.ok(!calls.some((c) => ["config", "issue", "register", "pay"].includes(c[0])), "nothing issued or paid");
  }
  {
    const { deps, calls } = fakeOrder();
    const runner = createRunner({ cfg, deps, pollMs: 1 });
    const run = await runner.start({ mode: "order", order: "N4" });
    await until(run, waiting);
    await runner.decide(run.id, "approve");
    await until(run, finished);
    assert.equal(run.result, "paid");
    assert.deepEqual(calls.find((c) => c[0] === "config").slice(2, 3), ["82000"]); // 20,000 × $4.10
  }
});

test("order input rules: unknown order 404, missing id 400, not configured 501; other modes unchanged", async () => {
  const { deps } = fakeOrder();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  await assert.rejects(runner.start({ mode: "order", order: "N9" }), /no order N9/);
  await assert.rejects(runner.start({ mode: "order" }), /needs \{order/);
  const { orderBook, ...noBook } = deps;
  await assert.rejects(createRunner({ cfg, deps: noBook }).start({ mode: "order", order: "N1" }), /not configured/);
  await assert.rejects(runner.start({ mode: "bogus", text: "x" }), /mode must be/);
});

test("HTTP: GET /orders, /health lists mode order, POST /run {mode:order}; 501 without an order book", async () => {
  const { startRunnerServer } = await import("../runner/index.mjs");
  const { deps } = fakeOrder();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const server = startRunnerServer({ cfg, runner, deps, port: 0, allowOrigin: "http://127.0.0.1:8765", signerUrl: "http://127.0.0.1:9", bridgeUrl: "http://127.0.0.1:9" });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const o = await (await fetch(`${base}/orders`)).json();
    assert.deepEqual([o.ok, o.negotiator, o.orders.map((x) => x.id)], [true, "rules", ["N1", "N2", "N3", "N4"]]);
    const h = await (await fetch(`${base}/health`)).json();
    assert.deepEqual([h.modes, h.negotiator], [["invoice", "issue", "order"], "rules"]);
    const r = await (await fetch(`${base}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "order", order: "N1" }) })).json();
    assert.deepEqual([r.ok, r.mode], [true, "order"]);
    await until(runner.get(r.runId), finished);
  } finally {
    server.close();
  }
  const { orderBook, ...noBook } = deps;
  const s2 = startRunnerServer({ cfg, runner: createRunner({ cfg, deps: noBook }), deps: noBook, port: 0, allowOrigin: "x", signerUrl: "http://127.0.0.1:9", bridgeUrl: "http://127.0.0.1:9" });
  await new Promise((r) => s2.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${s2.address().port}/orders`);
    assert.equal(res.status, 501);
  } finally {
    s2.close();
  }
});

test("4a: sub-agents (Inventory, both Treasuries) are verified through their parent agent → officer → LE", async () => {
  const { identity } = await import("../runner/swarm.mjs");
  for (const [sub, parent] of [["JupiterInventoryAgent", "jupiterSellerAgent"], ["JupiterTreasuryAgent", "jupiterSellerAgent"], ["TommyTreasuryAgent", "tommyBuyerAgent"]]) {
    const id = identity(evidence, sub);
    assert.equal(id.verified, true, `${sub}: ${id.note}`);
    assert.equal(id.subAgentOf, parent);
    assert.match(id.chain, new RegExp(`^${sub} → ${parent} → .+ → .+`));
  }
  const ev2 = JSON.parse(JSON.stringify(evidence));
  ev2.companies.flatMap((c) => c.agents).find((a) => a.alias === "JupiterInventoryAgent").delegationVerified = false;
  const bad = identity(ev2, "JupiterInventoryAgent");
  assert.deepEqual([bad.verified, bad.note], [false, "JupiterInventoryAgent → jupiterSellerAgent delegation not verified"]);
  assert.equal(identity(evidence, null).verified, false);
});

test("4b: --pace-ms pauses between swarm checks, moves and treasury checks (0 = no pauses)", async () => {
  for (const [paceMs, min] of [[0, 0], [7, 1]]) {
    const { deps } = fakeOrder();
    const slept = [];
    const base = deps.sleep;
    deps.sleep = (ms) => { slept.push(ms); return base(ms); };
    const runner = createRunner({ cfg, deps, pollMs: 1, paceMs });
    const run = await runner.start({ mode: "order", order: "N3" });
    await until(run, finished);
    assert.equal(run.result, "paid");
    const paced = slept.filter((ms) => ms === 7).length;
    if (min) assert.equal(paced, 2 + 6 + 1 + 2, "2 swarm checks + 6 moves (N3) + 1 seller verification + 2 treasury checks");
    else assert.equal(paced, 0);
  }
});

test("B: a failed negotiation is shown as no_deal (amber), not failed", async () => {
  const { deps } = fakeOrder();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ mode: "order", order: "N4" });
  await until(run, waiting);
  const neg = run.events.filter((e) => e.data.step === "negotiate" && e.data.status !== "running").pop().data;
  assert.equal(neg.status, "no_deal");
  await runner.decide(run.id, "reject");
  await until(run, finished);
});

test("4c: an unverified buyer stops before the swarm; an unverified seller agent stops on its first answer", async () => {
  {
    const { deps, calls } = fakeOrder();
    deps.runVerifyBuyer = async () => ({ exitCode: 1, stdout: "", stderr: "strict check failed", ms: 1, cmd: "x", evidence: null });
    const runner = createRunner({ cfg, deps, pollMs: 1 });
    const run = await runner.start({ mode: "order", order: "N1" });
    await until(run, finished);
    assert.equal(run.result, "seller_refused");
    assert.ok(!run.events.some((e) => ["swarm", "negotiate"].includes(e.data.step)), "no swarm, no negotiation");
    assert.ok(!calls.some((c) => ["config", "issue", "register", "pay"].includes(c[0])));
  }
  {
    const { deps, calls } = fakeOrder();
    const ev = JSON.parse(JSON.stringify(evidence));
    ev.companies.flatMap((c) => c.agents).find((a) => a.alias === "jupiterSellerAgent").delegationVerified = false;
    deps.runVerifyBuyer = async () => ({ exitCode: 0, stdout: "All checks passed.\n", stderr: "", ms: 1, cmd: "x", evidence: ev });
    const runner = createRunner({ cfg, deps, pollMs: 1 });
    const run = await runner.start({ mode: "order", order: "N3" });
    await until(run, finished);
    assert.equal(run.result, "buyer_refused");
    assert.equal(run.events.filter((e) => e.data.step === "verify_seller_agent").pop().data.status, "failed");
    const last = run.events.filter((e) => e.data.step === "negotiate").pop().data.data.moves;
    assert.deepEqual(last.map((m) => m.from), ["buyer", "seller"], "stopped right after the seller's first answer: the buyer never replied");
    assert.ok(!calls.some((c) => ["config", "issue", "register", "pay"].includes(c[0])));
  }
});
