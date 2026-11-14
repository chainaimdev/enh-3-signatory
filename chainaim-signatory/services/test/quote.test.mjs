// Quote flow (S-4): Tommy RFQ → jupiterSellerAgent → OutcomeAI agents → rounds → vLEI escalation.
// No keys, no network: OutcomeAI answers are replayed from fixtures/quote-agent-responses/*.json (recorded against the
// section 4 contract), and the expected outcomes are the data-pack generator's oracle (fixtures/quote-expected-outcomes.csv).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ROOT } from "../../scripts/lib/common.mjs";
import { FIXTURE_EVIDENCE } from "./fixture.mjs";
import { createOutcomeClient, OutcomeError } from "../shared/outcome-client.mjs";
import { buildQuotation, leakScan, parseRfq, validateQuotation, validateRfq } from "../runner/quote-objects.mjs";
import { createRuleBuyer, roundHalfEven } from "../runner/quote-buyer.mjs";
import { guardRound, importanceOf, loadQuotePolicy, REASONS, runQuote, validatePolicy } from "../runner/quote-flow.mjs";

const policy = loadQuotePolicy(resolve(ROOT, "config", "quote-authority.json"));
const book = JSON.parse(readFileSync(resolve(ROOT, "data", "quote", "inquiries.json"), "utf8"));
const evidence = JSON.parse(readFileSync(FIXTURE_EVIDENCE, "utf8"));
const FIX = resolve(ROOT, "services", "test", "fixtures");
const oracle = (() => {
  const [head, ...lines] = readFileSync(join(FIX, "quote-expected-outcomes.csv"), "utf8").trim().split(/\r?\n/);
  const h = head.split(",");
  return Object.fromEntries(lines.map((l) => {
    const v = l.split(",");
    const r = Object.fromEntries(h.map((k, i) => [k, v[i]]));
    return [r.inquiry_id.replace("RFQ-", ""), r];
  }));
})();
const inquiry = (id) => book.inquiries.find((q) => q.id === id);
const LEVEL_OF = { jupiterSellerAgent: "AGENT", SALES_OFFICER: "SALES_OFFICER", CEO: "CEO" };

/** Replays recorded OutcomeAI answers by (alias, path, request body); counts calls. */
function replayClient(id, { synthesize } = {}) {
  const rec = JSON.parse(readFileSync(join(FIX, "quote-agent-responses", `${id}.json`), "utf8"));
  const byKey = new Map(rec.calls.map((c) => [`${c.alias}|${c.path}|${JSON.stringify(c.request)}`, c]));
  const calls = [];
  return {
    calls,
    async call(alias, path, body) {
      calls.push({ alias, path, body });
      if (path === "seller/synthesize" && synthesize) return synthesize(alias, body, calls.length);
      const c = byKey.get(`${alias}|${path}|${JSON.stringify(body)}`);
      if (!c) throw new Error(`no recorded answer for ${alias} ${path} ${JSON.stringify(body).slice(0, 160)}`);
      return { body: structuredClone(c.response), api: { service: "outcome", method: "POST", path, alias, httpStatus: c.httpStatus, ms: 0, requestId: "replay" } };
    },
  };
}

async function run(id, { synthesize, approve = ["SALES_OFFICER", "CEO"], ai = true, rfq } = {}) {
  const q = inquiry(id);
  const client = replayClient(id, { synthesize });
  const records = {};
  const summary = await runQuote({
    rfq: rfq ?? q.rfq,
    policy,
    client,
    ai,
    buyer: createRuleBuyer(q.buyerSim, q.rfq.items[0].custom_target_rate_cents),
    decide: async (req) => ({ decision: approve.includes(req.level) ? "approve" : "reject", who: req.alias }),
    record: async (name, obj) => {
      records[name] = JSON.parse(JSON.stringify(obj));
    },
    now: () => "2026-11-16T00:00:00.000Z",
  });
  return { summary, records, calls: client.calls };
}

// ------------------------------------------------------------------ 1. authority config

