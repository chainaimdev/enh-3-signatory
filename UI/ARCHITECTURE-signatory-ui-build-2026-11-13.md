# ARCHITECTURE: Signatory UI build (UI-1 now, UI-2/UI-3 after NEAR)

Date: 2026-11-13 · Status: UI-1 BUILT 13 Nov (see "Owner instruction" status line); UI-2/UI-3 still plan only.
Target file: `enh2-final/UI/Agent Escalation Console.html`, edited in place (decision D-UI-01).
Companion docs: `UI/ARCHITECTURE-signatory-ui.md` (U1–U14, §3 sources, §6 states, §7 flags, gates G-31/G-32/G-33),
`ARCHITECTURE-signatory-vlei.md`.
Tags: **V-READ** = read from the file on 13 Nov · **ASSUMED** = not verified · **GATE** = open question · **AI** / **MANUAL** = who does it.

---

## Owner instruction (13 Nov): where the UI changes happen

- **Do all required UI changes in `C:\SATHYA\CHAINIAM3003\mcp-servers\CHAINAIMDEV\enh2-final\UI\Agent Escalation Console.html` itself.** It is the Signatory UI (D-UI-01). No second UI file, no new page.
- **Keep the existing theme and layout**: header + tabs, the 3-column trade floor (Tommy ladder | centre | Jupiter ladder), the colour tokens (buyer teal, seller orange, ok/warn/bad), IBM Plex Sans/Mono, light/dark mode, 1100/760 px breakpoints. Visual changes are small: title "Signatory", status strip, invoice card, scenario rail, a Proof-trail tab; the mock's free-text composer, timers and fake cash/market controls are removed.
- **The script inside the file is replaced**: the fake engine (`askHuman`, `approveSide`, `sleep`, `LIMITS`) gives way to code that reads real data (§2.2) and shows real states (§5).
- Only three helper files sit beside it, none of them a UI: `UI/serve.mjs` (needed by G-33), `UI/signatory-config.json` (settings, §2.3), `UI/baseline/Agent Escalation Console.mock-2026-11-13.html` (untouched rollback copy).
- Status 13 Nov: **UI-1 built** on the owner's request. The mock is preserved as `UI/baseline/Agent Escalation Console.mock-2026-11-13.html` (MD5 `4f8f0532…`). Evidence exported to `UI/data/` with `--strict` (all checks passed). `signatory-config.json` uses `rpcUrl` `https://test.rpc.fastnear.com` (tested in chainaim-adminUI-NEAR `docs/NEAR-GATES.md`); RPC is only called once `contractId` is set.

---

## 0. What exists today (V-READ 13 Nov)

| Item | State |
| --- | --- |
| `UI/Agent Escalation Console.html` | Mock. MD5 `4f8f0532eb42eff6063cbbd76685c4ca`, 862 lines, 0 `fetch` calls, fake engine (`askHuman`, `approveSide`, `sleep`), hard-coded `LIMITS = {agent:100000, l2:250000, ceoAgent:500000}`, header pill "Mock · sample data". |
| Mock layout kept as the visual reference | `header.top` (brand + `nav.tabs`) → `main` → `section.view` ×3 (`view-live`, `view-tommy`, `view-jupiter`). Live view = composer + `.floor` (buyer ladder `aside.ladder.buyer` · centre `dealbar` / `approval` / `timeline` · seller ladder `aside.ladder.seller`). |
| Mock design tokens kept | IBM Plex Sans / Mono; `--bg --surface --surface-2 --ink --muted --line --accent`; buyer teal `--buyer/--buyer-soft`, seller orange `--seller/--seller-soft`; `--ok/--warn/--bad` + soft variants; light + dark (`prefers-color-scheme` and `data-theme`). |
| vLEI backend | **Working.** 4D re-run 13 Nov 05:47Z: 2 LEs, 4 OOR officers, 4 agents, 3 sub-agents (incl. JupiterInventoryAgent), invoice INV-2026-0003 0.084 USDC `near:testnet`, IPEX `admitSuccess:true`, `credentialHeld:true`. |
| `legentvLEI/export-signatory-evidence.js` | Exists, flags `--config --task-data --out --seller-agent --buyer-agent --invoice-said --fetch-kel --keria-url --strict --dry-run`. Refuses to write if any key-like field (`bran/passcode/secret/salt/privkey/private`) is present. |
| `UI/data/signatory-evidence.json` | **Not yet written** (MANUAL Step D, §9). |
| NEAR side (`chainaim-signatory`: contract, bridge, signer, advisors, `config/accounts.json`) | **Does not exist.** |

