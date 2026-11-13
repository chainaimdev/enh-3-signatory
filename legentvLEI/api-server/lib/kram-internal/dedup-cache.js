// ================= KRAM DEDUP CACHE (A.6 replay protection) =================
// The A.5 envelope model got replay protection for free from its monotonic
// per-(sender,receiver) counter. The A.6 HTTP transport has no such counter, so
// we detect replays with a short-lived seen-signature cache.
//
// KEY = the Signify-Signature header value. KERI/Ed25519 signatures are
// deterministic, so a byte-identical replayed request carries a byte-identical
// signature -> same key. (Signing the same canonical bytes with the same key
// always yields the same signature.)
//
// TTL = the staleness window (MAX_MESSAGE_AGE_MS, default 300_000ms, plus the
// future-skew allowance). A replay presented AFTER the entry expires would be
// older than the staleness horizon and is rejected by the middleware's
// timestamp check anyway, so the cache only needs to cover the live window.
// This bounds memory: entries self-expire.
//
// In-memory only (single process). A multi-instance deployment would need a
// shared store (e.g. Redis) keyed the same way; out of scope for Phase A.

export class DedupCache {
  /**
   * @param {{ttlMs?:number}} [opts] ttlMs defaults to 330_000 (300s age + 30s skew).
   */
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs ?? 330_000;
    /** @type {Map<string, number>} signature -> expiry epoch ms. */
    this.seen = new Map();
    this._lastPrune = 0;
    // Prune at most this often to keep checkAndRecord amortized O(1).
    this._pruneIntervalMs = Math.max(1_000, Math.floor(this.ttlMs / 10));
  }

  /**
   * Record a signature as seen. Returns true if it was ALREADY seen and still
   * within TTL (i.e. a replay); false if this is the first time (and records it).
   * @param {string} signature the Signify-Signature header value
   * @returns {boolean} true if replay
   */
  checkAndRecord(signature) {
    const now = Date.now();
    this._maybePrune(now);

    const existing = this.seen.get(signature);
    if (existing !== undefined && existing > now) {
      return true; // replay within the live window
    }
    this.seen.set(signature, now + this.ttlMs);
    return false;
  }

  /** Remove expired entries; cheap-guarded so it doesn't run every call. */
  _maybePrune(now) {
    if (now - this._lastPrune < this._pruneIntervalMs) return;
    this._lastPrune = now;
    for (const [sig, exp] of this.seen) {
      if (exp <= now) this.seen.delete(sig);
    }
  }

  /** Current entry count (post-lazy-prune; mainly for tests/metrics). */
  size() {
    return this.seen.size;
  }

  /** Drop all entries (tests). */
  clear() {
    this.seen.clear();
    this._lastPrune = 0;
  }
}
