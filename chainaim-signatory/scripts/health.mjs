#!/usr/bin/env node
// S-3 health — read-only checks (view calls + service /health). Runs on Windows or in WSL; reads no keys.
//   node scripts/health.mjs [--stage accounts|contract|all] [--require-services] [--write-ui-config]
//                           [--config <path>]
// --stage accounts : RPC, token decimals, S-1 accounts exist, token storage registrations, balances
// --stage contract : + contract code/config, mandates vs accounts.json, evidence invoices on chain
// --stage all      : + services GET /health (default). Down services are WARN unless --require-services.
// --write-ui-config: set contractId / signerUrl / bridgeUrl / advisorsUrl / runnerUrl in
//                    ../UI/signatory-config.json ONLY for the parts that passed (never clears a value,
//                    keeps every other key). Without this flag nothing is written.
// Exit code 1 if any FAIL.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { formatNear, formatUnits, loadConfig, readJson, view, viewAccount, rpc } from "./lib/common.mjs";

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const STAGES = ["accounts", "contract", "all"];
const stage = opt("--stage", "all");
if (!STAGES.includes(stage)) {
  console.error(`--stage must be one of ${STAGES.join(", ")}`);
  process.exit(64);
}
const atLeast = (s) => STAGES.indexOf(stage) >= STAGES.indexOf(s);

const cfg = loadConfig(opt("--config"));
const acc = cfg.accounts;
const results = [];
const report = (level, check, detail = "") => {
  results.push({ level, check, detail });
  console.log(`${level.padEnd(4)}  ${check.padEnd(34)} ${detail}`);
};
const EMPTY_CODE_HASH = "11111111111111111111111111111111";
const STORAGE_YOCTO_PER_BYTE = 10n ** 19n;
const MIN_FREE_CONTRACT = 10n ** 23n; // 0.1 NEAR available for storage + 1 yocto per ft_transfer

/** Integer units of the invoice amount, from the acdcRaw text (never via a JS float). */
function invoiceUnits(inv, decimals) {
  const raw = typeof inv.acdcRaw === "string" ? inv.acdcRaw : JSON.stringify(inv.acdcRaw);
  const m = /"totalAmount"\s*:\s*"?([0-9]+)(?:\.([0-9]+))?"?/.exec(raw || "");
  if (!m) return null;
  const frac = m[2] || "";
  if (frac.length > decimals) return null;
  return BigInt(m[1] + frac.padEnd(decimals, "0"));
}

