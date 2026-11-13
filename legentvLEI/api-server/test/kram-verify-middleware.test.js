// ================= KRAM VERIFY MIDDLEWARE ROUND-TRIP TEST (A.6) =================
// REAL end-to-end test of the HTTP transport, mirroring the A.5.5 envelope test
// but over RFC 9530 / Signify headers:
//   producer  = the buyer (tommyBuyerAgent), signing with its REAL KERI key
//   verifier  = lib/kram-verify-middleware.js mounted on a live express server,
//               resolving the buyer's CURRENT key LIVE from KERIA
//
// NO MOCKS anywhere: real signify-ts Signer, real KERIA resolution, real HTTP.
// (The A.5 test had to mock the clock for the stale case; here the producer just
//  signs over an explicit past timestamp, so even that needs no mock.)
//
// The producer below reproduces KramSigner.produceHttpHeaders() using this
// package's own kram-canonical.js + a signify-ts Signer — DD's TS KramSigner is
// a separate package, so we re-derive the same bytes here. If this passes, the
// DD producer and this middleware agree on the canonical contract.
//
// REQUIRED ENV (pass host-reachable values; use WSL paths if running under WSL):
//   KERIA_ADMIN_URL    e.g. http://localhost:3901
//   KERIA_BOOT_URL     e.g. http://localhost:3903
//   KERIA_OOBI_BASE    e.g. http://localhost:3902
//   BUYER_INFO_PATH    abs path to tommyBuyerAgent-info.json   (aid + oobi)
//   BUYER_BRAN_PATH    abs path to tommyBuyerAgent-bran.txt    (buyer's signer)
// OPTIONAL ENV:
//   KRAM_SERVER_BRAN_PATH  the middleware's own client bran; defaults to
//                          BUYER_BRAN_PATH if unset (any valid bran works for
//                          the read-only resolve/query).
//
// RUN (bash / WSL, from api-server):
//   export KERIA_ADMIN_URL=http://localhost:3901
//   export KERIA_BOOT_URL=http://localhost:3903
//   export KERIA_OOBI_BASE=http://localhost:3902
//   export BUYER_INFO_PATH=/mnt/c/SATHYA/CHAINAIM3003/mcp-servers/vLEIEnh1/legentvLEI/task-data/tommyBuyerAgent-info.json
//   export BUYER_BRAN_PATH=/mnt/c/SATHYA/CHAINAIM3003/mcp-servers/vLEIEnh1/legentvLEI/task-data/tommyBuyerAgent-bran.txt
//   node --test test/kram-verify-middleware.test.js
// (If KERIA was wiped since the last mint, re-run 4D so the buyer AID resolves.)

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";

import express from "express";

import { getOrCreateClient } from "../lib/kram-internal/signify-client.js";
import { buildKramSigningBytes } from "../lib/kram-internal/kram-canonical.js";
import { createKramVerifier } from "../lib/kram-verify-middleware.js";

function requireEnv(name) {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`[A.6 mw] ${name} is required (see file header for the env list)`);
  return v;
}

function readInfo(infoPath) {
  const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  if (!info.aid) throw new Error(`[A.6 mw] ${infoPath} has no "aid"`);
  if (!info.oobi) throw new Error(`[A.6 mw] ${infoPath} has no "oobi"`);
  return info;
}

/**
 * Reproduce KramSigner.produceHttpHeaders(): sign `payload` and emit the 4
 * headers + the exact body bytes. `opts.timestamp` overrides "now" (stale test).
 */
function produceHeaders(signer, aid, payload, opts = {}) {
  const body = JSON.stringify(payload);
  const contentDigestB64 = crypto.createHash("sha256").update(body).digest("base64");
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const signingBytes = buildKramSigningBytes({ senderAid: aid, timestamp, contentDigestB64 });
  const cigar = signer.sign(signingBytes);
  const signature = cigar.qb64;
  if (!signature) throw new Error("[A.6 mw] signer.sign() yielded no qb64 signature");
  return {
    body,
    headers: {
      "Content-Type": "application/json",
      "Content-Digest": `sha-256=:${contentDigestB64}:`,
      "Signify-Resource": aid,
      "Signify-Timestamp": timestamp,
      "Signify-Signature": signature,
    },
  };
}

let buyerAid;
let buyerSigner;
let server;
let url;