test("quote-authority.json: margins fall 15 > 12 > 10 > 8, every level and preparer is a vLEI identity", () => {
  assert.deepEqual(validatePolicy(policy), []);
  const lv = Object.fromEntries(policy.levels.map((l) => [l.level, l]));
  assert.deepEqual([policy.targetMargin, lv.AGENT.minMargin, lv.SALES_OFFICER.minMargin, lv.CEO.minMargin], [0.15, 0.12, 0.1, 0.08]);
  assert.equal(policy.absoluteFloor, 0.08);
  const jupiter = evidence.companies.find((c) => c.lei === policy.seller.lei);
  const known = new Set([...jupiter.officers.map((o) => o.alias), ...jupiter.agents.map((a) => a.alias)]);
  for (const a of [policy.seller.alias, ...policy.levels.map((l) => l.alias), ...policy.levels.map((l) => l.preparedBy).filter(Boolean)]) assert.ok(known.has(a), `${a} is in the vLEI evidence`);
  for (const a of ["JupiterInventoryAgent", "JupiterTreasuryAgent"]) assert.ok(known.has(a), `${a} is in the vLEI evidence`);
  assert.equal(known.has("JupiterLogisticsAgent"), false, "JupiterLogisticsAgent is not in the frozen evidence yet (change #14)");
  const broken = structuredClone(policy);
  broken.levels.find((l) => l.level === "SALES_OFFICER").minMargin = 0.13;
  assert.ok(validatePolicy(broken).some((e) => e.includes("margins must fall")));
});

// ------------------------------------------------------------------ 2. objects

test("RFQ and Quotation objects validate against the ERPNext-shaped schemas; bad ones are refused", () => {
  for (const q of book.inquiries) assert.deepEqual(validateRfq(q.rfq), [], q.id);
  const bad = structuredClone(inquiry("T01").rfq);
  delete bad.items[0].schedule_date;
  bad.custom_from_lei = "x";
  const errs = validateRfq(bad);
  assert.ok(errs.some((e) => e.includes("schedule_date: required")) && errs.some((e) => e.includes("custom_from_lei")));
  assert.throws(() => parseRfq(bad), /not valid/);
  const rq = parseRfq(inquiry("T07").rfq);
  const qn = buildQuotation({ rfq: rq, seller: { alias: "jupiterSellerAgent", company: "Jupiter Knitting Company" }, round: 2, decision: "ACCEPT", sku: rq.sku, priceCents: 418, shipments: [{ units: 45000, deliveredBy: "2026-12-31" }], counters: [], message: "ok", decidedBy: "Jupiter_Chief_Executive_Officer", final: true });
  assert.deepEqual(validateQuotation(qn), []);
  assert.equal(qn.items[0].rate, 4.18);
  assert.equal(qn.items[0].amount, 188100);
  assert.deepEqual(qn.payment_schedule.map((p) => [p.invoice_portion, p.payment_amount, p.due_date]), [[30, 56430, "2026-11-16"], [70, 131670, "2026-12-16"]]);
  assert.ok(validateQuotation({ ...qn, currency: "EUR" }).some((e) => e.includes("currency")));
});

test("leak scan: floors, cost, margin and percentages never reach the buyer; the quoted price may equal a floor", () => {
  const secrets = { cents: [415, 401, 392, 384, 353] };
  assert.equal(leakScan("RFQ-T08: we can offer 20,000 × FAB-COT-180-A at $4.15 per unit, delivered by 2027-01-12.", { ...secrets, allowCents: [415] }).ok, true);
  assert.equal(leakScan("We cannot go below $4.01.", secrets).ok, false);
  assert.equal(leakScan("Our floor is tight.", secrets).ok, false);
  assert.equal(leakScan("That leaves us a 9% margin.", secrets).ok, false);
  assert.equal(leakScan("Landed at 353 cents.", secrets).ok, false);
  assert.equal(leakScan("", secrets).ok, false);
});

// ------------------------------------------------------------------ 3. flow vs oracle

test("T01–T08 with recorded OutcomeAI answers: decision, price, rounds, decider, sku, band and floors equal the oracle", async () => {
  for (const q of book.inquiries) {
    const o = oracle[q.id];
    assert.ok(o, `oracle row for ${q.id}`);
    const { summary: s, records } = await run(q.id);
    for (const a of records["jupiter-internal.json"].ai) assert.equal(a.why, 'synthesize answered source "rules"', `${q.id}: every synthesize call was replayed (${a.why})`);
    const got = [s.decision, s.priceCents, s.rounds, s.decidedBy, s.sku, s.importance.band, s.floors.AGENT, s.floors.SALES_OFFICER, s.floors.CEO, s.premiumCents];
    const want = [o.final_decision, +o.final_price_cents, +o.rounds, LEVEL_OF[o.decided_by], o.offered_sku, o.importance_band, +o.agent_floor, +o.sales_officer_floor, +o.ceo_absolute_floor, +o.realloc_premium_cents];
    assert.deepEqual(got, want, q.id);
  }
});