async function main() {
  const passed = { contract: false, services: {} };

  // ---- RPC + token
  try {
    const st = await rpc(cfg.rpcUrl, "status", []);
    if (st.chain_id === (cfg.network || "testnet")) report("PASS", "rpc", `${cfg.rpcUrl} chain_id ${st.chain_id}`);
    else report("FAIL", "rpc", `chain_id ${st.chain_id}, expected ${cfg.network || "testnet"}`);
  } catch (e) {
    report("FAIL", "rpc", `${cfg.rpcUrl}: ${e.message}`);
    return passed;
  }
  try {
    const md = await view(cfg.rpcUrl, cfg.token, "ft_metadata");
    if (md.decimals === cfg.tokenDecimals) report("PASS", "token ft_metadata", `${md.symbol}, decimals ${md.decimals}`);
    else report("FAIL", "token ft_metadata", `decimals ${md.decimals} ≠ config ${cfg.tokenDecimals}`);
  } catch (e) {
    report("FAIL", "token ft_metadata", e.message);
  }

  // ---- S-1 accounts
  const roles = [
    ["contract", cfg.contractId],
    ["owner", acc.owner],
    ["registrar (bridge)", acc.registrar],
    ...Object.entries(acc.aliases).map(([alias, e]) => [`${alias} (${e.role})`, e.account]),
  ];
  const seen = new Set();
  const accounts = {};
  for (const [label, id] of roles) {
    if (seen.has(id)) continue;
    seen.add(id);
    try {
      const a = await viewAccount(cfg.rpcUrl, id);
      accounts[id] = a;
      if (a) report("PASS", `account ${label}`, `${id} ${formatNear(a.amount)}`);
      else report("FAIL", `account ${label}`, `${id} UNKNOWN_ACCOUNT — create it (S-1)`);
    } catch (e) {
      report("FAIL", `account ${label}`, `${id}: ${e.message}`);
    }
  }

  // ---- token storage registrations (S-1): contract, buyer agents, payee
  const buyerAgents = Object.values(acc.aliases).filter((e) => e.role === "buyer_agent").map((e) => e.account);
  const mustRegister = [...new Set([cfg.contractId, ...buyerAgents, acc.payee])];
  for (const id of mustRegister) {
    if (!accounts[id]) continue;
    try {
      const sb = await view(cfg.rpcUrl, cfg.token, "storage_balance_of", { account_id: id });
      if (sb) report("PASS", "token storage registered", id);
      else
        report(
          "FAIL",
          "token storage registered",
          `${id} not registered — storage_deposit on ${cfg.token.slice(0, 8)}… (S-1)`,
        );
    } catch (e) {
      report("FAIL", "token storage registered", `${id}: ${e.message}`);
    }
  }

  // ---- evidence invoices (amounts needed by the agent)
  let invoices = [];
  if (cfg.paths.evidence && existsSync(cfg.paths.evidence)) {
    const ev = readJson(cfg.paths.evidence);
    invoices = (ev.invoices || (ev.invoice ? [ev.invoice] : [])).map((inv) => ({
      said: inv.said,
      units: invoiceUnits(inv, cfg.tokenDecimals),
      payee: inv.acdc?.a?.paymentWalletAddress,
      chain: inv.acdc?.a?.paymentChainID,
    }));
    report("INFO", "evidence", `${invoices.length} invoice(s), generatedAt ${ev.generatedAt}`);
    for (const inv of invoices) {
      if (inv.units === null) report("FAIL", "evidence amount", `${inv.said}: totalAmount unreadable or > ${cfg.tokenDecimals} decimals`);
      if (inv.payee !== acc.payee) report("FAIL", "evidence payee", `${inv.said}: ${inv.payee} ≠ accounts.json payee ${acc.payee}`);
      if (inv.chain !== `near:${cfg.network || "testnet"}`) report("FAIL", "evidence chain", `${inv.said}: ${inv.chain}`);
    }
  } else {
    report("WARN", "evidence", `not found at ${cfg.paths.evidence}`);
  }

  // ---- contract (code, config, mandates, invoices)
  let onChain = {};
  if (atLeast("contract")) {
    const c = accounts[cfg.contractId];
    if (!c) {
      report("FAIL", "contract code", "contract account missing");
    } else if (c.code_hash === EMPTY_CODE_HASH) {
      report("FAIL", "contract code", "no code deployed — scripts/deploy.sh (S-2b)");
    } else {
      const free = BigInt(c.amount) - BigInt(c.storage_usage) * STORAGE_YOCTO_PER_BYTE;
      report(free >= MIN_FREE_CONTRACT ? "PASS" : "WARN", "contract free balance", `${formatNear(free > 0n ? free : 0n)} beyond storage (${c.storage_usage} bytes)`);
      try {
        const g = await view(cfg.rpcUrl, cfg.contractId, "get_config");
        const bad = [
          ["owner", acc.owner],
          ["registrar", acc.registrar],
          ["token", cfg.token],
        ].filter(([k, v]) => g[k] !== v);
        if (bad.length) report("FAIL", "contract get_config", `differs: ${bad.map(([k]) => k).join(", ")}`);
        else {
          report("PASS", "contract get_config", `owner/registrar/token match, ${g.events_count} event(s)`);
          passed.contract = true;
        }
      } catch (e) {
        report("FAIL", "contract get_config", e.message);
      }
    }

    if (passed.contract) {
      for (const m of acc.mandateArgs) {
        try {
          const got = await view(cfg.rpcUrl, cfg.contractId, "get_mandate", { account: m.args.account });
          if (!got) {
            report("FAIL", `mandate ${m.alias}`, "missing — scripts/set-mandates.sh");
            continue;
          }
          const diff = ["company", "role", "limit_units", "approver"].filter((k) => got[k] !== m.args[k]);
          if (diff.length) report("FAIL", `mandate ${m.alias}`, `differs from accounts.json: ${diff.join(", ")}`);
          else
            report(
              got.revoked ? "WARN" : "PASS",
              `mandate ${m.alias}`,
              `limit ${formatUnits(got.limit_units, cfg.tokenDecimals)}, approver ${got.approver}${got.revoked ? ", REVOKED (set-mandates resets)" : ""}`,
            );
        } catch (e) {
          report("FAIL", `mandate ${m.alias}`, e.message);
        }
      }
      for (const inv of invoices) {
        try {
          const got = await view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said: inv.said });
          onChain[inv.said] = got;
          if (!got) report("INFO", `invoice ${inv.said.slice(0, 10)}…`, "not registered yet (bridge, S-5)");
          // change #2: amount is only a commitment until payment reveals it
          else if (got.amount_units === null || got.amount_units === undefined)
            report("PASS", `invoice ${inv.said.slice(0, 10)}…`, `${got.status}, commitment only (amount hidden until payment)`);
          else if (inv.units !== null && BigInt(got.amount_units) !== inv.units)
            report("FAIL", `invoice ${inv.said.slice(0, 10)}…`, `on-chain amount ${got.amount_units} ≠ evidence ${inv.units}`);
          else report("PASS", `invoice ${inv.said.slice(0, 10)}…`, `${got.status}, ${formatUnits(got.amount_units, cfg.tokenDecimals)} USDC`);
        } catch (e) {
          report("FAIL", `invoice ${inv.said.slice(0, 10)}…`, e.message);
        }
      }
    }
  }

  // ---- buyer agent USDC balance vs unpaid evidence invoices
  const unpaid = invoices
    .filter((i) => i.units !== null && !["paid", "pending"].includes(onChain[i.said]?.status))
    .reduce((s, i) => s + i.units, 0n);
  for (const id of buyerAgents) {
    if (!accounts[id]) continue;
    try {
      const bal = BigInt(await view(cfg.rpcUrl, cfg.token, "ft_balance_of", { account_id: id }));
      const level = bal >= unpaid ? "PASS" : "WARN";
      report(level, "buyer agent USDC", `${id} ${formatUnits(bal, cfg.tokenDecimals)} (unpaid invoices need ${formatUnits(unpaid, cfg.tokenDecimals)}; faucet G-38)`);
    } catch (e) {
      report("FAIL", "buyer agent USDC", `${id}: ${e.message}`);
    }
  }

  // ---- services
  if (atLeast("all")) {
    for (const [name, port] of Object.entries(cfg.ports || {})) {
      const url = `http://127.0.0.1:${port}`;
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
        const body = await r.text();
        if (r.ok) {
          passed.services[name] = url;
          report("PASS", `service ${name}`, `${url}/health ${r.status}`);
        } else report(flag("--require-services") ? "FAIL" : "WARN", `service ${name}`, `${url}/health ${r.status} ${body.slice(0, 80)}`);
      } catch {
        report(flag("--require-services") ? "FAIL" : "WARN", `service ${name}`, `${url} not reachable`);
      }
    }
  }
  return passed;
}

