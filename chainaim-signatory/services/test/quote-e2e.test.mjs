// Quote flow regressions from the 10-scenario end-to-end run (services/chain-10.mjs) on OutcomeAI's 10-SKU Jupiter data.
// No keys, no network: agent answers are replayed from fixtures/quote-agent-responses/S0x.json (live recordings, AI off).
//   S03 credit over the buyer's limit  → the agent cannot close it; the CEO decides (was: agent accepted)
//   S05 split shipment                 → the buyer message names both shipment dates, not one delivered-by date
//   S07 Tier-1 reallocation + credit   → CEO, both reasons recorded
//   S08 air needs the CEO, MEDIUM deal → the CEO is asked (was: declined by the agent, nobody asked)
//   S10 no supply plan at any level    → DECLINE without a crash and without a treasury call (was: TDZ crash)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "../../scripts/lib/common.mjs";
import { createRuleBuyer } from "../runner/quote-buyer.mjs";
import { escalationChain, loadQuotePolicy, REASONS, runQuote, treasuryGate, validatePolicy } from "../runner/quote-flow.mjs";

const policy = loadQuotePolicy(resolve(ROOT, "config", "quote-authority.json"));
const FIX = resolve(ROOT, "services", "test", "fixtures", "quote-agent-responses");
const fixture = (id) => JSON.parse(readFileSync(join(FIX, `${id}.json`), "utf8"));

function replayClient(rec) {
  const byKey = new Map(rec.calls.map((c) => [`${c.alias}|${c.path}|${JSON.stringify(c.request)}`, c]));
  const calls = [];
  return {
    calls,
    async call(alias, path, body) {
      calls.push({ alias, path, body });
      const c = byKey.get(`${alias}|${path}|${JSON.stringify(body)}`);
      if (!c) throw new Error(`no recorded answer for ${alias} ${path} ${JSON.stringify(body).slice(0, 160)}`);
      return { body: structuredClone(c.response), api: { service: "outcome", method: "POST", path, alias, httpStatus: c.httpStatus, ms: 0, requestId: "replay" } };
    },
  };
}

async function run(id, { approve = ["SALES_OFFICER", "CEO"], pol = policy } = {}) {
  const rec = fixture(id);
  const client = replayClient(rec);
  const asked = [];
  const quotes = [];
  const records = {};
  const summary = await runQuote({
    rfq: rec.rfq, policy: pol, client, ai: false,
    buyer: createRuleBuyer(rec.buyerSim, rec.rfq.items[0].custom_target_rate_cents),
    decide: async (req) => { asked.push(req.level); return { decision: approve.includes(req.level) ? "approve" : "reject", who: req.alias }; },
    record: async (name, obj) => { records[name] = JSON.parse(JSON.stringify(obj)); },
    onStep: async (ev) => { if (ev.type === "quote") quotes.push(ev); },
    now: () => "2026-11-16T00:00:00.000Z",
  });
  return { summary, asked, quotes, records, calls: client.calls };
}

test("S10: no supply plan at any authority → DECLINE, no crash, no treasury call, no quotation", async () => {
  const { summary, records, calls } = await run("S10");
  assert.equal(summary.decision, "DECLINE");
  assert.equal(summary.priceCents, null);
  assert.deepEqual(summary.reasons, [REASONS.NO_SUPPLY_PLAN]);
  assert.equal(summary.decidedBy, "AGENT");
  assert.equal(calls.some((c) => c.path === "agents/treasury"), false);
  assert.equal(records["final.quote.json"].quotation, null);
  assert.equal(records["jupiter-internal.json"].floors, null);
});

test("S03: credit over the buyer's limit → agent cannot close; Sales Officer forwarded, CEO decides", async () => {
  const { summary, asked, records } = await run("S03");
  assert.ok(summary.reasons.includes(REASONS.CREDIT_OVER_LIMIT));
  assert.equal(summary.level, "CEO");
  assert.deepEqual(asked, ["CEO"]);
  assert.deepEqual(summary.escalations, ["SALES_OFFICER:FORWARDED", "CEO:approve"]);
  assert.equal(summary.decision, "ACCEPT");
  assert.equal(summary.decidedBy, "CEO");
  assert.equal(summary.priceCents, 319);
  assert.ok(summary.priceCents >= summary.floors.CEO);
  assert.deepEqual(records["jupiter-internal.json"].treasuryChecks.map((t) => [t.check, t.minLevel]), [["creditOverLimit", "CEO"]]);
});

