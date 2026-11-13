# ARCHITECTURE — Signatory: vLEI changes (4D with InventoryAgent) + NEAR interface

Status: vLEI side (sections 3–6) IMPLEMENTED 2026-11-13 on the CHAINIAM3003 copy, not yet run end-to-end
(needs a 4D re-run, see section 11). NEAR side (section 7) is still DESIGN ONLY.
Repo affected: `enh2-final\legentvLEI` (vLEI side, sections 2–6) and a NEW repo `chainaim-signatory` (NEAR side, section 7).
Rule: the owner said "PROCEED TO CHANGE" for the vLEI side on 2026-11-13. Tag **V-CODE** = checked in the code by Claude on 13 Nov.

## 0. How to read this document (no-hallucination rules)

Every fact carries one tag. Anything not tagged V-READ or V-HANDOFF is not a fact yet.

| Tag | Meaning |
| --- | --- |
| **V-READ** | Claude read the file itself in the 12-Nov chat (CHAINIAM3003 copy). |
| **V-HANDOFF** | Stated in the owner's handoff of 2026-11-13 (from a session that ran the code). Not re-read by Claude. |
| **GATE** | Must be checked in the code or official docs before any code is written. Each gate has an ID (G-nn). |
| **DECISION** | Owner chooses. Each has an ID (D-nn) and a recommended option. |
| **MANUAL** | Owner does it by hand (accounts, keys, funding). One step at a time when we get there. |

