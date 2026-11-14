#!/usr/bin/env node
// Quote flow (S-3): tommyBuyerAgent sends RFQs to jupiterSellerAgent, which consults Jupiter's Inventory, Logistics
// and Treasury agents in OutcomeAI, negotiates within its vLEI authority and escalates to the Sales Officer → CEO.
//
//   node scripts/demo-quote.mjs [--inquiry T01..T08|all] [--outcome-url http://127.0.0.1:8785]
//        [--approve officer,ceo|officer|none|ask] [--ai on|off] [--out private/quotes] [--pace-ms 0]
//        [--tenant jupiter-knitting] [--token-env QUOTE_TOKEN_JUPITER] [--timeout-ms 20000]
//        [--inquiries data/quote/inquiries.json] [--authority config/quote-authority.json] [--json]
//
// The OutcomeAI tenant token is read from the env var named by --token-env; it is never printed or written.
// Records go to <out>/<RFQ-id>/ (private/ is git-ignored); an earlier run's folder is renamed <RFQ-id>.<time>, not deleted.
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig, readJson, ROOT } from "./lib/common.mjs";
import { createOutcomeClient } from "../services/shared/outcome-client.mjs";
import { totalCents, unitsFromCents } from "../services/shared/negotiate.mjs";
import { createRuleBuyer } from "../services/runner/quote-buyer.mjs";
import { loadQuotePolicy, runQuote } from "../services/runner/quote-flow.mjs";

const DEFAULTS = {
  inquiry: "all",
  "outcome-url": "http://127.0.0.1:8785",
  approve: "officer,ceo",
  ai: "on",
  out: "private/quotes",
  "pace-ms": "0",
  tenant: "jupiter-knitting",
  "token-env": "QUOTE_TOKEN_JUPITER",
  "timeout-ms": "20000",
  inquiries: "data/quote/inquiries.json",
  authority: "config/quote-authority.json",
};

export function parseArgs(argv) {
  const o = { ...DEFAULTS, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") o.help = true;
    else if (a === "--json") o.json = true;
    else if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (!(k in DEFAULTS)) throw new Error(`unknown flag --${k}`);
      o[k] = v ?? argv[++i];
      if (o[k] === undefined) throw new Error(`--${k} needs a value`);
    } else throw new Error(`unexpected argument ${a}`);
  }
  if (!["on", "off"].includes(o.ai)) throw new Error("--ai must be on or off");
  const ap = o.approve.split(",").map((s) => s.trim()).filter(Boolean);
  for (const x of ap) if (!["officer", "ceo", "none", "ask"].includes(x)) throw new Error(`--approve: unknown value ${x}`);
  o.approveSet = new Set(ap);
  o.paceMs = Number(o["pace-ms"]);
  o.timeoutMs = Number(o["timeout-ms"]);
  return o;
}

const LEVEL_FLAG = { SALES_OFFICER: "officer", CEO: "ceo" };
const usd = (c) => (c == null ? "—" : `$${(c / 100).toFixed(2)}`);
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) {
    console.log(readHelp());
    return;
  }
  const cfg = loadConfig();
  const policy = loadQuotePolicy(resolve(ROOT, o.authority));
  const book = readJson(resolve(ROOT, o.inquiries));
  const pick = o.inquiry === "all" ? book.inquiries : book.inquiries.filter((q) => q.id === o.inquiry || q.rfq.name === o.inquiry);
  if (!pick.length) throw new Error(`no inquiry ${o.inquiry} in ${o.inquiries} (have ${book.inquiries.map((q) => q.id).join(", ")})`);

  const client = createOutcomeClient({ baseUrl: o["outcome-url"], tenant: o.tenant, tokenEnv: o["token-env"], lei: policy.seller.lei, timeoutMs: o.timeoutMs });
  let health;
  try {
    health = (await client.health()).body;
  } catch (e) {
    console.error(`OutcomeAI is not reachable at ${o["outcome-url"]}: ${e.message}\nStart OutcomeAI's quote-agents service first, or pass --outcome-url.`);
    process.exit(2);
  }
  if (!process.env[o["token-env"]]) {
    console.error(`${o["token-env"]} is not set. Set it to the OutcomeAI tenant token for ${o.tenant} (do not paste it into chats or logs).`);
    process.exit(2);
  }
  log(o, `OutcomeAI ${o["outcome-url"]}: ok=${health.ok} ai=${health.ai} model=${health.model ?? "—"} tenants=${(health.tenants ?? []).join(",")}`);

  const agentMandate = cfg.accounts.mandates.find((m) => m.alias === "tommyBuyerAgent");
  const rl = o.approveSet.has("ask") ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const rows = [];
  try {
    for (const q of pick) {
      const dir = resolve(ROOT, o.out, q.rfq.name);
      // keep an earlier run's records instead of mixing them with this run's (no file is deleted)
      if (existsSync(dir)) renameSync(dir, `${dir}.${statSync(dir).mtime.toISOString().replace(/[:.]/g, "-")}`);
      mkdirSync(dir, { recursive: true });
      log(o, `\n=== ${q.rfq.name} — ${q.scenario}`);
      const summary = await runQuote({
        rfq: q.rfq,
        policy,
        client,
        buyer: createRuleBuyer(q.buyerSim, q.rfq.items[0].custom_target_rate_cents),
        ai: o.ai === "on",
        record: async (name, obj) => writeFileSync(resolve(dir, name), JSON.stringify(obj, null, 2) + "\n"),
        onStep: async (ev) => {
          log(o, fmtStep(ev));
          await sleep(o.paceMs);
        },
        decide: async (req) => {
          const flag = LEVEL_FLAG[req.level];
          if (rl) {
            const who = req.preparedBy ? `${req.alias} (brief by ${req.preparedBy})` : req.alias;
            if (req.brief?.text) console.log(`    brief: ${req.brief.text}`);
            const a = (await rl.question(`    ${who}: approve counter ${usd(req.counterCents)} (floor ${usd(req.floorCents)}) for ${req.rfqId}? [y/N] `)).trim().toLowerCase();
            return { decision: a === "y" || a === "yes" ? "approve" : "reject", who: req.alias };
          }
          return { decision: o.approveSet.has(flag) ? "approve" : "reject", who: `${req.alias} (--approve ${o.approve})` };
        },
      });
      const units = summary.decision === "ACCEPT" ? unitsFromCents(totalCents(summary.qty, summary.priceCents), cfg.tokenDecimals, cfg.demoScale) : null;
      const route = units == null ? "nothing issued" : units <= BigInt(agentMandate.limitUnits) ? "agent pays" : `${agentMandate.approver} approves`;
      rows.push({ ...summary, onChain: units == null ? null : { units: units.toString(), usdc: Number(units) / 10 ** cfg.tokenDecimals, route }, records: dir });
    }
  } finally {
    rl?.close();
  }
  if (o.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  console.log("\nID       decision  price   rounds  decided by                          reasons                                   on-chain later");
  for (const r of rows) {
    const oc = r.onChain ? `${r.onChain.usdc} USDC, ${r.onChain.route}` : "nothing issued";
    console.log(`${r.id.padEnd(8)} ${r.decision.padEnd(9)} ${usd(r.priceCents).padEnd(7)} R${String(r.rounds).padEnd(6)} ${r.decidedByAlias.padEnd(35)} ${(r.reasons.join(",") || "—").padEnd(41)} ${oc}`);
  }
  console.log(`\nRecords: ${resolve(ROOT, o.out)}/<RFQ-id>/ (inquiry, consults, round quotes, escalations, final quote, jupiter-internal)`);
}

