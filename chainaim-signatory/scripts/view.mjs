#!/usr/bin/env node
// Read-only views for S-6 (Windows or WSL, no keys):
//   node scripts/view.mjs invoice <said|INV3|INV4>
//   node scripts/view.mjs mandate <account|agent|cpo>
//   node scripts/view.mjs balance <account|agent|payee|contract>     (USDC)
//   node scripts/view.mjs events [from_index]
//   node scripts/view.mjs snapshot                                    (all of the above, one line each)
import { formatUnits, loadConfig, view } from "./lib/common.mjs";

const cfg = loadConfig();
const alias = {
  INV3: "EBQy-FlPtaa6_kh-BZI5Cn-ndtJ2It5Q3JNDMH3oYY1z",
  INV4: "EHusycc5UI7q2qRnfHhY-5fc0M9xkxB0nixx9Vs7m1qr",
  agent: Object.values(cfg.accounts.aliases).find((e) => e.role === "buyer_agent")?.account,
  cpo: Object.values(cfg.accounts.aliases).find((e) => e.role === "cpo")?.account,
  payee: cfg.accounts.payee,
  contract: cfg.contractId,
};
const r = (x) => alias[x] ?? x;
const usdc = async (account) => formatUnits(await view(cfg.rpcUrl, cfg.token, "ft_balance_of", { account_id: account }), cfg.tokenDecimals);

const [cmd, arg] = process.argv.slice(2);
const out = (v) => console.log(JSON.stringify(v, null, 2));

switch (cmd) {
  case "invoice":
    out(await view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said: r(arg) }));
    break;
  case "mandate":
    out(await view(cfg.rpcUrl, cfg.contractId, "get_mandate", { account: r(arg) }));
    break;
  case "balance":
    console.log(`${r(arg)} ${await usdc(r(arg))} USDC`);
    break;
  case "events": {
    const evs = await view(cfg.rpcUrl, cfg.contractId, "get_events", { from_index: Number(arg || 0) });
    for (const e of evs) {
      const d = JSON.parse(e.json).data?.[0] || {};
      console.log(`#${e.index} ${e.event} ${d.said ? d.said.slice(0, 10) + "…" : d.account || ""} ${d.reason || d.via || ""}`.trim());
    }
    break;
  }
  case "snapshot": {
    for (const k of ["INV3", "INV4"]) {
      const i = await view(cfg.rpcUrl, cfg.contractId, "get_invoice", { said: alias[k] });
      console.log(`${k}: ${i ? `${i.status}, payer ${i.payer ?? "-"}` : "not registered"}`);
    }
    const m = await view(cfg.rpcUrl, cfg.contractId, "get_mandate", { account: alias.agent });
    console.log(`agent mandate: ${m ? `limit ${formatUnits(m.limit_units, cfg.tokenDecimals)}, revoked ${m.revoked}` : "none"}`);
    for (const k of ["agent", "payee", "contract"]) console.log(`${k} USDC: ${await usdc(alias[k])}`);
    break;
  }
  default:
    console.error("usage: view.mjs invoice|mandate|balance|events|snapshot [arg]");
    process.exit(64);
}