test("S03: CEO rejects → DECLINE by the CEO", async () => {
  const { summary } = await run("S03", { approve: [] });
  assert.equal(summary.decision, "DECLINE");
  assert.equal(summary.decidedBy, "CEO");
});

test("S03: with treasuryChecks.creditOverLimit removed, the agent closes it as before (the check is config, not code)", async () => {
  const pol = structuredClone(policy);
  delete pol.treasuryChecks.creditOverLimit;
  const { summary, asked } = await run("S03", { pol });
  assert.deepEqual(asked, []);
  assert.equal(summary.decidedBy, "AGENT");
  assert.equal(summary.reasons.includes(REASONS.CREDIT_OVER_LIMIT), false);
});

test("S07: Tier-1 reallocation and credit over limit → CEO, both reasons", async () => {
  const { summary, asked } = await run("S07");
  assert.deepEqual(summary.reasons, [REASONS.SUPPLY_NEEDS_AUTHORITY, REASONS.CREDIT_OVER_LIMIT]);
  assert.deepEqual(asked, ["CEO"]);
  assert.equal(summary.decision, "ACCEPT");
  assert.equal(summary.decidedBy, "CEO");
  assert.deepEqual(summary.shipments, [{ units: 45000, deliveredBy: "2026-12-24" }]);
});

test("S08: air needs the CEO on a MEDIUM deal → the CEO is asked, not an agent decline", async () => {
  const { summary, asked, records } = await run("S08");
  assert.equal(summary.importance.band, "MEDIUM");
  assert.deepEqual(asked, ["CEO"]);
  assert.deepEqual(summary.escalations, ["SALES_OFFICER:FORWARDED", "CEO:approve"]);
  assert.equal(summary.decision, "ACCEPT");
  assert.equal(summary.decidedBy, "CEO");
  assert.ok(records["jupiter-internal.json"].plan.every((c) => c.mode === "AIR"));
});

test("S05: split shipment → the buyer message names both shipments, not one delivered-by date", async () => {
  const { summary, quotes } = await run("S05");
  assert.equal(summary.decision, "ACCEPT");
  assert.deepEqual(summary.shipments, [{ units: 6000, deliveredBy: "2026-12-28" }, { units: 2000, deliveredBy: "2027-02-02" }]);
  for (const q of quotes) {
    assert.ok(!q.message.includes("delivered by 2026-12-28"), q.message);
    assert.ok(q.message.includes("Delivery in two shipments: 6,000 by 2026-12-28 and 2,000 by 2027-02-02."), q.message);
  }
});

test("escalationChain extends the importance chain up to the level the deal needs; treasuryGate and config checks", () => {
  assert.deepEqual(escalationChain(policy, ["SALES_OFFICER"], "CEO"), ["SALES_OFFICER", "CEO"]);
  assert.deepEqual(escalationChain(policy, [], "SALES_OFFICER"), ["SALES_OFFICER"]);
  assert.deepEqual(escalationChain(policy, [], "AGENT"), []);
  assert.deepEqual(escalationChain(policy, ["SALES_OFFICER", "CEO"], "AGENT"), ["SALES_OFFICER", "CEO"]);
  const tre = { credit: { ok: false, headroomUsd: 1 }, liquidity: { status: "DEFICIT", net30Usd: 2 } };
  assert.deepEqual(treasuryGate(policy, tre, { advance: false }).map((t) => t.check), ["creditOverLimit"]);
  const on = { ...policy, treasuryChecks: { creditOverLimit: { minLevel: "CEO" }, liquidityDeficit: { minLevel: "SALES_OFFICER" } } };
  assert.deepEqual(treasuryGate(on, tre, { advance: false }).map((t) => t.check), ["creditOverLimit", "liquidityDeficit"]);
  assert.deepEqual(treasuryGate(on, tre, { advance: true }).map((t) => t.check), ["creditOverLimit"], "the advance lever answers a DEFICIT");
  assert.deepEqual(validatePolicy({ ...policy, treasuryChecks: { creditOverLimit: { minLevel: "AGENT" } } }).filter((e) => e.includes("treasuryChecks")).length, 1);
  assert.deepEqual(validatePolicy({ ...policy, treasuryChecks: { bogus: {} } }).filter((e) => e.includes("treasuryChecks")).length, 1);
});
