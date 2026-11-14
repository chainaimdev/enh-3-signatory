// Quote flow (S-2): client for the OutcomeAI quote-agents service (design §4 shared contract).
// Every call is made AS a Jupiter vLEI alias (X-Agent-Alias) for the tenant's LEI (X-Agent-LEI), with the tenant
// bearer token. The token comes ONLY from the environment variable named by tokenEnv (default QUOTE_TOKEN_JUPITER);
// it is never logged, never returned and never written to a record. Any failure throws an OutcomeError
// (code + httpStatus) so the caller can fall back to its rules and record why.
import { randomUUID } from "node:crypto";

export class OutcomeError extends Error {
  constructor(code, message, httpStatus = null) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/**
 * opts: {baseUrl, tenant, tokenEnv, lei, timeoutMs, env, fetchImpl}
 * Returns {baseUrl, tenant, call(alias, path, body) → {body, api}, health() → {body, api}}.
 * path is relative to /v1/tenants/{tenant}/, e.g. "agents/inventory" or "seller/synthesize".
 */
export function createOutcomeClient({
  baseUrl,
  tenant = "jupiter-knitting",
  tokenEnv = "QUOTE_TOKEN_JUPITER",
  lei = "3358004DXAMRWRUIYJ05",
  timeoutMs = 20000,
  env = process.env,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) throw new OutcomeError("CONFIG", "outcome baseUrl is required (--outcome-url)");
  const base = baseUrl.replace(/\/+$/, "");

  async function request(method, url, headers, payload) {
    const t0 = Date.now();
    let r;
    try {
      r = await fetchImpl(url, { method, headers, ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timeout = e?.name === "TimeoutError" || e?.name === "AbortError";
      throw new OutcomeError(timeout ? "TIMEOUT" : "UNREACHABLE", `OutcomeAI not reachable at ${base} (${timeout ? "timeout" : e.message})`, timeout ? 504 : null);
    }
    const ms = Date.now() - t0;
    const json = await r.json().catch(() => null);
    if (!r.ok) {
      const code = json?.error?.code ?? `HTTP_${r.status}`;
      throw new OutcomeError(code, `OutcomeAI ${method} ${new URL(url).pathname} → ${r.status} ${json?.error?.message ?? ""}`.trim(), r.status);
    }
    if (json === null || typeof json !== "object") throw new OutcomeError("BAD_BODY", `OutcomeAI ${new URL(url).pathname} returned a non-JSON body`, r.status);
    return { json, status: r.status, ms };
  }

  return {
    baseUrl: base,
    tenant,
    async health() {
      const url = `${base}/healthz`;
      const { json, status, ms } = await request("GET", url, { accept: "application/json" });
      return { body: json, api: { service: "outcome", method: "GET", path: "/healthz", httpStatus: status, ms } };
    },
    async call(alias, path, body) {
      if (!alias) throw new OutcomeError("CONFIG", "agent alias is required");
      const token = env[tokenEnv];
      if (!token) throw new OutcomeError("NO_TOKEN", `${tokenEnv} is not set`);
      const payload = { ...body, requestId: body?.requestId ?? randomUUID() };
      const rel = `/v1/tenants/${encodeURIComponent(tenant)}/${path.replace(/^\/+/, "")}`;
      const { json, status, ms } = await request("POST", `${base}${rel}`, {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "x-agent-alias": alias,
        "x-agent-lei": lei,
      }, payload);
      return { body: json, api: { service: "outcome", method: "POST", path: rel, alias, requestId: payload.requestId, httpStatus: status, ms } };
    },
  };
}
