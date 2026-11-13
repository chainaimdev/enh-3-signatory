# vLEI + DynDic3ent — Implementation Plan

**Author:** Sathya Bala
**Date:** 2026-05-25
**Status:** Active execution plan — iterations broken into small chunks with time estimates
**Companion to:** `ARCHITECTURE_REVIEW.md` (full design context, no code)

This document breaks the entire scope into **small iterations** that can be picked up one at a time. Each iteration has a clear deliverable, a time estimate, and a definition of done. Iterations are sized so most fit in a single 2–4 hour focused work session.

---

## How to read this plan

**Three parallel tracks.** Some work can run in parallel without conflicting. Tracks are labelled `A` (auth/API), `B` (lifecycle/shell), `C` (DD-side). The dependency graph in §1 shows which iterations block which.

**Time estimates** are pessimistic working time including testing and documentation. Add 25% buffer for unknowns. They assume one developer familiar with the existing codebase. Multiply by ~1.5 if you are picking up an iteration cold after a long break.

**Definition of done** for each iteration is explicit. If you can answer yes to every item in the DoD list, the iteration is complete and you can stop.

**Iteration size principle.** Most iterations are 2–6 hours. A few unavoidable ones (the lifecycle scripts themselves) take a full day. Nothing in this plan should take more than 1.5 days end-to-end — if it would, it gets split further.

---

## 1. Dependency graph

```
                        ITERATION 0 (must run first)
                      ┌────────────────────────┐
                      │ Fix get_keria_alias    │
                      │ hardcoded function     │
                      └───────────┬────────────┘
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       │                          │                          │
       ▼                          ▼                          ▼
  TRACK A                    TRACK B                    TRACK C
  (Auth + API)               (Lifecycle scripts)        (DD-side)
       │                          │                          │
   A1 auth-middleware         B1 manage-status.sh       C1 .env additions
       │                          │                          │
   A2 server.js wiring        B2 bootstrap-root-qvi.sh   C2 optional Bearer
       │                          │                          │     headers
   A3 startup warning         B3 manage-company.sh           │
       │                          │                      ╔═══╧═══╗
       │                          │                      ║ Phase ║
       │                      B4 manage-officer.sh       ║ 1     ║
       │                          │                      ║ ends  ║
       │                      B5 manage-agent.sh         ╚═══════╝
       │                          │
       │                      B6 manage-subagent.sh
       │                          │
       ▼                          ▼
   ╔══════════════════════════════════════════╗
   ║  INTEGRATION POINT — pair each manage-X  ║
   ║  with /api/lifecycle/X endpoints         ║
   ║  (Iterations P1 — P5)                    ║
   ╚══════════════════════════════════════════╝
                          │
                          ▼
                  Iteration M1 — vlei-llms.txt catalog
                          │
                          ▼
                  Iterations M2–M5 — mcp-vlei TypeScript project
                          │
                          ▼
                  Iteration G — graduation to AUTH_MODE=api_key
                          │
                          ▼
                  ┌───────────────────────┐
                  │ PHASE 1 COMPLETE      │
                  │ — ship to staging —   │
                  └───────────┬───────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         Iter. K1–K4      Iter. S1–S4    Iter. N1–N2
         (KRAM/Phase 1b)  (Schemas+ACDC) (gleif-prod)
              │               │               │
              └───────────────┼───────────────┘
                              ▼
                      PRODUCTION READY
```

---

## 2. Phase 1 — Foundation (the only blocking phase)

This is the minimum end-to-end working system. After Phase 1, you have:
- Lifecycle operations workable from terminal AND from REST API
- All endpoints discoverable via `/llms.txt`
- LLMs can register companies, officers, agents, sub-agents via MCP
- Authentication is opt-in (default open with warning)

**Total Phase 1 effort:** ~12–16 working days of one developer.

### Iteration 0 — Unblock everything

**ID:** P0
**Estimate:** 3–4 hours
**Track:** Foundation (blocks everything)
**Dependencies:** none

**What it is.** Fix the hardcoded `get_keria_alias` function in `generate-unique-agent-brans.sh`. Today it literally checks for "Jupiter" and "Tommy" in the org name; any third company breaks the workflow. Replace it with a config-driven lookup that reads the agent alias from `appconfig/configBuyerSellerAIAgent1-with-subdelegation.json`.

**Files touched.**
- `vLEIEnh1\legentvLEI\generate-unique-agent-brans.sh` (modify)
- `vLEIEnh1\legentvLEI\appconfig\configBuyerSellerAIAgent1-with-subdelegation.json` (add explicit `keriaAlias` field per agent if needed, or document the lookup rule)

**Definition of done.**
- Add a third dummy company to the config (e.g. "Acme Corp") and run the existing 4D workflow.
- The new company gets a valid, distinct agent alias (not `unknownAgent`).
- Existing Jupiter and Tommy flows still work — no regression.
- The fix is documented in a comment at the top of the function.

**Why first.** Without this, none of the lifecycle scripts work for arbitrary companies. Caveat B from MODULAR_LIFECYCLE_PLAN §6.2 explicitly names this as the highest-priority change.

---

### Track A — Authentication scaffold (parallel with Track B)

#### Iteration A1 — Bearer auth middleware

