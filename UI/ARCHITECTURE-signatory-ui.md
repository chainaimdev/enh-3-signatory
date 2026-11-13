# ARCHITECTURE — Signatory: UI changes

Status: DESIGN ONLY. No code written. Date: 2026-11-13.
Companion: `ARCHITECTURE-signatory-vlei.md` (same tags: V-READ, V-HANDOFF, GATE, DECISION, MANUAL).
Rule: nothing here is built until the owner says "PROCEED TO CHANGE".
Revised 2026-11-13: §0, §5 and G-31 checked against the files on the CHAINIAM3003 PC (tagged V-READ 13 Nov).
Revised 2026-11-13 (owner decision D-UI-01): **`UI/Agent Escalation Console.html` IS the Signatory UI** (the same console,
renamed in the demo as "Signatory"). All UI changes are made **in that file**. There is no separate `signatory-console.html`.

## 0. Starting point and limits

| Item | Tag |
| --- | --- |
| **The Signatory UI is `UI/Agent Escalation Console.html`** (owner decision D-UI-01, 13 Nov). Today it is still the mock (file name has **spaces**, not underscores; single file, 862 lines, plain JS, no backend, fake data, header "Mock · sample data", subtitle "… not connected to 4D"). MD5 `4f8f0532eb42eff6063cbbd76685c4ca` on 13 Nov = the **mock baseline** (no UI edits made yet; MD5 re-checked 13 Nov). | V-READ 13 Nov |
| D-UI-01 — **decided** by the owner 13 Nov: the Signatory UI is this file, edited in place; the file name stays `Agent Escalation Console.html`; the on-screen title becomes "Signatory". | DECISION 13 Nov |
| G-30 (is the `UI/` mock in `enh2-final` the same file?) — **closed**: it is the only HTML file in `C:\SATHYA\CHAINIAM3003\mcp-servers\CHAINAIMDEV\enh2-final\UI`; its content matches the rows in §5. | V-READ 13 Nov |
| Design target: canvas "Signatory 1.5 — Console" (https://claude.ai/artifact/Kz2nYjAC86urFrEqKSJFas): one screen, 5 scenes, sample data. | made by Claude 12 Nov |
| The UI folder was not reachable from the PC linked on 13 Nov (`CHAINAIM3003` path). It **is** present on the CHAINIAM3003 PC; build here. | V-READ 13 Nov |
| The evidence exporter exists: `legentvLEI/export-signatory-evidence.js` (default output `legentvLEI/task-data/signatory-evidence.json`). That output file is **not on disk yet**, and the vLEI doc reports the strict run fails today (InventoryAgent not minted, IPEX admit `false`). | V-READ 13 Nov |
| No `chainaim-signatory` repo (contract, bridge, signer, advisors) and no `config/accounts.json` under `CHAINAIMDEV`. The screen cannot be built against real data until they exist (§10). | V-READ 13 Nov |

## 1. Goal

Turn `UI/Agent Escalation Console.html` (the Signatory UI, today a mock) into a console that shows **only real data**: real vLEI identities and credentials (from
`signatory-evidence.json`), real NEAR contract state, real transactions, real AI attestations. If a value is not
available, the screen says "not available" — it never shows an invented value.

## 2. Non-breaking rule

- The Signatory UI is edited **in place**: `UI/Agent Escalation Console.html` (D-UI-01). No new HTML file.
  If the script grows large it may be split into `UI/Agent Escalation Console.js` next to it.
- Rollback: before the first UI edit, copy the mock baseline (MD5 `4f8f0532eb42eff6063cbbd76685c4ca`) to
  `UI/baseline/Agent Escalation Console.mock-2026-11-13.html` and confirm the copy's MD5 matches. That copy is never edited.
- Nothing else in `UI/` is edited apart from this document (the baseline copy is a new file, never edited).
- The screen holds **no keys**. All signing goes through the local `signer` service in the Signatory repo.
- It reads only public data: the evidence file, NEAR RPC view calls, the signer/advisor APIs on 127.0.0.1.

## 3. Data sources (every value on screen comes from one of these)

| Source | What it gives | How the UI reads it |
| --- | --- | --- |
| `signatory-evidence.json` (vLEI export) | Field names as written by `export-signatory-evidence.js` (V-READ 13 Nov): `generatedAt`; `companies[]` {`alias`, `name`, `lei`, `leAid`, `officers[]` {`alias`, `officialRole`, `aid`, `oorCredential` {`said`, `issuerAid`, `issueeAid`, `grantSaid`} — SAID only, no OOR ACDC}, `agents[]` {`alias`, `aid`, `delegatorAlias`, `delegator`, `role`, `scope`, `advisoryOnly`, `delegationVerified` (true/false/null)}}; `invoice` {`said`, `schemaSaid`, `selfAttested`, `issuerAlias`, `issuerAid`, `holderAlias`, `holderAid`, `acdcRaw`, `acdc`, `issuerDelegatedFrom` {`officerAlias`, `officerAid`, `officerOorSaid`}, `ipex` {`grantSaid`, `grantCredentialSaid`, `admitSuccess`, `admitGrantSaid`}}; `checks` {`strict`, `passed`, `failures[]`, `notes[]`}. There is **no admit SAID** in the export. | fetched once from the Signatory repo's local server (`--evidence-url`) |
| `config/accounts.json` | vLEI alias → NEAR account id | same server |
| NEAR RPC (TestNet) | `get_mandate`, `get_invoice(said)` (status: registered / pending / paid / rejected; agent revoked flag), tx outcomes | `query` view calls, poll every 2 s (`--poll-ms`) |
| `signer` service | Runs `pay_invoice`, `approve`, `reject`, `revoke`; returns tx hash or the contract's error text | POST on 127.0.0.1 |
| `bridge` | Registers an invoice or returns the refusal reason (including the labelled tamper demo) | POST on 127.0.0.1 |
| `advisors` | InventoryAgent / TreasuryAgent answer + NEAR AI attestation fields (as private-ai's attestation route returns them) | POST on 127.0.0.1 |

GATE G-31 (narrowed 13 Nov): attestation field names. V-READ 13 Nov in
`chainaim-adminUI-NEAR/services/near-watch/src/jobs.ts` (the `job_attested` consumer): job `summary` ∈
`attested | partial | unverified | not_applicable`; per call `step` (`query | answer`), `model`, `servedModel`,
`providerId`, `signatureKind` (`provider_tee | gateway`), `signingAlgo` (`ecdsa | ed25519`), `signingAddress`,
`reportFetchedAt`, `tdx`, `gpu`, `signature`, `hashes` (`true | false | null` = not checked), `status`
(`verified | unverified | unavailable | not_applicable`), `reason`, `signedText`, `signatureHex`. Check link:
https://cloud.near.ai/verify. The UI uses exactly these names. **Still open:** the producer `chainaim-private-ai/services/attest/src/judge.ts`
uses different internal names (e.g. `tdxVerified`, `tdxStatus`, `verified`, `reasons`; V-READ by grep 13 Nov, file not
read in full). Before coding, read which object the attested route actually returns to callers and have `advisors`
pass on the `job_attested` shape above (mapping in `advisors`, never in the UI).

## 4. Screen layout (from the canvas design)

```
Header: Signatory · network chip (from config) · "vLEI test ecosystem" · NEAR AI chip (only if an attestation was returned)
Scene/action bar: Request quote · Register invoice · Pay (agent) · Approve (CPO) · Tamper demo · Revoke agent
Deal bar: order · real terms ($) · on-chain (USDC) · invoice no. · status (from contract)
[Jupiter column]          [Middle: Offer · Invoice · Mandate cards + Timeline]          [Tommy column]
Proof trail: who offered · who invoiced · who authorised · what was paid · on what advice
```

## 5. Changes from the mock, one by one

| # | Mock today (V-READ) | New screen | Why |
| --- | --- | --- | --- |
| U1 | In-browser fake engine (`approveSide`, `askHuman` countdown timers, `sleep` delays, fixed cash figures per company toggled by "Market conditions" checkboxes; no `Math.random`) | Removed. Status comes only from the contract and services. | No mocks |
| U2 | Per company: Treasury helper + 4-level ladder (agent → L2 officer → CEO agent → CEO), timeouts 45 s (L2) / 60 s (CEO); AIDs are placeholders like `EBk2…sample-t2` | 6 working nodes: Jupiter CSO, jupiterSellerAgent, JupiterTreasuryAgent, **JupiterInventoryAgent**, Tommy CPO, tommyBuyerAgent. CEOs listed as "can revoke" only. | Signatory 1.5 scope |
| U3 | Counter-offers and negotiation rounds, up to 8 (bugs 1–3 are from the 12-Nov review, not re-checked 13 Nov) | Removed. Flow is quote → invoice → pay. | Removes the bugs; smaller |
| U4 | Limits hard-coded (`LIMITS = {agent:100000, l2:250000, ceoAgent:500000}`) | Read from the contract (`get_mandate`) and shown in both units: real $ = on-chain × scale | One source of truth |
| U5 | Amounts in dollars only | Two columns: real terms and on-chain USDC; scale from config (`--demo-scale`, default 1,000,000) | Penny test is explicit |
| U6 | No invoice view | Invoice card from `invoice`: `said`, `schemaSaid`, "self-attested" when `selfAttested`; issuer `issuerAlias` + `issuerAid` (jupiterSellerAgent, not the CSO — vLEI doc §2 correction); "delegated by" `issuerDelegatedFrom.officerAlias` + `officerAid` + `officerOorSaid`; `acdc.a.sellerLEI`, `acdc.a.paymentWalletAddress` (payee), `acdc.a.paymentChainID`; `ipex.grantSaid` and admit status from `ipex.admitSuccess` (no admit SAID exists) | The invoice is the payment instruction |
| U7 | No tampered-invoice case | "Tamper demo" calls the bridge with `--tamper-field paymentWalletAddress`; shows the bridge's real refusal text. Labelled "demo: altered copy". | Real refusal, not a picture |
| U8 | Report tab marks every AI node "delegation verified (KEL)" and every human "OOR issued" without any check; timeline says "vLEI ✓" | Shows only checks actually performed by the bridge/export, each with its result: per agent "delegation verified (KEL)" only when `delegationVerified === true`, "not verified" when `false`, "not checked" when `null`; per officer "OOR SAID" when `oorCredential.said` is present (the export has no OOR ACDC, so no "OOR verified" badge); `checks.failures` listed verbatim. | Honest claims |
| U9 | "payable on Algorand" | Chain and token from the invoice credential (`near:testnet`, USDC) | Real data |
| U10 | Approval card driven by a timer | Approval card appears when the contract says `pending`; buttons call `signer` `approve`/`reject` as the CPO account; result shows tx hash link | Real approval |
| U11 | No revoke | "Revoke agent" calls `signer` `revoke`; next `pay_invoice` shows the contract's refusal | Kill switch |
| U12 | Treasury advice is fixed text | InventoryAgent and TreasuryAgent show the advisor's real answer and an "attested ✓" badge only when attestation fields are present and checked | TEE proof |
| U13 | Reports tabs with KPIs computed from fake deals | Replaced by the proof trail; each row links to evidence (SAID, tx hash, attestation) | Auditable |
| U14 | Live floor shows both companies' ladders with their limits (god view); the report tabs are already per-company ("Only X's own data") | Keep for the demo, labelled "operator view (demo)"; per-company views are later work | Honest scope |

Kept from the mock: IBM Plex Sans / Mono, buyer teal `--buyer` / seller orange `--seller` (light + dark values),
text labels beside every colour, `textContent` rendering (no `innerHTML` in the file), dark mode via
`prefers-color-scheme`, breakpoints 1100 px / 760 px, `prefers-reduced-motion` (all V-READ 13 Nov).

## 6. States the screen must handle (no fake fallbacks)

| Situation | What the screen shows |
| --- | --- |
| Evidence file missing / invalid | "vLEI evidence not loaded" with the file path; actions disabled |
| Evidence `checks.passed` is `false` | Banner "vLEI checks failed" with each `checks.failures` entry verbatim; Register invoice / Pay disabled |
| `invoice.ipex.admitSuccess` is not `true` | Invoice card shows "IPEX admit not completed"; Register invoice disabled |
| RPC down | "NEAR RPC not reachable"; last known state greyed with its time |
| Signer/bridge/advisor down | That button disabled with the service name |
| Contract error | The contract's error text, verbatim |
| Attestation missing | No badge; text "not attested" |

## 7. Flags (configurable, defaults safe)

`--evidence-url` · `--accounts-url` · `--rpc-url` (default NEAR TestNet RPC) · `--contract-id` ·
`--signer-url` / `--bridge-url` / `--advisors-url` (default 127.0.0.1 ports) · `--demo-scale` (1000000) ·
`--poll-ms` (2000) · `--explorer` (testnet.nearblocks.io).
Passed as a small JSON config served next to the page (no values hard-coded in the HTML).

GATE G-33: browsers block `fetch` of a local JSON file when the page is opened as `file://`, and a `file://` page
has origin `null` for calls to 127.0.0.1. So the page and its config must be served over `http://127.0.0.1:<port>`
(e.g. by the Signatory repo's local server), and `signer` / `bridge` / `advisors` must send CORS headers allowing
exactly that origin. Decide the serving port with the Signatory repo; do not open the edited page by double-click.

## 8. Out of scope for this UI round
Live negotiation, CEO-agent level, period-budget charts, per-company logins, NEAR Intents payment (optional: a
"dry quote" panel only after gate G-25 in the vLEI doc), multi-company selector.

## 9. Acceptance

| Check | Pass when |
| --- | --- |
| Data honesty | Grep of `Agent Escalation Console.html` (and its `.js`, if split) finds no hard-coded AIDs, SAIDs, amounts, account ids or tx hashes |
| Scene 1 | Pay 0.084 → contract `paid`, tx link opens on the explorer |
| Scene 2 | Pay 0.1575 → `pending` → CPO approve → `paid`. GATE G-32: the vLEI doc defines only one invoice (`INV-2026-0003`, 0.084 USDC). Scene 2 needs a second real invoice credential above the agent limit (amount source: canvas design, not re-checked) and the contract's `agent_limit_units` set between the two; until both exist this scene is not run. |
| Scene 3 | Tamper demo → bridge refusal text shown; contract unchanged |
| Scene 4 | Revoke → next pay shows the contract's refusal |
| Advice | Badges appear only with real attestation fields |
| Rollback | `UI/baseline/Agent Escalation Console.mock-2026-11-13.html` exists, MD5 `4f8f0532eb42eff6063cbbd76685c4ca`, and still opens as the old mock |
| Title | The edited `Agent Escalation Console.html` shows "Signatory" as its title; no "Mock · sample data" label remains |

## 10. Order of work
After the vLEI export and the Signatory contract/bridge/signer exist (vLEI doc §10): baseline copy (§2 Rollback) →
page shell + config in `Agent Escalation Console.html` →
evidence panels (U2, U6, U8) → contract state + actions (U4, U5, U10, U11) → tamper demo (U7) → advisors (U12) →
proof trail (U13) → state handling (§6) → acceptance.

## 11. Build status (13 Nov 2026)
Build plan: `UI/ARCHITECTURE-signatory-ui-build-2026-11-13.md`. **UI-1 built** (owner asked for the HTML edits on 13 Nov):
`Agent Escalation Console.html` rewritten in place (title "Signatory"; no fake engine); `serve.mjs`, `signatory-config.json`,
`baseline/Agent Escalation Console.mock-2026-11-13.html` (MD5 `4f8f0532…`), `data/signatory-evidence.json` (exporter `--strict --out`).
UI-2 (contract + signer) and UI-3 (bridge + advisors) not started: those services do not exist yet.
