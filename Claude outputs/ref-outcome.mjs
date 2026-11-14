#!/usr/bin/env node
// Reference OutcomeAI quote agents — Node port of ref_outcome.py + build.py (Jupiter data pack v1, 2026-11-16).
// NOT part of Signatory and NOT the real OutcomeAI service: a stand-in that answers the design's section 4 contract
// so Signatory's demo-quote can run end to end before OutcomeAI's quote-agents service (OA-1..OA-5) exists.
// Jupiter's private sample data lives only in this file. seller/synthesize answers source="rules" (no model).
//
//   node ref-outcome.mjs [--port 8785] [--host 127.0.0.1] [--tenant jupiter-knitting]
//                        [--lei 3358004DXAMRWRUIYJ05] [--token-env QUOTE_TOKEN_JUPITER]
// The bearer token is read from the env var named by --token-env and never printed.
import { createServer } from "node:http";

// ---------------------------------------------------------------- flags
const opt = { port: "8785", host: "127.0.0.1", tenant: "jupiter-knitting", lei: "3358004DXAMRWRUIYJ05", "token-env": "QUOTE_TOKEN_JUPITER" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const [k, v] = argv[i].replace(/^--/, "").split("=", 2);
  if (!(k in opt)) {
    console.error(`unknown flag --${k}`);
    process.exit(2);
  }
  opt[k] = v ?? argv[++i];
}
const TOKEN = process.env[opt["token-env"]];
if (!TOKEN) {
  console.error(`${opt["token-env"]} is not set`);
  process.exit(2);
}

// ---------------------------------------------------------------- dates (UTC, ISO yyyy-mm-dd)
const D = (iso) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (s, n) => iso(D(s) + n * 86400000);
const TODAY = "2026-11-16";

/** Python round(): half to even (used for the air freight, as in the data pack). */
function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
  return Math.round(x);
}

// ---------------------------------------------------------------- data pack (build.py)
const POLICY = { targetMargin: 0.15, orderOverheadUsd: 300, minAdvancePct: 30, premiumByTier: { TIER2: 0.04, TIER1: 0.08 } };
// sku: [description, grade, gsm, unit cost cents, kg/unit, units per 40HC, production lead days, new-production capacity]
const PROD = {
  "FAB-COT-180-A": ["Combed cotton single jersey 180 GSM, Grade A (<=20 defect pts/100 m2, shade 4-5)", "A", 180, 330, 0.7, 25000, 21, 24000],
  "FAB-COT-180-B": ["Carded cotton single jersey 180 GSM, Grade B (<=40 defect pts/100 m2, shade 3-4)", "B", 180, 290, 0.7, 25000, 21, 30000],
  "FAB-COT-220-A": ["Combed cotton interlock 220 GSM, Grade A", "A", 220, 400, 0.85, 20000, 28, 16000],
};
const GRADE_RANK = { A: 2, B: 1 };
const TOMMY = { tier: "TIER1", creditLimitUsd: 300000, openReceivableUsd: 60000 };
// lot, sku, warehouse, qty, status, readyDate, allocatedTo, tier, customerShipDate, reallocatable, premiumPct, replacement
const INV = [
  ["LOT-A1", "FAB-COT-180-A", "MADRAS-WH-1", 22000, "FREE", "2026-11-19", "", "", "", "", "", ""],
  ["WIP-A2", "FAB-COT-180-A", "MADRAS-WH-1", 12000, "WIP_FREE", "2026-12-03", "", "", "", "", "", ""],
  ["LOT-A3", "FAB-COT-180-A", "MADRAS-WH-1", 15000, "ALLOCATED", "2026-11-19", "CUST-K", "TIER2", "2026-12-22", "Y_SALES_OFFICER", 0.04, "new production ready 2026-12-09"],
  ["LOT-A4", "FAB-COT-180-A", "TIRUPUR-WH-2", 18000, "ALLOCATED", "2026-11-19", "CUST-S", "TIER1", "2026-11-28", "Y_CEO_ONLY", 0.08, "none before customer ship date"],
  ["LOT-B1", "FAB-COT-180-B", "MADRAS-WH-1", 6000, "FREE", "2026-11-19", "", "", "", "", "", ""],
  ["LOT-B2", "FAB-COT-180-B", "MADRAS-WH-1", 10000, "ALLOCATED", "2026-11-19", "CUST-K", "TIER2", "2026-12-22", "Y_SALES_OFFICER", 0.04, "new production ready 2026-12-09"],
  ["LOT-C1", "FAB-COT-220-A", "MADRAS-WH-1", 9000, "FREE", "2026-11-19", "", "", "", "", "", ""],
  ["WIP-C2", "FAB-COT-220-A", "MADRAS-WH-1", 8000, "WIP_FREE", "2026-12-10", "", "", "", "", "", ""],
];
const INLAND = { "MADRAS-WH-1": 1, "TIRUPUR-WH-2": 2 };
const APPROVAL = { Y_SALES_OFFICER: "SALES_OFFICER", Y_CEO_ONLY: "CEO" };