**ID:** A1
**Estimate:** 4 hours
**Track:** A (auth)
**Dependencies:** P0

**What it is.** Create `vLEIEnh1\legentvLEI\api-server\lib\auth-middleware.js`. Export two functions: `requireRole(minRole)` returning Express middleware, and `validateAuthConfig(bindHost)` for startup checks. Three roles: `viewer`, `agent`, `operator`. Two AUTH_MODE settings: `none` (default, passthrough), `api_key` (enforce Bearer header against three configured keys).

**Files touched.**
- `vLEIEnh1\legentvLEI\api-server\lib\auth-middleware.js` (new)
- `vLEIEnh1\legentvLEI\api-server\lib\` (new directory)

**Definition of done.**
- File exists, exports both functions.
- Standalone unit test (or manual curl test against a tiny test server): missing header → 401, valid key → next(), wrong role → 403.
- File has a module-level comment explaining the three AUTH_MODE states and how to graduate.

---

#### Iteration A2 — Wire middleware into server.js

**ID:** A2
**Estimate:** 3 hours
**Track:** A (auth)
**Dependencies:** A1

**What it is.** Import `requireRole` and `validateAuthConfig` into `api-server/server.js`. Apply `requireRole('viewer')` to status endpoints, `requireRole('agent')` to verify/IPEX endpoints. Leave `/health` unauthenticated. Call `validateAuthConfig('0.0.0.0')` right before `app.listen`.

**Files touched.**
- `vLEIEnh1\legentvLEI\api-server\server.js` (modify)
- `vLEIEnh1\legentvLEI\.env` (add `AUTH_MODE=none` with commented-out key lines)

**Definition of done.**
- All 15 existing routes have the appropriate `requireRole(...)` applied.
- Legacy `/api/verify/*` routes get `requireRole('agent')` for backward compatibility.
- With `AUTH_MODE=none`, every endpoint behaves exactly as it did before (no regression).
- Server starts and serves traffic.

---

#### Iteration A3 — Startup warning

**ID:** A3
**Estimate:** 1–2 hours
**Track:** A (auth)
**Dependencies:** A2

**What it is.** Implement the boxed startup warning in `validateAuthConfig`. When `AUTH_MODE=none` and bind is not loopback, print a multi-line boxed warning to stderr explaining the server is unauthenticated and reachable on the network. When `AUTH_MODE=api_key` and any of the three keys is missing, throw at startup.

**Files touched.**
- `vLEIEnh1\legentvLEI\api-server\lib\auth-middleware.js` (modify)

**Definition of done.**
- Start server with `AUTH_MODE=none` on `0.0.0.0` — boxed warning prints, server boots.
- Start server with `AUTH_MODE=none` on `127.0.0.1` — informational log only, no warning.
- Start server with `AUTH_MODE=api_key` and no keys set — throws with a clear error message.
- Start server with `AUTH_MODE=api_key` and three keys set — clean startup log saying "3 keys loaded, role-based access enforced".

**Track A complete after A3. ~9–10 hours total.**

---

### Track B — Lifecycle scripts (parallel with Track A)

#### Iteration B1 — manage-status.sh (read-only inventory)

**ID:** B1
**Estimate:** 4–5 hours
**Track:** B (lifecycle)
**Dependencies:** P0

**What it is.** Create `manage-status.sh` at the project root. Walks `task-data/` and the active config file, prints a tree of companies → officers → agents → sub-agents with each entity's AID, status, and any verification info available. Supports `--json` for structured output.

**Files touched.**
- `vLEIEnh1\legentvLEI\manage-status.sh` (new)

**Definition of done.**
- Running `./manage-status.sh` shows the current Jupiter and Tommy trees correctly.
- Running `./manage-status.sh --json` outputs valid JSON parseable by `jq`.
- The script reads only per-alias files, never shared `le-info.json` / `le-aid.txt` (per Caveat C from MODULAR_LIFECYCLE_PLAN §6.3).
- Script has a usage banner at the top and exits 0 on success.

**Why first in Track B.** Cheapest to build, immediately useful for testing every later iteration. Run it before and after every add/remove during development.

---

#### Iteration B2 — bootstrap-root-qvi.sh

**ID:** B2
**Estimate:** 4–5 hours
**Track:** B (lifecycle)
**Dependencies:** P0

**What it is.** Extract Section 2 of `run-all-buyerseller-4C-with-agents.sh` into a standalone `bootstrap-root-qvi.sh`. Sets up the GEDA root and the QVI delegated identity. One-time setup. Idempotent — skips if already done.

**Files touched.**
- `vLEIEnh1\legentvLEI\bootstrap-root-qvi.sh` (new)

**Definition of done.**
- On a fresh environment, running `./bootstrap-root-qvi.sh` produces the same GEDA + QVI state as running the existing 4C script up through Section 2.
- Running it a second time exits with "already bootstrapped, nothing to do" and exit code 0.
- `manage-status.sh` shows the bootstrapped state.

---

#### Iteration B3 — manage-company.sh

**ID:** B3
**Estimate:** 1–1.5 days (8–12 hours)
**Track:** B (lifecycle)
**Dependencies:** B2

**What it is.** Create the add and remove flow for Legal Entities. Add mode: append to config, run LE chain (create AID, OOBI exchange, registry creation, LE credential issuance, presentation to Sally). Remove mode: refuse if officers exist (unless `--force`), delete LE from KERIA, clean up files, archive.

**Files touched.**
- `vLEIEnh1\legentvLEI\manage-company.sh` (new)

**Definition of done.**
- `./manage-company.sh add --id acme --name "Acme Corp" --lei <valid LEI> --alias Acme_Corp` creates a new company end-to-end.
- `manage-status.sh` shows Acme Corp as an empty shell (no officers yet).
- `./manage-company.sh remove --alias Acme_Corp` removes it cleanly.
- `./manage-company.sh remove --alias Jupiter_Knitting_Company` (which has officers) refuses with a clear "still has officers" error.
- Same command with `--force` does remove it.
- `--dry-run` on both add and remove prints what would happen without doing it.

---

#### Iteration B4 — manage-officer.sh

**ID:** B4
**Estimate:** 1–1.5 days (8–12 hours)
**Track:** B (lifecycle)
**Dependencies:** B3

**What it is.** Same pattern as B3 but for officers (Person + OOR credential). Add: full Person AID creation, OOBI exchange with LE/QVI/Verifier, two-step OOR issuance (LE issues OOR_AUTH to QVI, QVI issues OOR to Person), presentation to Sally. Remove: refuse if agents delegated, optionally revoke OOR with `--revoke`.

**Files touched.**
- `vLEIEnh1\legentvLEI\manage-officer.sh` (new)

**Definition of done.**
- Add an officer to an existing company end-to-end.
- `manage-status.sh` shows the officer with `OOR` credential status verified.
- Remove the officer succeeds when no agents are delegated.
- Remove refuses when agents are delegated.
- `--revoke` flag performs the TEL revocation step in addition to local delete.

---

#### Iteration B5 — manage-agent.sh

**ID:** B5
**Estimate:** 1–1.5 days (8–12 hours)
**Track:** B (lifecycle)
**Dependencies:** B4

**What it is.** Same pattern as B4 but for agents (AI agent delegated by an officer). Add: generate fresh 256-bit BRAN, add to `agent-brans.json`, run `agent-delegate-with-unique-bran`, resolve OOBIs, run verification. Remove: refuse if sub-agents exist, delete from KERIA, clean BRAN file and info files.

**Files touched.**
- `vLEIEnh1\legentvLEI\manage-agent.sh` (new)
- `vLEIEnh1\legentvLEI\task-data\agent-brans.json` (modified at runtime by script)

**Definition of done.**
- Add an agent under an existing officer end-to-end.
- New BRAN appears in `agent-brans.json`.
- `manage-status.sh` shows the agent with delegation verified.
- Remove the agent succeeds when no sub-agents exist; refuses otherwise.
- BRAN is also written to DD-local `.secret/agent-bran.txt` per Q10 lock — see C-track iterations.

---

#### Iteration B6 — manage-subagent.sh

**ID:** B6
**Estimate:** 5–6 hours
**Track:** B (lifecycle)
**Dependencies:** B5

**What it is.** Sub-agent management. Cheapest of the four to build because `task-scripts/subagent/subagent-delete-from-keria.sh` already exists and provides the remove primitive. Add: validate parent agent has `canDelegate: true`, generate BRAN, run `subagent-delegate-with-unique-bran`, enforce scope-narrowing rule (sub-agent scope must be subset of parent scope). Remove: invoke existing delete script, clean up.

**Files touched.**
- `vLEIEnh1\legentvLEI\manage-subagent.sh` (new)
- `vLEIEnh1\legentvLEI\task-data\subagent-brans.json` (modified at runtime)

**Definition of done.**
- Add a sub-agent under an existing agent that has `canDelegate: true`.
- Refuses to add under an agent with `canDelegate: false` with a clear error.
- Refuses to add with a scope that is not a subset of the parent's scope.
- Remove works and removes only the sub-agent, not the parent.

**Track B complete after B6. ~5–7 working days total.**

---

### Track C — DD-side prep (parallel with A and B)

#### Iteration C1 — DD .env additions

**ID:** C1
**Estimate:** 30 minutes
**Track:** C (DD-side)
**Dependencies:** none (can be done any time)

**What it is.** Add `VLEI_API_BASE_URL=http://localhost:4000` and a commented-out `VLEI_API_KEY_AGENT` line to `buyer-agent\.env` and `seller-agent\.env`. Trivial change.

**Files touched.**
- `DynDic3ent1\A2A\js\src\agents\buyer-agent\.env` (modify)
- `DynDic3ent1\A2A\js\src\agents\seller-agent\.env` (modify)

**Definition of done.**
- Both `.env` files contain `VLEI_API_BASE_URL` (uncommented) and `VLEI_API_KEY_AGENT` (commented out with a graduation note).

---

#### Iteration C2 — Optional Bearer header on 4 fetch sites

**ID:** C2
**Estimate:** 2–3 hours
**Track:** C (DD-side)
**Dependencies:** C1 + A2 (server needs to accept Bearer header)

**What it is.** Modify the four `fetch()` call sites that hit the vLEI api-server. Build the headers object conditionally — if `process.env.VLEI_API_KEY_AGENT` is set, attach `Authorization: Bearer ${apiKey}`. Otherwise, send without auth header. Matches the server's default-open behaviour.

**Files touched.**
- `DynDic3ent1\A2A\js\src\agents\buyer-agent\index.ts` (modify — 2 fetch sites)
- `DynDic3ent1\A2A\js\src\agents\seller-agent\index.ts` (modify — 2 fetch sites)

**Definition of done.**
- All four fetches build headers conditionally.
- With `VLEI_API_KEY_AGENT` unset, agents still successfully call the api-server (test mode works).
- With `AUTH_MODE=api_key` on the server and `VLEI_API_KEY_AGENT` set on the agents, agents successfully authenticate.
- Without setting the key on the agent but with `AUTH_MODE=api_key` on the server, agents get 401 (expected behaviour).

**Track C complete after C2 for Phase 1. ~3 hours total. KramSigner work is Phase 1b.**

---

### Integration Iterations — pair lifecycle scripts with REST endpoints

These iterations build on Track A (auth middleware) and Track B (lifecycle scripts). Each one wraps a lifecycle script with matching `/api/lifecycle/*` HTTP endpoints. Same operation, two front doors.

#### Iteration P1 — POST /api/lifecycle/company + DELETE /api/lifecycle/company/:alias

**ID:** P1
**Estimate:** 4–5 hours
**Track:** Integration
**Dependencies:** A2 + B3

**What it is.** Add two routes to `api-server/server.js`. POST takes a JSON body with `id`, `name`, `lei`, `alias`. Shells out to `./manage-company.sh add --json ...` and returns the script's JSON output as the HTTP response. DELETE takes the alias as URL param plus a body with `revocationMode`, `confirmationToken`, `cascade`, etc per DetailedDesign §3.6. Both routes use `requireRole('operator')`.

**Files touched.**
- `vLEIEnh1\legentvLEI\api-server\server.js` (modify — add 2 routes)
- `vLEIEnh1\legentvLEI\api-server\lib\lifecycle-runner.js` (new helper that shells out safely with input validation)

**Definition of done.**
- `curl -X POST -H "Authorization: Bearer <operator-key>" -d '{...}' http://localhost:4000/api/lifecycle/company` creates a company.
- The same operation via `./manage-company.sh add` produces the identical end state.
- `manage-status.sh` shows the new company regardless of which path created it.
- DELETE with `revocationMode: soft` (default) marks inactive but keeps data.
- DELETE with `revocationMode: immediate` and a correct `confirmationToken` performs the TEL revocation.
- DELETE with wrong token returns 400.
- All routes return 403 when called with non-operator role.

---

#### Iteration P2 — POST/DELETE /api/lifecycle/officer

**ID:** P2
**Estimate:** 3–4 hours
**Track:** Integration
**Dependencies:** P1 + B4

**What it is.** Same pattern as P1 but for officers. Reuse the `lifecycle-runner.js` helper.

**Files touched.**
- `vLEIEnh1\legentvLEI\api-server\server.js` (modify — add 2 routes)

**Definition of done.** Same shape as P1, but for officer add/remove with parent company in the request body.

---

#### Iteration P3 — POST/DELETE /api/lifecycle/agent

**ID:** P3
**Estimate:** 3–4 hours
**Track:** Integration
**Dependencies:** P2 + B5

**What it is.** Same pattern, for agents. Notably also writes the BRAN to the DD-local `.secret/agent-bran.txt` per Q10 lock from DetailedDesign §8.

**Files touched.**
- `vLEIEnh1\legentvLEI\api-server\server.js` (modify)
- `vLEIEnh1\legentvLEI\manage-agent.sh` (extend to also write DD-local BRAN copy)

**Definition of done.** Same shape as P1, plus: a fresh agent's BRAN appears in both `vLEIEnh1\legentvLEI\task-data\{alias}-bran.txt` AND `DynDic3ent1\A2A\js\src\agents\{alias}\.secret\agent-bran.txt` with file permissions 600.

---

#### Iteration P4 — POST/DELETE /api/lifecycle/subagent

**ID:** P4
**Estimate:** 3–4 hours
**Track:** Integration
**Dependencies:** P3 + B6

**What it is.** Same pattern, for sub-agents.

**Definition of done.** Same shape.

---

#### Iteration P5 — GET /api/lifecycle/status

**ID:** P5
**Estimate:** 2–3 hours
**Track:** Integration
**Dependencies:** B1

**What it is.** Read-only endpoint that returns what `manage-status.sh --json` produces. Uses `requireRole('viewer')`. Cheap, useful for the UI and for monitoring.

**Files touched.**
- `vLEIEnh1\legentvLEI\api-server\server.js` (modify)

**Definition of done.** GET returns valid JSON with the full tree of companies, officers, agents, sub-agents. Viewer role is sufficient.

**Integration iterations complete. ~15–20 hours total.**

---

### MCP track — discoverability and LLM access

#### Iteration M1 — vlei-llms.txt catalog

**ID:** M1
**Estimate:** 1 day (8 hours)
**Track:** MCP
**Dependencies:** P5 (so all endpoints exist by now)

**What it is.** Author the `vlei-llms.txt` markdown catalog. One section per non-deprecated endpoint. Each section includes path, description, minimum role, state-changing flag, body schema (JSON), and a response sample (JSON). Add the `GET /llms.txt` route (no auth) to `server.js` that serves the file. Add a startup CI test that parses both the catalog and `server.js` and fails if any non-deprecated route lacks a catalog entry.

**Files touched.**
- `vLEIEnh1\legentvLEI\api-server\vlei-llms.txt` (new)
- `vLEIEnh1\legentvLEI\api-server\server.js` (modify — add /llms.txt route)
- `vLEIEnh1\legentvLEI\api-server\lib\catalog-loader.js` (new)
- `vLEIEnh1\legentvLEI\api-server\test\catalog-drift.test.js` (new)

**Definition of done.**
- `curl http://localhost:4000/llms.txt` returns the markdown catalog.
- Every existing endpoint plus the five new lifecycle endpoints have entries.
- Legacy `/api/verify/*` endpoints are excluded.
- The drift test passes today. Adding a fake new route in `server.js` and rerunning the test makes it fail. Adding the catalog entry makes it pass again.

---

#### Iteration M2 — mcp-vlei project scaffold

**ID:** M2
**Estimate:** 4–5 hours
**Track:** MCP
**Dependencies:** M1

**What it is.** Create the `vLEIEnh1\mcp-vlei\` TypeScript project. `package.json`, `tsconfig.json`, `.env.example`, `README.md`, empty `src/server.ts` with a TODO comment. Verify the current `@modelcontextprotocol/sdk` version against the official README before pinning. Confirm `tsx` runs an empty placeholder.

**Files touched.**
- `vLEIEnh1\mcp-vlei\` (new directory tree)
- `vLEIEnh1\mcp-vlei\package.json` (new)
- `vLEIEnh1\mcp-vlei\tsconfig.json` (new)
- `vLEIEnh1\mcp-vlei\.env.example` (new)
- `vLEIEnh1\mcp-vlei\README.md` (new)
- `vLEIEnh1\mcp-vlei\src\server.ts` (new — placeholder)

**Definition of done.**
- `cd mcp-vlei && pnpm install` succeeds.
- `pnpm run dev` runs the placeholder and exits cleanly.
- README documents the env vars.

---

#### Iteration M3 — catalog parser + EndpointIndex

**ID:** M3
**Estimate:** 4–6 hours
**Track:** MCP
**Dependencies:** M2

**What it is.** Implement `src/catalog/parser.ts` that parses `vlei-llms.txt` markdown into an array of `EndpointSpec` objects. Implement `src/catalog/index.ts` with an `EndpointIndex` class providing `search(query, opts)`, `isPathAllowed(path)`, and `getSpec(path)`.

**Files touched.**
- `vLEIEnh1\mcp-vlei\src\catalog\parser.ts` (new)
- `vLEIEnh1\mcp-vlei\src\catalog\index.ts` (new)

**Definition of done.**
- A unit test feeds the parser the real `vlei-llms.txt` and gets back a populated `EndpointSpec[]`.
- `EndpointIndex.search("verify seller")` returns at least one relevant result.
- `isPathAllowed("/api/buyer/verify/ext/seller")` returns true.
- `isPathAllowed("/api/../etc/passwd")` returns false.

---

#### Iteration M4 — vlei_search_endpoints tool

**ID:** M4
**Estimate:** 4–5 hours
**Track:** MCP
**Dependencies:** M3

**What it is.** Implement the first MCP tool. Input schema: `{ query, detail?, max_results? }`. Output: ranked list of matching endpoints from the EndpointIndex. Detail levels: `brief` (title + path + method), `more` (adds body schema), `verbose` (adds response sample).

**Files touched.**
- `vLEIEnh1\mcp-vlei\src\tools\search-endpoints.ts` (new)
- `vLEIEnh1\mcp-vlei\src\server.ts` (modify — register tool)

**Definition of done.**
- `npx @modelcontextprotocol/inspector node dist/server.js` opens the inspector.
- Calling `vlei_search_endpoints` with `query: "verify seller"` returns sensible matches.
- Detail level switching works.

---

#### Iteration M5 — vlei_call_endpoint tool

**ID:** M5
**Estimate:** 1 day (6–8 hours)
**Track:** MCP
**Dependencies:** M4

**What it is.** Implement the second MCP tool. Input schema: `{ path, method?, body?, params?, confirm_state_change? }`. Validates path against EndpointIndex allowlist, validates body against catalog schema, enforces state-change guard (reject if `stateChanging: true` and `confirm_state_change !== true`), attaches Bearer header from env, makes the HTTP call via `undici`, maps HTTP errors to massive-style category prefixes.

**Files touched.**
- `vLEIEnh1\mcp-vlei\src\tools\call-endpoint.ts` (new)
- `vLEIEnh1\mcp-vlei\src\http-client.ts` (new)
- `vLEIEnh1\mcp-vlei\src\env.ts` (new)
- `vLEIEnh1\mcp-vlei\src\server.ts` (modify — register tool)

**Definition of done.**
- Inspector test: calling a viewer-role endpoint succeeds.
- Calling a state-changing endpoint without `confirm_state_change: true` is rejected with `Error [STATE_CHANGE_GUARD]`.
- Calling with `confirm_state_change: true` succeeds.
- Calling a path not in the catalog returns `Error [NOT_FOUND]`.
- Path-traversal attempt (`/api/../`) is rejected.
- Wrong Bearer key returns `Error [AUTH]`.

**MCP track complete after M5. ~3–4 working days total.**

---

### Phase 1 closeout — graduation to production auth

#### Iteration G — Graduate to AUTH_MODE=api_key

**ID:** G
**Estimate:** 1–2 hours
**Track:** Integration
**Dependencies:** A3 + C2 + M5

**What it is.** The "flip the switch" iteration. Generate three keys, paste them into the right places, restart, verify.

**Files touched.**
- `vLEIEnh1\legentvLEI\.env` (uncomment and fill in keys)
- `DynDic3ent1\A2A\js\src\agents\buyer-agent\.env` (uncomment and fill in agent key)
- `DynDic3ent1\A2A\js\src\agents\seller-agent\.env` (same)
- `vLEIEnh1\mcp-vlei\.env` (set VLEI_API_KEY to operator key)

**Procedure.**
1. Generate three keys: `openssl rand -hex 32` three times.
2. Uncomment the three `VLEI_API_KEY_*` lines in `vLEIEnh1\legentvLEI\.env` and paste in the values.
3. Change `AUTH_MODE=none` → `AUTH_MODE=api_key`.
4. Uncomment `VLEI_API_KEY_AGENT` in both DD agent .envs with the matching agent key.
5. Set `VLEI_API_KEY=<operator-key>` in `mcp-vlei\.env`.
6. Restart api-server, agents, and mcp-vlei.
7. Smoke test: curl every endpoint with and without keys; confirm 401/403/200 per role matrix.

**Definition of done.**
- Server starts in `api_key` mode with the "3 keys loaded" log line.
- No request to port 4000 succeeds without a valid Bearer header.
- DD agents authenticate successfully.
- MCP server authenticates successfully.
- Lifecycle endpoints reject calls with agent-role keys (operator-only).
- The boxed warning no longer prints (since we are not in `none` mode anymore).

**Phase 1 ships after this iteration. ~3 working days reserved for end-to-end smoke testing, bug fixing, and operational documentation.**

---

## 3. Phase 1 summary table

| ID | Iteration | Track | Hours | Cumulative days* |
|---|---|---|---|---|
| P0 | Fix get_keria_alias | Foundation | 3–4 | 0.5 |
| A1 | Bearer auth middleware | A | 4 | 1.0 |
| A2 | Wire middleware into server.js | A | 3 | 1.5 |
| A3 | Startup warning | A | 1–2 | 1.75 |
| B1 | manage-status.sh | B | 4–5 | 2.5 |
| B2 | bootstrap-root-qvi.sh | B | 4–5 | 3.0 |
| B3 | manage-company.sh | B | 8–12 | 4.5 |
| B4 | manage-officer.sh | B | 8–12 | 6.0 |
| B5 | manage-agent.sh | B | 8–12 | 7.5 |
| B6 | manage-subagent.sh | B | 5–6 | 8.25 |
| C1 | DD .env additions | C | 0.5 | 8.25 |
| C2 | Optional Bearer on fetches | C | 2–3 | 8.5 |
| P1 | /api/lifecycle/company | Int | 4–5 | 9.25 |
| P2 | /api/lifecycle/officer | Int | 3–4 | 9.75 |
| P3 | /api/lifecycle/agent | Int | 3–4 | 10.25 |
| P4 | /api/lifecycle/subagent | Int | 3–4 | 10.75 |
| P5 | /api/lifecycle/status | Int | 2–3 | 11.25 |
| M1 | vlei-llms.txt catalog | MCP | 8 | 12.25 |
| M2 | mcp-vlei scaffold | MCP | 4–5 | 12.75 |
| M3 | catalog parser | MCP | 4–6 | 13.5 |
| M4 | vlei_search_endpoints | MCP | 4–5 | 14.0 |
| M5 | vlei_call_endpoint | MCP | 6–8 | 14.75 |
| G | Graduate to api_key | Int | 1–2 | 15.0 |
| — | End-to-end smoke + buffer | — | 24 | **18.0** |

*Assuming an 8-hour focused work day. Calendar time will be longer if you cannot dedicate full days.

**Phase 1 total: ~18 working days (≈3.5 calendar weeks at 5 dev-days/week, or ~7 weeks at 2.5 dev-days/week).**

---

## 4. Phase 1b — KRAM (optional but recommended)

After Phase 1 ships, the next strategic upgrade is KRAM — cryptographic per-message signing using each agent's own KERI key. This adds court-defensible non-repudiation to negotiation messages.

### Iteration K1 — Add signify-ts dependency to DD

**ID:** K1
**Estimate:** 1–2 hours
**Track:** KRAM
**Dependencies:** Phase 1 complete

**What it is.** Verify the current published `signify-ts` version at https://www.npmjs.com/package/signify-ts. Add it to `DynDic3ent1\A2A\js\package.json`. Run `pnpm install`. Verify it imports without runtime errors.

**Files touched.**
- `DynDic3ent1\A2A\js\package.json` (modify)
- `DynDic3ent1\A2A\js\pnpm-lock.yaml` (regenerated)

**Definition of done.** `import { Authenticater } from 'signify-ts'` works in a one-off test script.

---

### Iteration K2 — KramSigner skeleton + signed-message.ts changes

**ID:** K2
**Estimate:** 4–6 hours
**Track:** KRAM
**Dependencies:** K1

**What it is.** Create `KramSigner.ts` as a class skeleton implementing the `MessageSigner` interface. Extend `SigningMode` type to include `"kram"`. Add `KRAM_SIGNATURE_INVALID` to the failure-reason enum. Modify the factory in `messaging/index.ts` to instantiate `KramSigner` when `SIGNING_MODE=kram`.

**Files touched.**
- `DynDic3ent1\A2A\js\src\messaging\KramSigner.ts` (new)
- `DynDic3ent1\A2A\js\src\messaging\signed-message.ts` (modify)
- `DynDic3ent1\A2A\js\src\messaging\index.ts` (modify)

**Definition of done.** Setting `SIGNING_MODE=kram` and starting an agent constructs a `KramSigner` instance without crashing (even though seal/verify still throw "not implemented").

---

### Iteration K3 — KramSigner.seal() and .verify() implementation

**ID:** K3
**Estimate:** 2 days (12–16 hours)
**Track:** KRAM
**Dependencies:** K2

**What it is.** The substantive work. Implement `seal()` to build outgoing headers (`Signify-Resource`, `Signify-Timestamp`, `Content-Digest`), call `Authenticater.sign()` with the body digest included in signed fields, serialise into the SignedEnvelope. Implement `verify()` to deserialise headers, reconstruct `Authenticater` with the sender's public key from KEL, verify the signature, and separately verify the body digest matches.

**Files touched.**
- `DynDic3ent1\A2A\js\src\messaging\KramSigner.ts` (implement)

**Definition of done.**
- Unit test: buyer signs an offer, seller receives and verifies. Round trip succeeds.
- Tampered body fails verification with `KRAM_SIGNATURE_INVALID`.
- Stale timestamp (older than 30 seconds) fails verification.
- Replay of the same signed message within the window is rejected by the dedup cache.

---

### Iteration K4 — KRAM verify middleware on vLEI side

**ID:** K4
**Estimate:** 2 days (12–16 hours)
**Track:** KRAM
**Dependencies:** K3

**What it is.** Implement `vLEIEnh1\legentvLEI\api-server\lib\kram-verify-middleware.js`. Parse `Signify-Resource` and `Signify-Timestamp` headers, run staleness and dedup-cache checks, resolve sender KEL via OOBI cache, construct `Authenticater` with the sender's public key, verify, then separately verify the body digest. Insert raw-body capture middleware (`express.raw({ type: '*/*' })`) before `express.json()` so the digest can be recomputed.

