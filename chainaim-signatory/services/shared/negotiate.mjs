// Change #4: buyer ↔ seller price negotiation (US cents per unit), ported from DD5 (dd5-final-NEAR @4312cb1):
//   seller-agent ruleBasedDecision + applySellerConstraints, buyer-agent ruleBasedDecision + applyBuyerConstraints,
//   round flow (buyer opens; seller answers; round += 1 when the buyer receives a counter; > maxRounds → escalation).
// Each move: an optional AI proposer (services/shared/llm.mjs) proposes; the guard (DD5 constraints) checks it;
// an invalid or missing proposal falls back to the DD5 rule. The guard also checks rule decisions (one deliberate
// difference from DD5: the buyer never accepts above its budget, even in the final round).
// Pure functions + one async loop; no network here.

const ACTIONS = new Set(["ACCEPT", "COUNTER", "REJECT"]);
const pick = (table, round) => table[String(round)] ?? table.default;

// ---------------------------------------------------------------- seller (jupiterSellerAgent)

export function sellerRule(p, st) {
  const b = st.lastBuyer;
  const min = p.floorCents + p.minMarginCents;
  const target = pick(p.acceptTargetsCents, st.round) ?? min;
  if (b >= target) return { action: "ACCEPT", reasoning: `Buyer $${usd(b)} meets the round ${st.round} target $${usd(target)}` };
  if (st.round === p.maxRounds) {
    return b >= min
      ? { action: "ACCEPT", reasoning: `Final round — $${usd(b)} is above the minimum` }
      : { action: "REJECT", reasoning: `Final round — buyer $${usd(b)} is below the seller minimum` };
  }
  let price;
  if (st.lastSeller == null) price = Math.max(p.floorCents * p.openingMarkup, b * p.openingOverBuyer);
  else price = Math.max(st.lastSeller - (st.lastSeller - b) * pick(p.concession, st.round), min);
  price = Math.round(price);
  return { action: "COUNTER", price, reasoning: `Counter at $${usd(price)}` };
}

/** DD5 applySellerConstraints. Returns {decision, changed, note} or null (invalid → use the rule). */
export function sellerGuard(p, st, d) {
  if (!d || !ACTIONS.has(d.action)) return null;
  const out = { ...d };
  const min = p.floorCents + p.minMarginCents;
  const notes = [];
  if (out.action === "ACCEPT" && st.lastBuyer < min) {
    if (st.round < p.maxRounds) Object.assign(out, { action: "COUNTER", price: min });
    else Object.assign(out, { action: "REJECT", price: undefined });
    notes.push(`cannot accept $${usd(st.lastBuyer)} (below the seller minimum)`);
  }
  if (out.action === "COUNTER") {
    if (!Number.isFinite(out.price)) return null;
    if (out.price < p.floorCents) {
      out.price = min;
      notes.push("raised to the margin floor");
    }
    if (st.lastSeller != null && out.price > st.lastSeller) {
      out.price = Math.max(st.lastSeller - 5, min);
      notes.push("a counter may not go up");
    }
    out.price = Math.round(out.price);
  }
  if (out.action !== "COUNTER") delete out.price;
  return { decision: out, changed: notes.length > 0, note: notes.join("; ") };
}

// ---------------------------------------------------------------- buyer (tommyBuyerAgent)

export function buyerRule(p, st) {
  const s = st.lastSeller;
  const th = pick(p.acceptThresholdsCents, st.round) ?? p.acceptThresholdsCents["3"];
  if (st.round === p.maxRounds) {
    const near = s <= st.lastBuyer + p.finalRoundNearCents;
    if (s <= th && s <= st.budget && near) return { action: "ACCEPT", reasoning: `Final round: $${usd(s)} is close to our last offer` };
    if (s <= st.budget + p.nearBudgetCents && near) return { action: "ACCEPT", reasoning: "Final round: near budget and close to our last offer" };
  } else if (s <= th && s <= st.budget) {
    return { action: "ACCEPT", reasoning: `Seller $${usd(s)} meets the round ${st.round} threshold` };
  }
  const price = Math.min(Math.round(st.lastBuyer + (s - st.lastBuyer) * pick(p.concession, st.round)), st.budget);
  return { action: "COUNTER", price, reasoning: `Counter at $${usd(price)}` };
}

/** DD5 applyBuyerConstraints (+ counters stay within [last buyer offer, budget]). */
export function buyerGuard(p, st, d) {
  if (!d || !ACTIONS.has(d.action)) return null;
  const out = { ...d };
  const notes = [];
  if (out.action === "ACCEPT" && st.lastSeller > st.budget) {
    if (st.round < p.maxRounds) Object.assign(out, { action: "COUNTER", price: Math.min(st.budget, st.lastSeller - 10) });
    else Object.assign(out, { action: "REJECT" });
    notes.push(`cannot accept $${usd(st.lastSeller)} (above the budget)`);
  }
  if (out.action === "ACCEPT" && (st.lastSeller - st.lastBuyer) / st.lastBuyer > p.maxConcessionGap) {
    Object.assign(out, { action: "COUNTER", price: Math.min(Math.round((st.lastBuyer + st.lastSeller) / 2), st.budget) });
    notes.push(`gap from our last offer is over ${Math.round(p.maxConcessionGap * 100)}% — countering at the midpoint`);
  }
  if (out.action === "COUNTER") {
    if (!Number.isFinite(out.price)) return null;
    if (out.price > st.budget) {
      out.price = st.budget;
      notes.push("capped at the budget");
    }
    if (out.price < st.lastBuyer) {
      out.price = st.lastBuyer;
      notes.push("a counter may not go down");
    }
    out.price = Math.round(out.price);
  }
  if (out.action !== "COUNTER") delete out.price;
  return { decision: out, changed: notes.length > 0, note: notes.join("; ") };
}

