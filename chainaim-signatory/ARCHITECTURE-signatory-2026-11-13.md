# ARCHITECTURE — Signatory part (NEAR contract + services + ship)

Date: 2026-11-13 · Status: PLAN. Companions: `ARCHITECTURE-UI-2026-11-13.md`, `ARCHITECTURE-vLEI-2026-11-13.md`.
Location: `C:\SATHYA\CHAINIAM3003\mcp-servers\CHAINAIMDEV\enh2-final\chainaim-signatory` (created by the owner 13 Nov; V-READ 13 Nov: holds only this doc, no code yet).
Tags: V-READ · ASSUMED · GATE · DECISION · AI / MANUAL.
Rules: no change until `PROCEED TO CHANGE <item>`; never paste private keys, seed phrases or `.env` into chat (commands that print keys: run them, don't paste the output); the UI never holds keys; git commit deferred (owner).
Deadline: 14 Nov 2026 23:59 UTC. Punchline: "Private AI decides. Signed credentials prove. NEAR enforces."

---

## 1. What this part does

It turns the vLEI-proven invoice into an enforced payment on NEAR testnet:
- **bridge** checks the invoice (SAID recompute + rule R-IPEX) and registers it in the contract;
- **contract** holds each agent's mandate (limit, approver, revoked) and enforces: within limit → paid; above limit → pending until the human officer approves; revoked → refused;
- **signer** sends transactions for the agent and the CPO (keys stay on the PC);
- **runner** turns a typed request into the real steps (UI request box);
- **advisors** (optional) give attested AI advice from chainaim-private-ai.

```
UI (127.0.0.1:8765) ──► runner :8774 ──► bridge :8772 ──► contract (NEAR testnet)
        │                   │        └──► signer :8771 ──► token (NEP-141) / contract
        │                   └──► advisors :8773 ──► chainaim-private-ai attested route
        └──► RPC view calls (get_mandate, get_invoice, get_events)
inputs: ../UI/data/signatory-evidence.json (vLEI export), config/accounts.json
```

---

## 2. Decisions and gates (resolve first)

| Id | Item | Recommendation / action |
| --- | --- | --- |
| D-02 | Contract language | **DECIDED (owner, 13 Nov 12:36 IST): Rust near-sdk** + `cargo near` build/deploy. Alternatives considered: near-sdk-js (NEAR docs: prototyping/learning), Python/Go (community) |
| D-03 | Money flow | **ACCEPTED (owner "proceed", 13 Nov 12:36 IST; owner may still object).** Agent pays with NEP-141 `ft_transfer_call(contract, amount, msg={"invoice":"<said>"})`; contract forwards ≤ limit to the payee, holds > limit as `pending` (approve → forward, reject → refund), refuses otherwise (amount returned by `ft_on_transfer`). **Failed forward (owner, 13 Nov, S-2a #1):** direct pay (≤ limit) whose `ft_transfer` to the payee fails → the callback returns the full amount to the token, which refunds the **agent** (`ft_resolve_transfer`); invoice back to `registered`, `payment_refused` reason "forward to payee failed; amount returned". Failed approve/reject transfer → tokens **stay in the contract**, invoice back to `pending` (retry possible) |
| D-04 | Repo | V-READ 13 Nov: folder is inside the `enh2-final` git repo (no own `.git`, not in `.gitignore`). Either keep it there or `git init` it as its own repo before the first commit. Recommendation: own repo `chainaim-signatory`, and add `chainaim-signatory/` to enh2-final's `.gitignore` then |
| G-37 | Testnet USDC token id | **RESOLVED, V-READ 13 Nov**: `3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af` (Circle TestNet USDC). Source: `chainaim-private-ai/docs/NEAR-GATES.md` G2 (same id as `@x402/near` `DEFAULT_ASSETS`) and the recorded x402 payment `packages/observer/test/fixtures/x402-near-payment.json`. No demo token needed |
| G-38 | Funding test accounts with that token | **RESOLVED (source), MANUAL run**: faucet.circle.com, network "NEAR Testnet" (`chainaim-private-ai/MANUAL_SETUP.md` §NEAR). The receiving account must be storage-registered on the token first (S-1) |
| G-31 | Attestation field mapping (advisors) | **Shape V-READ 13 Nov, route still OPEN**: `chainaim-private-ai/test-console/console/attest.ts` — `JobAttestation {jobId, summary, at, calls[]}`, `summary ∈ verified · partly · unverified · unavailable · not_applicable · pending`, each call `{index, model, status (verified · unverified · unavailable · not_applicable), reason, servedModel, signatureKind, signingAlgo, signingAddress, tdx, gpu, signature, hashes, …}`. There is **no** `"attested"` summary value: the badge condition is `summary === "verified"`. Which private-ai endpoint S-8 calls is not yet read: GATE before coding S-8 |
| G-39 | USDC decimals | **RESOLVED, V-READ 13 Nov**: `ft_metadata` on the G-37 contract via `https://test.rpc.fastnear.com` → `symbol USDC, decimals 6`. Services still read `ft_metadata` at start and stop if decimals ≠ 6 (same guard as the private-ai paywall) |
| G-40 | Build/deploy toolchain on this PC | **RESOLVED 13 Nov 12:44 IST (see §4.0)**. Was: V-READ 13 Nov — `cargo`, `rustc`, `rustup`, `cargo-near`, `near` (near-cli-rs) are **not** on PATH and there is no `%USERPROFILE%\.near-credentials`. Node v26.13.1, Docker and WSL are present. Install them **inside WSL (Ubuntu)**, steps M-1..M-7 in §4.0 (commands from docs.near.org/smart-contracts/quickstart, read 13 Nov; the page pins no versions). Keys then live in WSL `~/.near-credentials`, so the services that sign (signer, bridge) run in WSL too. **V-READ 13 Nov (AI test):** a Node server bound to `127.0.0.1:8779` inside Ubuntu answered `curl http://127.0.0.1:8779/` from Windows (no `.wslconfig`, default WSL2 localhost forwarding), so the Windows browser reaches WSL services. ⚠️ The **default** WSL distro is `docker-desktop`, not Ubuntu (`wsl -l -v`): plain `wsl <cmd>` fails with `execvpe(bash) failed`; always use `wsl -d Ubuntu …` in scripts and run steps |
| G-41 | R-IPEX `credentialHeld` | **RESOLVED 13 Nov 12:52 IST**: owner re-exported (`--strict --out ../UI/data/signatory-evidence.json`): INV-2026-0003 (0.084) and INV-2026-0004 (0.1575) both `admit true · held true · issuance-verified true`, all checks passed. Was: **GATE (vLEI G-34)**: the current export (06:23 UTC) has no `invoice.ipex.credentialHeld` field. The bridge requires it and refuses until the evidence is re-exported with it — no relaxation |

---

## 3. Folder layout

```
chainaim-signatory/
  contract/            Rust near-sdk contract + unit tests + sandbox test
  services/
    signer/            Node + near-api-js
    bridge/            Node (evidence check, SAID recompute, register)
    runner/            Node (request → steps, SSE)
    advisors/          Node (optional; proxy to private-ai attested route)
    shared/            config loader, CORS, logging, decimal→units
  config/
    signatory.json     contractId, rpcUrl, token, ports, allowOrigin, evidencePath, demoScale
    accounts.json      vLEI alias → NEAR account (no keys)
  scripts/             deploy, set-mandates, health, demo-reset
  README.md  HACKATHON-DISCLOSURE.md  docs/video-script.md
```
`config/signatory.json` defaults: `rpcUrl https://test.rpc.fastnear.com` (tested by adminUI-NEAR: `chainaim-adminUI-NEAR/docs/NEAR-GATES.md`; view calls worked against it 13 Nov), `token 3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af`, `tokenDecimals 6`, `allowOrigin http://127.0.0.1:8765`, `evidencePath ../UI/data/signatory-evidence.json`, ports 8771–8774, `demoScale 1000000`.

---

## 4. Work items (in order)

### 4.0 Manual setup before any AI build (G-40) — owner, ONE step at a time, ~20 min
All in a WSL Ubuntu terminal. Paste only the result lines asked for; none of these steps prints a key.

| Step | Command | Expected result |
| --- | --- | --- |
| M-1 | PowerShell: `wsl -l -v` | an Ubuntu distro, VERSION 2 |
| M-2 | WSL: `rustc --version; cargo --version; near --version; cargo near --version; node -v; gcc --version \| head -1` | shows what is already present (missing = "command not found") |
| M-3 | `sudo apt update && sudo apt install -y build-essential pkg-config libssl-dev curl` | ends without errors |
| M-4 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` (choose default), then `source "$HOME/.cargo/env"` | `rustc --version` prints a version |
| M-5 | `rustup target add wasm32-unknown-unknown` | "installed" or "up to date" |
| M-6 | `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh \| sh` | `cargo near --version` prints a version |
| M-7 | `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh \| sh` | `near --version` prints a version |

**DONE 13 Nov 12:44 IST (owner, WSL Ubuntu 26.04 "resolute", user `bala`):** gcc 15.2.0 · curl 8.18.0 · rustc 1.100.0 · cargo 1.100.0 · target `wasm32-unknown-unknown` · cargo-near 0.23.0 · near-cli-rs 0.31.1 (config `~/.config/near-cli/config.toml`) · Node v22.22.1 · npm 9.2.0 (M-8, added: Node inside Ubuntu for the signer, which must run next to the keys).
Watch item: rustc 1.100 is very new; if `cargo near build` or deploy fails on a wasm feature, pin an older toolchain with `contract/rust-toolchain.toml` (project-only).
**Re-checked by AI 13 Nov (`wsl -d Ubuntu`, read-only):** the same versions listed above, and the near-cli `testnet` profile uses `https://archival-rpc.testnet.fastnear.com/`. `~/.near-credentials` does not exist yet, which is expected until S-1 creates accounts. The project folder is reachable from WSL as `/mnt/c/SATHYA/CHAINIAM3003/mcp-servers/CHAINAIMDEV/enh2-final/chainaim-signatory`.
**Done when:** M-2 shows rustc, cargo, near, cargo near, node and gcc (met 13 Nov). Then S-1 accounts (manual, keys never pasted) and the AI work below can start.

### 4.1 AI work order after 4.0 (each starts on `PROCEED TO CHANGE <id>`)
1. **S-2a** contract scaffold + all methods + unit tests (Rust, in `contract/`) — can start right after M-7, before accounts exist. **DONE 13 Nov (AI):** near-sdk 5.30.1, `cargo test` 43/43 pass, `cargo near build non-reproducible-wasm` → `contract/target/near/chainaim_signatory.wasm` (200 288 bytes, sha256 `80a1bbf6…52ed6`); decisions in §S-2 "Decided in S-2a".
2. ~~**vLEI G-34** (`credentialHeld` export) → owner re-exports evidence → unblocks the bridge (G-41).~~ **DONE 13 Nov 12:52 IST** (G-41).
3. **S-3** config (`config/signatory.json`, `config/accounts.json`) + scripts (deploy, set-mandates, health). **DONE 13 Nov (AI)**, see §S-3.
4. Owner: **S-1** accounts + storage deposits + faucet USDC; then **deploy** (S-2b) + set-mandates.
5. **S-4** signer, **S-5** bridge → owner runs **S-6** end-to-end (scenes 1, 2, 4 + tamper) without the UI. **S-4/S-5 DONE 13 Nov (AI)**, see §S-4; **S-6 DONE 13 Nov (owner)**, see §S-6.
6. UI-2 (UI doc), then S-7 runner / UI-2R, then S-8 advisors / UI-3 if time remains.


### S-1. NEAR testnet accounts — MANUAL, one at a time (~30 min)
| Role | Suggested account (configurable) | Key used by |
| --- | --- | --- |
| Contract | `chainaim-signatory.testnet` | deploy only (MANUAL) |
| vLEI registrar (only account allowed to call `register_invoice`; renamed from `chainaim-bridge.testnet` by the owner 13 Nov 13:30 IST, before creation; the **bridge service** signs as this account) | `chainaim-vlei-registrar.testnet` | bridge service (WSL): signs `register_invoice` itself, as the diagram in §1 shows (bridge → contract); this is the only key it loads |
| Buyer agent (payer) | `chainaim-tommy-buyer-agent.testnet` | signer service |
| Approver (Tommy CPO) | `chainaim-tommy-cpo.testnet` | signer service |
| Payee (Jupiter) | `chainaim-jupiter-payee.testnet` (named in the invoice `paymentWalletAddress`) | none (create it, keep its key offline) |
V-READ 13 Nov, re-checked after the 12:52 IST re-export (`view_account` on testnet): **all five accounts are still `UNKNOWN_ACCOUNT`** — none exists yet, including the payee the invoice already names. A forward to a missing or unregistered payee fails, so the payee must be created too (the name is fixed by the issued invoice; changing it means re-issuing the credential).
Keys stay in the NEAR CLI credentials folder; with near-cli-rs choose the legacy keychain (`~/.near-credentials/testnet/<account>.json`) so the signer can read them from `--credentials`. ⚠️ Never paste output that shows a private key. Then: `storage_deposit` on the token (G-37) for the **contract**, the **buyer agent** and the **payee** (the contract receives and forwards; the agent receives refunds; the payee receives payments), and fund the agent with USDC (G-38). The contract account also needs a little NEAR for storage and the 1 yoctoNEAR each `ft_transfer` requires.

### S-2. Contract — AI build (S-2a), MANUAL deploy (S-2b) (~3–4 h)
State: `owner`, `registrar`, `token`, `mandates: account → {company, role, limit_units, approver, revoked}`, `invoices: said → {amount_units, payee, seller_lei, buyer_lei, due, status, payer, paid_at}`, `events` index.

| Method | Caller | Rule |
| --- | --- | --- |
| `new(owner, registrar, token)` | deploy | — |
| `set_mandate(account, company, role, limit_units, approver)` | owner | penny test: agent 100000 units (0.10 USDC), CPO 250000 (0.25) |
| `register_invoice(said, amount_units, payee, seller_lei, buyer_lei, due)` | registrar | unique `said`, amount > 0 |
| `ft_on_transfer(sender_id, amount, msg)` | token contract only | invoice registered + unpaid; sender has a mandate, not revoked; amount == invoice amount; ≤ limit → `ft_transfer` to payee, `paid`; > limit → `pending`; else return full amount (refund) with `payment_refused` |
| `approve(said)` / `reject(said)` | the payer's approver | `pending` → forward `paid` (refused if amount > the approver's own `limit_units`) / refund `rejected` |
| `revoke(account)` | approver or owner | `revoked = true` |
| `get_mandate`, `get_invoice`, `get_events(from_index)` | anyone (view) | — |
Events: NEP-297 `EVENT_JSON:{"standard":"signatory","version":"1.0.0","event":"…","data":[…]}` — `invoice_registered`, `paid`, `payment_pending`, `payment_approved`, `payment_rejected`, `payment_refused`, `agent_revoked`.
Amounts with the real invoices (6 decimals): INV-2026-0003 0.084 → 84000 units ≤ 100000 → `paid` (scene 1); INV-2026-0004 0.1575 (vLEI G-32) → 157500 > 100000 → `pending`, ≤ CPO 250000 → approvable (scene 2).
Refusal in `ft_on_transfer` must **return** the amount (not panic): a panic also refunds, but it reverts the `payment_refused` log, so the reason would be lost. The tx therefore succeeds; the reason lives in the event (see S-4).
Forward/refund: `ft_transfer` (1 yoctoNEAR) + a private callback; on failure the callback restores the previous status and the tokens stay in the contract (no silent loss).
Tests: each rule + callback failure on `ft_transfer` (state rolled back) — **unit tests DONE (43)**. Sandbox flow for scenes 1, 2, 4 (near-workspaces + mock NEP-141) **DEFERRED** (owner, 13 Nov); S-6 on testnet covers the flow, and the private-callback guard (not reachable from unit tests) is checked in S-6.

**Decided in S-2a (owner, 13 Nov):**
1. Failed forward/refund handling — see D-03.
2. A successful `approve` logs **two** events: `payment_approved`, then `paid` (`via:"approved"`); direct pay logs `paid` (`via:"within_limit"`). The UI/signer can watch `paid` for both scenes.
3. A failed approve/reject `ft_transfer` logs a **plain log line** (not an event; no event for it in the list above) and `on_settle` returns `false`; invoice back to `pending`.
4. `approve` is still allowed when the agent was revoked **after** its payment went `pending` (the human decides). The approver's own mandate must exist, not be revoked, and cover the amount. → disclosure note (S-9).
5. `revoke` of an already revoked mandate is refused ("mandate already revoked"); `set_mandate` on an existing account replaces it and clears `revoked` (used by demo-reset).
6. Additions: view `get_config` → `{owner, registrar, token, events_count}`; `get_events(from_index, limit?)` (default/cap 100) returns `{index, event, block_height, timestamp_ns, json}` where `json` is the NEP-297 string as logged. Private callbacks: `on_pay_forward(said, payer) → U128`, `on_settle(said, settlement, approver) → bool`.
7. Gas: the contract reserves a static 15 Tgas for each `ft_transfer` and 15 Tgas for its callback, so the caller's `ft_transfer_call` needs ≥ 100 Tgas → signer flag `--gas-tgas` (default **150**), S-4.

### S-3. Config + deploy scripts — AI (~30 min), MANUAL run
`scripts/deploy` (build, deploy, `new`), `scripts/set-mandates` (from `accounts.json`), `scripts/health` (view calls + service health). Copy `config/accounts.json` to `../UI/data/accounts.json`; set `contractId`, `signerUrl`, `bridgeUrl` (and later `runnerUrl` for UI-2R, `advisorsUrl` for UI-3) in `../UI/signatory-config.json`. V-READ 13 Nov: that file has `contractId/signerUrl/bridgeUrl/advisorsUrl` empty and **no `runnerUrl` key yet** (UI doc §5 adds it); edit only those values, keep every other key.

**DONE 13 Nov (AI), MANUAL run pending.** Files:
- `config/signatory.json` — §3 defaults plus `accountsPath`, `uiConfigPath`, `uiAccountsPath`, `wasmPath`, `gasTgas 150`, `explorer`. Relative paths resolve from the `chainaim-signatory/` root.
- `config/accounts.json` — no keys. Top level: `owner` (= contract account), `registrar`, `payee`. `aliases`: vLEI alias → `{account, role, company, lei}` for `tommyBuyerAgent`, `Tommy_Chief_Procurement_Officer`, `Jupiter_Knitting_Company` (aliases/LEIs V-READ from the 07:22Z export). `mandates`: `{alias, limitUnits, approver}` — agent 100000 → approver CPO; CPO 250000 → approver `owner`. Copied to `../UI/data/accounts.json` (13 Nov; `set-mandates.sh` re-copies).
- `scripts/deploy.sh` (WSL): build → refuse if the contract account is missing or already initialized (`--redeploy` = new code, no `new`) → `near contract deploy … with-init-call new … sign-with-legacy-keychain send` → verify `get_config`. `--dry-run`, `--skip-build`.
- `scripts/set-mandates.sh` (WSL): `set_mandate` per mandate signed by `owner`, verified by `get_mandate`, then copies accounts.json to the UI. `--dry-run`, `--only <alias>`; also the mandate demo reset (S-2a #5).
- `scripts/health.mjs` (Windows or WSL, read-only): RPC, token decimals, S-1 accounts, token storage registration (contract, buyer agent, payee), evidence amount/payee/chain, contract code + free balance + `get_config`, mandates vs accounts.json, evidence invoices on chain, agent USDC vs unpaid invoices, services `/health`. `--stage accounts|contract|all`, `--require-services`. Exit 1 on any FAIL.
- UI config rule (reconciles UI doc §7 "leave `""` until each answers `/health`"): `health.mjs --write-ui-config` writes `contractId` only after `get_config` passes and each service URL only after its `/health` passes; it never clears a value and keeps every other key. Not written yet (nothing deployed).
- Scripts read no key; they only check that `~/.near-credentials/testnet/<signer>.json` exists. Signing is done by the near CLI.
**Tested by AI 13 Nov:** bash syntax, LF endings, near-cli-rs 0.31.1 command chains (`--help`), `deploy.sh --dry-run --skip-build` and `set-mandates.sh --dry-run` (both stop: contract account `none`), `health.mjs` from WSL and Windows: rpc + token PASS, all 5 accounts `UNKNOWN_ACCOUNT` (S-1 not done), both evidence invoices parse to 84000 / 157500 units.
**Owner run order:** S-1 accounts → `node scripts/health.mjs --stage accounts` until no FAIL → `bash scripts/deploy.sh` → `bash scripts/set-mandates.sh` → `node scripts/health.mjs --stage contract`.

### S-4. Signer service — AI (~1.5 h)
Flags `--port 8771 --config ../../config/signatory.json --credentials <near credentials dir> --allow-origin http://127.0.0.1:8765 --gas-tgas 150` (`--gas-tgas`: gas for `ft_transfer_call`, `approve`, `reject`; default 150, refuse < 100; S-2a #7). Endpoints: `GET /health`; `POST /pay {said}` (agent → `ft_transfer_call`, amount from `get_invoice`), `/approve {said}`, `/reject {said}`, `/revoke {account}` (CPO). Response `{ok, txHash}` or `{ok:false, error}` (contract error verbatim). `/pay` also returns `outcome` read from the tx's `EVENT_JSON` logs (`paid` · `payment_pending` · `payment_refused` + its reason), because a refused payment is a successful tx (S-2). Keys read from `<credentials>/testnet/<account>.json` (in WSL: `~/.near-credentials`); loads only the buyer-agent and CPO keys. Runs in WSL (`wsl -d Ubuntu`, Node v22.22.1). Binds 127.0.0.1; never returns or logs keys.

**S-4 + S-5 DONE 13 Nov (AI)**, owner on-chain setup confirmed before (`health --stage contract` OK; registrar `chainaim-vlei-registrar.testnet`). Files: `services/package.json` (**one** package for all services — shared/ needs the same `node_modules`; pins `near-api-js 7.4.0` (7.5.x was 2 days old) and `@noble/hashes 2.4.0`), `services/shared/{http,near}.mjs`, `services/signer/index.mjs`, `services/bridge/{index,rules}.mjs`, `services/test/*.test.mjs`, `scripts/view.mjs` (read-only S-6 views: `invoice|mandate|balance|events|snapshot`).
- Both: start-up guard (token decimals = 6, contract `get_config` token; bridge also registrar = accounts.json), key file `<credentials>/testnet/<account>.json` → checked to be an access key of that account (public key used internally, never printed), every tx sent with `waitUntil: FINAL` so callback logs are included; contract panics returned verbatim (`Smart contract panicked: …`); responses carry `txHash` + `txUrl` (nearblocks). `--no-send` = start without keys (used for AI tests). One JSON log line per request (method, path, status, ms, txHash/outcome/error).
- Signer: `/pay` pre-checks only that the invoice is registered (amount from `get_invoice`); everything else is left to the contract. Returns `outcome` (last of `paid`/`payment_pending`/`payment_refused` + reason) and `usedUnits`/`refundedUnits` from the `ft_transfer_call` result (P4 evidence). `/approve` `/reject` → `ok:false` with the contract's log line when `on_settle` returns `false`. Gas: `--gas-tgas` (default 150, 100..300) for pay/approve/reject; revoke 30 Tgas.
- Bridge additions: `POST /check {said, tamperField?}` = rules only, nothing sent (+ `wouldRegister`, `onChain`); `--evidence <path>` for the P6 copy; `/register` of an already registered SAID returns `ok:true, alreadyRegistered:true` without a tx; evidence re-read per request; amount, payee, chain and issuer taken from the **hashed** `acdcRaw` bytes (also `acdcRaw.i` = seller agent AID); `tamperField` = any `a.*` attribute (string → `-TAMPERED`, number → +1), response labelled `demo`. register gas 30 Tgas.
**Tested by AI 13 Nov:** `npm test` 19/19 (both SAIDs exact; all 10 rules pass for both invoices → 84000 / 157500; tamper payee/amount → SAID refused; P6 `admitSuccess:false` copy refused; held/grant/strict/issuer/payee/chain refusals; amount parser; outcome parsing on RPC-shaped fixtures; P8 origin policy). Live `--no-send` smoke run against the deployed contract: both services start (guards pass), `/check` INV-2026-0003 all PASS, tamper `/register` refused, foreign Origin 403, allowed Origin gets the CORS header. Signing paths (real keys) are first exercised in S-6.

### S-5. Bridge — AI (~1.5 h)
`POST /register {said, tamperField?}` → load evidence → recompute invoice SAID from `acdcRaw` (Blake3) → enforce **R-IPEX** (strict checks passed; grant carries this SAID; admit ✓; credential held ✓; issuer = seller agent delegated from an OOR officer; chain `near:testnet`; payee = `accounts.json` payee) → `register_invoice` as registrar (flags `--port 8772 --config … --credentials <WSL ~/.near-credentials>`, loads only the `chainaim-vlei-registrar.testnet` key; runs in WSL). Refusal returns the reason; nothing sent. `tamperField` alters a copy → SAID mismatch → refused (labelled demo, scene 3). Decimal string → integer units, no floats.
Concrete against the current export (V-READ 13 Nov: `generatedAt 2026-11-13T07:22:21.237Z`, the 12:52 IST re-export): invoice from `invoices[]` (present now: INV-2026-0003 `EBQy-FlPtaa6_kh-BZI5Cn-ndtJ2It5Q3JNDMH3oYY1z`, INV-2026-0004 `EHusycc5UI7q2qRnfHhY-5fc0M9xkxB0nixx9Vs7m1qr`; `invoice` = `invoices[0]`), selected by `said`; SAID = Blake3-256 of `acdcRaw` with `d` replaced by 44 `#` (`JSON.parse` keeps the field order, then compact `JSON.stringify`), base64url of the 32-byte digest with one zero byte in front, first char replaced by the CESR `E` code, must equal `invoice.said` (the export's `checks.notes` says the bridge does this). **Tested by AI 13 Nov** with `@noble/hashes` 2.4.0 (the copy already in `chainaim-private-ai/services/paywall/node_modules`; v2 needs the import path `@noble/hashes/blake3.js`): both SAIDs recomputed **exactly**, and a copy with `paymentWalletAddress` changed gives a mismatch (scene 3 works on real data). The bridge declares `@noble/hashes` in its own `package.json`, without reaching into private-ai; strict = `checks.strict && checks.passed`; grant = `ipex.grantCredentialSaid === said`; admit = `ipex.admitSuccess === true`; held = `ipex.credentialHeld === true` (now `true` for both invoices; G-41 resolved). Both invoices also carry `issuance` + `issuanceVerified:true` (vLEI G-36). The bridge reports them but does not add them as a new rule; issuer = `invoice.issuerAid` is agent `jupiterSellerAgent` in `companies[]` with `delegationVerified:true`, whose `delegator` = `issuerDelegatedFrom.officerAid` and that officer's `oorCredential.said` = `issuerDelegatedFrom.officerOorSaid`; chain `acdc.a.paymentChainID === "near:testnet"`; payee `acdc.a.paymentWalletAddress` = `accounts.json` payee. Amount: `totalAmount` is a JSON **number** (`"totalAmount":0.084` in `acdcRaw`), so take its digits from the `acdcRaw` text, not from a parsed JS number; refuse > 6 fractional digits.

### S-6. End-to-end check without UI — MANUAL (~30 min)
`scripts/health`; register INV-2026-0003 → pay → `paid` (scene 1); register INV-2026-0004 (vLEI G-32, 0.1575) → pay → `pending` → approve → `paid`, and reject path → refund (scene 2); revoke → pay refused (scene 4); tamper → refused (scene 3); **private callback must be refused**: calling `on_pay_forward` (and `on_settle`) as any account other than the contract (e.g. the buyer agent) fails with "Method on_pay_forward is private" and the invoice state is unchanged (`get_invoice` before = after). Each with tx links.

**RUN 13 Nov (owner, live testnet, via signer + bridge; tx hashes as reported, shortened):**
| # | Step | Result | Tx |
| --- | --- | --- | --- |
| 1 | bridge register INV-2026-0003 | registered | `3RaUB3…` |
| 2 | CPO revoke buyer agent | `agent_revoked` | `7kHEn3…` |
| 3 | pay INV-2026-0003 while revoked (scene 4) | `payment_refused` "mandate revoked", refunded 84000 units to the agent | `BQ8zFt…` |
| 4 | `scripts/set-mandates.sh` (reset, clears `revoked`) | mandates restored | — |
| 5 | pay INV-2026-0003 (scene 1) | `paid` `via:"within_limit"` | `EhENXV…` |
| 6 | bridge register INV-2026-0004 | registered | `FefFaa…` |
| 7 | pay INV-2026-0004 (scene 2) | `payment_pending` | `BFaZCF…` |
| 8 | CPO approve INV-2026-0004 | `paid` `via:"approved"` | `8uLtun…` |
| 9 | bridge register INV-2026-0003 with `tamperField:"paymentWalletAddress"` (scene 3) | refused (SAID mismatch), `sent:false` | none |
| 10 | call `on_pay_forward` as a non-contract account (P1 private-callback check) | refused "Method on_pay_forward is private" | `A1AHCDVDv1MG2in33wEs1Xh7YqDFfQ4PK4FssbCYCrKx` |
| 11 | call `on_settle` as a non-contract account | refused "Method on_settle is private" | `3z71sVDFGDkB8xpx16xZbYqsCdhYDgXF7skKg9HqcCuB` |
| 12 | state diff before/after 10–11 | STATE UNCHANGED | — |
**S-6 DONE 13 Nov (owner).** Rows 10–11 cross-checked by AI 13 Nov against the FastNear testnet tx index for `chainaim-signatory.testnet`: both hashes present with `is_success:false`; contract `get_events` still 8 events (none added by 10–11).
Order note: only two issued invoices exist, so scene 4 ran before scene 1 on the same invoice (refusal leaves it `registered`). **Reject path** (scene 2b): unit-tested only (S-2a); live test with **INV-2026-0005** in the final rebuild (owner, 13 Nov). **Private-callback check**: DONE, rows 10–12 (P1). P6 (`admitSuccess:false` evidence copy): unit-tested in `services/test/rules.test.mjs`, not run live.

### S-7. Runner — PHASE A (owner decision 13 Nov 14:55 IST) — AI (~2 h), NEW service, nothing else changes
Goal: the UI shows agents "talking" live, every message = a real step. Pre-issued invoices only (Phase A); live per-run issuance is Phase B (§S-7B).
- New folder `services/runner/`, port **8774**, binds 127.0.0.1, same Origin rule as signer/bridge (P8), reuses `services/shared/`. **No change to the contract, signer or bridge.**
- `GET /health`; `GET /invoices` → issued invoices from the evidence with their live NEAR status (`get_invoice`), marking which are **runnable** (registered-or-unregistered and not paid/pending/rejected).
- `POST /run {said?, text?}` → `runId`. `said` picks an issued invoice; `text` (request box) is parsed deterministically (amount/quantity) and must match an issued unpaid invoice, else an honest `no_match` stop (never invents).
- `GET /runs/:id/events` (SSE). Steps, each emitted as it happens, each with actor → target, text, status and `txUrl` where one exists:
  1. `offer` jupiterSellerAgent → tommyBuyerAgent: invoice no., amount, SAID (from evidence; IPEX grant SAID) — history, no tx
  2. `accept` tommyBuyerAgent → jupiterSellerAgent: IPEX admit ✓, credential held ✓ — history, no tx
  3. `register` vLEI registrar → contract: calls bridge `/register` (skipped with "already registered" if so)
  4. `pay` tommyBuyerAgent → contract: calls signer `/pay`
  5. outcome from the contract: `paid` (within limit) / `payment_pending` → **escalation** to the approver / `payment_refused` (reason verbatim, e.g. "mandate revoked", refund units)
  6. on escalation the run waits; the **user** decides in the UI (signer `/approve` or `/reject`, already existing); runner emits the result (`paid via approved` / `rejected`, refund)
- One run at a time (mutex); a run never retries a payment by itself.
- **Revoke** stays the existing signer `/revoke` (user clicks it in the UI). **Re-enable** needs the contract owner (`set_mandate`, owner-only by design): stays manual `bash scripts/set-mandates.sh`; the owner key is NOT given to any service.
- **Each run consumes one unpaid invoice.** Phase A supply = invoices issued in advance by the owner (vLEI doc §3.3).

**Phase A backend DONE 13 Nov (AI); MANUAL run pending (issue 0005–0007 → export → start runner).** Files: `services/runner/{index,engine,logic}.mjs`, `services/test/runner.test.mjs`. Contract, signer, bridge and `services/shared/*` unchanged (runner has its own small HTTP/SSE layer with the same Origin rule; reuses `shared/http.mjs` `log`/`HttpError`, `shared/near.mjs` `isSaid`, `bridge/rules.mjs` amount parser read-only). Holds no keys.
- Flags: `--port 8774 --config --allow-origin --signer-url http://127.0.0.1:8771 --bridge-url http://127.0.0.1:8772 --evidence --poll-ms 2000 --wait-minutes 15`. Start-up guard: token decimals 6, `get_config`, evidence readable.
- API, escalation, matching and timeout: see **§S-7 Runner API (as built)** below — the single authoritative description.
**Tested by AI 13 Nov:** `npm test` 35/35 (16 runner: parsing, listing, matching, scenes 1/2/2b/4, decision outside the runner, failed approve keeps waiting, bridge refusal → no pay, signer down → error + lock released, no_match, cancel, timeout, HTTP P8, SSE replay with `Last-Event-ID`, decide). Live no-key run (bridge/signer `--no-send`) against the deployed contract: `/health` both up, `/invoices` INV-2026-0003/0004 `paid` (not runnable), `/run` on 0003 → 409, `$120,000` → 0.12 USDC → honest `no_match` (0005 not issued yet), SSE replay, foreign Origin 403.

#### S-7 Runner API (as built 13 Nov, Phase A + Phase B — authoritative; source `services/runner/{index,engine,logic,vlei}.mjs`)
Base `http://127.0.0.1:8774` (binds 127.0.0.1). All non-SSE responses are JSON with `cache-control: no-store`. Two run modes: **`invoice`** (Phase A: pay a pre-issued invoice, steps 1–6) and **`issue`** (Phase B, §S-7B: issue a new vLEI invoice per request, steps 0–10).

**Origin / CORS (P8, same rule as signer/bridge).** `Origin` header present and ≠ `http://127.0.0.1:8765` → **403** `{ok:false, error:"origin not allowed: <origin>"}` (also `Origin: null`). Allowed Origin → `access-control-allow-origin: http://127.0.0.1:8765`, `vary: Origin`. No Origin (curl, scripts) → allowed, no CORS header. `OPTIONS` → **204**, allows methods `GET, POST, OPTIONS`, headers `content-type, last-event-id`, max-age 600.

**Common errors.** 400 `{ok:false, error:"body must be a JSON object"}` · 413 body > 16 KiB · 404 `{ok:false, error:"no route <METHOD> <path>"}` · 503 `{ok:false, error:"evidence not readable at <path> (<code>)"}` (`/invoices`, `/run`) · 500 `{ok:false, error}` (e.g. RPC failure).

**Endpoints**
| Method + path | Success | Errors |
| --- | --- | --- |
| `GET /health` | 200 `{ok:true, service:"runner", contractId, modes:["invoice","issue"], activeRun: null \| {runId, mode, state, said, result, createdAt, events:<count>}, signer:{up, url, keysLoaded?, httpStatus}, bridge:{up, url, keysLoaded?, httpStatus}}` (`keysLoaded` only when that service answered) | — |
| `GET /invoices` | 200 `{ok:true, invoices:[Invoice]}` (evidence order = oldest credential first; live `get_invoice` per SAID) | 503, 500 |
| `GET /preflight` | 200 `{ok, checks:[{name, ok, detail, api}], mandate}` — step 0 alone, read-only; `ok:false` is still 200. Checks in order: `signer`, `bridge` (up **and** key loaded), `near_rpc` (chain_id = testnet), `docker_tsx_shell` (`docker exec tsx_shell true`), `keria` (`docker inspect` → `running` or `running healthy`), `jq`, `vlei_issue_script`, `vlei_exporter`, `export_node` (files exist), `evidence` (readable), `agent_mandate` (exists; **revoked = ok with a note**, the run then shows the contract's refusal) | 501 issue mode not configured |
| `GET /next-invoice[?text=…]` | 200 `{ok:true, invoiceNumber:"INV-2026-0009", highest:{evidence, appconfig, generatedRuns, taskData}, amount?:{ok:true, amountUnits, amount, parsed} \| {ok:false, result:"bad_amount"\|"no_match", error, parsed}, readOnly:true}` — next free number = highest `INV-<year>-NNNN` in the evidence, `legentvLEI/appconfig/*.json`, `appconfig/generated-runs/*.json` and `task-data/<seller>-self-invoice-credential-info*.json` (+1); nothing is written | 501 |
| `POST /run {said}` · `{text}` · `{text, mode:"issue"}` | 200 `{ok:true, runId, eventsUrl:"/runs/<id>/events", mode:"invoice"\|"issue", state:"running"\|"finished", result?}` — `state:"finished"` with `result` `no_match` / `bad_amount` (or `error` if the mandate view fails) is still **200** | 409 `{ok:false, error:"a run is already active", activeRunId}` (checked first, after only the SAID-format 400) · 409 `{ok:false, error:"<INV> is <status>, it cannot be run again", invoice:Invoice}` · 404 `{ok:false, error:"no issued invoice with this SAID in the evidence"}` · 400 `"said must be a SAID string"` / `"give said or text"` / `"text must be a string of at most 500 characters"` / `'mode must be "invoice" or "issue"'` / `'mode "issue" creates a new invoice: send {text, mode:"issue"} without said'` · 501 issue mode not configured |
| `GET /runs/:id` | 200 `{ok:true, runId, mode, state:"running"\|"waiting"\|"finished", said, result?, createdAt, events:[{event:"run"\|"step", ...data}]}` | 404 `"no such run"` |
| `GET /runs/:id/events` | 200 `text/event-stream; charset=utf-8` (see SSE) | 404 JSON `"no such run"` |
| `POST /runs/:id/decide {decision}` | 200 `{runId, ok:true, txUrl, txHash}` (calls signer `/approve` or `/reject`) | 422 `{runId, ok:false, error:<signer/contract error verbatim>, txUrl?}` — run **keeps waiting** · 409 `"run is <state>, not waiting for a decision"` (checked before the decision value) · 409 `"a decision is already being sent"` · 400 `"decision must be approve or reject"` · 404 |
| `POST /runs/:id/cancel` | 200 `{runId, ok:true}` → run finishes `cancelled`, invoice stays `pending` on NEAR | 409 `"run is <state>; only a run waiting for a decision can be cancelled"` · 409 `"a decision is being sent"` · 404 |
`Invoice` = `{said, invoiceNumber, amount:"0.12", amountUnits:"120000", currency:"USDC", realAmount:"120,000 USD", dueDate, payee, status: unregistered|registered|pending|paid|rejected, runnable, reason?}`; `runnable` = amount readable and status not `paid|pending|rejected`; `reason` only when not runnable (`"invoice is paid"`, `"amount: …"`). `said` with `text`: `said` wins.

**Lock and retention.** One run at a time: the lock is held from `POST /run` until `run` finished (also while waiting for a decision). A run never retries a payment. The last 20 runs are kept in memory (finished ones pruned first); older run ids → 404. Restarting the runner forgets all runs (on-chain state is unaffected).

**SSE `GET /runs/:id/events`.** First line `retry: 3000`. Each event: `id: <seq>` · `event: run|step` · `data: <one-line JSON>` · blank line. All past events are replayed on connect; `Last-Event-ID: <n>` replays only `seq > n`. Comment `: ping` every 15 s. The stream **stays open** after the run finished — the client closes it on `event: run` with `state:"finished"`. `seq` is unique per event (1, 2, 3 … per run): a step that changes status arrives as a **new event with the same `step` name** (e.g. `register` `running` then `done`), so rows are keyed by `step` (+ `decision` may arrive `failed` then `done`), not by `seq`.

**Event `run` — started** (always `seq:1`):
```json
{"runId":"run-…","seq":1,"ts":"2026-11-13T…Z","state":"started","mode":"invoice|issue",
 "steps":["offer","accept","register","pay","outcome","decision"],
 "said":"E…|null",
 "invoice":{ /* Invoice — mode invoice only */ },
 "planned":{"invoiceNumber":"INV-2026-0009","amount":"0.084","amountUnits":"84000","currency":"USDC","description":"Cotton t-shirts, 8,000 pcs (demo scale 1:1,000,000; real 84,000.00 USD)"},
 "mandate":{"account":"chainaim-tommy-buyer-agent.testnet","limitUnits":"100000","limit":"0.1","revoked":false,"approver":"chainaim-tommy-cpo.testnet"},
 "request":{"text":"…","parsed":{"text":"…","invoiceNumber?":"INV-2026-0005","amountUnits?":"120000","amount?":"0.12","amountSource?":"$120,000","amountKind?":"token|real","demoScale?":1000000,"amountError?":"…","quantity?":8000,"item?":"t-shirts"}}}
```
`steps` = the plan of this mode: `invoice` → the 6 names above; `issue` → `["preflight","request","verify_buyer","issue","offer","verify_seller","accept","register","pay","outcome","decision"]` (S-7C; `preflight` appears as an event only when it fails). `request` only for `{text}` runs. Mode `invoice`: `invoice` + `mandate` (`null` if the agent has no mandate); on `no_match` `said:null`, no `invoice`/`mandate`. Mode `issue`: `said:null` (the SAID exists only after step 1; later events and `GET /runs/:id` carry it), `planned` (number, amount and line-item description the run will issue) and no `mandate` (step 0 reports it); on `no_amount`/`bad_amount` no `planned`.

**Event `run` — finished** (last event):
```json
{"runId":"run-…","seq":9,"ts":"…","state":"finished","mode":"invoice|issue","said":"E…|null",
 "result":"paid|rejected|refused|register_refused|seller_refused|no_match|no_amount|bad_amount|error|timeout|cancelled",
 "text":"<sentence; contract/bridge/vLEI reason verbatim for refused/register_refused/seller_refused/error>",
 "failedStep?":"preflight|request|verify_buyer|issue|offer|verify_seller|accept|register|pay|outcome",
 "txUrl?":"…","txHash?":"…"}
```
`txUrl` = pay tx for `paid` (within limit) / `refused` / `error` after pay; `txUrl`+`txHash` = decision tx for `paid`/`rejected` decided via `/decide`; none otherwise. `failedStep` names the step that stopped the run (results `error` and `register_refused`). `register_refused` = mode `invoice` only; in mode `issue` a bridge refusal is `error` with `failedStep:"register"` (§S-7B: every failed step → `error`). `no_amount` and `bad_amount` = mode `issue` only (finish before step 0, nothing called); `no_match` = mode `invoice` only.

**Event `step`:**
```json
{"runId":"run-…","seq":4,"ts":"…","step":"register","index":3,
 "status":"running|done|skipped|failed|waiting",
 "actor":{"id":"vlei_registrar","account":"chainaim-vlei-registrar.testnet"},
 "target":{"id":"contract","account":"chainaim-signatory.testnet"},
 "text":"…","history?":true,"txUrl?":"https://testnet.nearblocks.io/txns/<hash>","txHash?":"<hash>",
 "api":{"service":"bridge","method":"POST","path":"http://127.0.0.1:8772/register","httpStatus":200,"ms":4123},
 "data?":{ "raw?":"<verbatim response JSON or stdout tail, key-like lines removed>" }}
```
**`api` proof block (every step event, both modes).** HTTP calls: `{service, method, path, httpStatus, ms}` (on `running` events only `{service, method, path}`). Processes: `{service:"vlei"|"docker"|"shell", cmd, exitCode, ms, timedOut?}`. Reads: `{service:"evidence"|"vlei-task-data"|"fs", method:"read"|"stat", path}`. Contract outcome: `{service:"contract", method:"tx-logs", path:"<contract> EVENT_JSON (from /pay)"}`. Decision by polling: `{service:"near-rpc", method:"view", path:"<contract>.get_invoice (poll every 2000 ms)"}`. `data.raw` = bridge/signer response JSON (pretty) or the last 40 lines of stdout+stderr (ANSI removed); any line containing `bran|passcode|pass_code|secret|salt|privkey|private key|seed phrase|mnemonic` is **dropped** and counted (`[n key-like line(s) removed]`).
Actor/target ids: `jupiterSellerAgent` (account `null`) · `tommyBuyerAgent` (`chainaim-tommy-buyer-agent.testnet`) · `vlei_registrar` (`chainaim-vlei-registrar.testnet`) · `contract` (`chainaim-signatory.testnet`) · `Jupiter_Knitting_Company` (payee `chainaim-jupiter-payee.testnet`) · `Tommy_Chief_Procurement_Officer` (`chainaim-tommy-cpo.testnet`) · Phase B also `runner` and `vlei` (account `null`).

**The 6 steps (mode `invoice`, Phase A)**
| # `index` | `step` | actor → target | events (`status`) | `data` / links |
| --- | --- | --- | --- | --- |
| 1 | `offer` | jupiterSellerAgent → tommyBuyerAgent | `done`, `history:true` (from evidence, no tx) | `{invoiceNumber, amount, amountUnits, currency, said, grantSaid, issuerAid, holderAid, dueDate}` |
| 2 | `accept` | tommyBuyerAgent → jupiterSellerAgent | `done` (admit ✓ and held ✓) or `failed` (run continues; the bridge then refuses), `history:true` | `{admitSuccess, credentialHeld, admitGrantSaid}` |
| 3 | `register` | vlei_registrar → contract | `running` → `done` (tx) · `skipped` ("Already registered on NEAR") · `failed` ("Bridge refused: <reason>") → run `register_refused` | `{checks:[{rule, ok, detail}]}` on done/skipped/failed |
| 4 | `pay` | tommyBuyerAgent → contract | `running` → `done` (tx) · `failed` ("Payment not sent: <error>") → run `error` | — |
| 5 | `outcome` | contract → Jupiter_Knitting_Company · Tommy_Chief_Procurement_Officer · tommyBuyerAgent | `done` (paid, target payee) → run `paid` · `waiting` (pending, target CPO) · `failed` (refused, target agent) → run `refused` · `failed` "No contract outcome in the transaction logs" (no data) → run `error` | pay tx; `{event:"paid", via:"within_limit", amountUnits}` · `{event:"payment_pending", limitUnits, approver, amountUnits}` · `{event:"payment_refused", reason, refundedUnits}` |
| 6 | `decision` | Tommy_Chief_Procurement_Officer → contract | `failed` ("<decision> not applied: <error>; still waiting") — may repeat · `done` → run `paid` / `rejected` | `{decision:"approve", event:"paid", via:"approved"}` · `{decision:"reject", event:"payment_rejected", refunded:true}`; tx link only when decided via `/decide` |

**Escalation (step 5 `waiting` → step 6).** The run state becomes `waiting`. It resolves by (a) `POST /runs/:id/decide` → signer `/approve|/reject` → `decision` `done` with `txUrl`/`txHash`; or (b) polling `get_invoice` every `--poll-ms` (default 2000 ms) — a decision made elsewhere (UI → signer directly) gives `decision` `done` **without** a tx link and text "… (decided outside the runner)"; polling is ignored while a `/decide` call is in flight. **Timeout:** `--wait-minutes` (default **15**) → run `timeout` ("No decision within 15 min; the invoice stays pending on NEAR"), lock released. `/cancel` → run `cancelled` (same: invoice stays pending, can still be approved/rejected via the signer).

**Matching (`{text}`, deterministic, never invents).** Parse: invoice number `INV-YYYY-NNNN` (case-insensitive); token amount `<n> USDC`; else real amount `$<n>` or `<n> USD` (commas allowed) → units = real × 10⁶ ÷ `demoScale` (config, now 1,000,000) and must be exact, else `amountError`; `<n> USDC` with > 6 decimals → `amountError`; quantity = first `<n> <word>` that is not a currency or a time word (`day(s)`, `week(s)`, `month(s)`, `year(s)`, `hour(s)`, `minute(s)`, `min(s)`, `percent`, `pct`) and not part of the amount — **reported only**, never used to match (demo invoices are quantity 1). Match order: (1) invoice number → that invoice; refused if not issued, not runnable, or the text's amount differs; (2) else `amountError` → `no_match`; (3) else no amount → `no_match` ("names no amount or invoice number"); (4) else the **first runnable** invoice (evidence order) with exactly those units, else `no_match` ("No issued unpaid invoice for <amount> USDC — issue one first"). Every `no_match` text ends with `Runnable: <list or none>`.

**The steps of mode `issue` (Phase B in the S-7C business order — `POST /run {text, mode:"issue"}`; `index` = 0…10).** Each `running` event is followed by one final event for the same `step`. Any `failed` step finishes the run at once (`error`, or `seller_refused` at `verify_buyer`) with `failedStep` — nothing later runs: no invoice is issued after a failed buyer check, no money moves after a failed vLEI check. **Every step's `api` carries `orchestrator:"runner (no keys)"`; the runner is never the actor, except in a failed `preflight`.**
| `index` | `step` | actor → target | `api` | `done` when / `data` |
| --- | --- | --- | --- | --- |
| 0 | `preflight` | `runner` → `runner` | `{service:"runner", method:"GET", path:"/preflight", ms}` | **emitted only when it FAILS** (red, never hidden): text lists the failing checks + "nothing requested, nothing issued" · `data:{checks[]}`. When it passes, its result is inside `request` |
| 1 | `request` | `tommyBuyerAgent` → `jupiterSellerAgent` | `{service:"runner", method:"GET", path:"/preflight + /next-invoice", ms}` | single `done` event · text "Request: <qty> <item>, real total <USD> → <USDC> on NEAR (unsigned request)" (+ revoked note) · `data:{signed:false, label:"unsigned request", item, quantity, realTotal, amount, amountUnits, currency, description, nextInvoiceNumber, nextInvoiceSources, preflight:{ok, ms, checks[]}, mandate}` |
| 2 | `verify_buyer` | `jupiterSellerAgent` → `tommyBuyerAgent` | `{service:"vlei", cmd:"\"<export-node>\" export-signatory-evidence.js --strict --out <services/runner/.work/verify-buyer-<runId>.json>", exitCode, ms, timedOut?}` (existing exporter, BEFORE issue; work file read then deleted; UI evidence untouched) | exporter exit 0 **and** buyer chain verified · `data:{agent, agentAid, delegationVerified, officer, officerAid, officerOorSaid, legalEntity, lei, leAid, qviAid, links:[{link, verified, how, checked?}], raw}`. Failed → run `seller_refused`, text **"seller refused: buyer not verified — <reason>"**, NO invoice |
| 3 | `issue` | `jupiterSellerAgent` → `vlei` | `{service:"vlei", cmd:"bash issue-additional-invoice.sh --invoice-config ./appconfig/generated-runs/invoiceConfig-run-<INV>.json", exitCode, ms, timedOut?}` (cwd `legentvLEI`, timeout `--issue-timeout-s` 360) | exit 0 **and** `✓ <INV> (<SAID>) issued, granted, admitted and held` with the planned number · `data:{invoiceNumber, said, configFile, description, raw}`; config written first (never overwritten) |
| 4 | `offer` | `jupiterSellerAgent` → `tommyBuyerAgent` | `{service:"vlei-task-data", method:"read", path:"…/task-data/jupiterSellerAgent-ipex-grant-info.<SAID>.json"}` | grant file for this SAID has `grantResult.said` · `data:{invoiceNumber, amount, amountUnits, currency, said, grantSaid, grantedAt}` (the admit itself ran inside the issue script; proven in `accept`) |
| 5 | `verify_seller` | `tommyBuyerAgent` → `jupiterSellerAgent` | `{service:"vlei", cmd:"\"<export-node>\" export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json", exitCode, ms, timedOut?}` (**the export runs inside this step**; timeout `--export-timeout-s` 120) | export exit 0 + `All checks passed.` + new SAID in the evidence; seller chain verified; invoice `issuerAid` = seller agent, `issuerDelegatedFrom` = its officer + OOR; `issuanceVerified` · `data:{…same chain fields as verify_buyer, issuerMatches, issuanceVerified, issuanceAnchor, export:{exitCode, ms, allChecksPassed, generatedAt, invoices}, raw}` |
| 6 | `accept` | `tommyBuyerAgent` → `jupiterSellerAgent` | `{service:"evidence", method:"read", path}` | `ipex.admitSuccess`, `credentialHeld`, invoice `holderAid` = the verified buyer AID · `data:{admitSuccess, credentialHeld, admitGrantSaid, grantSaid, holderMatches}` |
| 7–10 | `register`, `pay`, `outcome`, `decision` | as mode `invoice` (steps 3–6 above) | as mode `invoice` | as mode `invoice`, except a bridge refusal → `error` + `failedStep:"register"` |
Step id changes vs S-7B: `request` added; `export` removed (its process and output are inside `verify_seller`); `verify_buyer` moved from 5 to 2; `preflight` only appears on failure. Results add `seller_refused` (mode `issue`).

**Amount rules (mode `issue`, checked before step 0 — nothing is called on refusal).** Amount as in Matching (`$<n>` / `<n> USD` ÷ `demoScale`, or `<n> USDC`; exact). No amount → `no_amount` ("No amount given: …"); inexact / > 6 decimals → `bad_amount`; < 0.0001 USDC (100 units, vLEI float guard) → `bad_amount`; > `--max-amount` (default **0.25** = the CPO limit) → `bad_amount`. The item phrase and quantity (up to 5 words after the number, stopping at punctuation or `total|for|at|worth|about|deliver|by|in|with|of|and|to|per|each|usd|usdc|please`) go only into the line-item **description**: `"<Item>, <qty> pcs (demo scale 1:1,000,000; real <total> USD)"`, or `"Order (…)"` without an item; the invoice numbers stay quantity 1, unitPrice = amount = totalAmount. The 10 built-in prompts of §S-7B are unit-tested to give exactly the amounts/stops in that table.

**Phase B flags (runner):** `--vlei-dir` (default `../legentvLEI`) · `--export-node` (default `/mnt/c/Program Files/nodejs/node.exe`, G-42) · `--issue-timeout-s 360` · `--export-timeout-s 120` · `--max-amount 0.25` · `--invoice-template appconfig/invoiceConfig-near-2.json` · `--invoice-year 2026` · `--keria-container keria` · `--shell-container tsx_shell`. The next invoice number is computed at `POST /run` (for `planned`) and again just before writing the config. On a timeout the process gets SIGTERM, then SIGKILL after 3 s.

### S-7B. Runner — PHASE B: a new vLEI invoice per request, live verification, per-step proof (owner decision 13 Nov 16:12 IST, Option A) — AI (~4–5 h)
Goal: one buyer request = one brand-new invoice issued by the seller agent (vLEI), verified both ways live, registered on NEAR, paid / escalated / refused — every step a chat bubble with the proof of its API call. Phase A (`POST /run {said}` on pre-issued invoices) keeps working.

**Option A (decided):** the runner (WSL Ubuntu) calls the vLEI scripts directly; Docker Desktop "WSL integration" is switched on for Ubuntu (MANUAL setting). Scripts are LF (V-READ 16:12) and need `jq` in Ubuntu (MANUAL `sudo apt install -y jq`). vLEI scripts are called, never edited.

**Steps of one Phase B run** (`POST /run {text, mode:"issue"}`; each step = one SSE `step` event, keyed by `runId`+`step`; each event carries `api {service, method, path|cmd, httpStatus|exitCode, ms}` and the verbatim response/stdout tail in `data.raw` with any BRAN/key-like line stripped):
| # | step | actor → target | API / tool | done when |
|---|---|---|---|---|
| 0 | `preflight` | runner → all | `GET /health` signer 8771, bridge 8772; NEAR RPC `status`; `docker exec tsx_shell true`; KERIA reachable (via the vLEI read-only diagnose task or `docker ps` healthy); evidence readable; agent mandate not revoked (else continue: the run must show the refusal) | all ok, else run stops before issuing |
| 1 | `issue` | jupiterSellerAgent → (vLEI) | writes `legentvLEI/appconfig/generated-runs/invoiceConfig-run-<INV>.json` (next free `INV-2026-NNNN`, amount from the request, quantity 1, unitPrice = amount, every number ≥ 0.0001, same parties/payee/chain as near-2), then `bash issue-additional-invoice.sh --invoice-config <file>` (cwd `legentvLEI`, timeout 6 min) | stdout "issued, granted, admitted and held"; credential SAID parsed |
| 2 | `offer` | jupiterSellerAgent → tommyBuyerAgent | from step 1 output: IPEX grant SAID | grant SAID present |
| 3 | `export` | runner → (vLEI) | **Windows** `node.exe` (flag `--export-node`, default `/mnt/c/Program Files/nodejs/node.exe`) `export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json` (cwd `legentvLEI`, timeout 2 min). Ubuntu node is NOT used here: G-42 measured 9.2 s per OOBI via the WSL localhost bridge (exporter times out) vs 0.02 s from Windows | "All checks passed." + new invoice present |
| 4 | `verify_seller` | tommyBuyerAgent → jupiterSellerAgent | from the fresh export: seller agent `delegationVerified` (live KEL), delegated from `Jupiter_Chief_Sales_Officer` with OOR SAID, invoice `issuanceVerified` (TEL iss anchored in seller KEL) | all true → UI seller panel ✓ |
| 5 | `verify_buyer` | jupiterSellerAgent → tommyBuyerAgent | from the fresh export: buyer agent `delegationVerified`, delegated from `Tommy_Chief_Procurement_Officer` with OOR SAID | true → UI buyer panel ✓ |
| 6 | `accept` | tommyBuyerAgent → jupiterSellerAgent | from the fresh export: `ipex.admitSuccess`, `credentialHeld` | both true |
| 7 | `register` | vlei_registrar → contract | bridge `POST /register {said}` (bridge must see the new evidence, see below) | `ok:true`, tx |
| 8 | `pay` | tommyBuyerAgent → contract | signer `POST /pay {said}` | tx |
| 9 | `outcome` | contract → payee / CPO / agent | from `/pay` outcome + `get_invoice` | paid / pending (waiting) / refused (reason, refund) |
| 10 | `decision` | Tommy CPO → contract | `POST /runs/:id/decide` → signer approve/reject | paid via approved / rejected + refund |
Any failed step = red bubble with its `api` block and verbatim error, the run finishes `error` at that step; nothing later runs (no money moves after a failed verification).

**New/changed endpoints:** `GET /preflight` (step 0 alone, for testing); `POST /run {text, mode:"issue"}`; `GET /next-invoice` (shows the number/amount the next run would use, read-only). Concurrency 1; issue+export timeouts; `--vlei-dir`, `--issue-timeout-s`, `--export-timeout-s`, `--max-amount` flags.
**Bridge change (small, the only change outside the runner):** the bridge re-reads the evidence file when its mtime changes (or on `POST /reload`), so a run-issued invoice is found without restarting it. Tested by unit test + live.
→ **NOT NEEDED, bridge unchanged (AI, 13 Nov, owner to confirm):** the S-5 bridge already reads the evidence file on **every** `/check` and `/register` (`loadEvidence()` = `readFileSync` per request, no cache), so a newly exported invoice is found without a restart. **Proven live 13 Nov:** bridge (`--no-send`) started on an evidence copy without INV-2026-0004 → `/check` INV-2026-0004 `found: no invoice …`; the file was replaced by the full export **without restarting** → same process: `ok true, found true`, all rules pass. A cache + `/reload` would only add risk; can be added later if wanted.
**Invoice data from the prompt:** the generated config's line-item `description` = item + quantity + real total parsed from the request (e.g. "Cotton t-shirts, 8,000 pcs (demo scale 1:1,000,000; real 84,000.00 USD)"); numbers stay quantity 1, unitPrice = amount = totalAmount (float rule). Missing amount → honest stop `no_amount` before issuing; amount < 0.0001 or > `--max-amount` (0.25) → `bad_amount` before issuing, no invoice.

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

**Amount rules:** request `$<n>` / `<n> USD` ÷ `demoScale` or `<n> USDC`; must convert exactly, be ≥ 0.0001 and ≤ `--max-amount` (default 0.25, the CPO limit); else `no_match`/`bad_amount` before issuing.
**Standalone test per step** (owner can prove each API alone): 0 `curl :8774/preflight` · 1 run the issue script by hand · 3 run the exporter by hand · 4/5 exporter `--strict --dry-run` (agent lines `KEL-verified: true`, invoice `issuance-verified true`) · 7 `curl :8772/check -d '{"said":…}'` · 8 `curl :8771/pay …` · 9 `node scripts/view.mjs invoice <said>` · 10 `/decide` or signer `/approve` · revoke `curl :8771/revoke …` · health `node scripts/health.mjs --stage all`.
**Acceptance B1** request $84,000 → new INV issued, both verifications ✓, registered, paid (≈2–3 min) · **B2** $157,500 → pending → user Approve → paid · **B3** $120,000 → pending → user Reject → refunded · **B4** after Turn off agent → new invoice issued and verified, pay refused + refund · **B5** stop the bridge → preflight fails, no invoice issued · **B6** amount 0.00001 → refused before issuing · **B7** every bubble shows its `api` block; no BRAN/key text anywhere (grep).

**S-7C BUILT 13 Nov (AI, `PROCEED TO CHANGE S-7C`, business-order flow) — supersedes the S-7B step order below; full API in §S-7 Runner API.**
New order of a mode-`issue` run (index · step · actor → target · what really runs):
| # | step | actor → target | real check / call |
|---|---|---|---|
| 0 | `preflight` (event **only if it fails**) | runner → runner | signer/bridge `/health` (+ key loaded), NEAR RPC `status`, `docker exec tsx_shell true`, `docker inspect keria`, `jq`, vLEI files, `node.exe`, evidence, `get_mandate` |
| 1 | `request` | tommyBuyerAgent → jupiterSellerAgent | preflight result (all checks + ms) + next free invoice number; `signed:false`, "unsigned request" |
| 2 | `verify_buyer` | jupiterSellerAgent → tommyBuyerAgent | existing exporter `--strict --out <runner work file>` **before issue**; fail → `seller_refused` "seller refused: buyer not verified", **no invoice** |
| 3 | `issue` | jupiterSellerAgent → vlei | existing `issue-additional-invoice.sh` |
| 4 | `offer` | jupiterSellerAgent → tommyBuyerAgent | grant file of the new SAID |
| 5 | `verify_seller` | tommyBuyerAgent → jupiterSellerAgent | existing exporter `--strict --out ../UI/data/signatory-evidence.json` (export inside this step) + seller chain + issuance |
| 6 | `accept` | tommyBuyerAgent → jupiterSellerAgent | admit + held + holder = verified buyer |
| 7–10 | `register` · `pay` · `outcome` · `decision` | unchanged | bridge `/register` · signer `/pay` · contract events · `/decide` |
Every step's `api.orchestrator = "runner (no keys)"`; the runner is the actor only in a failed `preflight`. Files: `services/runner/{engine,index,vlei}.mjs`, tests; `services/.gitignore` += `runner/.work/`. Unchanged: contract, signer, bridge, `services/shared/*`, every vLEI script.
**V-READ (13 Nov, `legentvLEI/export-signatory-evidence.js` code):** the exporter verifies identities from current task-data + live KELs **without needing a new invoice** (existing invoices must still pass strict). Per link of the buyer chain:
- agent → OOR officer: **verified live** — agent and officer KELs fetched from their OOBI URLs on KERIA; agent inception is `dip` with `di` = officer AID and the officer's KEL anchors a seal for the agent (`checkDelegation`). **Event structure only: the exporter does not re-verify KEL signatures** (it trusts KERIA's OOBI stream).
- officer holds an OOR issued by the QVI: **record check** — task-data OOR credential record issuee = officer AID, issuer = QVI AID; not a credential-signature / TEL check.
- officer → Legal Entity: **config** — officer listed under that LE in the 4D config; LE AID from task-data.
- Legal Entity → QVI: **NOT CHECKED** by the exporter (no LE credential check). Reported as `verified:false, checked:false` in `verify_buyer.data.links` and in the step text; never shown as a pass. The same gap applies to `verify_seller`.
**ASSUMED:** none in the runner path (every step calls the real script / service / view). Not in scope: LE-credential and KEL-signature verification (would need a vLEI-side change).
**Tested by AI 13 Nov:** `npm test` **64/64** (B1 in the new order with indexes 1–9 and no preflight event; every event `orchestrator` = "runner (no keys)" and no runner actor; `request` data (unsigned, item, quantity, real total, preflight, next number); `verify_buyer` links; **verify_buyer failing 3 ways (delegation, exporter timeout, OOR issuer) → `seller_refused`, calls = preflight + verify_buyer only, no config / issue / export / NEAR**; failed preflight shown as a red step; export failure now `failedStep:"verify_seller"`; all 10 scenario rows; Phase A unchanged). The real-folder number test now checks "highest + 1" (0009/0010 were issued in the meantime).
**LIVE testnet run 13 Nov 14:03 UTC (AI; owner's signer + bridge with keys, runner restarted by AI with the S-7C code; scenario #1 "Need 8,000 cotton t-shirts, total $84,000"):** run `run-mwf1rckc-1` → **`paid`** in 28.4 s:
| +s | # | step | actor → target | proof |
|---|---|---|---|---|
| 0.8 | 1 | request | tommyBuyerAgent → jupiterSellerAgent | preflight 697 ms, next INV-2026-0011, 0.084 USDC, unsigned |
| 1.3 | 2 | verify_buyer | jupiterSellerAgent → tommyBuyerAgent | exporter exit 0, 506 ms; delegated from Tommy_Chief_Procurement_Officer, OOR `EPGQCVCJ…`, LE TOMMY HILFIGER EUROPE B.V. (LEI 54930012QJWZMYHNJW95); LE→QVI not checked |
| 16.5 | 3 | issue | jupiterSellerAgent → vlei | script exit 0, 15 184 ms; INV-2026-0011 = `EBOSeRIt7qckoFAyriyKbuoEQk5xSdMP5jjmHf-yIc53` |
| 16.6 | 4 | offer | jupiterSellerAgent → tommyBuyerAgent | IPEX grant `EHJCvRjVR7S08zIozbvSzbe2tavAOxXSIwq7c0AnQfvc` |
| 17.1 | 5 | verify_seller | tommyBuyerAgent → jupiterSellerAgent | strict export exit 0, 468 ms, 9 invoices, all checks passed; issuance anchored in seller KEL |
| 17.1 | 6 | accept | tommyBuyerAgent → jupiterSellerAgent | admit ✓ held ✓ |
| 21.6 | 7 | register | vlei_registrar → contract | HTTP 200, 4 508 ms, tx `EJH5Zjdj2mLA5VfrZJgqGGdaRWBsjE5w5HMXxmmWbfa3` |
| 28.4 | 8 | pay | tommyBuyerAgent → contract | HTTP 200, 6 789 ms, tx **`9iLjmeGmDH4WWdTX83iyCubAr1J2RYodu1r3AAiM9Zg2`** |
| 28.4 | 9 | outcome | contract → Jupiter_Knitting_Company | `paid` within limit, 0.084 USDC forwarded |
Cross-checked read-only: `get_invoice` = `paid`, payer `chainaim-tommy-buyer-agent.testnet`; contract events #21 `invoice_registered`, #22 `paid within_limit`; payee 0.751 USDC; 0 key-like words in the run JSON; runner work folder empty after the run.

**S-7B DONE 13 Nov (AI); MANUAL B1–B7 pending.** Files: `services/runner/vlei.mjs` (new: next number, config writer, process runner with timeouts, preflight, issue-output parser, grant reader, redaction), `services/runner/{engine,index,logic}.mjs` (Phase B steps 0–10, `api` block on every step in both modes, `GET /preflight`, `GET /next-invoice`, `POST /run {text, mode:"issue"}`, flags), `services/test/runner-issue.test.mjs` (new). **Unchanged:** contract, signer, bridge, `services/shared/*`, every vLEI script (called, never edited). Full API: §S-7 Runner API (as built).
- Phase A unchanged in behaviour (same steps, texts, indexes, results); additive only: `mode`, `steps`, `api`, `data.raw`, `failedStep`. Phase A tests now use a fixture reduced to INV-2026-0003/0004 (the live export grows with every invoice).
- Prompt rules implemented as in the two paragraphs above: description = item + quantity + real total from the prompt; `no_amount`; `bad_amount` for < 0.0001 or > `--max-amount` 0.25.
**Tested by AI 13 Nov:** `npm test` **63/63** — incl. **one test per built-in scenario row (#1–#10)**: on-chain amount exactly as the table (0.084 · 0.05 · 0.1 · 0.1575 · 0.12 · 0.24 · 0.3→`bad_amount` · 0.042 · 0.00005→`bad_amount` · none→`no_amount`), item + quantity, the generated config's line item (`description` from the prompt, `quantity 1`, `unitPrice = amount = totalAmount`), and for the 3 stop rows: run ends before step 0 with nothing called (no config, no vLEI script, no NEAR call) (Phase B: redaction drops BRAN-like lines; real success line parsed with ANSI colours; exact JSON amounts; next number over the 4 sources; **read-only scan of the real `legentvLEI` → `INV-2026-0009`** (highest 0008 in generated-runs / task-data / evidence); config = template + only number/amount/dates/item/ref, never overwritten; preflight pass/fail rules; B1 paid with indexes 0–10 and an `api` on every event; B2 approve / B3 reject; B4 revoked → issued + verified + refused; B5 preflight fail → nothing issued; B6 min/max/none/inexact refused before anything; stop-on-failure at issue (exit 1, timeout), export, verify_seller (no register/pay); the 10 built-in prompts; HTTP `/preflight`, `/next-invoice`, `/run` issue, 501 when not configured). **Live, no keys** (signer/bridge `--no-send`, real vLEI folder, live contract): `/next-invoice?text=about $84,000` → `INV-2026-0009`, 0.084; `/preflight` → near_rpc, `docker exec tsx_shell true`, keria `running healthy`, jq 1.8.1, issue script, exporter, `node.exe`, evidence (6 invoices), mandate (0.1, not revoked) all PASS, only signer/bridge FAIL "started without keys" (correct); `POST /run {mode:"issue"}` → stopped at step 0 "— nothing issued"; `0.00001 USDC` → `bad_amount`; `generated-runs/` still only the G-42 file; no key-like word in any service log. **Not yet run:** a real issue/export through the runner (B1–B7, MANUAL).

### S-8. Advisors — AI (~1 h, optional, cut first)
`POST /ask {agent, question}` → chainaim-private-ai attested NEAR AI route → mapped to the `job_attested` shape (G-31: `JobAttestation`, badge only when `summary === "verified"`; return the private-ai fields as they are, never synthesize them; unreachable → `not attested / advisors not reachable`). Advisory only: no payment path.

### S-9. Ship — (~3–4 h)
| Item | Who |
| --- | --- |
| Full rehearsal from a clean state (export → services → 4 scenes in the UI) | MANUAL |
| `README.md` (what, why NEAR, judge path: open UI, verify in browser, open tx links; run steps) | AI |
| `HACKATHON-DISCLOSURE.md` (real vs demo-scale, test token, what is not built; **note S-2a #4**: revoking an agent does not cancel a payment it already left `pending` — the approver can still approve or reject it; sandbox test deferred, testnet E2E instead) | AI draft, MANUAL review |
| `docs/video-script.md` (~2 min, 4 scenes) + Entry A script (~1 min) | AI |
| Record videos, submit both entries on nearhackathon.com | MANUAL |
| Commit/push (deferred; D-04 first) | MANUAL |

---

## 5. Dependencies

```
G-40 tools · G-38 ─ S-1 accounts ─ S-2 contract ─ S-3 deploy ─ S-4 signer ─┐
vLEI G-34 (=G-41)/G-36/G-32 ✓ 12:52 ──────────────────── S-5 bridge ──────┼─ S-6 E2E ─ UI-2 ─ S-7 runner ─ UI-2R
                                                   S-8 advisors ───┴─ UI-3 (optional) ─ S-9 ship
```
Core for Entry B: S-1..S-6 + UI-2 (scenes 1, 2, 4 on real NEAR). Cut order if late: S-8/UI-3, then S-7/UI-2R.

---

## 6. Acceptance (Signatory part)

**Status 13 Nov (S-6 run, table in §S-6):** P1 ✅ unit tests 43/43 + live private-callback check passed (`on_pay_forward` `A1AHCD…`, `on_settle` `3z71sV…` both "Method … is private", state unchanged) · P2 ✅ `EhENXV…` · P3 ◐ pending `BFaZCF…` → approve → paid `8uLtun…`; reject live test deferred to INV-2026-0005 (final rebuild) · P4 ✅ `BQ8zFt…` `payment_refused` "mandate revoked", 84000 units refunded · P5 ✅ tamper refused, `sent:false`, nothing sent · P6 ◐ unit-tested only (not live) · P7, P8 not yet checked live (P8 unit-tested).

P1 contract unit tests pass (`cargo test`; sandbox test deferred, owner 13 Nov) · P2 scene 1 paid on testnet (tx link) · P3 scene 2 pending → approve → paid; reject → refunded · P4 revoke → pay refused with the contract's `payment_refused` reason (from the tx event log) and the amount back with the agent · P5 tamper → bridge refuses, contract unchanged · P6 bridge refuses an evidence copy with `admitSuccess:false` (R-IPEX) · P7 no key material in any service response, log or the UI (grep) · P8 services refuse requests that carry an `Origin` other than `http://127.0.0.1:8765`. Requests with no `Origin` header (runner → bridge/signer, `scripts/health`, curl) are allowed only because every service binds to 127.0.0.1. Without that rule the runner could not call the bridge or the signer.