**Files touched.**
- `vLEIEnh1\legentvLEI\api-server\lib\kram-verify-middleware.js` (replace stub with real implementation)
- `vLEIEnh1\legentvLEI\api-server\server.js` (modify — insert raw-body capture, optionally wire `requireKram()` on selected routes)

**Definition of done.**
- DD buyer-agent set to `SIGNING_MODE=kram` successfully calls `/api/buyer/verify/ext/seller` and the vLEI server verifies the signature.
- Tampering with the body in flight fails server-side verification.
- Mismatched timestamps outside the skew window fail.
- Replay within the window is caught by the dedup cache.

**Phase 1b complete after K4. ~5–6 working days total.**

---

## 5. Phase 4 — Heavy commitments (ACDC + IPEX)

This phase is later — only relevant once negotiation messaging is working at scale and the business needs legally binding commitments.

### Iteration S1 — Author 4 commitment ACDC schemas

**ID:** S1
**Estimate:** 1–2 days
**Track:** Schemas
**Dependencies:** Phase 1 complete

**What it is.** Author `A2AAccept`, `A2ADDAccept`, `A2AOrder`, `A2ACancel` JSON Schemas following `101_60_Saidify_schema.md`. SAIDify each. Register them with the schema server.

**Definition of done.** Schemas exist as SAIDified JSON files. Schema server serves them at the expected URLs.