// Sailings INMAA → USLAX: MSC weekly (Thu, standard, 27 days, $4,200/40HC); Maersk weekly (Tue, express, 22 days, $5,400/40HC).
// Cargo cutoff = ETD − 2 days. Delivered = ETA + 4 customs + 1 drayage. Air: Emirates SkyCargo, 380 c/kg, ETD = at port + 1, 4 days.
const SAILINGS = [];
for (let d = "2026-11-19"; D(d) <= D("2027-01-14"); d = addDays(d, 7)) SAILINGS.push({ mode: "SEA_STD", carrier: "MSC", cutoff: addDays(d, -2), etd: d, eta: addDays(d, 27), rate: 4200 });
for (let d = "2026-11-24"; D(d) <= D("2027-01-12"); d = addDays(d, 7)) SAILINGS.push({ mode: "SEA_EXP", carrier: "Maersk", cutoff: addDays(d, -2), etd: d, eta: addDays(d, 22), rate: 5400 });

/** build.py ship(): cheapest mode delivering by the deadline, else the earliest option. */
function ship(units, ready, wh, sku, deadline, airOk) {
  const atPort = addDays(ready, INLAND[wh]);
  let opts = [];
  for (const s of SAILINGS) {
    if (D(s.cutoff) >= D(atPort)) opts.push({ mode: s.mode, carrier: s.carrier, etd: s.etd, delivered: addDays(s.eta, 5), freight: Math.ceil(units / PROD[sku][5]) * s.rate * 100 });
  }
  opts = [...opts.filter((o) => o.mode === "SEA_STD").slice(0, 1), ...opts.filter((o) => o.mode === "SEA_EXP").slice(0, 1)];
  if (airOk) {
    const etd = addDays(atPort, 1);
    opts.push({ mode: "AIR", carrier: "Emirates SkyCargo", etd, delivered: addDays(etd, 9), freight: roundHalfEven(units * PROD[sku][4] * 380) });
  }
  const ok = opts.filter((o) => D(o.delivered) <= D(deadline)).sort((a, b) => a.freight - b.freight); // stable, like Python sorted()
  if (ok.length) return { o: ok[0], onTime: true };
  return { o: opts.reduce((m, o) => (D(o.delivered) < D(m.delivered) ? o : m)), onTime: false };
}

