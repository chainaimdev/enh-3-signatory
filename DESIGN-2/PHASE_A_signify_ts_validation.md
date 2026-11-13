# Phase A — signify-ts / KRAM Validation

**Goal:** Prove KERI per-message cryptographic signing works end-to-end between the existing buyer-agent and seller-agent **before** investing time in lifecycle modularization.

**Why this comes first:** signify-ts is the highest-novelty work in the whole project — new library, new crypto, new dependency surface. If it fails in your environment, you want to know on day 3, not day 17. KRAM is mostly DD-side and barely touches the lifecycle scripts, so it can be proven in isolation.

**Estimated effort:** ~5 dev-days
**Phase A produces:** A working KRAM round-trip between buyer-agent and seller-agent, plus server-side KRAM verification on one selected vLEI route. Existing 4D demo workflow still works untouched.

---

## Root Paths (verified on disk)

- **vLEI:** `C:\SATHYA\CHAINAIM3003\mcp-servers\vLEIEnh1\legentvLEI\`
- **DD:** `C:\SATHYA\CHAINAIM3003\mcp-servers\DynDic3ent1\A2A\js\`

---

## Non-Negotiable Quality Principles

These apply to every iteration. Do not violate them for shortcuts.

1. **No mocks in shipped code.** Test-only mocks live exclusively in `*.test.ts` / `*.test.js` files.
2. **No hardcoded values.** Every URL, key, alias, and path reads from `.env` or config JSON.
3. **No silent fallbacks.** Missing env var → throw at startup with clear message naming the variable.
4. **No skipped error handling.** Every shell-out captures exit code. Every `fetch()` checks status. Every `JSON.parse` is wrapped in try/catch.
5. **No new dependency without verification.** Before adding `signify-ts`, read the current published README/TypeDoc. Pin the exact version.
6. **Idempotency mandatory.** Every script can be run twice safely.
7. **Real KERIA, real witnesses, real Sally.** Every DoD involves an actual end-to-end transaction against the real local Docker stack.

---

## Phase A Iteration Roadmap

| # | Iteration | Hours | Cumulative |
|---|---|---|---|
| A.1 | Unblock `get_keria_alias` | 3–4 | 0.5 day |
| A.2 | DD env light-touch (C1 only) | 0.5 | 0.6 day |
| A.3 | One-time BRAN copy + .gitignore | 1 | 0.7 day |
| A.4 | signify-ts smoke + KramSigner skeleton | 6–8 | 1.7 days |
| A.5 | KramSigner full implementation | 12–14 | 3.5 days |
| A.6 | vLEI KRAM verify middleware + server wiring | 12–14 | 5.0 days |

**Sequential execution required.** Each iteration's test gate must pass before starting the next. Do not parallelize within Phase A.

---

# Iteration A.1 — Unblock `get_keria_alias`

**Time:** 3–4 hours
**Depends on:** Nothing
**Risk if skipped:** Any new company name breaks the existing 4D pipeline. Downstream lifecycle work (Phase B) is impossible without this.

## What you'll do
Replace the hardcoded `get_keria_alias` function in `generate-unique-agent-brans.sh`. The current function literally string-matches "Jupiter" and "Tommy" — anything else returns `unknownAgent`. The fix: read the alias from the config JSON, throw if not found.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| A.1.1 | READ FIRST | `…\legentvLEI\generate-unique-agent-brans.sh` | Find the current `get_keria_alias` function. Confirm it string-matches "Jupiter" and "Tommy" literally. |
| A.1.2 | READ | `…\legentvLEI\appconfig\configBuyerSellerAIAgent1-with-subdelegation.json` | Identify whether a usable lookup key already exists per company entry. Likely needs an explicit `keriaAlias` field. |
| A.1.3 | MODIFY | `…\legentvLEI\generate-unique-agent-brans.sh` | Replace `get_keria_alias`. New version: takes org name, reads config JSON via `jq`, returns alias. Throws (NOT "unknownAgent") if no match. Add header comment naming the bug fixed. |
| A.1.4 | MAYBE MODIFY | `…\legentvLEI\appconfig\configBuyerSellerAIAgent1-with-subdelegation.json` | If A.1.2 confirmed no usable field exists, add explicit `keriaAlias` field per company entry. Only change schema if required. |

## Definition of Done

- [ ] `get_keria_alias` no longer string-matches "Jupiter" or "Tommy" anywhere in its body.
- [ ] Function reads from config JSON via `jq` or equivalent.
- [ ] Function throws (exits non-zero) if no match found — never returns "unknownAgent".
- [ ] Added a 3rd test company entry to config (e.g. `Acme_Corp` with a valid LEI).
- [ ] Ran `./run-all-buyerseller-4D-with-subdelegation.sh` — all 3 companies get distinct valid aliases.
- [ ] `grep -r "unknownAgent" task-data/` returns nothing.
- [ ] Existing Jupiter and Tommy flows complete with identical BRAN values, AIDs, and credential chains (no regression).

## Test gate

```bash
cd C:\SATHYA\CHAINAIM3003\mcp-servers\vLEIEnh1\legentvLEI

