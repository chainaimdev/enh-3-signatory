// ================= KRAM CANONICAL SIGNING STRING (A.6 server port) =================
// JS/ESM port of DD's src/messaging/kram/kram-canonical.ts. This MUST stay
// byte-for-byte identical to that file's output: the signature the buyer's
// KramSigner.seal() produced covers exactly these bytes, and this middleware
// re-derives them from the RFC 9530 HTTP headers to verify. A single-character
// divergence here makes every cross-transport signature fail.
//
// CONTRACT (post-A.6, RFC 9530 base64 Content-Digest):
//   kram-v1\n
//   resource:<senderAid>\n
//   created:<ISO timestamp>\n
//   content-digest:sha-256=:<STANDARD base64 of raw sha-256 of body>:
//
// The content-digest line is the RFC 9530 structured-field Byte Sequence form,
// so it equals the value carried in `Content-Digest: sha-256=:<base64>:`.
//
// DO NOT EDIT independently of DD's kram-canonical.ts. If the contract changes,
// change both in lockstep.

const KRAM_SIGNING_VERSION = "kram-v1";

/**
 * Build the canonical signing string. Deterministic: same inputs -> same bytes.
 * @param {{senderAid:string, timestamp:string, contentDigestB64:string}} input
 *   contentDigestB64 = STANDARD base64 (not hex, not base64url) of the raw
 *   SHA-256 digest of the serialized payload (the body), matching the byte
 *   sequence inside `Content-Digest: sha-256=:<base64>:`.
 * @returns {string}
 */
export function buildKramSigningString(input) {
  if (!input.senderAid) throw new Error("[kram-canonical] senderAid is required");
  if (!input.timestamp) throw new Error("[kram-canonical] timestamp is required");
  if (!input.contentDigestB64) {
    throw new Error("[kram-canonical] contentDigestB64 is required");
  }
  return [
    KRAM_SIGNING_VERSION,
    `resource:${input.senderAid}`,
    `created:${input.timestamp}`,
    `content-digest:sha-256=:${input.contentDigestB64}:`,
  ].join("\n");
}

/** The signing string as the UTF-8 bytes that get signed/verified. */
export function buildKramSigningBytes(input) {
  return new TextEncoder().encode(buildKramSigningString(input));
}
