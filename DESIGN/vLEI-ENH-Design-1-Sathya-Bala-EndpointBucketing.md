# vLEI Enhancement Design 1 — Endpoint Bucketing Guide

**Author:** Sathya Bala
**Date:** 2026-05-24
**Status:** Draft for review
**Companion to:** `vLEI-ENH-Design-1-Sathya-Bala.md`, `vLEI-ENH-Design-1-Sathya-Bala-Hybrid.md`

---

## §0 — Grounding

This bucketing is taken from code I actually read, not memory:

**DynDic3ent1 files read (paths absolute under `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\FINAGENTS1\DynDic3ent1`):**
- `A2A\js\src\api\onboarding-server.ts` — Express :6060 onboarding routes
- `A2A\js\src\agents\buyer-agent\index.ts` — buyer :9090, A2A SDK + REST routes, all message handlers
- `A2A\js\src\agents\seller-agent\index.ts` — seller :8080, A2A SDK + REST routes, all message handlers

**Vouched-for facts from the prior turns of this design session** (re-cite if needed):
- IPEX (`apply`/`offer`/`agree`/`grant`/`admit`) — `vlei-trainings\markdown\102_25_KERIA_Signify_Credential_Presentation_and_Revocation.md`
- Challenge-response — `vlei-trainings\markdown\101_45_Connecting_controllers.md` and workshop `qvi-challenge-geda.ts` trio
- KRAM (timestamp-bound request signing) — `vlei.wiki/concept/keri-request-authentication-method`
- `Authenticater.sign(headers, method, path)` and `Exchanges.createExchangeMessage(...)` — TypeDoc at `weboftrust.github.io/signify-ts/`

**Anything I label "assumption" below has not been verified by reading code** and is flagged accordingly per Rule 3.

---

## §1 — DynDic3ent1 actual endpoint inventory

### 1.1 Onboarding server (port 6060)
Source: `A2A\js\src\api\onboarding-server.ts`

| Route | Method | Purpose (from comments + body) |
|---|---|---|
| `/health` | GET | Liveness probe |
| `/api/onboard-counterparty` | POST | Register a new agent identity. Runs `checkCompliance()` against GLEIF API |
| `/api/counterparties` | GET | List onboarded agents from `live-agent-cards/` |
| `/api/counterparties/:name` | GET | Read one agent card |
| `/api/counterparties/:name` | DELETE | Tombstone (rename to `.tombstones/`), no hard delete |

### 1.2 Buyer agent (port 9090)
Source: `A2A\js\src\agents\buyer-agent\index.ts`

**A2A message routes** — set up by `new A2AExpressApp(handler).setupRoutes(app)`. I have not read the @a2a-js/sdk source so I do not know the exact route names the SDK exposes. **Assumption flag.** What I do know from the executor code is the *message-type* handlers:

| A2A message type | Direction | Where handled in buyer-agent |
|---|---|---|
| `OFFER` | sent (BUYER→SELLER) | `startNegotiation()` → `sendToSeller()` |
| `COUNTER_OFFER` | both directions | `handleSellerCounterOffer()` / `sendCounterOffer()` |
| `ACCEPT_OFFER` | both directions | `handleSellerAcceptance()` / `sendAcceptance()` |
| `REJECT_OFFER` | received | `handleSellerRejection()` |
| `ESCALATION_NOTICE` | sent | `escalateToHuman()` → `sendToSeller()` |
| `PURCHASE_ORDER` | sent | `sendPurchaseOrder()` (after `ACCEPT_OFFER`) |
| `INVOICE` | received | inline in `handleSellerMessage()` — calls api-server IPEX admit |
| `DD_OFFER` | received | `handleDDOffer()` — autonomous decision engine |
| `DD_ACCEPT` | sent | `autoAcceptDD()` → `sendToSeller()` |
| `DD_INVOICE` | received | `handleDDInvoice()` — calls api-server IPEX admit |

**REST/SSE routes the buyer agent serves (non-A2A):**

| Route | Method | Purpose |
|---|---|---|
| `/negotiate-events` | GET | SSE stream for the React UI |
| `/api/notify-status` | GET | Reports which notification channels are active |
| `/api/identity-mode` | GET | Reports `CREDENTIAL_MODE` (plain or vlei) |
| `/api/verify/seller` | POST | Runs `verifyCounterparty("buyer", "DEEP-EXT")`, returns step-by-step result |
| `/api/recent-deals` | GET | Lists last N audit JSONs from `src/escalations/*.audit.json` |
| `/api/quality/:negotiationId` | GET | Returns one audit JSON |
| `/api/quality/:negotiationId/pdf` | GET | Streams a PDF rendered from the audit JSON |
| `/api/baseline` | GET | Returns latest fixture-replay baseline |
| `/api/signing-mode` | GET | Reports `SIGNING_MODE` |
| `/api/mode-matrix` | GET | Reports credential+signing matrix |

