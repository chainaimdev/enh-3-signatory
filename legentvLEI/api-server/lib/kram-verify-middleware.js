// ================= KRAM VERIFY MIDDLEWARE (A.6) =================
// Express middleware that authenticates the CALLER of a route via a KERI
// signature carried in RFC 9530 / Signify HTTP headers. It is the HTTP-transport
// twin of DD's KramSigner.verify(): it reconstructs the SAME canonical signing
// bytes (kram-canonical.js, ported byte-for-byte from DD) and verifies them
// against the caller's CURRENT signing key, resolved LIVE from KERIA.
//
// HEADERS CONSUMED (produced by the DD-side header producer that mirrors seal()):
//   Content-Digest:    sha-256=:<base64(raw sha-256 of body)>:   (RFC 9530)
//   Signify-Resource:  <caller KERI AID>                          (-> canonical resource)
//   Signify-Timestamp: <ISO-8601 send time>                       (-> canonical created)
//   Signify-Signature: <CESR qb64 Cigar over the canonical bytes>
//
// VERIFY PIPELINE (order matters — cheap/local checks before network):
//   1. headers present?                         -> 400 KRAM_HEADERS_MISSING
//   2. raw body captured?                        -> 400 KRAM_RAW_BODY_MISSING
//   3. parse Content-Digest (structured-headers) -> 400 KRAM_DIGEST_*
//   4. recomputed sha-256(body) == digest?       -> 401 KRAM_CONTENT_DIGEST_MISMATCH
//      (binds the signed digest to the ACTUAL bytes; the HTTP analog of the
//       envelope payloadHash check. Without it the digest is attacker-chosen.)
//   5. timestamp staleness / future skew         -> 401 KRAM_TIMESTAMP_STALE / TIMESTAMP_FUTURE
//   6. dedup on the signature (replay)            -> 401 KRAM_REPLAY_DETECTED
//   7. resolve caller's CURRENT Verfer (live)     -> 401 KRAM_SIGNATURE_INVALID
//   8. Verfer.verify(canonical bytes)             -> 401 KRAM_SIGNATURE_INVALID
//   success -> req.kram = { senderAid, timestamp }, next()
//
// GATING (KRAM_REQUIRED):
//   - KRAM_REQUIRED truthy: KRAM headers MUST be present and valid, else 401/400.
//   - otherwise: a request with NO KRAM headers passes through untouched
//     (gradual rollout). A request that DOES carry headers is always verified.
//
// LAZY INIT: the KERIA client (server's own, from KRAM_SERVER_BRAN_PATH) +
// resolver are built once, on the first request that actually needs verifying,
// so a server with KRAM unused never connects to KERIA.
//
// CONSTRAINTS: no mocks; all config from env; missing required config throws on
// first use (surfaced as KRAM_CONFIG to the caller and logged).

import crypto from "node:crypto";
import fs from "node:fs";

import { parseDictionary } from "structured-headers";
import { Cigar } from "signify-ts";

import { getOrCreateClient } from "./kram-internal/signify-client.js";
import { VerferResolver } from "./kram-internal/oobi-resolver.js";
import { DedupCache } from "./kram-internal/dedup-cache.js";
import { buildKramSigningBytes } from "./kram-internal/kram-canonical.js";

const HDR_RESOURCE = "Signify-Resource";
const HDR_TIMESTAMP = "Signify-Timestamp";
const HDR_SIGNATURE = "Signify-Signature";
const HDR_DIGEST = "Content-Digest";

