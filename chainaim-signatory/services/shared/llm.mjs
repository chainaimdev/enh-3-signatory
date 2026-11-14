// Change #4: AI proposer for the negotiation (services/shared/negotiate.mjs).
// Calls an OpenAI-compatible chat endpoint: POST <baseUrl>/v1/chat/completions (planned: the ChainAim private-ai
// gateway, wired in #8 — not verified against it yet). The API key comes ONLY from the environment variable named by
// keyEnv (default SIGNATORY_LLM_API_KEY); it is never logged or returned. Any failure throws → the negotiation uses the
// DD5 rule for that move and labels it "rules". There is no built-in or fake model.

const SYSTEM = {
  seller:
    "You are jupiterSellerAgent, the delegated sales agent of Jupiter Knitting Company, negotiating the unit price (US cents) " +
    "of cotton fabric with a buyer agent. Never go below your private minimum. Reply with ONE JSON object only: " +
    '{"action":"ACCEPT"|"COUNTER"|"REJECT","price":<integer cents, only for COUNTER>,"reasoning":"<one short sentence>"}. ' +
    "ACCEPT accepts the buyer's last offer.",
  buyer:
    "You are tommyBuyerAgent, the delegated procurement agent of Tommy Hilfiger Europe, negotiating the unit price (US cents) " +
    "of cotton fabric with a seller agent. Never exceed your private budget. Reply with ONE JSON object only: " +
    '{"action":"ACCEPT"|"COUNTER"|"REJECT","price":<integer cents, only for COUNTER>,"reasoning":"<one short sentence>"}. ' +
    "ACCEPT accepts the seller's last counter.",
};

/** Extracts the first JSON object from a model reply and normalises it to {action, price, reasoning}. */
export function parseProposal(text) {
  if (typeof text !== "string") throw new Error("empty model reply");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in the model reply");
  let o;
  try {
    o = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error("model reply is not valid JSON");
  }
  const action = String(o.action ?? "").toUpperCase();
  if (!["ACCEPT", "COUNTER", "REJECT"].includes(action)) throw new Error(`model action "${o.action}" is not ACCEPT/COUNTER/REJECT`);
  const price = o.price === undefined || o.price === null ? undefined : Number(o.price);
  if (action === "COUNTER" && !Number.isInteger(price)) throw new Error("COUNTER without an integer price in cents");
  const reasoning = typeof o.reasoning === "string" ? o.reasoning.slice(0, 240) : "";
  return { action, ...(action === "COUNTER" ? { price } : {}), reasoning };
}

/**
 * Returns an async proposer (role, publicState) → {action, price?, reasoning, model, ms}, or null when not configured.
 * opts: {baseUrl, model, keyEnv, timeoutMs, env, fetchImpl}
 */
export function createLlmProposer({ baseUrl, model = "default", keyEnv = "SIGNATORY_LLM_API_KEY", timeoutMs = 15000, env = process.env, fetchImpl = fetch } = {}) {
  if (!baseUrl) return null;
  const url = `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
  return async (role, state) => {
    const key = env[keyEnv];
    if (!key) throw new Error(`${keyEnv} is not set`);
    const t0 = Date.now();
    let r;
    try {
      r = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: [
            { role: "system", content: SYSTEM[role] },
            { role: "user", content: JSON.stringify(state) },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`AI not reachable (${e.name === "TimeoutError" ? "timeout" : e.message})`);
    }
    if (!r.ok) throw new Error(`AI HTTP ${r.status}`);
    const j = await r.json().catch(() => null);
    const content = j?.choices?.[0]?.message?.content;
    const p = parseProposal(content);
    return { ...p, model: j?.model ?? model, ms: Date.now() - t0 };
  };
}