**Answer to "UI works half — correct?"** Yes. UI-1 shows everything the vLEI side has proven (identities, delegations, invoice, IPEX) from real data, and every NEAR-dependent part shows an explicit, named "not available" state with the action disabled. Nothing is faked.

---

## 1. Goals and non-goals

Goals (UI-1):
1. One screen a judge understands in 30 seconds: who the two companies are, which humans authorised which AI agents, which invoice exists, and what is still missing.
2. Every value comes from a file or a service; if missing, the screen says so by name.
3. Same look as the mock (trade-floor layout, colours, fonts), minus the clutter.

Non-goals (UI-1): payments, approvals, revoke, tamper demo, AI advice (UI-2/UI-3); live negotiation, counter-offers, CEO-agent ladder level beyond display (doc §8).

---

## 2. Architecture

```
 Browser  http://127.0.0.1:8765/Agent%20Escalation%20Console.html
   │
   ├─ GET  ./signatory-config.json            (flags §7; no values hard-coded in HTML)
   ├─ GET  ./data/signatory-evidence.json     (vLEI export, copied by --out)        ← UI-1
   ├─ GET  ./data/accounts.json  (optional)   (vLEI alias → NEAR account)           ← UI-2
   ├─ POST {rpcUrl}  view calls               (get_mandate, get_invoice)            ← UI-2
   ├─ GET  {signerUrl}/health, POST actions   (pay, approve, reject, revoke)        ← UI-2
   ├─ GET  {bridgeUrl}/health, POST register  (incl. tamper demo)                   ← UI-3
   └─ GET  {advisorsUrl}/health, POST ask     (attested advice, G-31 shape)         ← UI-3

 UI/serve.mjs  (Node, no dependencies) — serves ONLY the UI/ folder on 127.0.0.1
```

### 2.1 Why a server (GATE G-33, resolved for UI-1)
A `file://` page cannot `fetch` local JSON, and has origin `null` toward 127.0.0.1 services. UI-1 adds `UI/serve.mjs`:
- Flags: `--port 8765` · `--host 127.0.0.1` · `--root <UI folder>` (default: its own folder) · `--no-cache`.
- Serves only files under `--root`; rejects `..`, absolute paths and symlinks out of root; only `GET`/`HEAD`; content types for `.html .js .json .css .svg`.
- **Never** serve `legentvLEI/` or `enh2-final/` — `task-data/` holds BRAN files.
- UI-2: the Signatory services must send `Access-Control-Allow-Origin: http://127.0.0.1:8765` (exact origin, not `*`).

### 2.2 Code layout inside the page (one file; split to `Agent Escalation Console.js` only if it passes ~900 lines of script)

| Module (section in the script) | Responsibility | No-fake rule |
| --- | --- | --- |
| `config` | Load `signatory-config.json`, validate types, apply defaults from §2.3 | Missing config → full-page state "config not loaded" |
| `sources.evidence` | Fetch + validate evidence (schema in §3) | Invalid → state E1 |
| `sources.probe` | For each service: `GET /health` with timeout `probeMs`; record `up / down / not configured` | Never assumes up |
| `store` | One plain state object; render on change | No values invented |
| `view.*` | Pure render functions using `document.createElement` + `textContent` (mock never used `innerHTML`; keep that) | Missing field → "—" + reason |
| `actions.*` | UI-1: none enabled. Each button renders with its blocking reason | No click handler runs a fake |
| `fmt` | Short ids, amounts, dates (§5.4) | — |