function isTruthyEnv(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function fail(res, status, code, detail) {
  console.warn(`[kram-verify] ${code}: ${detail}`);
  return res.status(status).json({ success: false, error: detail, kramCode: code });
}

/**
 * Build the lazy, memoized verification state (client + resolver + caller
 * AID->OOBI map + dedup cache). Reads all config from env. Throws on missing
 * required config; the caller turns that into a KRAM_CONFIG response.
 */
function makeStateLoader() {
  let statePromise = null;
  return function getState() {
    if (statePromise) return statePromise;
    statePromise = (async () => {
      const branPath = process.env.KRAM_SERVER_BRAN_PATH?.trim();
      if (!branPath) {
        throw new Error(
          "KRAM_SERVER_BRAN_PATH is not set (server's own 21-char KERI passcode " +
            "file; used to connect a read-only client for live key resolution)."
        );
      }
      if (!fs.existsSync(branPath)) {
        throw new Error(`KRAM_SERVER_BRAN_PATH file not found: ${branPath}`);
      }
      const bran = fs.readFileSync(branPath, "utf8").trim();
      if (!bran) throw new Error(`KRAM_SERVER_BRAN_PATH file is empty: ${branPath}`);

      const oobiBase = process.env.KERIA_OOBI_BASE?.trim();
      if (!oobiBase) {
        throw new Error(
          "KERIA_OOBI_BASE is not set (host-reachable KERIA OOBI base, e.g. " +
            "http://localhost:3902; remaps the docker-internal OOBI host)."
        );
      }

      const callerPaths = (process.env.KRAM_CALLER_INFO_PATHS ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean);
      if (callerPaths.length === 0) {
        throw new Error(
          "KRAM_CALLER_INFO_PATHS is not set (comma-separated <name>-info.json " +
            "paths of allowed callers; supplies each caller AID's OOBI)."
        );
      }

      const oobiByAid = new Map();
      for (const p of callerPaths) {
        if (!fs.existsSync(p)) throw new Error(`caller info file not found: ${p}`);
        const info = JSON.parse(fs.readFileSync(p, "utf8"));
        if (!info.aid) throw new Error(`caller info file ${p} has no "aid".`);
        if (!info.oobi) throw new Error(`caller info file ${p} has no "oobi".`);
        oobiByAid.set(info.aid, info.oobi);
      }

      const client = await getOrCreateClient(bran);
      const resolver = new VerferResolver(client, { oobiBase });

      const maxAgeMs = Number(process.env.MAX_MESSAGE_AGE_MS ?? 300_000);
      const maxFutureMs = Number(process.env.MAX_FUTURE_SKEW_MS ?? 30_000);
      const dedupTtlMs = Number(
        process.env.KRAM_DEDUP_TTL_MS ?? maxAgeMs + maxFutureMs
      );
      const dedup = new DedupCache({ ttlMs: dedupTtlMs });

      return { resolver, oobiByAid, dedup, maxAgeMs, maxFutureMs };
    })();
    // If init fails, clear so a later request can retry (e.g. KERIA came up).
    statePromise.catch(() => {
      statePromise = null;
    });
    return statePromise;
  };
}

/**
 * Create the KRAM verify middleware. Returns an async express middleware.
 * @param {{required?:boolean}} [opts] override KRAM_REQUIRED (mainly for tests).
 */
export function createKramVerifier(opts = {}) {
  const required =
    opts.required !== undefined ? opts.required : isTruthyEnv(process.env.KRAM_REQUIRED);
  const getState = makeStateLoader();

  return async function kramVerify(req, res, next) {
    const resource = req.get(HDR_RESOURCE);
    const timestamp = req.get(HDR_TIMESTAMP);
    const signature = req.get(HDR_SIGNATURE);
    const digestHeader = req.get(HDR_DIGEST);

    const anyHeader = resource || timestamp || signature || digestHeader;
    if (!anyHeader) {
      // No KRAM headers at all.
      if (required) {
        return fail(res, 401, "KRAM_HEADERS_MISSING",
          "KRAM_REQUIRED is set but the request carries no Signify-* / Content-Digest headers.");
      }
      return next(); // gradual rollout: unsigned requests pass through
    }
    if (!resource || !timestamp || !signature || !digestHeader) {
      return fail(res, 400, "KRAM_HEADERS_MISSING",
        "Incomplete KRAM headers: need Signify-Resource, Signify-Timestamp, Signify-Signature, Content-Digest.");
    }

    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      return fail(res, 400, "KRAM_RAW_BODY_MISSING",
        "Raw request body not captured. Ensure express.json({verify}) records req.rawBody before this route.");
    }

    // ── Content-Digest parse (structured-headers byte-sequence -> ArrayBuffer) ──
    let claimedDigest;
    try {
      const dict = parseDictionary(digestHeader);
      const entry = dict.get("sha-256");
      if (!entry) {
        return fail(res, 400, "KRAM_DIGEST_UNSUPPORTED",
          "Content-Digest has no sha-256 member (only sha-256 is supported).");
      }
      claimedDigest = Buffer.from(entry[0]); // entry = [ArrayBuffer, params]
    } catch (e) {
      return fail(res, 400, "KRAM_DIGEST_PARSE", `Content-Digest parse failed: ${e.message}`);
    }

    // ── Digest binds the signature to the ACTUAL body bytes ──
    const actualDigest = crypto.createHash("sha256").update(rawBody).digest();
    if (
      claimedDigest.length !== actualDigest.length ||
      !crypto.timingSafeEqual(claimedDigest, actualDigest)
    ) {
      return fail(res, 401, "KRAM_CONTENT_DIGEST_MISMATCH",
        "Body does not match the sha-256 in Content-Digest (tampered or wrong digest).");
    }
    const contentDigestB64 = actualDigest.toString("base64");

    // ── Staleness / future skew ──
    let state;
    try {
      state = await getState();
    } catch (e) {
      return fail(res, 500, "KRAM_CONFIG", `KRAM verify not configured: ${e.message}`);
    }
    const tsMs = Date.parse(timestamp);
    if (Number.isNaN(tsMs)) {
      return fail(res, 401, "KRAM_TIMESTAMP_STALE", `Unparseable Signify-Timestamp: ${timestamp}`);
    }
    const ageMs = Date.now() - tsMs;
    if (ageMs > state.maxAgeMs) {
      return fail(res, 401, "KRAM_TIMESTAMP_STALE",
        `Request ${Math.floor(ageMs / 1000)}s old, max ${state.maxAgeMs / 1000}s.`);
    }
    if (ageMs < -state.maxFutureMs) {
      return fail(res, 401, "TIMESTAMP_FUTURE",
        `Signify-Timestamp ${Math.floor(-ageMs / 1000)}s in the future.`);
    }

    // ── Replay (deterministic-signature dedup) ──
    if (state.dedup.checkAndRecord(signature)) {
      return fail(res, 401, "KRAM_REPLAY_DETECTED", "This signature was already seen within the live window.");
    }

    // ── Live key resolution for the caller AID ──
    const oobi = state.oobiByAid.get(resource);
    if (!oobi) {
      return fail(res, 401, "KRAM_SIGNATURE_INVALID",
        `Unknown caller AID ${resource} (add its info file to KRAM_CALLER_INFO_PATHS).`);
    }
    let verfer;
    try {
      verfer = await state.resolver.resolveVerfer(resource, oobi);
    } catch (e) {
      return fail(res, 401, "KRAM_SIGNATURE_INVALID",
        `Live key resolution failed for AID ${resource}: ${e.message}`);
    }

    // ── Rebuild the canonical bytes + verify the signature ──
    const signingBytes = buildKramSigningBytes({ senderAid: resource, timestamp, contentDigestB64 });
    let ok;
    try {
      const sigRaw = new Cigar({ qb64: signature }).raw;
      ok = verfer.verify(sigRaw, signingBytes);
    } catch (e) {
      return fail(res, 401, "KRAM_SIGNATURE_INVALID", `Signature decode/verify threw: ${e.message}`);
    }
    if (!ok) {
      return fail(res, 401, "KRAM_SIGNATURE_INVALID", "KERI signature did not verify against the caller's current key.");
    }

    // Authenticated caller. Expose the verified identity to the route handler.
    req.kram = { verified: true, senderAid: resource, timestamp };
    return next();
  };
}
