# Cross-Repo Architecture Analysis — vLEI + Dynamic Discounting

Date: 2026-08-04
Author: analysis session 4
Status: **PARTIAL — Passes 1–2 complete, Passes 3–5 not started**

## 0. Provenance rule for this document

Every claim below is tagged:

- `[READ]` — derived from a file I opened and read in full or in the stated range
- `[INFER]` — reasoned from `[READ]` evidence, NOT directly stated in any file
- `[UNREAD]` — named here as a known gap; no claim is made about its contents

Do not promote an `[INFER]` to fact without opening the file.

---

## 1. Repository topology

### 1.1 Roots

| Repo | Path | Role |
|---|---|---|
| legentvLEI | `C:\SATHYA\CHAINAIM3003\mcp-servers\vLEIEnh1\legentvLEI` | vLEI / KERI identity stack, verification API |
| DynDisc | `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\FINAGENTS1\DynDiscProject5\A2A\js` | A2A trading agents |

`[READ]` Filesystem MCP root is `C:\SATHYA\CHAINAIM3003\mcp-servers` (single root,
from `claude_desktop_config.json`). Both repos are reachable beneath it.

`[READ]` Git repo root for DynDisc is `DynDiscProject5`, **not** `A2A/js`.
(Carried from ADR-001 / session-3 handoff.)

### 1.2 Coupling mechanism

`[READ]` from `DynDiscProject5/A2A/js/docker-compose.yml`. The two compose
projects are joined by exactly two external Docker objects:

- network `vlei_workshop` (declared `networks.default.external: true`)
- volume `vlei_task_data` (declared as `task-data-vol`, `external: true`,
  name overridable via `VLEI_TASK_DATA_VOLUME`)

Both are created by `legentvLEI/deploy.sh`. **Start order is load-bearing**:
legentvLEI first, DD second. DD-first fails with "network not found" or
"external volume not found".

`[READ]` The compose header documents the prior state: task-data was a bind
mount to an absolute WSL path
(`/mnt/c/SATHYA/.../legentvLEI/task-data`), which pinned both stacks to one
workstation and left BRAN private-key material loose on the host filesystem.

---

## 2. Service inventory

### 2.1 Containerised today

`[READ]` from DD `docker-compose.yml` — three services only:

| Service | Container | Port | Entrypoint | task-data mount |
|---|---|---|---|---|
| dd-seller | `dd_seller` | 8080 | `src/agents/seller-agent/index.ts` | yes → `/task-data` |
| dd-buyer | `dd_buyer` | 9090 | `src/agents/buyer-agent/index.ts` | yes → `/task-data` |
| dd-treasury | `dd_treasury` | 7070 | `src/agents/treasury-agent/index.ts` | **no — deliberate** |

`[READ]` treasury is deliberately denied the task-data mount: its code reads no
`AGENT_BRAN_PATH` / `KERIA_*_URL` / `VLEI_API_BASE_URL`, so mounting BRAN key
material would be unnecessary exposure. This is a correct least-privilege call.

`[READ]` Shared YAML anchor `x-agent-image` gives all three:
`restart: unless-stopped`, `stop_grace_period: 5s`,
`user: "${UID:-1000}:${GID:-1000}"`, and a local build with no `image:` key
(deliberate — a registry-shaped tag would make compose attempt a Hub pull).

### 2.2 Agents that exist in code but have NO compose service

`[READ]` `src/agents/` contains seven agent directories:

```
audit-reporting-agent/   ← no compose service
buyer-agent/             ← dd-buyer
credit-agent/            ← no compose service
inventory-agent/         ← no compose service
logistics-agent/         ← no compose service
seller-agent/            ← dd-seller
treasury-agent/          ← dd-treasury
```

`[READ]` `src/api/` contains `engine-decide-server.ts`, `onboarding-server.ts`,
and a `graphql/` module (`index.ts`, `resolvers.ts`, `schema.ts`) — none of
which have compose services either.

**This is the single largest hosting blocker.** Four agents plus three API
surfaces run only as bare-host `npx tsx` processes today.

`[INFER]` Because seller's env sets `TREASURY_URL: http://dd-treasury:7070/consult`
and `BUYER_AGENT_URL`, the containerised trio can talk to each other by
hostname — but any call from a container to credit/inventory/logistics/
audit-reporting or to engine-decide would have to resolve a hostname that does
not exist on the `vlei_workshop` network. I have **not** read the agent code to
confirm such calls are attempted. That check belongs in Pass 3.