test("escalation reasons are recorded per scenario", async () => {
  const reasons = {};
  for (const id of ["T01", "T05", "T06", "T07", "T08"]) reasons[id] = (await run(id)).summary.reasons;
  assert.deepEqual(reasons.T01, []);
  assert.deepEqual(reasons.T05, []);
  assert.deepEqual(reasons.T06, [REASONS.ROUNDS_EXPIRED, REASONS.PRICE_BELOW_AGENT_FLOOR]);
  assert.deepEqual(reasons.T07, [REASONS.SUPPLY_NEEDS_AUTHORITY]);
  assert.deepEqual(reasons.T08, [REASONS.ROUNDS_EXPIRED, REASONS.PRICE_BELOW_AGENT_FLOOR, REASONS.BELOW_ABSOLUTE_FLOOR]);
});

test("officer rejects (--approve none): T06 is declined by the Sales Officer; T07 by the CEO", async () => {
  const t6 = (await run("T06", { approve: [] })).summary;
  assert.deepEqual([t6.decision, t6.decidedBy, t6.priceCents], ["DECLINE", "SALES_OFFICER", 406]);
  const t7 = (await run("T07", { approve: ["SALES_OFFICER"] })).summary;
  assert.deepEqual([t7.decision, t7.decidedBy, t7.escalations], ["DECLINE", "CEO", ["SALES_OFFICER:FORWARDED", "CEO:reject"]]);
});

// ------------------------------------------------------------------ 4. re-consult

test("re-consult of the sub-agents happens only when the counter changes non-price terms (T04 quantity, T05 quality)", async () => {
  const re = {};
  for (const q of book.inquiries) re[q.id] = (await run(q.id)).summary.reconsults;
  assert.deepEqual(re.T04, ["reconsult-quantity"]);
  assert.deepEqual(re.T05, ["reconsult-quality"]);
  for (const id of ["T01", "T02", "T03", "T06", "T07", "T08"]) assert.deepEqual(re[id], [], id);
  const t5 = await run("T05");
  assert.equal(t5.calls.filter((c) => c.path === "agents/inventory").length, 2, "inventory asked again for the Grade A alternative");
});

// ------------------------------------------------------------------ 5. guard

test("guard: never below the level floor, never a downgrade, split only as planned, slip within the limit, no counter going up, clean message", () => {
  const rq = parseRfq(inquiry("T04").rfq);
  const AGENT = policy.levels[0];
  const plan = { sku: "FAB-COT-180-A", shipments: [{ units: 34000, deliveredBy: "2027-01-05" }, { units: 6000, deliveredBy: "2027-01-18" }] };
  const ctx = { lastBuyerCents: 415, floorCents: 416, prevAskCents: 430, plan, rfq: rq, level: AGENT, hasCounters: true, secrets: [416, 406, 398] };
  const C = (counter, decision = "COUNTER") => ({ decision, counter });
  assert.equal(guardRound(C({ priceCents: 410 }), ctx).ok, false);
  assert.equal(guardRound(C({ priceCents: 431 }), ctx).ok, false);
  assert.equal(guardRound(C({ priceCents: 425, sku: "FAB-COT-180-B" }), ctx).ok, false);
  assert.equal(guardRound(C({ priceCents: 425, shipments: [{ units: 20000, deliveredBy: "2027-01-05" }, { units: 20000, deliveredBy: "2027-02-20" }] }), ctx).ok, false);
  const slip = guardRound(C({ priceCents: 425, deadline: "2027-01-10" }), ctx);
  assert.deepEqual([slip.ok, slip.reason], [false, REASONS.DEADLINE_SLIP_OVER_LIMIT]);
  assert.equal(guardRound(C({ priceCents: 425 }), ctx, "We can do $4.25; our floor is $4.16.").ok, false);
  assert.equal(guardRound(C(null, "ACCEPT"), ctx).ok, false, "cannot accept as asked when the plan changes terms");
  assert.deepEqual(guardRound(C({ priceCents: 425, shipments: plan.shipments, deadline: "2027-01-08" }), ctx, "Offer: $4.25 per unit in two shipments."), { ok: true, decision: "COUNTER", priceCents: 425, message: "Offer: $4.25 per unit in two shipments." });
  assert.equal(guardRound(C({ priceCents: 420 }), { ...ctx, lastBuyerCents: 421 }).decision, "ACCEPT");
});