# Confirm the bug body is gone
grep -n "Jupiter\|Tommy" generate-unique-agent-brans.sh
# Should appear only in config references / comments, not in function logic

# Run with 3 companies in config
./run-all-buyerseller-4D-with-subdelegation.sh

# Verify all 3 BRANs created
ls task-data/*-bran.txt
# Should show 3 distinct files

# Verify no unknownAgent slipped through
grep -l "unknownAgent" task-data/
# → nothing
```

**⚠️ STOP. Verify the test gate before starting A.2.**

---

# Iteration A.2 — DD env light-touch (C1 only)

**Time:** 30 minutes
**Depends on:** A.1 complete

## What you'll do
Add the `VLEI_API_BASE_URL` env var to both DD agent `.env` files. The Bearer-header part (C2 from original plan) is deferred to Phase B — KRAM does not need it yet.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| A.2.1 | MODIFY | `…\DynDic3ent1\A2A\js\src\agents\buyer-agent\.env` | Add `VLEI_API_BASE_URL=http://localhost:4000`. Add `# VLEI_API_KEY_AGENT=` (commented, with graduation comment explaining it will be uncommented in Phase B). |
| A.2.2 | MODIFY | `…\DynDic3ent1\A2A\js\src\agents\seller-agent\.env` | Same as A.2.1. |

## Definition of Done

- [ ] Both `.env` files contain `VLEI_API_BASE_URL` uncommented.
- [ ] Both contain `VLEI_API_KEY_AGENT` commented out with explanatory note.
- [ ] Existing buyer↔seller negotiation still works (no regression — this is a passive env add).

## Test gate

```bash
cd C:\SATHYA\CHAINAIM3003\mcp-servers\DynDic3ent1\A2A\js
./run-all-agents.sh
# Existing negotiation runs to completion — sanity check
```

**⚠️ STOP. Verify the test gate before starting A.3.**

---

# Iteration A.3 — One-time BRAN copy + .gitignore

**Time:** 1 hour
**Depends on:** A.1 complete (Jupiter/Tommy BRANs must exist in vLEI `task-data/`)

**Note:** This is a **throwaway step that exists only in Phase A**. `manage-agent.sh` in B.6 replaces it with an automatic dual-write. The script you write here will be deleted in B.6.3.

## What you'll do
Write a one-shot script that copies existing BRANs from the vLEI `task-data/` directory to DD-local `.secret/` folders, with locked-down permissions. This makes BRANs available to the DD agent processes for `KramSigner` to read.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| A.3.1 | NEW | `…\vLEIEnh1\legentvLEI\copy-brans-to-dd-local.sh` | One-time helper. Reads BRAN file paths from `task-data/`, computes mapping to DD agent folders, copies to `.secret/agent-bran.txt`, sets perms 600. Idempotent: skips if destination matches source byte-for-byte. **Header comment explicitly states the script will be deleted in Phase B (B.6.3).** |
| A.3.2 | NEW DIR (created by script) | `…\DynDic3ent1\A2A\js\src\agents\buyer-agent\.secret\` | Auto-created. |
| A.3.3 | NEW DIR (created by script) | `…\DynDic3ent1\A2A\js\src\agents\seller-agent\.secret\` | Auto-created. |
| A.3.4 | MODIFY | `…\DynDic3ent1\A2A\js\.gitignore` | Add `**/.secret/` so BRAN files never get committed. Verify file isn't currently tracked first (`git ls-files \| grep secret`). |

## Definition of Done

- [ ] `./copy-brans-to-dd-local.sh` runs successfully after a fresh 4D pipeline.
- [ ] `cmp` confirms byte-equal: vLEI source BRAN ↔ DD destination BRAN for both buyer and seller.
- [ ] On Linux/WSL the destination files have perms 600. On Windows, ACL restricts to current user.
- [ ] Re-running the script is a no-op (prints "no changes needed", exits 0).
- [ ] `git status --ignored` shows `.secret/` as ignored.
- [ ] No `.secret/` files appear as untracked or staged.

## Test gate

```bash
cd C:\SATHYA\CHAINAIM3003\mcp-servers\vLEIEnh1\legentvLEI
./copy-brans-to-dd-local.sh

