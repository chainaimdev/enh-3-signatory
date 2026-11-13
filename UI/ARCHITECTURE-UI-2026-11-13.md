# ARCHITECTURE — UI part (Signatory UI): all remaining UI work

Date: 2026-11-13 · Status: PLAN. Companions: `ARCHITECTURE-vLEI-2026-11-13.md` (legentvLEI) and `ARCHITECTURE-signatory-2026-11-13.md` (NEAR contract + services + ship, in `enh2-final\chainaim-signatory`).
Single UI file: `C:\SATHYA\CHAINIAM3003\mcp-servers\CHAINAIMDEV\enh2-final\UI\Agent Escalation Console.html` (D-UI-01: edited in place; same theme and layout).
Tags: V-READ = checked in the files 13 Nov · ASSUMED = not verified · GATE = open · AI / MANUAL = who does it.
Rules: nothing is built until the owner says `PROCEED TO CHANGE <phase>`; no fake values; git commit deferred (owner, 13 Nov).

---

## 0.0 Status of the parts the UI depends on (updated 13 Nov 14:24 IST: S-1..S-6 done, NEAR backend proven live)

- **vLEI #1–5 done**: evidence (07:22 UTC) has `invoices[]` = INV-2026-0003 `EBQy-FlP…` 0.084 USDC and INV-2026-0004 `EHusycc5…` 0.1575 USDC, both `admit · held · issuance-verified` true. UI-1 still reads only `invoice` (first); UI-1.5 must read `invoices[]`.
- **Signatory S-1, S-2a, S-2b, S-3 done**: contract live on `chainaim-signatory.testnet` (initialised, 0 events); registrar account **`chainaim-vlei-registrar.testnet`** (renamed from `chainaim-bridge.testnet`; the service is still called "bridge"); mandates on chain: buyer agent `chainaim-tommy-buyer-agent.testnet` limit 0.10 USDC (100000), approver CPO; CPO `chainaim-tommy-cpo.testnet` limit 0.25 (250000), approver = contract owner; payee `chainaim-jupiter-payee.testnet`; agent holds 20 USDC. `UI/data/accounts.json` was re-copied by `set-mandates.sh`.
- **Do not hand-edit `signatory-config.json`**: `node scripts/health.mjs --write-ui-config` (Signatory repo) writes `contractId` only after `get_config` passes and each service URL only after its `/health` passes. Run it when UI-2 starts.
- **Signatory S-4, S-5, S-6 DONE (13 Nov 14:24 IST) — UI-2 is unblocked.** Services run in WSL Ubuntu (`cd …/chainaim-signatory/services`): signer `node signer/index.mjs` → `http://127.0.0.1:8771` (keys: buyer agent + CPO; `gasTgas` 150; `POST /pay {said}`, `/approve {said}`, `/reject {said}`, `/revoke {account}`, `GET /health`); bridge `node bridge/index.mjs` → `http://127.0.0.1:8772` (key: `chainaim-vlei-registrar.testnet`; `POST /register {said, tamperField?}`, `POST /check`, `GET /health`). Both allow only Origin `http://127.0.0.1:8765` (no Origin = allowed). Responses carry `txHash`, `txUrl` (nearblocks), `outcome {event, …}`, and for `/pay` `usedUnits` / `refundedUnits`.
- **Live testnet state after S-6 (the UI must show this, not reset it):** INV-2026-0003 `EBQy-FlP…` **paid** (register `3RaUB3…`, revoke `7kHEn3…`, pay refused "mandate revoked" refund 84000 `BQ8zFt…`, reset via `set-mandates.sh`, pay paid `within_limit` `EhENXV…`); INV-2026-0004 `EHusycc5…` **paid** (register `FefFaa…`, pay `payment_pending` `BFaZCF…`, CPO approve → paid `via approved` `8uLtun…`); tamper on INV-0003 refused `sent:false`; private callbacks refused (`A1AHCD…`, `3z71sV…`), state unchanged. Agent mandate active (not revoked). Payee holds 0.2415 USDC.
- **Consequence for UI-2:** both current invoices are already `paid`, so scenes 1, 2 and 4 cannot be re-run on them; the UI shows them as completed history (events from `get_events`, tx links). Fresh live runs need new invoices: the final rebuild issues INV-2026-0003/0004 again with new SAIDs plus INV-2026-0005 (0.12 USDC) for the reject path. Scene 3 (tamper) can be re-run any time (no transaction).
- **Before UI-2 runs:** `node scripts/health.mjs --write-ui-config` (Signatory repo) to fill `contractId`, `signerUrl`, `bridgeUrl` in `signatory-config.json` after their checks pass; keep both service terminals open.
- **P1 / S-6 DONE (owner, 13 Nov):** private callbacks refused live (`on_pay_forward` `A1AHCD…`, `on_settle` `3z71sV…`, state unchanged).
- **UI-2 BUILT 13 Nov (AI, after `PROCEED TO CHANGE UI-2`):** `health.mjs --write-ui-config` run first (0 fail; wrote `contractId`, `signerUrl`, `bridgeUrl`). UI-1 copy kept at `baseline/Agent Escalation Console.ui1-2026-11-13.html` (MD5 `663768c2…`). Page reads `accounts.json`, `get_config`, `ft_metadata` (USDC, 6 decimals), `get_mandate` (ladder limits), `get_invoice` (both invoices from `invoices[]`), `get_events` (timeline + Proof trail). **Tx links:** contract events carry no tx hash, so the page asks the FastNear testnet tx index (`txIndexUrl` = `https://tx.test.fastnear.com`, `POST /v0/account` + `/v0/transactions`, CORS allows `http://127.0.0.1:8765`, V-READ 13 Nov) and links a tx only when one of its receipts on the contract, in the event's block, logged exactly `EVENT_JSON:`+event JSON — all 8 events matched (`3RaUB3…`, `7kHEn3…`, `BQ8zFt…`, `EhENXV…`, `FefFaa…`, `BFaZCF…`, `8uLtun…` ×2), same hashes as Signatory §S-6. Scenes 1, 2, 4 disabled with the "already paid" reason (both invoices `paid`); scene 3 runnable; Approve/Reject appear on the CPO node and in scene 2 only while an invoice is `pending`. N2 (RPC down: last values greyed + time), S2 (service down), X1 (service answers verbatim, full JSON under "full answer") built. Tested headless (Edge, live testnet, no button pressed): render, all tx matched, S2/N2 copy, 390 px no overflow.

## 0. Where the UI stands (V-READ 13 Nov 06:3x UTC)