test("AI proposals inside the band are used (source ai); a proposal below the floor falls back to the rule", async () => {
  const good = await run("T02", {
    synthesize: async (alias, body) => ({ body: { proposal: { decision: "COUNTER", counter: { priceCents: body.round === 1 ? 412 : 405 } }, messageToBuyer: `We can offer $${body.round === 1 ? "4.12" : "4.05"} per unit.`, reasoning: "in band", source: "ai", model: "test-model", attest: { ok: true }, ms: 1 }, api: { httpStatus: 200, ms: 1 } }),
  });
  assert.deepEqual([good.summary.decision, good.summary.decidedBy, good.summary.source], ["ACCEPT", "AGENT", "ai"]);
  assert.ok(good.summary.priceCents >= good.summary.floors.AGENT && good.summary.priceCents <= 418);
  assert.deepEqual(good.records["final.quote.json"].attest, { ok: true });
  const low = await run("T02", { synthesize: async () => ({ body: { proposal: { decision: "COUNTER", counter: { priceCents: 300 } }, source: "ai", model: "m" }, api: { httpStatus: 200 } }) });
  assert.deepEqual([low.summary.priceCents, low.summary.rounds, low.summary.source], [411, 2, "rules"]);
  assert.match(low.records["jupiter-internal.json"].ai[0].guard, /below the level floor/);
});

// ------------------------------------------------------------------ 6. fallback

test("synthesize answers rules, fails with HTTP 502, or AI is off: the flow continues with the rules and the same outcome", async () => {
  const fail = async () => {
    throw new OutcomeError("HTTP_502", "OutcomeAI POST seller/synthesize → 502", 502);
  };
  for (const variant of [{}, { synthesize: fail }, { ai: false }]) {
    const { summary, records, calls } = await run("T06", variant);
    assert.deepEqual([summary.decision, summary.priceCents, summary.rounds, summary.decidedBy, summary.source], ["ACCEPT", 410, 4, "SALES_OFFICER", "rules"]);
    if (variant.ai === false) assert.equal(calls.filter((c) => c.path === "seller/synthesize").length, 0);
    if (variant.synthesize) assert.equal(records["jupiter-internal.json"].ai[0].error.httpStatus, 502);
  }
});

// ------------------------------------------------------------------ 7. isolation

test("isolation: seller modules never import the buyer module or read the buyer's private block", async () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const f of ["services/runner/quote-flow.mjs", "services/runner/quote-objects.mjs", "services/shared/outcome-client.mjs"]) {
    const src = strip(readFileSync(resolve(ROOT, f), "utf8"));
    assert.equal(/quote-buyer/.test(src), false, `${f} imports quote-buyer`);
    assert.equal(/buyerSim|budgetCents/.test(src), false, `${f} reads the buyer's private block`);
  }
  const q = inquiry("T03");
  const trap = new Proxy(structuredClone(q.rfq), { get: (t, k) => (k === "buyerSim" || k === "budgetCents" ? assert.fail(`read ${String(k)}`) : t[k]) });
  const { summary } = await run("T03", { rfq: trap });
  assert.equal(summary.priceCents, 413);
});

// ------------------------------------------------------------------ 8. records + client

