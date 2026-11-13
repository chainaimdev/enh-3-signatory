// ================= KRAM VERFER RESOLVER (A.6 server port) =================
// JS/ESM port of DD's src/messaging/kram-internal/oobi-resolver.ts. SAME
// behaviour: rotation-aware AID -> Verfer via LIVE KERIA, so the server
// middleware verifies inbound KRAM signatures against current keys.
//
// Keep this byte-for-byte equivalent in behaviour to the DD .ts. The two ports
// exist only because DD is TypeScript and the api-server is plain ESM JS; a
// divergence here would let a signature pass on one side and fail on the other.
//
// GROUNDING (read from real code, not memory):
//   - oobis().resolve / operations().wait+delete  -> sig-wallet oobis.ts + operations.ts
//   - keyStates().query (POST /queries -> Operation)
//   - keyStates().get  (GET /states?pre= -> ARRAY of key-state records)
//       signify-ts@0.3.0-rc2 dist/keri/app/coring.js (KeyStates)
//   - Verfer({qb64}) over state.k[0]
//
// CONSTRAINTS: no mocks; oobiBase + timeouts from options/env; throw if missing.

import { Verfer } from "signify-ts";

export class VerferResolver {
  /**
   * @param {import('signify-ts').SignifyClient} client connected SignifyClient
   * @param {{oobiBase:string, keyStateTtlMs?:number, opTimeoutMs?:number}} options
   */
  constructor(client, options) {
    if (!client) {
      throw new Error("[kram-resolver] a connected SignifyClient is required.");
    }
    const base = options?.oobiBase?.trim();
    if (!base) {
      throw new Error(
        "[kram-resolver] oobiBase is required (host-reachable KERIA OOBI base, " +
          "e.g. http://localhost:3902). The docker OOBI host 'keria:3902' does " +
          "not resolve from WSL/host."
      );
    }
    try {
      new URL(base);
    } catch {
      throw new Error(`[kram-resolver] oobiBase is not a valid URL: ${base}`);
    }
    this.client = client;
    this.oobiBase = base;
    this.ttlMs = options.keyStateTtlMs ?? 60_000;
    this.opTimeoutMs = options.opTimeoutMs ?? 30_000;
    /** @type {Map<string,{verfer:Verfer,key:string,fetchedAt:number}>} */
    this.cache = new Map();
  }

  /**
   * Swap ONLY scheme+host of a docker-internal OOBI with the configured
   * host-reachable base. Preserves the /oobi/<aid>/agent/<aid> path + query.
   * @param {string} oobi
   * @returns {string}
   */
  remapOobi(oobi) {
    let u;
    try {
      u = new URL(oobi);
    } catch {
      throw new Error(`[kram-resolver] counterparty OOBI is not a valid URL: ${oobi}`);
    }
    const b = new URL(this.oobiBase);
    u.protocol = b.protocol;
    u.host = b.host; // host includes hostname:port
    return u.toString();
  }

  /**
   * Resolve an AID to its CURRENT signing Verfer via live KERIA. Cached per AID
   * for keyStateTtlMs; pass {forceRefresh:true} to bypass the cache.
   * @param {string} aid
   * @param {string} oobi
   * @param {{forceRefresh?:boolean}} [opts]
   * @returns {Promise<Verfer>}
   */
  async resolveVerfer(aid, oobi, opts = {}) {
    if (!aid) throw new Error("[kram-resolver] resolveVerfer called without an AID.");
    if (!oobi) throw new Error(`[kram-resolver] no OOBI provided for AID ${aid}.`);

    const cached = this.cache.get(aid);
    if (cached && !opts.forceRefresh && Date.now() - cached.fetchedAt < this.ttlMs) {
      return cached.verfer;
    }

    // 1) Make KERIA aware of the AID's endpoints (idempotent; updates contact).
    const remapped = this.remapOobi(oobi);
    const resolveOp = await this.client.oobis().resolve(remapped, aid);
    await this.waitOperation(resolveOp);

    // 2) Refresh key state from the AID's witnesses -> rotation-aware.
    const queryOp = await this.client.keyStates().query(aid);
    await this.waitOperation(queryOp);

    // 3) Read the now-current key state. GET /states?pre= returns an ARRAY.
    const states = await this.client.keyStates().get(aid);
    const record = Array.isArray(states) ? states[0] : states;
    const key = record?.k?.[0];
    if (!key) {
      throw new Error(
        `[kram-resolver] no current signing key (state.k[0]) for AID ${aid} ` +
          `after query. Is the AID known to this KERIA?`
      );
    }

    const verfer = new Verfer({ qb64: key });
    this.cache.set(aid, { verfer, key, fetchedAt: Date.now() });
    return verfer;
  }

  /** Drop a cached entry (e.g. on a verify failure, before a forced refresh). */
  invalidate(aid) {
    this.cache.delete(aid);
  }

  // Mirror of sig-wallet operations.ts#waitOperation.
  async waitOperation(op) {
    const completed = await this.client
      .operations()
      .wait(op, { signal: AbortSignal.timeout(this.opTimeoutMs) });
    const name = completed?.name;
    if (name) {
      try {
        await this.client.operations().delete(name);
      } catch {
        // Non-fatal: the wait already gave us a completed op.
      }
    }
    return completed;
  }
}