| Item | State |
| --- | --- |
| UI-1 built | `Agent Escalation Console.html` (727 lines), `serve.mjs`, `signatory-config.json`, `baseline/Agent Escalation Console.mock-2026-11-13.html` (MD5 `4f8f0532…`), `data/signatory-evidence.json` (06:23 UTC, checks passed, 7 agents, admit true, no key-like fields) |
| What UI-1 shows | Status strip; both ladders (2 LE, 4 OOR officers, 4 agents, 3 sub-agents, "KEL ✓" ×7, "advisory only" ×3); invoice card INV-2026-0003 0.084 USDC / 84,000.00 USD; 4 scenarios, each disabled with its reason; timeline (issued → grant → admit); Tommy / Jupiter / Proof-trail tabs |
| What "KEL ✓" means today | Structural check by the exporter (`checkDelegation`): child inception is `dip`, `di` = parent, and one of the parent's own events has a seal with `i` = child (V-READ `anchorsSeal`: matches the seal by `i` only, **not** `s`/`d`). **No signature check in the exporter or the UI**; signatures were verified by KERIA when it accepted the events |
| Signatures are verifiable (one-off check, V-READ 13 Nov) | Claude parsed all 11 exported KEL streams and verified every controller-indexed signature (Ed25519, Node built-in crypto) over the exact event bytes with the keys from that identifier's establishment event: **78 ok, 0 bad**. This was a script in Claude's temp folder, not part of the UI or exporter; it shows UI-1.5 is feasible with this data |
| Run | from `UI`: `node serve.mjs --port 8765` → `http://127.0.0.1:8765/Agent%20Escalation%20Console.html` |
| Not committed | whole `UI/` folder is untracked (commit deferred) |

---

## 1. Phases (in build order)

