// Quote flow (S-2): jupiterSellerAgent answers one RFQ from tommyBuyerAgent (design §6).
//   1 consult  — inventory → logistics → treasury in OutcomeAI, each call made as its Jupiter vLEI alias (cached)
//   2 supply   — agent-level plan; a same-or-better grade (re-consult) or a split shipment (re-consult) when short;
//                otherwise the lowest authority whose reallocation/air rights give an on-time plan
//   3 floors   — treasury.pricesAtMargin at each level's margin (+ advance lever) + reallocation premium
//   4 rounds   — OutcomeAI seller/synthesize proposes (AI) → GUARD → else the concession rule; quote → buyer
//   5 escalate — reasons recorded; importance band picks the chain (Sales Officer → CEO, prepared by jupiterCeoAgent)
//   6 records  — inquiry, consults (with api proof blocks), round quotes, escalations, final quote
// Everything external is injected (client, buyer, decide, record, onStep) so the same function runs in the CLI,
// in tests (recorded OutcomeAI answers) and later in the runner. Seller-side only: it receives the RFQ, never the
// buyer's private simulation block, and does not import the buyer module.
import { readFileSync } from "node:fs";
import { buildQuotation, leakScan, parseRfq } from "./quote-objects.mjs";

export const REASONS = Object.freeze({
  ROUNDS_EXPIRED: "ROUNDS_EXPIRED",
  PRICE_BELOW_AGENT_FLOOR: "PRICE_BELOW_AGENT_FLOOR",
  SUPPLY_NEEDS_AUTHORITY: "SUPPLY_NEEDS_AUTHORITY",
  DEADLINE_SLIP_OVER_LIMIT: "DEADLINE_SLIP_OVER_LIMIT",
  BELOW_ABSOLUTE_FLOOR: "BELOW_ABSOLUTE_FLOOR",
  NO_SUPPLY_PLAN: "NO_SUPPLY_PLAN",
});

const ALIASES = { inventory: "JupiterInventoryAgent", logistics: "JupiterLogisticsAgent", treasury: "JupiterTreasuryAgent" };
const mKey = (m) => String(m);
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const fmtQty = (n) => n.toLocaleString("en-US");
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);

// ---------------------------------------------------------------- policy (config/quote-authority.json)

export function loadQuotePolicy(path) {
  const p = JSON.parse(readFileSync(path, "utf8"));
  const errs = validatePolicy(p);
  if (errs.length) throw new Error(`quote-authority.json: ${errs.join("; ")}`);
  return p;
}

/** Structural and ordering checks: target > agent > officer > CEO = absolute floor; every margin is priced. */
export function validatePolicy(p) {
  const e = [];
  const lv = Object.fromEntries((p.levels ?? []).map((l) => [l.level, l]));
  for (const k of ["AGENT", "SALES_OFFICER", "CEO"]) if (!lv[k]) e.push(`level ${k} missing`);
  if (e.length) return e;
  const order = [p.targetMargin, lv.AGENT.minMargin, lv.SALES_OFFICER.minMargin, lv.CEO.minMargin];
  for (let i = 1; i < order.length; i++) if (!(order[i - 1] > order[i])) e.push(`margins must fall: target > AGENT > SALES_OFFICER > CEO (${order.join(" > ")})`);
  if (lv.CEO.minMargin !== p.absoluteFloor) e.push("CEO minMargin must equal absoluteFloor");
  for (const l of p.levels) {
    if (l.minMarginWithAdvance > l.minMargin) e.push(`${l.level}: minMarginWithAdvance above minMargin`);
    if (l.minMarginWithAdvance < p.absoluteFloor) e.push(`${l.level}: minMarginWithAdvance below the absolute floor`);
    for (const m of [l.minMargin, l.minMarginWithAdvance]) if (!p.margins.includes(m)) e.push(`${l.level}: margin ${m} not in margins[]`);
    if (!l.alias) e.push(`${l.level}: alias missing`);
  }
  for (const m of p.concessionMargins ?? []) if (!p.margins.includes(m)) e.push(`concession margin ${m} not in margins[]`);
  if (!Number.isInteger(lv.AGENT.maxRounds) || lv.AGENT.maxRounds < 1) e.push("AGENT.maxRounds must be a positive integer");
  const bands = p.importance?.bands ?? [];
  for (let i = 1; i < bands.length; i++) if (!(bands[i - 1].min > bands[i].min)) e.push("importance bands must be ordered by falling min");
  for (const b of bands) for (const c of b.chain) if (!lv[c] || c === "AGENT") e.push(`band ${b.band}: bad chain level ${c}`);
  return e;
}

