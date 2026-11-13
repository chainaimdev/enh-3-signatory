# ARCHITECTURE — vLEI part (legentvLEI) for Signatory

Date: 2026-11-13 · Status: PLAN. Companions: `ARCHITECTURE-UI-2026-11-13.md`, `ARCHITECTURE-signatory-2026-11-13.md`.
Location: `C:\SATHYA\CHAINIAM3003\mcp-servers\CHAINAIMDEV\enh2-final\legentvLEI` (Git Bash / UCRT64).
Tags: V-READ (checked 13 Nov) · ASSUMED · GATE · AI / MANUAL.
Rules: no change until `PROCEED TO CHANGE <item>`; **4D must never break** (changes are additive, existing flags keep their behaviour); never open or paste BRANs, `task-data/*-bran.txt`, `agent-brans.json`, `subagent-brans.json`, `.env`; git commit deferred (owner, 13 Nov).

---

## 1. Role of the vLEI part

It proves **who may act**: GLEIF → QVI → legal entities → OOR officers (humans) → delegated AI agents → sub-agents, and it issues the **invoice credential** that the Signatory bridge registers on NEAR. Its only output to the other parts is `signatory-evidence.json` (no keys).

```
4D run (KERIA) ──► task-data/*.json ──► export-signatory-evidence.js --strict ──► UI/data/signatory-evidence.json
                                                                              └─► chainaim-signatory bridge (reads the same file)
```

---

## 2. Done and verified (13 Nov)

| Item | Evidence |
| --- | --- |
| Clean 4D re-run (stack wiped with `stop.sh --fresh && deploy.sh --fresh`) | log `4d-20261113-run.log`; tree: 2 LE, 4 OOR, 4 agents, 3 sub-agents incl. **JupiterInventoryAgent** |
| Invoice INV-2026-0003, 0.084 USDC, `near:testnet`, payee `chainaim-jupiter-payee.testnet`, self-attested by jupiterSellerAgent | `appconfig/invoiceConfig-near.json` (line item quantity 1, unitPrice 0.084: float fix) |
| IPEX grant → admit → credential held | `tommyBuyerAgent-ipex-admit-info.json`: `admitSuccess:true, credentialHeld:true, admitPath:notification` |
| Fixes C1 (admit uses grant SAID `note.a.d`, honest result), C1d (buyer resolves seller + delegator OOBIs before the grant, 4C §7.2b), C1e (buyer resolves invoice schema before admit), honest ✓ in 4C / admit wrapper / `api-server/server.js` | files listed in §6 |
| C2: 30 BRAN print lines → `(hidden)`; `.gitignore` covers `*-run.log`, `.edit-backup-*/` | grep: 0 left |
| D1 read-only diagnose tool | `task-scripts/invoice/invoice-ipex-diagnose.sh` |
| Strict export passed, no key-like fields | `UI/data/signatory-evidence.json` 06:23 UTC |
| Backups | `.edit-backup-2026-11-13T0515Z/` (code); `CHAINAIMDEV/task-data-backup-20261113T0535Z` (old task-data, holds BRANs, local only) |

Lessons recorded: (1) a delegated sender's grant is dropped unless the receiver knows the sender's KEL **and its delegator**; (2) the holder must know the schema or the admitted credential stays in escrow; (3) numbers < 0.0001 serialize differently in JS and Python → KERIA `Invalid sad`; (4) 4C is not idempotent: a re-run needs `stop.sh --fresh && deploy.sh --fresh`.

---

## 3. Remaining vLEI work (in order)

