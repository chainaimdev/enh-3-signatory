// Minimal JSON HTTP server shared by signer and bridge.
// - binds 127.0.0.1 only
// - P8: a request whose Origin header is present and differs from allowOrigin is refused (403);
//   requests without Origin (runner, scripts, curl) are allowed because of the 127.0.0.1 bind.
// - logs one JSON line per request: method, path, status, ms, txHash / error. Never bodies with keys
//   (no service ever holds a key in a response object).
import { createServer } from "node:http";

const MAX_BODY = 16 * 1024;

export function log(service, fields) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), service, ...fields }) + "\n");
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error();
    return v;
  } catch {
    throw new HttpError(400, "body must be a JSON object");
  }
}

/**
 * routes: { "GET /health": async (body) => [status, json], ... }
 * Returns the http.Server (listening).
 */
export function startServer({ service, port, allowOrigin, routes, host = "127.0.0.1" }) {
  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    const origin = req.headers.origin;
    const cors = origin === allowOrigin ? { "access-control-allow-origin": allowOrigin, vary: "Origin" } : {};

    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...cors });
      res.end(JSON.stringify(body));
      const extra = {};
      if (body.txHash) extra.txHash = body.txHash;
      if (body.ok === false) extra.error = body.error || body.reason;
      if (body.outcome?.event) extra.outcome = body.outcome.event;
      log(service, { method: req.method, path, status, ms: Date.now() - t0, ...extra });
    };

    if (origin !== undefined && origin !== allowOrigin) {
      return send(403, { ok: false, error: `origin not allowed: ${origin}` });
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }
    const route = routes[`${req.method} ${path}`];
    if (!route) return send(404, { ok: false, error: `no route ${req.method} ${path}` });
    try {
      const body = req.method === "POST" ? await readJsonBody(req) : {};
      const [status, out] = await route(body);
      send(status, out);
    } catch (e) {
      send(e instanceof HttpError ? e.status : 500, { ok: false, error: e.message });
    }
  });
  server.listen(port, host, () => log(service, { event: "listening", url: `http://${host}:${port}` }));
  return server;
}