// Treasury: 30-day liquidity = cash + credit headroom + current AR due in 30 days − AP due in 30 days.
const LEDGER = [
  ["CASH", 42000, "2026-11-16", "available"], ["CREDIT_LINE", 15000, "2026-11-16", "headroom"],
  ["AR", 60000, "2026-11-30", "current"], ["AR", 85000, "2026-12-05", "current"], ["AR", 120000, "2026-12-28", "current"], ["AR", 35000, "2026-10-01", "overdue_45d_excluded"],
  ["AP", -150000, "2026-11-25", "due"], ["AP", -70000, "2026-12-02", "due"], ["AP", -55000, "2026-12-01", "due"], ["AP", -18000, "2026-12-10", "due"], ["AP", -12000, "2026-12-05", "due"],
];
const WIN = D(addDays(TODAY, 30));
const cash = LEDGER.filter(([t]) => t === "CASH" || t === "CREDIT_LINE").reduce((s, r) => s + r[1], 0);
const ar = LEDGER.filter(([t, , d, s]) => t === "AR" && s === "current" && D(d) <= WIN).reduce((s, r) => s + r[1], 0);
const ap = -LEDGER.filter(([t, , d]) => t === "AP" && D(d) <= WIN).reduce((s, r) => s + r[1], 0);
const NET30 = cash + ar - ap;
const LIQ = NET30 < 0 ? "DEFICIT" : "SURPLUS";

// ---------------------------------------------------------------- agents (section 4 contract)
class Bad extends Error {}
const need = (b, k) => {
  if (b[k] === undefined || b[k] === null) throw new Bad(`${k} is required`);
  return b[k];
};

function inventory(b) {
  const sku = need(b, "sku");
  const qty = Number(need(b, "qty"));
  if (!PROD[sku]) return [404, { error: { code: "UNKNOWN_SKU", message: sku } }];
  const lots = INV.filter((l) => l[1] === sku);
  const sources = lots.filter((l) => l[4] === "FREE" || l[4] === "WIP_FREE").map((l) => ({ lot: l[0], kind: l[4] === "FREE" ? "FREE" : "WIP", units: l[3], readyDate: l[5], warehouse: l[2] }));
  sources.push({ lot: "NEW-PROD", kind: "PRODUCTION", units: PROD[sku][7], readyDate: addDays(TODAY, PROD[sku][6] + 2), warehouse: "MADRAS-WH-1" });
  const reallocatable = lots.filter((l) => l[4] === "ALLOCATED").map((l) => ({
    lot: l[0], units: l[3], tier: l[7], requiredAuthority: APPROVAL[l[9]] ?? null, premiumPct: l[10],
    replacementOk: !["", "none before customer ship date"].includes(l[11]), readyDate: l[5], warehouse: l[2],
  }));
  const g = PROD[sku];
  const gradeAlternatives = Object.entries(PROD).filter(([s, p]) => s !== sku && p[2] === g[2] && GRADE_RANK[p[1]] > GRADE_RANK[g[1]]).map(([s, p]) => ({ sku: s, grade: p[1] }));
  const have = sources.reduce((s, x) => s + x.units, 0);
  return [200, { sources, reallocatable, gradeAlternatives, shortfall: Math.max(0, qty - have) }];
}

function logistics(b) {
  const sku = need(b, "sku");
  const deadline = need(b, "deadline");
  const lots = need(b, "lots");
  if (!PROD[sku]) return [404, { error: { code: "UNKNOWN_SKU", message: sku } }];
  if (!Array.isArray(lots)) throw new Bad("lots must be an array");
  const legs = lots.map((l) => {
    if (!INLAND[l.warehouse]) throw new Bad(`unknown warehouse ${l.warehouse}`);
    const { o, onTime } = ship(Number(l.units), l.readyDate, l.warehouse, sku, deadline, Boolean(b.allowAir));
    return { lot: l.lot, units: Number(l.units), mode: o.mode, carrier: o.carrier, etd: o.etd, delivered: o.delivered, freightCents: o.freight, onTime };
  });
  const late = legs.filter((x) => !x.onTime).reduce((s, x) => s + x.units, 0);
  return [200, { legs, freightCents: legs.reduce((s, x) => s + x.freightCents, 0), meetsDeadline: late === 0, lateUnits: late, airOption: { centsPerUnit: roundHalfEven(PROD[sku][4] * 380), transitDays: 4 } }];
}

