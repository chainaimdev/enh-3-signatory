# Phase C — MCP Discoverability (Optional / Later)

**Goal:** Add LLM-accessible interface so Claude (or any MCP-compatible client) can drive the vLEI system through natural language. Catalog endpoints, search them, call them with guards.

**Prerequisite:** Phase B complete. System is already fully shippable without Phase C. Defer this until you actually need LLM access.

**Estimated effort:** ~4–5 dev-days
**Phase C produces:** The `mcp-vlei` TypeScript subproject with two MCP tools (`vlei_search_endpoints`, `vlei_call_endpoint`), a public catalog at `/llms.txt`, a CI drift test, and full closure of the 11-box Phase 1 Done checklist from `IMPLEMENTATION_PLAN.md`.

---

## Root Paths

- **vLEI:** `C:\SATHYA\CHAINAIM3003\mcp-servers\vLEIEnh1\legentvLEI\`
- **MCP project (new):** `C:\SATHYA\CHAINAIM3003\mcp-servers\vLEIEnh1\mcp-vlei\`

---

## Non-Negotiable Quality Principles

Same as Phases A and B:

1. **No mocks in shipped code.**
2. **No hardcoded values.** Everything from env or catalog.
3. **No silent fallbacks.** Missing env → throw at startup.
4. **No skipped error handling.**
5. **No new dependency without verification.** `@modelcontextprotocol/sdk` version must be confirmed against current docs.
6. **Idempotency mandatory.**
7. **Real vLEI server, real KERIA.** No stubbed responses.

## Cross-Cutting MCP Rules

- **State-change guard mandatory.** Any catalog entry with `stateChanging: true` cannot be invoked without `confirm_state_change: true` parameter from the caller.
- **Path allowlist.** Only paths present in `vlei-llms.txt` are callable. Path traversal (`/api/../`) rejected.
- **Error category prefixes.** All errors propagated to Claude with `[AUTH]`, `[NOT_FOUND]`, `[STATE_CHANGE_GUARD]`, etc. so Claude can reason about failures.
- **No silent endpoint additions.** Adding a route to `server.js` without a catalog entry → CI fails (drift test).

---

## Phase C Iteration Roadmap

| # | Iteration | Hours | Cumulative |
|---|---|---|---|
| C.1 | `vlei-llms.txt` catalog + drift test | 6–8 | 1 day |
| C.2 | `mcp-vlei` project scaffold | 4–5 | 1.6 days |
| C.3 | Catalog parser + EndpointIndex | 4–6 | 2.3 days |
| C.4 | `vlei_search_endpoints` tool | 4–5 | 3 days |
| C.5 | `vlei_call_endpoint` tool with guards | 6–8 | 4 days |
| C.6 | MCP graduation + close 11-box checklist | 4 | 4.5 days |

Sequential execution required.

---

# Iteration C.1 — Catalog + drift test

**Time:** 6–8 hours
**Depends on:** Phase B complete (all 20 endpoints exist and are role-gated)

## What you'll do
Author the markdown catalog that documents every non-deprecated endpoint. Build the parser. Wire `GET /llms.txt` as a public route. Add a CI test that fails on drift between catalog and `server.js`.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| C.1.1 | NEW | `…\api-server\vlei-llms.txt` | Markdown catalog. One section per route. Fields per section: `path`, `method`, `description`, `minimumRole`, `stateChanging` boolean, body schema (JSON), response sample (JSON). Covers all existing endpoints + 5 lifecycle endpoints + `/llms.txt` itself. Legacy `/api/verify/*` excluded. |
| C.1.2 | NEW | `…\api-server\lib\catalog-loader.js` | Markdown parser. Pure function. Used by both `server.js` (to serve `/llms.txt`) and `catalog-drift.test.js` (to compare against routes). |
| C.1.3 | MODIFY | `…\api-server\server.js` | Add `GET /llms.txt` route. No auth — public. Serves the markdown file using `catalog-loader.js`. |
| C.1.4 | NEW | `…\api-server\test\catalog-drift.test.js` | CI test. Parses both `vlei-llms.txt` (via catalog-loader) and `server.js` (via AST or regex over Express route registrations). Fails if any non-deprecated route in `server.js` lacks a catalog entry. Fails if catalog entry exists for a non-existent route. |

## Definition of Done

- [ ] `curl http://localhost:4000/llms.txt` returns catalog markdown.
- [ ] Catalog covers all existing endpoints + 5 lifecycle endpoints (POST/DELETE company, officer, agent, sub-agent, GET status).
- [ ] Legacy `/api/verify/*` endpoints intentionally absent from catalog.
- [ ] Each catalog entry has: `path`, `method`, `description`, `minimumRole`, `stateChanging`, `bodySchema`, `responseSample`.
- [ ] Drift test passes today (all routes have entries, no orphan entries).
- [ ] Adding a fake route to `server.js` without a catalog entry → CI fails clearly naming the missing route.
- [ ] Adding a fake entry for a non-existent route → CI fails.

## Test gate

```bash
# Serve catalog
curl -s http://localhost:4000/llms.txt | head -100
# Markdown content visible

# Drift test passing
cd api-server && npm test test/catalog-drift.test.js
# All passing

# Negative: add fake route to server.js without catalog entry
# (e.g. app.get('/api/fake', ...) somewhere)
npm test test/catalog-drift.test.js
# Fails with "route /api/fake has no catalog entry"

# Restore: add entry to catalog
npm test test/catalog-drift.test.js
# Passes again

# Revert the fake route + entry
```

**⚠️ STOP. Verify the test gate before starting C.2.**

---

# Iteration C.2 — `mcp-vlei` project scaffold

**Time:** 4–5 hours
**Depends on:** C.1

## What you'll do
Create the brand-new TypeScript subproject. Pin the MCP SDK version after verifying against the current docs. Write a placeholder `server.ts` that the next iterations fill in.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| C.2.1 | READ FIRST | https://github.com/modelcontextprotocol/typescript-sdk | Confirm the current published version of `@modelcontextprotocol/sdk`. Read the README for the current tool-registration API surface. Document which version is being pinned and why. |
| C.2.2 | NEW DIR | `…\vLEIEnh1\mcp-vlei\` | New TypeScript subproject root. |
| C.2.3 | NEW | `…\mcp-vlei\package.json` | Pin `@modelcontextprotocol/sdk` (exact version from C.2.1, no `^`/`~`). Pin `undici`, `tsx`, `typescript`. |
| C.2.4 | NEW | `…\mcp-vlei\tsconfig.json` | Strict mode TypeScript config. Target ES2022. |
| C.2.5 | NEW | `…\mcp-vlei\.env.example` | `VLEI_API_BASE_URL=http://localhost:4000`. `# VLEI_API_KEY=` (commented). |
| C.2.6 | NEW | `…\mcp-vlei\README.md` | Setup instructions, env vars, how to run with MCP Inspector, how to connect from Claude. |
| C.2.7 | NEW | `…\mcp-vlei\src\server.ts` | MCP server boilerplate. Imports SDK, sets up a Server instance, registers a placeholder tool list (empty initially). Tools filled in C.4 and C.5. |

## Definition of Done

- [ ] C.2.1 documented: which version pinned, link to README confirming API.
- [ ] `cd mcp-vlei && npm install` succeeds with no peer-dep warnings.
- [ ] `npm run dev` (or `tsx src/server.ts`) starts placeholder and exits cleanly on Ctrl-C.
- [ ] README documents env vars + how to invoke MCP Inspector.
- [ ] SDK version is pinned (no `^` or `~`).
- [ ] `tsc --noEmit` passes.

## Test gate

```bash
cd C:/SATHYA/CHAINAIM3003/mcp-servers/vLEIEnh1/mcp-vlei
npm install
npx tsc --noEmit
npm run dev
# Runs placeholder MCP server, no errors
# Ctrl-C to stop
```

**⚠️ STOP. Verify the test gate before starting C.3.**

---

# Iteration C.3 — Catalog parser + EndpointIndex

**Time:** 4–6 hours
**Depends on:** C.2

## What you'll do
Write the markdown-to-typed-spec parser. Build the `EndpointIndex` class that loads the catalog from the live vLEI server at startup and provides search/lookup/allowlist methods.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| C.3.1 | NEW | `…\mcp-vlei\src\catalog\parser.ts` | Parses `vlei-llms.txt` markdown into `EndpointSpec[]`. Pure function. Same logic as server-side `catalog-loader.js` but in TypeScript. |
| C.3.2 | NEW | `…\mcp-vlei\src\catalog\index.ts` | `EndpointIndex` class. Methods: `static load(baseUrl)` (async — fetches `/llms.txt` and parses), `search(query, opts)` (returns ranked matches), `isPathAllowed(path)` (boolean), `getSpec(path)` (returns EndpointSpec or undefined). |
| C.3.3 | NEW | `…\mcp-vlei\src\catalog\__tests__\parser.test.ts` | Feeds a snapshot of `vlei-llms.txt` to parser. Asserts populated array with expected fields. Tests edge cases (missing optional fields, malformed sections). |

## Definition of Done

- [ ] Parser unit tests pass.
- [ ] `EndpointIndex.search("verify seller")` returns at least one match.
- [ ] `isPathAllowed("/api/buyer/verify/ext/seller")` → `true`.
- [ ] `isPathAllowed("/api/../etc/passwd")` → `false`.
- [ ] `isPathAllowed("/api/nonexistent")` → `false`.
- [ ] Startup with vLEI server down → `EndpointIndex.load()` throws clearly (do NOT fail silently with empty catalog).
- [ ] `getSpec("/api/lifecycle/company")` returns spec with `stateChanging: true`.
- [ ] `getSpec("/api/lifecycle/status")` returns spec with `stateChanging: false`.

## Test gate

```bash
cd mcp-vlei
npx tsc --noEmit
npm test src/catalog/__tests__/parser.test.ts
# Passing

# Live load against running vLEI server
node -e "
  const { EndpointIndex } = require('./dist/catalog');
  EndpointIndex.load('http://localhost:4000').then(i => {
    console.log('search verify:', i.search('verify seller').length, 'matches');
    console.log('allowed status:', i.isPathAllowed('/api/lifecycle/status'));
    console.log('blocked traversal:', i.isPathAllowed('/api/../etc/passwd'));
    console.log('company stateChanging:', i.getSpec('/api/lifecycle/company').stateChanging);
  });
"
# Expected output:
#   search verify: <n> matches
#   allowed status: true
#   blocked traversal: false
#   company stateChanging: true
```

**⚠️ STOP. Verify the test gate before starting C.4.**

---

# Iteration C.4 — `vlei_search_endpoints` tool

**Time:** 4–5 hours
**Depends on:** C.3

## What you'll do
Wire up the first MCP tool. Lets Claude (or any MCP client) search the catalog with three detail levels.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| C.4.1 | NEW | `…\mcp-vlei\src\tools\search-endpoints.ts` | MCP tool. Input schema: `{ query: string, detail?: 'brief'\|'more'\|'verbose', max_results?: number }`. Output: ranked matches from `EndpointIndex.search()`. Detail levels: `brief` (path + method + description), `more` (adds body schema), `verbose` (adds response sample). |
| C.4.2 | MODIFY | `…\mcp-vlei\src\server.ts` | Register `vlei_search_endpoints` tool with the MCP server. |

## Definition of Done

- [ ] `npx @modelcontextprotocol/inspector tsx src/server.ts` opens the MCP Inspector UI.
- [ ] In Inspector, calling `vlei_search_endpoints { "query": "verify seller" }` returns sensible matches.
- [ ] Detail level `brief` returns only path/method/description.
- [ ] Detail level `more` includes body schema.
- [ ] Detail level `verbose` includes response sample.
- [ ] `max_results` limit respected.

## Test gate

```bash
cd mcp-vlei
npx @modelcontextprotocol/inspector tsx src/server.ts

# In inspector UI:
#   Call vlei_search_endpoints { "query": "lifecycle company" }
#   → Returns POST and DELETE /api/lifecycle/company entries
#
#   Call vlei_search_endpoints { "query": "verify seller", "detail": "verbose" }
#   → Returns matches with full response samples
#
#   Call vlei_search_endpoints { "query": "anything", "max_results": 1 }
#   → Returns at most 1 result
```

**⚠️ STOP. Verify the test gate before starting C.5.**

---

# Iteration C.5 — `vlei_call_endpoint` tool with guards

**Time:** 6–8 hours
**Depends on:** C.4

## What you'll do
The second and most important MCP tool. Lets Claude actually invoke vLEI endpoints — but with three layers of safety: path allowlist, body schema validation, state-change guard.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| C.5.1 | NEW | `…\mcp-vlei\src\env.ts` | Loads and validates env vars (`VLEI_API_BASE_URL` required, `VLEI_API_KEY` optional). Throws clearly on missing required. |
| C.5.2 | NEW | `…\mcp-vlei\src\http-client.ts` | `undici`-based HTTP wrapper. Attaches `Authorization: Bearer ${VLEI_API_KEY}` if set. Maps HTTP errors to category-prefixed `Error`: 401/403 → `[AUTH]`, 404 → `[NOT_FOUND]`, 400 → `[VALIDATION]`, 5xx → `[SERVER_ERROR]`. |
| C.5.3 | NEW | `…\mcp-vlei\src\tools\call-endpoint.ts` | MCP tool. Input: `{ path: string, method?: string, body?: object, params?: object, confirm_state_change?: boolean }`. (1) Validates `path` via `EndpointIndex.isPathAllowed` — else `[NOT_FOUND]`. (2) Validates body against catalog body schema — else `[VALIDATION]`. (3) **State-change guard**: if `EndpointIndex.getSpec(path).stateChanging === true` and `confirm_state_change !== true`, reject with `Error [STATE_CHANGE_GUARD]`. (4) Calls vLEI via http-client. Returns response. |
| C.5.4 | MODIFY | `…\mcp-vlei\src\server.ts` | Register `vlei_call_endpoint` tool with the MCP server. |

## Definition of Done

- [ ] Inspector: calling a viewer-role endpoint succeeds (with valid Bearer set).
- [ ] State-changing endpoint without `confirm_state_change: true` → `Error [STATE_CHANGE_GUARD]`.
- [ ] State-changing endpoint with `confirm_state_change: true` → succeeds (201 created).
- [ ] Path not in catalog → `Error [NOT_FOUND]`.
- [ ] Path traversal attempt (`/api/../etc/passwd`) → `Error [NOT_FOUND]`.
- [ ] Wrong/missing Bearer when server in `AUTH_MODE=api_key` → `Error [AUTH]`.
- [ ] Invalid body schema → `Error [VALIDATION]`.
- [ ] State-change against the server actually creates the entity (verifiable via `./manage-status.sh`).

## Test gate

```bash
# Set up env
cd mcp-vlei
cp .env.example .env
# Edit .env: set VLEI_API_BASE_URL and VLEI_API_KEY to operator key

npx @modelcontextprotocol/inspector tsx src/server.ts

# Read-only call
#   vlei_call_endpoint { "path": "/api/lifecycle/status" }
#   → Returns JSON tree

# State-change without confirm (should reject)
#   vlei_call_endpoint {
#     "path": "/api/lifecycle/company",
#     "method": "POST",
#     "body": {"id":"beta","name":"Beta Corp","lei":"...","alias":"Beta_Corp"}
#   }
#   → Error [STATE_CHANGE_GUARD]

# State-change with confirm (should succeed)
#   vlei_call_endpoint {
#     "path": "/api/lifecycle/company",
#     "method": "POST",
#     "body": {"id":"beta","name":"Beta Corp","lei":"...","alias":"Beta_Corp"},
#     "confirm_state_change": true
#   }
#   → 201 created

./manage-status.sh
# Shows Beta_Corp (created via MCP)

# Path traversal
#   vlei_call_endpoint { "path": "/api/../etc/passwd" }
#   → Error [NOT_FOUND]

# Bad Bearer (set VLEI_API_KEY to garbage, restart MCP)
#   vlei_call_endpoint { "path": "/api/lifecycle/status" }
#   → Error [AUTH]
```

**⚠️ STOP. Verify the test gate before starting C.6.**

---

# Iteration C.6 — MCP graduation + close 11-box checklist

**Time:** 4 hours
**Depends on:** C.5

## What you'll do
Connect Claude to the MCP server. Run the full smoke that closes out the four 11-box checklist items deferred from Phase B. Update ops runbook with MCP usage.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| C.6.1 | NEW | `…\vLEIEnh1\mcp-vlei\.env` | Created from `.env.example`. Set `VLEI_API_KEY=<operator-key>` (same operator key from B.8.1). |
| C.6.2 | EXTEND | `…\legentvLEI\OPERATIONS_RUNBOOK.md` | Add MCP section: how to connect Claude, how to authenticate, sample prompts. Update the runbook's table of contents. |

## Definition of Done — **full 11-box checklist from `IMPLEMENTATION_PLAN.md` §10**

All eleven items pass:

- [ ] (1) `./manage-status.sh` shows healthy tree.
- [ ] (2a) Fresh company creatable via `./manage-company.sh add`.
- [ ] (2b) Fresh company creatable via `curl -X POST /api/lifecycle/company`.
- [ ] (2c) Fresh company creatable via Claude using MCP — **NOW CLOSED**.
- [ ] All three paths produce byte-identical state.
- [ ] (3) Fresh agent removal cleans BOTH BRAN paths.
- [ ] (4) `curl /llms.txt` returns catalog — **NOW CLOSED**.
- [ ] (5) Drift test passes in CI — **NOW CLOSED**.
- [ ] (6) DD agents authenticate with Bearer.
- [ ] (7) Boxed warning prints in `none`, not in `api_key`.
- [ ] (8) State-change guard from Claude blocks unconfirmed destructive calls — **NOW CLOSED**.
- [ ] (9) Three role boundaries enforced.
- [ ] (10) `--dry-run` works on all 5 lifecycle scripts.
- [ ] (11) Existing Jupiter↔Tommy + KRAM negotiation still works.

## Test gate — **PHASE C FINAL GATE**

```bash
# Connect Claude to mcp-vlei (configure in Claude Desktop or Claude Code MCP settings)

# In Claude conversation:
#   "Register a new company called Beta Corp with LEI 549300XYZ001234ABCDE 
#    using alias Beta_Corp."
#
# Expected behavior:
#   1. Claude calls vlei_search_endpoints to find the right endpoint
#   2. Claude identifies POST /api/lifecycle/company
#   3. Claude calls vlei_call_endpoint with confirm_state_change: true
#   4. Server returns 201

# Verify on the vLEI side
./manage-status.sh
# Shows Beta Corp

# Three-path parity test: create same company via shell, curl, and Claude
# Verify byte-identical state in task-data/ each time
# (Use different aliases: Acme via shell, Beta via curl, Gamma via Claude)
diff -r task-data/Acme_Corp-* task-data/Beta_Corp-*  # Structurally identical
diff -r task-data/Beta_Corp-* task-data/Gamma_Corp-* # Structurally identical

# State-change guard from Claude
# In Claude: "Delete company Beta_Corp."
# Claude should try without confirm_state_change → get STATE_CHANGE_GUARD error
# Claude should then ask user for confirmation OR re-call with confirm_state_change: true

# KRAM still works
SIGNING_MODE=kram ./run-all-agents.sh
# Buyer↔seller negotiation works

# Existing demo
./run-all-buyerseller-4D-with-subdelegation.sh
# Works
```

---

# ✅ PHASE C COMPLETE

When all six iterations' test gates pass, you have:

- **Full LLM accessibility:** Claude can drive the entire vLEI system through MCP.
- **Two safe MCP tools:** `vlei_search_endpoints` (discovery), `vlei_call_endpoint` (action with guards).
- **Public catalog:** `/llms.txt` documents every endpoint.
- **CI drift protection:** Adding an endpoint without documenting it fails the build.
- **State-change guard:** Destructive operations require explicit confirmation.
- **Full 11-box Phase 1 Done checklist** from `IMPLEMENTATION_PLAN.md` §10 passes.

The system is now complete in the Phase 1 sense. Phases 1b (KRAM extension), 4 (ACDC commitments), and 5 (gleif-prod) from the original design remain available as future enhancements but are not required for "Phase 1 done."

---

## Open Decisions Resolved Across the Three Phases

- **npm vs pnpm on DD side** — Used npm throughout. Compatible with existing `package-lock.json`.
- **`_patch_handleBuyerCounterOffer.ts`** — Read in B.3, decision documented in code comment.
- **signify-ts version pin** — Documented in A.4.1, applied in A.4.2.
- **MCP SDK version pin** — Documented in C.2.1, applied in C.2.3.

## What's NOT in Scope (Available as Future Phases)

These remain as future work, not blocking anything:

- **Phase 1b — KRAM extension to all routes:** Currently KRAM is wired to one test route (A.6.5). Extending it to all sensitive routes is a quick follow-up but deliberately not in scope.
- **Phase 4 — ACDC commitments:** Schemas `A2AAccept`, `A2ADDAccept`, `A2AOrder`, `A2ACancel` and the `VleiAcdcSigner.ts` class. Signed legal commitments. Defer until needed.
- **Phase 5 — `gleif-prod` network preset:** `resolve-env.ts` modification to add real GLEIF production network support. Defer until going to production.
