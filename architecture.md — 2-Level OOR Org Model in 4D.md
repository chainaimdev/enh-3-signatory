# architecture.md — 2-Level OOR Org Model in 4D

Nov 12, 2026 · @Sathya Krishnasamy

## Summary

We add a 2-level OOR officer model (Level 1 CEO, Level 2 CSO or CPO, each with AI agents) to the 4D workflow in `legentvLEI`, described in standard W3C ORG and PROV-O JSON, without changing how today's 4C/4D runs behave.

- **Non-breaking rule:** every change is additive and off by default. Running 4C or 4D with no new flags reads today's config files and produces today's result.
- **How:** new company files (W3C ORG + PROV-O, JSON-LD) are turned by a new config builder into the exact config format 4C/4D already read. The identity, credential and delegation scripts are not modified.
- **Decisions taken:** both levels use OOR only (ECR out of scope). Escalation logic lives in the trading agents and UI, not in 4D. Verifying the officer's OOR credential during agent verification is an open decision for later.
- **Status:** implemented 2026-11-12 (test plan steps 1–6 done). Org files, `build-org-config.js` and the optional flags are in place; the builder passes all 10 checks and generates `config-4c.json` / `config-4d.json`. Steps 7–10 (WSL runs, filling placeholders) are still manual and not yet run.

## Scope

This change covers org modelling and identity setup only; runtime escalation and credential-chain verification are later phases.

| Area | In this change | Notes |
| --- | --- | --- |
| Company org files (W3C ORG + PROV-O) | Yes | Jupiter (seller), Tommy (buyer) |
| Level 1 CEO + Level 2 CSO/CPO, both OOR | Yes | Each with one AI agent; CEO agent added |
| Treasury sub-agents (4D style) | Yes | Created only if listed in parent's `may_act` |
| Config builder | Yes | Writes generated 4C/4D configs |
| Optional flags on 4C, 4D, DEEP-EXT | Yes | Defaults unchanged |
| ECR officers | No | Out of scope for the 2-level OOR plan |
| Escalation runtime (limits, `escalatesTo`, timeouts) | No | Owned by the trading agents and UI |
| OOR credential check during agent verification | No | Open decision, see below |
| Multi-company UI (pick seller/buyer) | No | Later phase; the org files are ready for it |

**Open decision: OOR credential verification.** Today the verifier (`verification_service_keri_v3.py`) checks only the KERI delegation between agent and delegator. Options for later: (a) keep delegation-only, (b) fix and deploy `custom-sally/agent_verifying.py` to walk OOR → LE → QVI → GLEIF, (c) check the chain in the API server before trading. Not chosen yet.

## Standards used

The org structure uses two W3C Recommendations, officer data uses the official vLEI fields, and only the escalation rules are custom.