---

### Iteration S2 — VleiAcdcSigner implementation

**ID:** S2
**Estimate:** 2–3 days
**Track:** Schemas
**Dependencies:** S1

**What it is.** Wraps `/api/seller/ipex/issue-and-grant` + `/api/buyer/ipex/admit` flow into a class that implements the same `MessageSigner` interface as `PlainHashSigner` and `KramSigner`. The "heavy tier" of the three-tier message security model from Hybrid §5.

**Definition of done.** End-to-end test: buyer accepts an offer, seller-agent calls `VleiAcdcSigner.seal()`, an A2AAccept credential is issued in the seller's TEL, granted to the buyer, admitted by the buyer, and verifiable by Sally.

---

### Iteration S3 — Full negotiation end-to-end test

**ID:** S3
**Estimate:** 1–2 days
**Track:** Schemas
**Dependencies:** S2

**What it is.** Run Jupiter ↔ Tommy through a full negotiation producing one ACCEPT credential, verifiable by Sally. The canonical Phase 4 acceptance test from DetailedDesign §7 step 25.

**Definition of done.** Existing demo workflow plus the new credential issuance succeeds end-to-end without manual intervention.

**Phase 4 complete after S3. ~5–7 working days total.**

---

## 6. Phase 5 — Production hardening

### Iteration N1 — gleif-prod network preset