### 1.3 Seller agent (port 8080)
Source: `A2A\js\src\agents\seller-agent\index.ts`

Same A2A message types as 1.2, with seller-side handlers:

| Handler | A2A message |
|---|---|
| `handleBuyerOffer()` | `OFFER` |
| `handleBuyerCounterOffer()` | `COUNTER_OFFER` |
| `handleBuyerAcceptance()` | `ACCEPT_OFFER` |
| `handlePurchaseOrder()` | `PURCHASE_ORDER` → triggers IPEX issue+grant + sends `INVOICE` + sends `DD_OFFER` |
| `handleEscalationNotice()` | `ESCALATION_NOTICE` |
| `handleDDAccept()` | `DD_ACCEPT` → triggers IPEX issue+grant + sends `DD_INVOICE` |
| `handleFinalRejection()` | sends `REJECT_OFFER` |

**Seller REST/SSE routes:**

| Route | Method | Purpose |
|---|---|---|
| `/negotiate-events` | GET | SSE stream |
| `/api/notify-status` | GET | Notification channel status |
| `/api/identity-mode` | GET | Reports `CREDENTIAL_MODE` |
| `/api/verify/buyer` | POST | Symmetric to buyer's `/api/verify/seller` |
| `/api/self/mode-status` | GET | Reports seller-response-mode (BASIC/L1/L2/L3/L4) |

### 1.4 Other services referenced in code (not in DynDic3ent1)

These are called by DynDic3ent1 but live in adjacent projects:

| URL | Origin | Used by | Purpose |
|---|---|---|---|
| `http://localhost:4000/api/buyer/ipex/admit` | `legentvLEI/api-server` | buyer-agent | IPEX admit of seller-issued credential |
| `http://localhost:4000/api/seller/ipex/issue-and-grant` | `legentvLEI/api-server` | seller-agent | IPEX issue+grant of invoice credential |
| `http://localhost:7070/consult` | `treasury-agent` (in DynDic3ent1) | seller-agent | ACTUS PAM solvency check before accepting a price |
| `http://localhost:7070/dd-cashflow-schedule` | `treasury-agent` | seller-agent | ACTUS DD cashflow schedule on DD accept |

I have not read treasury-agent or api-server source in this session. The treasury endpoint set is **assumption from the seller-agent call sites only.** api-server endpoints are vouched-for from the prior summary turn.

---

## §2 — Bucketing rules (recap, then applied)

Three buckets, in increasing weight:

- **No-auth** — discovery, OOBI fetch, schema lookup. Self-verifying or operational-only.
- **Light** — KRAM-signed HTTP header (`Authenticater.sign(headers, method, path)`). Per-request signature with timestamp window. Backed by `keria/docs/protocol.md` + `vlei.wiki/KRAM`. ~1ms crypto, single HTTP round trip.
- **Heavy** — ACDC + IPEX (`credentials().issue()` + `ipex().grant()` + `submitGrant()`). Registry-anchored, court-defensible, revocable. Backed by `102_25_KERIA_Signify_Credential_Presentation_and_Revocation.md`. Seconds per cycle.

Two orthogonal session-establishment primitives:
- **Mutual challenge-response** at handshake (`client.challenges().generate/respond/verify`). Backed by `101_45` and the workshop QVI trio. One-time per session.
- **OOBI resolution** at handshake (`client.oobis().resolve`). Self-verifying by KEL hash. Already in our codebase.

---

## §3 — DynDic3ent1 endpoint bucketing

### 3.1 Onboarding server :6060 — operator infrastructure

| Route | Bucket | Why |
|---|---|---|
| `GET /health` | **No-auth** | Liveness probe. No business value to signing it |
| `POST /api/onboard-counterparty` | **Light + operator-bound** | Mutates state (writes `live-agent-cards/`), invokes GLEIF API. The caller is the operator running the demo, not a counterparty agent. KRAM-sign with the operator's AID; or, if operator auth is out of scope for Design 1, leave on localhost-only behind a reverse proxy. **Note:** today this endpoint already runs GLEIF compliance internally; adding KRAM means *who is asking* gets the same rigour as *who is being onboarded* |
| `GET /api/counterparties` | **Light** | Read-only, but it lists who you've onboarded — operator-internal info. KRAM-sign |
| `GET /api/counterparties/:name` | **Light** | Same as list |
| `DELETE /api/counterparties/:name` | **Light** | Tombstones a counterparty. State mutation with audit consequences. KRAM-sign; the audit record then carries the operator's AID signature |

