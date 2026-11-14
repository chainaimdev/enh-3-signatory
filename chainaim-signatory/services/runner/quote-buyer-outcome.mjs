// Quote flow: tommyBuyerAgent backed by Tommy's own private-AI tenant in OutcomeAI (tommy-hilfiger-europe), in place of
// the rule buyer in quote-buyer.mjs. Tommy's maximum price lives only in OutcomeAI; this module never sees it.
//   prepare()        TommyTreasuryAgent  POST agents/treasury     at the RFQ's opening price: within budget? who approves?
//   respond(...)     tommyBuyerAgent     POST buyer/synthesize    accept or counter the seller's ask (same moves as the rule buyer)
//   check(price)     TommyTreasuryAgent  POST agents/treasury     at the agreed price: who approves the payment (agent or CPO)
// Tommy's side only: seller modules (quote-flow.mjs, quote-objects.mjs, outcome-client.mjs) must never import it.

/**
 * client: createOutcomeClient for Tommy's tenant (token from QUOTE_TOKEN_TOMMY). rfq: the ERPNext RFQ Tommy sent.
 * Returns {alias, source, prepare(), respond({phase, round, askCents}) → {action, priceCents, reasoning}, check(priceCents)}.
 */
export function createOutcomeBuyer({ client, rfq }) {
  if (!client?.call) throw new Error("createOutcomeBuyer: an OutcomeAI client for Tommy's tenant is required");
  const it = rfq?.items?.[0];
  if (!it || !rfq.name) throw new Error("createOutcomeBuyer: an RFQ with one item is required");
  const opening = it.custom_target_rate_cents;
  let last = opening; // Tommy's own last offer (Tommy's state, sent with each request)
  const treasury = async (priceCents) => {
    const r = await client.call("TommyTreasuryAgent", "agents/treasury", { rfqId: rfq.name, sku: it.item_code, qty: it.qty, priceCents, advancePct: rfq.custom_advance_pct ?? 0 });
    const a = r.body;
    if (typeof a?.withinBudget !== "boolean" || !["AGENT", "CPO", "OVER_AUTHORITY"].includes(a?.approval)) throw new Error("Tommy treasury answer: withinBudget and approval are required");
    return a;
  };
  return {
    alias: "tommyBuyerAgent",
    source: "outcome",
    prepare: () => treasury(opening),
    check: (priceCents) => treasury(priceCents),
    async respond({ phase = "round", round, askCents }) {
      if (!Number.isInteger(askCents)) throw new Error("askCents must be an integer");
      const r = await client.call("tommyBuyerAgent", "buyer/synthesize", { rfqId: rfq.name, sku: it.item_code, phase, round, askCents, lastOfferCents: last });
      const a = r.body;
      if (!["ACCEPT", "COUNTER"].includes(a?.decision) || !Number.isInteger(a?.priceCents)) throw new Error("Tommy buyer/synthesize answer: decision ACCEPT|COUNTER and integer priceCents are required");
      if (a.decision === "COUNTER") last = Math.max(last, a.priceCents);
      return { action: a.decision, priceCents: a.priceCents, reasoning: a.reasoning ?? null, source: a.source ?? null };
    },
  };
}