function treasury(b) {
  const sku = need(b, "sku");
  const qty = Number(need(b, "qty"));
  const freight = Number(need(b, "freightCents"));
  const margins = need(b, "margins");
  if (!PROD[sku]) return [404, { error: { code: "UNKNOWN_SKU", message: sku } }];
  const landed = (qty * PROD[sku][3] + freight + POLICY.orderOverheadUsd * 100) / qty;
  const pricesAtMargin = Object.fromEntries(margins.map((m) => [String(m), Math.ceil(landed / (1 - m))]));
  const target = Math.ceil(landed / (1 - POLICY.targetMargin));
  const ru = b.reallocUnits ?? {};
  const prem = Math.ceil((((ru.TIER2 ?? 0) * POLICY.premiumByTier.TIER2 + (ru.TIER1 ?? 0) * POLICY.premiumByTier.TIER1) * target) / qty);
  const adv = Number(b.advancePct ?? 0);
  const headroom = TOMMY.creditLimitUsd - TOMMY.openReceivableUsd; // the data pack has one buyer (Tommy)
  return [200, {
    landedCents: landed, pricesAtMargin, reallocPremiumCents: prem,
    liquidity: { net30Usd: NET30, status: LIQ },
    advanceLever: { minAdvancePct: POLICY.minAdvancePct, marginRelief: 0.01, applies: LIQ === "DEFICIT" && adv >= POLICY.minAdvancePct },
    credit: { headroomUsd: headroom, ok: (qty * target) / 100 <= headroom },
  }];
}

const synthesize = () => [200, { proposal: null, messageToBuyer: null, reasoning: null, source: "rules", model: null, attest: null, ms: 0 }];

const ROUTES = {
  "agents/inventory": { alias: ["JupiterInventoryAgent"], fn: inventory },
  "agents/logistics": { alias: ["JupiterLogisticsAgent"], fn: logistics },
  "agents/treasury": { alias: ["JupiterTreasuryAgent"], fn: treasury },
  "seller/synthesize": { alias: ["jupiterSellerAgent", "jupiterCeoAgent"], fn: synthesize },
};

// ---------------------------------------------------------------- HTTP
const err = (status, code, message) => [status, { error: { code, message } }];
createServer(async (req, res) => {
  const send = ([status, obj]) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const path = new URL(req.url, "http://x").pathname;
  if (req.method === "GET" && path === "/healthz") {
    return send([200, { ok: true, asOf: TODAY, ai: false, model: null, gateway: { ok: false }, attest: { ok: false }, tenants: [opt.tenant], impl: "reference agents (data pack v1, Node)" }]);
  }
  const pre = `/v1/tenants/${opt.tenant}/`;
  if (req.method !== "POST" || !path.startsWith(pre)) return send(err(404, "NOT_FOUND", path));
  const route = ROUTES[path.slice(pre.length)];
  if (!route) return send(err(404, "NOT_FOUND", path));
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(err(401, "UNAUTHORIZED", "bad token"));
  if (req.headers["x-agent-lei"] !== opt.lei) return send(err(403, "FORBIDDEN", "LEI is not this tenant's"));
  if (!route.alias.includes(req.headers["x-agent-alias"])) return send(err(403, "FORBIDDEN", `must be called as ${route.alias.join(" or ")}`));
  let body = "";
  for await (const c of req) body += c;
  try {
    const b = JSON.parse(body || "{}");
    if (!b.requestId) return send(err(400, "BAD_REQUEST", "requestId required"));
    send(route.fn(b));
  } catch (e) {
    send(err(e instanceof Bad || e instanceof SyntaxError ? 422 : 500, e instanceof Bad || e instanceof SyntaxError ? "BAD_REQUEST" : "INTERNAL", e.message));
  }
}).listen(Number(opt.port), opt.host, () => console.log(`reference OutcomeAI agents on http://${opt.host}:${opt.port} (tenant ${opt.tenant}, liquidity ${LIQ} ${NET30} USD) — Ctrl+C to stop`));