**Why not heavy on any of these:** the onboarding records aren't bilateral commitments. They're operator-internal facts. No counterparty will ever sue you over a row in `live-agent-cards/`. KRAM gives you "who-acted-when" without ACDC overhead.

### 3.2 Buyer/Seller A2A negotiation messages — the core of the design

This is where the §5 matrix from the hybrid doc directly applies. Restated for DynDic3ent1's actual message types:

| A2A message type | Bucket | Reason |
|---|---|---|
| `OFFER` | **Light** | Negotiation chatter. Not a commitment. KRAM-sign |
| `COUNTER_OFFER` | **Light** | Same — repeat back-and-forth, no legal weight per message |
| `REJECT_OFFER` | **Light** | Signals the end of negotiation but doesn't bind anyone to anything new |
| `ESCALATION_NOTICE` | **Light** | Informational — "we couldn't agree". Not a commitment |
| `ACCEPT_OFFER` | **Heavy** | The commitment moment. ACDC + IPEX. This is the message a court would care about |
| `PURCHASE_ORDER` | **Heavy** | Final commercial commitment. ACDC + IPEX. Buyer is bound to receive and pay |
| `INVOICE` | **Heavy** | Already wired as IPEX in the code (`api/seller/ipex/issue-and-grant`). Keep it heavy — invoices are tax-relevant and audit-relevant |
| `DD_OFFER` | **Light** | This is an offer with terms. Still negotiation, still not binding until accepted. KRAM-sign |
| `DD_ACCEPT` | **Heavy** | Buyer commits to an earlier settlement date with a discount. Legally binding. ACDC + IPEX |
| `DD_INVOICE` | **Heavy** | Already wired as IPEX. Keep it heavy |

**Cross-check against existing code:** lines in `seller-agent/index.ts` for `INVOICE` and `DD_INVOICE` already call `POST /api/seller/ipex/issue-and-grant`. Lines in `buyer-agent/index.ts` for those same types already call `POST /api/buyer/ipex/admit`. So **invoices are already heavy in the code today.** Design 1 needs to extend the same pattern to `ACCEPT_OFFER`, `PURCHASE_ORDER`, and `DD_ACCEPT`. Everything else stays on the lightweight envelope path (currently `PlainHashSigner`, to be upgraded to KRAM in the hybrid).

### 3.3 Buyer/Seller REST endpoints (non-A2A) — UI dashboard and ops

| Route | Bucket | Reason |
|---|---|---|
| `GET /negotiate-events` (SSE) | **No-auth** (localhost-only) | UI streaming. Caller is the React dev server on localhost:5173. Don't expose externally. **Action item: enforce loopback bind** |
| `GET /api/notify-status` | **No-auth** (localhost-only) | Diagnostic. Loopback-only |
| `GET /api/identity-mode` | **No-auth** | Returns a config flag. Same value for every caller |
| `POST /api/verify/seller` and `/api/verify/buyer` | **Light** | Triggers a verification run that talks to GLEIF and (in vlei mode) api-server :4000. The result is what the UI uses to gate "start negotiation". Sign so an audit-trail review can answer "who asked for this verification at this time" |
| `GET /api/recent-deals` | **Light** | Reveals deal history including counterparty names and prices. Privacy-sensitive |
| `GET /api/quality/:id` | **Light** | Same. The audit JSON contains LEIs, prices, treasury data |
| `GET /api/quality/:id/pdf` | **Light** | Same content, different format |
| `GET /api/baseline` | **Light** | Returns fixture-replay baseline. If left unauth, anyone with the URL can read aggregated deal metrics |
| `GET /api/signing-mode` / `/api/mode-matrix` | **No-auth** | Config flags. Pure constants |
| `GET /api/self/mode-status` (seller) | **No-auth** | Same |

**Why these are mostly light, not heavy:** none of these endpoints creates a bilateral commitment. They're read or read-with-side-effect. KRAM gives you per-request accountability without the IPEX latency tax. Heavy is reserved for the messages that *bind* a counterparty.

### 3.4 Adjacent services called by DynDic3ent1

| Endpoint | Bucket | Reason |
|---|---|---|
| `POST localhost:4000/api/buyer/ipex/admit` | **Heavy by construction** | This *is* the IPEX admit. The signing happens inside signify-ts as part of the admit |
| `POST localhost:4000/api/seller/ipex/issue-and-grant` | **Heavy by construction** | Same — IPEX issue+grant is heavy by definition |
| `POST localhost:7070/consult` | **Light** | Internal microservice call seller→treasury. The treasury runs an ACTUS sim and returns a verdict. Not a commitment, but the seller relies on the result. KRAM-sign so a forensic review can confirm the treasury was asked about this exact price |
| `POST localhost:7070/dd-cashflow-schedule` | **Light** | Same — sub-delegation to treasury, not a bilateral commitment |

