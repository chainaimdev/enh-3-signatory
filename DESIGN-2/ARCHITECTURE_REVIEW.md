# vLEI + DynDic3ent — Architecture Review

**Author:** Sathya Bala
**Date:** 2026-05-25
**Status:** Consolidated review of three design documents — no code
**Scope:** Both projects — `vLEIEnh1\legentvLEI` and `DynDic3ent1\A2A\js`

This document is a plain-English synthesis of:

1. `DESIGN-2\vLEI-ENH-Design-1-Sathya-Bala-Hybrid.md` — security strategy
2. `DESIGN-2\vLEI-ENH-Design-1-Sathya-Bala-DetailedDesign.md` — API operationalisation
3. `legentvLEI\MODULAR_LIFECYCLE_PLAN.md` — shell-script modularisation

These three documents solve **two different problems** at **two different layers** of the system. This review explains how they fit together as a single coherent plan, and what the end-state architecture looks like.

---

## 1. The two problems being solved

The three documents may at first read like one big plan, but they are actually solving two separate problems that meet at a single integration point.

### Problem A — Authentication, signing, and AI accessibility

**The pain today.** The API server on port 4000 has fifteen routes, listens on all network interfaces, and has no authentication. Any process that can reach the port can call any endpoint, including the ones that issue cryptographic credentials. There is no way for an LLM (Claude or otherwise) to discover what endpoints exist or to call them safely. Agents in `DynDic3ent1` make four HTTP calls into this server with no identity proof on the request.

**The solution.** A four-layer security and discoverability stack: Bearer API keys with three roles (Phase 1), an optional deeper KERI-signed-headers layer called KRAM (Phase 1b), a public catalog file at `/llms.txt` describing every endpoint (Phase 2), and a new TypeScript project `mcp-vlei` that exposes a two-tool interface to LLMs over MCP (Phase 3). Authentication starts unlocked by default so testing is friction-free and graduates to fully-locked production with a single environment-variable flip.

**Documents:** Hybrid (strategy) + DetailedDesign (operationalisation).

### Problem B — Modular lifecycle management

**The pain today.** Everything runs through one monolithic pipeline — `run-all-buyerseller-4D-with-subdelegation.sh` — that sets up root of trust, sets up QVI, creates every company, creates every officer, creates every agent, and creates every sub-agent in one shot. This is fine for a demo. It is unusable in production. Adding a third company today literally breaks the pipeline because of a hardcoded function (`get_keria_alias`) that only knows about Jupiter and Tommy.

**The solution.** Split the monolith into one one-time bootstrap and five small lifecycle scripts, each managing one entity type with `add` and `remove` modes. These scripts are smart coordinators — they call the existing low-level scripts in `task-scripts/le/`, `task-scripts/person/`, `task-scripts/agent/`, `task-scripts/subagent/` without rewriting them. The proven cryptographic logic stays exactly as it is; only the orchestration gets reorganised.

**Documents:** MODULAR_LIFECYCLE_PLAN.

### The integration point

The two tracks meet at one place: **every lifecycle script also gets a matching REST API endpoint**. Registering a company can be triggered by running `manage-company.sh add` directly from the terminal, OR by sending a `POST /api/lifecycle/company` HTTP request from the UI, OR by an LLM calling the MCP `vlei_call_endpoint` tool. All three paths converge on the same shell script underneath. One brain, three faces.

This is the user's own architectural insight and is the bridge that turns three independent design documents into one coherent plan.

---

## 2. End-state architecture — four layers

```
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 1 — LLM / AI agent access                                    │
│  ──────────────────────────────                                     │
│  Claude (or any MCP-capable LLM) uses mcp-vlei                      │
│  Two tools: vlei_search_endpoints, vlei_call_endpoint               │
│  Catalog driven (reads /llms.txt at startup)                        │
│  State-change guard on destructive operations                       │
│  Holds an operator-role Bearer key                                  │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ HTTPS + Bearer
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 2 — HTTP API (port 4000)                                     │
│  ──────────────────────────────                                     │
│  Existing 15 endpoints (verification, IPEX issue/admit, status)     │
│  New: GET /llms.txt (no auth, public catalog)                       │
│  New: POST/DELETE /api/lifecycle/{company,officer,agent,subagent}   │
│  Middleware: requireRole + optional requireKram                     │
│  Three roles: viewer / agent / operator                             │
│  Two AUTH_MODE settings: none (default, test) / api_key (prod)      │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ shells out
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 3 — Lifecycle orchestration (shell)                          │
│  ──────────────────────────────                                     │
│  bootstrap-root-qvi.sh           (one-time, GEDA + QVI)             │
│  manage-company.sh    add | remove                                  │
│  manage-officer.sh    add | remove                                  │
│  manage-agent.sh      add | remove                                  │
│  manage-subagent.sh   add | remove                                  │
│  manage-status.sh     read-only inventory                           │
│  All five share the same flag interface (--dry-run, --config,       │
│  --force, --json) and the same idempotency contract                 │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼ calls existing scripts
┌─────────────────────────────────────────────────────────────────────┐
│  LAYER 4 — Low-level task scripts (unchanged)                       │
│  ──────────────────────────────                                     │
│  task-scripts/le/      le-aid-create, le-acdc-issue-oor-auth, ...   │
│  task-scripts/person/  person-aid-create, ...                       │
│  task-scripts/agent/   agent-delegate-with-unique-bran, ...         │
│  task-scripts/subagent/ subagent-delete-from-keria, ...             │
│  task-scripts/qvi/, task-scripts/geda/, task-scripts/verifier/      │
└─────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
                        KERIA + Docker stack
```