**ID:** N1
**Estimate:** 4–5 hours
**Track:** Network
**Dependencies:** Phase 1 complete

**What it is.** Add the `gleif-prod` case to `vLEIEnh1\legentvLEI\sig-wallet\src\client\resolve-env.ts`. All URLs come from `GLEIF_PROD_*` env vars; throws if any are missing. Document the env-var family in `.env.example`.

**Definition of done.**
- With `WORKSHOP_ENV=gleif-prod` and all env vars set, resolver returns valid config.
- With any env var missing, resolver throws with a clear error listing what's missing.
- `docker` and `testnet` presets unchanged.

---

### Iteration N2 — Production deployment dry-run

**ID:** N2
**Estimate:** 1–2 days
**Track:** Network
**Dependencies:** N1 + all of Phase 1

**What it is.** Stand up the full stack pointing at GLEIF's actual production network. Run smoke tests. Document any operational gotchas discovered.

**Definition of done.** A documented deployment runbook exists. All endpoints respond correctly against the real GLEIF production network.

---

## 7. Total effort summary

| Phase | Iterations | Total dev-days | Notes |
|---|---|---|---|
| **Phase 1 (Foundation)** | P0 + A1–A3 + B1–B6 + C1–C2 + P1–P5 + M1–M5 + G + buffer | **~18 days** | Ships end-to-end working system |
| **Phase 1b (KRAM)** | K1–K4 | **~5–6 days** | Optional; cryptographic per-message non-repudiation |
| **Phase 4 (Commitments)** | S1–S3 | **~5–7 days** | Legal-grade ACDC commitments |
| **Phase 5 (Production network)** | N1–N2 | **~2–3 days** | gleif-prod deployment |
| **GRAND TOTAL** | | **~30–34 dev-days** | (~6–7 calendar weeks at full time) |

