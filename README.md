# Signatory — private AI decides, signed credentials prove, NEAR enforces

Signatory is a B2B payment demo for the NEAR hackathon. A buyer types a purchase request in a chat. The seller's AI agent issues a **signed vLEI invoice credential**. Both companies' identity chains are **verified live** (KERI / vLEI). The invoice is **registered on NEAR**, and a NEAR smart contract **enforces each agent's spending mandate**: it pays within the limit, escalates to a human officer above it, and refuses when the agent is turned off.

- **Buyer:** Tommy Hilfiger Europe B.V. (LEI `54930012QJWZMYHNJW95`)
- **Seller:** Jupiter Knitting Company (LEI `3358004DXAMRWRUIYJ05`)
- **Network:** NEAR testnet, contract `chainaim-signatory.testnet`, Circle testnet USDC (6 decimals)
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
| `chainaim-signatory/contract/` | Rust NEAR contract (near-sdk 5.30.1), 43 unit tests |
| `chainaim-signatory/services/` | Node services: `signer/` (8771), `bridge/` (8772), `runner/` (8774), `shared/`, `test/` (63 tests) |
| `chainaim-signatory/scripts/` | `deploy.sh`, `set-mandates.sh`, `health.mjs`, `view.mjs` |
| `chainaim-signatory/config/` | `signatory.json` (network, contract, ports), `accounts.json` (accounts + mandates) |
| `UI/` | `Agent Escalation Console.html` (the chat UI), `serve.mjs` (static server), `data/` (evidence + accounts, no secrets) |
| `legentvLEI/` | vLEI / KERI stack (KERIA, witnesses, schema server in Docker), identity scripts, invoice issue + IPEX, `export-signatory-evidence.js` |
| `ARCHITECTURE-*.md`, `chainaim-signatory/ARCHITECTURE-signatory-2026-11-13.md`, `UI/ARCHITECTURE-UI-2026-11-13.md` | Design and build records |

---

## 4. Run it yourself

### 4.1 Prerequisites

Tested on Windows 11 with WSL2. Two terminals are used throughout:

- **Git Bash** — vLEI scripts (Docker) and the UI server.
- **WSL Ubuntu** — NEAR tools and the three services (they read keys from `~/.near-credentials`). Always open it with `wsl -d Ubuntu`.

| Tool | Version used |
|---|---|
| Docker Desktop, WSL integration enabled for Ubuntu | current |
| Node.js (Windows **and** Ubuntu) | ≥ 22 (26.x used) |
| Rust / cargo, target `wasm32-unknown-unknown` | 1.100.0 |
| cargo-near | 0.23.0 |
| near-cli-rs | 0.31.1 |
| jq, gcc, curl (Ubuntu) | any recent |

If `docker ps` in Ubuntu says *permission denied*: `sudo usermod -aG docker $USER`, reopen Ubuntu, and after a Docker Desktop restart run `sudo chgrp docker /var/run/docker.sock`.

### 4.2 Start the vLEI stack and create identities (Git Bash, ~15–25 min)

```bash
cd enh2-final/legentvLEI
# create legentvLEI/.env with your user ids:  UID=1000  GID=1000
./stop.sh
./setup.sh
./deploy.sh --fresh
./saidify-and-restart.sh
./run-all-buyerseller-4D-with-subdelegation.sh --invoice-config ./appconfig/invoiceConfig-near.json
```

This creates GEDA → QVI → both Legal Entities → OOR officers → delegated AI agents and sub-agents, then issues the first invoice. Each identity's passcode (BRAN) is generated into `legentvLEI/task-data/`, which is git-ignored. **Never commit or share that folder.**

Export the evidence the UI and bridge read:

```bash
node export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json
# expect: all agents KEL-verified, invoices issuance-verified, "All checks passed."
```

### 4.3 NEAR accounts, contract and mandates (WSL Ubuntu)

1. Create five testnet accounts with near-cli-rs, saving keys to the **legacy keychain** (`~/.near-credentials/testnet/<account>.json`): contract owner, vLEI registrar, buyer agent, CPO (approver), payee. Our names are in `chainaim-signatory/config/accounts.json`. If you use your own names, update `accounts.json`, `signatory.json`, and the `paymentWalletAddress` in `legentvLEI/appconfig/invoiceConfig-near*.json` **before** issuing invoices (the payee is part of the signed invoice).
2. Register token storage (`storage_deposit` on the USDC contract) for the contract, the buyer agent and the payee.
3. Fund the buyer agent with testnet USDC from [faucet.circle.com](https://faucet.circle.com) (network: NEAR Testnet).
4. Build, deploy and set mandates:

```bash
cd /mnt/c/<path-to>/enh2-final/chainaim-signatory
node scripts/health.mjs --stage accounts      # until no FAIL
bash scripts/deploy.sh                         # build wasm, deploy, init, verify get_config
bash scripts/set-mandates.sh                   # agent 0.10, CPO 0.25; also copies accounts.json to the UI
node scripts/health.mjs --stage contract
```

> Do not paste any command output that shows a private key, and never run `near account export-account … using-private-key` where others can see the output.

### 4.4 Start the services (three WSL Ubuntu windows)

```bash
cd /mnt/c/<path-to>/enh2-final/chainaim-signatory/services
npm install          # first time only
npm test             # optional: 63 tests

node signer/index.mjs     # window 1 — port 8771 (buyer agent + CPO keys)
node bridge/index.mjs     # window 2 — port 8772 (registrar key)
node runner/index.mjs     # window 3 — port 8774 (no keys; calls vLEI scripts + signer + bridge)
```

The runner issues invoices with Ubuntu bash and exports with **Windows** `node.exe` (`--export-node "/mnt/c/Program Files/nodejs/node.exe"`, the default), because Ubuntu's Node reaches KERIA through the WSL localhost bridge too slowly.

Then point the UI at the services:

```bash
cd ..
node scripts/health.mjs --stage all --write-ui-config
```

### 4.5 Open the UI (Git Bash)

```bash
cd enh2-final/UI
node serve.mjs
```

Open <http://127.0.0.1:8765/Agent%20Escalation%20Console.html>. The top strip should show vLEI, NEAR, Signer, Bridge and Runner as up, with the runner in **Phase B** (a new invoice per request).

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
| UI shows a service as down | start it, then `node scripts/health.mjs --stage all --write-ui-config` |
| `docker ps` permission denied in Ubuntu | `sudo chgrp docker /var/run/docker.sock` |