function writeUiConfig(passed) {
  const path = cfg.paths.uiConfig;
  if (!path || !existsSync(path)) {
    report("FAIL", "ui config", `not found at ${path}`);
    return;
  }
  const ui = JSON.parse(readFileSync(path, "utf8"));
  const set = {};
  if (passed.contract) set.contractId = cfg.contractId;
  const keyOf = { signer: "signerUrl", bridge: "bridgeUrl", advisors: "advisorsUrl", runner: "runnerUrl" };
  for (const [name, url] of Object.entries(passed.services)) if (keyOf[name]) set[keyOf[name]] = url;
  const changed = Object.entries(set).filter(([k, v]) => ui[k] !== v);
  if (!changed.length) {
    report("INFO", "ui config", "no change");
    return;
  }
  for (const [k, v] of changed) ui[k] = v;
  writeFileSync(path, JSON.stringify(ui, null, 2) + "\n");
  report("INFO", "ui config", `wrote ${changed.map(([k, v]) => `${k}=${v}`).join(", ")} → ${path}`);
}

main()
  .then((passed) => {
    if (flag("--write-ui-config")) writeUiConfig(passed);
    const fails = results.filter((r) => r.level === "FAIL").length;
    const warns = results.filter((r) => r.level === "WARN").length;
    console.log(`\n${fails ? "NOT READY" : "OK"} — ${fails} fail, ${warns} warn (stage ${stage})`);
    process.exit(fails ? 1 : 0);
  })
  .catch((e) => {
    console.error(`health: ${e.stack || e.message}`);
    process.exit(2);
  });