| # | Id | Change | Files | Who | Est. |
| --- | --- | --- | --- | --- | --- |
| 1 | G-34 | Export `invoice.ipex.credentialHeld`; strict fails unless `true` | `export-signatory-evidence.js` | AI | 15 min |
| 2 | G-36 | Export the invoice issuance proof: `invoice.issuance { telEvent (iss, CESR), registry, anchor { kelSeq, ixnSaid } }`. New read-only task fetches it from KERIA as the issuer (BRAN read from file, never printed; `connect()` only, never boot) | new `sig-wallet/src/tasks/invoice/invoice-export-issuance.ts` + `.sh`; exporter | AI | 1 h |
| 3 | G-32 | Second invoice INV-2026-0004, **0.1575 USDC** (quantity 1, unitPrice 0.1575, amount 0.1575; every number ≥ 0.0001), same parties, for the "above agent limit" scene | new `appconfig/invoiceConfig-near-2.json` | AI | 10 min |
| 4 | G-32 run | Issue + grant + admit the second invoice **without** re-running 4D. GATE: verify the issue/grant/admit scripts run standalone against current identities and that a second credential in the same registry is supported before running | existing task scripts | AI check, MANUAL run | 30 min |
| 5 | G-32 export | Exporter supports several invoices: `invoices[]` (keep `invoice` = first, for UI-1 compatibility) and `--invoice-said` selection | exporter | AI | 30 min |
| 6 | Float guard | Pre-check in the 4C invoice step: refuse any number with 0 < \|x\| < 0.0001, with a clear message | `run-all-buyerseller-4C-with-agents.sh` (§7.2) | AI | 15 min |
| 7 | Cosmetic | Replace the hard-coded `INV-2025-001` trust-tree text with the real invoice values | `run-all-buyerseller-4C-with-agents.sh:561` | AI | 10 min |
| 8 | Doc | `ARCHITECTURE-signatory-vlei.md` §7.1: issuer = jupiterSellerAgent (self-attested), delegated from the Jupiter CSO who holds an OOR; add rule **R-IPEX** (§4); mark the "admit failed" correction as fixed 13 Nov | doc | AI | 15 min |
| 9 | Optional | `build-org-config.js` "Run 4D with" hint: missing space before `--force-base` and missing `--invoice-config` | `build-org-config.js` | AI | 5 min |
| 10 | Re-export | `node export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json` after 1–5 | — | MANUAL | 2 min |
| 11 | After hackathon | Refresh DD5 cards/BRAN copies (`--dd-root`), all AIDs changed | 4D card step | MANUAL | — |
| 12 | Deferred | Commit `legentvLEI` (owner decides when; review file list for secrets first) | git | MANUAL | — |

### 3.0 Owner runs 13 Nov (after the AI work below)
- 12:52 IST `./issue-additional-invoice.sh --invoice-config ./appconfig/invoiceConfig-near-2.json` (Git Bash): INV-2026-0004, credential `EHusycc5UI7q2qRnfHhY-5fc0M9xkxB0nixx9Vs7m1qr`, grant `ELJYeYKt…`, admit via notification, `credentialHeld=true`; issuance: registry `EPGO2HZi…`, TEL iss `EKCY2TC_…` (s=0), anchor `ixn s=5 d=EM3wuvq4…`.
- 12:52 IST strict export to `../UI/data/signatory-evidence.json`: passed (item 10).
- Owner decision 12:50 IST: **no BRAN rotation now** (jupiterSellerAgent BRAN exposed in a session output, see §3.1 security note). Rotation = the final clean rebuild at the end: C2b (stop passing BRANs as CLI args: `invoice-acdc-issue-self-attested.sh`, `invoice-ipex-grant.sh`, `invoice-ipex-admit.sh`, `invoice-registry-create-agent.sh`, plus a search of all other `docker exec` calls; **the invoice part and the search are done, see §3.2**) → `stop.sh --fresh && deploy.sh --fresh` → 4D → item 4 again → item 10 again → re-register both invoices on NEAR (SAIDs change).
- Run vLEI scripts from **Git Bash** (Docker), not WSL Ubuntu (no Docker integration checked there).

### 3.1 Status after the AI work of 13 Nov (V-READ = run and checked on this PC, live stack)