### 2.3 `signatory-config.json` (all keys, defaults safe)

```json
{
  "evidenceUrl": "./data/signatory-evidence.json",
  "accountsUrl": "./data/accounts.json",
  "rpcUrl": "https://rpc.testnet.near.org",
  "contractId": "",
  "signerUrl": "",
  "bridgeUrl": "",
  "advisorsUrl": "",
  "demoScale": 1000000,
  "pollMs": 2000,
  "probeMs": 1500,
  "explorer": "https://testnet.nearblocks.io",
  "sellerAgent": "jupiterSellerAgent",
  "buyerAgent": "tommyBuyerAgent"
}
```
Empty string = "not configured" (shown as such). `rpcUrl` default is ASSUMED; confirm with the NEAR repo in UI-2.

---

## 3. Evidence contract the UI reads (V-READ from `export-signatory-evidence.js` lines 180–336)

```
generatedAt
source { gedaAid, qviAid, run { config, sha256 } }
companies[] {
  alias, name, lei, leAid, leOobi,
  officers[] { alias, officialRole, aid, oobi, oorCredential { said, issuerAid, issueeAid, grantSaid } | null, kel },
  agents[]   { alias, aid, oobi, delegatorAlias, delegator, role, scope, advisoryOnly, delegationVerified (true|false|null), kel }
}                                   // sub-agents are in agents[] too: delegatorAlias = parent agent alias
invoice {
  said, schemaSaid, registry, selfAttested, issuerAlias, issuerAid, holderAlias, holderAid,
  acdcRaw, acdc { a { invoiceNumber, invoiceDate, dueDate, sellerLEI, buyerLEI, currency, totalAmount,
                       lineItems[], paymentTerms, paymentMethod, paymentChainID, paymentWalletAddress, ref_uri } },
  ipex { grantSaid, grantCredentialSaid, admitSuccess, admitGrantSaid },
  issuerDelegatedFrom { officerAlias, officerAid, officerOorSaid }
} | null
checks { strict, passed, failures[], notes[] }
```

Rules derived from it:
- **Tree build:** company → officers; officer → agents where `agent.delegatorAlias === officer.alias`; agent → sub-agents where `sub.delegatorAlias === agent.alias`.
- **Role labels:** `officialRole` for humans; `role` / `scope` for agents; `advisoryOnly:true` → label "advisory only · no payment authority".
- **Not in the export (do not show as verified):** full OOR ACDC (SAID only), admit SAID, `credentialHeld` (it is in `tommyBuyerAgent-ipex-admit-info.json`, not exported — GATE G-34 below).
- `kel` strings are public KEL CESR; the UI never renders them in full (size), only "KEL ✓ (n bytes)" with a copy button.

---

## 4. Screen design (reference: the mock; fixes for clutter)

### 4.1 Header (one line on desktop, wraps on mobile)
`Signatory` (h1) · subtitle "Private AI decides. Signed credentials prove. NEAR enforces." · **status strip** (right):

| Chip | Source | Values |
| --- | --- | --- |
| vLEI | `checks.passed` | ✓ checks passed · ✗ n failures |
| Evidence | `generatedAt` | "exported 13 Nov 05:52 UTC" (+ "stale" if > 24 h) |
| NEAR | `contractId` + RPC | "contract not configured" / "RPC down" / "testnet · {contractId}" |
| Signer / Bridge / Advisors | probe | up · down · not configured |

The mock's "Mock · sample data" pill is removed. Theme toggle kept.