---

## 8. Recommended starting sequence

If you can only do one thing at a time and want to make visible progress fast, this is the order:

1. **Day 1 morning:** P0 (fix get_keria_alias). Half a day. Removes the biggest blocker.
2. **Day 1 afternoon:** B1 (manage-status.sh). You will use this constantly.
3. **Day 2:** A1 + A2 + A3 (auth scaffold, test mode). Server starts gating endpoints but stays open by default.
4. **Day 3:** B2 (bootstrap-root-qvi.sh) + C1 + C2 (DD-side prep).
5. **Days 4–8:** B3 → B6 (the four manage-* lifecycle scripts). One per day-and-a-half.
6. **Days 9–11:** P1 → P5 (REST endpoints). Roughly half a day each.
7. **Days 12–15:** M1 → M5 (catalog + MCP). About a day each.
8. **Day 16:** G (graduation). 1–2 hours of pasting keys plus a smoke test.
9. **Days 17–18:** Bug fixing, documentation, operational runbook.

Stop here unless you have an immediate need for KRAM or ACDC commitments. Phase 1 is a complete, shippable, production-graduable system on its own.

---

## 9. Risk register

| Risk | Mitigation |
|---|---|
| `signify-ts` API changes between releases break KramSigner | Pin the version in `package.json`. Re-verify against current TypeDoc before any version bump |
| MCP SDK API surface changes | M2 explicitly verifies current SDK README before writing M4/M5 |
| `manage-X.sh` shell scripts have subtle differences from monolithic 4D pipeline | B1 (status tool) plus side-by-side runs of new vs old workflow catch divergence early |
| KERI immutability surprises operators ("I removed it, why is it still in the KEL?") | Document Caveat A from MODULAR_LIFECYCLE_PLAN prominently in the lifecycle script `--help` output |
| Production GLEIF URLs differ from documentation | N1 reads from env vars, never hardcodes. Operator pastes from GLEIF onboarding docs |
| Lifecycle endpoint authentication misconfigured (e.g. agent-role can register companies) | P1's DoD explicitly checks 403 for non-operator roles |
| Catalog drifts from real routes | M1 includes a CI drift test |
| DD agents' BRAN duplicate copies drift out of sync | P3 ensures both copies are written atomically by the same `manage-agent.sh add` invocation; never edit either copy manually |

---

## 10. Definition of "Phase 1 done"

You have completed Phase 1 when all of these are true:

- Running `./manage-status.sh` shows a healthy tree of companies, officers, agents, sub-agents.
- A fresh company can be registered three ways and all three produce the identical result: (a) `./manage-company.sh add ...`, (b) `curl -X POST .../api/lifecycle/company`, (c) Claude calling `vlei_call_endpoint` with the right body.
- A fresh agent can be removed and the BRAN files in both `vLEIEnh1` and `DynDic3ent1` locations are cleaned up.
- `curl http://localhost:4000/llms.txt` returns the markdown catalog.
- The drift test passes.
- DD agents successfully call vLEI endpoints with Bearer auth when `AUTH_MODE=api_key`.
- The startup boxed warning prints in `AUTH_MODE=none` and does not print in `AUTH_MODE=api_key`.
- A state-changing endpoint called from Claude without `confirm_state_change: true` is rejected.
- Three role boundaries are enforced: viewer cannot do agent operations, agent cannot do operator operations.
- `--dry-run` works on all five lifecycle scripts.

When you can tick all eleven boxes, ship it.

---

*End of implementation plan. For full architectural context with no code, see `ARCHITECTURE_REVIEW.md` in this directory.*