---

## §4 — Decision rules: how to bucket any new endpoint

For new endpoints in DynDic3ent1 or any other project, walk this short tree. Each rule is grounded in the official docs cited at the top of §0.

**Rule 1 — If the endpoint is self-verifying, no auth.**
Examples: OOBI fetch (response is a KEL, caller hashes it and matches the AID prefix — covered in `101_35_Modes_oobis_and_witnesses.md`). Schema fetch (response is a SAIDified schema, caller hashes it — covered in `101_60_Saidify_schema.md`). Health checks. Static config flags.

**Rule 2 — If the endpoint creates or modifies a bilateral commitment, heavy (ACDC + IPEX).**
A bilateral commitment is anything where a court or auditor would later need to prove that a specific party agreed to specific terms at a specific time. `102_25` is the playbook: issue an ACDC in the issuer's registry, grant it via `client.ipex().grant() + submitGrant()`, recipient `admit()`s.

The four DynDic3ent1 commitment messages — `ACCEPT_OFFER`, `PURCHASE_ORDER`, `DD_ACCEPT`, plus the two already-heavy invoices — fit this rule. Each gets its own SAIDified ACDC schema, registered to its issuing agent's registry.

**Rule 3 — Everything else, light (KRAM).**
KRAM is per-request, timestamp-bound, replay-protected, and doesn't need a prior handshake (per `vlei.wiki/KRAM`). The `Authenticater.sign(headers, method, path)` call (from `signify-ts/src/keri/core/authing.ts` per TypeDoc) is the one-liner. Sign every operational, diagnostic, or negotiation-chatter call this way.

**Rule 4 — Once per session, mutual challenge-response, then cache.**
Two AIDs that have never talked before run `client.challenges().generate/respond/verify` once at first contact (per `101_45` and workshop `qvi-challenge-geda.ts` trio). The result is recorded in each side's `authenticated_sessions` table. Subsequent KRAM-signed messages within that session rely on the cached proof; you don't re-handshake per message.

**Rule 5 — If a sub-agent introduces itself, one-time ACDC presentation.**
Sub-agent → counterparty's sub-agent → first contact → IPEX grant of the sub-agent's `ROR_ROLE` (or chain-equivalent) ACDC, no admit needed. After verification, future messages from that sub-agent ride on KRAM. Reuses the §3.5 pattern in the hybrid doc.

---

## §5 — General guidelines for other projects

These same rules apply to any project that does agent-to-agent messaging. Restated as a checklist you can hand to another team:

### 5.1 Identify your "commitment" messages
For each business message your system sends, ask: *if the counterparty later disputed this specific message, would I want it provable in court without my own server logs?* If yes → ACDC + IPEX. If no → KRAM.

Most systems have 3–6 commitment messages. Everything else — even messages that feel important, like "order shipped" or "payment received" — is usually operational and belongs on KRAM.

### 5.2 Author one ACDC schema per commitment message type
Per `101_60_Saidify_schema.md`, schemas must be SAIDified. Per `103_10_vLEI_Trust_Chain.md`, each schema is anchored by edges to a parent credential — for our system, the parent is the agent's `ROR_ROLE`, which chains to the LE credential, which chains to the QVI, which chains to GLEIF. Sally walks this chain unmodified.

If you find yourself authoring more than 6 commitment schemas, you're probably over-classifying messages as commitments. Step back.

### 5.3 Wire KRAM at the HTTP layer once
KRAM is one middleware on the receiver and one signed-header builder on the sender. Wire it once at the HTTP framework level (Express middleware, FastAPI dependency, whatever) and it covers every endpoint automatically. Don't put the signing logic in each handler.

**Open item from the hybrid doc §7-Q1:** confirm `Authenticater.DefaultFields` covers body integrity. If it doesn't, pass an explicit `fields` array that includes a `Content-Digest` header. If neither works, the body must be hashed separately and the hash signed via the same primitive. **Until this is confirmed, the per-message-non-repudiation claim for KRAM is conditional.**

### 5.4 Localhost-only endpoints stay no-auth, but enforce binding
If an endpoint is for the local UI only (`/negotiate-events`, `/api/notify-status`), don't add auth — but **do enforce the loopback bind**. `app.listen(PORT, '127.0.0.1', ...)` instead of just `app.listen(PORT, ...)`. Otherwise the no-auth assumption is broken the moment the agent is deployed to a host with a public interface.