| # | Status | What was done / found |
| --- | --- | --- |
| 1 G-34 | DONE | `ipex.credentialHeld` exported; strict fails unless `true` (tested: flipping it to `false` in a scratch copy → exit 1). |
| 2 G-36 | DONE | New `sig-wallet/src/tasks/invoice/invoice-export-issuance.ts` + `task-scripts/invoice/invoice-export-issuance.sh`. They connect only (no boot), never print the BRAN and make no write calls. They write `task-data/<issuer>-invoice-issuance-<SAID>.json`. The exporter adds `invoice.issuance` and re-checks it against the issuer's **public** KEL (OOBI): the anchoring ixn must be in the KEL with seal `{i: SAID, s: "0", d: iss}`, and the TEL state must be `iss`. Live result for INV-2026-0003: TEL iss `EKXaRLKN…`, state `iss`, anchor `ixn s=2 EBcpBhbo…`, `issuance-verified true`. Tested: a missing file and a tampered anchor both give exit 1. |
| 3 G-32 | DONE | `appconfig/invoiceConfig-near-2.json`: INV-2026-0004, quantity 1, unitPrice = amount = total = 0.1575, same parties/payee/chain. The description says "real 157,500.00 USD" (0.1575 × the 1:1,000,000 scale); no piece count was invented. |
| 4 G-32 gate | **DONE 13 Nov 12:52 IST (owner run)** — gate PASS, then | Checked in code: issue (`invoice-acdc-issue-self-attested-only.ts`) **reuses** the existing registry (it fails if the registry is missing and never recreates it). Grant takes the SAID the issue step just wrote. Admit matches the grant SAID from the grant file. A second credential in one registry is ordinary TEL use. **Catch:** the three files `<seller>-self-invoice-credential-info.json`, `<seller>-ipex-grant-info.json` and `<buyer>-ipex-admit-info.json` are overwritten. So the new `issue-additional-invoice.sh` keeps a copy of each invoice's files as `<base>.<SAID>.json`, runs issue → grant → admit → issuance export with the existing scripts, and fails unless the admit file shows `admitSuccess` and `credentialHeld` true for the new SAID. It refuses before any KERIA call on a duplicate invoiceNumber, a small float or missing run files (tested with a stub `docker`). Run against KERIA by the owner 13 Nov 12:52 IST (§3.0). |
| 5 G-32 export | DONE (2 real invoices) | `invoices[]` (all, oldest credential `dt` first); `invoice` = first, or the one `--invoice-said` names (unknown SAID → failure). Files are grouped by SAID, so a base file plus its copy count once (tested). Every invoice check runs per invoice. Re-checked by AI after the owner run: `--strict` passes with INV-2026-0003 and INV-2026-0004, both held and issuance-verified (INV-0004 anchor `ixn s=5 EM3wuvq4…`). |
| 6 Float guard | DONE | In 4C **section 1 (config validation)**, not §7.2: §7.2 runs only after the whole identity setup, and L3 asks for "before any KERIA call". Tested: a config with `0.0000105` → exit 1 at step [1/8] with no docker call (stub). The 3 real invoice configs pass. The same guard is in `issue-additional-invoice.sh`. |
| 7 Cosmetic | DONE | The 4C trust-tree text now shows the invoice number, amount + currency, LEIs, payment method/chain/payee and config path from the config this run uses. The wrong schema line (`invoice-credential-schema.json`) now shows the real `self-attested-invoice.json` + SAID. |
| 8 Doc | DONE | `ARCHITECTURE-signatory-vlei.md`: §7.1 bridge issuer rule, R-IPEX added, "admit failed" and the BRAN-print item marked fixed (C2 checked in code: `(hidden)`). |
| 9 Optional | DONE / no bug | The space before `--force-base` is present in both source and printed output (checked with `cat -A`), so it was likely a terminal wrap. Added a line that shows `--invoice-config ./appconfig/invoiceConfig-near.json` when that file exists. Generated configs are byte-identical (md5). |
| 10 | **DONE 13 Nov 12:52 IST (owner run)** | `--strict --out ../UI/data/signatory-evidence.json`: all 7 agents KEL-verified; INV-2026-0003 `EBQy-FlP…` 0.084 USDC and INV-2026-0004 `EHusycc5…` 0.1575 USDC, both `chain near:testnet · payee chainaim-jupiter-payee.testnet · admit true · held true · issuance-verified true`; "All checks passed." |

