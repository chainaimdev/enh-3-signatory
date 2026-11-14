// Change #4: the order book (data/orders.json + DD5 fixtures in data/dd5/) and the swarm checks around a negotiation.
//   before:  JupiterInventoryAgent (stock vs quantity, from the DD5 ERPNext Bin fixture)
//            JupiterLogisticsAgent  (ocean quote MAA→LAX, from the DD5 DCSA fixture; sub-agent added by #14)
//   after:   JupiterTreasuryAgent   (deal profit / working-capital cost / NPV at the hurdle rate — DD5 treasury formula)
//            TommyTreasuryAgent     (deal amount vs the agent's on-chain mandate: agent pays / CPO approves / blocked)
// Each agent's identity comes from the vLEI evidence (agentChain); an agent without one is shown as such.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatUnits as fmtUnits } from "../../scripts/lib/common.mjs";
import { totalCents, unitsFromCents, usd } from "../shared/negotiate.mjs";
import { agentChain } from "./vlei.mjs";

export function loadOrderBook(dataDir) {
  const read = (rel) => JSON.parse(readFileSync(resolve(dataDir, rel), "utf8"));
  const book = read("orders.json");
  for (const o of book.orders) {
    if (!Number.isInteger(o.quantity) || o.quantity <= 0 || o.quantity % 100 !== 0) throw new Error(`order ${o.id}: quantity must be a positive multiple of 100`);
    for (const k of ["buyerBudgetCents", "buyerOpeningCents"]) if (!Number.isInteger(o[k]) || o[k] <= 0) throw new Error(`order ${o.id}: ${k} must be a positive integer`);
  }
  return { ...book, fixtures: { inventory: read(book.inventory.fixture), logistics: read(book.logistics.fixture) } };
}

export function identity(evidence, alias) {
  if (!alias) return { alias: null, verified: false, note: "no vLEI identity yet (planned: change #14)" };
  if (!evidence) return { alias, verified: false, note: "no evidence" };
  // Sub-agent (4D sub-delegation): its delegator is another agent, not an OOR officer → check
  // sub-agent → parent agent (live KEL, from the export) and then parent agent → officer → LE (agentChain).
  const all = (evidence.companies || []).flatMap((c) => c.agents || []);
  const me = all.find((a) => a.alias === alias);
  const parent = me && all.find((a) => a.aid === me.delegator);
  if (parent) {
    const pc = agentChain(evidence, parent.alias);
    const ok = me.delegationVerified === true && pc.ok === true;
    return {
      alias, verified: ok, agentAid: me.aid, subAgentOf: parent.alias, officer: pc.data?.officer ?? null, legalEntity: pc.data?.legalEntity ?? null,
      chain: `${alias} → ${parent.alias} → ${pc.data?.officer ?? "?"} → ${pc.data?.legalEntity ?? "?"}`,
      ...(ok ? {} : { note: me.delegationVerified !== true ? `${alias} → ${parent.alias} delegation not verified` : pc.reason }),
    };
  }
  const c = agentChain(evidence, alias);
  return { alias, verified: c.ok === true, agentAid: c.data?.agentAid ?? null, officer: c.data?.officer ?? null, legalEntity: c.data?.legalEntity ?? null, ...(c.ok ? {} : { note: c.reason }) };
}

const source = (fx) => ({ dataMode: fx.__source?.dataMode ?? null, file: fx.__source?.dataSource ?? null, performedAt: fx.__source?.performedAt ?? null, realEquivalent: fx.__source?._realEquivalent ?? null });