// ---------------------------------------------------------------- one move = (AI proposal →) guard → rule fallback

async function decideMove({ role, params, state, propose }) {
  const rule = role === "seller" ? sellerRule : buyerRule;
  const guard = role === "seller" ? sellerGuard : buyerGuard;
  let ai = null;
  if (propose) {
    try {
      ai = await propose(role, publicStateFor(role, params, state));
    } catch (e) {
      ai = { error: e.message };
    }
  }
  if (ai && !ai.error) {
    const g = guard(params, state, ai);
    if (g) {
      return {
        ...g.decision,
        reasoning: ai.reasoning || g.decision.reasoning || "",
        source: g.changed ? "ai+guard" : "ai",
        guard: g.changed ? g.note : "kept",
        ai: { action: ai.action, price: ai.price ?? null, reasoning: ai.reasoning ?? null, model: ai.model ?? null, ms: ai.ms ?? null },
      };
    }
    ai = { ...ai, error: "proposal not usable (bad action or price)" };
  }
  const r = guard(params, state, rule(params, state));
  return {
    ...r.decision,
    reasoning: rule(params, state).reasoning + (r.changed ? ` (${r.note})` : ""),
    source: "rules",
    guard: r.changed ? r.note : "kept",
    ...(propose ? { ai: { error: ai?.error ?? "no proposal" } } : {}),
  };
}

/** What a role's AI may see: its own private limits, the offer history, never the other side's limits. */
export function publicStateFor(role, params, st) {
  const history = st.history.map((h) => ({ round: h.round, from: h.from, action: h.action, priceCents: h.price ?? null }));
  const base = { role, round: st.round, maxRounds: params.maxRounds, quantity: st.quantity, history, lastBuyerCents: st.lastBuyer, lastSellerCents: st.lastSeller };
  if (role === "seller") return { ...base, private: { floorCents: params.floorCents, minimumAcceptCents: params.floorCents + params.minMarginCents } };
  return { ...base, private: { budgetCents: st.budget } };
}

/**
 * Runs the negotiation. order: {quantity, buyerBudgetCents, buyerOpeningCents}; rules: orders.json {seller, buyer}.
 * propose (optional): async (role, publicState) → {action, price, reasoning, model, ms} | throws.
 * onMove (optional): called (and awaited) after each move.
 * Returns {deal, priceCents?, round, moves, reason?, lastSellerCents, lastBuyerCents}.
 */
export async function negotiate({ order, rules, propose = null, onMove = () => {} }) {
  const sp = rules.seller;
  const bp = rules.buyer;
  const st = { round: 1, quantity: order.quantity, budget: order.buyerBudgetCents, lastBuyer: order.buyerOpeningCents, lastSeller: null, history: [] };
  const moves = [];
  const push = async (m) => {
    moves.push(m);
    st.history.push(m);
    await onMove(m); // may pace the demo (runner --pace-ms)
  };
  await push({ round: 1, from: "buyer", action: "OFFER", price: st.lastBuyer, reasoning: `Opening offer $${usd(st.lastBuyer)} (fixed order opening)`, source: "order", guard: "kept" });
  for (;;) {
    const s = await decideMove({ role: "seller", params: sp, state: st, propose });
    await push({ round: st.round, from: "seller", ...s });
    if (s.action === "ACCEPT") return done(true, st.lastBuyer);
    if (s.action === "REJECT") return done(false, null, "seller rejected the final offer");
    st.lastSeller = s.price;
    st.round += 1;
    if (st.round > Math.min(sp.maxRounds, bp.maxRounds)) return done(false, null, `no agreement in ${sp.maxRounds} rounds`);
    const b = await decideMove({ role: "buyer", params: bp, state: st, propose });
    await push({ round: st.round, from: "buyer", ...b });
    if (b.action === "ACCEPT") return done(true, st.lastSeller);
    if (b.action === "REJECT") return done(false, null, "buyer rejected the final counter");
    st.lastBuyer = b.price;
  }
  function done(deal, price, reason) {
    return { deal, ...(deal ? { priceCents: price } : { reason }), round: st.round, moves, lastSellerCents: st.lastSeller, lastBuyerCents: st.lastBuyer };
  }
}

export function usd(cents) {
  return (cents / 100).toFixed(2);
}

/** Real total in whole USD cents (BigInt) = quantity × price. */
export function totalCents(quantity, priceCents) {
  return BigInt(quantity) * BigInt(priceCents);
}

/** Token units from a real cents total: cents × 10^decimals / (100 × demoScale); null when not exact. */
export function unitsFromCents(cents, decimals, demoScale) {
  const num = BigInt(cents) * 10n ** BigInt(decimals);
  const den = 100n * BigInt(demoScale);
  return num % den === 0n ? num / den : null;
}