### 3.2 C2b — BRANs off the command line (AI, 13 Nov, after the owner runs)

**Done (invoice path, the scripts named in §3.0):** `task-scripts/invoice/invoice-acdc-issue-self-attested.sh`,
`invoice-ipex-grant.sh`, `invoice-ipex-admit.sh`, `invoice-registry-create-agent.sh`, and the inline fallback
registry call in `run-all-buyerseller-4C-with-agents.sh` §7.1. Each now passes `""` instead of the BRAN, and the host
no longer reads the BRAN (the file-exists check stays). **No TS change was needed:** all four tasks
(`invoice-acdc-issue-self-attested-only.ts`, `invoice-ipex-grant.ts`, `invoice-ipex-admit.ts`,
`invoice-registry-create.ts`) already read `/task-data/<alias>-bran.txt` with `.trim()` when the passcode argument is empty.
Checks (V-READ):
- Same passcode: the host used `$(cat)` and the tasks use `.trim()`. All 7 BRAN files give the same value both ways
  (checked without printing), so KERIA sees the same passcode. A different one would make `getOrCreateClient` boot a
  new agent.
- Argv: a stub `docker` that reports only true/false gave `BRAN_IN_ARGV=false` for all 4 scripts and `true` for the
  old issue script (control).
- Same identity through the in-container file read, read-only: `invoice-export-issuance.sh` connected as
  jupiterSellerAgent and `invoice-ipex-diagnose.sh` as tommyBuyerAgent (`receiver AID` = info file, `agent match YES`,
  `ALREADY_HELD`).
- Strict export still passes with both invoices.
- Not re-run against KERIA, because issue/grant/admit create new credentials. The first real use is the final clean
  rebuild (§3.0).

**Still open (search of all `docker exec` calls, 74 found outside backups):** these pass a passcode on the command
line, and their TS tasks take it **only** from argv. Fixing them needs a TS change in each task (e.g. read
`/task-data/<alias>-bran.txt` or a container env var), and they cover every step of 4C/4D, so they belong to the
planned final rebuild and are not done here (rule: 4D must never break):
- agent BRANs: `task-scripts/agent/agent-aid-delegate-finish.sh`, `agent-delegate-with-unique-bran.sh`,
  `agent-oobi-resolve-{agent,le,qvi,verifier}.sh`, `person/person-delegate-agent-create.sh`,
  `subagent/subagent-oobi-resolve-{le,qvi,verifier}.sh`, `subagent/subagent-delete-from-keria.sh`;
- workshop salts (`GEDA_SALT`, `QVI_SALT`, `LE_SALT`, `PERSON_SALT`): every script in `task-scripts/{geda,qvi,le,person}/`
  plus `test-geda-verbose.sh`;
- other invoice tasks not on the current path: `invoice-acdc-admit(.sh, -self.sh)`, `invoice-acdc-issue.sh`,
  `invoice-acdc-present.sh`, `invoice-query.sh`, `invoice-registry-create.sh`;
- test tools: `test-agent-verification-DEEP.sh`, `test-agent-verification-DEEP-credential.sh`;
- old copies `run_4c.sh`, `run-all-buyerseller-4C-with-agents-FIXED.sh` (not used by 4D).

