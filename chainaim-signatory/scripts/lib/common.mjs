// Shared helpers for scripts/*: config loading and read-only NEAR RPC calls.
// No keys are read here: signing is done only by the near CLI (deploy/set-mandates).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Loads config/signatory.json (+ accounts.json). Paths in the config are relative to ROOT. */
export function loadConfig(configPath = resolve(ROOT, "config", "signatory.json")) {
  const cfg = readJson(configPath);
  for (const k of ["contractId", "rpcUrl", "token", "tokenDecimals", "accountsPath"]) {
    if (cfg[k] === undefined || cfg[k] === "") throw new Error(`config: ${k} missing`);
  }
  const abs = (p) => (p ? resolve(ROOT, p) : p);
  cfg.paths = {
    accounts: abs(cfg.accountsPath),
    evidence: abs(cfg.evidencePath),
    uiConfig: abs(cfg.uiConfigPath),
    uiAccounts: abs(cfg.uiAccountsPath),
    wasm: abs(cfg.wasmPath),
    // change #2: off-chain commitment records (salts); git-ignored, never published
    commits: abs(cfg.commitsPath),
    // change #3: AP2 records and keys (private/* git-ignored; public JWKs under config/ap2-keys)
    ap2Records: abs(cfg.ap2?.recordsPath),
    ap2MerchantKey: abs(cfg.ap2?.merchantKeyPath),
    ap2MerchantPublicJwk: abs(cfg.ap2?.merchantPublicJwkPath),
    ap2BuyerKey: abs(cfg.ap2?.buyerKeyPath),
    ap2BuyerPublicJwk: abs(cfg.ap2?.buyerPublicJwkPath),
  };
  cfg.accounts = loadAccounts(cfg.paths.accounts);
  return cfg;
}

/** Validates accounts.json and resolves mandate aliases to `set_mandate` args. */
export function loadAccounts(path) {
  const a = readJson(path);
  for (const k of ["owner", "registrar", "payee", "aliases", "mandates"]) {
    if (!a[k]) throw new Error(`accounts.json: ${k} missing`);
  }
  const resolveAlias = (alias) => {
    if (alias === "owner") return a.owner;
    const e = a.aliases[alias];
    if (!e) throw new Error(`accounts.json: unknown alias ${alias}`);
    return e.account;
  };
  a.mandateArgs = a.mandates.map((m) => {
    const e = a.aliases[m.alias];
    if (!e) throw new Error(`accounts.json: mandate for unknown alias ${m.alias}`);
    if (!/^[0-9]+$/.test(String(m.limitUnits))) throw new Error(`accounts.json: ${m.alias} limitUnits must be an integer string`);
    return {
      alias: m.alias,
      args: {
        account: e.account,
        company: e.company,
        role: e.role,
        limit_units: String(m.limitUnits),
        approver: resolveAlias(m.approver),
      },
    };
  });
  const payeeAliases = Object.entries(a.aliases).filter(([, e]) => e.role === "payee");
  for (const [alias, e] of payeeAliases) {
    if (e.account !== a.payee) throw new Error(`accounts.json: alias ${alias} account differs from payee`);
  }
  return a;
}

let rpcId = 0;
export async function rpc(rpcUrl, method, params, timeoutMs = 10000) {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `s3-${++rpcId}`, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json();
  if (body.error) {
    const cause = body.error.cause?.name || body.error.name || "RPC_ERROR";
    const err = new Error(`${cause}: ${body.error.data || body.error.message || ""}`.trim());
    err.cause_name = cause;
    throw err;
  }
  return body.result;
}

/** Contract view call. Returns the parsed JSON result. Throws on missing contract / method panic. */
export async function view(rpcUrl, contractId, method, args = {}) {
  const r = await rpc(rpcUrl, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  if (r.error) throw new Error(r.error);
  const text = Buffer.from(r.result).toString("utf8");
  return text === "" ? null : JSON.parse(text);
}

/** view_account; returns null when the account does not exist. */
export async function viewAccount(rpcUrl, accountId) {
  try {
    return await rpc(rpcUrl, "query", { request_type: "view_account", finality: "final", account_id: accountId });
  } catch (e) {
    if (e.cause_name === "UNKNOWN_ACCOUNT") return null;
    throw e;
  }
}

/** yoctoNEAR string → "x.yyyy NEAR" (string math, no floats). */
export function formatNear(yocto) {
  const s = BigInt(yocto).toString().padStart(25, "0");
  const whole = s.slice(0, -24).replace(/^0+(?=\d)/, "");
  return `${whole}.${s.slice(-24, -20)} NEAR`;
}

/** Integer token units → decimal string (e.g. 84000, 6 → "0.084"). */
export function formatUnits(units, decimals) {
  const s = BigInt(units).toString().padStart(decimals + 1, "0");
  const frac = s.slice(-decimals).replace(/0+$/, "");
  return frac ? `${s.slice(0, -decimals)}.${frac}` : s.slice(0, -decimals);
}