The DD-side architecture sits parallel to layers 1–4, calling layer 2 over HTTP:

```
┌─────────────────────────────────────────────────────────────────────┐
│  DynDic3ent1\A2A\js — Negotiation business logic (unchanged)        │
│  ──────────────────────────────                                     │
│  buyer-agent (9090)   seller-agent (8080)   treasury-agent (7070)   │
│  credit-agent, inventory-agent, logistics-agent (out of scope)      │
│                                                                      │
│  Messaging layer:                                                   │
│    MessageSigner interface (unchanged)                              │
│    PlainHashSigner (today's MVP, unchanged)                         │
│    KramSigner (new, Phase 1b — uses signify-ts in-process)          │
│                                                                      │
│  Four HTTP call sites into vLEI api-server (Bearer header added)    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. What changes on the vLEI side

The `vLEIEnh1\legentvLEI` directory gains five things and modifies two.

**Gains:**

1. **A library folder** `api-server/lib/` containing the Bearer-auth middleware and (later) the KRAM verify middleware. This is the only new dependency-free Phase-1 code.
2. **One one-time bootstrap script** and **five lifecycle scripts** at the project root, replacing what the monolithic 4D pipeline does.
3. **An API endpoint family** `/api/lifecycle/*` that thin-wraps the lifecycle scripts. Same operation, two front doors — the shell terminal and the HTTP API.
4. **A public catalog file** `vlei-llms.txt` listing every non-deprecated endpoint (the existing 15 plus the new lifecycle ones), served at `GET /llms.txt`.
5. **A brand-new TypeScript subproject** `vLEIEnh1\mcp-vlei\` containing the MCP server that exposes two tools to LLMs.

**Modifications:**

1. **The hardcoded `get_keria_alias` function** in `generate-unique-agent-brans.sh` becomes config-driven. This single fix unblocks the entire lifecycle modularisation.
2. **`server.js`** gains middleware imports, role-based protection on every existing route, and the new lifecycle routes.

**Deliberately unchanged:**

- All scripts under `task-scripts/` — they are reused as-is.
- The KERIA Docker setup.
- The credential schemas (invoice, OOR, ECR, etc).
- The monolithic 4D script — it is not deleted; it remains as a reference. Over time it becomes equivalent to "run bootstrap once, then loop through the config calling the four manage-* scripts."

---

## 4. What changes on the DynDic3ent1 side

`DynDic3ent1\A2A\js` gains exactly one new dependency, one new file, and four small modifications.

**Gain:**

1. **`signify-ts`** as a new npm dependency (Phase 1b only). Phase 1 ships without it.
2. **A new file** `src/messaging/KramSigner.ts` implementing per-message KERI signing using the agent's own controller key.

**Modifications:**

1. **The `MessageSigner` factory** in `src/messaging/index.ts` gains a case for `"kram"` signing mode alongside the existing `"plain"` and (deferred) `"vlei"`.
2. **`signed-message.ts`** extends the `SigningMode` type to include `"kram"` and adds one new failure-reason enum entry.
3. **Four HTTP fetch call sites** in `buyer-agent/index.ts` and `seller-agent/index.ts` get an optional Bearer header — sent only when `VLEI_API_KEY_AGENT` is set, omitted otherwise. This keeps the test phase friction-free.
4. **Two `.env` files** (`buyer-agent/.env` and `seller-agent/.env`) gain a `VLEI_API_BASE_URL` line and a commented-out `VLEI_API_KEY_AGENT` line for graduation.

**Deliberately unchanged:**

- All business logic — offer/counter/accept flow, discount calculations, pricing rules, A2A protocol handlers.
- The other agents (credit, inventory, logistics) — out of Design 1 scope.
- The treasury-agent — internal microservice on port 7070, not involved in cross-company A2A.

---

## 5. The KATE principle — why each DD agent signs its own messages

The most important architectural decision on the DD side is that each agent process holds its own cryptographic seed (called a BRAN) and signs its own outbound messages **in-process** using the `signify-ts` library. The DD agents do not ask the vLEI side to sign on their behalf.

This is called the "Key At The Edge" principle, taken directly from KERI's official guidance. The DetailedDesign explicitly rejects the alternative ("let vLEI be a signing oracle") on three grounds:

1. **No precedent.** Every published KERI pattern for "where signify-ts runs" puts it inside the process that needs to sign — never as a trusted-backend service signing for other trusted backends.
2. **No attack-surface reduction.** The BRAN still has to live somewhere on the DD side anyway. Moving signing to vLEI just adds an HTTP round trip per message without removing the secret from DD memory.
3. **Centralised risk.** A vLEI signing oracle holding BRANs for every agent would be a single point of total compromise — break in once, compromise every identity.

A practical consequence: at agent provisioning time, each agent's BRAN gets written to **two** locations — the existing `vLEIEnh1\legentvLEI\task-data\{alias}-bran.txt` (for the existing shell-script pipeline) AND a DD-local location like `DynDic3ent1\A2A\js\src\agents\buyer-agent\.secret\agent-bran.txt` with permissions locked down. The DD agent reads its local copy. Provisioning scripts gain one extra copy + permission step per agent.

---

## 6. The graduation principle — test without keys, then flip a switch

A second principle that pervades the auth design: the system defaults to **unauthenticated** during development and testing, prints a loud boxed startup warning so the state is operationally obvious, and graduates to fully authenticated with a single environment variable flip.

This applies at two layers:

- **vLEI api-server.** `AUTH_MODE=none` by default — the Bearer middleware just calls `next()` and lets the request through. `AUTH_MODE=api_key` activates the role enforcement. No code changes between test and production.
- **DD agents.** The Bearer header is attached only when `VLEI_API_KEY_AGENT` is set in the agent's `.env`. Missing key → no header sent. This matches the vLEI side's default-open behaviour. When you graduate, you uncomment the key line in both agents and the vLEI side, restart, and authentication just starts working.

The graduation path is intentionally small: generate three keys (`openssl rand -hex 32`), paste them into three places, flip one environment variable. That is the entire production-hardening procedure for authentication.

---

## 7. The message-security strategy — three tiers

Cross-company A2A messages are not all equal. Some are throwaway negotiation chatter. Others legally commit a party to terms. The Hybrid document defines three tiers of cryptographic protection, matched to each message class:

**Tier 1 — Plain envelopes (today's MVP).**
SHA-256 hash + monotonic counter + ISO timestamp. Replay-protected and tamper-evident, but offers no per-message non-repudiation. If a counterparty later disputes a specific offer, the only evidence is the authenticated-session log. This is what `PlainHashSigner` already provides.

**Tier 2 — KRAM (Phase 1b).**
Each outbound HTTP request gets KERI-signed headers (`Signify-Resource`, `Signify-Timestamp`, `Signature-Input`, `Signature`) plus a body integrity header (`Content-Digest`, per RFC 9530). Per-message cryptographic non-repudiation. Each message is provably signed by the sending agent's controller key. Court-defensible at the message level. This is what `KramSigner` will provide.

**Tier 3 — ACDC + IPEX grant/admit (Phase 4).**
Legally binding commitments — accept-offer, accept-discount, order, cancel — get wrapped as full ACDC credentials, anchored in the issuer's TEL registry, and exchanged via the IPEX grant/admit protocol. This is the strongest tier, reserved for messages that must survive in a court or compliance review. Four new schemas are needed: `A2AAccept`, `A2ADDAccept`, `A2AOrder`, `A2ACancel`.

The recommendation matrix from Hybrid §5 maps each message type to a tier. Negotiation chatter (`OFFER`, `COUNTER`, `INQUIRY`) uses Tier 2. Legal commitments use Tier 3. Discovery operations use no signing. First-contact handshake uses a one-shot challenge-response.

---

## 8. The lifecycle architecture — top-down add, bottom-up remove

The MODULAR_LIFECYCLE_PLAN imposes a strict hierarchy:

```
QVI (bootstrap, one time)
 └─ Company           (Legal Entity)        manage-company.sh
     └─ Officer       (Person + OOR)        manage-officer.sh
         └─ Agent     (AI agent)            manage-agent.sh
             └─ Sub-agent                   manage-subagent.sh
```

**Adds go top-down.** Each script refuses to create an entity whose parent does not exist. You cannot add an officer before the company is registered. You cannot add a sub-agent before the agent is registered.

**Removes go bottom-up.** Each script refuses to remove an entity that still has children, unless `--force` is passed. You cannot remove a company that still has officers. You cannot remove an agent that still has sub-agents. This safety block is the single most important guard in the lifecycle layer.

**Read-only inventory** (`manage-status.sh`) walks the tree and shows you what exists and what depends on what. It is the cheapest script to build and the most useful — you will want to run it before every add (to see what already exists) and before every remove (to see what depends on what).

---

## 9. Five cross-cutting rules for the lifecycle layer

These apply uniformly to all five lifecycle scripts:

1. **Config is the single source of truth.** Adds update the config JSON first, then KERIA. Removes update KERIA first, then the config. This ordering prevents the config from claiming something exists when KERIA does not have it (or vice versa) if a script crashes mid-operation.

2. **Idempotent and resumable.** Every script first checks "does this entity already exist?" Adds skip with a notice if yes. Removes skip with a notice if no. Matches how the existing 4D script already behaves.

3. **Consistent flag interface.** All five scripts accept the same flags — `--dry-run`, `--config`, `--force`, `--json`. The `--json` flag is what the API endpoint layer uses to consume structured output instead of parsing terminal text.

4. **Lifecycle metadata in the config.** Every entity in the config tree gains `createdAt`, `createdBy`, and `status` fields (`active` / `archived` / `removed`). Audits, rollback, and reporting all become possible.

5. **Removal defaults to local delete + archive.** "Remove" means stop using the entity locally and clean up files. True credential revocation (TEL-anchored, irreversible) is opt-in via `--revoke`. The DELETE API endpoints map this to the extensible `revocationMode` enum (`soft` default, `scheduled`, `immediate`) from DetailedDesign §3.6.

---

## 10. Three caveats every developer must know

From MODULAR_LIFECYCLE_PLAN §6 — these are real constraints, not theoretical concerns:

**Caveat A — KERI history is permanently immutable.**
When you "remove" an agent, you are locally deleting its alias from KERIA. The Key Event Log events still exist and are still anchored in the parent's KEL on the witnesses. "Remove" really means stop-using-locally plus clean-up-files. Genuine revocation that makes verifiers reject the credential forever is a different TEL-based operation. The `--revoke` flag is opt-in, not default, for this reason.

**Caveat B — A hardcoded function will block expansion.**
In `generate-unique-agent-brans.sh`, the function `get_keria_alias` literally checks for the strings "Jupiter" and "Tommy" in the org name. A third company added today will be assigned `unknownAgent` and the workflow will break. **This must be fixed before any lifecycle script will work for arbitrary new companies.** It is the single highest-priority change in the entire plan.

**Caveat C — Some files are shared across LEs.**
The current 4C orchestrator overwrites `task-data/le-info.json` and `task-data/le-aid.txt` each time a new LE is processed. Only the per-alias files (`Jupiter_Knitting_Company-info.json`, `Tommy_Hilfiger_Europe-info.json`) are truly per-entity. The new lifecycle scripts must read only per-alias files and ignore the shared ones — otherwise they will read stale state from the last LE that was processed.

---

## 11. Revocation — the extensible design

DetailedDesign §3.6 (PD-2 lock) replaces the original binary `revoke=true|false` flag with a four-mode extensible design:

| Mode | Behaviour | Reversible | Extra confirmation |
|---|---|---|---|
| `soft` (default) | Flip an "inactive" flag, no TEL change | Yes — flip it back | None |
| `scheduled` | Schedule an immediate revocation for a future timestamp | Yes, until scheduled time | None to schedule; DELETE to cancel |
| `immediate` | TEL revocation issued now, permanent | No | `confirmationToken` of form `REVOKE-{alias}-{YYYY-MM-DD}` |
| `immediate` + `cascade` | Same applied to all descendants | No | Token PLUS `cascade_immediate_confirmed: true` |

Three separate signals are required to permanently wreck a whole subtree: explicit `revocationMode=immediate`, explicit `confirmationToken`, explicit `cascade_immediate_confirmed=true`. Hard to do by accident.

Two new SQLite tables (`revocations`, `entity_status`) provide the audit trail and the current-status lookup that verifiers consult when deciding whether to honour a credential issued by an inactive entity.

---

## 12. The recommendation matrix for A2A messages

From Hybrid §5 — this is the operational rulebook for which cryptographic treatment each message type gets:

| Message class | Examples | Treatment |
|---|---|---|
| Discovery | OOBI resolution, schema lookup | No signing |
| First handshake | Initial cross-company contact | Mutual challenge-response (one-time) |
| Liveness / health | Ping, heartbeat, status pull | KRAM-signed HTTP (Phase 1b) |
| Negotiation chatter | OFFER, COUNTER, INQUIRY, BID, ASK | KRAM-signed HTTP (Phase 1b) |
| Authoritative status writes | "Order now in fulfilment" | KRAM-signed HTTP (Phase 1b) |
| Legal commitments | ACCEPT, DD_ACCEPT, ORDER, CANCEL | ACDC + IPEX grant/admit (Phase 4) |
| Sub-agent introduction | "Here's my delegation chain" | ACDC presentation (one-shot grant) |
| Dispute escalation | "I dispute commitment X" | ACDC + IPEX (auditable evidence) |
| Multi-party events | "All three counterparties agreed" | ACDC + IPEX with multisig (out of scope) |

Two notes on the matrix:

- **Before Phase 1b ships, negotiation chatter falls back to plain envelopes (`PlainHashSigner`).** That is the current state. KRAM is the upgrade target.
- **No message uses custom-route `exn` messages** (the "Option 4b" path from Hybrid §4.3). That option exists and is documented, but is held in reserve because it relies on KERIA mailbox transport which adds latency, and because there is no GLEIF reference verifier for custom routes.

---

## 13. The production network preset

DetailedDesign §3.7 (PD-3 lock) handles the question "what does GLEIF production deployment look like?"

Today `resolve-env.ts` supports two presets:

- `docker` (default) — local witness pool, what dev and CI use today.
- `testnet` — GLEIF testnet, hardcoded `*.testnet.gleif.org` URLs.

A third preset `gleif-prod` gets added. Critically, **all production URLs come from environment variables, not hardcoded values**. The operator pastes the actual production URLs from GLEIF's onboarding documentation into a `.env` file. If any required environment variable is missing at startup, the resolver throws — better than silently using wrong endpoints.

The pattern is extensible. Future presets (private AWS-hosted KERIA cluster, alternate regions, partner federations) follow the same shape: add a new case arm to the switch statement, add a new environment-variable family, document them in `.env.example`. No architectural change at any step.

---

## 14. What is deliberately out of scope

To keep the design honest:

- **No changes to root or QVI workflow.** The bootstrap script is a one-time extraction of existing Section 2 of `run-all-buyerseller-4C-with-agents.sh`.
- **No changes to credential schemas.** Invoice, OOR, ECR, LE — all keep their current SAIDified definitions.
- **No new Docker services.** Only orchestration shell scripts, an Express server modification, and a new TypeScript subproject.
- **No replacement of existing `task-scripts/`.** They are reused as-is.
- **No changes to DynDic3ent1 business logic.** Negotiation, pricing, discount curves — all untouched.
- **No work on credit-agent, inventory-agent, logistics-agent.** Out of Design 1 scope.
- **No multi-signature commitment ACDCs.** Mentioned in Hybrid §5 footnote but out of scope.
- **No mobile wallet integration.** Veridian, Sparán etc are noted as future work.

---

## 15. The one-page mental model

If you remember nothing else, remember this:

**vLEI side becomes a properly gated identity service.** Same fifteen endpoints, but now behind role-based Bearer auth that defaults open in dev and locks down with one env-var flip. Plus new lifecycle endpoints that wrap the new modular shell scripts. Plus a public catalog file describing everything. Plus a separate MCP server that exposes a two-tool interface to LLMs.

**DD side gets one new dependency and one new file.** The dependency is `signify-ts`. The file is `KramSigner.ts`. Four HTTP call sites get an optional Bearer header. The negotiation business logic is completely untouched.

**The shell-script layer gets split.** One monolithic 4D pipeline becomes one bootstrap plus five lifecycle scripts plus one read-only inventory tool. Each lifecycle script gets a matching `/api/lifecycle/*` REST endpoint. Same operation, two front doors — terminal and HTTP.

**The graduation principle.** Test phase = nothing locked, loud warning on startup. Production phase = three keys, one env-var flip, no code changes. The path between them is small and obvious.

**The KATE principle.** Each DD agent process holds its own cryptographic seed and signs its own messages. The vLEI side is never a signing oracle. Compromise of any one agent affects only that agent, not the whole system.

---

*End of architecture review. For the implementation plan with iterations and time estimates, see `IMPLEMENTATION_PLAN.md` in this directory.*
