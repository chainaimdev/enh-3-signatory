#!/usr/bin/env node
// Quote test rig: Tommy's RFQ → jupiterSellerAgent (hub) → Inventory → hub → Logistics → hub → Treasury → hub → seller
// synthesis → quote back to tommyBuyerAgent, for the 10 scenarios in data/quote/rig-scenarios.json, against OutcomeAI's
// quote-agents for the jupiter-knitting tenant. Prints every hub hop (endpoint, question, answer) and checks the outcome.
//
//   node scripts/quote-rig.mjs [--scenario S01..S10|all] [--outcome-url http://127.0.0.1:8785] [--ai on|off]
//        [--approve officer,ceo|officer|ceo|none] [--bodies] [--no-check] [--out private/quote-rig]
//        [--tenant jupiter-knitting] [--token-env QUOTE_TOKEN_JUPITER] [--timeout-ms 20000]
//        [--rigs data/quote/rig-scenarios.json] [--authority config/quote-authority.json] [--json]
//        [--buyer outcome|rules] [--buyer-tenant tommy-hilfiger-europe] [--buyer-token-env QUOTE_TOKEN_TOMMY]
//
// Endpoints (OutcomeAI quote-agents, POST, Bearer <tenant token>, X-Agent-Alias, X-Agent-LEI):
//   Jupiter /v1/tenants/jupiter-knitting/agents/inventory  /agents/logistics  /agents/treasury  /seller/synthesize
//   Tommy   /v1/tenants/tommy-hilfiger-europe/agents/treasury  /buyer/synthesize   (--buyer outcome; rules = Signatory's
//           rule buyer in quote-buyer.mjs, no Tommy calls)                                       (+ GET /healthz)
// Tokens are read from the env vars named by --token-env and --buyer-token-env; they are never printed or written.
// Exit 0: every checked scenario matches its expect block; 1: a mismatch or a failed run; 2: OutcomeAI or token missing.
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readJson, ROOT } from "./lib/common.mjs";
import { createOutcomeClient } from "../services/shared/outcome-client.mjs";
import { createRuleBuyer } from "../services/runner/quote-buyer.mjs";
import { createOutcomeBuyer } from "../services/runner/quote-buyer-outcome.mjs";
import { loadQuotePolicy, runQuote } from "../services/runner/quote-flow.mjs";

const DEFAULTS = {
  scenario: "all",
  "outcome-url": "http://127.0.0.1:8785",
  ai: "on",
  approve: "officer,ceo",
  out: "private/quote-rig",
  tenant: "jupiter-knitting",
  "token-env": "QUOTE_TOKEN_JUPITER",
  "timeout-ms": "20000",
  rigs: "data/quote/rig-scenarios.json",
  authority: "config/quote-authority.json",
  buyer: "outcome",
  "buyer-tenant": "tommy-hilfiger-europe",
  "buyer-token-env": "QUOTE_TOKEN_TOMMY",
};
const SWITCHES = ["json", "bodies", "no-check", "help"];

export function parseArgs(argv) {
  const o = { ...DEFAULTS, json: false, bodies: false, "no-check": false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") o.help = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (SWITCHES.includes(k)) o[k] = true;
      else if (k in DEFAULTS) {
        o[k] = v ?? argv[++i];
        if (o[k] === undefined) throw new Error(`--${k} needs a value`);
      } else throw new Error(`unknown flag --${k}`);
    } else throw new Error(`unexpected argument ${a}`);
  }
  if (!["on", "off"].includes(o.ai)) throw new Error("--ai must be on or off");
  if (!["outcome", "rules"].includes(o.buyer)) throw new Error("--buyer must be outcome or rules");
  const ap = o.approve.split(",").map((s) => s.trim()).filter(Boolean);
  for (const x of ap) if (!["officer", "ceo", "none"].includes(x)) throw new Error(`--approve: unknown value ${x}`);
  o.approveSet = new Set(ap);
  o.timeoutMs = Number(o["timeout-ms"]);
  if (!Number.isInteger(o.timeoutMs) || o.timeoutMs < 1000) throw new Error("--timeout-ms must be an integer ≥ 1000");
  return o;
}

