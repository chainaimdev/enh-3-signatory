# Signatory

**AI agents spend company money on NEAR — only within limits a smart contract enforces, and only after their legal identity is verified.**

NEAR HACKATHON 2026 · Track: **Agent Economy** · Network: NEAR **testnet** · Demo video: _<link to the X post>_

**Architecture (one page):** https://signatory-architecture.vercel.app/

Same team's other entry: **Outcome AI** — github.com/chainaimdev/chainaim-private-ai

---

## Check it in 5 minutes

1. **Watch** the 2-minute demo video (link above): one full purchase, from the buyer agent's order to payment on NEAR.
2. **Open** the four NEAR testnet transactions below: invoices registered and paid by an AI agent, on chain.
3. **Run** the tests — no keys, no network: `cd chainaim-signatory/services && npm ci && npm test` → 141 pass.

---

## What it does

Tommy Hilfiger Europe (buyer) and Jupiter Knitting (seller) trade through AI agents.

1. Tommy's **buyer agent** sends a purchase order.
2. Jupiter **verifies who is asking** — the agent's legal identity chain, live.
3. Jupiter's **seller agent** asks its sub-agents (Inventory, Logistics, Treasury) and negotiates a price.
4. Tommy's **treasury agent** checks the agent's **spending mandate on NEAR**.
5. Jupiter issues the invoice as a **signed vLEI credential**.
6. A registrar checks the credential and **registers the invoice on NEAR**.
7. The buyer agent **pays in USDC through the NEAR contract**.
   Within its limit it pays alone. Above it, the payment waits for a human officer. If the agent is turned off, the contract refuses.

## Proof — real transactions on NEAR testnet

Contract: `chainaim-signatory-v2.testnet` · Token: Circle testnet USDC · Scale: $1,000,000 = 1 USDC

| Run | Step | What the chain shows | Transaction |
|---|---|---|---|
| 1 (in the video) | Register invoice | `register_invoice` by `chainaim-vlei-registrar.testnet` → event `invoice_registered` | [EZNRayz8…](https://testnet.nearblocks.io/txns/EZNRayz84E4PmWnuT1CUKbzkBhdsGRk2bhfUgnzVCo5w) |
| 1 (in the video) | Agent pays 0.077 USDC | `ft_transfer_call` by `chainaim-tommy-buyer-agent.testnet` → contract → `chainaim-jupiter-payee.testnet`, event `paid` | [F6ihh9Sw…](https://testnet.nearblocks.io/txns/F6ihh9SwRYbzC9dbnu7zgizHNZCQcXqpUP8HThTt9kLU) |
| 2 | Register invoice | `register_invoice` → event `invoice_registered` | [CDzCkxYb…](https://testnet.nearblocks.io/txns/CDzCkxYbvCoNSZohm78R3N5N799Nv6VQywaTGQw4XifA) |
| 2 | Agent pays 0.035 USDC | `ft_transfer_call` → contract → payee, event `paid` | [4XpgAcNr…](https://testnet.nearblocks.io/txns/4XpgAcNrsSgcNdH9BMJGzsgoLorCoGRVAUpqEhCroyi1) |

The agent's mandate (limit 0.1 USDC, approver = the Chief Procurement Officer) is stored in the contract and checked on every payment.

## Why the identity part matters (vLEI)

- **vLEI** is GLEIF's verifiable legal identity for organisations, built on **KERI** key event logs.
- Every actor here has a chain: **GLEIF → QVI** (Qualified vLEI Issuer) **→ company (LE) → human officer with an OOR credential** (Official Organisational Role) **→ AI agent → sub-agent**.
- Before acting, each side checks the other live: the officer presents its OOR credential to a verifier (Sally), and the agent's delegation is checked against the key logs.
- The invoice is a signed credential handed over with **IPEX** (grant → admit), and its issuance is anchored in the seller's key log. The registrar recomputes its digest before anything reaches NEAR — a tampered invoice never reaches the chain.

## Try it

**No keys, about 2 minutes** — the logic, with recorded agent answers:

```bash
cd chainaim-signatory/services
npm ci
npm test          # → 141 pass
```

**Full live run** — needs Docker, your own NEAR testnet accounts and about 30 minutes for the one-time vLEI setup. Run in WSL Ubuntu or Linux:

```bash
cd chainaim-signatory
bash scripts/signatory.sh setup --fresh-vlei   # builds the vLEI org (GLEIF → QVI → 2 companies, 4 officers, 4 agents, 4 sub-agents); lists anything missing
bash scripts/signatory.sh start --vlei         # vLEI stack + signer + bridge + runner + UI
# open http://127.0.0.1:8765 and click ▶ N1
```

Keys are never in this repository: NEAR keys stay in `~/.near-credentials`, vLEI passcodes in the git-ignored `legentvLEI/task-data/`.

## What is real and what is demo

- **Real:** KERI identifiers and delegations, vLEI-style LE/OOR credentials, IPEX invoice credentials, live verification, the NEAR contract, mandates and every transaction above.
- **Demo:** same KERI/vLEI software and protocol as production, but the GLEIF root and QVI are created locally — production vLEIs are issued only by GLEIF-licensed QVIs, so these credentials are not valid outside this demo. USDC is testnet USDC; amounts are scaled.
- **Agents:** purchase orders N1–N4 negotiate with a rule-based negotiator. The quote flow (S01–S09) uses AI agents in Outcome AI, each answering from its own company's private data; it needs Outcome AI running.

## What we built and what we build on

- **Built for this hackathon:** the NEAR contract `chainaim-signatory-v2.testnet` (mandates, escalation, refunds), signer, bridge, runner, agent swarm and negotiation, UI, AP2 signing, quote flow.
- **Built on:** GLEIF's open-source vLEI stack (KERIA, Signify, vLEI schemas); our `legentvLEI/` org scripts started from GLEIF's vlei-hackathon-2025-workshop.
- **Libraries:** near-api-js, @noble/hashes.
- **AI assistance:** parts of the code and docs were written with AI coding assistants.

## Repository map

| Folder | What |
|---|---|
| `chainaim-signatory/contract/` | NEAR smart contract (Rust) |
| `chainaim-signatory/services/` | signer, bridge, runner, tests |
| `chainaim-signatory/scripts/signatory.sh` | setup / start / stop |
| `legentvLEI/` | vLEI stack (Docker) and org setup (`run-5D.sh`) |
| `UI/` | the console shown in the video |
| `docs/README-full.md` | full technical README: all scenarios, flags, security, troubleshooting |

## License

MIT — see [LICENSE](LICENSE).