# Byte equality
cmp task-data/tommyBuyerAgent-bran.txt \
    C:/SATHYA/CHAINAIM3003/mcp-servers/DynDic3ent1/A2A/js/src/agents/buyer-agent/.secret/agent-bran.txt
# Exit code 0

cmp task-data/jupiterSellerAgent-bran.txt \
    C:/SATHYA/CHAINAIM3003/mcp-servers/DynDic3ent1/A2A/js/src/agents/seller-agent/.secret/agent-bran.txt
# Exit code 0

# Permissions check (WSL/Linux)
ls -la C:/SATHYA/CHAINAIM3003/mcp-servers/DynDic3ent1/A2A/js/src/agents/buyer-agent/.secret/
# perms = 600 (rw-------)

# Idempotency
./copy-brans-to-dd-local.sh
# Output: "no changes needed", exit 0

# gitignore check
cd C:/SATHYA/CHAINAIM3003/mcp-servers/DynDic3ent1/A2A/js
git status --ignored | grep .secret
# Shows .secret/ as ignored, not as untracked
```

**⚠️ STOP. Verify the test gate before starting A.4.**

---

# Iteration A.4 — signify-ts smoke + KramSigner skeleton

**Time:** 6–8 hours
**Depends on:** A.3 (BRAN files exist at DD-local paths)

**Critical risk callout:** If `signify-ts` does not import cleanly in your Node version, OR if the smoke script in A.4.4 fails, **STOP HERE and reassess**. Do NOT push through with workarounds. The fallback is to revert to the original plan ordering (lifecycle first, KRAM later). Spending 12 more hours on KramSigner against a broken signify-ts wastes Phase A.

## What you'll do
Three things, in this order:
1. Verify the current `signify-ts` version + API surface (A.4.1).
2. Install it and run a smoke script that proves the library works against your existing Tommy BRAN (A.4.2 + A.4.4).
3. Write the KramSigner skeleton — class structure, factory case, type extensions — but with `seal()` and `verify()` throwing "not implemented". Real implementation comes in A.5.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| A.4.1 | READ FIRST | https://www.npmjs.com/package/signify-ts | Verify the current published version. **Read the README and TypeDoc.** Confirm `Authenticater`, `SignifyClient`, `Signer`, `Verfer` are all exported. Document which signing API to use (`client.manager.get(aid).signers[0].sign(bytes)` vs. higher-level helper) — this is the one piece of unknown territory in Phase A. |
| A.4.2 | MODIFY | `…\DynDic3ent1\A2A\js\package.json` | Pin `signify-ts` to the exact version from A.4.1 (no `^` or `~`). Run `npm install`. |
| A.4.3 | REGEN | `…\DynDic3ent1\A2A\js\package-lock.json` | Regenerated by npm. Commit. |
| A.4.4 | NEW | `…\DynDic3ent1\A2A\js\src\messaging\__smoke__\signify-import-smoke.ts` | **The critical smoke script.** Steps: (1) `await ready()` to load WASM. (2) Print `typeof Authenticater`, `typeof SignifyClient`. (3) Read Tommy BRAN from `.secret/agent-bran.txt`. (4) Call `getOrCreateClient(bran, 'docker')`. (5) `client.identifiers().get('tommyBuyerAgent')` — verify prefix matches expected `EG3fWw-6lu5g_PouB-2QrQdtIfbJOvutBA3xXmOCVA_v`. (6) Reach into the signing API discovered in A.4.1 — confirm a `Signer` object is accessible. Throwaway file but committed for next dev. |
| A.4.5 | MODIFY | `…\src\messaging\signed-message.ts` | Extend `SigningMode` type union to include `"kram"`. Add three new failure-reason enum entries: `KRAM_SIGNATURE_INVALID`, `KRAM_TIMESTAMP_STALE`, `KRAM_REPLAY_DETECTED`. |
| A.4.6 | NEW | `…\src\messaging\KramSigner.ts` | Class implementing the `MessageSigner` interface. Constructor: reads BRAN from `.secret/agent-bran.txt` (path resolved via `__dirname` or env var `AGENT_BRAN_PATH`). Calls `getOrCreateClient(bran, env)` to get a `SignifyClient`. Both `seal()` and `verify()` throw `Error('KramSigner not yet implemented — A.5')`. Constructor must throw clearly if BRAN file is missing. |
| A.4.7 | MODIFY | `…\src\messaging\index.ts` | Factory function: add `case "kram": return new KramSigner(config);` to the switch. Existing `"plain"` and other cases unchanged. |

## Definition of Done

- [ ] A.4.1 documented: which signify-ts version, which signing API to call.
- [ ] `signify-ts` version pinned in `package.json` (no `^` or `~`).
- [ ] `npm install` succeeds with no warnings about missing peer deps.
- [ ] Running `npx tsx src/messaging/__smoke__/signify-import-smoke.ts` exits 0 and prints:
  - "WASM loaded ✓"
  - "Authenticater is a function"
  - "Connected. Controller: <some AID>"
  - "AID prefix matches expected ✓"
- [ ] `tsc --noEmit` passes on the entire DD codebase (no new TS errors introduced).
- [ ] Setting `SIGNING_MODE=kram` and starting buyer-agent constructs a `KramSigner` instance without crashing during construction. (It WILL throw on first message send — expected; A.5 fixes this.)
- [ ] `KramSigner` constructor throws with clear error message if BRAN file is missing or unreadable.

## Test gate

```bash
cd C:\SATHYA\CHAINAIM3003\mcp-servers\DynDic3ent1\A2A\js