### 4.2 Tabs (keep `nav.tabs`, rename)
1. **Live floor** (default) · 2. **Tommy** (buyer, own data only) · 3. **Jupiter** (seller, own data only) · 4. **Proof trail**.
A red count badge on a tab = number of failed checks relevant to that company (mock's `.badge` style).

### 4.3 Live floor (keeps the mock's 3-column `.floor`)

```
┌ Tommy ladder (teal) ┐ ┌──────── centre ────────┐ ┌ Jupiter ladder (orange) ┐
│ LE  Tommy Hilfiger  │ │ Invoice card (U6)       │ │ LE  Jupiter Knitting    │
│  OOR CPO   [OOR]    │ │ Scenario rail (4 scenes)│ │  OOR CSO   [OOR]        │
│   agent buyer [KEL✓]│ │ Timeline (real events)  │ │   agent seller [KEL✓]   │
│    sub Treasury     │ │                         │ │    sub Treasury [KEL✓]  │
│  OOR CEO            │ │                         │ │    sub Inventory (adv.) │
│   agent ceo [KEL✓]  │ │                         │ │  OOR CEO                │
└─────────────────────┘ └─────────────────────────┘ └─────────────────────────┘
```
- **Removed from the mock:** composer textarea + suggestion chips (no free-text negotiation in this round), `approval` timer card, fake cash/market checkboxes.
- **Ladder node** (one row each, indented by level): role label · alias · short AID (mono, copy) · badges. Limits line: UI-1 "limit: from contract — not deployed"; UI-2 the real `get_mandate` value in both units.
- **Invoice card (U6):** invoice number · "self-attested by jupiterSellerAgent" · "delegated from Jupiter_Chief_Sales_Officer (OOR {short})" · seller/buyer LEI · amount in two columns (on-chain `0.084 USDC` / real `84,000.00 USD` at 1:1,000,000, labelled "demo scale") · line item · due date · chain `near:testnet` · payee `chainaim-jupiter-payee.testnet` · IPEX: grant {short} → admit ✓/✗ · invoice SAID (copy). Footer: "Register on NEAR" button (disabled, reason).
- **Scenario rail:** 4 numbered steps, each with status and its one primary button:
  1. Pay 0.084 within agent limit — needs signer + contract
  2. Pay 0.1575 → CPO approval — needs signer + contract + **G-32** second invoice
  3. Tamper demo — needs bridge
  4. Revoke agent → next pay refused — needs signer + contract
  UI-1: every step shows "Blocked: <service> not configured" in `--warn` text, button disabled. No hover-only reasons.
- **Timeline:** real events only. UI-1 entries derived from evidence: "Invoice issued (self-attested) {said}", "IPEX grant {grantSaid}", "IPEX admit ✓ by tommyBuyerAgent", "Evidence exported {generatedAt}". No invented timestamps: entries without a time show none.

### 4.4 Company tabs (Tommy / Jupiter)
Per company only (U14): identity table (alias · role · AID · delegated from · KEL check · OOR SAID), that company's invoices, and that company's blocked capabilities. Dense table style from the mock reports.

### 4.5 Proof trail (U13)
One table, one row per claim, each with its evidence: `GEDA → QVI` (source.gedaAid/qviAid), each OOR (SAID), each delegation (`delegationVerified`), invoice SAID + schema SAID + registry, IPEX grant, IPEX admit, run config sha256. UI-2 adds NEAR rows (register tx, pay tx, approve tx, revoke tx) with explorer links. `checks.failures` are listed verbatim at the top if any; `checks.notes` at the bottom (e.g. "Not checked: … bridge recomputes it").

### 4.6 Anti-clutter rules (acceptance-checked)
- One primary button per card; secondary actions as text links.
- Every disabled control shows its reason as visible text right under it.
- Ids: `EAiCLp3O…zEgCG` (8 + … + 5) in mono, full value on copy; never wrap mid-id.
- At most 3 badge kinds per row; badge text ≤ 3 words.
- Numbers right-aligned, tabular; currency always labelled.
- Breakpoints from the mock: ≤1100 px ladders stack above centre; ≤760 px single column, tabs scroll.
- `prefers-reduced-motion`: no animations; otherwise only 150 ms fades.
- Empty/loading states use the same card frame (no layout jump).

---

## 5. States (doc §6, extended; every one is a real condition)

| Id | Condition | Screen |
| --- | --- | --- |
| C0 | Opened as `file://` | Full-page: "Open via http://127.0.0.1:8765 (run UI/serve.mjs)". |
| C1 | Config missing/invalid | Full-page: "signatory-config.json not loaded: <error>". |
| E1 | Evidence missing/invalid JSON/required field absent | Banner "vLEI evidence not loaded: <path> <error>"; ladders show skeleton with "—"; all actions disabled. |
| E2 | `checks.passed === false` | Red banner listing `checks.failures` verbatim; Register/Pay disabled; affected nodes get ✗. |
| E3 | `invoice === null` | Invoice card: "No invoice in evidence". |
| E4 | `invoice.ipex.admitSuccess !== true` | Card: "IPEX admit not completed"; Register disabled. |
| E5 | Evidence older than 24 h | Amber chip "evidence stale — re-export". |
| N1 | `contractId` empty | NEAR chip "contract not configured"; limits show "not deployed". |
| N2 | RPC unreachable / view call error | "NEAR RPC not reachable"; last good values greyed with their time (UI-2). |
| S1 | Service URL empty | Button reason "<service> not configured". |
| S2 | Service probe failed | Button reason "<service> not reachable at <url>". |
| X1 | Contract/service returned error | Error text verbatim under the button (UI-2). |
| A1 | Advice without attestation fields | No badge; text "not attested" (UI-3). |

---

## 6. Phases

### UI-1 (now — works with what exists)
U1 remove fake engine · U3 remove negotiation · title + header strip · U2 ladders from evidence · U6 invoice card · U8 KEL badges · U9 chain/token · U5 two-unit amounts · U13 proof trail (vLEI rows) · U14 per-company tabs · states C0–E5, N1, S1, S2 · `serve.mjs` · `signatory-config.json` · baseline copy.

### UI-2 (after the NEAR contract + signer exist)
U4 limits from `get_mandate` · scenario 1 (pay) · scenario 2 (pending → approve/reject; needs G-32) · U10 · U11 revoke (scenario 4) · tx links · N2/X1 · proof-trail NEAR rows · polling `pollMs`.

### UI-3 (after bridge + advisors)
U7 tamper demo (scenario 3, bridge refusal verbatim) · U12 Inventory/Treasury advice with attestation badge (G-31 shape, mapping inside `advisors`) · A1.

---

## 7. Files UI-1 touches (and nothing else)

| File | Action |
| --- | --- |
| `UI/baseline/Agent Escalation Console.mock-2026-11-13.html` | New copy of the mock; MD5 must equal `4f8f0532…`; never edited |
| `UI/Agent Escalation Console.html` | Edited in place |
| `UI/signatory-config.json` | New (§2.3) |
| `UI/serve.mjs` | New (§2.1) |
| `UI/data/signatory-evidence.json` | Written by the exporter (`--out`), not by hand |
| `UI/ARCHITECTURE-signatory-ui.md` | Pointer to this build plan + phase status |

Not touched: anything in `legentvLEI/`, `chainaim-private-ai/`, `chainaim-adminUI-NEAR/`.

---

## 8. Gates

| Gate | Blocks | Status |
| --- | --- | --- |
| G-31 attestation field names | UI-3 advice badge | Open (map in `advisors`, never in UI) |
| G-32 second invoice 0.1575 USDC | Scenario 2 | Open — needs a second invoice config + issue run; watch the float rule (§10) |
| G-33 file:// / CORS | Everything | UI-1: solved by `serve.mjs`; UI-2: services send CORS for `http://127.0.0.1:8765` |
| **G-34 (new)** `credentialHeld` not exported | Invoice card "credential held ✓" | Open — either exporter adds `invoice.ipex.credentialHeld` (vLEI change) or the card shows admit only. UI-1 shows admit only. |
| D-02 Rust vs JS contract | UI-2 view-call names | Open (recommend Rust near-sdk) |

---

## 9. Run order (AI vs MANUAL; manual steps are done one at a time)

1. **MANUAL** — export evidence where the UI can read it (from `legentvLEI`):
   `mkdir -p ../UI/data && node export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json`
   Expect: delegations OK, `admit true`, "All checks passed.", "Written: …".
2. **MANUAL** — owner says `PROCEED TO CHANGE UI-1` (new chat).
3. **AI** — baseline copy + MD5 check; build UI-1 files (§7); self-checks (§11).
4. **MANUAL** — start the server (from `UI`): `node serve.mjs --port 8765`
   Open `http://127.0.0.1:8765/Agent%20Escalation%20Console.html`.
5. **MANUAL** — walk the acceptance list (§11) and report what you see.

---

## 10. Lessons from 13 Nov that the UI must respect

- **Float rule:** numbers below 0.0001 serialize differently in JS (`0.0000105`) and Python (`1.05e-05`) → KERIA rejects the credential (`Invalid sad`). The UI only displays; the G-32 invoice config must keep every number ≥ 0.0001.
- The invoice is **self-attested by jupiterSellerAgent**, not issued by the CSO; the CSO appears as "delegated from".
- The old `INV-2025-001` text in the 4C trust-tree printout is hard-coded, not data — never copy it into the UI.

---

## 11. Acceptance for UI-1

| # | Check | Pass when |
| --- | --- | --- |
| A1 | Baseline | `UI/baseline/…mock-2026-11-13.html` MD5 = `4f8f0532eb42eff6063cbbd76685c4ca` |
| A2 | Data honesty | Grep of the edited HTML finds no AID/SAID (`E[A-Za-z0-9_-]{43}`), no `LIMITS`, no `askHuman`/`approveSide`/`sleep`, no "Mock" |
| A3 | Ladders | 2 LEs, 4 officers, 4 agents, 3 sub-agents; InventoryAgent labelled "advisory only" |
| A4 | Badges | "KEL ✓" exactly on agents with `delegationVerified:true` |
| A5 | Invoice card | INV-2026-0003, 0.084 USDC / 84,000.00 USD (demo scale), near:testnet, payee, issuer + delegated-from, admit ✓ |
| A6 | E1 | Rename the evidence file → banner "vLEI evidence not loaded" with path; rename back → recovers on reload |
| A7 | E2 | Serve a copy with `checks.passed:false` + one failure (`--evidence-url` pointing at it) → banner shows the text verbatim, actions disabled |
| A8 | C0 | Double-click the HTML → page says to use the server |
| A9 | Blocked scenes | All 4 scenario buttons disabled with visible "not configured" reasons; no click does anything |
| A10 | Server safety | `GET /../legentvLEI/task-data/` → 403/404; only `UI/` files served |
| A11 | Layout | 1440 / 1100 / 760 / 390 px widths: no overlap, no horizontal scroll except tabs; dark mode legible |
| A12 | No secrets | Page source and network tab contain no BRAN/key fields (exporter guard + grep) |

---

## 12. After UI-1 (reminder list)

- vLEI small: refresh DD5 cards/BRAN copies (`--dd-root`), fix hard-coded `INV-2025-001` line in `run-all-buyerseller-4C-with-agents.sh:561`, fix `ARCHITECTURE-signatory-vlei.md` §7.1 bridge rule (issuer = jupiterSellerAgent self-attested, delegated from the CSO with an OOR), G-34 export `credentialHeld`, commit everything.
- NEAR: `chainaim-signatory` repo (contract register/pay/approve/reject/revoke + views, bridge with SAID re-check + tamper flag, signer, advisors, `accounts.json`), D-02, G-32 second invoice, create `chainaim-jupiter-payee.testnet` (MANUAL), then UI-2 and UI-3.
- Videos for both entries. Deadline 14 Nov 2026 23:59 UTC.
