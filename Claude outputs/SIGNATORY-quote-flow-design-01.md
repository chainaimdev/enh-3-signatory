# Signatory — quote flow design (Tommy → Jupiter inquiry, negotiation, vLEI escalation)

Codebase: `enh-3-signatory/chainaim-signatory` · Date: 2026-11-14 · Status: **DESIGN — nothing built, no code changed**
Companion: `OUTCOMEAI-quote-agents-design-01.md` (the service this calls). Shared contract: §4 (identical in both files).
Suggested place in repo (owner's choice): `DESIGN-2/signatory-quote-flow-design-01.md`.

> **Path check (OPEN):** the files read for this design are at `C:\SATHYA\CHAINAIM3003\mcp-servers\enh-3-signatory`. You also gave `C:\SATHYA\CHAINIAM3003\mcp-servers\CHAINAIM-DEV\enh-3-signatory` (note `CHAINIAM` and `CHAINAIM-DEV`). Confirm which copy is the working one before building. If they differ, the V-READ facts below refer to the first path.

Tags: **V-READ** read in code today · **CALC** computed by the generator this session · **DESIGN** proposed · **ASSUMED** · **OPEN** · **DECIDED** owner decision in chat.

---

## 1. Role of Signatory in this flow
Signatory is the **identity and governance** side:
- receives Tommy's inquiry (RFQ);
- lets `jupiterSellerAgent` consult Jupiter's three sub-agents in OutcomeAI;
- applies Jupiter's **authority matrix**;
- runs the rounds with Tommy;
- escalates to the Sales Officer → CEO agent → CEO (all vLEI identities);
- writes the inquiry/quote records;
- (later) hands the agreed deal to the existing vLEI invoice → NEAR payment tail.

DECIDED: no model and no model key in Signatory; inquiry and quote objects and records live here; Tommy's simulated budget lives here (precedent `data/orders.json`).

## 2. Verified facts (V-READ)
| Fact | Source |
|---|---|
| Order mode steps `STEPS_C`: preflight, request, verify_buyer, swarm, negotiate, verify_seller_agent, escalation, treasury, issue, offer, verify_seller, accept, register, pay, outcome, decision | `services/runner/engine.mjs` L41 |
| Officer decision on a failed negotiation: `waitForDeal` + `POST /runs/:id/decide {decision}` (approve/reject) | `engine.mjs` L696–745; `runner/index.mjs` L17–19 |
| Negotiation pattern: AI proposal → guard → rule fallback (`decideMove`); the AI sees only its own limits (`publicStateFor`) | `services/shared/negotiate.mjs` |
| Existing LLM client `llm.mjs`: OpenAI-compatible, key only from env `SIGNATORY_LLM_API_KEY`, roles seller and buyer; used by `--negotiator llm` | `services/shared/llm.mjs`, `runner/index.mjs` L12–14 |
| Swarm: `preDealChecks` (inventory + logistics from one DD5 fixture), `treasuryChecks` (seller profit/NPV + buyer mandate route) | `services/runner/swarm.mjs` |
| Ports: signer 8771, bridge 8772, advisors 8773, runner 8774; UI origin 127.0.0.1:8765 | `config/signatory.json` |
| `chainaim-signatory/private/` is git-ignored | repo `.gitignore` |
| Jupiter (LEI `3358004DXAMRWRUIYJ05`): officers `Jupiter_Chief_Executive_Officer`, `Jupiter_Chief_Sales_Officer`; agents `jupiterCeoAgent`, `jupiterSellerAgent`, `JupiterTreasuryAgent`, `JupiterInventoryAgent`; **no Logistics agent yet** (#14) | `services/test/fixtures/signatory-evidence.fixture.json`, `data/orders.json` |
| Tommy (LEI `54930012QJWZMYHNJW95`): officers `Tommy_Chief_Executive_Officer`, `Tommy_Chief_Procurement_Officer`; agents `tommyCeoAgent`, `tommyBuyerAgent`, `TommyTreasuryAgent` | same fixture |
| Mandates: tommyBuyerAgent 100000 units (0.10 USDC), CPO 250000 (0.25); `demoScale` 1,000,000 | `config/accounts.json`, `config/signatory.json` |
| Existing tests: 90 (`npm test`); contract 48 (`cargo test`) | `README.md` §4.5 |
| Hackathon deadline 14 Nov 2026 23:59 UTC | `ARCHITECTURE-signatory-2026-11-13.md` L7 |

## 3. Design overview
```
tommyBuyerAgent (quote-buyer.mjs, rules) ──RFQ──► jupiterSellerAgent (quote-flow.mjs)
   1 consult as sub-agents ── outcome-client.mjs ──► OutcomeAI :8785 (inventory → logistics → treasury)
   2 floors = treasury.pricesAtMargin × config/quote-authority.json
   3 round r ≤ 3: OutcomeAI seller/synthesize ─► GUARD (authority) ─► Quotation ─► Tommy (accept | counter)
        counter changes qty/sku/deadline ─► re-consult affected agents
   4 escalate: Sales Officer → jupiterCeoAgent brief → CEO  (CLI --approve now; runner /decide in Q7)
   5 records: private/quotes/<id>/…          6 (Q7) existing tail: buyer mandate → issue → pay on NEAR
```

## 4. Shared API contract (identical in both design files)

All requests: `Content-Type: application/json`, `Authorization: Bearer <tenant token>`, `X-Agent-Alias: <vLEI alias>`, `X-Agent-LEI: <tenant LEI>`, body field `requestId`.
Errors: `{error:{code, message}}` with 400, 401, 403, 404, 422, 502/504.

| Method · Path | Request | Response |
|---|---|---|
| `GET /healthz` | — | `{ok, asOf, ai, model, gateway:{ok}, attest:{ok}, tenants:[ids]}` |
| `POST /v1/tenants/{t}/agents/inventory` | `{requestId, sku, qty, shipBy}` | `{sources:[{lot, kind, units, readyDate, warehouse}], reallocatable:[{lot, units, tier, requiredAuthority, premiumPct, replacementOk}], gradeAlternatives:[{sku, grade}], shortfall}` |
| `POST /v1/tenants/{t}/agents/logistics` | `{requestId, sku, lots:[{lot, units, readyDate, warehouse}], deadline, allowAir}` | `{legs:[{lot, units, mode, carrier, etd, delivered, freightCents}], freightCents, meetsDeadline, lateUnits, airOption}` |
| `POST /v1/tenants/{t}/agents/treasury` | `{requestId, sku, qty, freightCents, reallocUnits:{TIER1, TIER2}, termsDays, advancePct, margins:[0.15,0.135,0.12,0.11,0.10,0.09,0.08]}` | `{landedCents, pricesAtMargin:{…}, reallocPremiumCents, liquidity:{net30Usd, status}, advanceLever:{minAdvancePct, marginRelief, applies}, credit:{headroomUsd, ok}}` |
| `POST /v1/tenants/{t}/seller/synthesize` | `{requestId, mode:"round"\|"ceo-brief", inquiry, round, history, answers, authority:{level, floorCents, maxRounds, allowed}}` | `{proposal:{decision, counter:{sku, qty, priceCents, deadline, shipments}}, messageToBuyer, reasoning, source:"ai"\|"rules", model, attest\|null, ms}` |

Tenant `jupiter-knitting` · token env `QUOTE_TOKEN_JUPITER` · LEI `3358004DXAMRWRUIYJ05`. Calls are made as the matching vLEI alias (`JupiterInventoryAgent`, `JupiterLogisticsAgent`, `JupiterTreasuryAgent`, `jupiterSellerAgent`, `jupiterCeoAgent`).

## 5. Files (✚ new · ✎ edit)
| | Path | Content | Iteration |
|---|---|---|---|
| ✚ | `config/quote-authority.json` | levels AGENT (`jupiterSellerAgent`, 12% / 11% with advance, 3 rounds, slip ≤ 3d, no realloc/air) · SALES_OFFICER (`Jupiter_Chief_Sales_Officer`, 10% / 9%, slip ≤ 7d, TIER2 realloc, air ≤ 10%) · CEO (`Jupiter_Chief_Executive_Officer`, prepared by `jupiterCeoAgent`, 8%, TIER1+TIER2, any air); `absoluteFloor` 0.08; importance score and bands HIGH/MEDIUM/LOW | S-1 |
| ✚ | `data/quote/inquiries.json` | T01–T09: `{rfq:{…ERPNext-modelled…}, buyerSim:{budgetCents, concession, behaviour}}` | S-1 |
| ✚ | `data/quote/schema/rfq.schema.json`, `quotation.schema.json` | ERPNext-modelled shapes (field names OPEN, §10) | S-1 |
| ✚ | `services/shared/outcome-client.mjs` | `createOutcomeClient({baseUrl, tenant, tokenEnv, lei, timeoutMs, fetchImpl})` → `call(alias, path, body)` → `{body, api:{service:"outcome", method, path, httpStatus, ms}}`; token from env only, never logged | S-2 |
| ✚ | `services/runner/quote-objects.mjs` | build/validate RFQ and Quotation; `messageToBuyer` leak scan (no cost, margin or floor numbers) | S-2 |
| ✚ | `services/runner/quote-buyer.mjs` | Tommy rules from `buyerSim`: counters in round 1; from round 2 accepts any ask ≤ budget; otherwise moves 50% of the gap, capped at budget; T09 asks for an earlier deadline each round. **Never imported by seller modules.** | S-2 |
| ✚ | `services/runner/quote-flow.mjs` | §6 algorithm; injected `client`, `buyer`, `decide`, `record`, `onStep` | S-2 |
| ✚ | `scripts/demo-quote.mjs` | CLI `--inquiry T01..T09\|all --outcome-url http://127.0.0.1:8785 --approve officer,ceo\|ask --out private/quotes --pace-ms 0` | S-3 |
| ✚ | `scripts/demo-quote.sh`, `scripts/demo-quote.ps1` | judge wrappers: health check OutcomeAI, run all, print a summary table | S-3 |
| ✚ | `services/test/quote.test.mjs` + `fixtures/quote-expected-outcomes.csv` + `fixtures/quote-agent-responses/*.json` | §8 | S-4 |
| ✎ | `README.md` (repo root) | "Quote flow (Private AI + vLEI escalation)" section | S-5 |
| ✎ (Q7, optional) | `services/runner/engine.mjs`, `services/runner/index.mjs` | mode `quote`: steps request, verify_buyer, consult, negotiate, escalate_officer, escalate_ceo, then the existing tail from `treasury`; `GET /quotes`; `POST /run {mode:"quote", inquiry}`; waiter kinds `quote_officer`, `quote_ceo` on the existing `/decide` | S-6 |
| ✎ (Q7, optional) | `UI/Agent Escalation Console.html`, `scripts/signatory.sh` | quote chips; pass `--outcome-url` through | S-6 |
| — | `negotiate.mjs`, `swarm.mjs`, `llm.mjs`, `orders.json`, contract | **no change** (N1–N4 untouched) | — |

**The MVP (S-1 … S-5) only adds files and one README section**, so the 90 existing tests cannot regress.

## 6. Algorithm (`quote-flow.mjs`)
1. **Consult** (cached by sku, qty, deadline, terms): inventory as `JupiterInventoryAgent` → logistics(lots) as `JupiterLogisticsAgent` → treasury(freight, realloc, terms, margins) as `JupiterTreasuryAgent`.
2. **Supply authority:**
   - on-time plan needs TIER2 → SALES_OFFICER;
   - needs TIER1, or air above 10% → CEO;
   - requested grade short → counter with a same-or-better grade;
   - first lot ≥ 70% on time → counter with split shipments.
3. **Floors** per level = `pricesAtMargin[minMargin]` (`minMarginWithAdvance` when liquidity DEFICIT and advance ≥ 30%) + `reallocPremiumCents`.
4. **Rounds 1..3:** `seller/synthesize` as `jupiterSellerAgent` → **guard**:
   - price ≥ the level floor;
   - grade same or better;
   - split ≥ 70%, with every lot on time;
   - deadline slip ≤ the level's limit;
   - no counter above the previous counter;
   - clean `messageToBuyer`.
   A guard failure → the rules proposal. Write `round-N.quote.json`, send the Quotation to Tommy.
5. **Tommy** answers. A non-price change → re-consult the affected agents.
6. **Escalation reasons** (combinable, all recorded): `ROUNDS_EXPIRED`, `PRICE_BELOW_AGENT_FLOOR`, `SUPPLY_NEEDS_AUTHORITY`, `DEADLINE_SLIP_OVER_LIMIT`, `BELOW_ABSOLUTE_FLOOR`.
   - Importance HIGH → officer → CEO; MEDIUM → officer only; LOW → decline.
   - Officer: counter at `max(officerFloor, ceil((officerFloor + lastAsk)/2))`; the buyer accepts if ≤ budget, else offers its budget; approve if budget ≥ floor.
   - CEO: `seller/synthesize mode:"ceo-brief"` as `jupiterCeoAgent` → CEO decision.
   - Below 8% → best-and-final at the 8% price → decline.
7. **Records** in `private/quotes/<RFQ-id>/`: `inquiry.json`, `consults.json` (answers + `api` proof blocks), `round-N.quote.json`, `escalations.json` (reason, level, decision, who, when, AI brief), `final.quote.json` (`{sku, qty, priceCents, shipments, deadline, terms, decidedBy, reasons, source, attest}`).
   - `reasoning` from the model stays in these Jupiter records only.
   - Escalation decisions are recorded by Signatory, **not KERI-signed** (same as N4 today; #15 later — OPEN decision D-Q2).

## 7. Scenarios and expected results (T01–T08 CALC, rules only; T09 OPEN)
| ID | Tommy asks | Path | Expected | On-chain later (CALC) |
|---|---|---|---|---|
| T01 | 20k 180-A @425, by 01-08 | accept in round 1 | ACCEPT 425, R0, agent | 0.085 USDC, agent pays |
| T02 | 18k @390, by 01-12 | counter, price | ACCEPT 411, R2 | 0.07398, agent pays |
| T03 | 30k @375, by 01-05 | counter, price; std + express sea | ACCEPT 413, R3 | 0.1239, CPO approves |
| T04 | 40k @415, by 01-05 | counter, quantity split → re-consult | ACCEPT 423, R2 | 0.1692, CPO approves |
| T05 | 12k Grade B @350, by 12-30 | counter, quality B→A → re-consult | ACCEPT 425, R2 | 0.051, agent pays |
| T06 | 25k @370, by 01-12 | rounds + deviation → Sales Officer | ACCEPT 410, R4 | 0.1025, CPO approves |
| T07 | 45k @380, by 12-31, 30% advance | deviation only (TIER1 + TIER2) → CEO | ACCEPT 418 (12c premium) | 0.1881, CPO approves |
| T08 | 20k @340, by 01-12 | below 8% → decline | DECLINE, best-and-final 384 | nothing issued |
| T09 | price OK, earlier deadline each round | rounds only → Sales Officer slip ≤ 7d | DESIGN, numbers OPEN | OPEN |

With the AI on, prices may differ inside the same authority bands. Tests assert deciders and bands, not exact AI prices.

## 8. Tests (`services/test/quote.test.mjs`, no keys, no network)
1. `quote-authority.json` validates (margin order 15 > 12 > 10 > 8; aliases exist in the vLEI fixture).
2. `quote-objects`: RFQ/Quotation validate; the leak scan rejects messages containing a floor, cost or margin.
3. `quote-flow` with recorded OutcomeAI responses: T01–T08 decision, price, rounds and decider equal the oracle; T09 reasons = `[ROUNDS_EXPIRED]`.
4. Re-consult happens for T04/T05 only (call counter on the client mock).
5. Guard: never below the level floor; never a downgrade; split ≥ 70%; slip ≤ limit.
6. Fallback: synthesize returns `source:"rules"` or HTTP 502 → the flow continues with rules.
7. Isolation: seller modules never import `quote-buyer.mjs` and never read `buyerSim` (module graph + read spy).
8. Records: files written under `private/quotes/<id>/`, with no token in any file.
9. Regression: the existing 90 tests unchanged.

## 9. Iteration plan (Signatory part)
| # | Item | Pri | Punchline | Tracks | Status/work | Files | Time | Who |
|---|---|---|---|---|---|---|---|---|
| S-0 | Confirm working copy path (§ header) and the ERPNext RFQ/Quotation field names | MVP | Build in the right place, right shapes | — | OPEN | — | 10m | MANUAL (path) + AI (ERPNext doctype read) |
| S-1 | Authority config + inquiries + schemas | MVP | Policy and RFQs as data | Governance (vLEI) | not started | `config/quote-authority.json`, `data/quote/*` | 20m | AI |
| S-2 | Client + objects + buyer + flow | MVP | Rounds + escalation end to end | Governance / Private AI | not started | `services/shared/outcome-client.mjs`, `services/runner/quote-{objects,buyer,flow}.mjs` | 50m | AI |
| S-3 | CLI + judge wrappers | MVP | `demo-quote --all` | Demo | not started | `scripts/demo-quote.{mjs,sh,ps1}` | 20m | AI |
| S-4 | Tests + fixtures | MVP | Oracle-proven, offline | QA | not started | `services/test/quote.test.mjs`, `fixtures/quote-*` | 30m | AI |
| S-5 | README section | MVP | Two-command demo | Demo | not started | `README.md` | 10m | AI |
| S-6 | Runner mode `quote` + UI chips | Med | Same console as N1–N4 | Demo | optional, after S-4 | `runner/engine.mjs`, `runner/index.mjs`, `UI/…Console.html`, `scripts/signatory.sh` | 90m | AI |
| S-7 | Live end-to-end with OutcomeAI (rules, then TEE) | High | Real calls | Demo | after OA-5 / OA-7 | — | 15m | MANUAL (walked one step at a time) |
| S-8 | Tommy via OutcomeAI tenant (`--buyer-ai outcome`) | Later | Both sides reason privately | Private AI | after hackathon | `quote-buyer.mjs` + client | 45m | AI |
| S-9 | KERI-signed agent requests + escalation decisions | Later | Identity per call | vLEI | after hackathon | both repos | — | AI + MANUAL |

MVP for Signatory: S-0 → S-5 ≈ **2h20m** (S-2/S-4 can be developed against recorded fixtures before OutcomeAI is running).
Exit: `npm test` green (90 existing + new); `bash scripts/demo-quote.sh --all` against OutcomeAI prints T01–T09 with the expected deciders; records written under `private/quotes/`.

## 10. Open items
| ID | Item | Close by |
|---|---|---|
| S-O1 | Working copy: `C:\SATHYA\CHAINAIM3003\mcp-servers\enh-3-signatory` vs `C:\SATHYA\CHAINIAM3003\mcp-servers\CHAINAIM-DEV\enh-3-signatory` | owner (S-0) |
| S-O2 | ERPNext `Request for Quotation` / `Quotation` field names (not in Jupiter's ERPNext schema in OutcomeAI) | read the official ERPNext doctype definitions (S-0) |
| S-O3 | OutcomeAI port 8785 free (8780 taken) | owner `netstat` |
| S-O4 | UI renders unknown runner steps generically? | read the step renderer in `UI/Agent Escalation Console.html` (S-6) |
| S-O5 | D-Q1 (quote mode next to N1–N4: recommended yes) · D-Q2 (escalation not KERI-signed for now) | owner |
| S-O6 | T09 numbers | generator run at S-1 |

## 11. Combined critical path (both repos)
OA-0 → OA-1 → OA-2 → OA-3 → OA-4 → OA-5 (OutcomeAI, ≈ 2h) in parallel with S-0 → S-5 (Signatory, ≈ 2h20m, against fixtures) → S-7 live (15m). Then OA-6 → OA-7 for the NEAR TEE (+1h). S-6 only if time remains; the CLI demo stands on its own.
