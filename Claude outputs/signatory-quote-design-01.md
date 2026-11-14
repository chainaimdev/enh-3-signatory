# signatory-quote-design-01 — Jupiter ⇄ Tommy quote negotiation with Private AI (OutcomeAI) and vLEI governance

Date: 2026-11-14 · Status: **DRAFT for owner review — nothing built** · Author: Claude (read-only analysis)
Repos: `enh-3-signatory` (Signatory) · `chainiam-private-ai` (OutcomeAI) · `chainaim-adminUI-NEAR` (not read; out of scope)
Hackathon deadline (V-READ `chainaim-signatory/ARCHITECTURE-signatory-2026-11-13.md` L7): **14 Nov 2026 23:59 UTC = 15 Nov 05:29 IST**.

Tags: **V-READ** = read in the code/config today · **CALC** = computed by the generator script in this session · **DESIGN** = proposed here, not built · **ASSUMED** = my assumption, owner to confirm · **OPEN** = must be checked before/while building · **DECIDED** = owner decision in this chat.

---

## 1. Goal (one paragraph)

Tommy's buyer agent sends a request for quotation (quality, quantity, price per unit, deadline). Jupiter's seller agent consults three Jupiter sub-agents (Inventory, Logistics, Treasury). Their private data and the reasoning model live in OutcomeAI (NEAR AI TEE). The seller agent then synthesises an answer: accept, counter on any of the four variables, or escalate. Signatory enforces Jupiter's authority policy (agent → Sales Officer → CEO agent → CEO, all vLEI identities), keeps the inquiry/quote records, and (later) hands the agreed deal to the existing vLEI invoice → NEAR payment tail.

## 2. Owner decisions recorded in this chat (DECIDED)

| # | Decision |
|---|---|
| D1 | Jupiter business data lives **only in OutcomeAI**; Signatory never holds Jupiter's private data. |
| D2 | **Policy split:** authority matrix (floors per level, rounds, importance, vLEI role mapping) in **Signatory**; business thresholds (target margin, advance-payment lever, reallocation premiums) in **OutcomeAI**. |
| D3 | Inquiry and quote objects (ERPNext-style) and run records live in **Signatory**. |
| D4 | No model and no model key inside Signatory. All reasoning goes through OutcomeAI → gateway → NEAR AI TEE. |
| D5 | Default model `nearai/deepseek-v4.1-flash`; `bedrock/nemotron-nano-3-30b` behind a flag. |
| D6 | LLM path **A**: quote-agents → OutcomeAI gateway (masking) → NEAR AI; attest service verifies. Direct-to-NEAR-AI kept as a flag. |
| D7 | Signatory reaches OutcomeAI by **URL only** (`--outcome-url`), no folder coupling. |
| D8 | Add **T09** (rounds-only escalation). |
| D9 | Tommy's simulated budget stays in Signatory (precedent: `data/orders.json` `buyerBudgetCents`, V-READ). |
| D10 | POC: Tommy decides by **rules**; Tommy LLM (via OutcomeAI tenant) later. |

## 3. Verified facts the design depends on (V-READ)

