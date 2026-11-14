// tommyBuyerAgent through Tommy's own OutcomeAI tenant (quote-buyer-outcome.mjs): agents/treasury before the RFQ and
// after agreement, buyer/synthesize for each move. Replayed from fixtures/quote-buyer-responses/S01..S10.json (live
// recordings) together with Jupiter's fixtures: the 10 rig scenarios end exactly as with the rule buyer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "../../scripts/lib/common.mjs";
import { runRig } from "../../scripts/quote-rig.mjs";
import { createOutcomeBuyer } from "../runner/quote-buyer-outcome.mjs";
import { loadQuotePolicy } from "../runner/quote-flow.mjs";

const policy = loadQuotePolicy(resolve(ROOT, "config", "quote-authority.json"));
const book = JSON.parse(readFileSync(resolve(ROOT, "data", "quote", "rig-scenarios.json"), "utf8"));
const FIX = resolve(ROOT, "services", "test", "fixtures");

function replay(folder) {
  const byKey = new Map();
  for (const q of book.inquiries) for (const c of JSON.parse(readFileSync(join(FIX, folder, `${q.id}.json`), "utf8")).calls) byKey.set(`${c.alias}|${c.path}|${JSON.stringify(c.request)}`, c);
  const calls = [];
  return {
    calls,
    async call(alias, path, body) {
      calls.push({ alias, path, body });
      const c = byKey.get(`${alias}|${path}|${JSON.stringify(body)}`);
      if (!c) throw new Error(`no recorded answer for ${alias} ${path} ${JSON.stringify(body)}`);
      return { body: structuredClone(c.response), api: { httpStatus: 200, ms: 0 } };
    },
  };
}

test("outcome buyer: all 10 scenarios end as expected, with Tommy's treasury first and buyer synthesis per move", async () => {
  const rows = await runRig({ scenarios: book.inquiries, policy, client: replay("quote-agent-responses"), buyerClient: replay("quote-buyer-responses"), ai: false });
  for (const r of rows) {
    assert.ok(r.ok, `${r.id}: ${r.diffs.join("; ")}`);
    assert.equal(r.buyerCalls[0], "TommyTreasuryAgent agents/treasury", `${r.id}: Tommy asks his treasury before the RFQ`);
    for (const c of r.buyerCalls) assert.ok(["TommyTreasuryAgent agents/treasury", "tommyBuyerAgent buyer/synthesize"].includes(c), c);
  }
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.deepEqual(by.S10.buyerCalls, ["TommyTreasuryAgent agents/treasury"], "declined: no move, no payment check");
  assert.equal(by.S09.buyerCalls.filter((c) => c.endsWith("buyer/synthesize")).length, 5);
  // payment routing from Tommy's treasury: agent mandate ≤ $100k, CPO above
  assert.deepEqual([by.S02.payment.approver, by.S03.payment.approver, by.S07.payment.approval], ["tommyBuyerAgent", "Tommy_Chief_Procurement_Officer", "CPO"]);
});

test("outcome buyer: sends its own last offer, never a budget; refuses malformed answers", async () => {
  const sent = [];
  const answers = [{ decision: "COUNTER", priceCents: 288 }, { decision: "ACCEPT", priceCents: 300 }];
  const client = { async call(alias, path, body) { sent.push({ alias, path, body }); return { body: { ...answers.shift(), source: "rules" } }; } };
  const rfq = book.inquiries.find((q) => q.id === "S02").rfq;
  const b = createOutcomeBuyer({ client, rfq });
  assert.deepEqual(await b.respond({ phase: "round", round: 1, askCents: 306 }), { action: "COUNTER", priceCents: 288, reasoning: null, source: "rules" });
  assert.equal((await b.respond({ phase: "round", round: 2, askCents: 300 })).action, "ACCEPT");
  assert.deepEqual(sent.map((s) => s.body.lastOfferCents), [270, 288]);
  assert.deepEqual(sent.map((s) => [s.alias, s.path]), [["tommyBuyerAgent", "buyer/synthesize"], ["tommyBuyerAgent", "buyer/synthesize"]]);
  for (const s of sent) assert.equal(Object.keys(s.body).some((k) => /budget|max/i.test(k)), false);
  const bad = createOutcomeBuyer({ client: { async call() { return { body: { decision: "MAYBE" } }; } }, rfq });
  await assert.rejects(() => bad.respond({ round: 1, askCents: 306 }), /ACCEPT\|COUNTER/);
  assert.throws(() => createOutcomeBuyer({ rfq }), /client/);
});