# Install
npm install

# Type-check the whole codebase
npx tsc --noEmit

# The smoke — this is THE de-risk moment of Phase A
npx tsx src/messaging/__smoke__/signify-import-smoke.ts
# Expected output:
#   Step 1: ready()... ✓ WASM loaded
#   Step 2: API surface... Authenticater: function, SignifyClient: function
#   Step 3: reading BRAN... BRAN length: 21
#   Step 4: connect to KERIA... ✓ Connected. Controller: <prefix>
#   Step 5: lookup AID... AID prefix: EG3fWw-6lu5g_PouB-2QrQdtIfbJOvutBA3xXmOCVA_v ✓
#   Step 6: signing API located ✓

# Construction smoke
SIGNING_MODE=kram node -e "
  const { createSigner } = require('./dist/messaging');
  const s = createSigner({ mode: 'kram', branPath: '/path/to/.secret/agent-bran.txt', env: 'docker' });
  console.log('Constructed:', s.constructor.name);
"
# → "Constructed: KramSigner"

# Negative path
SIGNING_MODE=kram node -e "
  const { createSigner } = require('./dist/messaging');
  createSigner({ mode: 'kram', branPath: '/no/such/file', env: 'docker' });
"
# → Throws "BRAN file not found: /no/such/file"
```

**⚠️ STOP. If smoke fails: do NOT proceed to A.5. Debug WASM, API surface, or KERIA connectivity first. Verify the test gate before starting A.5.**

---

# Iteration A.5 — KramSigner full implementation

**Time:** 12–14 hours (the substantive crypto work of Phase A)
**Depends on:** A.4 complete and smoke green

**No-mocks rule applies hard here.** Real KERI signatures, real witnesses, real OOBI exchanges. Mocks may exist only in `__tests__/KramSigner.test.ts` and only for time (to test staleness) and the network layer (to inject tampered bodies).

## What you'll do
Implement `seal()` and `verify()` in `KramSigner.ts`. Implement the dedup cache and OOBI resolver helpers. Write the round-trip test that proves buyer→seller signed-message verification works end-to-end.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| A.5.1 | EXTEND | `…\src\messaging\KramSigner.ts` | Implement `seal(message, recipient)`. Steps: (1) Compute SHA-256 body digest per RFC 9530 → `Content-Digest` header. (2) Build `Signify-Resource: <sender-AID>` and `Signify-Timestamp: <ISO8601-now>`. (3) Build the canonical signing string per the KRAM spec (resource + timestamp + digest). (4) Call signify-ts signing API discovered in A.4.1 over the signing string bytes. (5) Serialize all 4 headers (`Content-Digest`, `Signify-Resource`, `Signify-Timestamp`, `Signify-Signature`) into the `SignedEnvelope` return. |
| A.5.2 | EXTEND | `…\src\messaging\KramSigner.ts` | Implement `verify(envelope)`. Steps: (1) Parse all 4 headers — throw `KRAM_SIGNATURE_INVALID` if any missing. (2) Check timestamp within 30-second window — else `KRAM_TIMESTAMP_STALE`. (3) Check `(sender-AID + timestamp + digest)` not in dedup cache — else `KRAM_REPLAY_DETECTED`. (4) Resolve sender's KEL via OOBI cache (lazy fetch). (5) Get sender's current verifier key via `client.keyStates().query()`. (6) Verify the signature using `Verfer` — else `KRAM_SIGNATURE_INVALID`. (7) Recompute body digest and compare — else `KRAM_SIGNATURE_INVALID` (digest mismatch case). (8) Add to dedup cache. |
| A.5.3 | NEW | `…\src\messaging\kram-internal\dedup-cache.ts` | LRU/TTL cache for replay protection. 30-second TTL window. Unit-tested in isolation. |
| A.5.4 | NEW | `…\src\messaging\kram-internal\oobi-resolver.ts` | Resolves a sender's KEL by OOBI URL using existing `signify-ts` `client.oobis().resolve()` and `client.keyStates().query()` patterns. In-memory cache. Does NOT reimplement OOBI resolution. |
| A.5.5 | NEW | `…\src\messaging\__tests__\KramSigner.test.ts` | Real round-trip tests using real Tommy + Jupiter BRANs against the real local KERIA. Tests: (a) buyer signs, seller verifies — round-trip success; (b) tampered body fails verify with `KRAM_SIGNATURE_INVALID`; (c) stale timestamp (35s old) fails with `KRAM_TIMESTAMP_STALE`; (d) replay within 30s fails with `KRAM_REPLAY_DETECTED`. Time mocked only for (c); network injection only for (b). No mocks of signify-ts. |

## Definition of Done

- [ ] Unit test in A.5.5: all 4 tests pass with real signify-ts and real BRANs.
- [ ] Live demo: `SIGNING_MODE=kram` on both buyer and seller agents → existing negotiation completes successfully. Logs on both sides show "kram seal ok" / "kram verify ok".
- [ ] Regression check: `SIGNING_MODE=plain` still uses existing `PlainHashSigner` path with no behavior change.
- [ ] `grep -n "mock\|stub\|fake" src/messaging/KramSigner.ts` returns nothing (production code has no mocks).
- [ ] Tampering body in transit (verified manually via proxy or test injection) produces `KRAM_SIGNATURE_INVALID`.
- [ ] Replay attempt → second receipt rejected.

## Test gate

```bash
cd C:\SATHYA\CHAINAIM3003\mcp-servers\DynDic3ent1\A2A\js