function log(o, s) {
  if (!o.json) console.log(s);
}

function fmtStep(ev) {
  switch (ev.type) {
    case "consult":
      return `  consult  ${ev.alias.padEnd(22)} ${ev.path.padEnd(18)} ${ev.reason.padEnd(20)} HTTP ${ev.api.httpStatus} ${ev.api.ms}ms`;
    case "plan":
      return `  plan     ${ev.ok ? "on time" : "NO PLAN"} at ${ev.level} with ${ev.sku}: ${ev.chunks.map((c) => `${c.lot} ${c.units} ${c.mode} → ${c.delivered}`).join("; ")}${ev.counters.length ? ` | ${ev.counters.map((c) => c.type).join(", ")}` : ""}`;
    case "floors":
      return `  floors   (Jupiter-internal) ${Object.entries(ev.floors).map(([k, v]) => `${k} ${v}`).join(" · ")} · asks ${ev.asks.join("/")}${ev.premium ? ` · premium ${ev.premium}` : ""}${ev.advance ? " · advance lever" : ""} · importance ${ev.importance.band} ${ev.importance.score}`;
    case "quote":
      return `  R${ev.round} seller ${ev.decision} ${usd(ev.priceCents)}${ev.decidedBy ? ` by ${ev.decidedBy}` : ""} — "${ev.message}"`;
    case "buyer":
      return `  R${ev.round} buyer  ${ev.action} ${usd(ev.priceCents)}`;
    case "escalate":
      return `  escalate ${ev.reasons.join(", ")} → band ${ev.band}: ${ev.chain.join(" → ") || "no escalation"}`;
    case "decision":
      return `  decision ${ev.alias}: ${ev.decision} (counter ${usd(ev.counterCents)})`;
    case "final":
      return `  FINAL    ${ev.decision} ${usd(ev.priceCents)} R${ev.rounds} by ${ev.decidedBy}${ev.reasons.length ? ` [${ev.reasons.join(", ")}]` : ""}`;
    default:
      return `  ${ev.type}`;
  }
}

function readHelp() {
  return `demo-quote — Tommy → Jupiter quote flow (Private AI agents in OutcomeAI + vLEI escalation)
  --inquiry T01..T08|all        which RFQ(s) to run (default all)
  --outcome-url URL             OutcomeAI quote-agents base URL (default ${DEFAULTS["outcome-url"]})
  --approve officer,ceo|...     who approves escalations: officer, ceo, none, or ask (prompt) (default officer,ceo)
  --ai on|off                   call OutcomeAI seller/synthesize (on) or use the rules only (off) (default on)
  --out DIR                     records directory (default private/quotes, git-ignored)
  --pace-ms N                   pause after each step, for live demos (default 0)
  --tenant ID --token-env NAME  OutcomeAI tenant and the env var holding its token (default jupiter-knitting, QUOTE_TOKEN_JUPITER)
  --timeout-ms N                per-call timeout (default 20000)
  --inquiries FILE --authority FILE   data/quote/inquiries.json, config/quote-authority.json
  --json                        print the summary as JSON only`;
}

main().catch((e) => {
  console.error(`demo-quote: ${e.message}`);
  process.exit(1);
});