const usd = (c) => (c == null ? "—" : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const n = (x) => Number(x).toLocaleString("en-US");
const LEVEL_FLAG = { SALES_OFFICER: "officer", CEO: "ceo" };

// ---- plain-language question and answer per endpoint (what the hub asked, what the agent said)
const ASK = {
  "agents/inventory": (b) => `Can Jupiter supply ${n(b.qty)} × ${b.sku} ready to ship by ${b.shipBy}? Which lots, any shortfall, whose lots could be reallocated, any better grade?`,
  "agents/logistics": (b) => `Get ${b.lots.map((l) => `${l.lot} (${n(l.units)}, ready ${l.readyDate}, ${l.warehouse})`).join(", ")} to DAP Los Angeles by ${b.deadline}, ${b.allowAir ? "air allowed" : "sea only"}: which sailing, delivered when, freight?`,
  "agents/treasury": (b) => `${n(b.qty)} × ${b.sku}, freight ${usd(b.freightCents)}, reallocated Tier-2 ${n(b.reallocUnits.TIER2)} / Tier-1 ${n(b.reallocUnits.TIER1)}, Net ${b.termsDays}, ${b.advancePct}% advance: landed cost, price per margin, liquidity, Tommy's credit?`,
  "seller/synthesize": (b) => `${b.mode === "ceo-brief" ? `${b.authority.level === "CEO" ? "CEO" : "Sales Officer"} brief` : `Round ${b.round}`} at ${b.authority.level} (floor ${usd(b.authority.floorCents)}): Tommy's last ${usd(b.history.at(-1)?.priceCents)} for ${n(b.inquiry.qty)} × ${b.inquiry.sku} by ${b.inquiry.deadline}. Accept, counter or escalate?`,
};
const ANSWER = {
  "agents/inventory": (r) =>
    [`${r.sources.map((s) => `${s.lot} ${s.kind} ${n(s.units)} ready ${s.readyDate}`).join("; ") || "no own stock"}`, `shortfall ${n(r.shortfall)}`,
      ...(r.reallocatable.length ? [`reallocatable ${r.reallocatable.map((x) => `${x.lot} ${x.tier} ${n(x.units)} (${x.requiredAuthority}, +${x.premiumPct}%)`).join("; ")}`] : []),
      ...(r.gradeAlternatives?.length ? [`better grade ${r.gradeAlternatives.map((g) => g.sku).join(", ")}`] : [])].join(" | "),
  "agents/logistics": (r) => `${r.legs.map((g) => `${g.lot} ${g.mode} ${g.carrier} ETD ${g.etd} → ${g.delivered}${g.late ? " LATE" : ""}`).join("; ")} | freight ${usd(r.freightCents)} | on time: ${r.meetsDeadline ? "yes" : `no (${n(r.lateUnits)} late)`}`,
  "agents/treasury": (r) => `landed ${usd(r.landedCents)} | 15% ${usd(r.pricesAtMargin["0.15"])} · 12% ${usd(r.pricesAtMargin["0.12"])} · 8% ${usd(r.pricesAtMargin["0.08"])} | premium ${usd(r.reallocPremiumCents)} | cash ${r.liquidity.status} | credit ${r.credit.ok ? "ok" : "OVER LIMIT"} (headroom $${n(r.credit.headroomUsd)})`,
  "seller/synthesize": (r) => `${r.proposal?.decision ?? "?"} ${usd(r.proposal?.counter?.priceCents)} (source ${r.source}${r.model ? `, ${r.model}` : ""})`,
};
const WHO = { "agents/inventory": "Inventory", "agents/logistics": "Logistics", "agents/treasury": "Treasury", "seller/synthesize": "seller synthesis" };
const TOMMY_ASK = {
  "agents/treasury": (b) => `${b.rfqId}: ${n(b.qty)} × ${b.sku} at ${usd(b.priceCents)}/unit, ${b.advancePct}% advance — within my budget? who approves the payment? cash?`,
  "buyer/synthesize": (b) => `${b.rfqId} ${b.phase === "escalation" ? "officer's" : `round ${b.round}`} ask ${usd(b.askCents)} (my last ${usd(b.lastOfferCents)}): accept or counter?`,
};
const TOMMY_ANSWER = {
  "agents/treasury": (r) => `within budget: ${r.withinBudget ? "yes" : "NO"} | total $${n(r.totalUsd)} | approver ${r.approver ?? "over authority"} (${r.approval}) | cash ${r.cash.status}${r.cash.advanceDueUsd ? `, advance $${n(r.cash.advanceDueUsd)}` : ""}`,
  "buyer/synthesize": (r) => `${r.decision} ${usd(r.priceCents)} (source ${r.source}) — "${r.messageToSeller}"`,
};
const TOMMY_WHO = { "agents/treasury": "Tommy treasury", "buyer/synthesize": "buyer synthesis" };

/**
 * Wraps an OutcomeAI client so every call is traced with its endpoint, question and answer. `seq` is shared by Jupiter's
 * and Tommy's clients so the hop numbers follow the real order; `side` picks the caller label and the wording.
 */
export function traceClient(client, tenant, line, { bodies = false, seq = { n: 0 }, side = "seller" } = {}) {
  const calls = [];
  const [asks, answers, who] = side === "buyer" ? [TOMMY_ASK, TOMMY_ANSWER, TOMMY_WHO] : [ASK, ANSWER, WHO];
  return {
    calls,
    async call(alias, path, body) {
      seq.n += 1;
      const from = side === "buyer" ? "tommyBuyerAgent" : "hub jupiterSellerAgent";
      line(` ${String(seq.n).padStart(2)}. ${from} → ${alias} (${who[path]})   POST /v1/tenants/${tenant}/${path}`);
      line(`       asks:    ${asks[path](body)}`);
      if (bodies) line(`       body:    ${JSON.stringify(body)}`);
      const r = await client.call(alias, path, body);
      calls.push({ alias, path, request: body, response: r.body });
      line(`       answers: ${answers[path](r.body)}  [HTTP ${r.api?.httpStatus ?? "?"}]`);
      return r;
    },
  };
}

/** Compares a run summary with a scenario's expect block. Prices and rounds are only compared when no AI proposal was used. */
export function checkOutcome(expect, s, { aiUsed }) {
  const diffs = [];
  const eq = (k, a, b) => JSON.stringify(a) !== JSON.stringify(b) && diffs.push(`${k}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  eq("decision", s.decision, expect.decision);
  eq("sku", s.sku, expect.sku);
  eq("decidedBy", s.decidedByAlias, expect.decidedByAlias);
  eq("reasons", s.reasons, expect.reasons);
  eq("shipments", s.shipments, expect.shipments);
  if (!aiUsed) {
    eq("priceCents", s.decision === "DECLINE" ? null : s.priceCents, expect.priceCents);
    eq("rounds", s.rounds, expect.rounds);
  }
  return diffs;
}

/** Runs the chosen scenarios through Signatory's runQuote (the hub) and returns one row per scenario. */
export async function runRig({ scenarios, policy, client, tenant = "jupiter-knitting", buyerClient = null, buyerTenant = "tommy-hilfiger-europe", ai = true, approveSet = new Set(["officer", "ceo"]), line = () => {}, bodies = false, check = true, recordDir = null }) {
  const rows = [];
  for (const q of scenarios) {
    const r = q.rfq;
    const it = r.items[0];
    line(`\n=== ${q.id} · ${q.scenario}`);
    line(`    path: ${q.path}`);
    const seq = { n: 0 };
    const tc = traceClient(client, tenant, line, { bodies, seq });
    const tb = buyerClient ? traceClient(buyerClient, buyerTenant, line, { bodies, seq, side: "buyer" }) : null;
    const buyer = tb ? createOutcomeBuyer({ client: tb, rfq: r }) : createRuleBuyer(q.buyerSim, it.custom_target_rate_cents);
    let buyerCheck = null;
    const quoteNames = [];
    let finalDoc = null;
    let dir = null;
    if (recordDir) {
      dir = resolve(recordDir, r.name);
      if (existsSync(dir)) renameSync(dir, `${dir}.${statSync(dir).mtime.toISOString().replace(/[:.]/g, "-")}`);
      mkdirSync(dir, { recursive: true });
    }
    let row;
    try {
      if (buyer.prepare) {
        const p = await buyer.prepare();
        if (!p.withinBudget) line(`       tommyBuyerAgent: the opening price is over budget — sends the RFQ anyway`);
      }
      seq.n += 1;
      line(` ${String(seq.n).padStart(2)}. ${r.custom_from_agent} (${r.company}) → ${r.custom_to_agent} (hub)   ERPNext Request for Quotation ${r.name}`);
      line(`       ${n(it.qty)} × ${it.item_code} grade ${it.custom_quality_grade} at ${usd(it.custom_target_rate_cents)}/unit, ${r.incoterm} ${r.named_place}, deliver by ${it.schedule_date}, Net ${r.custom_payment_terms_days}, ${r.custom_advance_pct}% advance${buyer.source === "outcome" ? "" : "  (Tommy = rule buyer, --buyer rules)"}`);
      const s = await runQuote({
        rfq: r, policy, client: tc, ai,
        buyer,
        decide: async (req) => {
          const ok = approveSet.has(LEVEL_FLAG[req.level]);
          line(`       ${req.alias}${req.preparedBy ? ` (brief by ${req.preparedBy})` : ""}: ${ok ? "APPROVES" : "REJECTS"} counter ${usd(req.counterCents)} [${req.reasons.join(", ")}]`);
          return { decision: ok ? "approve" : "reject", who: req.alias };
        },
        record: async (name, obj) => {
          if (/^round-\d+\.quote\.json$/.test(name)) quoteNames.push(obj.name);
          if (name === "final.quote.json") finalDoc = obj;
          if (dir) writeFileSync(resolve(dir, name), JSON.stringify(obj, null, 2) + "\n");
        },
        onStep: async (ev) => {
          if (ev.type === "plan") line(`       hub plan (${ev.level}): ${ev.ok ? "on time" : "NO on-time plan"} · ${ev.chunks.map((c) => `${c.lot}${c.kind === "REALLOC" ? `[${c.tier}]` : ""} ${n(c.units)} ${c.mode} → ${c.delivered}`).join("; ")}${ev.counters.map((c) => ` · ${c.toBuyer ?? c.internal}`).join("")}`);
          else if (ev.type === "floors") line(`       hub floors (Jupiter-internal, never sent to Tommy): ${Object.entries(ev.floors).map(([k, v]) => `${k} ${usd(v)}`).join(" · ")} · importance ${ev.importance.band}`);
          else if (ev.type === "treasury-check") line(`       hub treasury check: ${ev.checks.map((c) => c.reason).join(", ")} → needs ${ev.level}`);
          else if (ev.type === "escalate") line(`       hub escalates: ${ev.reasons.join(", ")} → ${ev.chain.join(" → ")}`);
          else if (ev.type === "quote") line(`  →  hub → tommyBuyerAgent   Quotation ${quoteNames.at(-1) ?? "—"} R${ev.round} ${ev.decision} ${usd(ev.priceCents)}: "${ev.message}"`);
          else if (ev.type === "buyer") line(`  ←  tommyBuyerAgent → hub   ${ev.action} ${usd(ev.priceCents)}`);
        },
      });
      const qn = finalDoc?.quotation;
      if (buyer.check && s.decision === "ACCEPT") buyerCheck = await buyer.check(s.priceCents);
      const aiUsed = tc.calls.some((c) => c.path === "seller/synthesize" && c.response?.source === "ai");
      line(`  →  hub → tommyBuyerAgent   final ${qn ? `Quotation ${qn.name} (${qn.status})` : "decline, no quotation"}: "${qn?.custom_message_to_buyer ?? `we cannot deliver ${n(s.qty)} × ${s.requestedSku} by ${it.schedule_date}`}"`);
      const deliveries = s.shipments.map((x) => `${n(x.units)} by ${x.deliveredBy}`).join(" + ");
      const total = s.decision === "ACCEPT" ? `$${n(((s.qty * s.priceCents) / 100).toFixed(2))}` : "—";
      if (buyerCheck) line(`  →  payment by ${buyerCheck.approver ?? "nobody (over Tommy's authority)"} ($${n(buyerCheck.totalUsd)}: ${buyerCheck.approval === "AGENT" ? "within the agent's NEAR mandate" : buyerCheck.approval === "CPO" ? "above the agent's mandate, the CPO approves" : "over authority"})`);
      line(`  RESULT  customer ${r.company} (${r.custom_from_agent}) · ${n(s.qty)} × ${s.sku} · ${r.incoterm} ${r.named_place} · ${s.decision === "ACCEPT" ? deliveries : "no delivery"} · ${s.decision} ${s.decision === "ACCEPT" ? `${usd(s.priceCents)}/unit = ${total}` : ""} · decided by ${s.decidedByAlias} · rounds ${s.rounds}${s.reasons.length ? ` · ${s.reasons.join(", ")}` : ""}`);
      const diffs = check && q.expect ? checkOutcome(q.expect, s, { aiUsed }) : [];
      if (check && q.expect) line(diffs.length ? `  CHECK   ✗ ${diffs.join("; ")}` : `  CHECK   ✓ matches expect${aiUsed ? " (AI proposals used: price and rounds not compared)" : ""}`);
      row = { id: q.id, ok: diffs.length === 0, diffs, aiUsed, summary: s, quotation: qn?.name ?? null, calls: tc.calls.map((c) => `${c.alias} ${c.path}`), buyerCalls: (tb?.calls ?? []).map((c) => `${c.alias} ${c.path}`), payment: buyerCheck ? { approval: buyerCheck.approval, approver: buyerCheck.approver } : null, records: dir };
    } catch (e) {
      line(`  FAILED  ${e.message}`);
      row = { id: q.id, ok: false, diffs: [`run failed: ${e.message}`], error: e.message, calls: tc.calls.map((c) => `${c.alias} ${c.path}`), buyerCalls: (tb?.calls ?? []).map((c) => `${c.alias} ${c.path}`) };
    }
    rows.push(row);
  }
  return rows;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) return console.log(HELP);
  const policy = loadQuotePolicy(resolve(ROOT, o.authority));
  const book = readJson(resolve(ROOT, o.rigs));
  const scenarios = o.scenario === "all" ? book.inquiries : book.inquiries.filter((q) => o.scenario.split(",").includes(q.id));
  if (!scenarios.length) throw new Error(`no scenario ${o.scenario} in ${o.rigs} (have ${book.inquiries.map((q) => q.id).join(", ")})`);
  const line = o.json ? () => {} : (s) => console.log(s);
  const client = createOutcomeClient({ baseUrl: o["outcome-url"], tenant: o.tenant, tokenEnv: o["token-env"], lei: policy.seller.lei, timeoutMs: o.timeoutMs });
  let health;
  try {
    health = (await client.health()).body;
  } catch (e) {
    console.error(`OutcomeAI is not reachable at ${o["outcome-url"]} (${e.message}). Start quote-agents first, or pass --outcome-url.`);
    process.exit(2);
  }
  for (const env of [o["token-env"], ...(o.buyer === "outcome" ? [o["buyer-token-env"]] : [])]) {
    if (!process.env[env]) {
      console.error(`${env} is not set: set it to the OutcomeAI tenant token (never paste it into a chat or a log)${env === o["buyer-token-env"] ? ", or run with --buyer rules" : ""}.`);
      process.exit(2);
    }
  }
  const tommyLei = scenarios[0].rfq.custom_from_lei;
  const buyerClient = o.buyer === "outcome" ? createOutcomeClient({ baseUrl: o["outcome-url"], tenant: o["buyer-tenant"], tokenEnv: o["buyer-token-env"], lei: tommyLei, timeoutMs: o.timeoutMs }) : null;
  // the expect blocks were recorded with both officers approving; any other --approve is a what-if run, not checked
  const check = !o["no-check"] && o.approve === DEFAULTS.approve;
  if (!o["no-check"] && !check) line(`(check off: the expect blocks assume --approve ${DEFAULTS.approve})`);
  line(`OutcomeAI ${o["outcome-url"]} · as-of ${health.asOf ?? "?"} · OutcomeAI ai=${health.ai} model=${health.model ?? "—"} · seller ${o.tenant} · buyer ${o.buyer === "outcome" ? o["buyer-tenant"] : "rule buyer (Signatory)"} · rig --ai ${o.ai} --approve ${o.approve}`);
  const rows = await runRig({
    scenarios, policy, client, tenant: o.tenant, buyerClient, buyerTenant: o["buyer-tenant"], ai: o.ai === "on", approveSet: o.approveSet, line, bodies: o.bodies, check,
    recordDir: resolve(ROOT, o.out),
  });
  if (o.json) return console.log(JSON.stringify(rows, null, 2));
  console.log("\nID   check  decision  price    rounds  decided by                        deliveries");
  for (const r of rows) {
    const s = r.summary;
    console.log(`${r.id.padEnd(4)} ${!check ? "-" : r.ok ? "✓" : "✗"}      ${(s?.decision ?? "FAILED").padEnd(9)} ${usd(s?.decision === "ACCEPT" ? s.priceCents : null).padEnd(8)} ${String(s?.rounds ?? "—").padEnd(7)} ${(s?.decidedByAlias ?? "—").padEnd(33)} ${s?.decision === "ACCEPT" ? s.shipments.map((x) => `${n(x.units)} by ${x.deliveredBy}`).join(" + ") : "—"}`);
  }
  const bad = rows.filter((r) => !r.ok).length;
  console.log(`\n${check ? `${rows.length - bad}/${rows.length} as expected` : "not checked"} · records: ${resolve(ROOT, o.out)}/<RFQ-id>/`);
  if (check && bad) process.exit(1);
}

const HELP = `quote-rig — Tommy RFQ → jupiterSellerAgent hub → Inventory → Logistics → Treasury → seller synthesis → quote to Tommy
  --scenario S01..S10|S03,S08|all   which scenarios (default all)
  --outcome-url URL                 OutcomeAI quote-agents (default ${DEFAULTS["outcome-url"]})
  --ai on|off                       on: the hub calls seller/synthesize each round (default); off: Signatory's rules only
  --approve officer,ceo|officer|ceo|none   which officers approve escalations (default officer,ceo)
  --bodies                          also print each request body
  --no-check                        do not compare with the expect blocks (exit 0 even if outcomes differ)
  --out DIR                         records per RFQ (default private/quote-rig, git-ignored)
  --tenant ID --token-env NAME      default jupiter-knitting, QUOTE_TOKEN_JUPITER
  --buyer outcome|rules             outcome: Tommy = tommyBuyerAgent + TommyTreasuryAgent in OutcomeAI (default); rules: Signatory's rule buyer
  --buyer-tenant ID --buyer-token-env NAME   default tommy-hilfiger-europe, QUOTE_TOKEN_TOMMY
  --timeout-ms N --rigs FILE --authority FILE --json`;

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(`quote-rig: ${e.message}`);
    process.exit(1);
  });
}