# Unit tests (4 tests, all passing)
npm test src/messaging/__tests__/KramSigner.test.ts

# Live round-trip
SIGNING_MODE=kram ./run-all-agents.sh
# buyer-agent log: "kram seal ok, sig=<cesr-prefix>..."
# seller-agent log: "kram verify ok, sender=EG3fWw-6lu5g_..."
# Negotiation runs to completion

# Regression
SIGNING_MODE=plain ./run-all-agents.sh
# Same negotiation works using existing PlainHashSigner

# No mocks in prod code
grep -ni "mock\|stub\|fake" src/messaging/KramSigner.ts src/messaging/kram-internal/
# (output should be empty or only show comments referencing the test files)
```

**⚠️ STOP. Verify the test gate before starting A.6.**

---

# Iteration A.6 — vLEI KRAM verify middleware

**Time:** 12–14 hours
**Depends on:** A.5 complete (so the DD side can produce real KRAM-signed requests)

## What you'll do
Build the server-side equivalent of `KramSigner.verify()` as Express middleware. Wire raw-body capture into `server.js`. Add the middleware to ONE test route (`/api/buyer/verify/ext/seller`) gated by a `KRAM_REQUIRED` env var.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| A.6.1 | NEW DIR | `…\vLEIEnh1\legentvLEI\api-server\lib\` | Create the `lib/` directory (first use of it in this reordered plan). |
| A.6.2 | NEW | `…\api-server\lib\kram-verify-middleware.js` | Express middleware factory. Exports `kramVerify(options)`. Implementation mirrors `KramSigner.verify()` from A.5.2: parse headers, staleness check, dedup, KEL resolution via OOBI, sig verify, body digest verify. On failure, respond 401 with `{ error: "KRAM_*", detail: "..." }`. Uses signify-ts on the server side too. |
| A.6.3 | NEW | `…\api-server\lib\kram-internal\dedup-cache.js` | Server-side dedup cache. Same TTL semantics as A.5.3. |
| A.6.4 | NEW | `…\api-server\lib\kram-internal\oobi-resolver.js` | Server-side KEL resolution. Calls local KERIA via signify-ts client. |
| A.6.5 | MODIFY | `…\api-server\server.js` | (a) Insert `express.raw({ type: '*/*' })` body capture BEFORE `express.json()` for routes that need digest verification. Store raw body on `req.rawBody`. (b) Add the `kramVerify()` middleware to ONE test route: `POST /api/buyer/verify/ext/seller` gets optional KRAM verification when `KRAM_REQUIRED=true` env var is set. Default: KRAM optional (verify if headers present, ignore if absent). |
| A.6.6 | NEW | `…\api-server\test\kram-verify-middleware.test.js` | Integration tests: real DD-side request via `KramSigner.seal()` → server verifies via middleware. Tampered body → 401 + `KRAM_SIGNATURE_INVALID`. Stale timestamp → 401 + `KRAM_TIMESTAMP_STALE`. Replay → 401 + `KRAM_REPLAY_DETECTED`. |

## Definition of Done — **PHASE A FINAL GATE**

- [ ] vLEI server starts cleanly with the new middleware imported (whether `KRAM_REQUIRED=true` or `false`).
- [ ] DD buyer in `SIGNING_MODE=kram` calls `/api/buyer/verify/ext/seller` → vLEI server logs `kram verify ok` and returns the expected verification result.
- [ ] Tampering the body via a proxy → vLEI server returns 401 with `KRAM_SIGNATURE_INVALID`.
- [ ] Timestamp >30s old → 401 with `KRAM_TIMESTAMP_STALE`.
- [ ] Same envelope replayed within 30s → second attempt 401 with `KRAM_REPLAY_DETECTED`.
- [ ] Existing endpoints (not protected by `kramVerify()`) work unchanged.
- [ ] Existing Jupiter↔Tommy demo workflow runs end-to-end with `SIGNING_MODE=kram` on DD and `KRAM_REQUIRED=true` on server.
- [ ] Existing Jupiter↔Tommy demo workflow ALSO runs end-to-end with `SIGNING_MODE=plain` on DD and `KRAM_REQUIRED=false` on server (no regression).

## Test gate

```bash
# Start server with KRAM required
cd C:\SATHYA\CHAINAIM3003\mcp-servers\vLEIEnh1\legentvLEI
KRAM_REQUIRED=true node api-server/server.js &