before(async () => {
  // Shared KERIA endpoints (read by getOrCreateClient + the middleware resolver).
  process.env.KERIA_ADMIN_URL = requireEnv("KERIA_ADMIN_URL");
  process.env.KERIA_BOOT_URL = requireEnv("KERIA_BOOT_URL");
  process.env.KERIA_OOBI_BASE = requireEnv("KERIA_OOBI_BASE");

  const buyerInfoPath = requireEnv("BUYER_INFO_PATH");
  const buyerBranPath = requireEnv("BUYER_BRAN_PATH");
  const buyerInfo = readInfo(buyerInfoPath);
  buyerAid = buyerInfo.aid;

  // The route under test is called BY the buyer, so the buyer is the allowed
  // caller. Wire the middleware's caller set + server client from env.
  process.env.KRAM_CALLER_INFO_PATHS = buyerInfoPath;
  if (!process.env.KRAM_SERVER_BRAN_PATH) {
    // Any valid bran works for the read-only resolve/query; reuse the buyer's.
    process.env.KRAM_SERVER_BRAN_PATH = buyerBranPath;
  }

  // Resolve the buyer's OWN Signer (same path KramSigner.init uses).
  const buyerBran = fs.readFileSync(buyerBranPath, "utf8").trim();
  const client = await getOrCreateClient(buyerBran);
  const hab = await client.identifiers().get(buyerAid);
  const km = client.manager.get(hab);
  if (!km.signers || km.signers.length === 0) {
    throw new Error(`[A.6 mw] no signer for buyer AID ${buyerAid} — is BUYER_BRAN_PATH its controller?`);
  }
  buyerSigner = km.signers[0];

  // Live express server: rawBody capture + KRAM middleware (forced required).
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  const kramVerify = createKramVerifier({ required: true });
  app.post("/test/kram", kramVerify, (req, res) => {
    res.json({ ok: true, kram: req.kram });
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  url = `http://127.0.0.1:${server.address().port}/test/kram`;
});

after(() => {
  if (server) server.close();
});

// ── A: happy path — valid signed request authenticates the caller ───────────
test("A: valid KRAM request authenticates the buyer (200, req.kram set)", async () => {
  const { body, headers } = produceHeaders(buyerSigner, buyerAid, { kind: "happy", n: 1 });
  const r = await fetch(url, { method: "POST", headers, body });
  assert.equal(r.status, 200, `expected 200, got ${r.status}`);
  const j = await r.json();
  assert.equal(j.kram?.verified, true);
  assert.equal(j.kram?.senderAid, buyerAid);
});

// ── B1: tampered body (digest no longer matches) -> KRAM_CONTENT_DIGEST_MISMATCH ──
test("B1: body altered after signing is rejected (KRAM_CONTENT_DIGEST_MISMATCH)", async () => {
  const { headers } = produceHeaders(buyerSigner, buyerAid, { kind: "tamper-body", n: 2 });
  // Send a DIFFERENT body than the Content-Digest was computed over.
  const tamperedBody = JSON.stringify({ kind: "tamper-body", n: 999 });
  const r = await fetch(url, { method: "POST", headers, body: tamperedBody });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).kramCode, "KRAM_CONTENT_DIGEST_MISMATCH");
});

// ── B2: corrupted signature (digest intact) -> KRAM_SIGNATURE_INVALID ────────
test("B2: corrupted signature is rejected (KRAM_SIGNATURE_INVALID)", async () => {
  const { body, headers } = produceHeaders(buyerSigner, buyerAid, { kind: "tamper-sig", n: 3 });
  const sig = headers["Signify-Signature"];
  const i = sig.length - 5;
  const swapped = sig[i] === "A" ? "B" : "A";
  headers["Signify-Signature"] = sig.slice(0, i) + swapped + sig.slice(i + 1);
  const r = await fetch(url, { method: "POST", headers, body });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).kramCode, "KRAM_SIGNATURE_INVALID");
});

// ── C: stale timestamp (signed over the past instant) -> KRAM_TIMESTAMP_STALE ──
test("C: stale timestamp is rejected (KRAM_TIMESTAMP_STALE)", async () => {
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { body, headers } = produceHeaders(
    buyerSigner, buyerAid, { kind: "stale", n: 4 }, { timestamp: tenMinAgo }
  );
  const r = await fetch(url, { method: "POST", headers, body });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).kramCode, "KRAM_TIMESTAMP_STALE");
});

// ── D: replay (identical valid request twice) -> KRAM_REPLAY_DETECTED ────────
test("D: replayed request is rejected on the second send (KRAM_REPLAY_DETECTED)", async () => {
  const { body, headers } = produceHeaders(buyerSigner, buyerAid, { kind: "replay", n: 5 });
  const r1 = await fetch(url, { method: "POST", headers, body });
  assert.equal(r1.status, 200, `first send should pass, got ${r1.status}`);
  // Identical bytes -> identical (deterministic) signature -> replay.
  const r2 = await fetch(url, { method: "POST", headers, body });
  assert.equal(r2.status, 401);
  assert.equal((await r2.json()).kramCode, "KRAM_REPLAY_DETECTED");
});