---

## 3. Environment contract (verified)

`[READ]` DD compose sets, per service, `env_file:` **before** `environment:` —
deliberate ordering so container-specific values override the stale
Windows-path/localhost values already in each agent's `.env`. Docker Compose
semantics: `environment:` wins over `env_file:` on key conflict. This is
correct.

Seller (`dd-seller`) receives:

```
PORT=8080
KERIA_ADMIN_URL=http://keria:3901
KERIA_BOOT_URL=http://keria:3903
KERIA_OOBI_BASE=http://keria:3902
VLEI_API_BASE_URL=http://api_server:4000
AGENT_BRAN_PATH=/task-data/jupiterSellerAgent-bran.txt
AGENT_INFO_PATH=/task-data/jupiterSellerAgent-info.json
KRAM_COUNTERPARTY_INFO_PATHS=/task-data/tommyBuyerAgent-info.json
TREASURY_URL=http://dd-treasury:7070/consult
BUYER_AGENT_URL=http://dd-buyer:9090
```

Buyer is symmetric (`PORT=9090`, tommy BRAN/info, seller as counterparty,
`SELLER_AGENT_URL`).

`[READ]` Secrets (Gemini / Meta / Twilio) are loaded from each agent's
git-ignored `.env` via `env_file:`, not hardcoded in compose. Correct pattern.
Note this does **not** discharge pending item (2) — rotation — since those keys
were exposed in a prior chat transcript.

---

## 4. The identity integration seam

`[READ]` `src/shared/vlei-verification-client.ts` in full. This is the only
module that crosses from DD into legentvLEI.

### 4.1 Endpoints consumed

```
POST /api/buyer/verify/seller          DEEP,  standard
POST /api/seller/verify/buyer          DEEP,  standard
POST /api/buyer/verify/ext/seller      DEEP-EXT, cross-org
POST /api/seller/verify/ext/buyer      DEEP-EXT, cross-org
POST /api/buyer/verify/sellerInvoice   DEEP-EXT-CREDENTIAL
GET  /health
```

Base URL resolution: `process.env.VLEI_API_BASE_URL || "http://localhost:4000"`.

### 4.2 Kill switch — significant finding

`[READ]` `isVleiEnabledFromEnv()` disables all cryptographic verification when
**either**:

```
CREDENTIAL_MODE=plain
VLEI_ENABLED=false
```

When disabled, `verifyCounterparty()` returns **`verified: true`** immediately,
with `verificationType: "DISABLED"` and `verificationScript: "NONE"`, without
any network call.

`[READ]` The check is intentionally lazy (inside the function, not at module
load) because `dotenv.config()` runs after imports in the agent entrypoint.
That is a correct fix for a real ordering bug.

`[READ]` Mitigations that ARE present: the audit records the disabled-mode
result, and `printVerificationResult()` is mode-aware — it prints
"Plain-mode identity check passed — NOT vLEI" in yellow and explicitly
suppresses the KERI trust-chain line so a plain run is not visually mistaken
for a verified one.

`[INFER]` Risk assessment, not stated in the file: `verified: true` on a
disabled path is a fail-open default. Anything downstream that branches on
`result.verified` alone — without also testing
`verificationType !== "DISABLED"` — treats an unverified counterparty as
verified. Whether such a call site exists is **unknown until Pass 3 reads the
agent code**. This is the highest-value open question from this session.

### 4.3 KRAM request signing

`[READ]` `buildRequestInit()` reuses the existing message-signer singleton from
`src/messaging/index.js`. If `signer.mode() === "kram"` and
`produceHttpHeaders` exists, the body is signed (RFC 9530 / Signify headers);
otherwise it falls through to an unsigned `POST` with `JSON.stringify`.

`[READ]` The file's own comment states that before this change, nothing on the
DD side ever sent KRAM headers — every call to api-server was unauthenticated
regardless of `KRAM_REQUIRED`.

Consistent with handoff §5: this code path exists but has never executed
against a live stack.

### 4.4 Agent card resolution

`[READ]` `readAgentCardMetadata()` probes three directories in order:

```
live-agent-cards/   (customer onboarded)
demo-agent-cards/   (source-controlled Tommy + Jupiter)
agent-cards/        (legacy fallback)
```

