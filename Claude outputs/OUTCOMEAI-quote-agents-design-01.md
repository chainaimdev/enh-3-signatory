# OutcomeAI — quote-agents design (Jupiter private data plane + NEAR AI TEE reasoning)

Codebase: `C:\SATHYA\CHAINAIM3003\mcp-servers\chainiam-private-ai` · Date: 2026-11-14 · Status: **DESIGN — nothing built, no code changed**
Companion: `SIGNATORY-quote-flow-design-01.md` (the caller). Shared contract: §4 (identical in both files).
Suggested place in repo (owner's choice): `DESIGN/privateAI-design-<next number>-quote-agents.md` (OPEN: next free design number).

Tags: **V-READ** read in code today · **CALC** computed by the generator this session · **DESIGN** proposed · **ASSUMED** · **OPEN** · **DECIDED** owner decision in chat.

---

## 1. Role of OutcomeAI in this flow
OutcomeAI is **Jupiter's private data plane**. It answers questions from Jupiter's vLEI-identified agents (called from Signatory) using:
- Jupiter's private business data: stock, sailings, costs, AR/AP, business policy (DECIDED: this data lives **only** here);
- the reasoning model in the **NEAR AI TEE**, through the existing gateway + attest (DECIDED: path A).

It **does not** decide authority, store negotiation state or talk to Tommy. Signatory does that.

## 2. Verified facts (V-READ)
| Fact | Source |
|---|---|
| Gateway: no npm runtime deps, Node runs TypeScript; secrets by env var **name** only in `.env.example`; Presidio down → chat 503; everything sent to a model is masked | `PROJECT_CONTEXT.md` |
| Gateway default `--port 8700`, `--presidio-url http://127.0.0.1:5002`; compose host port **127.0.0.1:8720 → 8700**; network alias `gateway.railway.internal` | `services/gateway/src/main.ts`, `docker-compose.yml` |
| Gateway auth: `Authorization: Bearer <key>`, timing-safe compare; no key configured = open; compose passes env `CHAINAIM_GATEWAY_KEY`, secret file `test-console/local-gateway-key.txt` | `gateway/src/server.ts` `authorized()`, `docker-compose.yml` |
| Attested replies carry headers `x-chainaim-provider-id`, `x-chainaim-served-model`, `x-chainaim-req-sha256`, `x-chainaim-resp-sha256` | `gateway/src/server.ts` L61–68 |
| Residual guard: refuses runs of **≥ 9 digits** (`digits`), ≥ 10 (`spaced_digits`), intl phone, e-mail, titled name; ISO dates/times stripped first; `.` not a joiner (amounts pass) | `gateway/src/privacy/residual.ts` |
| Attest: port 8770, `POST /verify {calls:[{chatId, servedModel, requestSha256, responseSha256, calledAt}]}`, `GET /healthz`; holds `NEARAI_API_KEY`; compose profile `attest`, `127.0.0.1:8770` | `services/attest/src/main.ts`, `docker-compose.yml` |
| Models: `nearai/deepseek-v4.1-flash` (reasoning, NEAR AI TEE), `bedrock/nemotron-nano-3-30b`, `hosted/nemotron-nano-reasoning` | `config/local-models.cpu-all-nearai.json`, `config/catalog.bedrock.json` |
| Compose host ports in use: 8080 paywall, 8720 gateway, 8735 console-api, 8740 analyst, 8750 chain-query, 8760 agent (profile `agent`), 8770 attest, 5004 openrouter-stub (profile `test`) | `docker-compose.yml` |
| **Port 8780 is in use on the owner's PC** (PID 12400, `netstat`) | owner output, 2026-11-14 |
| Jupiter ERPNext data exists: `sample-data/smb-2-erp-fin/erpnext/jupiter-knitting/jupiter-knitting.erpnext-data.json`; schema has `Item`, `Customer`, `Sales Order`; **no** `Quotation`, `Request for Quotation`, `Bin`, `Warehouse` | `_source/jupiter-knitting.erpnext-schema.json` |
| `rig/tenants/t01/tenant.json` = paywall **payer** tenant ("Jupiter Knitting (synthetic test tenant)", XRPL/NEAR accounts, spend policy) — a different purpose from quote tenancy | `rig/tenants/t01/tenant.json` |
| Existing start scripts: `test-console/desk.ps1`, `up.ps1`, `down.ps1`, `stack.ps1` (contents not read) | directory listing |

## 3. New service: `services/quote-agents` (DESIGN)

### 3.1 Runtime and flags
- Node 24, TypeScript run directly, **no npm runtime dependencies** (same rule as the gateway).
- `node services/quote-agents/src/main.ts` with flags (all have defaults; nothing hard-coded):

| Flag | Default | Meaning |
|---|---|---|
| `--port` | **8785** (OPEN: owner confirms free; 8780 is taken) | listen port |
| `--host` | `127.0.0.1` (`0.0.0.0` in compose) | bind address |
| `--data-root` | `sample-data/quote` | tenant data root |
| `--tenants` | `config/quote-tenants.json` | tenant registry |
| `--as-of` | `2026-11-16` | fixed "today" so runs repeat |
| `--ai` | `off` | `off` (rules) · `nearai` · `bedrock` |
| `--model` | `nearai/deepseek-v4.1-flash` | gateway model id (`bedrock/nemotron-nano-3-30b` with `--ai bedrock`) |
| `--llm-via` | `gateway` | `gateway` (masked, DECIDED) · `direct` (fallback) |
| `--gateway-url` | `http://127.0.0.1:8720` (compose: `http://gateway:8700`) | gateway base |
| `--attest-url` | `http://127.0.0.1:8770` (compose: `http://attest:8770`) | attest base |
| `--attest` | `on` when `--ai nearai`, else `off` | verify each AI call |
| `--timeout-ms` | `60000` | per model call |

- Env var **names** (added to `.env.example`; values never in git or chat): `QUOTE_TOKEN_JUPITER`, `QUOTE_TOKEN_TOMMY`. Reuses `CHAINAIM_GATEWAY_KEY` (existing) for the gateway call.

### 3.2 Files
| ✚ new / ✎ edit | Path | Content |
|---|---|---|
| ✚ | `services/quote-agents/src/main.ts` | flags, HTTP server (node:http), routing, JSON errors, `/healthz` |
| ✚ | `services/quote-agents/src/tenants.ts` | load `config/quote-tenants.json`; caller check (token, alias → path, LEI) |
| ✚ | `services/quote-agents/src/data.ts` | load and validate tenant JSON data (as-of date) |
| ✚ | `services/quote-agents/src/inventory.ts` | stock available to promise, WIP, production, reallocatable lots, grade alternatives |
| ✚ | `services/quote-agents/src/logistics.ts` | sailing by cutoff, delivered = ETA + customs + drayage, sea → express → air |
| ✚ | `services/quote-agents/src/treasury.ts` | landed cost, prices at requested margins, liquidity (AR/AP 30d), advance lever, buyer credit; **never returns unit cost** |
| ✚ | `services/quote-agents/src/synthesize.ts` | rules proposal; AI branch (Q5): prompt → gateway → parse → async attest |
| ✚ | `services/quote-agents/src/rules.ts` | concession schedule 15% → 13.5% → floor (rules fallback, same maths as the generator) |
| ✚ | `services/quote-agents/package.json` | `"type":"module"`, scripts `start`, `test` (no dependencies) |
| ✚ | `services/quote-agents/Dockerfile` | node:24-slim, copy src + config + sample-data/quote |
| ✚ | `services/quote-agents/test/*.test.ts` | §7 |
| ✚ | `config/quote-tenants.json` | §3.3 |
| ✚ | `config/quote-prompts/seller-round.md`, `ceo-brief.md` | T5 system prompts (Q5) |
| ✚ | `sample-data/quote/jupiter-knitting/` | `products.json`, `customers.json`, `inventory-lots.json`, `sailings.json`, `air.json`, `treasury-ledger.json`, `business-policy.json` (JSON only, converted from the pack, CALC) |
| ✚ | `sample-data/quote/tommy-hilfiger-europe/README.md` | placeholder for the later buyer tenant (no data in the MVP) |
| ✎ | `docker-compose.yml` | add service `quote-agents`: profile `quote`, ports `127.0.0.1:8785:8785`, env `QUOTE_TOKEN_JUPITER`, `QUOTE_TOKEN_TOMMY`, `CHAINAIM_GATEWAY_KEY`; `depends_on: gateway` only with the `ai` profile |
| ✎ | `.env.example` | add the two token names |
| ✎ | `README.md` | "Quote agents (Signatory demo)" section: start, flags, endpoints |
| — | gateway, attest, paywall, analyst | **no change** |

### 3.3 Tenant registry `config/quote-tenants.json`
```json
{
  "jupiter-knitting": {
    "lei": "3358004DXAMRWRUIYJ05", "dataDir": "jupiter-knitting", "tokenEnv": "QUOTE_TOKEN_JUPITER", "rigTenant": "t01",
    "agents": {
      "JupiterInventoryAgent": ["agents/inventory"], "JupiterLogisticsAgent": ["agents/logistics"],
      "JupiterTreasuryAgent": ["agents/treasury"], "jupiterSellerAgent": ["seller/synthesize"], "jupiterCeoAgent": ["seller/synthesize"]
    }
  },
  "tommy-hilfiger-europe": {
    "lei": "54930012QJWZMYHNJW95", "dataDir": "tommy-hilfiger-europe", "tokenEnv": "QUOTE_TOKEN_TOMMY",
    "agents": { "TommyTreasuryAgent": ["agents/treasury"], "tommyBuyerAgent": ["agents/procurement", "buyer/synthesize"] }
  }
}
```
LEIs and agent aliases are V-READ from Signatory's `config/accounts.json` and vLEI evidence. A token for one tenant gets **403** on the other tenant's paths.

## 4. Shared API contract (identical in both design files)

All requests: `Content-Type: application/json`, `Authorization: Bearer <tenant token>`, `X-Agent-Alias: <vLEI alias>`, `X-Agent-LEI: <tenant LEI>`, body field `requestId`.
Errors: `{error:{code, message}}` with 400 (bad body), 401 (token), 403 (alias/path/LEI), 404 (tenant/path), 422 (data cannot answer), 502/504 (model/attest).

| Method · Path | Request | Response |
|---|---|---|
| `GET /healthz` | — | `{ok, asOf, ai, model, gateway:{ok}, attest:{ok}, tenants:[ids]}` |
| `POST /v1/tenants/{t}/agents/inventory` | `{requestId, sku, qty, shipBy}` | `{sources:[{lot, kind:"FREE"\|"WIP"\|"PRODUCTION", units, readyDate, warehouse}], reallocatable:[{lot, units, tier:"TIER1"\|"TIER2", requiredAuthority:"SALES_OFFICER"\|"CEO", premiumPct, replacementOk}], gradeAlternatives:[{sku, grade}], shortfall}` |
| `POST /v1/tenants/{t}/agents/logistics` | `{requestId, sku, lots:[{lot, units, readyDate, warehouse}], deadline, allowAir}` | `{legs:[{lot, units, mode:"SEA_STD"\|"SEA_EXP"\|"AIR", carrier, etd, delivered, freightCents}], freightCents, meetsDeadline, lateUnits, airOption:{deliveredBy, centsPerUnit, maxUnits}\|null}` |
| `POST /v1/tenants/{t}/agents/treasury` | `{requestId, sku, qty, freightCents, reallocUnits:{TIER1, TIER2}, termsDays, advancePct, margins:[0.15,0.135,0.12,0.11,0.10,0.09,0.08]}` | `{landedCents, pricesAtMargin:{"0.15":n,…}, reallocPremiumCents, liquidity:{net30Usd, status:"SURPLUS"\|"DEFICIT"}, advanceLever:{minAdvancePct, marginRelief, applies}, credit:{headroomUsd, ok}}` |
| `POST /v1/tenants/{t}/seller/synthesize` | `{requestId, mode:"round"\|"ceo-brief", inquiry, round, history, answers:{inventory, logistics, treasury}, authority:{level, floorCents, maxRounds, allowed}}` | `{proposal:{decision:"ACCEPT"\|"COUNTER"\|"ESCALATE", counter:{sku, qty, priceCents, deadline, shipments}}, messageToBuyer, reasoning, source:"ai"\|"rules", model, attest:{chatId, servedModel, verdict}\|null, ms}` |
| later: `/v1/tenants/tommy-hilfiger-europe/agents/treasury`, `/agents/procurement`, `/buyer/synthesize` | buyer mirror | — |

Data rules on the wire: prices in **US cents per unit** (integers); totals in **USD**; ISO dates. Never send cent totals, LEIs or account numbers to the model (residual guard, §2).

## 5. Computation rules (DESIGN; the same maths as the generator that produced the CALC oracle)
- **Inventory:** stock available to promise = on hand − reserved − QC hold. Source order: FREE → WIP_FREE → new production (ready = as-of + lead days + 2 days QC, up to the capacity per cycle) → TIER2 reallocation (Sales Officer) → TIER1 reallocation (CEO).
- **Logistics:** at port = ready date + inland days (MADRAS 1, TIRUPUR 2). Take the first sailing whose cutoff (ETD − 2) is ≥ the at-port date. Delivered = ETA + 4 (customs) + 1 (drayage). Choose the cheapest mode that meets the deadline; air only when allowed. Containers = ceil(units ÷ units per 40HC).
- **Treasury:**
  - landed = (qty × unit cost + freight + $300 overhead) ÷ qty;
  - price at margin m = ceil(landed ÷ (1 − m));
  - 30-day net = cash + credit headroom + current AR due ≤ 30d − AP due ≤ 30d;
  - DEFICIT + advance ≥ 30% → one margin point of relief;
  - credit OK if invoice ≤ limit − open receivable.
- **Rules proposal:** round 1 ask = 15%, round 2 = 13.5%, round 3 = the floor sent by Signatory. Accept if the buyer's price ≥ the current ask.

## 6. AI synthesis (Q5, DESIGN)
1. Load `config/quote-prompts/seller-round.md` (or `ceo-brief.md`). The user content is a compact JSON context (numbers as fields).
2. `POST {gateway}/v1/chat/completions` with `Authorization: Bearer ${CHAINAIM_GATEWAY_KEY}`, model per `--model`, `temperature 0.2`.
3. Read the 4 `x-chainaim-*` headers. Fire `POST {attest}/verify` **without waiting**; the result lands in the response field `attest.verdict` when it is ready within `--timeout-ms`, otherwise `"pending"`.
4. Strict JSON parse. On 422 (residual), timeout, or bad JSON → the rules proposal with `source:"rules"` and `reasonAiSkipped`.
5. `reasoning` is returned to Signatory (Jupiter-internal record only; Signatory never forwards it to Tommy).
- OPEN: confirm a non-stream reply carries `reasoning` for deepseek-v4.1-flash (`gateway/src/chat.ts` L437 copies `reasoning` in stream deltas, V-READ).
- OPEN: Presidio masks locations by default (Chennai, Los Angeles); the gateway restores placeholders in the answer. Confirm in the first live call.

## 7. Tests (`services/quote-agents/test/`)
| Test | Asserts |
|---|---|
| `tenants.test.ts` | wrong token 401; alias not allowed for the path 403; LEI mismatch 403; Jupiter token on the Tommy tenant 403 |
| `inventory.test.ts` | T01–T08 sources and shortfall match the CALC oracle |
| `logistics.test.ts` | legs, delivered dates and freight match the oracle (incl. T03 std + express split) |
| `treasury.test.ts` | landed cents, prices at 15/12/10/8 match the oracle; unit cost absent from every response |
| `synthesize.test.ts` | rules proposals per round; AI branch with a stubbed gateway: valid → `source:"ai"`; 422/timeout/bad JSON → `source:"rules"`; attest headers forwarded |
| `http.test.ts` | `/healthz`, 404/400 paths, JSON error shape |

Run: `node --test services/quote-agents/test/*.test.ts` (the repo already runs TS tests with Node; OPEN: confirm the exact flags used by the gateway's `npm test`).

## 8. Iteration plan (OutcomeAI part)
| # | Item | Pri | Punchline | Tracks | Status/work | Files | Time | Who |
|---|---|---|---|---|---|---|---|---|
| OA-0 | Confirm port **8785** free | MVP | No clash | Ops | 8780 taken (PID 12400) | — | 2m | MANUAL `netstat -ano \| findstr :8785` |
| OA-1 | Data JSON + tenant registry | MVP | Jupiter's private data in one place | Private AI | not started | `sample-data/quote/jupiter-knitting/*.json`, `config/quote-tenants.json` | 15m | AI |
| OA-2 | quote-agents service, rules only | MVP | Three sub-agents + rules synthesis answer | Private AI | not started | `services/quote-agents/src/*`, `package.json` | 45m | AI |
| OA-3 | Tests | MVP | Matches the oracle; tenants isolated | QA | not started | `services/quote-agents/test/*` | 25m | AI |
| OA-4 | Compose service + `.env.example` names | MVP | One command start | Demo | not started | `docker-compose.yml`, `.env.example`, `services/quote-agents/Dockerfile` | 20m | AI |
| OA-5 | README section | MVP | Judges can start it | Demo | not started | `README.md` | 10m | AI |
| OA-6 | AI synthesis via gateway + async attest | High | NEAR TEE reasoning, attested | NEAR AI / TEE | after OA-3 | `src/synthesize.ts`, `config/quote-prompts/*` | 45m | AI |
| OA-7 | Live NEAR AI run | High | Real attested answer | Demo | after OA-6 | — | 15m | MANUAL (key in `.env` only; never in chat) |
| OA-8 | Tommy tenant endpoints | Later | Buyer reasons privately too | Private AI | after hackathon | tenant data + `agents/procurement`, `buyer/synthesize` | 60m | AI |

MVP for OutcomeAI: OA-0 → OA-5 ≈ **2h**. Exit: `curl` each endpoint for T01–T08 → values equal the oracle; `docker compose --profile quote up -d quote-agents` → `/healthz` ok; existing repo tests unchanged.

## 9. Run commands (DESIGN)
```powershell
# local, no Docker, rules only
node services/quote-agents/src/main.ts --port 8785 --ai off
# Docker, rules only
docker compose --profile quote up -d quote-agents
# Docker, NEAR AI TEE (NEARAI_API_KEY + CHAINAIM_GATEWAY_KEY set in .env)
docker compose --profile quote --profile attest up -d presidio gateway attest quote-agents
curl http://127.0.0.1:8785/healthz
```

## 10. Open items
| ID | Item | Close by |
|---|---|---|
| O1 | Port 8785 free | owner `netstat` (OA-0) |
| O6 | non-stream `reasoning` field via the gateway | OA-7 live call |
| O7 | Presidio location masking + restore on quote prompts | OA-7 live call |
| O8 | exact Node test flags used by the repo | read root `package.json` scripts at OA-3 |
| O9 | Is the gateway's current mode (set by `switch-models.ps1` / `up.ps1`) one that routes `nearai/*`? (compose comment: only the `ollama-cpu-8gb-all-nearai` mode uses `NEARAI_API_KEY`) | read `up.ps1` / `switch-models.ps1` at OA-6 |
| O10 | next free `privateAI-design-NN` number | owner |
