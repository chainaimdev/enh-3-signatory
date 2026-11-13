#!/usr/bin/env node
// Small CLI used by the bash scripts (no keys, read-only RPC).
//   plan.mjs get <contractId|rpcUrl|token|network|wasm|owner|registrar|accounts|uiAccounts|gasTgas>
//   plan.mjs init-args                 → JSON args for new(owner, registrar, token)
//   plan.mjs mandates                  → one line per mandate: <alias>\t<account>\t<set_mandate json args>
//   plan.mjs contract-state            → none | no-code | uninitialized | initialized
//   plan.mjs view <method> [json args] → JSON result of a view call on contractId
import { loadConfig, view, viewAccount } from "./common.mjs";

const EMPTY_CODE_HASH = "11111111111111111111111111111111";
const [cmd, ...rest] = process.argv.slice(2);
const cfg = loadConfig(process.env.SIGNATORY_CONFIG || undefined);

async function main() {
  switch (cmd) {
    case "get": {
      const map = {
        contractId: cfg.contractId,
        rpcUrl: cfg.rpcUrl,
        token: cfg.token,
        network: cfg.network || "testnet",
        wasm: cfg.paths.wasm,
        owner: cfg.accounts.owner,
        registrar: cfg.accounts.registrar,
        accounts: cfg.paths.accounts,
        uiAccounts: cfg.paths.uiAccounts,
        gasTgas: String(cfg.gasTgas ?? 150),
      };
      if (!(rest[0] in map)) throw new Error(`unknown key ${rest[0]}`);
      process.stdout.write(`${map[rest[0]]}\n`);
      return;
    }
    case "init-args":
      process.stdout.write(
        JSON.stringify({ owner: cfg.accounts.owner, registrar: cfg.accounts.registrar, token: cfg.token }) + "\n",
      );
      return;
    case "mandates":
      for (const m of cfg.accounts.mandateArgs) {
        process.stdout.write(`${m.alias}\t${m.args.account}\t${JSON.stringify(m.args)}\n`);
      }
      return;
    case "contract-state": {
      const acc = await viewAccount(cfg.rpcUrl, cfg.contractId);
      if (!acc) return void process.stdout.write("none\n");
      if (acc.code_hash === EMPTY_CODE_HASH) return void process.stdout.write("no-code\n");
      try {
        await view(cfg.rpcUrl, cfg.contractId, "get_config");
        process.stdout.write("initialized\n");
      } catch (e) {
        if (/not initialized/i.test(e.message)) process.stdout.write("uninitialized\n");
        else throw e;
      }
      return;
    }
    case "view": {
      const args = rest[1] ? JSON.parse(rest[1]) : {};
      const r = await view(cfg.rpcUrl, cfg.contractId, rest[0], args);
      process.stdout.write(JSON.stringify(r) + "\n");
      return;
    }
    default:
      throw new Error(`usage: plan.mjs get|init-args|mandates|contract-state|view`);
  }
}

main().catch((e) => {
  process.stderr.write(`plan.mjs: ${e.message}\n`);
  process.exit(2);
});
