// Quote flow (S-2): tommyBuyerAgent, simulated with rules from the inquiry's PRIVATE buyerSim block
// (data/quote/inquiries.json → budgetCents, concession). Same rules as the data-pack generator that produced the
// T01–T08 oracle:
//   - round 1: always counters;
//   - from round 2: accepts any seller ask ≤ budget;
//   - otherwise counters at last offer + concession × (ask − last offer), rounded half-to-even, capped at the budget;
//   - to an officer's counter: accepts if ≤ budget, otherwise answers with its budget (best and final).
// This module is Tommy's side only. Seller modules (quote-flow.mjs, quote-objects.mjs, outcome-client.mjs) must never
// import it or read buyerSim (services/test/quote.test.mjs, test 7); the flow gets a buyer object injected.

/** Round half to even (the generator's Python round()), for x ≥ 0. */
export function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

/**
 * buyerSim: {budgetCents, concession, behaviour}; openingCents: the RFQ's target rate.
 * Returns {respond({phase:"round"|"escalation", round, askCents}) → {action:"ACCEPT"|"COUNTER", priceCents, reasoning}}.
 */
export function createRuleBuyer(buyerSim, openingCents) {
  const { budgetCents, concession } = buyerSim ?? {};
  if (!Number.isInteger(budgetCents) || budgetCents <= 0) throw new Error("buyerSim.budgetCents must be a positive integer");
  if (!(concession > 0 && concession <= 1)) throw new Error("buyerSim.concession must be in (0, 1]");
  if (buyerSim.behaviour && buyerSim.behaviour !== "price") throw new Error(`buyerSim.behaviour "${buyerSim.behaviour}" is not supported (only "price")`);
  let last = openingCents;
  return {
    alias: "tommyBuyerAgent",
    respond({ phase = "round", round, askCents }) {
      if (!Number.isInteger(askCents)) throw new Error("askCents must be an integer");
      if (phase === "escalation") {
        if (askCents <= budgetCents) return { action: "ACCEPT", priceCents: askCents, reasoning: "Officer's price is within our budget" };
        last = budgetCents;
        return { action: "COUNTER", priceCents: budgetCents, reasoning: "Best and final offer" };
      }
      if (round >= 2 && askCents <= budgetCents) return { action: "ACCEPT", priceCents: askCents, reasoning: `Round ${round}: the ask is within our budget` };
      const next = Math.min(budgetCents, roundHalfEven(last + concession * (askCents - last)));
      last = Math.max(last, next);
      return { action: "COUNTER", priceCents: last, reasoning: `Round ${round}: counter` };
    },
  };
}
