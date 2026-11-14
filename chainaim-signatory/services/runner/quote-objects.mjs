// Quote flow (S-2): the ERPNext-shaped objects of the quote flow and their checks.
//   - RFQ (Tommy → Jupiter) and Quotation (Jupiter → Tommy), validated against data/quote/schema/*.schema.json
//     (a small validator for the JSON-Schema keywords those two files use; no new dependency).
//   - leakScan: a message to the buyer must never carry Jupiter's cost, margin, floors or treasury position.
// Pure functions; no network, no file writes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT } from "../../scripts/lib/common.mjs";

const SCHEMA_DIR = resolve(ROOT, "data", "quote", "schema");
const schemas = {};
export function loadSchema(name) {
  schemas[name] ??= JSON.parse(readFileSync(resolve(SCHEMA_DIR, `${name}.schema.json`), "utf8"));
  return schemas[name];
}

const typeOk = (t, v) =>
  t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "array" ? Array.isArray(v) : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : typeof v === t;

/** Validates v against the JSON-Schema subset used in data/quote/schema. Returns a list of "path: problem" strings. */
export function validateAgainst(schema, v, path = "$") {
  const errs = [];
  if ("const" in schema && v !== schema.const) errs.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(v)) errs.push(`${path}: must be one of ${schema.enum.join(", ")}`);
  if (schema.type && !typeOk(schema.type, v)) return [...errs, `${path}: must be ${schema.type}`];
  if (typeof v === "string") {
    if (schema.minLength != null && v.length < schema.minLength) errs.push(`${path}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(v)) errs.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof v === "number") {
    if (schema.minimum != null && v < schema.minimum) errs.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum != null && v > schema.maximum) errs.push(`${path}: above ${schema.maximum}`);
    if (schema.exclusiveMinimum != null && v <= schema.exclusiveMinimum) errs.push(`${path}: must be > ${schema.exclusiveMinimum}`);
  }
  if (Array.isArray(v)) {
    if (schema.minItems != null && v.length < schema.minItems) errs.push(`${path}: needs at least ${schema.minItems} item(s)`);
    if (schema.maxItems != null && v.length > schema.maxItems) errs.push(`${path}: at most ${schema.maxItems} item(s)`);
    if (schema.items) v.forEach((x, i) => errs.push(...validateAgainst(schema.items, x, `${path}[${i}]`)));
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of schema.required ?? []) if (v[k] === undefined) errs.push(`${path}.${k}: required`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (v[k] !== undefined) errs.push(...validateAgainst(s, v[k], `${path}.${k}`));
  }
  return errs;
}

export function validateRfq(rfq) {
  return validateAgainst(loadSchema("rfq"), rfq);
}
export function validateQuotation(q) {
  return validateAgainst(loadSchema("quotation"), q);
}

/** The flow's view of an RFQ (throws when it does not validate). */
export function parseRfq(rfq) {
  const errs = validateRfq(rfq);
  if (errs.length) throw new Error(`RFQ ${rfq?.name ?? "?"} is not valid: ${errs.join("; ")}`);
  const it = rfq.items[0];
  return {
    id: rfq.name,
    date: rfq.transaction_date,
    buyerCompany: rfq.company,
    buyerAgent: rfq.custom_from_agent,
    buyerLei: rfq.custom_from_lei,
    sellerAgent: rfq.custom_to_agent,
    sku: it.item_code,
    grade: it.custom_quality_grade,
    qty: it.qty,
    uom: it.uom,
    offerCents: it.custom_target_rate_cents,
    deadline: it.schedule_date,
    termsDays: rfq.custom_payment_terms_days,
    advancePct: rfq.custom_advance_pct,
    incoterm: rfq.incoterm ?? null,
    namedPlace: rfq.named_place ?? null,
  };
}

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Builds an ERPNext-shaped Quotation for one round (or the final answer).
 * q: {rfq (parsed), seller:{company, alias}, round, decision, sku, itemName, priceCents, shipments:[{units, deliveredBy}],
 *     counters:[string], message, decidedBy, final, lostReason}
 */
export function buildQuotation(q) {
  const r = q.rfq;
  const suffix = q.final ? "FINAL" : `R${q.round}`;
  const qty = q.shipments.reduce((s, x) => s + x.units, 0);
  const lastDelivery = q.shipments.map((s) => s.deliveredBy).sort().at(-1);
  const total = (qty * q.priceCents) / 100;
  const doc = {
    doctype: "Quotation",
    name: `QTN-${r.id.replace(/^RFQ-/, "")}-${suffix}`,
    naming_series: "SAL-QTN-.YYYY.-",
    quotation_to: "Customer",
    party_name: r.buyerCompany,
    transaction_date: r.date,
    order_type: "Sales",
    company: q.seller.company,
    currency: "USD",
    conversion_rate: 1,
    selling_price_list: "Standard Selling",
    price_list_currency: "USD",
    plc_conversion_rate: 1,
    ...(r.incoterm ? { incoterm: r.incoterm } : {}),
    ...(r.namedPlace ? { named_place: r.namedPlace } : {}),
    status: q.decision === "DECLINE" ? "Lost" : "Open",
    ...(q.decision === "DECLINE" && q.lostReason ? { order_lost_reason: q.lostReason } : {}),
    items: [
      {
        item_code: q.sku,
        item_name: q.itemName ?? q.sku,
        qty,
        uom: r.uom,
        conversion_factor: 1,
        rate: q.priceCents / 100,
        amount: total,
        custom_rate_cents: q.priceCents,
        custom_delivery_date: lastDelivery,
        custom_shipments: q.shipments.map((s) => ({ units: s.units, delivered_by: s.deliveredBy })),
        prevdoc_doctype: "Request for Quotation",
        prevdoc_docname: r.id,
      },
    ],
    payment_schedule: paymentSchedule(r, total),
    custom_rfq: r.id,
    custom_round: q.round,
    custom_decision: q.decision,
    custom_from_agent: q.seller.alias,
    ...(q.decidedBy ? { custom_decided_by: q.decidedBy } : {}),
    custom_counters: q.counters ?? [],
    custom_message_to_buyer: q.message,
  };
  const errs = validateQuotation(doc);
  if (errs.length) throw new Error(`Quotation ${doc.name} is not valid: ${errs.join("; ")}`);
  return doc;
}

function paymentSchedule(r, total) {
  const rows = [];
  const cents = Math.round(total * 100);
  const adv = Math.round((cents * r.advancePct) / 100);
  if (r.advancePct > 0) rows.push({ description: `${r.advancePct}% advance`, due_date: r.date, invoice_portion: r.advancePct, payment_amount: adv / 100 });
  if (r.advancePct < 100) rows.push({ description: `Balance, Net ${r.termsDays}`, due_date: addDays(r.date, r.termsDays), invoice_portion: 100 - r.advancePct, payment_amount: (cents - adv) / 100 });
  return rows;
}

const SECRET_WORDS = /\b(margins?|floors?|landed|unit cost|our cost|cost price|treasury|liquidity|deficit|authority limits?|minimum price)\b/i;

/**
 * Leak scan for a message to the buyer. secrets: {cents:[...]} — Jupiter-private cent values (floors at every level,
 * landed cost); allowCents: the price this message quotes (it may equal a floor, e.g. the round-3 ask).
 * Returns {ok, hits:[...]}.
 */
export function leakScan(message, { cents = [], allowCents = [] } = {}) {
  const hits = [];
  if (typeof message !== "string" || !message.trim()) return { ok: false, hits: ["empty message"] };
  const w = message.match(SECRET_WORDS);
  if (w) hits.push(`word "${w[0]}"`);
  if (/\d+(\.\d+)?\s*%/.test(message)) hits.push("a percentage");
  const secret = new Set(cents.filter((c) => Number.isFinite(c)).map((c) => Math.round(c)));
  for (const a of allowCents) secret.delete(Math.round(a));
  // ignore ISO dates, quantities with thousands separators and identifiers (RFQ-T01, FAB-COT-180-A)
  const text = message.replace(/\d{4}-\d{2}-\d{2}/g, " ").replace(/\b\d{1,3}(,\d{3})+\b/g, " ").replace(/\b[A-Z]+(-[A-Z0-9]+)+\b/g, " ");
  for (const m of text.matchAll(/\$?\d+(\.\d+)?/g)) {
    const s = m[0];
    const c = s.startsWith("$") || s.includes(".") ? Math.round(parseFloat(s.replace("$", "")) * 100) : parseInt(s, 10);
    if (secret.has(c)) hits.push(`number ${s}`);
  }
  return { ok: hits.length === 0, hits };
}