/** Deal importance (policy §5): customer tier + deal size at the target price + spare capacity. */
export function importanceOf(policy, buyerLei, qty, targetCents) {
  const imp = policy.importance;
  const tier = imp.inputs.customerTierByLei[buyerLei] ?? null;
  const tierPts = tier ? imp.weights.customerTier[tier] ?? 0 : 0;
  const dealUsd = (qty * targetCents) / 100;
  const sizePts = imp.weights.dealSizeUsd.find(([min]) => dealUsd >= min)?.[1] ?? 0;
  const capPts = imp.inputs.capacityUtilisationPct < imp.weights.capacityBelowPct ? imp.weights.capacityLowPoints : imp.weights.capacityOtherwisePoints;
  const score = tierPts + sizePts + capPts;
  const band = imp.bands.find((b) => score >= b.min);
  return { score, band: band.band, chain: band.chain, parts: { tier, tierPts, dealUsd, sizePts, capacityPts: capPts } };
}

/** Floors per level and the per-round asks, from the treasury answer. */
export function priceLadder(policy, treasury, advancePct) {
  const price = (m) => {
    const v = treasury?.pricesAtMargin?.[mKey(m)];
    if (!Number.isInteger(v)) throw new Error(`treasury answer has no integer price at margin ${m}`);
    return v;
  };
  const prem = treasury.reallocPremiumCents ?? 0;
  if (!Number.isInteger(prem) || prem < 0) throw new Error("treasury reallocPremiumCents must be a non-negative integer");
  const advance = treasury.advanceLever?.applies === true && advancePct >= policy.advanceLever.minAdvancePct;
  const floors = Object.fromEntries(policy.levels.map((l) => [l.level, price(advance ? l.minMarginWithAdvance : l.minMargin) + prem]));
  const agent = policy.levels.find((l) => l.level === "AGENT");
  const asks = Array.from({ length: agent.maxRounds }, (_, r) => (r < policy.concessionMargins.length ? price(policy.concessionMargins[r]) + prem : floors.AGENT));
  for (let r = 0; r < asks.length; r++) asks[r] = Math.max(asks[r], floors.AGENT);
  return { floors, asks, target: price(policy.targetMargin), premium: prem, advance, absolute: price(policy.absoluteFloor) + prem };
}

// ---------------------------------------------------------------- guard for an AI round proposal (§6.4)

/**
 * p: synthesize proposal {decision, counter:{sku, qty, priceCents, deadline, shipments}}.
 * ctx: {lastBuyerCents, floorCents, prevAskCents, plan:{sku, shipments}, rfq, level, hasCounters, secrets}
 * Returns {ok:true, decision, priceCents, message?} or {ok:false, why}.
 */