### 5.5 Diagnostic endpoints — KRAM yes, ACDC no
`/api/identity-mode`, `/api/signing-mode`, `/api/mode-matrix` return config flags. Light is enough. **But** ops/audit endpoints — anything that reveals real data like deal history, counterparty names, or audit JSON — should be light, not no-auth, even on localhost. The cost is one signature; the gain is a real audit trail of who saw the data.

### 5.6 Sub-agents: chain proof once, KRAM thereafter
When a sub-agent (Jupiter's checkout sub-agent talking to Tommy's inventory sub-agent) first connects, it presents its delegation ACDC. The receiver verifies the chain once (Sally-style walk) and caches the result. From then on, every KRAM-signed message from the sub-agent in this session is trusted because the chain was already verified. You don't re-verify the chain per message.

### 5.7 Revocation is automatic when you choose ACDC for commitments
ACDCs have TELs (per `102_25`). Revocation is a TEL event anchored in the issuer's KEL. The locked decision in the parent design doc §11 already says "all 4 entity types issue real KERI TEL revocations on DELETE." This naturally extends to commitment ACDCs: a revoked `ACCEPT_OFFER` ACDC is detected by the verifier on next use. No extra plumbing.

### 5.8 Default to KRAM, escalate to ACDC by exception
The mental default for any new endpoint should be **light**. ACDC is the exception, not the rule. If you can't articulate a specific dispute scenario where this exact message would need to survive in evidence without your server logs, you don't need ACDC.

---

## §6 — Migration plan for DynDic3ent1 specifically

Concrete steps to take this guide to working code:

1. **Confirm §7-Q1** from the hybrid doc (the `Authenticater.DefaultFields` body-integrity question) by reading `signify-ts/src/keri/core/authing.ts` from upstream. Until then, the KRAM tier is conditional.
2. **Wire one Express middleware** in `A2A\js\src\messaging\` that exports `signA2aRequest` and `verifyA2aRequest`. Mount it on the buyer (:9090), seller (:8080), onboarding (:6060), treasury (:7070), and api-server (:4000) Express apps.
3. **Replace the existing `PlainHashSigner` calls** in `buyer-agent/index.ts:sendToSeller()` and `seller-agent/index.ts:sendToBuyer()` for the **light-tier** message types. The current envelope wrap is `getMessageSigner().seal(...)` — keep this interface, swap the impl from `PlainHashSigner` to `KramSigner`. The two impls live side by side under `SIGNING_MODE=plain|kram` (extends the existing `SIGNING_MODE=plain|vlei` matrix).
4. **For the heavy-tier message types** (`ACCEPT_OFFER`, `PURCHASE_ORDER`, `DD_ACCEPT`): author 3 new ACDC schemas (`A2AAccept`, `A2APurchaseOrder`, `A2ADDAccept`), SAIDify them, register with the schema server, and add an `IpexCommitmentSigner` that wraps the existing api-server `/api/seller/ipex/issue-and-grant` and `/api/buyer/ipex/admit` calls. The pattern is already in code for `INVOICE` and `DD_INVOICE`.
5. **Add the challenge-response handshake step** to `verifyCounterparty()`. Today it's GLEIF-only or vLEI-DEEP-EXT. Add a mutual challenge round when `CREDENTIAL_MODE=vlei` and persist the result in a new `authenticated_sessions` table.
6. **Bind localhost-only routes to 127.0.0.1** explicitly. `/negotiate-events`, `/api/notify-status`, the SSE stream, the mode endpoints. One-line change per agent.

---

## §7 — What I did NOT verify (Rule 3 flags)

- **@a2a-js/sdk message-route names.** I read the executor's handler methods but not the SDK's `A2AExpressApp.setupRoutes()` source. The bucketing above bucketed by *message type*, not by HTTP route, because that's what I could verify.
- **treasury-agent and api-server source code in this session.** The treasury endpoint set is inferred from seller-agent call sites only. The api-server endpoints (`/api/buyer/ipex/admit`, `/api/seller/ipex/issue-and-grant`) are inferred from the prior session summary, not freshly verified in this turn.
- **`Authenticater.DefaultFields` body integrity** — open item from the hybrid doc §7-Q1. Until this is confirmed, the KRAM tier's per-message non-repudiation depends on whether body content is in the signed field set.
- **Exact KRAM clock-skew window for our deployment.** Default is ~5 seconds (per `vlei.wiki/KRAM`); we may need to set it wider for cross-AZ jitter. Not measured.
