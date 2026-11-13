// NEAR helpers shared by signer and bridge: key loading, transaction send, outcome parsing,
// start-up guards. Keys are read from <credentials>/<network>/<account>.json (near CLI legacy
// keychain) straight into a KeyPairSigner; the key string is never logged, returned or kept elsewhere.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Account, JsonRpcProvider, KeyPairSigner, actions } from "near-api-js";
import { rpc, view } from "../../scripts/lib/common.mjs";

export const EVENT_STANDARD = "signatory";
const TGAS = 10n ** 12n;

export function defaultCredentialsDir() {
  return join(homedir(), ".near-credentials");
}

/** Loads one legacy-keychain key file and returns a ready Account. Error messages never include file content. */
export async function loadAccount({ credentialsDir, network, accountId, rpcUrl }) {
  const path = resolve(credentialsDir, network, `${accountId}.json`);
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`cannot read key file for ${accountId} at ${path} (${e.code || "invalid JSON"})`);
  }
  if (data.account_id && data.account_id !== accountId) {
    throw new Error(`key file ${path} is for a different account`);
  }
  const secret = data.private_key || data.secret_key;
  if (typeof secret !== "string" || !/^(ed25519|secp256k1):/.test(secret)) {
    throw new Error(`key file ${path} has no usable private_key`);
  }
  const signer = KeyPairSigner.fromSecretKey(secret);
  data = null;
  // Check the key is an access key of the account (public key used internally only, not printed).
  const publicKey = (await signer.getPublicKey()).toString();
  try {
    await rpc(rpcUrl, "query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
  } catch (e) {
    throw new Error(`key file for ${accountId} is not an access key of that account (${e.cause_name || e.message})`);
  }
  const provider = new JsonRpcProvider({ url: rpcUrl });
  return new Account(accountId, provider, signer);
}

/** G-39 guard + contract config check. Throws with a clear reason. */
export async function startupChecks(cfg, { expectRegistrar } = {}) {
  const md = await view(cfg.rpcUrl, cfg.token, "ft_metadata");
  if (md.decimals !== cfg.tokenDecimals) {
    throw new Error(`token decimals ${md.decimals} ≠ config ${cfg.tokenDecimals} (G-39)`);
  }
  const c = await view(cfg.rpcUrl, cfg.contractId, "get_config");
  if (c.token !== cfg.token) throw new Error(`contract token ${c.token} ≠ config token`);
  if (expectRegistrar && c.registrar !== expectRegistrar) {
    throw new Error(`contract registrar ${c.registrar} ≠ accounts.json registrar ${expectRegistrar}`);
  }
  return { symbol: md.symbol, decimals: md.decimals, contract: c };
}

/** Sends one function call and waits for FINAL (all receipts, incl. callbacks). Never throws. */
export async function sendCall(account, { receiverId, method, args, gasTgas, depositYocto = 0n }) {
  let res;
  try {
    res = await account.signAndSendTransaction({
      receiverId,
      actions: [actions.functionCall(method, args, BigInt(gasTgas) * TGAS, BigInt(depositYocto))],
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
  } catch (e) {
    return { ok: false, txHash: e.context?.transactionHash || null, error: errorText(e) };
  }
  return summarize(res);
}

function errorText(e) {
  if (e?.type && e?.message) return `${e.type}: ${e.message}`;
  return e?.message || String(e);
}

/** Readable text of an RPC execution Failure; contract panics come back verbatim. */
export function failureText(f) {
  const fce = f?.ActionError?.kind?.FunctionCallError;
  if (fce?.ExecutionError) return fce.ExecutionError;
  if (fce) return JSON.stringify(fce);
  if (f?.ActionError?.kind) return JSON.stringify(f.ActionError.kind);
  if (f?.InvalidTxError) return `InvalidTxError: ${JSON.stringify(f.InvalidTxError)}`;
  return JSON.stringify(f);
}

/** Parses a send_tx / tx RPC result: hash, final value, failures, logs, signatory events. */
export function summarize(res) {
  const txHash = res.transaction_outcome?.id || res.transaction?.hash || null;
  const outcomes = [res.transaction_outcome, ...(res.receipts_outcome || [])].filter(Boolean);
  const logs = [];
  const events = [];
  const failures = [];
  for (const o of outcomes) {
    const executor = o.outcome?.executor_id;
    for (const line of o.outcome?.logs || []) {
      if (line.startsWith("EVENT_JSON:")) {
        try {
          const ev = JSON.parse(line.slice("EVENT_JSON:".length));
          if (ev.standard === EVENT_STANDARD) events.push({ executor, ...ev });
          continue;
        } catch {
          /* fall through: keep as plain log */
        }
      }
      logs.push({ executor, log: line });
    }
    if (o.outcome?.status?.Failure) failures.push({ executor, error: failureText(o.outcome.status.Failure) });
  }
  let value;
  let ok = true;
  let error;
  if (res.status?.Failure) {
    ok = false;
    error = failureText(res.status.Failure);
  } else if (typeof res.status?.SuccessValue === "string") {
    const text = Buffer.from(res.status.SuccessValue, "base64").toString("utf8");
    try {
      value = text === "" ? null : JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { ok, txHash, value, error, events, logs, failures };
}

/** Last event among `names` (signatory standard), flattened to {event, ...data[0]}. */
export function lastEvent(events, names) {
  const ev = [...events].reverse().find((e) => names.includes(e.event));
  return ev ? { event: ev.event, ...(ev.data?.[0] || {}) } : null;
}

export function txUrl(cfg, hash) {
  return hash && cfg.explorer ? `${cfg.explorer}/txns/${hash}` : undefined;
}

export function isAccountId(s) {
  return typeof s === "string" && s.length >= 2 && s.length <= 64 && /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(s);
}

export function isSaid(s) {
  return typeof s === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(s);
}
