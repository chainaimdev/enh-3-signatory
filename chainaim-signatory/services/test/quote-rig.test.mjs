// Quote test rig (scripts/quote-rig.mjs): the 10 scenarios in data/quote/rig-scenarios.json, replayed from
// fixtures/quote-agent-responses/S01..S10.json (live OutcomeAI recordings, AI off). Checks every expect block and the hub
// order: RFQ → Inventory → (Logistics, re-consults) → Treasury → quote back to Tommy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT } from "../../scripts/lib/common.mjs";
import { checkOutcome, parseArgs, runRig } from "../../scripts/quote-rig.mjs";
import { validateRfq } from "../runner/quote-objects.mjs";
import { loadQuotePolicy } from "../runner/quote-flow.mjs";

const policy = loadQuotePolicy(resolve(ROOT, "config", "quote-authority.json"));
const book = JSON.parse(readFileSync(resolve(ROOT, "data", "quote", "rig-scenarios.json"), "utf8"));
const FIX = resolve(ROOT, "services", "test", "fixtures", "quote-agent-responses");

function replayAll() {
  const byKey = new Map();
  for (const q of book.inquiries) for (const c of JSON.parse(readFileSync(join(FIX, `${q.id}.json`), "utf8")).calls) byKey.set(`${c.alias}|${c.path}|${JSON.stringify(c.request)}`, c);
  return {
    async call(alias, path, body) {
      const c = byKey.get(`${alias}|${path}|${JSON.stringify(body)}`);
      if (!c) throw new Error(`no recorded answer for ${alias} ${path}`);
      return { body: structuredClone(c.response), api: { httpStatus: 200, ms: 0 } };
    },
  };
}

test("rig: 10 scenarios, valid ERPNext RFQs from tommyBuyerAgent to jupiterSellerAgent, each with an expect block", () => {
  assert.equal(book.inquiries.length, 10);
  assert.deepEqual(book.inquiries.map((q) => q.id), ["S01", "S02", "S03", "S04", "S05", "S06", "S07", "S08", "S09", "S10"]);
  for (const q of book.inquiries) {
    assert.deepEqual(validateRfq(q.rfq), [], q.id);
    assert.equal(q.rfq.custom_from_agent, "tommyBuyerAgent");
    assert.equal(q.rfq.custom_to_agent, "jupiterSellerAgent");
    assert.ok(q.expect && q.path && q.buyerSim, q.id);
  }
});

test("rig: every scenario meets its expect block, and the hub asks Inventory first, Treasury last, Logistics in between", async () => {
  const lines = [];
  const rows = await runRig({ scenarios: book.inquiries, policy, client: replayAll(), ai: false, line: (s) => lines.push(s) });
  for (const r of rows) {
    assert.ok(r.ok, `${r.id}: ${r.diffs.join("; ")}`);
    const agents = r.calls.map((c) => c.split(" ")[1]).filter((p) => p.startsWith("agents/"));
    assert.equal(agents[0], "agents/inventory", r.id);
    assert.ok(agents.includes("agents/logistics"), r.id);
    if (r.id === "S10") assert.equal(agents.includes("agents/treasury"), false, "S10 declines before treasury");
    else {
      assert.equal(agents.at(-1), "agents/treasury", r.id);
      assert.equal(agents.filter((p) => p === "agents/treasury").length, 1, r.id);
      assert.ok(r.quotation, `${r.id}: a quotation went back to Tommy`);
    }
  }
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.summary]));
  assert.deepEqual(Object.fromEntries(Object.entries(byId).map(([k, s]) => [k, [s.decision, s.decision === "ACCEPT" ? s.priceCents : null, s.decidedByAlias]])), {
    S01: ["ACCEPT", 300, "jupiterSellerAgent"], S02: ["ACCEPT", 300, "jupiterSellerAgent"], S03: ["ACCEPT", 319, "Jupiter_Chief_Executive_Officer"],
    S04: ["ACCEPT", 295, "jupiterSellerAgent"], S05: ["ACCEPT", 878, "jupiterSellerAgent"], S06: ["ACCEPT", 700, "Jupiter_Chief_Sales_Officer"],
    S07: ["ACCEPT", 423, "Jupiter_Chief_Executive_Officer"], S08: ["ACCEPT", 535, "Jupiter_Chief_Executive_Officer"], S09: ["ACCEPT", 385, "Jupiter_Chief_Executive_Officer"],
    S10: ["DECLINE", null, "jupiterSellerAgent"],
  });
  assert.ok(lines.some((l) => l.includes("POST /v1/tenants/jupiter-knitting/agents/inventory")));
  assert.ok(lines.some((l) => l.startsWith("  RESULT  customer Tommy Hilfiger Europe B.V.")));
});

test("rig: officers reject (S06 Sales Officer, S08 CEO) → no deal; checkOutcome reports the difference", async () => {
  const rows = await runRig({ scenarios: book.inquiries.filter((q) => ["S06", "S08"].includes(q.id)), policy, client: replayAll(), ai: false, approveSet: new Set(["none"]), check: false });
  assert.deepEqual(rows.map((r) => [r.id, r.summary.decision, r.summary.decidedByAlias]), [["S06", "DECLINE", "Jupiter_Chief_Sales_Officer"], ["S08", "DECLINE", "Jupiter_Chief_Executive_Officer"]]);
  const d = checkOutcome(book.inquiries.find((q) => q.id === "S06").expect, rows[0].summary, { aiUsed: false });
  assert.ok(d.some((x) => x.startsWith("decision:")));
  assert.throws(() => parseArgs(["--approve", "maybe"]), /unknown value/);
  assert.throws(() => parseArgs(["--ai", "x"]), /on or off/);
  assert.equal(parseArgs(["--scenario", "S03,S08", "--bodies"]).bodies, true);
});