Resolved relative to `process.cwd()`. Compose mounts only
`./live-agent-cards:/app/live-agent-cards`.

`[INFER]` `demo-agent-cards/` and `agent-cards/` are therefore baked into the
image at build time rather than mounted, so changing a demo card requires a
rebuild. Not verified against the Dockerfile — **Dockerfile is `[UNREAD]`**.

Card schema consumed: `extensions.keriIdentifiers`, `extensions.vLEImetadata`,
`extensions.gleifIdentity`. Every field is read defensively with `?? ""`, so a
malformed card degrades to empty strings rather than throwing.

---

## 5. Module inventory (structure only — contents `[UNREAD]`)

`src/shared/` — 42 modules. Functional clusters:

- **Negotiation core**: `dd-calculator.ts`, `dd-types.ts`, `negotiation-mode.ts`,
  `negotiation-types.ts`, `negotiationTypes.ts` *(note: two files differing only
  in case convention — likely duplication, worth a Pass 3 check)*,
  `outcome-quality.ts`, `l2-executive.ts`, `l2-wire.ts`
- **Audit**: `audit-writer.ts`, `audit-paths.ts`, `audit-pdf.ts`,
  `audit-index-schema.ts`, `index-jsonl-writer.ts`, plus `audit-blocks/`
  (10 modules: autonomy, compliance, delegation-chain, framework-metrics,
  identity-proof, intent-block, message-signing-posture, self-check,
  think-cycle-trace)
- **Providers**: `credit-provider.ts`, `inventory-provider.ts`,
  `logistics-provider.ts`, `treasury-provider.ts`, `provider-types.ts` —
  `[INFER]` these are the in-process counterparts of the four agents that have
  no compose service
- **External**: `actus-client.ts`, `llm-client.ts`, `market-data-client.ts`,
  `vlei-verification-client.ts`
- **Infra**: `cors-config.ts`, `logger.ts`, `sqlite-sidecar.ts`,
  `sse-broadcaster.ts`, `cli-parser.ts`, `scenario-loader.ts`

`src/identity/` — 5 modules: `index.ts`, `CredentialProvider.ts`,
`VleiProvider.ts`, `PlainJsonProvider.ts`, `agent-card-loader.ts`.
`[INFER]` A provider-strategy pattern mirroring the `CREDENTIAL_MODE`
plain/vlei switch found in §4.2. Not yet read.

Other: `src/messaging/`, `src/notify/`, `src/types/`, `src/utils/`, `src/cli.ts`
— all `[UNREAD]`.

---

## 6. Gaps — what Passes 3–5 must cover

1. **`src/identity/*`** — confirm the provider-strategy inference; find where
   `CREDENTIAL_MODE` is dispatched.
2. **`seller-agent/index.ts` and `buyer-agent/index.ts`** — locate every call
   site that branches on `VerificationResult.verified` and check whether
   `verificationType === "DISABLED"` is also tested. This is the §4.2 fail-open
   question.
3. **`src/messaging/`** — `KramSigner`, `getMessageSigner()`, and what
   `SIGNING_MODE=vlei` does today (the client comment says "not yet
   implemented").
4. **`engine-decide-server.ts` + `onboarding-server.ts` + `graphql/`** — port
   assignments and whether these are reachable from the container network.
5. **legentvLEI `api-server/server.js`** — the four legacy routes flagged as
   auth-bypass in handoff §8 item (7).
6. **`Dockerfile`** (DD) — confirms the §4.4 build-vs-mount inference.
7. **`negotiation-types.ts` vs `negotiationTypes.ts`** — duplication check.

---

## 7. Findings summary

| # | Finding | Severity | Basis |
|---|---|---|---|
| A | 4 agents + 3 API servers have no compose service | Blocks hosting | `[READ]` |
| B | `CREDENTIAL_MODE=plain` returns `verified: true` (fail-open) | Needs Pass-3 confirmation | `[READ]` + `[INFER]` |
| C | KRAM signing code present, never executed | Unproven | `[READ]` |
| D | Treasury correctly denied BRAN mount | Good | `[READ]` |
| E | `env_file` before `environment` ordering | Correct | `[READ]` |
| F | `src/audits` + `src/escalations` still host bind mounts | Blocks portability | `[READ]` |
| G | Possible type-module duplication in `shared/` | Cosmetic | `[INFER]` |