/** Checks before the negotiation. Returns [{agent, identity, ok, text, data}]. */
export function preDealChecks({ book, order, evidence }) {
  const inv = book.fixtures.inventory.result;
  const short = Math.max(0, order.quantity - inv.availableQty);
  const inventory = {
    agent: "inventory",
    identity: identity(evidence, book.inventory.agent),
    ok: true,
    text: short === 0
      ? `${inv.availableQty.toLocaleString("en-US")} in stock at ${inv.warehouseRef} — ${order.quantity.toLocaleString("en-US")} can ship from stock`
      : `${inv.availableQty.toLocaleString("en-US")} in stock — short by ${short.toLocaleString("en-US")}; the rest needs ${inv.leadTimeDays} days of production`,
    data: { productCode: inv.productCode, availableQty: inv.availableQty, reservedQty: inv.reservedQty, quantity: order.quantity, shortfall: short, leadTimeDays: short ? inv.leadTimeDays : 0, source: source(book.fixtures.inventory) },
  };
  const lg = book.fixtures.logistics.result;
  const cheapest = [...lg.carriers].sort((a, b) => a.rateUsd - b.rateUsd)[0];
  const fastest = [...lg.carriers].sort((a, b) => a.transitDays - b.transitDays)[0];
  const fits = order.quantity <= book.logistics.quoteMaxUnits;
  const logistics = {
    agent: "logistics",
    identity: identity(evidence, book.logistics.agent),
    ok: fits,
    text: fits
      ? `${lg.originPort} → ${lg.destinationPort}: cheapest ${cheapest.name} $${cheapest.rateUsd.toLocaleString("en-US")} / ${cheapest.transitDays} days; fastest ${fastest.name} ${fastest.transitDays} days`
      : `The ocean quote covers up to ${book.logistics.quoteMaxUnits.toLocaleString("en-US")} units; ${order.quantity.toLocaleString("en-US")} needs a new quote`,
    data: { originPort: lg.originPort, destinationPort: lg.destinationPort, cheapest, fastest, carriers: lg.carriers, quoteMaxUnits: book.logistics.quoteMaxUnits, quoteValidUntil: cheapest.validUntil, source: source(book.fixtures.logistics) },
  };
  return [inventory, logistics];
}

/** Seller treasury (DD5 treasury-agent formula, Net-terms, simple interest). Money in cents. */
export function sellerTreasury(t, quantity, priceCents) {
  const revenue = quantity * priceCents;
  const cost = quantity * t.unitCostCents + t.overheadPerOrderUsd * 100;
  const yearFrac = t.paymentTermsDays / 365;
  const workingCapitalCost = Math.round(cost * t.hurdleRateAnnual * yearFrac);
  const netProfit = revenue - cost - workingCapitalCost;
  const npv = Math.round(revenue / (1 + t.hurdleRateAnnual * yearFrac) - cost);
  const approved = netProfit > 0 && npv > 0;
  return { approved, revenueCents: revenue, costCents: cost, workingCapitalCostCents: workingCapitalCost, netProfitCents: netProfit, npvCents: npv, hurdleRateAnnual: t.hurdleRateAnnual, paymentTermsDays: t.paymentTermsDays };
}

/** Checks after a price is agreed. mandate: get_mandate view ({limit_units, revoked, approver}). */
export function treasuryChecks({ book, order, priceCents, evidence, mandate, maxUnits, decimals, demoScale }) {
  const st = sellerTreasury(book.sellerTreasury, order.quantity, priceCents);
  const seller = {
    agent: "seller_treasury",
    identity: identity(evidence, book.sellerTreasury.agent),
    ok: st.approved,
    text: st.approved
      ? `Approved: net profit $${usd(st.netProfitCents)} after $${usd(st.workingCapitalCostCents)} working-capital cost; NPV $${usd(st.npvCents)} at ${st.hurdleRateAnnual * 100}%`
      : `Rejected: net profit $${usd(st.netProfitCents)}, NPV $${usd(st.npvCents)}`,
    data: st,
  };
  const cents = totalCents(order.quantity, priceCents);
  const units = unitsFromCents(cents, decimals, demoScale);
  const limit = mandate ? BigInt(mandate.limit_units) : null;
  let ok = true;
  let route;
  let text;
  if (units === null) {
    ok = false;
    route = "blocked";
    text = `$${usd(Number(cents))} does not convert exactly at demo scale 1:${demoScale}`;
  } else if (units > maxUnits) {
    ok = false;
    route = "blocked";
    text = `${fmtUnits(units, decimals)} USDC is above the maximum ${fmtUnits(maxUnits, decimals)} USDC — not sent`;
  } else if (limit === null) {
    route = "unknown";
    text = `${fmtUnits(units, decimals)} USDC — agent mandate not readable`;
  } else if (units <= limit) {
    route = "agent";
    text = `${fmtUnits(units, decimals)} USDC is within the agent mandate (${fmtUnits(limit, decimals)}) — the agent can pay`;
  } else {
    route = "cpo";
    text = `${fmtUnits(units, decimals)} USDC is above the agent mandate (${fmtUnits(limit, decimals)}) — the contract will hold it for ${mandate.approver}`;
  }
  if (mandate?.revoked) text += " (note: the mandate is revoked — the contract will refuse)";
  const buyer = {
    agent: "buyer_treasury",
    identity: identity(evidence, book.buyerTreasury.agent),
    ok,
    text,
    data: { realTotalCents: cents.toString(), amountUnits: units?.toString() ?? null, limitUnits: limit?.toString() ?? null, maxUnits: maxUnits.toString(), route, approver: mandate?.approver ?? null },
  };
  return { checks: [seller, buyer], units, ok: seller.ok && buyer.ok };
}