# Server-side integration tests
cd api-server && npm test test/kram-verify-middleware.test.js
# All passing

# End-to-end: DD signs, vLEI verifies
cd C:\SATHYA\CHAINAIM3003\mcp-servers\DynDic3ent1\A2A\js
SIGNING_MODE=kram ./run-all-agents.sh
# Server logs: "kram verify ok, sender=EAabc..."
# /api/buyer/verify/ext/seller returns 200 with verification result

# Regression: non-KRAM route unaffected
curl http://localhost:4000/api/buyer/status
# Returns as before

# Regression: KRAM-optional mode
KRAM_REQUIRED=false node api-server/server.js
SIGNING_MODE=plain ./run-all-agents.sh
# Existing flow works
```

---

# ✅ PHASE A COMPLETE

When all six iterations' test gates pass, you have:

- **Working `signify-ts` integration** in the DD codebase.
- **Round-trip cryptographic per-message non-repudiation** between buyer-agent and seller-agent.
- **Server-side KRAM verification** for one selected vLEI route.
- **Three failure modes proven to reject correctly:** tampered body, stale timestamp, replay.
- **Existing 4D demo workflow still works unchanged** (no regression).
- **Both `SIGNING_MODE=plain` and `SIGNING_MODE=kram`** are valid configurations.

You can now confidently proceed to Phase B (lifecycle modularization + REST endpoints + auth scaffold). The highest-novelty work is behind you.

---

## Open Decisions Carried Forward to Phase B

1. **npm vs pnpm on DD side.** Your `package-lock.json` is npm. Phase A used npm. Phase B continues with npm unless you decide otherwise before B.1.
2. **`_patch_handleBuyerCounterOffer.ts` in seller-agent.** Not referenced in any design doc. Phase B.3 will read it once and document whether it contains a vLEI fetch site.