| Phase | What | Depends on (vLEI doc # / Signatory doc S-) | Est. |
| --- | --- | --- | --- |
| UI-1.5 | **G-35** in-browser verification: KEL signatures, event SAIDs, invoice SAID | vLEI #1–2 (G-34, G-36) for the "issuance signed" row only | 2–3 h |
| UI-2 | Scenarios 1, 2, 4 for real (pay, approval, revoke) + NEAR state | none — Signatory S-1..S-6 and vLEI #1–5 done 13 Nov | 3–4 h |
| UI-2R | **D-UI-02** request box over the scenarios (runner) | Signatory S-7 runner | 2 h |
| UI-3 | Scenario 3 tamper demo + Inventory/Treasury advice with attestation badge | Signatory S-5 tamper, S-8 advisors, G-31 | 2 h |
| UI-A | Acceptance pass + video framing | all above | 1 h |

Cut order if time is short: UI-3 first, then UI-2R. UI-1.5 and UI-2 are the core.

---

## 2. Design rules (unchanged from UI-1)

- Same tokens, fonts, light/dark, 3-column floor (Tommy | centre | Jupiter), breakpoints 1100/760, reduced-motion.
- One primary button per card; every disabled control shows its reason as visible text.
- DOM built with `createElement` + `textContent` (no `innerHTML`).
- Ids shown short (8…5) in mono with copy; amounts in two columns (on-chain USDC / real at `demoScale`), decimal strings only (no float maths).
- Ladders always visible (standing facts). The deal area (invoice, scenarios, timeline) reflects real state only.
- No third-party network calls at runtime: libraries are vendored under `UI/vendor/` and served by `serve.mjs`.
  **Conflict today (V-READ):** UI-1 loads IBM Plex from Google Fonts (`fonts.googleapis.com` / `fonts.gstatic.com`,
  lines 7–9 of the HTML), so V4 below would fail. Fix in UI-1.5: vendor the IBM Plex Sans/Mono `.woff2` files (SIL OFL)
  under `UI/vendor/fonts/` with `@font-face`, and add `.woff2` → `font/woff2` to `serve.mjs` (today it serves only
  `.html .js .json .css .svg` and refuses everything else with 403).

---

## 3. UI-1.5 — G-35: verification done by the UI itself

### 3.1 What the browser verifies
| Check | Input (from `signatory-evidence.json`) | Method | Shown as |
| --- | --- | --- | --- |
| Event signatures | each agent's/officer's `kel` (CESR stream: event JSON + attachments) | Parse events; for each, the controller indexed signatures (`-AAB…` group, `AA`-coded Ed25519, 88 chars); verify over the exact event bytes with the current signing key(s) from the latest establishment event (`k`) and threshold `kt` | `sig ✓ n/n` · `sig ✗ event s=3` |
| Event SAIDs | each event's `d` | Blake3-256 over the event with `d` (and `i` for inception) replaced by `#` placeholders of equal length, qb64 encode, compare | `SAID ✓` |
| Chain continuity | `s`, `p` | `s` increments by 1, `p` = previous event `d` | part of `sig ✓` |
| Delegation | child `dip`.`di`, parent seal `{i,s,d}` | parent KEL has an `ixn`/`rot` whose `a[]` holds the child's `{i, s:"0", d}` | `delegation ✓` |
| Invoice integrity | `invoice.acdcRaw` | Blake3-256 SAID recompute of the ACDC → equals `invoice.said` | `invoice SAID ✓` |
| Issuance signed | TEL `iss` event + its KEL anchor (export field from **G-36**) | iss SAID ✓, issuer KEL `ixn` anchors `{i:regk?, s, d:iss.d}`, that `ixn` signature ✓ | `issuance signed by jupiterSellerAgent ✓` (until G-36: "issuance anchor not exported") |

V-READ 13 Nov: the exported KEL begins `{"v":"KERI10JSON00012b_","t":"icp",…,"k":["DLvC…"]…}-VAn-AABAAC2e…-EAB0AAAA…`, i.e. event + attachment group + 1 indexed signature + first-seen couple.
V-READ 13 Nov (parsed all 11 streams): each stream has **7–13 messages across 3–5 identifiers**: the AID's own
events, its delegator chain (e.g. `jupiterCeoAgent` starts with the CEO officer's `icp`, `ixn`), and KERIA agent
identifiers from the OOBI's `/agent/…` part. Totals: `icp` 22, `ixn` 35, `dip` 21, `rpy` 22. Own events: officers
`icp`,`ixn`; agents `dip` (plus `ixn` ×4 for jupiterSellerAgent, ×1 for tommyBuyerAgent). Every event with an `i` carried
`-AAB` (one controller signature). So the parser must: split by the version string's size field, group by `i`, verify
each identifier's events with its own keys, and handle `rpy` messages separately (no `i`; different attachments) or
skip them with "rpy not checked". Only the AID's own events and its delegators' events are shown as its badges.

### 3.2 Code
- Ed25519: **WebCrypto** (`crypto.subtle.verify({name:"Ed25519"}, …)`). V-READ 13 Nov: works in the local Edge
  157 (headless test: generate, sign, verify → `true`). No Ed25519 library is needed for the demo browser; `@noble/ed25519`
  is an optional fallback only for older browsers.
- Blake3 (event and ACDC SAIDs): WebCrypto has no Blake3, so vendor `@noble/hashes` (npm 13 Nov: version 2.4.0) blake3.
  The noble packages are **ES modules** (`"type": "module"`, also `@noble/ed25519` 3.2.0), so the verify code is loaded
  with `<script type="module">` from `UI/vendor/` (not a classic `.min.js`). Pin the version and record each vendored
  file's SHA-256 in `UI/vendor/README.md`.
- New script module section `verify.*`: `parseCesr(stream)`, `verifyEvent(evt, keys, sigs)`, `eventSaid(evt)`, `acdcSaid(raw)`, `verifyKel(aid, events)`, `verifyDelegation(child, parent)`.
- Results stored in `store.verify[aid]`; render badges from it. The exporter's `delegationVerified` becomes a second opinion shown in the Proof trail ("exporter: ✓ · browser: ✓"); if they disagree the row is red.
- Unit test page `UI/verify-test.html` (served only by `serve.mjs`): known-good event, one byte flipped (must fail), wrong key (must fail).

### 3.3 Acceptance UI-1.5
V1 all 7 agents + 4 officers `sig ✓` and `SAID ✓`; V2 flipping one byte in a served copy of the evidence turns exactly that identity red with the event number; V3 invoice `SAID ✓`, and a served copy with `totalAmount` edited shows `invoice SAID ✗`; V4 no network requests outside 127.0.0.1:8765 (DevTools).

---

## 4. UI-2 — scenarios 1, 2, 4 on real NEAR

### 4.1 Data in (all from the Signatory part)
| Source | Use |
| --- | --- |
| `signatory-config.json` | `contractId`, `rpcUrl` (`https://test.rpc.fastnear.com`, tested by adminUI-NEAR), `signerUrl`, `bridgeUrl`, `explorer` + paths |
| `data/accounts.json` | vLEI alias → NEAR account (agent, CPO, payee, bridge) |
| RPC view calls | `get_mandate(account)`, `get_invoice(said)`, `get_events(from_index)` (names fixed by the contract, Signatory §S-2) |
| signer (`:8771`) | `POST /pay {said}`, `/approve {said}`, `/reject {said}`, `/revoke {account}`, `GET /health` → `{ok, txHash}` or `{ok:false, error}` (contract error verbatim) (Signatory §S-4) |
| bridge (`:8772`) | `POST /register {said, tamperField?}` → `{ok, txHash}` or `{ok:false, reason}` (Signatory §S-5) |

### 4.2 Screen changes
- Ladder limit lines: real `get_mandate` values in both units (replaces "not deployed").
- Invoice card: NEAR status chip `not registered → registered → pending → paid / rejected`; "Register on NEAR" enabled only when vLEI checks passed **and** admit ✓ **and** `credentialHeld` ✓ (G-34) — mirrors bridge rule R-IPEX (the bridge enforces it; the UI only reflects it).
- Scenario 1: Run → bridge register (if needed) → signer pay → poll `get_invoice` every `pollMs` → `paid` + tx link.
- Evidence with several invoices (vLEI #5): read `invoices[]` when present, else fall back to `invoice` (UI-1 reads only
  `invoice` today, V-READ). The invoice card gets a selector; each scenario names the invoice it uses by number.
- Scenario 2: uses the second invoice (G-32, INV-2026-0004, 0.1575) → pay → `pending` → approval card on the Tommy CPO node (Approve / Reject) → `paid` or `rejected`.
- Scenario 4: Revoke (as CPO) → next pay shows the contract's refusal verbatim.
- Timeline: NEAR events (`invoice_registered`, `payment_pending`, `payment_approved`, `paid`, `agent_revoked`) with tx links; Proof trail gains NEAR rows.
- States N2 (RPC down, last values greyed with time), S2 (service down), X1 (error verbatim).

### 4.3 Acceptance UI-2
N1 scenario 1 ends `paid`, tx opens on nearblocks; N2 scenario 2 shows `pending`, approve → `paid`; reject path → `rejected`, funds back (Signatory D-03); N3 revoke → pay refused with the contract text; N4 stop the signer → buttons show "signer not reachable"; N5 a page reload restores state from the chain (no local storage of truth).

---

## 5. UI-2R — PHASE A conversation view (owner decision 13 Nov 14:55 IST)

Goal: the page is never static; agents appear to talk, and **every message is a real step** (no invented text, no fake timing).
- Before editing: copy the UI-2 page to `UI/baseline/Agent Escalation Console.ui2-2026-11-13.html`.
- **Conversation thread** (centre column, replaces the plain timeline): chat-style rows `actor → target · text · status · tx ↗`, agent colours (seller orange, buyer teal, registrar blue, contract purple, human officer grey), spinner while a step waits on NEAR. Fed by runner SSE (`GET {runnerUrl}/runs/:id/events`, Signatory §S-7).
- **Run controls:** a request box + "Run" (or a picker of runnable invoices from `GET {runnerUrl}/invoices`); disabled with the reason when no unpaid invoice exists ("issue a new invoice — vLEI §3.3").
- **Escalation card** on the Tommy CPO node when an invoice is `pending`: **Approve / Reject buttons the user clicks** (signer `/approve`, `/reject`); result appears in the thread.
- **"Turn off agent" (Revoke) button** on the tommyBuyerAgent node (signer `/revoke`); the agent card then shows "revoked"; the next run shows `payment_refused` + refund in the thread. Re-enable shown as text only: "owner action: `bash scripts/set-mandates.sh`" (owner key never in a service).
- **Replay of past runs:** completed invoices replay as a conversation from their real recorded events (`get_events` + evidence IPEX data), labelled "replay", real timestamps, speed control; never mixed with live rows.
- Config adds `runnerUrl` (written by `health.mjs --write-ui-config` after runner `/health` passes).
- Acceptance R1 live run on an unpaid invoice ≤ 0.10 → thread ends `paid`; R2 > 0.10 → escalation card → user Approve → `paid`; R3 user Reject → `rejected` + refund; R4 user Revoke → next run `payment_refused` + refund; R5 no unpaid invoice → Run disabled with reason; R6 replay of INV-2026-0003/0004 shows their 9 recorded steps with tx links; R7 runner down → controls disabled with reason.
- **BUILT 13 Nov (AI, `PROCEED TO CHANGE UI-2R Phase A`), runner NOT yet running → live run untested.** UI-2 copy kept at `baseline/Agent Escalation Console.ui2-2026-11-13.html` (MD5 `11833607…`). `health.mjs --write-ui-config` run: runner `:8774 not reachable` → `runnerUrl` NOT written (correct). Page: Conversation card (top of centre column) with request box + runnable-invoice picker (`GET /invoices`, only `runnable === true`), live thread (`POST /run` → `GET /runs/:id/events` read as SSE over `fetch`, any event name), replay thread (separate, labelled "replay"); the old timeline stays below as "All recorded events". Escalation card on the CPO node (signer `/approve` `/reject`, not blocked by a running run); "Turn off agent" on tommyBuyerAgent (confirm dialog → signer `/revoke`); revoked text: "re-enable = owner action: `bash scripts/set-mandates.sh`". Your clicks are added to the live thread (labelled "your click · signer …") only when no run is active; during a run the runner reports the outcome. UI-2 scenes / Register are disabled while a run is active.
  **ASSUMED (S-7 gives no JSON shapes; check when the runner exists):** `/run` answer `{runId}` (else `error`/`reason` shown verbatim); `/invoices` = array or `{invoices:[…]}` with `said`, optional `invoiceNumber`, `status`, `runnable`; SSE data = JSON with `step|type|kind`, `actor|from`, `target|to`, `text|message|reason|error`, `status|outcome|event`, `txHash`, `txUrl`, `at|ts|time`, optional `id|seq` (same id = update of the row). Non-JSON data is shown as text. Every row also shows the data "as received".
  **Tested (headless Edge):** runner not configured → R7 "Runner not configured"; runner URL on a closed port → R7 "Runner not reachable"; scratch-only test stub (never in `UI/`) → R5 "No unpaid invoice — issue a new invoice (vLEI §3.3)" and SSE parsing (row update by id, named + unnamed events); replay INV-2026-0003 = **6** steps (offer, accept from evidence; `invoice_registered`, `agent_revoked`, `payment_refused`, `paid` with their txs), INV-2026-0004 = 6 (offer, accept, registered, pending, approved, paid) — so R6 is 12 recorded steps, not 9 (the S-6 table's 9 rows include the set-mandates reset and the tamper check, which leave no contract event); 390 px no overflow.
- Phase B (later): the thread gains live vLEI steps per run (seller issues → IPEX grant → buyer admits) — Signatory §S-7B.

### 5.1 Chat interface + real runner API (owner decision 13 Nov 15:34 IST) — replaces the "player" look

**A. Align to the REAL runner API (the §5 build used ASSUMED names).**
> **Authoritative source: Signatory doc "§S-7 Runner API (as built)"** (checked line by line against the runner source, 13 Nov 15:41 IST). Where this summary and §S-7 differ, §S-7 wins. Must-fix points from that check:
> 1. **Key thread rows by `runId` + `step`, not by `seq`**: a step changes status through several events (`register` running → done; `decision` failed → done); `seq` is unique per event. Keyed by `seq`, "Typing…" rows would never clear (breaks C1).
> 2. 409 bodies differ: run already active → `{ok:false, error, activeRunId}`; invoice not runnable → `{ok:false, error, invoice}`.
> 3. `no_match` is HTTP 200 (`{ok:true, state:"finished", result:"no_match"}`); show the reason from the finished event's `text`.
> 4. `/decide` errors: 400 bad decision, 404 unknown run, 409 not waiting / decision in flight, 422 signer or contract refused (run keeps waiting; show the error verbatim, keep the buttons).
> 5. `started` on no_match has `said:null` and no `invoice`/`mandate`; `mandate` can be null; `request.parsed` may carry `amountError`.
> 6. Ignore SSE `retry:` and `: ping` lines; only the last 20 runs are kept and a runner restart forgets runs (404 → show "run no longer available").
> 7. **Decision (owner, 13 Nov 15:41 IST): escalation Approve/Reject always call `POST /runs/:id/decide`** (tx link lands in the decision event). The direct signer `/approve` `/reject` path is used only when no run is active (e.g. a pending invoice from an earlier session); §5's older wording is superseded. Runner `http://127.0.0.1:8774` (Signatory §S-7, built 13 Nov, 35/35 tests):
- `GET /invoices` → `{ok, invoices:[{said, invoiceNumber, amount, amountUnits, currency, realAmount, dueDate, payee, status (unregistered|registered|pending|paid|rejected), runnable, reason?}]}`
- `POST /run {said}` or `{text}` → `{ok:true, runId, eventsUrl, state, result?}`; 409 `{ok:false, error, activeRunId}` while another run is active or invoice not runnable; 404 unknown SAID; 400 bad input
- `GET /runs/:id` → summary + `events[]`; `GET /runs/:id/events` (SSE): `id: <seq>`, `event: run|step`, `data: <json>`; replays past events, honours Last-Event-ID; stream stays open → close on `run` with `state:"finished"`
- `POST /runs/:id/decide {decision:"approve"|"reject"}` → `{runId, ok, txUrl, txHash}` or 422; `POST /runs/:id/cancel` (only while waiting)
- event `run` started: `{runId, seq, ts, state:"started", said, invoice{…as /invoices}, mandate{account, limitUnits, limit, revoked, approver}, request?{text, parsed{amount, amountUnits, amountSource, amountKind, demoScale, invoiceNumber?, quantity?, item?}}}`
- event `run` finished: `{runId, seq, ts, state:"finished", said|null, result: paid|rejected|refused|register_refused|no_match|error|timeout|cancelled, text, txUrl?, txHash?}`
- event `step`: `{runId, seq, ts, step, index, status: running|done|skipped|failed|waiting, actor{id, account}, target{id, account}, text, history?, txUrl?, txHash?, data?}`; steps: 1 `offer` jupiterSellerAgent→tommyBuyerAgent (history) · 2 `accept` tommyBuyerAgent→jupiterSellerAgent (history) · 3 `register` vlei_registrar→contract · 4 `pay` tommyBuyerAgent→contract · 5 `outcome` contract→Jupiter_Knitting_Company (paid) / Tommy_Chief_Procurement_Officer (pending, `waiting`) / tommyBuyerAgent (refused) · 6 `decision` Tommy_Chief_Procurement_Officer→contract
- Escalation: the UI calls **`POST /runs/:id/decide`** (tx link lands in the stream); a direct signer approve/reject is seen by polling with no txUrl ("decided outside the runner"). Timeout 15 min → `timeout`. Matching: `INV-YYYY-NNNN`, `<n> USDC`, or `$<n>` / `<n> USD` ÷ 1,000,000 (exact).

**B. Chat interface (centre column; replaces the player/pace control as the main view).**
- **Chat box** at the bottom: the buyer types a request ("Need 8,000 t-shirts, about $84,000") → `POST /run {text}`; Enter = send. A small picker of runnable invoices stays as a secondary option. Shows the 409 reason inline if a run is active.
- **Agent avatars + bubbles**: one bubble per `step` event in arrival order, from the actor's avatar — seller 🟧 jupiterSellerAgent, buyer 🟩 tommyBuyerAgent, registrar 🔷 vLEI registrar, contract 🟪 NEAR contract, human 👤 Tommy CPO; bubble = `text` + target + status chip + tx link (nearblocks) + expandable details (`data`, e.g. bridge `checks[]`).
- **"Typing…"** under an avatar **only while that step's status is `running`** (real waiting on NEAR); removed when the next event for that step arrives. No artificial delays anywhere.
- **History steps** (`history:true`, offer/accept from pre-issued vLEI work) render with a small "vLEI proof · issued <time>" label so they are not mistaken for live actions (Phase B makes them live).
- **Escalation in the chat**: on `outcome` `waiting` the CPO 👤 bubble shows **Approve / Reject** buttons (→ `/decide`); the CPO node's escalation card mirrors the same state.
- **Turn off agent**: button on the buyer agent avatar/card (signer `/revoke`, confirm first); the next request shows the contract's 🟪 "refused — mandate revoked, N units refunded" bubble. Re-enable = owner text only.
- **Run summary card** after `run` finished: result, each step with status, time and tx link, plus vLEI proof IDs (invoice SAID, IPEX grant SAID, admit/held, issuance anchor) and on-chain amounts; "copy summary" button. Previous runs stay listed (collapsed) above the chat.
- **Replay** of completed invoices stays, but as the same chat bubbles, labelled "replay" with real timestamps, in a separate tab/toggle — never mixed into the live chat.
- Acceptance additions C1 typing appears only during real `running` steps; C2 Approve/Reject inside the chat produces the decision bubble with a tx link; C3 the summary lists every tx of the run and each link opens on nearblocks; C4 a 409 while a run is active is shown inline, not as a crash.
- R6 count: replay of INV-2026-0003 = 6 steps, INV-2026-0004 = 6 steps (12 total; the S-6 table's 9 rows include set-mandates and tamper, which leave no contract event).

**C. BUILT 13 Nov (AI, `PROCEED TO CHANGE UI-2R chat`).** Phase A page kept at `baseline/Agent Escalation Console.ui2r-2026-11-13.html` (MD5 `411ec6bf…`). `health.mjs --write-ui-config` → runner `/health` PASS → wrote `runnerUrl=http://127.0.0.1:8774` (0 fail). Shapes checked against the runner source (`services/runner/index.mjs`, `engine.mjs`), not the doc only. Page: Chat card (Live / Replay toggle), participants row with avatars (Turn off agent on 🟩 tommyBuyerAgent), one bubble per step keyed by `step` (a later event for the same step updates it), "Typing…" only while that step is `running`, history steps labelled "vLEI proof · issued <TEL iss dt>", CPO 👤 escalation bubble with Approve / Reject → `POST /runs/:id/decide` (the CPO-node card routes to `/decide` too while the run waits on that invoice; otherwise signer), summary card on `run` finished (steps, times, tx links, invoice SAID, IPEX grant, admit/held, issuance anchor `ixn s=<kelSeq>` + TEL iss SAID, `get_invoice` now, copy button), earlier runs collapsed above. SSE read with `fetch`; on a drop it reconnects with `Last-Event-ID` after the runner's `retry: 3000`; the stream is closed by the page on `run` finished. Refusals of `POST /run` (409 / 404 / 400) shown inline (C4), with "open run <activeRunId>"; a run active elsewhere (runner `/health activeRun`) is shown with "open it here". UI-2 scenes / Register / Turn off are blocked while a run is active. Replay: same bubbles, labelled, all at once with recorded times (no pacing).
  **Tested:** live page read-only (runner up, picker lists INV-2026-0005/0006/0007, all 5 avatars); scratch-only stub emitting the runner's exact wire format (`id`/`event: run|step`/`data`): Typing… present while `running`, gone at `waiting`; escalation bubble → Approve → `/decide` → decision bubble + summary; second `POST /run` → 409 inline; 390 px no overflow. No live run was started by AI (each consumes an invoice).

### 5.2 Chat-only redesign (owner decision 13 Nov 16:12 IST) — supersedes the §5/§5.1 layout; §5.1-A API rules still apply

**Layout (only these; everything else removed from the main view):**
- Top strip (slim): vLEI · NEAR · Signer · Bridge · Runner status, theme toggle.
- **Left panel — buyer (Tommy):** tommyBuyerAgent alias + short AID, NEAR account, limit (USDC + real USD), approver (CPO), status (active / TURNED OFF), **verification badge** (starts "not verified yet" each run; turns ✓ only when the `verify_buyer` step succeeds in the current run), **Turn off agent** button (signer `/revoke`, confirm). Re-enable = owner text.
- **Centre — chat:** request box at the bottom (Enter = send → `POST /run {text, mode:"issue"}`); bubbles one per step in arrival order from the actor's avatar (🟧 seller, 🟩 buyer, 🔷 registrar, 🟪 contract, 👤 CPO, ⚙ runner for preflight/export); "Typing…" only while a step is `running`; escalation Approve/Reject inside the CPO bubble (`/decide`); run summary card at the end (all steps, times, tx links, invoice SAID, grant, admit/held, issuance anchor) with copy.
- **Right panel — seller (Jupiter):** jupiterSellerAgent alias + short AID, payee account, **verification badge** set live by `verify_seller`.
- **Removed from the main view:** invoice card section, scenarios list, "All recorded events" list, big ladders/tables, Replay as a mode. Previous runs stay as collapsed summaries above the chat. (Proof data remains in each bubble's details and the run summary.)

**Per-step proof in every bubble:** an expandable "details" shows `api.service`, method/path or command, HTTP status / exit code, duration, the verbatim response (BRAN/key-like lines never shown), and the tx link. A failed step = red bubble with that block; the run stops there.

**Steps the chat shows (Signatory §S-7B):** 0 preflight · 1 issue (≈1–2 min, live "seller agent issuing invoice…") · 2 offer · 3 export · 4 verify_seller → right badge ✓ · 5 verify_buyer → left badge ✓ · 6 accept · 7 register · 8 pay · 9 outcome · 10 decision.

**Rules:** rows keyed by `runId`+`step`; no fake delays or values; badges reset at each run start; panels never claim "verified" outside a run's verify step.
- **Team list under each side panel (owner decision 13 Nov 16:42 IST):** below the buyer (left) and seller (right) agent box, a compact list of that company's people and agents — **one line each: name · Human/AI · role · limit**. Nothing else (no AIDs, KEL, OOR SAIDs here; those live in the chat bubbles' details).
  - Source (real data only): evidence `companies[].officers[]` (name, `officialRole`) and `agents[]` (`role`/`scope`, `advisoryOnly`, `delegatorAlias` for indentation) + `get_mandate` for limits via `accounts.json`.
  - Limit column: the on-chain mandate limit in USDC + real USD when one exists (today: tommyBuyerAgent 0.10, Tommy CPO 0.25); otherwise "advisory only" (sub-agents with `advisoryOnly:true`) or "no NEAR limit" — never an invented number.
  - Expected today — Tommy: CEO (Human · Director · no NEAR limit) · CPO (Human · Authorised Representative · approver · 0.25 USDC) · tommyCeoAgent (AI · executive approvals · no NEAR limit) · tommyBuyerAgent (AI · buyer · 0.10 USDC) · TommyTreasuryAgent (AI · treasury · advisory only). Jupiter: CEO (Human · Partner) · CSO (Human · Partner) · jupiterCeoAgent (AI · executive approvals) · jupiterSellerAgent (AI · seller) · JupiterTreasuryAgent (AI · treasury · advisory only) · JupiterInventoryAgent (AI · inventory · advisory only).
  - Revoked agent shows "TURNED OFF" on its line.
- **Two icons (owner decision 13 Nov 17:28 IST):** a **person icon** for humans (OOR officers: CEOs, CPO, CSO) and an **agent icon** (simple robot/chip glyph) for AI agents and sub-agents. Used consistently in the team lists, the side-panel agent boxes and the chat bubbles' avatars (the CPO approval bubble uses the person icon). Inline SVG drawn in the page (no external icon fonts or images, works offline under serve.mjs), coloured by company (buyer teal, seller orange); registrar/contract keep their own small marks. Each icon has an accessible label ("Human" / "AI agent").
  **BUILT 13 Nov (AI):** `icon(kind, side)` draws inline SVG with `createElementNS` (person = head + shoulders; agent = robot head with antenna, eyes, ears), `role="img"`, `aria-label` + `<title>` "Human" / "AI agent", colour by company (`.ico.buyer` teal, `.ico.seller` orange). Who is human/AI and which side comes only from the evidence (`officers[]` / `agents[]`) and `accounts.json` (role `cpo` → human, `buyer_agent` → AI). Used in both panel agent boxes, every team-list line and chat avatars (registrar 🔷, contract 🟪, runner ⚙ keep their marks). Tested: buyer team 2 Human + 3 AI (teal), seller team 2 Human + 4 AI (orange), chat avatars AI for seller/buyer agents and Human (teal) on the CPO escalation bubble; no `<img>`/`<use>`/external icon refs; 390 px clean.
- **Scenario picker (owner decision 13 Nov 16:44 IST):** small **square cards** in a compact grid above the chat box (one card per row of the table below; not a table): card = short label + on-chain amount + expected path icon (✓ paid · ⚠ escalation · ⛔ refused). Clicking a card fills the chat box with its prompt (editable); it never auto-sends; the selected card is highlighted; #8 shows "turn off the agent first".
- **Live preview while editing:** under the chat box, as the user types or changes values (quantity, item, total), show a one-line preview recomputed on every change: parsed item · quantity · real total → on-chain USDC, and the expected path from the **live** limits (agent `get_mandate` limit, CPO limit, 0.0001 floor, `--max-amount`): "within agent limit → pays directly" / "above agent limit → CPO approval" / "above CPO authority → refused before issuing" / "too small → refused before issuing" / "no amount". Labelled "preview — the runner decides"; uses the same parse rules as the runner (§5.1-A / Signatory §S-7B); Send uses exactly the edited text. If the preview and the runner disagree, the runner's result is shown and the difference is visible (no hidden correction).
- **BUILT 13 Nov (AI): scenario cards, live preview, amber stops, team lists.** Baseline `baseline/Agent Escalation Console.ui52-2026-11-13.html` (MD5 `ade07769…`). 10 square cards (label · on-chain amount · icon) above the chat box; click fills the box (no send), highlights the card; #8 shows "turn off the agent first". Card icons and the preview are computed from the LIVE limits (`get_mandate` agent + CPO via `accounts.json`), the 0.0001 floor (runner `minUnits`), and the CPO limit as the upper bound — the page cannot read the runner's `--max-amount` (not exposed by any endpoint; default 0.25 = CPO limit), so a different `--max-amount` would show as a preview/runner difference. Parser = exact port of the runner's current `parseRequest`/`toUnits` (multi-word items with STOP words); **parity test: 15/15 identical** to `services/runner/logic.mjs` (incl. all 10 prompts). With a Phase A runner the preview adds which pre-issued invoice would be used or "no pre-issued invoice of this amount → no_match". At Send the preview is stored with the run; after the run a line shows "matches the preview" or "runner differs → amount/result …". Runner stops `no_match` / `bad_amount` (no_amount arrives as `no_match` from the current runner) render as an amber ⚙ bubble, not red. Team lists under both panels: name · Human/AI · role (evidence `officialRole` / agent `role`) · limit (on-chain USDC + USD, "advisory only", or "no NEAR limit"; "approver of tommyBuyerAgent" when the agent's mandate names that account; TURNED OFF when revoked); no AIDs/SAIDs. Tested (headless, scratch stub using the runner's own `parseRequest` + `issueAmount` rules): card #4 fills and highlights, editing to $57,500 flips the preview to "pays directly", #7 → amber `bad_amount` "0.3 USDC is above the maximum 0.25 USDC (--max-amount)", #10 → amber `no_match`, forced difference shown; team lists match the expected lines; 390 px clean.

**Built-in scenarios (owner decision 13 Nov 16:39 IST).** One money amount per prompt (real USD ÷ demoScale 1,000,000 = USDC). Each issuing scenario creates a NEW vLEI invoice whose line-item description is taken from the prompt (item + quantity + real total); numbers stay quantity 1, unitPrice = amount (float rule).
| # | Chip label | Prompt text (sent as-is) | On-chain | Expected outcome |
|---|---|---|---|---|
| 1 | Within limit | Need 8,000 cotton t-shirts, total $84,000 | 0.084 | issued → verified → paid (within 0.10) |
| 2 | Small order | Order 2,500 denim jeans, total $50,000 | 0.05 | paid |
| 3 | Exactly at limit | Need 10,000 polo shirts, total $100,000 | 0.10 | paid (limit is inclusive) |
| 4 | Escalate → approve | Need 15,000 hoodies, total $157,500 | 0.1575 | pending → user Approve → paid |
| 5 | Escalate → reject | Order 12,000 jackets, total $120,000 | 0.12 | pending → user Reject → refunded |
| 6 | Near CPO maximum | Need 20,000 knit sweaters, total $240,000 | 0.24 | pending → Approve → paid (CPO limit 0.25) |
| 7 | Above CPO authority | Order 30,000 winter coats, total $300,000 | 0.30 | refused BEFORE issuing (> max-amount 0.25 = CPO limit); no invoice |
| 8 | Agent turned off | (click Turn off agent first) Need 5,000 t-shirts, total $42,000 | 0.042 | issued → verified → pay refused "mandate revoked" + refund |
| 9 | Too small | Sample order of 1 t-shirt, total $50 | 0.00005 | refused BEFORE issuing (< 0.0001 float guard) |
| 10 | No amount | Need cotton t-shirts for next month | — | honest stop: "no amount given" (no invoice) |
After #8 the owner re-enables the agent (`bash scripts/set-mandates.sh`). USDC used if all run: ≈ 0.084+0.05+0.10+0.1575+0.24 = 0.6315 (agent holds ≈ 19.7).

**Acceptance U1** a request shows steps 0–9 one by one with real timings and details; **U2** badges flip only at steps 4/5; **U3** Approve/Reject in chat → decision bubble with tx; **U4** Turn off agent → next run's outcome bubble "refused, mandate revoked, refund"; **U5** a failed preflight shows a red bubble and no invoice is issued; **U6** 390 px layout clean; **U7** none of the removed sections render.
Before editing: baseline-copy the current page to `UI/baseline/Agent Escalation Console.ui2r-chat-2026-11-13.html`.

**BUILT 13 Nov (AI, `PROCEED TO CHANGE UI-5.2`).** Baseline copy done (MD5 `14bc68ca…`). Page rebuilt (816 lines): slim strip (vLEI · NEAR · Signer · Bridge · Runner + phase, theme), buyer panel (alias, AID, NEAR account, limit USDC + USD from `get_mandate`, approver, active / TURNED OFF, `verify_buyer` badge, Turn off agent → signer `/revoke` with confirm, owner re-enable text), chat (request → `POST /run {text, mode:"issue"}`, bubbles keyed by runId+step, Typing… only while `running`, per-bubble "details" = `api` block + verbatim `data.raw` + other `data`, failed step = red bubble, Approve/Reject in the CPO bubble → `/decide`, summary card with steps/times/took/tx + invoice SAID, grant, admit/held, issuance anchor, `get_invoice` now, copy; earlier runs collapsed), seller panel (alias, AID, payee, `verify_seller` badge). Removed: invoice card, scenarios, recorded-events list, replay, ladders, tabs/tables, tx-index lookups. Key-like lines (BRAN/passcode/salt/seed/private key/secret, `ed25519:` keys) are hidden in every shown text as a second guard.
Runner phase is read from the runner: `GET /next-invoice` 200 → Phase B (shows the next invoice number); 404 → Phase A (lists runnable pre-issued invoices; "No unpaid invoice" reason when none). The invoice SAID of a Phase B run is taken from the `issue`/`offer`/`register` step `data.said` or the `finished` event (not known at `started`).
**Live state seen 13 Nov (read-only):** runner = Phase A; agent mandate **revoked** (event #8 `agent_revoked`, #10 `payment_refused` INV-2026-0006 "mandate revoked" — your R4); INV-2026-0006 `registered`, 0005/0007 unregistered.
**Tested (headless Edge):** live page read-only (Phase A detected, TURNED OFF shown, badges "not verified yet"); scratch-only Phase B wire-format stub: Typing… present exactly on the running step (0, 1, 3, 4, 5), seller badge flips at step 4 and buyer at step 5, both reset at the next run, Approve → `/decide` → decision bubble + summary 0–10, failed preflight → one red bubble, no later steps, run summary; key-like stub lines hidden; none of the removed sections render; 390 px no overflow. No live run by AI.

### 5.3 Side-panel reporting ladder (owner decision 13 Nov 18:00 IST) — replaces the flat team list of §5.2
Owner approved the chat mockup of 13 Nov 18:00 ("use same design for the UI"). Each side panel shows its company as a **vertical ladder of separate boxes, highest at the top, arrows pointing up to who each box reports to**:
```
 Buyer (left)                          Seller (right)
 [person] CEO · Human · OOR director   [person] CEO · Human · OOR partner
      ↑                                     ↑
 [agent]  CEO agent · AI · executive   [agent]  CEO agent · AI · executive
      ⇡ escalation (dashed, amber)          ⇡ escalation (dashed, amber)
 [person] CPO · Human · limit 0.25     [person] CSO · Human · OOR partner
      ↑                                     ↑
 [agent]  Buyer agent · AI · 0.10      [agent]  Seller agent · AI · issues invoice
      ↑                                     ↑            ↑
 [agent]  Treasury agent · advisory    [agent] Treasury   [agent] Inventory  (side by side)
```
- **Panel header:** company name, Buyer/Seller, short LEI (first 4 … last 4), "QVI ← GLEIF". Footer line: buyer "Mandate from NEAR · signer up/down", seller "Payee matches accounts.json" (only when it does).
- **Box = one line of name + one line of "Human/AI · role or limit"**, icon on the left, status dot on the right. Same limit rules as §5.2 team list (on-chain USDC + USD, "advisory only", "no NEAR limit"; never invented). Revoked agent: box shows TURNED OFF.
- **Arrows:** solid ↑ = real vLEI delegation (from evidence `delegatorAlias`: sub-agent → agent → its OOR officer; CEO agent → CEO). **Dashed amber ⇡ "escalation"** between the acting officer (CPO/CSO) and the CEO agent = business escalation, display only — not a vLEI delegation (in the KEL both officers hang off the LE). Legend under the panels: Human · AI agent · ↑ vLEI delegation · ⇡ business escalation · dot green = verified / grey = waiting · blue border = acting now.
- **Ordering rule (from data, not hard-coded names):** bottom chain = the company's NEAR-acting agent (accounts.json role `buyer_agent` / seller agent) with its sub-agents below it and its delegating officer above it; top chain = the other officer's chain (CEO agent → CEO). Sub-agents of the same agent sit side by side.
- **Icons:** keep the inline-SVG `icon(kind)` (no icon fonts, offline). Colour by kind as in the mockup: human = teal/green, AI = purple; company identity comes from the panel header.
- **Status dot:** grey at each run start. Turns green only for identities that the current run's `verify_seller` / `verify_buyer` step data shows as checked (agent, delegating OOR officer, LE). Identities that step did not check stay grey with tooltip "not checked in this run" — never green by default.
- **Blue border = acting now**, driven by the running step: issue/offer/verify_seller → seller agent; verify_buyer/accept/register/pay → buyer agent; escalation pending/decision → CPO. Cleared when the run ends.
- **Layout:** left panel ≈200 px · chat (flex) · right panel ≈200 px on desktop; at 390 px panels stack above/below the chat, ladder unchanged.
- Hover on a box shows full alias (e.g. `Tommy_Chief_Procurement_Officer`) and short AID — no BRAN/keys/SAIDs.
**Acceptance U8** both ladders render from evidence + accounts.json only; **U9** dashed escalation link labelled and in legend; **U10** dots green only after their verify step and only for checked identities; **U11** blue border follows the running step; **U12** 390 px clean. Before editing: baseline-copy to `UI/baseline/Agent Escalation Console.ui53-2026-11-13.html`.

**BUILT 13 Nov (AI, `PROCEED TO CHANGE UI-5.3`).** Baseline copy MD5 `b9402f02bcb518386aea95424a077d4d`; new page MD5 `6bd34c8a…`. Flat team list replaced by `ladder(actingAgent)`; panels 210 px; legend under the panels.
- **V-READ `services/runner/engine.mjs` (verify step data):** `verify_seller.data = {agent, agentAid, delegationVerified, officer, officerAid, officerOorSaid, issuanceVerified, issuanceAnchor}`; `verify_buyer.data = {agent, agentAid, delegationVerified, officer, officerAid, officerOorSaid}`. **No LE field** → only the acting agent (when `delegationVerified === true`) and its delegating OOR officer (when `officerOorSaid` present) can turn green; CEO, CEO agent, sub-agents (and the LE, which has no box) stay grey "not checked in this run".
- **V-READ (running events):** the runner emits `running` only for preflight, issue, export, register, pay; offer / verify_* / accept arrive as `done` only; decision has no running event. So the blue border shows on the seller agent during `issue`, on the buyer agent during `register`/`pay`, and on the CPO while the outcome is `waiting` or the user's decide is in flight.
- Ordering from data: acting agent = `cfg.buyerAgent` / `cfg.sellerAgent` (accounts.json role `buyer_agent`), its officer = evidence `delegatorAlias`, sub-agents = agents whose `delegatorAlias` is the acting agent (side by side when >1), top chain = every other officer with its agents. Labels = alias without the company prefix (hover = full alias + short AID). Limits: `get_mandate` via accounts.json (USDC + USD), else "advisory only", else role/"OOR <officialRole>" — none invented. Seller footer shown only when every evidence invoice's `paymentWalletAddress` = accounts.json payee (true today).
- **Tested (headless):** live read-only page (U8 both ladders from evidence + accounts.json; U9 dashed amber "escalation" + legend; dots all grey at load) and scratch Phase B stub with the runner's real verify data shape (U10 green only at verify_seller → Jupiter CSO + jupiterSellerAgent, at verify_buyer → Tommy CPO + tommyBuyerAgent; reset to grey on the next run; U11 blue border: seller agent at issue, buyer agent at register/pay, CPO while waiting, cleared at finish; U12 390 px clean). U1–U7 regression on the same stub: steps 0–10 in order with Typing… only while running, badges flip at 4/5, Approve in the CPO bubble (person icon) → decision → summary, failed preflight → one red bubble and no later step, no removed sections, no key-like text.

## 6. UI-3 — tamper demo + advisors

- Scenario 3: "Run tamper demo" → bridge `POST /register {said, tamperField:"paymentWalletAddress"}` → shows the bridge refusal verbatim ("SAID mismatch: recomputed … ≠ …"); contract state unchanged (re-read `get_invoice`). Labelled "demo: altered copy".
- Advisors on JupiterInventoryAgent / JupiterTreasuryAgent / TommyTreasuryAgent nodes: "Ask" → `POST {advisorsUrl}/ask {agent, question}` → answer + attestation in the `job_attested` shape (G-31: `summary`, per call `model`, `signatureKind`, `tdx`, `gpu`, `signature`, `status`, `reason`); badge "attested ✓" only when `summary === "verified"` (private-ai `attest.ts` vocabulary, passed through unchanged by the advisors service per Signatory S-8; note: adminUI near-watch uses a different vocabulary, `attested`/`partial`, so never reuse its names here; `partly` → text "partly attested", no badge); link `https://cloud.near.ai/verify`. Advisory only: no button on these nodes can pay.
- Acceptance T1 tamper refused, contract unchanged; T2 advice shows attested badge with real fields; T3 advisors down → "not attested / advisors not reachable".

---

## 7. Config keys (final)

```json
{ "evidenceUrl": "./data/signatory-evidence.json", "accountsUrl": "./data/accounts.json",
  "rpcUrl": "https://test.rpc.fastnear.com", "contractId": "", "signerUrl": "", "bridgeUrl": "",
  "advisorsUrl": "", "runnerUrl": "", "demoScale": 1000000, "realCurrency": "USD",
  "pollMs": 2000, "probeMs": 1500, "explorer": "https://testnet.nearblocks.io",
  "explorerTxPath": "/txns/", "explorerAccountPath": "/address/",
  "sellerAgent": "jupiterSellerAgent", "buyerAgent": "tommyBuyerAgent", "verifyInBrowser": true,
  "txIndexUrl": "https://tx.test.fastnear.com" }
```
`txIndexUrl` (added in UI-2): tx index used only to find the tx hash of each contract event (empty → events show "tx not matched"). Like `rpcUrl` it is a third-party call, so V4 (UI-1.5) must list both as the allowed exceptions or proxy them.
Services must send `Access-Control-Allow-Origin: http://127.0.0.1:8765` (exact). `serve.mjs` keeps serving only `UI/`.
URLs once the services run (ports from Signatory doc §config): `signerUrl` `http://127.0.0.1:8771`, `bridgeUrl` `:8772`,
`advisorsUrl` `:8773`, `runnerUrl` `:8774`. Leave them `""` until each one answers `GET /health`.
Compatibility (V-READ in UI-1 `validateConfig`): only known keys are read and unknown keys are ignored, so adding
`runnerUrl` / `verifyInBrowser` to the file does not break UI-1; each phase adds its key to the code's defaults.

---

## 8. Files the UI work touches

`UI/Agent Escalation Console.html` (in place) · `UI/signatory-config.json` · `UI/serve.mjs` (add `.woff2` only) · `UI/vendor/*` incl. `UI/vendor/fonts/` + `UI/vendor/README.md` (new) · `UI/verify-test.html` (new) · `UI/data/accounts.json` (copied from `enh2-final\chainaim-signatory\config\accounts.json`, no keys) · `UI/data/signatory-evidence.json` (re-exported by the exporter only). Never: `legentvLEI/task-data`, keys, `.env`.

---

## 9. Order of work (AI / MANUAL)

1. AI — UI-1.5 (after `PROCEED TO CHANGE UI-1.5`); MANUAL — open page, check V1–V4.
2. Signatory S-1..S-6 + vLEI #1–5 done → AI — UI-2; MANUAL — run N1–N5.
3. Signatory S-7 → AI — UI-2R; MANUAL — R1–R3.
4. Signatory S-5 tamper + S-8 → AI — UI-3; MANUAL — T1–T3.
5. MANUAL — full rehearsal from a clean state; record video.