Important limit: the latest code (with `build-org-config.js`, `print-org-trust-tree.js`, `start-vlei.sh`,
`appconfig/org/`) is on the PC with `C:\SATHYA\CHAINIAM3003\`. The PC linked on 13 Nov
(`C:\SATHYA\CHAINAIM3003\mcp-servers\CHAINAIM-DEV\enh2-final`) has an older copy without those files and
without a `UI` folder (V-READ, 13 Nov). Coding must happen on the CHAINIAM3003 PC.

## 1. Goal

Make the existing 4D run produce **real** vLEI identities and credentials for the Signatory demo, including a
**JupiterInventoryAgent**, and export a public evidence file that a NEAR contract bridge can check. No mock
identities, no fake credentials, no keys leave the vLEI stack.

## 2. What already exists (no change needed)

| Item | Source |
| --- | --- |
| Jupiter Knitting (LEI 3358004DXAMRWRUIYJ05, IN, ELF A0PS): CEO + CSO officers, both OOR ("Partner"); jupiterCeoAgent; jupiterSellerAgent → JupiterTreasuryAgent | V-HANDOFF |
| Tommy Hilfiger Europe B.V. (LEI 54930012QJWZMYHNJW95, NL, ELF 54M6): CEO ("Director") + CPO ("Authorised Representative"), OOR; tommyCeoAgent; tommyBuyerAgent → TommyTreasuryAgent | V-HANDOFF |
| 4D run with `--config-4c/--config-4d/--force-base` succeeded; 17 identities present (`print-org-trust-tree.js --strict`) | V-HANDOFF |
| Live KERIA chain for TommyTreasuryAgent: icp(CPO) → ixn → dip(tommyBuyerAgent) → ixn → dip(TommyTreasuryAgent) | V-HANDOFF |
| Per-officer OOR credential info files `<alias>-oor-credential-info.json` | V-HANDOFF |
| `print-org-trust-tree.js` reads only `task-data/*-info.json`, never BRAN files | V-HANDOFF |
| `start-vlei.sh` restarts without re-running 4D (preserve mode) | V-HANDOFF |
| Invoice credential schema `schemas/invoice-credential-schema.json`: attributes include sellerLEI, buyerLEI (pattern `^[A-Z0-9]{20}$`), currency (`^[A-Z0-9]{1,5}$`), totalAmount (number ≥ 0), lineItems (exactly 1), paymentMethod (enum blockchain/wire_transfer/check), paymentChainID (string 1–50), paymentWalletAddress (string **20–100 chars**), ref_uri (format uri, 10–500), edge `oor` with operator `I2I`; top level `additionalProperties: false` | V-READ |
| `appconfig/invoiceConfig.json`: issuer Jupiter_Chief_Sales_Officer, holder tommyBuyerAgent, registry JUPITER_SALES_REGISTRY, paymentChainID `"algorand"`, Algorand-style wallet | V-READ |
| **Correction (V-CODE):** 4C does NOT issue the invoice from the CSO with `invoice-credential-schema.json`. It issues a **self-attested** invoice: issuer = issuee = `jupiterSellerAgent`, schema `schemas/self-attested-invoice.json` (SAID `EIKpV6ZqOn2Rg-DY86bIKDixNlgdvUQoSpijhVqs_EPu`, from `appconfig/schemaSaids.json`), no `oor` edge, then IPEX grant → tommyBuyerAgent. That schema has **no** pattern/minLength limits. From `invoiceConfig.json` it uses only `issuer.lei`, `holder.lei` and `sampleInvoice`. | V-CODE |
| ~~**Correction (V-CODE):** in the current task-data the IPEX admit **failed**: `tommyBuyerAgent-ipex-admit-info.json` has `admitSuccess: false`~~ **FIXED 13 Nov** (C1/C1d/C1e, see `ARCHITECTURE-vLEI-2026-11-13.md` §2): after the clean re-run the file has `admitSuccess: true, credentialHeld: true, admitPath: notification` for INV-2026-0003 | V-CODE |

## 3. Change V1 — add JupiterInventoryAgent to 4D (real identity)

### 3.1 What
A second sub-agent under `jupiterSellerAgent`, advisory only (no payment authority), delegated in KERI exactly
like JupiterTreasuryAgent.

### 3.2 Company file change (`appconfig/org/companies/jupiter.json`)
Add one agent entry and allow the seller agent to delegate to it. Shape follows the existing
JupiterTreasuryAgent entry (V-READ in the 12-Nov handoff text):

```json
{ "@id": "ca:agent/JupiterInventoryAgent", "@type": "prov:SoftwareAgent", "alias": "JupiterInventoryAgent",
  "agentType": "AI", "actedOnBehalfOf": "ca:agent/jupiterSellerAgent",
  "mandate": { "authorization_details": [ { "type": "inventory_operations",
      "actions": ["stock_check", "delivery_feasibility"] } ],
    "validUntil": "2027-11-12T00:00:00Z", "advisoryOnly": true, "may_act": [] } }
```
and in `jupiterSellerAgent.mandate.may_act` add `"ca:agent/JupiterInventoryAgent"` beside JupiterTreasuryAgent.

Action names `stock_check`, `delivery_feasibility` are new labels (custom `ca:` namespace), not from a standard.

**As built (V-CODE):** `advisoryOnly: true` sits on the agent (same place as JupiterTreasuryAgent), not inside
`mandate`. The entry also has a `card` block (name, description, skills `stock_check`/`delivery_feasibility`,
`officialRole: "Partner"`, `engagementRole: "Inventory Agent"`, `"url": null` because no Inventory service exists yet).
`build-org-config.js` now copies `advisoryOnly` into config-4d sub-agents.

### 3.3 Gates before coding
| ID | Check | Where |
| --- | --- | --- |
| G-01 | `build-org-config.js` emits **two** sub-agents for one parent in `config-4d.json` (and its 8 checks pass: may_act, unique aliases, advisory has no limit above parent) | read build-org-config.js |
| G-02 | The 4D sub-agent loop delegates **every** sub-agent of a parent (not only the first) | read run-all-buyerseller-4D-with-subdelegation.sh sub-agent loop |
| G-03 | `generate-subagent-brans.sh --config` creates a BRAN for the new alias (file only, never printed) | read script |
| G-04 | `generate-agent-cards.js --per-officer-oor` makes a card for the new alias; card `url` field (open item 7 says some are placeholders) | read script + config cards |
| G-05 | `print-org-trust-tree.js --strict` counts identities from config (expect **18** after the change) or has a hard-coded 17 | read script |
| G-06 | `docker-compose.yml` `KRAM_CALLER_INFO_PATHS` (open item 5): needed only if the api-server KRAM check is used for these agents | read compose + api-server usage |

Gate results (V-CODE, 13 Nov):
| ID | Result |
| --- | --- |
| G-01 | PASS. `orgBlock()` maps **all** sub-agents (`subs.map`); the 10 checks pass with the InventoryAgent (dry-run output shows both sub-agents under jupiterSellerAgent). config-4c.json is unchanged. |
| G-02 | PASS. The Phase 3 loop runs `for sub_idx < SUB_COUNT`, filtered by the parent's `may_act`. |
| G-03 | PASS. The script loops over every sub-agent and writes `task-data/<alias>-bran.txt`, `subagent-brans.json` and `../Legent/A2A/js/src/agents/<alias>/.env`. **Note:** it (and 4D Phase 3) prints the first 20 characters of each BRAN to the console/log. That was not changed. |
| G-04 | PASS, with a fix. The sub-agent template hard-coded the Treasury name, skills, `officialRole: ChiefFinancialOfficer` and `engagementRole: Treasury Agent`. name/description/url/skills could already be overridden from `card`. **Changed:** `officialRole`/`engagementRole` can now be overridden from `card` too; without a `card` the defaults are the same as before (the Treasury card was regenerated in a scratch dir and is identical apart from its timestamp). |
| G-05 | PASS. Counts come from the config; nothing is hard-coded. With the new config it shows 17 found + 1 missing (`JupiterInventoryAgent-info.json`) until 4D is re-run. |
| G-06 | NOT NEEDED. Today the list has only tommyBuyerAgent and jupiterSellerAgent (Treasury isn't in it either). Left unchanged. |

### 3.4 Impact (must accept before running)
- A 4D re-run with `--force-base` **re-mints every identity** (V-HANDOFF: "every run re-mints agent AIDs" from the
  12-Nov handoff). All AIDs, OOBIs and credential SAIDs change. Anything that copied the old ones must be refreshed:
  - DD5 agents that use `copy-brans-to-dd-local.*` (V-READ file names exist; their use is not verified).
  - Any recorded evidence file (section 5) — export only after the final run.
- Tommy side unchanged. No inventory agent for Tommy (not needed for the demo). DECISION D-01 if wanted later.

## 4. Change V2 — fix the wrong-company lookup (open item 1)

**Problem (V-HANDOFF):** during 4D, JupiterTreasuryAgent resolved Tommy's LE OOBI instead of Jupiter's. Likely
cause (not confirmed): a shared `le-info` file holding the last company processed.

**Why it matters:** the demo claims "this helper belongs to Jupiter". The evidence would contradict that.

**Plan:** G-07 read where the sub-agent step loads the LE OOBI; make it load the LE of the agent's own company
(company comes from the org config). Must hold for JupiterInventoryAgent too. Acceptance: after the run, each
sub-agent's resolved LE OOBI equals its own company's LE AID (checked by section 5's export with `--strict`).

**G-07 result and fix (V-CODE):** cause confirmed. `task-scripts/subagent/subagent-oobi-resolve-le.sh` read
`task-data/le-info.json`, which `le-aid-create.ts` overwrites for each company, so it held the last company
(Tommy; same AID as `Tommy_Hilfiger_Europe-info.json`). The agent version (`agent-oobi-resolve-le.sh`) already read
`<LE alias>-info.json`. **Changed:** the sub-agent script now reads `task-data/<LE alias>-info.json`, the alias
4D passes from the org config, and stops with an error if that file is missing (no fallback to the shared file).
**Acceptance limit:** what a sub-agent resolved is stored only in its KERIA contacts, which can be read only with its
BRAN. So the export cannot check it. Check the 4D log line `Sub-agent <alias> resolving LE OOBI: <url>` instead:
the AID in the URL must equal that company's `<LE alias>-info.json` AID.

## 5. Change V3 — invoice credential for NEAR (new config file, old one untouched)

### 5.1 New file `appconfig/invoiceConfig-near.json` (existing `invoiceConfig.json` unchanged)
| Field | Value | Reason |
| --- | --- | --- |
| issuer / holder | Jupiter_Chief_Sales_Officer → tommyBuyerAgent (labels only; real issuer is jupiterSellerAgent, self-attested, see section 2 correction) | same as today (V-READ) |
| sellerLEI / buyerLEI | 3358004DXAMRWRUIYJ05 / 54930012QJWZMYHNJW95 | V-READ |
| currency | `USDC` | fits `^[A-Z0-9]{1,5}$` |
| totalAmount | `0.084` (penny test: $84,000 ÷ 1,000,000) | max 6 decimals (USDC) |
| lineItems | 1 item: "Cotton t-shirts", 8000, unitPrice `0.0000105`, amount `0.084` | schema allows exactly 1 |
| paymentMethod | `blockchain` | enum |
| paymentChainID | `near:testnet` | CAIP-2 style, same as chainaim-adminUI-NEAR's choice (V-READ: README says CAIP-2 ids default `near:testnet`) |
| paymentWalletAddress | Jupiter's NEAR payee account, **20–100 characters** | **schema minLength is 20**: a name like `jupiter-co.testnet` (18) FAILS. Use e.g. `chainaim-jupiter-payee.testnet` (MANUAL to create) |
| ref_uri | a valid URI, e.g. `urn:chainaim:order:INV-2026-0003` | required; must be a URI |

The schema itself is **not** changed (changing it changes its SAID). G-08: the issue script's flag for choosing the
invoice config (if none exists, add `--invoice-config <path>` with today's file as default).
G-09: which script issues + IPEX-grants the invoice in the current repo (`test-invoice-ipex-workflow.sh` exists,
V-READ by name only) and whether 4D already runs it.

**As built (V-CODE):** `appconfig/invoiceConfig-near.json` was created with the values above, plus invoiceNumber
`INV-2026-0003`, invoiceDate 2026-11-13 and dueDate 2026-12-13 (Net 30). It was checked against both
`self-attested-invoice.json` (the schema actually used) and `invoice-credential-schema.json`: all fields allowed,
patterns, lengths and enum OK. The payee `chainaim-jupiter-payee.testnet` (30 chars) is a **name only**: the
account must be created (MANUAL, section 7.3) before the bridge registers the invoice.
- G-08 RESULT: `task-scripts/invoice/invoice-acdc-issue-self-attested.sh` already takes the invoice config as `$2`;
  4C passed its fixed `./appconfig/invoiceConfig.json`. **Added** `--invoice-config <file>` to
  `run-all-buyerseller-4C-with-agents.sh` and `run-all-buyerseller-4D-with-subdelegation.sh` (4D passes it on
  to 4C). Without the flag, both run exactly as before. 4D warns when the flag is given but Phase 1 is skipped (no `--force-base`).
- G-09 RESULT: 4C sections 7.1–7.4 create the registry, issue, IPEX-grant and IPEX-admit, and 4D runs 4C in
  Phase 1. `test-invoice-ipex-workflow.sh` only runs `DEEP-EXT-credential.sh` (a verifier); it issues nothing.

### 5.2 Amount precision
JSON `totalAmount` is a number. The bridge (section 7) must read it as a decimal string from the credential's
serialized JSON and convert to USDC base units (6 decimals) without floating point, and refuse more than 6 decimals.

## 6. Change V4 — `export-signatory-evidence.js` (new, read-only)

Purpose: one public JSON file that the NEAR bridge and the judges can use without running KERIA. Same safety rule as
`print-org-trust-tree.js`: reads `task-data/*-info.json` and `*-oor-credential-info.json`; **never opens BRAN files,
agent-brans.json or .env files**.

Flags: `--config <config-4d.json>` `--task-data <dir>` `--out <file>` `--invoice-said <SAID>` `--fetch-kel on|off`
(default on) `--keria-url <url>` `--strict` `--dry-run`.

Output `signatory-evidence.json`:
```
{ "generatedAt", "source": { "gedaAid", "qviAid", "run": "<config-4d path + hash>" },
  "companies": [ { "lei", "leAid", "officers": [ { "alias", "aid", "oorCredential": { "said", "schemaSaid", "acdc" } } ],
                   "agents": [ { "alias", "aid", "delegator", "kel": "<CESR text>", "role", "advisoryOnly" } ] } ],
  "invoice": { "said", "acdc": "<full credential JSON>", "issuerAid", "holderAid", "ipex": { "grantSaid", "admitSaid" } } }
```

Gates:
| ID | Check |
| --- | --- |
| G-10 | Where the issued invoice ACDC and the IPEX grant/admit SAIDs are stored after the invoice step. If only inside KERIA, add a read-only sig-wallet task that fetches the credential by SAID for the holder (uses the holder's BRAN internally like other tasks; never prints it). |
| G-11 | KEL fetch: OOBI endpoints return the KEL stream without keys (V-HANDOFF: live OOBI check returned icp → ixn → dip chain). Confirm URL form from `*-info.json`. |
| G-12 | `<alias>-oor-credential-info.json` holds the full OOR ACDC, or only its SAID. |

`--strict` fails when: any configured identity is missing, a sub-agent's delegator is not its configured parent,
a sub-agent's LE is not its own company's LE (section 4), or the invoice issuer is not the holder of a Jupiter OOR.

**As built (V-CODE): `legentvLEI/export-signatory-evidence.js`** (Node built-ins only, no npm install).
- Gate results: **G-10**: the invoice ACDC is in task-data: `<seller>-self-invoice-credential-info.json` `acdc._raw`
  is the exact serialization the SAID was computed over. The grant SAID is in `<seller>-ipex-grant-info.json`
  `grantResult.said`. The admit file stores `admitSuccess` and `grantSAID` but **no admit SAID**. No new sig-wallet
  task was needed. **G-11**: the OOBI URLs in `*-info.json` use `http://keria:3902/...`, and KERIA's port 3902 is
  published to the host. GET returns `200 application/json+cesr`, and that stream also carries the delegators'
  events. `--keria-url` (default `http://127.0.0.1:3902`) replaces the Docker host name. **G-12**: the OOR info holds
  only `said`, `issuer`, `issuee`, `grantSaid`, **not the full ACDC**. The export writes those four fields and no `acdc`.
- Output differs from the sketch above in these ways: `oorCredential` = `{said, issuerAid, issueeAid, grantSaid}`;
  each agent has `delegationVerified`; `invoice` has `acdcRaw` + parsed `acdc`, `selfAttested`, `issuerDelegatedFrom`
  (officer alias/AID/OOR SAID), and `ipex: {grantSaid, grantCredentialSaid, admitSuccess, admitGrantSaid}`; a
  `checks` block lists every failure. Extra flags: `--seller-agent`, `--buyer-agent`. Default `--out` is
  `task-data/signatory-evidence.json`.
- The strict rule for the invoice is **corrected** for the self-attested flow. It fails unless: invoice SAID = grant's
  credential SAID (= `--invoice-said` if given), issuer = seller agent AID, `sellerLEI` = seller company LEI, the seller
  agent's `dip` names a seller-company officer who holds an OOR, and the buyer's admit succeeded. Delegation checks
  use the KEL: the child's inception is `dip`, `di` = configured parent, and the parent's own events anchor a seal for the child.
- Safety: the script refuses to open `*-bran.txt`, `agent-brans.json`, `subagent-brans.json` or `.env` files, copies
  only whitelisted fields (never `branFile`), and refuses to write if any output key looks like a secret.
- Tested 13 Nov against the live stack and the current task-data. All 6 existing agents/sub-agents were KEL-verified.
  A scratch config that claimed the wrong parent was rejected. An output written to the scratchpad contains none of the
  task-data BRAN values. Current strict result: 2 real failures, InventoryAgent not minted yet and admit `false`.

## 7. NEAR side — new repo `chainaim-signatory` (4D never touched)

### 7.1 Components
| Component | Job | Flags (defaults keep it safe) |
| --- | --- | --- |
| `contracts/mandate` | Holds USDC. `register_invoice(said, payee, amount_units, buyer_agent)` (attestor only) · `pay_invoice(said)` (agent: pays if ≤ agent limit and within period budget, else pending) · `approve(said)` (officer account only) · `reject(said)` · `revoke(agent)` (officer/CEO) · views `get_invoice`, `get_mandate`. Emits NEP-297 events with the invoice SAID. | init args: `attestor`, `usdc_contract`, `agent_limit_units`, `officer`, `ceo` |
| `bridge` | Reads `signatory-evidence.json`; recomputes the invoice SAID; checks issuer = **jupiterSellerAgent** (the invoice is self-attested), whose `dip` names the Jupiter CSO, who holds a Jupiter OOR (`invoice.issuerDelegatedFrom`); enforces rule **R-IPEX** (below); checks payee/amount/chain; then `register_invoice`. | `--evidence` `--contract` `--network testnet` `--dry-run` `--tamper-field <name>` (demo only: alters a copy in memory to show refusal; labelled in output) |
| `config/accounts.json` | Public map vLEI alias → NEAR account id (no keys). | — |
| `signer` (local service) | Signs `pay_invoice` / `approve` / `revoke` with keys from a secrets folder outside the repo; the browser never sees keys. | `--secrets-dir` `--port` `--network` |
| `advisors` | InventoryAgent / TreasuryAgent questions sent through chainaim-private-ai's gateway on the attested NEAR AI route; returns answer + attestation fields. | `--gateway-url` `--model` `--route attested` |

**Rule R-IPEX** (defined on the vLEI side in `ARCHITECTURE-vLEI-2026-11-13.md` §4; the bridge enforces it). An
invoice may be registered on NEAR only if all of these hold in the evidence (for the invoice chosen from
`invoices[]`): `checks.passed === true` (strict export) · `ipex.grantCredentialSaid === invoice.said` ·
`ipex.admitSuccess === true` · `ipex.credentialHeld === true` · issuer = the seller agent, whose `dip` names an officer of
the seller company holding an OOR · `acdc.a.paymentChainID === "near:testnet"`. No grant **and** admit → no
registration → no payment. The exporter (V-CODE 13 Nov) already fails `--strict` on every one of these except the
chain id, which only the bridge checks.

### 7.2 NEAR facts to verify before coding (official docs only)
| ID | Fact | Source to read |
| --- | --- | --- |
| G-20 | NEP-141: receiving tokens via `ft_transfer_call` → `ft_on_transfer`; paying with `ft_transfer` needs exactly 1 yoctoNEAR attached; receiver needs `storage_deposit` | NEP-141 spec, docs.near.org |
| G-21 | Async cross-contract call + callback to mark an invoice paid only after `ft_transfer` succeeds | docs.near.org smart contracts |
| G-22 | Function-call access key: `receiver_id` = contract, `method_names` = ["pay_invoice"], allowance covers gas only | docs.near.org access keys |
| G-23 | TestNet USDC contract id | reuse `chainaim-adminUI-NEAR/docs/NEAR-GATES.md` (V-READ that the file exists; value not re-read) |
| G-24 | NEP-297 event format | NEP-297 spec |
| G-25 | 1Click EXACT_OUTPUT minimum amount for the optional Intents scene (MainNet only; no testnet) | docs.near-intents.org swap limits page (not yet read) |

DECISION D-02: contract language — Rust `near-sdk` (recommended: most examples and audits) or JS `near-sdk-js`.

### 7.3 MANUAL setup (owner; done one step at a time later)
1. Create TestNet accounts: contract, attestor, `tommy-cpo`, `tommy-buyer-agent`, Jupiter payee (≥ 20 chars).
2. Add a function-call key on `tommy-buyer-agent` limited to the contract's `pay_invoice` (G-22).
3. Get TestNet USDC (Circle faucet) and NEAR for gas; `storage_deposit` for contract and payee.
4. Write each key to a file in a secrets folder outside every repo. **Never paste a key or the output of a
   command that prints one into any chat.**
5. Fund the contract with ~1 USDC via `ft_transfer_call`.

## 8. Non-breaking rules (must all hold)

1. 4D default behaviour unchanged: no new flag used → same run as today.
2. Existing files `invoiceConfig.json`, the invoice schema, `task-scripts/**`, `sig-wallet/src/tasks/**` are not
   edited unless a gate proves it necessary; any such edit is shown to the owner first.
3. New scripts are read-only on `task-data` and never touch BRAN/agent-brans/.env files.
4. The Signatory repo uses its own Docker compose project name and ports; it does not join or restart the vLEI stack.
5. Edits are made where the stack actually runs (owner's PC copy). If a WSL copy is used on another PC, sync is explicit.
6. Commit only when the owner asks.

## 9. Regression and acceptance

| Step | Who | Pass when |
| --- | --- | --- |
| 1. Old 4D run, no new flags | Owner runs | Same output as before; `print-org-trust-tree --strict` = 17 |
| 2. 4D with org config incl. InventoryAgent | Owner runs | `--strict` = 18; InventoryAgent delegated by jupiterSellerAgent; live OOBI shows `dip` under the seller agent |
| 3. LE check | `export-signatory-evidence --strict` | every sub-agent's LE = its own company's LE |
| 4. Invoice NEAR issue + IPEX | Owner runs | invoice credential with `near:testnet`, payee ≥ 20 chars; grant + admit SAIDs recorded |
| 5. Export | Claude-written script, owner runs | `signatory-evidence.json` has no key material (grep check for BRAN file names and 21-char passcodes returns nothing) |
| 6. Bridge dry-run | Owner runs | invoice SAID recomputes; `--tamper-field paymentWalletAddress` is refused |
| 7. Contract tests | `cargo test` / sandbox | pay ≤ limit, pending > limit, approve only by officer, revoke blocks, payee mismatch impossible |

## 10. Order of work
G-07 + V2 fix → V1 config + gates G-01..G-06 → 4D re-run → V3 invoice → V4 export → NEAR repo (contract → bridge →
signer → advisors) → UI (see ARCHITECTURE-signatory-ui.md).

## 11. Implementation log — vLEI side (2026-11-13)

Files changed (default behaviour of every existing script is unchanged when no new flag/config is used):
| File | Change |
| --- | --- |
| `legentvLEI/appconfig/org/companies/jupiter.json` | + JupiterInventoryAgent; added to jupiterSellerAgent `may_act` |
| `legentvLEI/build-org-config.js` | copies sub-agent `advisoryOnly` into config-4d |
| `legentvLEI/appconfig/generated/config-4d.json` | regenerated by `build-org-config.js --seller jupiter --buyer tommy`. Diff: InventoryAgent + `advisoryOnly` flags. config-4c.json byte-identical |
| `legentvLEI/generate-agent-cards.js` | sub-agent `card.officialRole` / `card.engagementRole` overrides (defaults unchanged) |
| `legentvLEI/task-scripts/subagent/subagent-oobi-resolve-le.sh` | V2 fix: reads `<LE alias>-info.json` (section 4) |
| `legentvLEI/run-all-buyerseller-4C-with-agents.sh` | + `--invoice-config <file>` (default `./appconfig/invoiceConfig.json`) |
| `legentvLEI/run-all-buyerseller-4D-with-subdelegation.sh` | + `--invoice-config <file>` passed on to 4C |
| `legentvLEI/appconfig/invoiceConfig-near.json` | NEW (section 5.1) |
| `legentvLEI/export-signatory-evidence.js` | NEW (section 6) |

Not changed: `invoiceConfig.json`, all schemas, `sig-wallet/src/tasks/**`, other `task-scripts/**` (the one edit above
was proven needed by G-07), `docker-compose.yml`, Tommy company file.

Owner run (WSL, in `legentvLEI`, stack up). Re-mints every AID (section 3.4):
```
node build-org-config.js --seller jupiter --buyer tommy
./run-all-buyerseller-4D-with-subdelegation.sh \
  --config-4c ./appconfig/generated/config-4c.json --config-4d ./appconfig/generated/config-4d.json \
  --invoice-config ./appconfig/invoiceConfig-near.json --force-base
node print-org-trust-tree.js --strict              # expect 18 found, 0 missing
node export-signatory-evidence.js --strict          # writes task-data/signatory-evidence.json
```
Regression (section 9 step 1): the old command without the new flags runs as before.

Open items found while building:
1. ~~IPEX admit currently fails (`admitSuccess: false`)~~ FIXED 13 Nov (C1/C1d/C1e); strict export passes.
2. ~~4D Phase 3 and `generate-subagent-brans.sh` print the first 20 characters of each BRAN~~ FIXED 13 Nov (C2: prints `(hidden)`).
3. The InventoryAgent card has `url: null` until an Inventory service exists (section 7.1 `advisors`).
4. NEAR side (section 7) not started: needs D-02, gates G-20..G-25 from official docs and the MANUAL accounts.

Sources: owner handoffs of 12 and 13 Nov 2026; files read 12 Nov (invoice schema, invoiceConfig.json,
chainaim-adminUI-NEAR README); code read and run on 13 Nov (V-CODE). NEAR facts in 7.2 are gates, not yet verified in official docs.