**Found while doing this (owner to decide):**
- **BRAN in argv.** (Invoice path fixed by §3.2; the rest is listed there.) `invoice-acdc-issue-self-attested.sh`, `invoice-ipex-grant.sh` and `invoice-ipex-admit.sh` pass the agent's BRAN as a **command-line argument** to `docker exec`, so it shows in process lists and in anything that logs the command. In an AI test on 13 Nov, a stub `docker` echoed its arguments, and **jupiterSellerAgent's BRAN was printed in the local Claude session output.** Treat that BRAN as exposed. Rotating it means a fresh stack (`stop.sh --fresh && deploy.sh --fresh`) and a 4D re-run. Fix suggestion: the tasks read `/task-data/<alias>-bran.txt` themselves, as `invoice-ipex-diagnose.ts` and `invoice-export-issuance.ts` do. Not changed: it touches `task-scripts/**` and `sig-wallet/src/tasks/**`.
- Archive copies `<base>.<SAID>.json` of INV-2026-0003 already exist in task-data (made by the stub test; a real run makes the same copies).

---

### 3.3 Invoice supply for the live UI (Phase A, owner decision 13 Nov 14:55 IST)
Each live run in the UI consumes one unpaid invoice (a paid invoice cannot be paid twice). Phase A issues them in advance with the **existing** script, no vLEI code change:
- New config files only, e.g. `appconfig/invoiceConfig-near-3.json` INV-2026-0005 **0.12 USDC** (escalation → reject), `invoiceConfig-near-4.json` INV-2026-0006 **0.084 USDC** (success), `invoiceConfig-near-5.json` INV-2026-0007 **0.1575 USDC** (escalation → approve); quantity 1, unitPrice = amount; every number ≥ 0.0001; unique invoice numbers.
- MANUAL (Git Bash, current stack, ~2 min each): `./issue-additional-invoice.sh --invoice-config ./appconfig/invoiceConfig-near-N.json`, then once `node export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json`.
- Non-breaking: the script saves copies of the existing invoice files under their SAIDs before issuing; existing invoices 0003/0004 stay as paid history.
- Phase B (later) automates this per run (Signatory §S-7B); the final rebuild re-issues everything with new SAIDs.
- **Configs created 13 Nov (AI), new files only, no script/code edit:** `invoiceConfig-near-3.json` INV-2026-0005 0.12, `-near-4.json` INV-2026-0006 0.084, `-near-5.json` INV-2026-0007 0.1575 — generated from `invoiceConfig-near-2.json`; `diff` shows only invoiceNumber, totalAmount, the line item (quantity 1, unitPrice = amount = total; "real 120,000.00 / 84,000.00 / 157,500.00 USD") and `ref_uri`. All numbers ≥ 0.0001; numbers not yet issued (script guards read, not run). Issue/export: MANUAL, pending.