| Part | JSON field(s) | Standard | Status |
| --- | --- | --- | --- |
| Company identity | `lei` | ISO 17442 (LEI) | Ratified |
| Trust chain GLEIF → QVI → LE → officer | created by 4C/4D | vLEI Ecosystem Governance Framework | Official (GLEIF) |
| Company | `@type: org:FormalOrganization` | [W3C Organization Ontology](https://www.w3.org/TR/vocab-org/) | W3C Recommendation, 2014 |
| Level 1 / Level 2 positions | `posts`, `org:Post`, `level` | W3C ORG (`level` is custom) | Ratified + custom |
| Who holds a post | `heldBy` | W3C ORG `org:heldBy` | Ratified |
| CSO/CPO reports to CEO | `reportsTo` | W3C ORG `org:reportsTo` | Ratified |
| CEO heads the company | `headOf` | W3C ORG `org:headOf` | Ratified |
| Officer vLEI data | `personLegalName`, `officialRole` | vLEI OOR credential schema; role code from ISO 5009 (GLEIF OOR Code List) | Official |
| Agent acts for officer; sub-agent for agent | `actedOnBehalfOf` | [W3C PROV-O](https://www.w3.org/TR/prov-o/) `prov:actedOnBehalfOf` | W3C Recommendation, 2013 |
| Agent permissions and limits | `mandate.authorization_details` | RFC 9396 (shape) | IETF Proposed Standard |
| Who may act under an agent | `may_act` | Name from RFC 8693 | IETF Proposed Standard (name only) |
| Escalation chain, timeouts, always-human rules | `escalatesTo`, `timeout`, `escalationPolicy`, `approvalLimit`, `advisoryOnly` | None; follows GLEIF Agent Mandate Credential proposal | Custom |

Custom fields live under the `ca:` namespace `https://chainaim.com/ns/vlei-org#`, kept separate from the official terms.

## Current architecture (as read from the code)

Today 4D runs 4C first, then sub-delegates agents; both read fixed config files with a custom layout and one officer per company.

| Component | What it does today | Finding |
| --- | --- | --- |
| `appconfig/configBuyerSellerAIAgent1.json` | 4C input: 3 orgs (Jupiter, Tommy, Acme), 1 person + 1 agent each | `legalName` holds a job title; `officialRole` is a made-up label |
| `appconfig/configBuyerSellerAIAgent1-with-subdelegation.json` | 4D input: 2 orgs, adds `subAgents` + `permissions` | Different `registryName` values from the 4C file |
| `run-all-buyerseller-4C-with-agents.sh` | GEDA/QVI, then per org: LE, per person: OOR AUTH + OOR, per agent: delegation; then invoice IPEX | Line 49 fixed config; line 316 creates the LE registry inside the person loop; lines 736–737 hard-code seller/buyer agents |
| `run-all-buyerseller-4D-with-subdelegation.sh` | Runs 4C (or skips it), generates sub-agent BRANs, delegates sub-agents, regenerates agent cards | Skips 4C if 3 task-data files exist; ignores `canDelegate` and `scope` |
| `task-scripts/agent/agent-delegate-with-unique-bran.sh` | Agent AID from unique BRAN, delegated from the person's AID | Credential-agnostic: works for any person AID |
| `task-scripts/subagent/*` + `sig-wallet/src/tasks/subagent/*` | 3-step sub-delegation; real KEL check (OOBIs sent) | Works as designed |
| `config/verifier-sally/verification_service_keri_v3.py` (deployed as `vlei-verification`) | Checks `dip`, `di`, anchoring seal and digest via OOBIs | Never checks the OOR credential; `verify_kel:false` = format check only (used by 4C) |
| `config/verifier-sally/custom-sally/agent_verifying.py` | Intended OOR chain check | Not deployed; matches a schema name against a SAID, so it never matches |
| `DEEP-EXT-subagent.sh` | Deep verification report | Compares local task-data files; guesses the officer from the agent name; Step 1 cannot fail |

Identities persist in the `keria-vol` volume and `task-data/<alias>-info.json`. Every 4D run mints new agent AIDs.

## Verification of the remaining scripts

The three scripts that were unread are now read: the registry needs no change, and the BRAN and agent-card scripts need only config pass-through and two small additive options.

| Script (read 2026-11-12) | What the code does | Effect with 2 officers per company | Action |
| --- | --- | --- | --- |
| `task-scripts/le/le-registry-create.sh` → `createRegistry()` in `sig-wallet/src/client/credentials.ts` | Lists the LE's registries and skips creation if `<LE_ALIAS>-oor-registry` already exists | Second officer reuses the registry; no clash | None |
| `task-scripts/person/person-aid-create.sh` + `.ts` | Writes `<alias>-aid.txt`, `<alias>-info.json` and the shared `person-info.json`; all persons use the same `PERSON_SALT`, told apart by alias | Works for any number of persons | None |
| `person-oobi-resolve-*.sh`, `le-acdc-issue-oor-auth.sh`, `qvi-acdc-issue-oor.sh`, `person-acdc-admit-oor.sh`, `person-acdc-present-oor.sh` | Read the shared `person-info.json`, `oor-auth-credential-info.json`, `oor-credential-info.json`; each run overwrites them; 4C calls them in order per person | Works in sequence; after the run the shared OOR file holds only the last officer's credential | Keep a per-officer copy (additive) |
| 4C after the person loop | No later step reads the shared person or OOR files | No other dependency | None |
| `generate-unique-agent-brans.sh` | Already has `--config`; exits if any agent lacks `role`; default `--env-mode none` writes no `.env` | New CEO agents need a `role`; 4C calls it without `--config` | Builder writes `role` on every agent; 4C passes its config through |
| `generate-subagent-brans.sh` | Config path fixed to the 4D file; writes each sub-agent's BRAN into `../Legent/A2A/js/src/agents/<alias>/.env` | `TommyTreasuryAgent` not found when using the generated config | Add optional `--config` (default unchanged) |
| `generate-agent-cards.js` | Already has `--config`; loops every org, person, agent, sub-agent; card text chosen by `org.id === 'jupiter'`; sub-agent card text fixed to "Jupiter Treasury Agent"; `delegatorSAID` read from the shared OOR file | CEO agents get seller/buyer text; `TommyTreasuryAgent` gets Jupiter text; every card's `delegatorSAID` is the last officer's | New optional flags: per-officer OOR SAID, card text from config; defaults unchanged |

Existing behaviour kept as is and flagged: `generate-subagent-brans.sh` writes each sub-agent BRAN in plain text into a `.env` file under `../Legent/A2A/js/src/agents/`.

## Target file layout

All new files sit beside today's configs; nothing existing is renamed or overwritten.

```
legentvLEI/
  appconfig/
    configBuyerSellerAIAgent1.json                      (unchanged, still the default for 4C)
    configBuyerSellerAIAgent1-with-subdelegation.json   (unchanged, still the default for 4D)
    org/                                                (NEW)
      context.jsonld          shared W3C ORG + PROV-O + ca: definitions
      companies/
        jupiter.json          seller, 2 posts, 2 people, 3 agents
        tommy.json            buyer,  2 posts, 2 people, 3 agents
    generated/                                          (NEW, written by the builder)
      config-4c.json          same format as configBuyerSellerAIAgent1.json
      config-4d.json          same format as ...-with-subdelegation.json
  build-org-config.js                                   (NEW)
```

The diagram below shows how these pieces connect.

&#91;embedded content: target architecture · old and new path into 4D\]

Only `build-org-config.js` is new code; 4D reads its generated files when given the new flags and today's files otherwise.

## Org JSON model

Each company file holds three flat lists, posts, people and agents, linked by `@id`; the shared `context.jsonld` maps each key to W3C ORG, PROV-O or the `ca:` namespace.

| List | Each item has | Maps to 4C/4D as |
| --- | --- | --- |
| `posts` | `label`, `level`, `reportsTo` (post), `heldBy` (person) | Order of `persons[]` (level 1 first) |
| `people` | `alias`, `personLegalName`, `credentialType: OOR`, `officialRole` (ISO 5009), `officialRoleLabel`, `approvalLimit`, `escalatesTo`, `timeout` | `persons[]`: `alias`, `legalName` = `personLegalName`, `officialRole` |
| `agents` acting for a person | `alias`, `agentType`, `tradeRole`, `actedOnBehalfOf` (person), `mandate`, `escalatesTo`, `timeout` | `persons[].agents[]` |
| `agents` acting for an agent | same, `actedOnBehalfOf` (agent), `advisoryOnly` | 4D `agents[].subAgents[]`, only if listed in the parent's `may_act` |

Company-level fields: `companyId`, `alias`, `label`, `lei`, `jurisdiction`, `registryName`, `tradeRoles`, `escalationPolicy`. `mandate`, `approvalLimit` and `escalationPolicy` are `@json` literals, so the RFC 9396 shape is kept byte for byte.

Shared context (excerpt):

```json
{
  "@context": {
    "@version": 1.1,
    "org": "http://www.w3.org/ns/org#",
    "prov": "http://www.w3.org/ns/prov#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
    "ca": "https://chainaim.com/ns/vlei-org#",
    "posts": { "@id": "org:hasPost", "@type": "@id", "@container": "@set" },
    "reportsTo": { "@id": "org:reportsTo", "@type": "@id" },
    "heldBy": { "@id": "org:heldBy", "@type": "@id" },
    "headOf": { "@id": "org:headOf", "@type": "@id" },
    "actedOnBehalfOf": { "@id": "prov:actedOnBehalfOf", "@type": "@id" },
    "mandate": { "@id": "ca:mandate", "@type": "@json" },
    "escalatesTo": { "@id": "ca:escalatesTo", "@type": "@id" }
  }
}
```

Jupiter seller agent (example item):

```json
{ "@id": "ca:agent/jupiterSellerAgent", "@type": "prov:SoftwareAgent",
  "alias": "jupiterSellerAgent", "agentType": "AI", "tradeRole": "seller",
  "actedOnBehalfOf": "ca:person/jupiter-cso",
  "mandate": { "authorization_details": [ { "type": "sales_operations",
      "actions": ["negotiate_order", "issue_invoice"],
      "transactionLimit": { "currency": "USD", "max": 100000 } } ],
    "validUntil": "2027-11-12T00:00:00Z", "may_act": ["ca:agent/JupiterTreasuryAgent"] },
  "escalatesTo": "ca:person/jupiter-cso", "timeout": "PT4H" }
```

The full `context.jsonld`, `jupiter.json` and `tommy.json` agreed in chat are the source files for implementation. Placeholders to fill before a run: legal names, Jupiter's country code, ISO 5009 OOR codes.

## Config builder (`build-org-config.js`)

The builder validates the company files and writes the two config files 4C and 4D already understand, so 4D needs no new input format.

```
node build-org-config.js \
  --org-dir    ./appconfig/org \
  --seller     jupiter \
  --buyer      tommy \
  --out-dir    ./appconfig/generated \
  [--dry-run]           # validate and print a summary, write nothing
  [--fail-on-placeholder]  # refuse values still in <angle brackets>
```

**Checks (any failure stops the build, nothing is written):**

1. Valid JSON; required fields present on company, people and agents.
2. Every `@id` reference resolves: `heldBy`, `reportsTo`, `headOf`, `actedOnBehalfOf`, `escalatesTo`, `may_act`, `escalationPolicy.reportTo`.
3. `reportsTo` has no cycles (W3C ORG allows cycles, so the builder must check).
4. All `alias` values unique within the run (they become KERIA identifier names and `task-data` file names).
5. Every sub-agent appears in its parent agent's `may_act`.
6. Limits narrow downwards: an agent's `transactionLimit.max` is below its person's `approvalLimit.max` when both are set.
7. Only `credentialType: OOR` accepted (ECR is out of scope).
8. Exactly one `tradeRole: seller` agent in the seller company and one `tradeRole: buyer` agent in the buyer company.
9. Every agent gets a non-empty `role` in the generated configs (required by `generate-unique-agent-brans.sh`, which exits otherwise).
10. With `--fail-on-placeholder`: no value still in angle brackets (legal names, ISO 5009 codes, country code).

**Mapping written to the generated files:**

| Company file | `config-4c.json` | `config-4d.json` |
| --- | --- | --- |
| `alias`, `label`, `lei`, `registryName`, `companyId` | `organizations[].alias`, `name`, `lei`, `registryName`, `id` | same |
| `people`, ordered by their post's `level` (1 first) | `persons[]` with `alias`, `legalName` = `personLegalName`, `officialRole` | same |
| agents acting for a person | `persons[].agents[]` with `alias`, `agentType`, `role` | same, plus `permissions` and the optional `card` |
| agent `role` rule | `tradeRole` if set, else the first `authorization_details[].type` (e.g. `executive_approvals`) | same |
| agents acting for an agent | not written | `agents[].subAgents[]` with `alias`, `agentType`, `permissions` (`scope` = first `authorization_details[].type`, `canDelegate` = `may_act` not empty), `may_act`, optional `card` |
| optional agent `card` (`name`, `description`, `url`, `skills`) | not written | copied as is, read by `generate-agent-cards.js` |
| `root`, `qvi` | copied from the current 4C config | same |

The builder reads the `@context` only to confirm it is present; it does not need a JSON-LD processor. `card` is a new optional key in the company files; `context.jsonld` gets `"card": { "@id": "ca:card", "@type": "@json" }`. An agent without `card.url` gets a card whose URL the generator already flags as a placeholder; that agent must be given its real service URL before a trading agent serves its card.

Generated files are rewritten on every builder run: edit the company files, never `appconfig/generated/*`.

## Script changes

Each edit adds an optional flag whose default reproduces today's behaviour exactly; no identity, credential or delegation script is touched.

| Script | Change | Without the new flag |
| --- | --- | --- |
| `run-all-buyerseller-4C-with-agents.sh` | `--config <file>` replaces the fixed `CONFIG_FILE` (line 49) | `./appconfig/configBuyerSellerAIAgent1.json` |
| same, BRAN step (\~line 209) | Passes the same config to `generate-unique-agent-brans.sh --config` | Same file as today |
| same, after each officer's OOR admit | Copies `task-data/oor-credential-info.json` to `task-data/<personAlias>-oor-credential-info.json` | Adds one new file per officer; the shared file and every existing read are unchanged |
| same, invoice step | `--seller-agent <alias>`, `--buyer-agent <alias>` replace lines 736–737 | `jupiterSellerAgent`, `tommyBuyerAgent` |
| `run-all-buyerseller-4D-with-subdelegation.sh` | `--config-4c <file>` (passed to 4C); `--config-4d <file>` (used by its sub-agent loop, `generate-subagent-brans.sh` and `generate-agent-cards.js`) | Today's two files |
| same, Phase 1 skip check | `--force-base` always runs 4C | Same 3-file skip rule as now |
| same, Phase 3 sub-agent loop | If the parent has `may_act`, delegate only sub-agents listed in it | Today's configs have no `may_act`, so every sub-agent is delegated as now |
| same, card step | When `--config-4d` is given, also passes `--per-officer-oor` to `generate-agent-cards.js` | Card step runs exactly as now |
| `generate-subagent-brans.sh` | `--config <file>` | The 4D file, as now |
| `generate-agent-cards.js` | `--per-officer-oor`: read `<personAlias>-oor-credential-info.json` for `delegatorSAID`. Optional `card` block on an agent (`name`, `description`, `url`, `skills`) replaces the template text | Shared OOR file and today's template text |
| `DEEP-EXT-subagent.sh` | `--oor-holder <alias>` | Same name-guessing as now |
| New: `build-org-config.js` | Generates the 4C/4D configs | Not run unless called |

**Not modified:** `task-scripts/**`, `sig-wallet/src/**`, `config/verifier-sally/**`, `docker-compose.yml`, `api-server/**`, KERIA config, existing `appconfig/*.json`.

**Checked and dropped:** the earlier possible change to `task-scripts/le/le-registry-create.sh` is not needed, because `createRegistry()` already reuses an existing registry.

## What works after the change

The old path keeps working unchanged, and the new path creates two OOR officers per company with their agents and sub-agents.

| Behaviour | Old path (no new flags) | New path (builder + flags) |
| --- | --- | --- |
| Companies | Jupiter, Tommy (+ Acme in 4C) | Companies chosen with `--seller` / `--buyer` |
| Officers per company | 1 (CSO / CPO) | 2: CEO (Level 1, OOR) + CSO or CPO (Level 2, OOR) |
| OOR registry | One per LE | Same registry reused by the second officer (verified) |
| OOR credential `personLegalName` | Job title | Real legal name from the company file |
| Agents | `jupiterSellerAgent`, `tommyBuyerAgent` (+ Acme) | Adds `jupiterCeoAgent`, `tommyCeoAgent` |
| Sub-agents | `JupiterTreasuryAgent` | `JupiterTreasuryAgent`, `TommyTreasuryAgent`, each only if in `may_act` |
| Sub-agent verification | Real KEL check | Same |
| Agent → officer verification | Format check (`verify_kel:false`) | Same (unchanged in this phase) |
| Invoice IPEX grant/admit | Seller agent → buyer agent | Same, agents taken from the company files |
| Agent cards | Today's text; `delegatorSAID` = last officer's OOR | Text from each agent's `card` when given; `delegatorSAID` = that agent's own officer |
| Extra files in `task-data` | `<personAlias>-oor-credential-info.json` per officer (new, unused by the old path) | Same, read by the card step |

**Still not working after this change (later phases):**

- Escalation runtime: limits, `escalatesTo`, timeouts are stored in the company files but not acted on until the trading agents read them.
- OOR credential check when verifying an agent (open decision).
- Selecting companies from a UI.

**Operational note:** the new path needs a fresh run (`stop.sh` → `setup.sh` → `deploy.sh` → 4D), and every run mints new AIDs for all agents.

## Test and rollout plan

The old path is proven unchanged before the new path is run; manual steps go one at a time.

| # | Step | Who | Pass when |
| --- | --- | --- | --- |
| 1 | Read the remaining scripts | AI | Done 2026-11-12 (see Verification section) |
| 2 | Back up every file that will be edited (4C, 4D, `generate-subagent-brans.sh`, `generate-agent-cards.js`, `DEEP-EXT-subagent.sh`) | AI | Done: the folder is a git repository, clean at commit `b24c375` before editing |
| 3 | Create `appconfig/org/*` and `build-org-config.js` | AI | Files exist; existing configs untouched |
| 4 | `build-org-config.js --dry-run` | AI | All 10 checks pass |
| 5 | Generate `config-4c.json` / `config-4d.json`; compare field names and nesting with today's configs | AI | Same shape, plus `role`, `may_act`, `card` |
| 6 | Add the optional flags; `bash -n` on shell scripts, `node --check` on JS | AI | Scripts parse; defaults equal today's values |
| 7 | Regression: run today's 4D with no new flags | Manual (WSL) | Same output as before, plus the new per-officer OOR files |
| 8 | Fill placeholders (legal names, ISO 5009 codes, country) | Manual | `--fail-on-placeholder` passes |
| 9 | Fresh start, then 4D with `--config-4c`, `--config-4d`, `--force-base` | Manual (WSL) | 2 OOR officers + 3 agents per company; sub-agents pass the KEL check |
| 10 | `DEEP-EXT-subagent.sh --oor-holder <alias>` for each sub-agent | Manual (WSL) | Steps 2–5 pass |

**Rollback:** delete `appconfig/org/`, `appconfig/generated/` and `build-org-config.js`; revert the flag edits from the backup copies taken before editing (or with git, if the folder is a repository). The old path never depended on them.

**Secrets:** `task-data/*-bran.txt` and `agent-brans.json` hold private seeds. Never paste their contents or command output that prints them.

## Risks and later phases

All scripts on the 4C/4D path are now read; no remaining risk needs a change outside the planned set.

| Item | Status after reading the code | Handling |
| --- | --- | --- |
| Registry clash for a second officer | Resolved: `createRegistry()` reuses an existing registry | No change |
| BRANs for new agents | Resolved with conditions: generator reads any config but needs `role` on every agent | Builder writes `role`; 4C passes `--config` |
| Sub-agent BRANs | Config path fixed to the 4D file | Add optional `--config` |
| Agent cards for new agents | Wrong template text and shared OOR SAID without changes | Optional `card` block + `--per-officer-oor` |
| New agents' card URL | No real service URL exists yet for CEO agents or `TommyTreasuryAgent` | Generator warns (existing); set `card.url` when those agents are deployed |
| ISO 5009 code missing for a role (e.g. CPO under Dutch law) | Open | Fine for the local stack; real issuance would need ECR (later phase) |
| 4D skip check sees old `task-data` | Open | Use `--force-base` on a fresh run |
| Sub-agent BRAN written in plain text to `.env` | Existing behaviour | Kept as is; flagged for a later security pass |
| Windows line endings in edited scripts | Open | `setup.sh` already runs dos2unix; keep LF |

**Later phases (not in this change):**

1. Escalation runtime in the trading agents: read `mandate`, `approvalLimit`, `escalatesTo`, `timeout`, `escalationPolicy`.
2. Decide and implement OOR credential verification during agent checks.
3. Multi-company onboarding and trade selection in the API server and UI, reusing the company files.
4. Optional: issue the `mandate` as a signed ACDC credential (GLEIF Agent Mandate Credential direction) once a schema exists.
5. ECR officers, if a company needs non-official roles.