### Signatory (`enh-3-signatory/chainaim-signatory`)
- Runner order mode: `STEPS_C = preflight, request, verify_buyer, swarm, negotiate, verify_seller_agent, escalation, treasury, issue, offer, verify_seller, accept, register, pay, outcome, decision` (`services/runner/engine.mjs` L41).
- Officer decision on a failed negotiation: `waitForDeal` + `POST /runs/:id/decide {decision: approve|reject}` (`engine.mjs` L696–745, `index.mjs` L17–19).
- Negotiation pattern: AI proposal → guard → rule fallback (`services/shared/negotiate.mjs` `decideMove`); the AI may see only its own private limits (`publicStateFor`).
- Existing LLM client: `services/shared/llm.mjs` — OpenAI-compatible `/v1/chat/completions`, key only from env `SIGNATORY_LLM_API_KEY`, roles `seller` and `buyer` (tommyBuyerAgent).
- Swarm checks (`services/runner/swarm.mjs`): `preDealChecks` (inventory + logistics from one DD5 fixture each), `treasuryChecks` (seller profit/NPV + buyer mandate route).
- Ports (`config/signatory.json`): signer 8771, bridge 8772, advisors 8773, runner 8774; UI origin `http://127.0.0.1:8765`.
- `.gitignore` (repo root): `chainaim-signatory/private/` is ignored.
- vLEI evidence (`services/test/fixtures/signatory-evidence.fixture.json`):
  - Jupiter_Knitting_Company (LEI `3358004DXAMRWRUIYJ05`): officers `Jupiter_Chief_Executive_Officer`, `Jupiter_Chief_Sales_Officer`; agents `jupiterCeoAgent` (executive_approvals), `jupiterSellerAgent` (seller), `JupiterTreasuryAgent`, `JupiterInventoryAgent`. **No Logistics agent** (planned #14, V-READ `orders.json`).
  - Tommy_Hilfiger_Europe (LEI `54930012QJWZMYHNJW95`): officers `Tommy_Chief_Executive_Officer`, `Tommy_Chief_Procurement_Officer`; agents `tommyCeoAgent`, `tommyBuyerAgent`, `TommyTreasuryAgent`.
- Mandates (`config/accounts.json`): tommyBuyerAgent limit `100000` units (0.10 USDC), CPO `250000` (0.25 USDC); `demoScale` 1,000,000 (`config/signatory.json`).

### OutcomeAI (`chainiam-private-ai`)
- `PROJECT_CONTEXT.md` constraints: gateway has **no npm runtime dependencies** (Node runs TypeScript); secrets as env var **names only** in `.env.example`; **Presidio unreachable → chat answers 503**; everything reaching a model is masked; **residual check (`--residual-guard on`) refuses text that still holds a long digit run, spaced digit groups, phone, e-mail or titled name (422)**.
- `docker-compose.yml` services and host ports: `gateway` **127.0.0.1:8720 → 8700**, `paywall` 8080, `analyst` 8740, `chain-query` 8750, `console-api` 8735, `agent` (profile `agent`) **8760**, `attest` (profile `attest`) **8770**, `presidio` (internal), `openrouter-stub` (profile `test`) 5004. Gateway and attest receive `NEARAI_API_KEY` by name.
- Gateway (`services/gateway/src/main.ts`, `server.ts`): default `--port 8700`, `--presidio-url http://127.0.0.1:5002`; attested replies carry headers `x-chainaim-provider-id`, `x-chainaim-served-model`, `x-chainaim-req-sha256`, `x-chainaim-resp-sha256`.
- Attest (`services/attest/src/main.ts`): `POST /verify {calls:[{chatId, servedModel, requestSha256, responseSha256, calledAt}]}`, `GET /healthz`, port 8770; holds `NEARAI_API_KEY`; receives ids and hashes only.
- Models (`config/local-models.cpu-all-nearai.json`): `nearai/deepseek-v4.1-flash` (reasoning, NEAR AI TEE, zone private-cloud), `bedrock/nemotron-nano-3-30b`, `hosted/nemotron-nano-reasoning`, local Qwen/DeepSeek-R1. `config/catalog.bedrock.json`: Nemotron Nano 3 30B on Bedrock (ap-southeast-2).
- Jupiter ERPNext data: `sample-data/smb-2-erp-fin/erpnext/jupiter-knitting/jupiter-knitting.erpnext-data.json`; schema `_source/jupiter-knitting.erpnext-schema.json` contains `Item`, `Customer`, `Sales Order` but **not** `Quotation`, `Request for Quotation`, `Bin` or `Warehouse`.
- Tenant convention exists in the paywall test rig: `rig/tenants/<id>/tenant.json` (`.env.example` L68, L95). Its fields are **OPEN** (not read).
- Scripts: `test-console/desk.ps1`, `up.ps1`, `down.ps1`, `stack.ps1` exist (not read).

## 4. Corrections to what I said earlier in this chat
| Earlier | Corrected |
|---|---|
| quote-agents on port 8760 | **8760 is taken by `agent`** → quote-agents on **8786** (ASSUMED free; OPEN: confirm with `netstat`). |
| gateway at :8700 | Container port 8700; **host port 8720** (V-READ compose). Inside the compose network: `http://gateway:8700`. |
| ERPNext Quotation/RFQ "from the schema" | Not in Jupiter's schema. RFQ/Quotation objects are **ERPNext-modelled** by us; exact field names OPEN until checked against the official ERPNext doctype definitions. |
| new tenant scheme | Reuse the existing `rig/tenants/<id>/tenant.json` convention if it fits (OPEN). |

## 5. Architecture

```
                         ┌─────────────────────────────── Signatory (enh-3-signatory) ─────────────────────────────┐
 tommyBuyerAgent ─RFQ──► │ jupiterSellerAgent  quote-flow.mjs                                                       │
  (quote-buyer.mjs,      │   1 consult  ─────────────────────────────────────────────┐                              │
   rules from buyerSim)  │   2 floors = treasury.pricesAtMargin × quote-authority.json│                              │
        ▲                │   3 round r: synthesize ─► GUARD ─► Quotation ──────────────┼──────────► tommyBuyerAgent   │
        │                │   4 escalate (Sales Officer → jupiterCeoAgent brief → CEO) via /decide                   │
        └──── quote ─────│   5 records: private/quotes/<id>/…   6 (later) existing tail: issue → pay on NEAR         │
                         └──────────────────────────────────────┬───────────────────────────────────────────────────┘
                                                                │ HTTP, --outcome-url (default http://127.0.0.1:8786)
                         ┌──────────────────────── OutcomeAI (chainiam-private-ai) ─────────────────────────────────┐
                         │ quote-agents :8786 (NEW)  tenant jupiter-knitting                                       │
                         │   /agents/inventory  /agents/logistics  /agents/treasury   (deterministic, private data) │
                         │   /seller/synthesize ──► gateway :8700 (Presidio mask) ──► NEAR AI TEE (deepseek-v4.1)  │
                         │                     └──► attest :8770 /verify (ids + hashes)                            │
                         │ sample-data/quote/jupiter-knitting/*.json                                                │
                         └──────────────────────────────────────────────────────────────────────────────────────────┘
```

Separation of concerns (DESIGN):
- **OutcomeAI computes and reasons** on Jupiter's private data: stock, sailings, costs, AR/AP, plus the TEE model call. Unit cost and AR/AP never leave.
- **Signatory decides and records:** identity, authority guard, negotiation state, escalation, records, payment.
- The model **proposes**; Signatory's guard **decides** (same pattern as `negotiate.mjs`).

## 6. OutcomeAI design — `services/quote-agents` (DESIGN)

### 6.1 Runtime
- Node 24, TypeScript run directly, **no npm runtime dependencies** (matches the gateway constraint, V-READ PROJECT_CONTEXT).
- Flags: `--port 8786 --host 127.0.0.1 --data-root sample-data/quote --tenants config/quote-tenants.json --as-of 2026-11-16 --ai off|nearai|bedrock --llm-via gateway|direct --gateway-url http://127.0.0.1:8720 --attest-url http://127.0.0.1:8770 --attest on|off --timeout-ms 60000`.
- Env var **names** (added to `.env.example`): `QUOTE_TOKEN_JUPITER`, `QUOTE_TOKEN_TOMMY`, gateway client key (OPEN: the gateway's existing client-key mechanism — compose has a `gateway-key` volume and `test-console/local-gateway-key.txt` exists; not read).
- Compose: new service `quote-agents`, profile `quote`, `127.0.0.1:8786:8786`, depends on `gateway` (and `attest` when `--attest on`); inside the network `--gateway-url http://gateway:8700 --attest-url http://attest:8770`.

### 6.2 Tenancy and caller check
`config/quote-tenants.json` (or `rig/tenants/<id>/tenant.json` if that convention fits — OPEN):
```json
{
  "jupiter-knitting": { "lei": "3358004DXAMRWRUIYJ05", "dataDir": "jupiter-knitting", "tokenEnv": "QUOTE_TOKEN_JUPITER",
    "agents": { "JupiterInventoryAgent": ["agents/inventory"], "JupiterLogisticsAgent": ["agents/logistics"],
                "JupiterTreasuryAgent": ["agents/treasury"], "jupiterSellerAgent": ["seller/synthesize"],
                "jupiterCeoAgent": ["seller/synthesize"] } },
  "tommy-hilfiger-europe": { "lei": "54930012QJWZMYHNJW95", "dataDir": "tommy-hilfiger-europe", "tokenEnv": "QUOTE_TOKEN_TOMMY",
    "agents": { "TommyTreasuryAgent": ["agents/treasury"], "tommyBuyerAgent": ["agents/procurement", "buyer/synthesize"] } }
}
```
Every request carries `Authorization: Bearer <tenant token>`, `X-Agent-Alias`, `X-Agent-LEI`. The service checks token = tenant, alias allowed for that path, and LEI = tenant LEI; otherwise 401/403. It reads only `data-root/<dataDir>`. Later (not POC): KERI-signed requests verified against the vLEI evidence.

### 6.3 Endpoints (tenant `jupiter-knitting`)

| Method · Path | Request | Response | Model? |
|---|---|---|---|
| `GET /healthz` | — | `{ok, asOf, ai, gateway:{ok}, attest:{ok}, tenants:[…]}` | — |
| `POST /v1/tenants/{t}/agents/inventory` | `{requestId, sku, qty, shipBy}` | `{sources:[{lot, kind:FREE\|WIP\|PRODUCTION, units, readyDate, warehouse}], reallocatable:[{lot, units, tier, requiredAuthority:SALES_OFFICER\|CEO, premiumPct, replacementOk}], gradeAlternatives:[{sku, grade, sameOrBetter:true}], shortfall}` | no |
| `POST /v1/tenants/{t}/agents/logistics` | `{requestId, sku, lots:[{lot, units, readyDate, warehouse}], deadline, allowAir}` | `{legs:[{lot, units, mode:SEA_STD\|SEA_EXP\|AIR, carrier, etd, delivered, freightCents}], freightCents, meetsDeadline, lateUnits, airOption:{deliveredBy, centsPerUnit, maxUnits}}` | no |
| `POST /v1/tenants/{t}/agents/treasury` | `{requestId, sku, qty, freightCents, reallocUnits:{TIER1, TIER2}, termsDays, advancePct, margins:[0.15,0.135,0.12,0.10,0.09,0.08]}` | `{landedCents, pricesAtMargin:{"0.15":…}, reallocPremiumCents, liquidity:{net30Usd, status:SURPLUS\|DEFICIT}, advanceLever:{minAdvancePct:30, marginRelief:0.01, applies}, credit:{headroomUsd, ok}}` — unit cost never returned | no |
| `POST /v1/tenants/{t}/seller/synthesize` | `{requestId, mode:"round"\|"ceo-brief", inquiry, round, history, answers:{inventory, logistics, treasury}, authority:{level, floorCents, maxRounds, allowed}}` | `{proposal:{decision:ACCEPT\|COUNTER\|ESCALATE, counter:{sku, qty, priceCents, deadline, shipments}}, messageToBuyer, reasoning, source:"ai"\|"rules", model, attest:{chatId, servedModel, verdict}\|null, ms}` | **yes** (or rules) |
| *(later)* `POST /v1/tenants/tommy-hilfiger-europe/agents/treasury`, `/agents/procurement`, `/buyer/synthesize` | mirror of the above for the buyer | | later |

### 6.4 Synthesis call (DESIGN, path A)
1. Build the prompt from template T5 (§9). The context is the inquiry, the three answers, the history and the authority level.
2. Call `POST {gateway}/v1/chat/completions`, model `nearai/deepseek-v4.1-flash`, `temperature 0.2`.
3. Read the 4 `x-chainaim-*` headers. Then `POST {attest}/verify` **asynchronously**: the proposal returns immediately and the verdict follows in the record.
4. Parse strict JSON. On any failure (timeout, 422 residual refusal, bad JSON) return the **rule proposal** with `source:"rules"` and the reason.
- **Risk R1 (OPEN):** the residual guard may refuse prompts full of numbers and dates (422). Test in iteration 0. Mitigations, in order: (a) send numbers as JSON fields, not prose; (b) round or scale values; (c) use the gateway's existing passthrough behaviour if it applies (OPEN: `test/passthrough-mask.test.ts` exists, not read).

### 6.5 Data (`sample-data/quote/jupiter-knitting/`, JSON only, matching the ERPNext-set rule in memory)
Converted from the pack generated in this session (CALC). Files: `products.json`, `customers.json`, `inventory-lots.json`, `sailings.json`, `air.json`, `treasury-ledger.json`, `business-policy.json` (target 15%, advance lever, premiums 4%/8%, overhead $300, customs 4d, drayage 1d, inland days).
Later: Treasury reads AR/AP from the existing `jupiter-knitting.erpnext-data.json` instead of the sample ledger.

## 7. Signatory design (DESIGN)

### 7.1 Files
| Path | Role |
|---|---|
| `config/quote-authority.json` | `{levels:[{id:"AGENT", alias:"jupiterSellerAgent", minMargin:0.12, minMarginWithAdvance:0.11, maxRounds:3, maxDeadlineSlipDays:3, realloc:[], air:false}, {id:"SALES_OFFICER", alias:"Jupiter_Chief_Sales_Officer", minMargin:0.10, minMarginWithAdvance:0.09, maxDeadlineSlipDays:7, realloc:["TIER2"], airMaxShare:0.10}, {id:"CEO", alias:"Jupiter_Chief_Executive_Officer", preparedBy:"jupiterCeoAgent", minMargin:0.08, realloc:["TIER1","TIER2"], airMaxShare:1.0}], absoluteFloor:0.08, importance:{…bands HIGH/MEDIUM/LOW…}}` |
| `data/quote/inquiries.json` | T01–T09: `{rfq:{…ERPNext-modelled RFQ…}, buyerSim:{budgetCents, concession, behaviour}}` |
| `data/quote/schema/rfq.schema.json`, `quotation.schema.json` | ERPNext-modelled shapes (field names OPEN, §11) |
| `services/shared/outcome-client.mjs` | `createOutcomeClient({baseUrl, tenant, tokenEnv, agentAlias, lei, timeoutMs, fetchImpl})`; returns `{body, api:{service, method, path, httpStatus, ms}}` like the engine's proof blocks; token read from env, never logged |
| `services/runner/quote-objects.mjs` | Build/validate RFQ and Quotation; `messageToBuyer` leak scan (no cost, margin or floor numbers) |
| `services/runner/quote-flow.mjs` | Orchestration (§7.2); pure apart from injected `client`, `buyer`, `decide`, `record`, `onStep` |
| `services/runner/quote-buyer.mjs` | Tommy rules from `buyerSim`; **never imported by seller modules** (test-enforced) |
| `scripts/demo-quote.mjs` + `demo-quote.sh` / `.ps1` | CLI: `--inquiry T01..T09\|all --outcome-url --approve officer,ceo\|ask --out private/quotes --pace-ms` |
| `private/quotes/<id>/inquiry.json`, `round-N.quote.json`, `final.quote.json`, `escalations.json`, `consults.json` | Records (git-ignored) |
| *(iteration 3)* `runner/engine.mjs` + `index.mjs` | mode `quote`: steps `request, verify_buyer, consult, negotiate, escalate_officer, escalate_ceo` then the existing tail from `treasury` (buyer mandate) → `issue` … `decision`; `GET /quotes`; `POST /run {mode:"quote", inquiry}` |

### 7.2 Algorithm (`quote-flow.mjs`)
1. **Consult** as each sub-agent identity: inventory(sku, qty, shipBy) → logistics(lots, deadline) → treasury(freight, realloc, terms, margins). Cache by `(sku, qty, deadline, terms)`.
2. **Supply authority:** if the on-time plan needs Tier-2 reallocation → `SALES_OFFICER`; Tier-1 or air above 10% → `CEO`; if the requested grade is short, offer a same-or-better grade as a counter.
3. **Floors** per level = `pricesAtMargin[level.minMargin]` (or `minMarginWithAdvance` when `liquidity.status = DEFICIT` and advance ≥ 30%) + `reallocPremiumCents`.
4. **Round r = 1..maxRounds:** call `seller/synthesize` → **guard**:
   - price ≥ the current level's floor;
   - quality same or better;
   - split shipment only if the first lot is ≥ 70% and every lot is on time;
   - deadline slip ≤ the level's limit;
   - no counter above the previous counter;
   - `messageToBuyer` clean.
   If the guard fails, the rule proposal is used (schedule: 15% → 13.5% → agent floor). Then send the Quotation to Tommy.
5. **Tommy:** ACCEPT, or COUNTER on price, qty, sku or deadline. A non-price change triggers a **re-consult** of the affected agents (step 1).
6. **Escalation reasons** (any combination, all recorded): `ROUNDS_EXPIRED`, `PRICE_BELOW_AGENT_FLOOR`, `SUPPLY_NEEDS_AUTHORITY`, `DEADLINE_SLIP_OVER_LIMIT`, `BELOW_ABSOLUTE_FLOOR`.
   - Route by importance: HIGH → officer → CEO; MEDIUM → officer only; LOW → decline.
   - Officer: one counter at `max(officerFloor, midpoint(officerFloor, lastAsk))`; approve via `/decide` (CLI: `--approve`).
   - CEO: `seller/synthesize mode:"ceo-brief"` written to the record, then the CEO decides.
   - `BELOW_ABSOLUTE_FLOOR` → best-and-final at the 8% price, then decline.
7. **Record** everything. On agreement, `final.quote.json` holds `{sku, qty, priceCents, shipments, deadline, terms, decidedBy, reasons, attest}`.

### 7.3 Tommy (buyer) side
| Part | POC | Later |
|---|---|---|
| Decisions | `quote-buyer.mjs` rules: counters in round 1; from round 2 accepts any ask ≤ budget; otherwise concedes 50% of the gap, capped at budget; T09 asks for an earlier deadline every round | `--buyer-ai outcome`: OutcomeAI tenant `tommy-hilfiger-europe` (`agents/treasury`, `agents/procurement`, `buyer/synthesize`); or quick option: reuse `llm.mjs` buyer role pointed at the gateway |
| Data | `buyerSim` in `data/quote/inquiries.json` | `sample-data/quote/tommy-hilfiger-europe/` in OutcomeAI |
| Identity | existing `verify_buyer` step (vLEI) | KERI-signed requests |
| Money | existing on-chain mandate (agent 0.10 / CPO 0.25 USDC) | unchanged |

## 8. Scenario set and expected results

T01–T08 are CALC by the generator with rules only; T09 is **OPEN** (not computed yet).

| ID | Tommy asks | Path | Expected (rules) | On-chain (CALC, scale 1:1e6) |
|---|---|---|---|---|
| T01 | 20k 180-A @425, by 01-08 | accept round 1 | ACCEPT 425, R0, agent | 0.085 USDC, agent pays |
| T02 | 18k @390, by 01-12 | counter, price | ACCEPT 411, R2, agent | 0.07398, agent pays |
| T03 | 30k @375, by 01-05 | counter, price; std + express sea | ACCEPT 413, R3, agent | 0.1239, CPO approves |
| T04 | 40k @415, by 01-05 | counter, **quantity** split → re-consult | ACCEPT 423, R2, agent | 0.1692, CPO approves |
| T05 | 12k **Grade B** @350, by 12-30 | counter, **quality** B→A → re-consult | ACCEPT 425, R2, agent | 0.051, agent pays |
| T06 | 25k @370, by 01-12 | escalate: **rounds + deviation** | ACCEPT 410, R4, Sales Officer | 0.1025, CPO approves |
| T07 | 45k @380, by 12-31, 30% advance | escalate: **deviation only** (Tier-1 + Tier-2 reallocation) | ACCEPT 418 (incl. 12c premium), CEO | 0.1881, CPO approves |
| T08 | 20k @340, by 01-12 | escalate → **decline** (below 8%) | DECLINE, best-and-final 384 | nothing issued |
| T09 | price OK, earlier deadline each round | escalate: **rounds only** | officer approves a ≤7-day slip (DESIGN) | OPEN |

The oracle file is `expected_outcomes.csv` (CALC) → `chainaim-signatory/services/test/fixtures/quote-expected-outcomes.csv`.
With the AI on, prices may differ, but the guard keeps every result within the same authority bands. Tests assert bands and deciders, not exact AI prices.

## 9. Templates

T1–T8 are in `agent_query_templates.md` (generated this session). Mapping:
- T1 → `data/quote/inquiries.json` (`rfq`)
- T2–T4 → OutcomeAI request bodies (§6.3)
- T5 → OutcomeAI `seller/synthesize` system prompt (stored in OutcomeAI `config/quote-prompts/seller-round.md`, `ceo-brief.md`)
- T6 → `quote-objects.mjs` Quotation
- T7 → officer step text
- T8 → CEO brief

## 10. Judges' package (DESIGN, local-first)

| Tier | Needs | Commands |
|---|---|---|
| 0 — rules | Docker (or Node 24) + Node 22; no keys | `cd chainiam-private-ai && docker compose --profile quote up -d quote-agents` → `cd ../enh-3-signatory/chainaim-signatory && bash scripts/demo-quote.sh --all` (or `.ps1`) |
| 1 — NEAR AI TEE | + `NEARAI_API_KEY` in `chainiam-private-ai/.env` (never in chat/git) | `docker compose --profile quote --profile attest up -d gateway presidio attest quote-agents` → `demo-quote.sh --all --ai nearai` |
| 2 — full (vLEI + NEAR pay) | owner's machine | existing `scripts/signatory.sh start` + runner mode `quote` (iteration 3); README tx links + video for judges |

Hosting: do not host Signatory (it needs NEAR keys and the vLEI stack). Optionally host OutcomeAI quote-agents + gateway + attest on Railway (the gateway, paywall and presidio already have `railway.json`, V-READ) so Tier 1 needs no key. The cost and availability risk is the owner's call (OPEN).

## 11a. Q0 gate results (2026-11-14, read-only)
| ID | Result | Tag |
|---|---|---|
| O1 | 8760 = `agent`; **8780 = `ca-control-signer`** (compose comments L144, L206). quote-agents moved to **8786**; "8786" is not in `docker-compose.yml`. A host-wide check is still MANUAL: `netstat -ano \| findstr :8786`. | V-READ / MANUAL |
| O2 | Gateway auth: `authorized(req, key)` in `server.ts` — when a key is configured, `Authorization: Bearer <key>` is required (timing-safe compare); with no key it is open. quote-agents sends the gateway key from env (name only, e.g. `CHAINAIM_GATEWAY_KEY`; exact compose wiring via the `gateway-key` volume still to read). | V-READ (mechanism) / OPEN (wiring) |
| O3 | Residual guard: default **`--residual-min-digits 9`**; spaced groups count only at ≥ 10 digits; **ISO dates and times are excluded**; digits split by "." count as amounts, and commas split runs. Quote prompts use ≤ 6-digit numbers and ISO dates, so **R1 risk is low**. Rule: never send cent totals ≥ 9 digits; send USD totals. Presidio may still mask locations or names (masked, then restored). | V-READ |
| O4 | `rig/tenants/t01/tenant.json` exists: `"name": "Jupiter Knitting (synthetic test tenant)"`, fields `seedPrefix`, `address`, `near{accountId, keyEnv}`, `policy{autoApproveMaxUsd, …, counter{maxRounds:2}}`. It is the **paywall paid-jobs rig** (AI-job buying), not ERP data. Recommendation (DECISION for owner): keep a separate `config/quote-tenants.json` and link Jupiter to `"rigTenant": "t01"` for continuity; there is no Tommy tenant in the rig. | V-READ / DECISION |
| O5 | ERPNext Quotation (official docs, docs.frappe.io/erpnext/quotation): **Quotation To** (Customer or Lead), **Party**, **Date**, **Valid Till**, Order Type, Company, items, taxes, payment terms; statuses incl. Lost/Expired/Cancelled. Item-level field names (`item_code`, `qty`, `rate`, …) and the Request for Quotation doctype are **not yet verified**. | V-WEB / OPEN |

## 11. Open items (check before or while building)
| ID | Item | How to close | Iteration |
|---|---|---|---|
| O1 | Port 8786 free | `netstat -ano \| findstr 8786` | 0 |
| O2 | **CLOSED (V-READ)**: gateway `authorized()` = `Authorization: Bearer <key>`, timing-safe compare; no key configured = open. Compose passes env `CHAINAIM_GATEWAY_KEY`; secret file `test-console/local-gateway-key.txt`. → quote-agents sends `Bearer ${CHAINAIM_GATEWAY_KEY}`. | — | 0 |
| O3 | **Mostly CLOSED (V-READ `privacy/residual.ts`)**: `digits` refuses runs of **≥ 9 digits** (joined by nothing, `-` or `/`; `.` excluded so amounts pass); `spaced_digits` ≥ 10; ISO dates/times are stripped before the check. Our values (qty ≤ 80000, cents ≤ 3 digits/unit, USD totals ≤ 6 digits, ISO dates) pass. Rule: send USD totals, never cent totals; never send LEIs or account numbers. Remaining: Presidio masks **locations** by default (Chennai, Los Angeles) — answers are restored by the gateway; confirm in Q5. | Q5 live call | 5 |
| O4 | **CLOSED (V-READ `rig/tenants/t01/tenant.json`)**: rig tenants are paywall *payer* tenants (t01 = "Jupiter Knitting (synthetic test tenant)", XRPL/NEAR accounts, spend policy, counter maxRounds 2). Different purpose → keep a separate `config/quote-tenants.json`, with field `rigTenant: "t01"` as a cross-reference only. | — | 0 |
| O5 | ERPNext RFQ / Quotation field names | official ERPNext doctype JSON (`request_for_quotation`, `quotation`) — fetch or owner provides | 0 |
| O6 | NEAR AI response carries a `reasoning` field for deepseek-v4.1-flash through the gateway | `gateway/src/chat.ts` L437 copies `reasoning` in stream deltas (V-READ); confirm non-stream with one live call | 2 |
| O7 | UI renders unknown steps generically? | read `UI/Agent Escalation Console.html` step renderer | 3 |
| O8 | T09 numbers | run the generator with T09 | 1 |
| O9 | NEAR AI offers Nemotron in the TEE? | NEAR AI model list (not in local catalogs) | later |
| O10 | `desk.ps1` / `up.ps1` should start quote-agents too | read `up.ps1` | 3 |

## 12. Iteration plan

Times are estimates. **AI** = Claude builds; **MANUAL** = owner.

| # | Item | Pri | Punchline | Tracks | Status/work | Files | Time | Who |
|---|---|---|---|---|---|---|---|---|
| Q0 | Read-only gate checks O1–O5 | MVP | No surprises | both | not started | — | 30m | AI (O1: MANUAL `netstat`) |
| Q1 | OutcomeAI quote-agents, rules only + data JSON + tenants | MVP | Jupiter's private data plane answers | Private AI | not started | `services/quote-agents/*`, `sample-data/quote/jupiter-knitting/*`, `config/quote-tenants.json`, `.env.example` (names) | 60m | AI |
| Q2 | Signatory quote-flow + client + buyer rules + authority + records + CLI | MVP | Negotiation + escalation end to end | Governance | not started | `config/quote-authority.json`, `data/quote/*`, `services/shared/outcome-client.mjs`, `services/runner/quote-{flow,buyer,objects}.mjs`, `scripts/demo-quote.*` | 60m | AI |
| Q3 | Tests: oracle T01–T09, guard, isolation, leak scan | MVP | Proven, repeatable | QA | not started | `services/test/quote.test.mjs` (Signatory); `services/quote-agents/test/*` (OutcomeAI) | 30m | AI |
| Q4 | Compose service `quote-agents` (profile `quote`) | MVP | One command for judges | Demo | not started | `docker-compose.yml`, `services/quote-agents/Dockerfile` | 20m | AI |
| Q5 | `seller/synthesize` via gateway → NEAR AI + attest (async) | High | Private AI decides, attested | NEAR AI / TEE | after Q0 O2/O3 | `services/quote-agents/src/synthesize.ts`, `config/quote-prompts/*` | 45m | AI |
| Q6 | Live Tier 1 run with key | High | Real TEE answers | Demo | after Q5 | — | 15m | MANUAL (key in `.env`; walked one step at a time) |
| Q7 | Runner mode `quote` + UI chips + `/decide` reuse | Med | Same console as N1–N4 | Demo | after Q3 | `runner/engine.mjs`, `runner/index.mjs`, `UI/…Console.html`, `scripts/signatory.sh` | 90m | AI |
| Q8 | Judges README + `demo-quote.ps1` + `desk/up` hook | High | Judges run it in 2 commands | Demo | after Q4 | `README.md` (both repos), `test-console/up.ps1` (O10) | 30m | AI |
| Q9 | Tommy tenant (`--buyer-ai outcome`) | Later | Both sides reason privately | Private AI | after hackathon | OutcomeAI tenant data + endpoints | 60m | AI |
| Q10 | KERI-signed agent requests; escalation decisions KERI-signed | Later | Identity proven per call | vLEI | after hackathon | both | — | AI + MANUAL |

**Critical path to a judgeable demo:** Q0 → Q1 → Q2 → Q3 → Q4 → Q8 (≈ 3h50m, rules only). Add Q5 → Q6 for the TEE (+1h). Q7 only if time remains; the CLI is the fallback demo.

**Exit criteria per iteration:**
- Q1: `curl` T01–T08 answers match the oracle inputs (landed cost, floors, plan).
- Q2/Q3: `npm test` green: the existing 90 Signatory tests unchanged plus the new quote tests; T01–T09 deciders and bands match.
- Q4: `docker compose --profile quote up` → `/healthz` ok.
- Q5/Q6: at least one round with `source:"ai"` and attest `verdict:"verified"`.
- Q8: a fresh clone on a second PC runs Tier 0 with the README alone (MANUAL check).

## 13. Testing summary
- **No keys, no network:** `outcome-client` mocked with recorded fixtures (`services/test/fixtures/quote-agent-responses/*.json`).
- **Isolation:** a Jupiter token gets 403 on the Tommy tenant; the seller modules never read `buyerSim` (spy on the module graph and file reads).
- **Guard:** never below the level floor, never a quality downgrade, split ≥ 70%, slip ≤ limit, no cost/margin/floor numbers in `messageToBuyer`.
- **Fallbacks:** AI timeout, 422 residual refusal, bad JSON → `source:"rules"`; attest unverified → badge `unverified`, the decision unchanged.
- **Regression:** order mode N1–N4 untouched (existing tests).

## 14. Risks
| Risk | Effect | Mitigation |
|---|---|---|
| R1 residual guard refuses numeric prompts | AI never used | O3 first; JSON fields; scale numbers; rules fallback keeps the demo working |
| R2 NEAR AI latency or signature delay | slow rounds | async attest; `--timeout-ms`; rules fallback |
| R3 deadline (≈14h left at writing) | unfinished UI | CLI demo is complete on its own; Q7 optional |
| R4 judges lack Docker | can't run Tier 0 | quote-agents also runs with `node` directly (no npm deps) — `node services/quote-agents/src/main.ts` |
| R5 port clash | services fail to start | flags for every port; O1 |