export function guardRound(p, ctx, messageToBuyer) {
  if (!p || !["ACCEPT", "COUNTER"].includes(p.decision)) return { ok: false, why: "decision is not ACCEPT or COUNTER" };
  const c = p.counter ?? {};
  if (p.decision === "ACCEPT") {
    if (ctx.hasCounters) return { ok: false, why: "the agents' plan changes non-price terms, so the RFQ cannot be accepted as asked" };
    if (ctx.lastBuyerCents < ctx.floorCents) return { ok: false, why: "accepting would be below the level floor" };
    return { ok: true, decision: "ACCEPT", priceCents: ctx.lastBuyerCents };
  }
  if (!Number.isInteger(c.priceCents)) return { ok: false, why: "counter without an integer priceCents" };
  if (c.priceCents < ctx.floorCents) return { ok: false, why: "price below the level floor" };
  if (ctx.prevAskCents != null && c.priceCents > ctx.prevAskCents) return { ok: false, why: "counter above the previous counter" };
  if (c.sku != null && c.sku !== ctx.plan.sku) return { ok: false, why: `sku ${c.sku} is not the agents' same-or-better plan (${ctx.plan.sku})` };
  if (c.qty != null && c.qty !== ctx.rfq.qty) return { ok: false, why: "quantity differs from the RFQ" };
  if (c.shipments != null) {
    const want = ctx.plan.shipments.map((s) => `${s.units}@${s.deliveredBy}`).join(",");
    const got = (Array.isArray(c.shipments) ? c.shipments : []).map((s) => `${s.units}@${s.deliveredBy ?? s.delivered_by}`).join(",");
    if (got !== want) return { ok: false, why: "shipments differ from the agents' on-time plan (split ≥ 70% with every lot on time)" };
  }
  if (c.deadline != null) {
    const slip = daysBetween(ctx.rfq.deadline, c.deadline);
    if (ctx.level.maxDeadlineSlipDays != null && slip > ctx.level.maxDeadlineSlipDays) return { ok: false, why: `deadline slip ${slip}d over the ${ctx.level.level} limit`, reason: REASONS.DEADLINE_SLIP_OVER_LIMIT };
    if (c.deadline < ctx.plan.shipments[0].deliveredBy) return { ok: false, why: "deadline earlier than the plan can deliver" };
  }
  if (messageToBuyer != null) {
    const scan = leakScan(messageToBuyer, { cents: ctx.secrets, allowCents: [c.priceCents, ctx.lastBuyerCents, ctx.rfq.offerCents] });
    if (!scan.ok) return { ok: false, why: `messageToBuyer leaks: ${scan.hits.join(", ")}` };
  }
  if (c.priceCents <= ctx.lastBuyerCents) return { ok: true, decision: "ACCEPT", priceCents: ctx.lastBuyerCents };
  return { ok: true, decision: "COUNTER", priceCents: c.priceCents, message: messageToBuyer ?? null };
}

// ---------------------------------------------------------------- the flow

/**
 * opts:
 *   rfq      ERPNext RFQ object (data/quote/inquiries.json → inquiries[i].rfq)
 *   policy   config/quote-authority.json (loadQuotePolicy)
 *   client   {call(alias, path, body) → {body, api}} (services/shared/outcome-client.mjs, or recorded answers in tests)
 *   buyer    {respond({phase, round, askCents}) → {action, priceCents, reasoning}}
 *   decide   async ({level, alias, preparedBy, ...}) → {decision:"approve"|"reject", who}
 *   record   async (name, json) — writes private/quotes/<RFQ-id>/<name>
 *   onStep   async (event) — progress for the CLI / runner
 *   ai       call OutcomeAI seller/synthesize (true) or use the rules only (false)
 *   now      () → ISO timestamp
 * Returns the summary {id, decision, priceCents, rounds, decidedBy, decidedByAlias, reasons, sku, qty, shipments, ...}.
 */
