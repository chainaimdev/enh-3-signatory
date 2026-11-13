#!/usr/bin/env node
// Static file server for the Signatory UI (UI/ folder only). Node built-ins, no dependencies.
//
//   node serve.mjs [--port 8765] [--host 127.0.0.1] [--root <dir>] [--no-cache]
//
// Safety rules (ARCHITECTURE-signatory-ui-build-2026-11-13.md §2.1):
// - serves only regular files whose real path is inside --root (default: this file's folder);
//   ".." segments, absolute paths, NUL bytes and symlinks that leave the root are refused;
// - only GET and HEAD; only .html .js .json .css .svg; dot-files are refused;
// - binds to 127.0.0.1 by default. Never point --root at legentvLEI/ or enh2-final/ (task-data holds BRAN files).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const opts = { port: 8765, host: "127.0.0.1", root: here, noCache: false };

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) { console.error(`ERROR: ${a} requires a value`); process.exit(1); }
    return v;
  };
  switch (a) {
    case "--port": {
      const p = Number(val());
      if (!Number.isInteger(p) || p < 1 || p > 65535) { console.error("ERROR: --port must be 1-65535"); process.exit(1); }
      opts.port = p; break;
    }
    case "--host": opts.host = val(); break;
    case "--root": opts.root = path.resolve(val()); break;
    case "--no-cache": opts.noCache = true; break;
    case "--help":
      console.log("node serve.mjs [--port 8765] [--host 127.0.0.1] [--root <dir>] [--no-cache]");
      process.exit(0);
    default: console.error(`ERROR: unknown flag ${a}`); process.exit(1);
  }
}

let root;
try { root = fs.realpathSync(opts.root); } catch { console.error(`ERROR: --root not found: ${opts.root}`); process.exit(1); }
if (!fs.statSync(root).isDirectory()) { console.error(`ERROR: --root is not a folder: ${root}`); process.exit(1); }
// Refuse roots that contain the vLEI task-data (BRAN files).
for (const bad of ["task-data", "legentvLEI"]) {
  if (fs.existsSync(path.join(root, bad))) { console.error(`ERROR: refusing to serve a root that contains "${bad}": ${root}`); process.exit(1); }
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const DEFAULT_PAGE = "/Agent%20Escalation%20Console.html";

function send(res, code, text, extra = {}) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(text);
}

function resolveSafe(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return { code: 400 }; }
  if (decoded.includes("\0")) return { code: 400 };
  const segs = decoded.split(/[\\/]+/).filter(Boolean);
  if (segs.some((s) => s === ".." || s === "." || s.startsWith("."))) return { code: 403 };
  if (segs.some((s) => /^[A-Za-z]:$/.test(s))) return { code: 403 };
  const full = path.join(root, ...segs);
  let real;
  try { real = fs.realpathSync(full); } catch { return { code: 404 }; }
  if (real !== root && !real.startsWith(root + path.sep)) return { code: 403 };
  let st;
  try { st = fs.statSync(real); } catch { return { code: 404 }; }
  if (!st.isFile()) return { code: 404 };
  const type = TYPES[path.extname(real).toLowerCase()];
  if (!type) return { code: 403 };
  return { code: 200, real, type, size: st.size };
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed", { Allow: "GET, HEAD" });
  let pathname;
  try { pathname = new URL(req.url, "http://localhost").pathname; } catch { return send(res, 400, "Bad request"); }
  if (pathname === "/") { res.writeHead(302, { Location: DEFAULT_PAGE }); return res.end(); }
  // Check the raw path too: URL() already collapses "/../", so a raw ".." is refused outright.
  if (/(^|[\\/])\.\.([\\/]|$)/.test(req.url) || /%2e%2e/i.test(req.url)) return send(res, 403, "Forbidden");
  const r = resolveSafe(pathname);
  if (r.code !== 200) return send(res, r.code, { 400: "Bad request", 403: "Forbidden", 404: "Not found" }[r.code]);
  const headers = {
    "Content-Type": r.type,
    "Content-Length": r.size,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": opts.noCache ? "no-store" : "no-cache",
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(r.real).on("error", () => res.destroy()).pipe(res);
});

server.on("error", (e) => { console.error(`ERROR: ${e.message}`); process.exit(1); });
server.listen(opts.port, opts.host, () => {
  console.log(`Serving ${root}`);
  console.log(`Open http://${opts.host}:${opts.port}${DEFAULT_PAGE}`);
});
