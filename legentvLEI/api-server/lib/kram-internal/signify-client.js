// ================= KRAM SIGNIFY CLIENT BOOTSTRAP (A.6 server port) =================
// JS/ESM port of DD's src/messaging/kram/signify-client.ts. The api-server had
// NO signify client before A.6; the KRAM verify middleware needs one to run the
// read-only oobis().resolve() + keyStates().query() that resolve a sender's
// CURRENT signing key (via VerferResolver).
//
// WHY THE SERVER NEEDS ITS OWN BRAN: querying ANOTHER AID's key state is
// read-only, but signify-ts still requires a connected client (its own agent).
// connect-or-boot means if KRAM_SERVER_BRAN_PATH points at a passcode with no
// agent yet on this KERIA, we boot a fresh client AID — no business identity
// required. The bran comes from env; missing -> throw at startup (no fallback).
//
// Keep behaviour identical to DD's bootstrap (same Tier, same 21-char padEnd,
// same ready()-first ordering) so both sides talk to KERIA the same way.

import { ready, SignifyClient, Tier } from "signify-ts";

/**
 * Resolve KERIA endpoints from env. Throws (no fallback) if unset — the docker
 * hostnames (keria:3901/3903) are not reachable from the host.
 * @returns {{adminUrl:string, bootUrl:string}}
 */
export function resolveKeriaEndpoints() {
  const adminUrl = process.env.KERIA_ADMIN_URL?.trim();
  const bootUrl = process.env.KERIA_BOOT_URL?.trim();

  if (!adminUrl) {
    throw new Error(
      "[kram-server] KERIA_ADMIN_URL is not set. Set it to the host-reachable " +
        "KERIA admin URL (e.g. http://localhost:3901)."
    );
  }
  if (!bootUrl) {
    throw new Error(
      "[kram-server] KERIA_BOOT_URL is not set. Set it to the host-reachable " +
        "KERIA boot URL (e.g. http://localhost:3903)."
    );
  }
  return { adminUrl, bootUrl };
}

/**
 * Connect (or boot then connect) a SignifyClient for the given BRAN.
 * @param {string} bran 21-char KERI passcode for the server's client AID.
 * @param {{adminUrl:string, bootUrl:string}} [endpoints] defaults to env.
 * @returns {Promise<SignifyClient>}
 */
export async function getOrCreateClient(bran, endpoints) {
  if (!bran || bran.trim().length === 0) {
    throw new Error("[kram-server] getOrCreateClient called without a BRAN.");
  }

  const { adminUrl, bootUrl } = endpoints ?? resolveKeriaEndpoints();

  // libsodium WASM must be initialized before any keying calls.
  await ready();

  // signify-ts expects a 21-char passcode. Pad defensively (matches DD).
  const passcode = bran.trim().padEnd(21, "_");

  const client = new SignifyClient(adminUrl, passcode, Tier.low, bootUrl);

  try {
    await client.connect();
  } catch {
    const res = await client.boot();
    if (!res.ok) {
      throw new Error(
        `[kram-server] KERIA boot failed: ${res.status} ${res.statusText} ` +
          `(adminUrl=${adminUrl}, bootUrl=${bootUrl})`
      );
    }
    await client.connect();
  }

  return client;
}