export async function runQuote({ rfq, policy, client, buyer, decide, record = async () => {}, onStep = async () => {}, ai = true, now = () => new Date().toISOString() }) {
  const rq = parseRfq(rfq);
  const L = Object.fromEntries(policy.levels.map((l) => [l.level, l]));
  const RANK = Object.fromEntries(policy.levels.map((l, i) => [l.level, i]));
  const seller = { alias: policy.seller.alias, company: policy.seller.company };
  const consults = [];
  const cache = new Map();
  await record("inquiry.json", rfq);

  async function consult(alias, path, body, reason) {
    const key = `${alias}|${path}|${JSON.stringify(body)}`;
    if (cache.has(key)) {
      consults.push({ alias, path, reason, cached: true });
      return cache.get(key);
    }
    const r = await client.call(alias, path, body);
    consults.push({ alias, path, reason, request: body, response: r.body, api: r.api });
    cache.set(key, r.body);
    await onStep({ type: "consult", alias, path, reason, api: r.api });
    return r.body;
  }

  const inventory = async (sku, reason) => {
    const a = await consult(ALIASES.inventory, "agents/inventory", { sku, qty: rq.qty, shipBy: rq.deadline }, reason);
    if (!Array.isArray(a?.sources) || !Array.isArray(a?.reallocatable)) throw new Error("inventory answer: sources[] and reallocatable[] are required");
    return a;
  };
  const logistics = async (sku, lots, deadline, allowAir, reason) => {
    const body = { sku, lots: lots.map(({ lot, units, readyDate, warehouse }) => ({ lot, units, readyDate, warehouse })), deadline, allowAir };
    const a = await consult(ALIASES.logistics, "agents/logistics", body, reason);
    const legs = Object.fromEntries((a?.legs ?? []).map((g) => [g.lot, g]));
    for (const l of lots) if (!legs[l.lot]) throw new Error(`logistics answer has no leg for lot ${l.lot}`);
    return legs;
  };

  /** On-time plan at one authority level: sea over all allowed lots first, then air (if allowed) for what is short. */
  async function planAt(levelName, sku, inv, reason) {
    const lv = L[levelName];
    const allowed = [
      ...inv.sources.map((s) => ({ ...s, tier: null, premiumPct: 0 })),
      ...inv.reallocatable.filter((r) => lv.reallocate.includes(r.tier)).map((r) => ({ ...r, kind: "REALLOC" })),
    ];
    for (const a of allowed) if (!a.readyDate || !a.warehouse) throw new Error(`inventory lot ${a.lot} has no readyDate/warehouse`);
    const used = {};
    const picks = [];
    let need = rq.qty;
    for (const air of lv.air ? [false, true] : [false]) {
      const left = (a) => a.units - (used[a.lot] ?? 0);
      const cand = allowed.filter((a) => left(a) > 0);
      if (need <= 0 || !cand.length) break;
      const legs = await logistics(sku, cand.map((a) => ({ ...a, units: left(a) })), rq.deadline, air, reason);
      for (const a of cand) {
        if (need <= 0) break;
        if (legs[a.lot].delivered > rq.deadline) continue;
        const take = Math.min(left(a), need);
        picks.push({ ...a, units: take, air });
        used[a.lot] = (used[a.lot] ?? 0) + take;
        need -= take;
      }
    }
    // freight for the exact units taken (container counts depend on units)
    const chunks = [];
    for (const air of [false, true]) {
      const part = picks.filter((p) => p.air === air);
      if (!part.length) continue;
      const legs = await logistics(sku, part, rq.deadline, air, reason);
      for (const p of part) chunks.push({ ...p, ...pickLeg(legs[p.lot]) });
    }
    const airUnits = sum(chunks.filter((c) => c.mode === "AIR"), (c) => c.units);
    const airShare = airUnits / rq.qty;
    const ok = need === 0 && airShare <= (lv.airMaxShare ?? 0) + 1e-12;
    return { level: levelName, sku, chunks, need, airShare, ok };
  }
  const pickLeg = (g) => ({ mode: g.mode, carrier: g.carrier, etd: g.etd, delivered: g.delivered, freightCents: g.freightCents });

  // ---- 1-2: consult + supply authority
  const reasons = [];
  const counters = [];
  let inv = await inventory(rq.sku, "initial");
  let plan = await planAt("AGENT", rq.sku, inv, "initial");
  let level = "AGENT";
  let split = null;
  if (plan.need > 0) {
    const alts = (inv.gradeAlternatives ?? []).filter((a) => a.sku !== rq.sku && String(a.grade) <= String(rq.grade)); // "A" better than "B"
    for (const alt of alts) {
      const invAlt = await inventory(alt.sku, "reconsult-quality");
      const p = await planAt("AGENT", alt.sku, invAlt, "reconsult-quality");
      if (p.ok) {
        inv = invAlt;
        plan = p;
        counters.push({ type: "quality", toBuyer: `We offer Grade ${alt.grade} (${alt.sku}) in place of ${rq.sku}, as the requested grade cannot be delivered in full on time.` });
        break;
      }
    }
  }
  if (plan.need > 0) {
    const first = rq.qty - plan.need;
    if (first / rq.qty >= policy.splitShipment.minFirstShare) {
      const usedU = {};
      for (const c of plan.chunks) usedU[c.lot] = (usedU[c.lot] ?? 0) + c.units;
      const later = [];
      let rem = plan.need;
      for (const s of inv.sources) {
        const left = s.units - (usedU[s.lot] ?? 0);
        if (rem <= 0 || left <= 0) continue;
        const take = Math.min(left, rem);
        later.push({ ...s, tier: null, premiumPct: 0, units: take });
        rem -= take;
      }
      if (rem === 0) {
        const legs = await logistics(plan.sku, later, policy.splitShipment.secondShipmentLatestDelivery, false, "reconsult-quantity");
        const laterChunks = later.map((l) => ({ ...l, air: false, second: true, ...pickLeg(legs[l.lot]) }));
        const secondBy = laterChunks.map((c) => c.delivered).sort().at(-1);
        split = { firstUnits: first, secondUnits: plan.need, secondDeliveredBy: secondBy };
        plan = { ...plan, chunks: [...plan.chunks, ...laterChunks], need: 0, ok: true };
        counters.push({ type: "quantity", toBuyer: `Delivery in two shipments: ${fmtQty(first)} by ${rq.deadline} and ${fmtQty(split.secondUnits)} by ${secondBy}.` });
      }
    } else {
      for (const lvName of policy.levels.map((l) => l.level).filter((n) => n !== "AGENT")) {
        const p = await planAt(lvName, plan.sku, inv, `authority-${lvName}`);
        if (p.ok) {
          plan = p;
          level = lvName;
          reasons.push(REASONS.SUPPLY_NEEDS_AUTHORITY);
          counters.push({ type: "supply", internal: `needs ${lvName} authority: ${[...new Set(p.chunks.filter((c) => c.kind === "REALLOC" || c.mode === "AIR").map((c) => (c.kind === "REALLOC" ? `REALLOC/${c.tier}` : "AIR")))].sort().join(", ")}` });
          break;
        }
      }
    }
  }
  const shipments = split
    ? [{ units: split.firstUnits, deliveredBy: rq.deadline }, { units: split.secondUnits, deliveredBy: split.secondDeliveredBy }]
    : [{ units: rq.qty, deliveredBy: rq.deadline }];
  const buyerCounters = counters.filter((c) => c.toBuyer);
  await onStep({ type: "plan", level, sku: plan.sku, ok: plan.ok, chunks: plan.chunks, counters });

  if (!plan.ok) {
    reasons.push(REASONS.NO_SUPPLY_PLAN);
    return finish({ decision: "DECLINE", priceCents: null, rounds: 0, decidedBy: "AGENT", source: "rules", message: `${rq.id}: we cannot deliver ${fmtQty(rq.qty)} × ${rq.sku} by ${rq.deadline}, so we must decline this request.`, ladder: null, imp: null, escalations: [] });
  }

  // ---- 3: treasury + floors
  const reallocUnits = {
    TIER1: sum(plan.chunks.filter((c) => c.kind === "REALLOC" && c.tier === "TIER1"), (c) => c.units),
    TIER2: sum(plan.chunks.filter((c) => c.kind === "REALLOC" && c.tier === "TIER2"), (c) => c.units),
  };
  const tre = await consult(ALIASES.treasury, "agents/treasury", {
    sku: plan.sku, qty: rq.qty, freightCents: sum(plan.chunks, (c) => c.freightCents), reallocUnits, termsDays: rq.termsDays, advancePct: rq.advancePct, margins: policy.margins,
  }, "initial");
  const ladder = priceLadder(policy, tre, rq.advancePct);
  const imp = importanceOf(policy, rq.buyerLei, rq.qty, ladder.target);
  const secrets = [...Object.values(ladder.floors), ladder.target, ladder.absolute, Math.floor(tre.landedCents ?? NaN), Math.ceil(tre.landedCents ?? NaN), Math.round(tre.landedCents ?? NaN)];
  await onStep({ type: "floors", internal: true, floors: ladder.floors, asks: ladder.asks, premium: ladder.premium, advance: ladder.advance, importance: imp });

  const answers = { inventory: inv, plan: plan.chunks.map(({ lot, kind, tier, units, mode, carrier, etd, delivered, freightCents }) => ({ lot, kind, tier, units, mode, carrier, etd, delivered, freightCents })), treasury: tre };
  const history = [{ round: 0, from: "buyer", action: "OFFER", priceCents: rq.offerCents }];
  const inquiryView = { id: rq.id, sku: rq.sku, grade: rq.grade, qty: rq.qty, priceCents: rq.offerCents, deadline: rq.deadline, termsDays: rq.termsDays, advancePct: rq.advancePct };
  let lastSource = "rules";
  let lastAttest = null;

  async function synthesize(mode, round, lv, floorCents, alias) {
    if (!ai) return { used: false, why: "AI off (--ai off)" };
    try {
      const s = await consult(alias, "seller/synthesize", {
        mode, inquiry: inquiryView, round, history: structuredClone(history),
        answers, authority: { level: lv.level, floorCents, maxRounds: L.AGENT.maxRounds, allowed: { reallocate: lv.reallocate, air: lv.air, maxDeadlineSlipDays: lv.maxDeadlineSlipDays } },
      }, "synthesize");
      return { used: s?.source === "ai", s };
    } catch (e) {
      return { used: false, why: `synthesize failed: ${e.message}`, error: { code: e.code ?? null, httpStatus: e.httpStatus ?? null } };
    }
  }
  const message = (decision, priceCents) => {
    const what = `${fmtQty(rq.qty)} × ${plan.sku} at ${usd(priceCents)} per unit, DAP Los Angeles`;
    const extra = buyerCounters.map((c) => ` ${c.toBuyer}`).join("");
    if (decision === "ACCEPT") return `${rq.id}: agreed — ${what}, delivered by ${rq.deadline}.${extra}`;
    return `${rq.id}: we can offer ${what}, delivered by ${rq.deadline}.${extra}`;
  };
  const checkedMessage = (msg, priceCents) => {
    const scan = leakScan(msg, { cents: secrets, allowCents: [priceCents, rq.offerCents, ...history.map((h) => h.priceCents).filter(Number.isInteger)] });
    if (!scan.ok) throw new Error(`rule message for ${rq.id} failed the leak scan (${scan.hits.join(", ")})`);
    return msg;
  };
  async function sendQuote({ round, decision, priceCents, decidedBy, msg, final = false, lostReason = null }) {
    const q = buildQuotation({ rfq: rq, seller, round, decision, sku: plan.sku, priceCents, shipments, counters: buyerCounters.map((c) => c.toBuyer), message: msg, decidedBy, final, lostReason });
    if (!final) await record(`round-${round}.quote.json`, q);
    await onStep({ type: "quote", round, decision, priceCents, decidedBy, message: msg });
    return q;
  }

  // ---- 4: rounds (agent authority)
  let b = rq.offerCents;
  let rounds = 0;
  let lastAsk = null;
  let result = null;
  const aiLog = [];
  if (level === "AGENT" && buyerCounters.length === 0 && b >= ladder.asks[0]) {
    result = { decision: "ACCEPT", priceCents: b, decidedBy: "AGENT" };
    history.push({ round: 0, from: "seller", action: "ACCEPT", priceCents: b, source: "rules" });
    await sendQuote({ round: 0, decision: "ACCEPT", priceCents: b, decidedBy: L.AGENT.alias, msg: checkedMessage(message("ACCEPT", b), b) });
  } else if (level === "AGENT") {
    for (let r = 0; r < L.AGENT.maxRounds && !result; r++) {
      rounds = r + 1;
      const ask = ladder.asks[r];
      let move = b >= ask ? { decision: "ACCEPT", priceCents: b } : { decision: "COUNTER", priceCents: ask };
      let source = "rules";
      let aiMsg = null;
      const syn = await synthesize("round", rounds, L.AGENT, ladder.floors.AGENT, L.AGENT.alias);
      if (syn.used) {
        const g = guardRound(syn.s.proposal, {
          lastBuyerCents: b, floorCents: ladder.floors.AGENT, prevAskCents: lastAsk, plan: { sku: plan.sku, shipments }, rfq: rq, level: L.AGENT, hasCounters: buyerCounters.length > 0, secrets,
        }, syn.s.messageToBuyer ?? null);
        aiLog.push({ round: rounds, proposal: syn.s.proposal, model: syn.s.model ?? null, guard: g.ok ? "kept" : g.why, reasoning: syn.s.reasoning ?? null });
        if (g.ok) {
          move = { decision: g.decision, priceCents: g.priceCents };
          aiMsg = g.message ?? null;
          source = "ai";
          lastAttest = syn.s.attest ?? null;
        } else if (g.reason && !reasons.includes(g.reason)) reasons.push(g.reason);
      } else if (ai) aiLog.push({ round: rounds, used: false, why: syn.why ?? `synthesize answered source "${syn.s?.source}"`, ...(syn.error ? { error: syn.error } : {}) });
      lastSource = source;
      if (move.decision === "ACCEPT") {
        history.push({ round: rounds, from: "seller", action: "ACCEPT", priceCents: move.priceCents, source });
        result = { decision: "ACCEPT", priceCents: move.priceCents, decidedBy: "AGENT" };
        await sendQuote({ round: rounds, decision: "ACCEPT", priceCents: move.priceCents, decidedBy: L.AGENT.alias, msg: checkedMessage(message("ACCEPT", move.priceCents), move.priceCents) });
        break;
      }
      lastAsk = move.priceCents;
      history.push({ round: rounds, from: "seller", action: "COUNTER", priceCents: lastAsk, source });
      await sendQuote({ round: rounds, decision: "COUNTER", priceCents: lastAsk, msg: aiMsg ?? checkedMessage(message("COUNTER", lastAsk), lastAsk) });
      const br = buyer.respond({ phase: "round", round: rounds, askCents: lastAsk });
      history.push({ round: rounds, from: "buyer", action: br.action, priceCents: br.priceCents });
      await onStep({ type: "buyer", round: rounds, action: br.action, priceCents: br.priceCents });
      if (br.action === "ACCEPT") result = { decision: "ACCEPT", priceCents: lastAsk, decidedBy: "AGENT", buyerAccepted: true };
      else b = br.priceCents;
    }
    if (!result) {
      reasons.push(REASONS.ROUNDS_EXPIRED);
      if (b < ladder.floors.AGENT) reasons.push(REASONS.PRICE_BELOW_AGENT_FLOOR);
    }
  } else {
    rounds = 1;
    lastAsk = ladder.asks[0];
    history.push({ round: 1, from: "seller", action: "ESCALATE", level, priceCents: null, source: "rules" });
  }

  // ---- 5: escalation (importance band → chain)
  const escalations = [];
  let lastLevel = "AGENT";
  if (!result) {
    await onStep({ type: "escalate", reasons, band: imp.band, chain: imp.chain });
    for (const lvName of imp.chain) {
      const lv = L[lvName];
      if (RANK[lvName] < RANK[level]) {
        escalations.push({ level: lvName, alias: lv.alias, decision: "FORWARDED", why: `the supply plan needs ${level} authority`, when: now() });
        continue;
      }
      lastLevel = lvName;
      rounds += 1;
      const fl = ladder.floors[lvName];
      const anchor = lv.counterAnchor === "target" ? ladder.asks[0] : lastAsk ?? ladder.asks[0];
      const ask = Math.max(fl, Math.ceil((fl + anchor) / 2));
      let brief = null;
      if (lv.preparedBy) {
        const syn = await synthesize("ceo-brief", rounds, lv, fl, lv.preparedBy);
        brief = syn.used ? { by: lv.preparedBy, source: "ai", text: syn.s.reasoning ?? syn.s.messageToBuyer ?? null, model: syn.s.model ?? null, attest: syn.s.attest ?? null } : { by: lv.preparedBy, source: "rules", text: `Rules brief: reasons ${reasons.join(", ")}; floor ${fl}c at ${lvName}; buyer's last ${b}c; importance ${imp.band} (${imp.score}).`, why: syn.why ?? null };
      }
      const d = await decide({ rfqId: rq.id, level: lvName, alias: lv.alias, preparedBy: lv.preparedBy ?? null, round: rounds, reasons: [...reasons], counterCents: ask, floorCents: fl, lastBuyerCents: b, importance: { score: imp.score, band: imp.band }, brief });
      const esc = { level: lvName, alias: lv.alias, reasons: [...reasons], counterCents: ask, floorCents: fl, lastBuyerCents: b, decision: d.decision, who: d.who ?? lv.alias, when: now(), brief };
      escalations.push(esc);
      await onStep({ type: "decision", level: lvName, alias: lv.alias, decision: d.decision, counterCents: ask });
      if (d.decision !== "approve") {
        result = { decision: "DECLINE", priceCents: null, decidedBy: lvName, rejected: true };
        break;
      }
      history.push({ round: rounds, from: "seller", action: "COUNTER", level: lvName, priceCents: ask, source: "rules" });
      await sendQuote({ round: rounds, decision: "COUNTER", priceCents: ask, decidedBy: lv.alias, msg: checkedMessage(message("COUNTER", ask), ask) });
      const br = buyer.respond({ phase: "escalation", round: rounds, askCents: ask });
      history.push({ round: rounds, from: "buyer", action: br.action, priceCents: br.priceCents });
      await onStep({ type: "buyer", round: rounds, action: br.action, priceCents: br.priceCents });
      if (br.action === "ACCEPT") {
        result = { decision: "ACCEPT", priceCents: ask, decidedBy: lvName };
        esc.outcome = `buyer accepted ${ask}`;
        break;
      }
      b = br.priceCents;
      if (b >= fl) {
        result = { decision: "ACCEPT", priceCents: b, decidedBy: lvName };
        esc.outcome = `buyer's best ${b} ≥ floor ${fl}: approved within ${lvName} authority`;
        break;
      }
      esc.outcome = `buyer's best ${b} < floor ${fl}: cannot approve`;
    }
  }
  let declineMsg = null;
  let bestAndFinal = null;
  if (!result || result.decision === "DECLINE") {
    const by = result?.decidedBy ?? (imp.chain.length ? lastLevel : "AGENT");
    bestAndFinal = ladder.floors[by];
    if (by === "CEO" && !result?.rejected && b < ladder.floors.CEO) reasons.push(REASONS.BELOW_ABSOLUTE_FLOOR);
    declineMsg = `${rq.id}: we cannot meet ${usd(b)} per unit. Our best and final price is ${usd(bestAndFinal)} per unit for ${fmtQty(rq.qty)} × ${plan.sku}, delivered by ${rq.deadline}.`;
    result = { decision: "DECLINE", priceCents: bestAndFinal, decidedBy: by, rejected: result?.rejected ?? false };
  }
  if (result.decidedBy !== "AGENT") lastSource = "rules";
  return finish({ ...result, rounds, source: lastSource, message: declineMsg, ladder, imp, escalations, aiLog, history, tre });

  // ---- 6: records
  async function finish(r) {
    const alias = r.decidedBy === "AGENT" ? L.AGENT.alias : L[r.decidedBy]?.alias ?? r.decidedBy;
    const msg = r.decision === "DECLINE" ? checkedMessage(r.message, r.priceCents ?? 0) : checkedMessage(message("ACCEPT", r.priceCents), r.priceCents);
    const quotation = r.priceCents == null ? null : buildQuotation({
      rfq: rq, seller, round: r.rounds, decision: r.decision, sku: plan.sku, priceCents: r.priceCents, shipments, counters: buyerCounters.map((c) => c.toBuyer), message: msg, decidedBy: alias, final: true,
      lostReason: r.decision === "DECLINE" ? (r.rejected ? `Declined by ${alias}` : `Below the price we can approve (${reasons.join(", ")})`) : null,
    });
    const final = {
      rfq: rq.id, decision: r.decision, sku: plan.sku, requestedSku: rq.sku, qty: rq.qty, priceCents: r.priceCents, shipments, deadline: rq.deadline,
      terms: { paymentTermsDays: rq.termsDays, advancePct: rq.advancePct, incoterm: rq.incoterm, namedPlace: rq.namedPlace },
      rounds: r.rounds, decidedBy: r.decidedBy, decidedByAlias: alias, reasons: [...reasons], source: r.source, attest: r.source === "ai" ? lastAttest : null,
      ...(r.decision === "DECLINE" ? { bestAndFinalCents: r.priceCents } : {}),
      quotation,
    };
    await record("consults.json", consults);
    await record("escalations.json", r.escalations ?? []);
    await record("final.quote.json", final);
    const internal = {
      level, plan: plan.chunks, counters, floors: r.ladder?.floors ?? null, asks: r.ladder?.asks ?? null, premium: r.ladder?.premium ?? null, advance: r.ladder?.advance ?? null,
      importance: r.imp, ai: r.aiLog ?? [], history: r.history ?? history, landedCents: r.tre?.landedCents ?? null,
    };
    await record("jupiter-internal.json", internal);
    await onStep({ type: "final", decision: r.decision, priceCents: r.priceCents, rounds: r.rounds, decidedBy: r.decidedBy, reasons });
    return {
      id: rq.id, decision: r.decision, priceCents: r.priceCents, rounds: r.rounds, decidedBy: r.decidedBy, decidedByAlias: alias, reasons: [...reasons],
      sku: plan.sku, requestedSku: rq.sku, qty: rq.qty, shipments, source: r.source, level, importance: r.imp ? { score: r.imp.score, band: r.imp.band } : null,
      floors: r.ladder?.floors ?? null, premiumCents: r.ladder?.premium ?? 0, consults: consults.filter((c) => !c.cached).length,
      reconsults: [...new Set(consults.filter((c) => /^reconsult-/.test(c.reason)).map((c) => c.reason))], escalations: (r.escalations ?? []).map((e) => `${e.level}:${e.decision}`),
    };
  }
}
