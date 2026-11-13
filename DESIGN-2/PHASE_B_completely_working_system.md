# Phase B — Completely Working System

**Goal:** Build the "decent completely working" milestone — auth scaffold, lifecycle scripts for all four entities (company / officer / agent / sub-agent), REST endpoints with role-based access, graduation to `AUTH_MODE=api_key`. **Shippable system.**

**Prerequisite:** Phase A complete. KRAM works between buyer/seller. Existing 4D demo workflow unchanged.

**Estimated effort:** ~11 dev-days
**Phase B produces:** A complete role-gated REST-accessible modular lifecycle system + working KRAM + the original Jupiter↔Tommy demo. The only Phase 1 piece deferred to Phase C is the MCP (Claude / LLM) layer.

---

## Root Paths (verified on disk)

- **vLEI:** `C:\SATHYA\CHAINAIM3003\mcp-servers\vLEIEnh1\legentvLEI\`
- **DD:** `C:\SATHYA\CHAINAIM3003\mcp-servers\DynDic3ent1\A2A\js\`

---

## Non-Negotiable Quality Principles

Same as Phase A — these apply throughout:

1. **No mocks in shipped code.**
2. **No hardcoded values.** Everything from env or config.
3. **No silent fallbacks.** Missing env → throw at startup.
4. **No skipped error handling.** Every shell-out and fetch checks status.
5. **No new dependency without verification.**
6. **Idempotency mandatory.** Every script can run twice safely.
7. **Real KERIA, real witnesses, real Sally.**

## Cross-Cutting Lifecycle Rules

These apply to every `manage-*.sh` script:

- **Config is source of truth.** Add: config → KERIA. Remove: KERIA → config.
- **Per-alias files only.** Never read shared `task-data/le-info.json` or `task-data/le-aid.txt` (Caveat C).
- **Lifecycle metadata fields.** Every entity record includes `createdAt`, `createdBy`, `status`.
- **Removal defaults to soft local delete.** Opt-in `--revoke` for TEL revocation.
- **Same flag interface across all five scripts:** `--dry-run`, `--config`, `--force`, `--json`, `--help`.
- **Hierarchy guards.** Cannot remove a parent if children exist (unless `--force`).
- **Caveat A in `--help`:** "KERI history is permanently immutable; `remove` is local-delete + archive; use `--revoke` for irreversible TEL revocation."

---

## Phase B Iteration Roadmap

| # | Iteration | Hours | Cumulative |
|---|---|---|---|
| B.1 | Auth scaffold (lib/auth-middleware.js + server wiring) | 8–10 | 1 day |
| B.2 | Status walker + bootstrap | 8–10 | 2 days |
| B.3 | DD Bearer header on fetch sites (C2) | 2–3 | 2.5 days |
| B.4 | Company lifecycle (shell + REST) | 12–17 | 4.5 days |
| B.5 | Officer lifecycle (shell + REST) | 11–16 | 6 days |
| B.6 | Agent lifecycle (with BRAN dual-write replacing A.3) | 11–16 | 7.5 days |
| B.7 | Sub-agent + status endpoint | 10–13 | 9 days |
| B.8 | Graduation to `AUTH_MODE=api_key` | 2–3 | 9.5 days |
| B.9 | End-to-end smoke + ops runbook | 8 | 10.5 days |

Sequential execution required for B.4 → B.7 because they all edit `server.js` (the lifecycle endpoints accumulate). B.1, B.2, B.3 can run in parallel by separate developers if needed.

---

# Iteration B.1 — Auth scaffold

**Time:** 8–10 hours
**Depends on:** Phase A complete

## What you'll do
Build the auth middleware that all subsequent lifecycle endpoints will use. Three roles (`viewer` < `agent` < `operator`), two modes (`none`, `api_key`), Bearer token enforcement, role-based 403s, startup validation.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| B.1.1 | NEW | `…\api-server\lib\auth-middleware.js` | Exports `requireRole(minRole)` returning Express middleware. Exports `validateAuthConfig(bindHost)` for startup checks. Three roles: `viewer`=1, `agent`=2, `operator`=3. Two `AUTH_MODE` settings: `none` (passthrough) and `api_key` (Bearer enforcement). Reads `VLEI_API_KEY_VIEWER`, `VLEI_API_KEY_AGENT`, `VLEI_API_KEY_OPERATOR` from env. |
| B.1.2 | MODIFY | `…\api-server\server.js` | Import `requireRole` and `validateAuthConfig`. Apply `requireRole('viewer')` to all `/api/*/status` routes. Apply `requireRole('agent')` to all `/api/*/verify/*` and `/api/*/ipex/*` routes. Leave `/health` unauthenticated. Call `validateAuthConfig(process.env.BIND_HOST \|\| '0.0.0.0')` immediately before `app.listen`. |
| B.1.3 | MODIFY | `…\legentvLEI\.env` | Add `AUTH_MODE=none`. Add three commented-out lines: `# VLEI_API_KEY_VIEWER=`, `# VLEI_API_KEY_AGENT=`, `# VLEI_API_KEY_OPERATOR=` with comment explaining graduation. |
| B.1.4 | EXTEND | `…\api-server\lib\auth-middleware.js` | Add boxed startup warning logic to `validateAuthConfig`: if `AUTH_MODE=none` and bind host is NOT loopback (127.0.0.1 / ::1), print multi-line boxed warning to stderr. If `AUTH_MODE=api_key` and any required key missing, throw with descriptive error. On clean api_key startup, log `"3 keys loaded, role-based access enforced"`. |
| B.1.5 | NEW | `…\api-server\test\auth-middleware.test.js` | Unit tests: missing header → 401; valid viewer key on viewer route → 200; viewer key on agent route → 403; agent key on agent route → 200; agent key on operator route → 403. |

## Definition of Done

- [ ] With `AUTH_MODE=none`: every existing endpoint behaves identically to before B.1 (no regression).
- [ ] With `AUTH_MODE=api_key` and matching Bearer keys:
  - Viewer route + viewer/agent/operator key → 200 each
  - Agent route + viewer key → 403; + agent/operator key → 200
  - Operator route + viewer/agent key → 403; + operator key → 200
- [ ] Missing Authorization header in `api_key` mode → 401.
- [ ] `AUTH_MODE=api_key` + any key missing → throws and exits 1.
- [ ] `AUTH_MODE=none` on `0.0.0.0` → boxed warning to stderr at startup.
- [ ] `AUTH_MODE=none` on `127.0.0.1` → no warning, just informational log.
- [ ] Existing 4D demo workflow + Phase A KRAM tests both still pass.

## Test gate

```bash
# In AUTH_MODE=none
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/health           # 200
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/buyer/status # 200

# Switch to api_key with real keys, restart
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/buyer/status # 401
curl -s -H "Authorization: Bearer $VIEWER" -o /dev/null -w "%{http_code}\n" \
  http://localhost:4000/api/buyer/status                                         # 200
curl -s -H "Authorization: Bearer $VIEWER" -o /dev/null -w "%{http_code}\n" \
  http://localhost:4000/api/buyer/verify/ext/seller                              # 403

# Unit tests
cd api-server && npm test test/auth-middleware.test.js
# All passing

# Revert .env to AUTH_MODE=none for rest of development
```

**⚠️ STOP. Verify the test gate before starting B.2.**

---

# Iteration B.2 — Status walker + bootstrap

**Time:** 8–10 hours
**Depends on:** A.1 (config schema fixed). Works in either AUTH_MODE.

## What you'll do
Two scripts: `manage-status.sh` (read-only inventory tree) and `bootstrap-root-qvi.sh` (idempotent GEDA+QVI setup). Both shell out to existing `task-scripts/`.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| B.2.1 | NEW | `…\legentvLEI\manage-status.sh` | Read-only walker. Reads ONLY per-alias files in `task-data/` (e.g. `Jupiter_Knitting_Company-info.json`). **Never reads** shared `le-info.json` or `le-aid.txt`. Reads active config JSON. Prints tree: Company → Officers → Agents → Sub-agents with AIDs and credential statuses. Supports `--json` (structured output), `--help`. |
| B.2.2 | NEW | `…\legentvLEI\bootstrap-root-qvi.sh` | Extracts Section 2 of `run-all-buyerseller-4C-with-agents.sh` (GEDA + QVI setup). Shells out to `task-scripts/geda/*.sh` and `task-scripts/qvi/*.sh` — does NOT reimplement. Idempotent: detects existing GEDA AID and exits 0 with "already bootstrapped". |

## Definition of Done

- [ ] `./manage-status.sh` shows existing Jupiter/Tommy/Acme trees correctly with AIDs and credential statuses.
- [ ] `./manage-status.sh --json | jq .` parses cleanly (valid JSON).
- [ ] `grep -E "le-info.json\|le-aid.txt" manage-status.sh` returns nothing (Caveat C compliance).
- [ ] `./bootstrap-root-qvi.sh` on fresh env produces identical GEDA+QVI state as the 4C Section 2 manual run.
- [ ] Second `bootstrap-root-qvi.sh` run exits 0 with "already bootstrapped, nothing to do".
- [ ] Both scripts have `--help` with clear usage banner.

## Test gate

```bash
# Fresh environment
./stop.sh && docker-compose down -v && docker-compose up -d

./bootstrap-root-qvi.sh
./manage-status.sh
# Shows GEDA + QVI, no companies

./manage-status.sh --json | jq '.qvi.aid'
# Returns valid AID prefix

./bootstrap-root-qvi.sh
# "already bootstrapped, nothing to do", exit 0

# After existing 4D pipeline has run with 3 companies
./manage-status.sh
# Shows 3 companies, their officers, agents
```

**⚠️ STOP. Verify the test gate before starting B.3.**

---

# Iteration B.3 — DD Bearer header on fetch sites (C2)

**Time:** 2–3 hours
**Depends on:** B.1 (server understands Bearer) and A.2 (env vars exist)

## What you'll do
This is C2 from the original plan, deferred from A.2. Now needed because Bearer auth is in play. Identify the 4 fetch sites in DD agents that hit vLEI, build headers conditionally on `VLEI_API_KEY_AGENT` being set.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| B.3.1 | READ FIRST | `…\src\agents\buyer-agent\index.ts` | Identify the 2 `fetch()` calls that hit vLEI api-server. Note line numbers. |
| B.3.2 | READ FIRST | `…\src\agents\seller-agent\index.ts` | Same — find the 2 vLEI-bound fetches. |
| B.3.3 | READ | `…\src\agents\seller-agent\_patch_handleBuyerCounterOffer.ts` | One-time investigation: is this a side-patch (skip) or does it contain a vLEI fetch site (include)? Document decision in a code comment. |
| B.3.4 | MODIFY | `…\src\agents\buyer-agent\index.ts` | At each of the 2 vLEI fetch sites: build headers object conditionally — if `process.env.VLEI_API_KEY_AGENT` is set, include `Authorization: Bearer ${apiKey}`. Use `process.env.VLEI_API_BASE_URL` for URL — remove any hardcoded `localhost:4000`. |
| B.3.5 | MODIFY | `…\src\agents\seller-agent\index.ts` | Same pattern for the 2 seller fetches. |

## Definition of Done

- [ ] All 4 fetch sites use `process.env.VLEI_API_BASE_URL` (no hardcoded `localhost:4000` anywhere).
- [ ] All 4 attach Bearer header conditionally on `VLEI_API_KEY_AGENT` being set.
- [ ] With `AUTH_MODE=none` on server and key unset on DD → negotiation works.
- [ ] With `AUTH_MODE=api_key` on server and key unset on DD → DD fetches return 401 (expected; graduation not yet done).
- [ ] With `AUTH_MODE=api_key` on server and key set on DD → negotiation works.
- [ ] `_patch_handleBuyerCounterOffer.ts` decision documented in code comment.

## Test gate

```bash
grep -rn "localhost:4000" src/agents/buyer-agent/ src/agents/seller-agent/
# Empty result

# Server in AUTH_MODE=none, DD key unset
./run-all-agents.sh
# Negotiation works

# Server in AUTH_MODE=api_key, DD key set
./run-all-agents.sh
# Negotiation works with auth

# KRAM still works alongside Bearer
SIGNING_MODE=kram ./run-all-agents.sh
# Works — KRAM headers + Bearer header both present
```

**⚠️ STOP. Verify the test gate before starting B.4.**

---

# Iteration B.4 — Company lifecycle (shell + REST)

**Time:** 12–17 hours
**Depends on:** B.1, B.2

## What you'll do
First of four lifecycle scripts. Build `manage-company.sh` for add/remove. Build the `lifecycle-runner.js` helper. Wire `POST/DELETE /api/lifecycle/company` endpoints into `server.js`.

This is the first lifecycle script, so it will establish the pattern for B.5, B.6, B.7. Spend time getting the structure right — the next three scripts copy-and-adapt from this one.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| B.4.1 | NEW | `…\legentvLEI\manage-company.sh` | Add mode: append to config (write through), then shell out to `task-scripts/le/*.sh` for AID creation, OOBI exchange, registry creation, LE credential issuance, presentation to Sally. Idempotent (skip if alias exists). Remove mode: refuse if officers exist (parse from config), unless `--force`. Delete LE from KERIA, clean per-alias files, archive entry in config. Supports `--dry-run`, `--config`, `--force`, `--json`, `--help`. |
| B.4.2 | NEW | `…\api-server\lib\lifecycle-runner.js` | Helper module. Exports `runLifecycle(scriptName, mode, args)`. Validates input against an allowlist. Shells out via `child_process.spawn` (NOT `exec` — avoid shell injection). Whitelisted scripts only. Captures stdout+stderr+exitCode, parses `--json` output, returns structured result. |
| B.4.3 | MODIFY | `…\api-server\server.js` | Add two routes: `POST /api/lifecycle/company` (body: `id`, `name`, `lei`, `alias`) and `DELETE /api/lifecycle/company/:alias` (body: `revocationMode`, `confirmationToken`, `cascade`). Both protected by `requireRole('operator')`. Each route calls `lifecycle-runner.js` with the corresponding mode. |

## Definition of Done

- [ ] `./manage-company.sh add --id acme --name "Acme Corp" --lei <valid 20-char LEI> --alias Acme_Corp` succeeds end-to-end.
- [ ] `./manage-status.sh` after add shows Acme_Corp as empty shell (no officers yet).
- [ ] Re-adding same alias → "already exists, skipping", exit 0 (idempotent).
- [ ] `./manage-company.sh remove --alias Acme_Corp` succeeds.
- [ ] Removing a company with officers → refuses with clear "still has officers" message and exit non-zero.
- [ ] Same command with `--force` removes it anyway.
- [ ] `--dry-run` on both add and remove prints planned actions without executing.
- [ ] `curl -X POST` with operator key creates a company.
- [ ] HTTP-created company is byte-identical in `task-data/` and config to a shell-created company.
- [ ] DELETE with `revocationMode: soft` (default) marks inactive but keeps data.
- [ ] DELETE with `revocationMode: immediate` and matching `confirmationToken` (regex `REVOKE-{alias}-{YYYY-MM-DD}`) performs TEL revocation.
- [ ] DELETE with wrong token → 400.
- [ ] POST/DELETE with viewer or agent role → 403.
- [ ] `lifecycle-runner.js` rejects any script name not in its allowlist.

## Test gate

```bash
# Shell path
./manage-company.sh add --id acme --name "Acme Corp" --lei "549300ABC123DEF45678" --alias Acme_Corp
./manage-status.sh                                       # Shows Acme_Corp
./manage-company.sh add --alias Acme_Corp                # "already exists", exit 0
./manage-company.sh remove --alias Acme_Corp
./manage-status.sh                                       # Gone

# HTTP path (server in AUTH_MODE=api_key)
curl -X POST -H "Authorization: Bearer $OPERATOR" -H "Content-Type: application/json" \
  -d '{"id":"acme","name":"Acme Corp","lei":"549300ABC123DEF45678","alias":"Acme_Corp"}' \
  http://localhost:4000/api/lifecycle/company           # 201

./manage-status.sh                                       # Shows Acme_Corp (HTTP-created)

# Auth boundary
curl -X POST -H "Authorization: Bearer $AGENT" ...      # 403
curl -X POST ...                                         # 401

# Hierarchy guard (Jupiter has officers from existing 4D run)
curl -X DELETE -H "Authorization: Bearer $OPERATOR" \
  http://localhost:4000/api/lifecycle/company/Jupiter_Knitting_Company    # 409 "has officers"
```

**⚠️ STOP. Verify the test gate before starting B.5.**

---

# Iteration B.5 — Officer lifecycle (shell + REST)

**Time:** 11–16 hours
**Depends on:** B.4 (pattern established)

## What you'll do
Copy-and-adapt from B.4. Officer = Person AID + OOR credential. Two-step OOR issuance per the existing 4D workflow.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| B.5.1 | NEW | `…\legentvLEI\manage-officer.sh` | Add mode: Person AID creation, OOBI exchanges with LE/QVI/Verifier, two-step OOR issuance (LE→OOR_AUTH→QVI; QVI→OOR→Person), presentation to Sally. Shells out to `task-scripts/person/*.sh`. Refuses if parent company missing. Remove mode: refuses if delegated agents exist unless `--force`; optional `--revoke` for TEL revocation. Same flag interface as B.4. |
| B.5.2 | MODIFY | `…\api-server\server.js` | Add `POST /api/lifecycle/officer` and `DELETE /api/lifecycle/officer/:alias`. Body for add: `parentCompanyAlias`, `id`, `name`, `alias`. Operator role. Reuses `lifecycle-runner.js`. |

## Definition of Done

- [ ] `./manage-officer.sh add --company Acme_Corp --id off1 --name "Jane Doe" --alias Acme_Officer1` succeeds end-to-end.
- [ ] `./manage-status.sh` shows Acme_Officer1 under Acme_Corp with OOR credential status verified.
- [ ] Add under non-existent company → refuses with "parent company not found".
- [ ] `./manage-officer.sh remove --alias Acme_Officer1` succeeds when no agents delegated.
- [ ] Remove refuses when agents are delegated.
- [ ] `--revoke` flag performs TEL revocation before local cleanup.
- [ ] HTTP POST/DELETE behave identically to shell paths.
- [ ] Auth boundaries enforced (operator only).

## Test gate

```bash
./manage-company.sh add --id acme --name "Acme Corp" --lei "..." --alias Acme_Corp
./manage-officer.sh add --company Acme_Corp --id off1 --name "Jane Doe" --alias Acme_Officer1
./manage-status.sh
# Shows officer with OOR verified

# Negative: officer under non-existent company
./manage-officer.sh add --company DoesNotExist --id x --name "x" --alias x
# Exit non-zero

# HTTP parity
curl -X POST -H "Authorization: Bearer $OPERATOR" -H "Content-Type: application/json" \
  -d '{"parentCompanyAlias":"Acme_Corp","id":"off2","name":"John Smith","alias":"Acme_Officer2"}' \
  http://localhost:4000/api/lifecycle/officer           # 201

# Cleanup
./manage-officer.sh remove --alias Acme_Officer1
./manage-officer.sh remove --alias Acme_Officer2
./manage-company.sh remove --alias Acme_Corp            # Succeeds (no officers left)
```

**⚠️ STOP. Verify the test gate before starting B.6.**

---

# Iteration B.6 — Agent lifecycle (with BRAN dual-write replacing A.3)

**Time:** 11–16 hours
**Depends on:** B.5

This is the iteration that introduces the **DD-local BRAN dual-write** per Q10 lock. It also **deletes the throwaway script from A.3.**

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| B.6.1 | NEW | `…\legentvLEI\manage-agent.sh` | Add mode: generate fresh 256-bit BRAN with `openssl rand -hex 32`, append to `task-data/agent-brans.json`, shell out to `task-scripts/agent/agent-delegate-with-unique-bran.sh`, resolve OOBIs, run verification chain. **Write BRAN to vLEI location AND to DD-local `.secret/agent-bran.txt` (perms 600) in the same invocation.** If DD write fails → roll back vLEI write. Remove mode: refuse if sub-agents exist, delete from KERIA, clean BOTH BRAN copies, clean info files. |
| B.6.2 | MODIFY | `…\api-server\server.js` | Add `POST /api/lifecycle/agent` and `DELETE /api/lifecycle/agent/:alias`. Body for add: `parentOfficerAlias`, `id`, `name`, `alias`, `canDelegate` (bool), `scope` (array). Operator role. |
| B.6.3 | DELETE | `…\legentvLEI\copy-brans-to-dd-local.sh` | **Delete the Phase A throwaway script.** `manage-agent.sh` now does the dual-write automatically. Document the deletion in commit message. |

## Definition of Done

- [ ] `./manage-agent.sh add --officer Acme_Officer1 --id ag1 --name "BuyerBot" --alias Acme_Agent1 --can-delegate true --scope buyer,negotiate` succeeds end-to-end.
- [ ] Fresh BRAN appears in BOTH paths in the same invocation:
  - `…\vLEIEnh1\legentvLEI\task-data\Acme_Agent1-bran.txt`
  - `…\DynDic3ent1\A2A\js\src\agents\Acme_Agent1\.secret\agent-bran.txt` (perms 600)
- [ ] Both files contain the same 64-hex-char BRAN value.
- [ ] Dual-write atomic: if DD write fails (simulate with permission denied), vLEI BRAN file gets removed too.
- [ ] `./manage-agent.sh remove --alias Acme_Agent1` cleans BOTH BRAN locations.
- [ ] HTTP POST `/api/lifecycle/agent` produces both files identically.
- [ ] HTTP DELETE cleans both files.
- [ ] If `--officer` doesn't exist → refuses.
- [ ] If sub-agents exist → remove refuses unless `--force`.
- [ ] **`copy-brans-to-dd-local.sh` no longer exists in the repo.**
- [ ] Phase A KRAM regression: a new agent created via `manage-agent.sh` works in `KramSigner` (signs + verifies correctly).

## Test gate

```bash
./manage-agent.sh add --officer Acme_Officer1 --id ag1 --name "BuyerBot" \
  --alias Acme_Agent1 --can-delegate true --scope buyer,negotiate

# Verify dual-write byte equality
cmp ./task-data/Acme_Agent1-bran.txt \
    C:/SATHYA/CHAINAIM3003/mcp-servers/DynDic3ent1/A2A/js/src/agents/Acme_Agent1/.secret/agent-bran.txt
# Exit 0

# Permissions check
ls -la C:/SATHYA/CHAINAIM3003/mcp-servers/DynDic3ent1/A2A/js/src/agents/Acme_Agent1/.secret/
# perms 600

# HTTP-created agent
curl -X POST -H "Authorization: Bearer $OPERATOR" -H "Content-Type: application/json" \
  -d '{"parentOfficerAlias":"Acme_Officer1","id":"ag2","name":"SellerBot","alias":"Acme_Agent2","canDelegate":false,"scope":["seller"]}' \
  http://localhost:4000/api/lifecycle/agent             # 201

# Verify HTTP-created agent dual-writes too
ls C:/SATHYA/CHAINAIM3003/mcp-servers/DynDic3ent1/A2A/js/src/agents/Acme_Agent2/.secret/

# KRAM regression: new agent works with KramSigner
# (point a DD process at Acme_Agent1's .secret/, run SIGNING_MODE=kram round-trip)

# Confirm throwaway is gone
ls C:/SATHYA/CHAINAIM3003/mcp-servers/vLEIEnh1/legentvLEI/copy-brans-to-dd-local.sh
# Not found
```

**⚠️ STOP. Verify the test gate before starting B.7.**

---

# Iteration B.7 — Sub-agent lifecycle + status endpoint

**Time:** 10–13 hours
**Depends on:** B.6

## What you'll do
Fourth and final lifecycle script. Add the read-only status endpoint that exposes what `manage-status.sh --json` produces.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| B.7.1 | NEW | `…\legentvLEI\manage-subagent.sh` | Add mode: validate parent agent has `canDelegate: true`. Validate scope is subset of parent's scope. Generate BRAN, append to `task-data/subagent-brans.json`. Shell out to existing `task-scripts/subagent/subagent-delegate-with-unique-bran.sh`. Remove mode: invoke existing `subagent-delete-from-keria.sh`, clean up per-alias files. |
| B.7.2 | MODIFY | `…\api-server\server.js` | Add `POST /api/lifecycle/subagent` + `DELETE /api/lifecycle/subagent/:alias`. Body for add: `parentAgentAlias`, `id`, `name`, `alias`, `scope`. Operator role. |
| B.7.3 | MODIFY | `…\api-server\server.js` | Add `GET /api/lifecycle/status` returning what `manage-status.sh --json` produces. Viewer role. |

## Definition of Done

- [ ] `./manage-subagent.sh add --agent Acme_Agent1 --id sub1 --name "Negotiator" --alias Acme_Sub1 --scope buyer` succeeds (parent canDelegate=true, scope subset).
- [ ] Refuses under parent with `canDelegate: false`.
- [ ] Refuses if scope not subset (e.g. parent scope `buyer,negotiate`, child scope `seller`).
- [ ] HTTP POST behaves identically.
- [ ] `GET /api/lifecycle/status` with viewer key returns full JSON tree (companies → officers → agents → sub-agents).
- [ ] GET with no auth in api_key mode → 401.
- [ ] Bottom-up removal enforced: `./manage-agent.sh remove --alias Acme_Agent1` refuses while sub-agents exist.

## Test gate

```bash
./manage-subagent.sh add --agent Acme_Agent1 --id sub1 --name "Negotiator" \
  --alias Acme_Sub1 --scope buyer
./manage-status.sh
# Shows sub-agent under agent

# Scope rule
./manage-subagent.sh add --agent Acme_Agent1 --alias bad --scope seller --id x --name x
# Rejected: "scope must be subset of parent's scope"

# canDelegate rule
./manage-subagent.sh add --agent Acme_Agent2 --alias bad --scope seller --id x --name x
# Rejected: "parent canDelegate=false"

# Status endpoint
curl -H "Authorization: Bearer $VIEWER" http://localhost:4000/api/lifecycle/status | jq .
# Full tree returned

# Bottom-up enforcement
./manage-agent.sh remove --alias Acme_Agent1            # Refused: sub-agent exists
./manage-subagent.sh remove --alias Acme_Sub1
./manage-agent.sh remove --alias Acme_Agent1            # Succeeds
```

**⚠️ STOP. Verify the test gate before starting B.8.**

---

# Iteration B.8 — Graduation to `AUTH_MODE=api_key`

**Time:** 2–3 hours
**Depends on:** B.7

**Note:** Phase B graduation skips the MCP check (item 8 of original 11-box). That check is deferred to Phase C.

## What you'll do
Generate three real keys with `openssl rand -hex 32`, paste into four `.env` files, flip the mode, restart everything, run the smoke matrix.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| B.8.1 | MODIFY | `…\legentvLEI\.env` | Uncomment three `VLEI_API_KEY_*` lines, paste keys generated by `openssl rand -hex 32`. Change `AUTH_MODE=none` → `AUTH_MODE=api_key`. |
| B.8.2 | MODIFY | `…\DynDic3ent1\A2A\js\src\agents\buyer-agent\.env` | Uncomment `VLEI_API_KEY_AGENT`, paste the agent key from B.8.1. |
| B.8.3 | MODIFY | `…\DynDic3ent1\A2A\js\src\agents\seller-agent\.env` | Same as B.8.2. |

## Definition of Done — partial 11-box checklist (MCP items deferred to Phase C)

- [ ] (1) `./manage-status.sh` shows healthy tree.
- [ ] (2a) Fresh company creatable via `./manage-company.sh add`.
- [ ] (2b) Fresh company creatable via `curl -X POST /api/lifecycle/company`.
- [ ] (2a) and (2b) produce byte-identical state.
- [ ] (2c) Via Claude/MCP → **DEFERRED to Phase C.**
- [ ] (3) Fresh agent removal cleans BOTH BRAN paths.
- [ ] (4) `/llms.txt` → **DEFERRED to Phase C.**
- [ ] (5) Drift test → **DEFERRED to Phase C.**
- [ ] (6) DD agents authenticate with Bearer in api_key mode.
- [ ] (7) Boxed warning prints in `none`, not in `api_key`.
- [ ] (8) State-change guard from Claude → **DEFERRED to Phase C.**
- [ ] (9) Three role boundaries enforced (viewer < agent < operator).
- [ ] (10) `--dry-run` works on all 5 lifecycle scripts.
- [ ] (11) Existing Jupiter↔Tommy + KRAM negotiation still works.

## Test gate

```bash
# Generate keys
VIEWER=$(openssl rand -hex 32)
AGENT=$(openssl rand -hex 32)
OPERATOR=$(openssl rand -hex 32)

# Paste into 3 .env files, restart vLEI server + DD agents

# Smoke matrix — 3 roles × 3 endpoint tiers
for ROLE_NAME in VIEWER AGENT OPERATOR; do
  ROLE_KEY=${!ROLE_NAME}
  for EP in /api/lifecycle/status /api/lifecycle/company /api/buyer/verify/ext/seller; do
    CODE=$(curl -s -w "%{http_code}" -H "Authorization: Bearer $ROLE_KEY" \
      http://localhost:4000$EP -o /dev/null)
    echo "$ROLE_NAME on $EP → $CODE"
  done
done
# Expected:
#   VIEWER on /api/lifecycle/status → 200
#   VIEWER on /api/lifecycle/company → 403
#   VIEWER on /api/buyer/verify/ext/seller → 403
#   AGENT on /api/lifecycle/status → 200
#   AGENT on /api/lifecycle/company → 403
#   AGENT on /api/buyer/verify/ext/seller → 200
#   OPERATOR on /api/lifecycle/status → 200
#   OPERATOR on /api/lifecycle/company → (200 GET or proper POST)
#   OPERATOR on /api/buyer/verify/ext/seller → 200

# Negotiation smoke
cd C:/SATHYA/CHAINAIM3003/mcp-servers/DynDic3ent1/A2A/js
SIGNING_MODE=kram ./run-all-agents.sh
# Buyer↔seller negotiation completes with Bearer + KRAM
```

**⚠️ STOP. Verify the test gate before starting B.9.**

---

# Iteration B.9 — End-to-end smoke + ops runbook

**Time:** 8 hours (1 day)
**Depends on:** B.8

## What you'll do
Codify the full lifecycle as a reproducible smoke test. Write the operations runbook. Make sure `--help` text on every lifecycle script carries Caveat A wording.

## Line items

| # | Action | Full path | What |
|---|---|---|---|
| B.9.1 | NEW | `…\legentvLEI\OPERATIONS_RUNBOOK.md` | Full operator runbook: initial setup, bootstrap procedure, daily ops (add/remove all 4 entities), graduation procedure (B.8), key rotation, troubleshooting common failures. |
| B.9.2 | MODIFY | All 5 `manage-*.sh` scripts | Add Caveat A wording to `--help` output: "Note: `remove` is a local-delete + archive. KERI history is permanently immutable. Use `--revoke` for irreversible TEL revocation." |
| B.9.3 | EXECUTE | (no file) | Run a full lifecycle stress test: bootstrap → add 3 companies → add 2 officers each → add 2 agents each → add 1 sub-agent each → tear down bottom-up. Document any issues found. |
| B.9.4 | NEW | `…\legentvLEI\test\smoke\full-lifecycle.sh` | Codified version of B.9.3 as a reproducible script with assertions. |

## Definition of Done — **PHASE B FINAL GATE**

- [ ] Runbook covers every documented operation with copy-pasteable commands.
- [ ] `--help` on all 5 lifecycle scripts mentions Caveat A.
- [ ] `./test/smoke/full-lifecycle.sh` runs end-to-end with zero manual intervention.
- [ ] Bottom-up teardown works without `--force` (because hierarchy guards correctly enforce order).
- [ ] Phase A KRAM regression: round-trip still works after all Phase B changes.
- [ ] Existing 4D demo workflow still completes.

## Test gate

```bash
# Full vertical slice on fresh environment
./stop.sh && docker-compose down -v && docker-compose up -d
./bootstrap-root-qvi.sh
./test/smoke/full-lifecycle.sh
# Completes without errors; all assertions pass

./manage-status.sh
# Empty after teardown

# KRAM regression
cd C:/SATHYA/CHAINAIM3003/mcp-servers/DynDic3ent1/A2A/js
SIGNING_MODE=kram ./run-all-agents.sh
# Works

# Existing demo
cd C:/SATHYA/CHAINAIM3003/mcp-servers/vLEIEnh1/legentvLEI
./run-all-buyerseller-4D-with-subdelegation.sh
# Works
```

---

# ✅ PHASE B COMPLETE

When all nine iterations' test gates pass, you have:

- **Three-role auth** enforced on every endpoint (viewer < agent < operator).
- **Five working lifecycle scripts:** `bootstrap-root-qvi.sh`, `manage-company.sh`, `manage-officer.sh`, `manage-agent.sh`, `manage-subagent.sh`, plus the read-only `manage-status.sh`.
- **Five REST lifecycle endpoints:** POST/DELETE for company, officer, agent, sub-agent, plus GET /status.
- **BRAN dual-write** atomic on agent creation/removal.
- **Phase A KRAM** still works alongside Bearer auth.
- **Existing 4D demo workflow** still works.
- **Production-shippable system.** Stop here if MCP/LLM access isn't urgent.

## What's deferred to Phase C

Three items from the original 11-box checklist remain:
- Item 2c: Fresh company creatable via Claude/MCP
- Item 4: `curl /llms.txt` returns catalog
- Item 5: Drift test passes in CI
- Item 8: State-change guard blocks unconfirmed destructive calls from Claude

These are all about LLM accessibility. Defer freely.
