# Signatory — private AI decides, signed credentials prove, NEAR enforces

Signatory is a B2B payment demo for the NEAR hackathon. A buyer types a purchase request in a chat. The seller's AI agent issues a **signed vLEI invoice credential**. Both companies' identity chains are **verified live** (KERI / vLEI). The invoice is **registered on NEAR**, and a NEAR smart contract **enforces each agent's spending mandate**: it pays within the limit, escalates to a human officer above it, and refuses when the agent is turned off.

- **Buyer:** Tommy Hilfiger Europe B.V. (LEI `54930012QJWZMYHNJW95`)
- **Seller:** Jupiter Knitting Company (LEI `3358004DXAMRWRUIYJ05`)
- **Network:** NEAR testnet, contract `chainaim-signatory-v2.testnet` (v1 `chainaim-signatory.testnet` kept for its history), Circle testnet USDC (6 decimals)
- **Demo scale:** real USD ÷ 1,000,000 = on-chain USDC (e.g. a $84,000 order = 0.084 USDC)

---

## 1. Verify it without running anything (2 minutes)

Every step below ran live on NEAR testnet. Open the links:

| Scenario | What happened | Transaction |
|---|---|---|
| Register invoice | vLEI invoice INV-2026-0003 registered by the registrar after IPEX checks | [3RaUB3Fe…](https://testnet.nearblocks.io/txns/3RaUB3FeYP3rGVLPFnPZomSL7XTVqQknR3Jx6qdYbfza) |
| Within limit → paid | Buyer agent pays 0.084 USDC (limit 0.10) | [EhENXVWQ…](https://testnet.nearblocks.io/txns/EhENXVWQsV8jwRb7kJfxdHhzgdF6GZfcHYGeKcRa9f9n) |
| Register invoice 2 | INV-2026-0004 (0.1575 USDC) registered | [FefFaaGR…](https://testnet.nearblocks.io/txns/FefFaaGRd3QZM7s2Tkfm3ArrVi3AVWJANS5USpiy3ade) |
| Above limit → pending | Agent limit exceeded, payment held for the CPO | [BFaZCF3i…](https://testnet.nearblocks.io/txns/BFaZCF3ib3vD61rcopqxiQbZFVyuQFcN2v7s8LNQ2Vqp) |
| CPO approves → paid | Human officer approves, contract forwards funds | [8uLtun7V…](https://testnet.nearblocks.io/txns/8uLtun7VBaUbiaKiQ3jaUUAbzuMx1oUo5A15WfzbAyYB) |
| Agent turned off | Mandate revoked | [7kHEn3EQ…](https://testnet.nearblocks.io/txns/7kHEn3EQ6afdbdF2hhEvpgEWY1DhbYUs5BRwFhTvUfJE) |
| Pay after revoke → refused | Contract refuses ("mandate revoked") and refunds the agent | [BQ8zFtd2…](https://testnet.nearblocks.io/txns/BQ8zFtd2mGGUQqPSUmCDBdNCtXCteK9uqpNhP2S2giAM) |
| Private callbacks | Outside calls to `on_pay_forward` / `on_settle` fail, state unchanged | [A1AHCDVD…](https://testnet.nearblocks.io/txns/A1AHCDVDv1MG2in33wEs1Xh7YqDFfQ4PK4FssbCYCrKx) · [3z71sVDF…](https://testnet.nearblocks.io/txns/3z71sVDFGDkB8xpx16xZbYqsCdhYDgXF7skKg9HqcCuB) |
| Tampered invoice | Bridge recomputes the SAID, refuses, nothing is sent to NEAR | (no transaction, by design) |

**v2 contract `chainaim-signatory-v2.testnet` (14 Nov): privacy commitment + AP2 receipts**

| Scenario | What happened | Transaction |
|---|---|---|
| Register, commitment only | INV-2026-0017: only the SAID and a sha256 commitment go on-chain (no amount, payee, LEIs or due date) | [GT76nPkn…](https://testnet.nearblocks.io/txns/GT76nPknkDqsUhfapD7UjGa6JAjfcM64nKdjSLeJpnEx) |
| Reveal at payment → paid | The agent reveals payee + salt; the contract recomputes the commitment, then pays 0.084 USDC | [HYvGfyVe…](https://testnet.nearblocks.io/txns/HYvGfyVegUCsP2NUzSxjmfA36t7MgYx3LVUVBVX4Yip2) |
| AP2 register | INV-2026-0019: Jupiter-signed UCP checkout (AP2 merchant_authorization, ES256) bound into the commitment | [5GdwhLVP…](https://testnet.nearblocks.io/txns/5GdwhLVPTSsEJRcowFFRdkXe5C4R5gT65ckgXv45xLTQ) |
| AP2 pay with receipt hash | Buyer agent pays under its signed payment mandate; the `paid` event carries the receipt hash of checkout + mandate | [58GabUaT…](https://testnet.nearblocks.io/txns/58GabUaTVTWuXDCSDfXRhpS4iKZdee8kLrB8U5MuXyCP) |

Read-only views of the live contract (no keys needed, Windows or WSL, Node ≥ 22):

```bash
cd chainaim-signatory
node scripts/view.mjs snapshot          # invoices, mandates, balances, events — one line each
node scripts/view.mjs invoice INV3      # one invoice
node scripts/view.mjs events            # contract event log (NEP-297)
```

---

## 2. How it works

```
 Buyer types a request in the chat UI (127.0.0.1:8765)
        │
        ▼
 Runner (8774) ── issue ──► vLEI stack (KERIA, Docker): seller agent issues invoice ACDC,
        │                    IPEX grant ─► buyer agent admits ─► credential held
        │── export ──► evidence file (KEL, delegation chain, TEL issuance, IPEX result)
        │── verify ──► seller chain and buyer chain checked (agent → OOR officer → LE → QVI)
        ▼
 Bridge (8772, registrar key) ── rule R-IPEX ──► register_invoice on NEAR
        ▼
 Signer (8771, agent + CPO keys) ── ft_transfer_call USDC ──► contract checks the mandate
        ├─ amount ≤ agent limit ............ paid to the seller's payee
        ├─ above limit, ≤ CPO limit ........ pending → human Approve / Reject in the chat
        └─ agent revoked / above authority . refused + refund
```

**Identity ladder (each company):** sub-agents → NEAR-acting agent → OOR officer (CPO / CSO) → Legal Entity → QVI → GLEIF. Each AI agent is a KERI-delegated identifier of a human officer, so every invoice and payment traces back to a person with an Official Organizational Role.

**Rule R-IPEX (bridge):** an invoice is registered only if the strict checks pass, the grant carries the invoice SAID, the admit succeeded and the credential is held, the issuer is the seller agent delegated from an OOR officer, the chain is `near:testnet`, and the payee matches `config/accounts.json`.

**Mandates on NEAR (`config/accounts.json`):** buyer agent limit 0.10 USDC (approver: CPO); CPO limit 0.25 USDC (approver: contract owner). Limits are inclusive.

---

## 3. Repository map

| Path | What it is |
|---|---|
| `chainaim-signatory/contract/` | Rust NEAR contract (near-sdk 5.30.1), 48 unit tests (`cargo test`) |
| `chainaim-signatory/services/` | Node services: `signer/` (8771), `bridge/` (8772), `runner/` (8774), `shared/` (commitment, AP2), `test/` (116 tests, `npm test`, frozen evidence fixture); `data/` (purchase orders N1–N4 + DD5 data, change #4) |
| `chainaim-signatory/scripts/` | **`signatory.sh` (setup / start / stop — the only command you need)**, plus `deploy.sh`, `set-mandates.sh`, `health.mjs`, `view.mjs`, `ap2-keys.mjs` |
| `chainaim-signatory/config/` | `signatory.json` (network, contract, ports), `accounts.json` (accounts + mandates) |
| `UI/` | `Agent Escalation Console.html` (the chat UI), `serve.mjs` (static server), `data/` (evidence + accounts, no secrets) |
| `legentvLEI/` | vLEI / KERI stack (KERIA, witnesses, schema server in Docker), identity scripts, invoice issue + IPEX, `export-signatory-evidence.js` |
| `ARCHITECTURE-*.md`, `chainaim-signatory/ARCHITECTURE-signatory-2026-11-13.md`, `UI/ARCHITECTURE-UI-2026-11-13.md` | Design and build records |

---

## 4. Run it yourself — one script

Everything runs through **one command**, from any folder, in **WSL Ubuntu** (`wsl -d Ubuntu`):

```bash
S=/mnt/c/<path-to>/enh-3-signatory/chainaim-signatory/scripts/signatory.sh
bash $S setup --fresh-vlei   # first time on a PC (≈ 30 min)
bash $S start                # every day (≈ 1 min) — prints the UI link
bash $S stop                 # stop the UI and the services
```

Every mode has `--dry-run` (prints what it would do, changes nothing) and `--help`. The script never reads, prints or copies a key or passcode: it only checks that the files exist.

### 4.1 Prerequisites (once)

- Windows 11 + WSL2 Ubuntu, Docker Desktop with WSL integration for Ubuntu
  (`docker ps` *permission denied* → `sudo usermod -aG docker $USER`, reopen Ubuntu).
- Node.js ≥ 22 in **Ubuntu and Windows** (the evidence export uses Windows `node.exe` for speed), plus `jq` and `curl` in Ubuntu.
- Only to rebuild or redeploy the contract: Rust 1.100 + target `wasm32-unknown-unknown`, `cargo-near` 0.23, `near-cli-rs` 0.31.

### 4.2 Keys (once) — never in git, chat or email

The services sign with these files; `setup` tells you which are missing.

| Key file | Put it at | Used by |
|---|---|---|
| `<buyer agent>.json`, `<CPO>.json`, `<registrar>.json`, `<owner>.json` (account names in `config/accounts.json`) | `~/.near-credentials/testnet/` in WSL (`chmod 600`) | signer (pay, approve, revoke), bridge (register), `set-mandates.sh` (owner) |
| `merchant.pem`, `buyer-agent.pem` | `chainaim-signatory/private/ap2-keys/` (git-ignored) | bridge (AP2 checkout), signer (AP2 payment mandate) |

Either get them from the account owner **in person or encrypted** (and never run live payments from two PCs at the same time), or create your own: testnet accounts with near-cli-rs (legacy keychain), `storage_deposit` on the USDC token for the contract, buyer agent and payee, USDC from [faucet.circle.com](https://faucet.circle.com) (NEAR Testnet), `bash scripts/deploy.sh` + `bash scripts/set-mandates.sh`, AP2 keys with `node scripts/ap2-keys.mjs --party merchant` and `--party buyer`. Put your account names in `config/accounts.json` and `config/signatory.json` (and the payee in `legentvLEI/appconfig/invoiceConfig-near*.json`) before issuing invoices.

### 4.3 `setup` — first time on a PC

```bash
bash $S setup --fresh-vlei
```

1. checks node ≥ 22, npm, jq, curl, docker;
2. **fresh vLEI stack + the full org** via `legentvLEI/run-5D.sh` — 4 OOR officers, 4 agents, 4 sub-agents (Treasury ×2, Inventory, Logistics), built from `appconfig/org/companies/*.json` (build-org-config → fresh stack → 4D → issuance proof → strict export → strict trust tree). It **deletes the vLEI identities on that PC**, so it asks you to type `FRESH`. `run-5D.sh` also runs on its own: `cd legentvLEI && ./run-5D.sh`;
3. `npm install` for the services;
4. read-only checks: key files present, evidence present, `health.mjs --stage contract` (accounts, storage, contract, mandates);
5. ends with `setup complete` or a numbered list of what is still missing.

To add **one** agent to an org that already exists (no wipe): `cd legentvLEI && ./add-subagent.sh <Agent> <ParentAgent>` (after adding it to the company file and `node build-org-config.js …`), then re-export the evidence.

Without `--fresh-vlei`, setup keeps the existing vLEI stack and only does steps 1, 3–5 (safe to re-run any time). If the vLEI step does not run in WSL on your machine, run it in Git Bash: `bash chainaim-signatory/scripts/signatory.sh setup --fresh-vlei --skip-npm`.

### 4.4 `start` — every day

```bash
bash $S start            # add --vlei after a reboot (restarts the vLEI Docker stack, same identities, no 4D)
# runs in this terminal: Ctrl+C or closing the window stops all services (--background = keep running until `stop`)
```

It stops old copies, starts the **signer (8771), bridge (8772) and runner (8774)** with AP2 on (`--ap2 off` to disable), waits for each, points the UI at the configured contract (`health.mjs --stage all --write-ui-config`), starts the **UI (8765)** and prints:

<http://127.0.0.1:8765/Agent%20Escalation%20Console.html>

The top strip should show vLEI, NEAR, Signer, Bridge and Runner up. Logs: `chainaim-signatory/private/run/*.log`.

**Negotiator (purchase orders N1–N4).** Default `--negotiator rules`: the DD5 rules decide every move (same result every run). With an AI endpoint (OpenAI-compatible `/v1/chat/completions`, e.g. the private-ai gateway):

```bash
export SIGNATORY_LLM_API_KEY=...        # in your own terminal only — never in git, chat or on the command line
bash $S start --negotiator llm --llm-url http://127.0.0.1:<gateway port> [--llm-model <name>]
```

The AI proposes each move; the DD5 guard checks it (seller never below $3.55, buyer never above its budget); if the AI is unreachable or its answer is unusable, that move uses the DD5 rule and is labelled so in the UI.

### 4.5 Tests (no keys, no network)

```bash
cd chainaim-signatory/services && npm test     # 116 tests
cd ../contract && cargo test                   # 48 tests
```

---

## 5. Demo scenarios (built-in cards in the UI)

Click a card to fill the chat box (you can edit it), then send.

| # | Prompt | On-chain | Expected |
|---|---|---|---|
| 1 | Need 8,000 cotton t-shirts, total $84,000 | 0.084 | issued → verified → **paid** |
| 2 | Order 2,500 denim jeans, total $50,000 | 0.05 | paid |
| 3 | Need 10,000 polo shirts, total $100,000 | 0.10 | paid (limit is inclusive) |
| 4 | Need 15,000 hoodies, total $157,500 | 0.1575 | **pending** → Approve → paid |
| 5 | Order 12,000 jackets, total $120,000 | 0.12 | pending → **Reject** → refunded |
| 6 | Need 20,000 knit sweaters, total $240,000 | 0.24 | pending → Approve → paid |
| 7 | Order 30,000 winter coats, total $300,000 | 0.30 | refused before issuing (above CPO authority) |
| 8 | *(click "Turn off agent" first)* Need 5,000 t-shirts, total $42,000 | 0.042 | issued → verified → **refused**, refund |
| 9 | Sample order of 1 t-shirt, total $50 | 0.00005 | refused before issuing (below 0.0001) |
| 10 | Need cotton t-shirts for next month | — | stops: no amount given |

**Purchase orders (change #4)** — the ▶ N1…N4 chips start the run directly: buyer agent order → **the seller agent verifies the buyer agent** (live KELs) → swarm (inventory, logistics) → negotiation, where **the buyer agent verifies the seller agent on its first answer**, before replying (DD5 rules, US cents/unit; DD5 rupee price points restated 1:1 as cents, e.g. ₹350 floor → $3.50) → treasury (seller profit/NPV, buyer mandate route) → issue → verify the issued invoice → pay, as above.

| Order | Qty | Budget | Rules result | On-chain | Expected |
|---|---|---|---|---|---|
| N1 | 20,000 | $4.15 | agreed $3.85 in round 1 | 0.077 | **paid** by the agent |
| N2 | 40,000 | $4.15 | agreed $3.73 in round 2 | 0.1492 | **pending** → CPO Approve → paid |
| N3 | 20,000 | $3.95 | agreed $3.83 in round 3 | 0.0766 | paid |
| N4 | 20,000 | $3.45 | **no deal** (below the seller's $3.55 minimum) | — | officer Approve (buy at the seller's last $4.10 → 0.082, paid) or Reject (nothing issued) |

Data: `chainaim-signatory/data/orders.json` (orders + rules) and `data/dd5/` (DD5 inventory, logistics and treasury fixtures and 4 scenarios, copied unchanged from dd5-final-NEAR @4312cb1). The Logistics agent has no vLEI identity yet and is shown that way.

**Quote flow (Private AI + vLEI escalation)** — before an order exists, `tommyBuyerAgent` sends a Request for Quotation (ERPNext shape) to `jupiterSellerAgent`. The seller agent asks Jupiter's **Inventory**, **Logistics** and **Treasury** agents in **OutcomeAI** (each call made as that agent's vLEI alias; Jupiter's private data never leaves OutcomeAI), negotiates up to 3 rounds within its authority (`config/quote-authority.json`: agent 12% → Sales Officer 10% → CEO 8% margin floor), and escalates to `Jupiter_Chief_Sales_Officer`, then the CEO (brief prepared by `jupiterCeoAgent`). In each round OutcomeAI's `seller/synthesize` may propose (AI); a guard enforces floors, grade, split, deadline slip and a leak scan on the message to the buyer, and otherwise the rule decides (labelled `rules`).

```bash
# OutcomeAI quote-agents service running on :8785; token = OutcomeAI's tenant token for jupiter-knitting (env only)
export QUOTE_TOKEN_JUPITER=...                     # PowerShell: $env:QUOTE_TOKEN_JUPITER = "..."
bash chainaim-signatory/scripts/demo-quote.sh      # PowerShell: .\chainaim-signatory\scripts\demo-quote.ps1
#   --inquiry T07 --approve ask --pace-ms 600      one RFQ, officers asked live
#   --ai off                                       rules only · --outcome-url http://host:port · --help for all flags
```

| RFQ | Tommy asks | What happens (rules) | Result | On-chain later |
|---|---|---|---|---|
| T01 | 20k 180-A @ $4.25, by 01-08 | above target, stock on time | **accept** round 0, agent | 0.085, agent pays |
| T02 | 18k @ $3.90, by 01-12 | price counter | accept $4.11, round 2 | 0.07398, agent pays |
| T03 | 30k @ $3.75, by 01-05 | price counter; stock by standard sea + WIP by express | accept $4.13, round 3 | 0.1239, CPO approves |
| T04 | 40k @ $4.15, by 01-05 | **quantity** counter: 34k on time + 6k second shipment (re-consult) | accept $4.23, round 2 | 0.1692, CPO approves |
| T05 | 12k Grade B @ $3.50, by 12-30 | **quality** counter: Grade A instead (re-consult) | accept $4.25, round 2 | 0.051, agent pays |
| T06 | 25k @ $3.70, by 01-12 | 3 rounds, buyer stops below the agent floor | **Sales Officer** approves $4.10, round 4 | 0.1025, CPO approves |
| T07 | 45k @ $3.80, by 12-31, 30% advance | needs Tier-2 + Tier-1 stock reallocation | **CEO** approves $4.18 (incl. 12c premium) | 0.1881, CPO approves |
| T08 | 20k @ $3.40, by 01-12 | buyer's best is below the 8% floor | **declined** after officer and CEO; best-and-final $3.84 | nothing issued |

Records per RFQ in `chainaim-signatory/private/quotes/<RFQ-id>/` (git-ignored): `inquiry.json`, `consults.json` (every answer + API proof block), `round-N.quote.json` (ERPNext Quotation), `escalations.json` (reason, level, decision, who, when, brief), `final.quote.json`, `jupiter-internal.json` (plan, floors, AI log — never sent to Tommy). Inputs: `data/quote/inquiries.json` (Tommy's RFQs; the `buyerSim` block is Tommy's private simulation input, read only by `quote-buyer.mjs`), `data/quote/schema/` (field names from the official ERPNext doctypes). Tests replay recorded OutcomeAI answers against the data-pack oracle (`services/test/quote.test.mjs`). Escalation decisions are recorded by Signatory, not yet KERI-signed; in the console the agreed quote continues into the existing invoice → NEAR pay tail (runner mode `quote`, below).

**In the console (runner mode `quote`):** `signatory.sh start` runs the runner with quote mode on whenever `data/quote/inquiries.json` exists. The UI then shows chips **▶ T01 … T08** next to N1–N4. A run goes: request → verify_buyer → consult (Inventory, Logistics, Treasury, each in OutcomeAI as its vLEI alias) → negotiate (≤ 3 rounds) → escalation (the Approve/Reject buttons decide for `Jupiter_Chief_Sales_Officer`, then the CEO) → treasury (Tommy's mandate route) → issue → … → pay on NEAR. Export `QUOTE_TOKEN_JUPITER` in the shell that starts the runner (env only). Runner flags: `--quote on|off`, `--outcome-url http://127.0.0.1:8785`, `--quote-ai on|off`, `--quote-tail on|off` (off = stop after the agreement, no invoice), `--quote-timeout-s 20`. Records: `private/quotes/<RFQ-id>.<runId>/`. Tests: `services/test/runner-quote.test.mjs`.

Every chat bubble has a **details** section with the real API call, status, duration, raw response and transaction link. After scenario 8, re-enable the agent with `bash scripts/set-mandates.sh`.

---

## 6. What is real and what is demo

- **Real:** KERI identifiers, delegation and KEL verification; vLEI-style LE/OOR credentials from a local QVI; ACDC invoice credentials with IPEX grant/admit and TEL issuance; the NEAR contract, mandates, escalation, refunds and every transaction above.
- **Demo:** the GLEIF root and QVI run locally (not production GLEIF); USDC is Circle **testnet** USDC; amounts are scaled 1:1,000,000; the failed private-callback transactions were cross-checked with the FastNear testnet transaction index.
- **Known limit:** revoking an agent does not cancel a payment it already left `pending`; the approver can still approve or reject it.

---

## 7. Security

- No private keys or passcodes are in this repository. NEAR keys stay in `~/.near-credentials`; KERI passcodes stay in the git-ignored `legentvLEI/task-data/`.
- Services bind to `127.0.0.1` and refuse any browser origin other than `http://127.0.0.1:8765`.
- The runner holds no keys. The signer and bridge never return or log keys, and the UI hides any key-like line.

---

## 8. Troubleshooting

| Symptom | Fix |
|---|---|
| `wsl` opens the wrong distro | use `wsl -d Ubuntu` |
| Export times out from Ubuntu | use Windows `node.exe` (the runner's default `--export-node`) or run the exporter in Git Bash |
| KERIA `Invalid sad` when issuing | an amount below 0.0001 — use larger numbers (the scripts guard this) |
| Identity scripts fail with "already incepted" | start clean: `./stop.sh && ./deploy.sh --fresh`, then 4D again |
| UI shows a service as down | `bash $S start` again (it restarts everything and rewrites the UI config); see `chainaim-signatory/private/run/<service>.log` |
| `EADDRINUSE` (port in use) | an old copy is still running: `bash $S stop`, then `bash $S start` |
| `setup` lists missing key files | put them where §4.2 says (names are in `config/accounts.json`); `setup` never opens them |
| `docker ps` permission denied in Ubuntu | `sudo chgrp docker /var/run/docker.sock` |