test("records: inquiry, consults with api proof blocks, round quotes, escalations, final quote — no token anywhere", async () => {
  const dir = mkdtempSync(join(tmpdir(), "quote-"));
  const token = "tok-test-6f1b2c";
  const rec = JSON.parse(readFileSync(join(FIX, "quote-agent-responses", "T06.json"), "utf8"));
  const byKey = new Map(rec.calls.map((c) => [`${c.alias}|${c.path}|${JSON.stringify((({ requestId, ...b }) => b)(c.request))}`, c.response]));
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers.authorization, `Bearer ${token}`);
    const body = JSON.parse(init.body);
    assert.ok(body.requestId);
    const { requestId, ...rest } = body;
    const path = new URL(url).pathname.replace("/v1/tenants/jupiter-knitting/", "");
    const resp = byKey.get(`${init.headers["x-agent-alias"]}|${path}|${JSON.stringify(rest)}`);
    return new Response(JSON.stringify(resp ?? { error: { code: "NOT_RECORDED", message: path } }), { status: resp ? 200 : 404, headers: { "content-type": "application/json" } });
  };
  const client = createOutcomeClient({ baseUrl: "http://127.0.0.1:8785", env: { QUOTE_TOKEN_JUPITER: token }, fetchImpl });
  const q = inquiry("T06");
  await runQuote({
    rfq: q.rfq, policy, client, buyer: createRuleBuyer(q.buyerSim, q.rfq.items[0].custom_target_rate_cents),
    decide: async () => ({ decision: "approve", who: "test" }),
    record: async (name, obj) => writeFileSync(join(dir, name), JSON.stringify(obj, null, 2)),
  });
  const files = readdirSync(dir).sort();
  assert.deepEqual(files, ["consults.json", "escalations.json", "final.quote.json", "inquiry.json", "jupiter-internal.json", "round-1.quote.json", "round-2.quote.json", "round-3.quote.json", "round-4.quote.json"]);
  for (const f of files) assert.equal(readFileSync(join(dir, f), "utf8").includes(token), false, `${f} carries the token`);
  const consults = JSON.parse(readFileSync(join(dir, "consults.json"), "utf8"));
  const live = consults.filter((c) => !c.cached);
  assert.ok(live.every((c) => c.api.service === "outcome" && c.api.httpStatus === 200 && c.api.requestId && c.api.alias === c.alias));
  assert.deepEqual([...new Set(live.map((c) => c.alias))].sort(), ["JupiterInventoryAgent", "JupiterLogisticsAgent", "JupiterTreasuryAgent", "jupiterSellerAgent"]);
  const esc = JSON.parse(readFileSync(join(dir, "escalations.json"), "utf8"));
  assert.deepEqual(esc.map((e) => [e.level, e.decision, e.counterCents, e.floorCents]), [["SALES_OFFICER", "approve", 411, 406]]);
  const fin = JSON.parse(readFileSync(join(dir, "final.quote.json"), "utf8"));
  assert.deepEqual([fin.priceCents, fin.decidedByAlias, fin.quotation.name, fin.quotation.items[0].custom_rate_cents], [410, "Jupiter_Chief_Sales_Officer", "QTN-T06-FINAL", 410]);
  for (const f of files.filter((n) => /quote\.json$/.test(n))) {
    const doc = JSON.parse(readFileSync(join(dir, f), "utf8"));
    const msg = (doc.quotation ?? doc).custom_message_to_buyer;
    assert.equal(/floor|margin|cost/i.test(msg), false, `${f}: ${msg}`);
  }
});

test("outcome client: no token → no call; HTTP errors carry code and status; timeouts map to 504", async () => {
  let called = false;
  const c0 = createOutcomeClient({ baseUrl: "http://x", env: {}, fetchImpl: async () => ((called = true), new Response("{}")) });
  await assert.rejects(c0.call("JupiterInventoryAgent", "agents/inventory", {}), (e) => e.code === "NO_TOKEN");
  assert.equal(called, false);
  const c1 = createOutcomeClient({ baseUrl: "http://x", env: { QUOTE_TOKEN_JUPITER: "t" }, fetchImpl: async () => new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "alias" } }), { status: 403 }) });
  await assert.rejects(c1.call("jupiterSellerAgent", "agents/inventory", {}), (e) => e.code === "FORBIDDEN" && e.httpStatus === 403);
  const c2 = createOutcomeClient({ baseUrl: "http://x", env: { QUOTE_TOKEN_JUPITER: "t" }, fetchImpl: async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); } });
  await assert.rejects(c2.call("a", "agents/inventory", {}), (e) => e.code === "TIMEOUT" && e.httpStatus === 504);
});

test("buyer rules: round 1 counters, later accepts within budget, half-to-even rounding as the generator", () => {
  assert.deepEqual([roundHalfEven(401.5), roundHalfEven(402.5), roundHalfEven(404.2)], [402, 402, 404]);
  const b = createRuleBuyer({ budgetCents: 412, concession: 0.5, behaviour: "price" }, 390);
  assert.deepEqual(b.respond({ round: 1, askCents: 400 }), { action: "COUNTER", priceCents: 395, reasoning: "Round 1: counter" });
  assert.equal(b.respond({ round: 2, askCents: 404 }).action, "ACCEPT");
  assert.deepEqual(b.respond({ phase: "escalation", round: 4, askCents: 420 }), { action: "COUNTER", priceCents: 412, reasoning: "Best and final offer" });
  assert.throws(() => createRuleBuyer({ budgetCents: 400, concession: 0.5, behaviour: "deadline" }, 380), /not supported/);
});

test("importance: Tommy TIER1 + deal size + spare capacity → HIGH above $75k, MEDIUM below", () => {
  assert.equal(importanceOf(policy, "54930012QJWZMYHNJW95", 20000, 415).band, "HIGH");
  assert.deepEqual([importanceOf(policy, "54930012QJWZMYHNJW95", 12000, 433).score, importanceOf(policy, "54930012QJWZMYHNJW95", 12000, 433).band], [65, "MEDIUM"]);
  assert.equal(importanceOf(policy, "UNKNOWNLEI0000000000", 1000, 400).band, "LOW");
});