### 3.4 Phase B — vLEI invoice issued per chat request (owner decision 13 Nov 16:12 IST, Option A)
The Signatory runner (WSL Ubuntu) calls the **existing** `issue-additional-invoice.sh` and `export-signatory-evidence.js` once per request (Signatory §S-7B). No vLEI script or code edits.
- MANUAL setup (one time): Docker Desktop → Settings → Resources → WSL integration → enable **Ubuntu** → Apply & restart; in Ubuntu `sudo apt install -y jq`; check `docker ps` lists `tsx_shell`, `keria` from Ubuntu.
- V-READ 16:12: `issue-additional-invoice.sh` and `task-scripts/invoice/*.sh` use LF line endings (no CRLF), so they run under Ubuntu bash; the script needs `jq`.
- Generated configs go to a new folder `appconfig/generated-runs/` (add to `.gitignore`); invoice numbers continue after INV-2026-0007; every number ≥ 0.0001 (float guard).
- Each run appends to `task-data` (copies by SAID) and to the KERIA registry; the strict export grows with every invoice (watch export time; the runner's export timeout is 2 min).
- Gate G-42 (test before relying on it): one issue + export run **from Ubuntu** succeeds end to end (same output as from Git Bash).
**G-42 RESULT (owner runs, 13 Nov 16:25–16:36 IST): PASS with a hybrid route.**
- Setup: Docker Desktop WSL integration on for Ubuntu; `bala` added to group `docker`; after a Docker Desktop restart run `sudo chgrp docker /var/run/docker.sock` if `docker ps` says permission denied.
- Issue from Ubuntu: **works** — `./issue-additional-invoice.sh --invoice-config ./appconfig/generated-runs/invoiceConfig-INV-2026-0008.json` → INV-2026-0008 `EJkdJ9yH8nb7CPcufqIqtxQu6c4-7fQtax5nGZfqY_NK`, anchor `ixn s=9` (uses `docker exec`, container-to-container).
- Export with Ubuntu's node: **fails** — every OOBI fetch to `http://127.0.0.1:3902` times out (measured: the same OOBI takes 9.18 s from Ubuntu vs 0.02 s from Git Bash; WSL→Windows localhost bridge; `host.docker.internal` not resolvable; no proxy vars).
- Export with **Windows node.exe called from Ubuntu**: **works** — `"/mnt/c/Program Files/nodejs/node.exe" export-signatory-evidence.js --strict --out <file>` → all 7 agents KEL-verified, 6 invoices issuance-verified, "All checks passed".
- **Route for the runner:** issue = Ubuntu bash (`issue-additional-invoice.sh`); export = `/mnt/c/Program Files/nodejs/node.exe export-signatory-evidence.js` (configurable path). Fallback: exporter in a throwaway Node container on network `vlei_workshop` with `--keria-url http://keria:3902`. No script edits.

- The final rebuild (§3.0) still re-issues everything with new BRANs; Phase B then issues fresh invoices per request on the new identities.
- **Done 13 Nov (AI, vLEI-3.4 step 1):** `.gitignore` += `appconfig/generated-runs/` (checked with `git check-ignore`); folder created; test config `appconfig/generated-runs/invoiceConfig-INV-2026-0008.json` = `invoiceConfig-near-4.json` with only `invoiceNumber` and `ref_uri` changed (`diff`: 2 lines), 0.084 USDC, float guard clean. V-READ before the gate: INV-2026-0003…0007 already issued (task-data copies), so 0008 is free; the current export passes strict with 5 invoices; the scripts have no CRLF; `export-signatory-evidence.js` uses global `fetch` + `AbortSignal.timeout`, so **Ubuntu needs Node ≥ 18** (apt's default `nodejs` on Ubuntu 22.04 is v12).
- **Gate G-42 procedure (MANUAL, Ubuntu, from `/mnt/c/SATHYA/CHAINIAM3003/mcp-servers/CHAINAIMDEV/enh2-final/legentvLEI`):** (a) prerequisites `docker ps` shows `tsx_shell`/`keria`, `jq`, `node ≥ 18`, `curl http://127.0.0.1:3902/` returns an HTTP code (not `000`); (b) `./issue-additional-invoice.sh --invoice-config ./appconfig/generated-runs/invoiceConfig-INV-2026-0008.json` ends with `✓ INV-2026-0008 (...) issued, granted, admitted and held`; (c) `node export-signatory-evidence.js --strict --out /tmp/g42-ubuntu.json` passes with 6 invoices; (d) the same export from Git Bash gives the same JSON apart from `generatedAt`; (e) then the live UI export. No script or code edited.
- **G-42 result:** _pending owner run._

## 4. Rule R-IPEX (vLEI side defines it; the Signatory bridge enforces it)

An invoice may be registered on NEAR only if all hold in the evidence:
`checks.passed === true` (strict) · `ipex.grantCredentialSaid === invoice.said` · `ipex.admitSuccess === true` · `ipex.credentialHeld === true` · issuer = the seller agent, whose `dip` names an officer of the seller company holding an OOR · `acdc.a.paymentChainID === "near:testnet"`.
No grant **and** admit → no registration → no payment.

---

## 5. Evidence contract (what other parts may rely on)

Fields as written by the exporter (V-READ 13 Nov) plus additions from §3:
`generatedAt` · `source {gedaAid, qviAid, run{config, sha256}}` · `companies[] {alias, name, lei, leAid, leOobi, officers[] {alias, officialRole, aid, oobi, oorCredential{said, issuerAid, issueeAid, grantSaid}, kel}, agents[] {alias, aid, oobi, delegatorAlias, delegator, role, scope, advisoryOnly, delegationVerified, kel}}` · `invoice {said, schemaSaid, registry, selfAttested, issuerAlias, issuerAid, holderAlias, holderAid, acdcRaw, acdc, ipex{grantSaid, grantCredentialSaid, admitSuccess, admitGrantSaid, credentialHeld*}, issuerDelegatedFrom{officerAlias, officerAid, officerOorSaid}, issuance*, issuanceVerified*}` · `invoices[]*` (same shape as `invoice`) · `checks {strict, passed, failures[], notes[]}`. (* = added in §3.)
As built (13 Nov): `issuance = {telEvent{said, t, s, dt, sad, cesr}, telState{et, s, d, ri, dt}, registry, anchor{kelSeq, ixnSaid, t}, fetchedAt}` or `null`; `issuanceVerified` = true / false (or null with `--fetch-kel off`).
Guarantee: the exporter refuses to write any key-like field (`bran|passcode|secret|salt|privkey|private`).

---

## 6. Files changed on 13 Nov (uncommitted)

`sig-wallet/src/tasks/invoice/invoice-ipex-admit.ts` · `task-scripts/invoice/invoice-ipex-admit.sh` · `run-all-buyerseller-4C-with-agents.sh` (honest status, §7.2b) · `api-server/server.js` · new `sig-wallet/src/tasks/invoice/invoice-ipex-diagnose.ts` + `task-scripts/invoice/invoice-ipex-diagnose.sh` · new `sig-wallet/src/tasks/agent/agent-oobi-resolve-counterparty.ts` + `task-scripts/agent/agent-oobi-resolve-counterparty.sh` · `appconfig/invoiceConfig-near.json` · 23 files with BRAN prints hidden · `.gitignore`. Later on 13 Nov (§3.1): `export-signatory-evidence.js` (G-34/G-36/G-32) · new `sig-wallet/src/tasks/invoice/invoice-export-issuance.ts` + `task-scripts/invoice/invoice-export-issuance.sh` · new `issue-additional-invoice.sh` · new `appconfig/invoiceConfig-near-2.json` · `run-all-buyerseller-4C-with-agents.sh` (float guard, tree text) · `build-org-config.js` (hint) · `ARCHITECTURE-signatory-vlei.md`. C2b (§3.2): `task-scripts/invoice/invoice-acdc-issue-self-attested.sh`, `invoice-ipex-grant.sh`, `invoice-ipex-admit.sh`, `invoice-registry-create-agent.sh`, `run-all-buyerseller-4C-with-agents.sh` (registry fallback call). Plus the earlier session's V1–V4 files (`build-org-config.js`, `generate-agent-cards.js`, `appconfig/org/`, `export-signatory-evidence.js`, `print-org-trust-tree.js`, `subagent-oobi-resolve-le.sh`).

---

## 7. Acceptance (vLEI part)

Owner run for L2 (in `legentvLEI`, stack up, current identities, relative paths):
```
./issue-additional-invoice.sh --invoice-config ./appconfig/invoiceConfig-near-2.json
node export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json
```
Status 13 Nov: L1 ✓ (live, INV-2026-0003) · L2 ✓ (owner run 12:52 IST; strict re-checked by AI) · L3 ✓ (stub-docker test) · L4 not re-run after these edits (the default path changed in 4C validation, tree text and the C2b invoice-step argv; first real check = the final clean rebuild) · L5 ✓ for the export; the invoice scripts now pass no BRAN on the command line (§3.2), the rest of the scripts still do.

L1 strict export passes with `credentialHeld:true` and `issuance` present · L2 two invoices exported (0.084 and 0.1575), both with admit ✓ · L3 float guard refuses a config with `0.0000105` before any KERIA call · L4 4D still runs end to end from a clean stack with the existing command (non-breaking) · L5 no BRAN text in any log or export (grep).
