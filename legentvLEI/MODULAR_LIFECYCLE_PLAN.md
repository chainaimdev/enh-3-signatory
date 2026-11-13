# Modular vLEI Lifecycle Management — Design Plan

**Project:** DynDiscMiniProject2 / legentvLEI
**Status:** Design plan only — no project files have been changed
**Scope:** Splitting the monolithic 4D workflow into independent, reusable lifecycle scripts

---

## 1. Purpose

The current workflow runs everything as one monolithic pipeline through
`run-all-buyerseller-4D-with-subdelegation.sh` (which itself wraps
`run-all-buyerseller-4C-with-agents.sh`).

This plan splits that pipeline into **five modular lifecycle scripts plus one
one-time bootstrap**, so that companies, officers, agents, and sub-agents can each
be added or removed independently — without re-running the root-of-trust or QVI
setup.

The goal: take the proven 4D workflow and turn each layer into a reusable
add/remove operation, so you can grow the system one company, one officer, one
agent at a time, on demand.

---

## 2. Files I Read to Ground This Plan

This plan is based on a direct read of:

- `run-all-buyerseller-4C-with-agents.sh` (the real workflow engine)
- `run-all-buyerseller-4D-with-subdelegation.sh` (the sub-delegation wrapper)
- `DEEP-EXT-subagent.sh` and the three DEEP verification scripts
- `appconfig/configBuyerSellerAIAgent1.json`
- `appconfig/configBuyerSellerAIAgent1-with-subdelegation.json`
- `generate-unique-agent-brans.sh`
- `generate-subagent-brans.sh`
- `task-scripts/le/*`, `task-scripts/person/*`, `task-scripts/agent/*`,
  `task-scripts/subagent/*`
- `task-scripts/subagent/subagent-delete-from-keria.sh` (existing delete pattern)
- The current `task-data/` directory layout

Nothing in this plan was inferred from training data — it is all from the files
in the repo.

---

## 3. Key Facts That Shape the Design

Four facts that matter before deciding architecture:

### 3.1 The config file is the brain

`appconfig/configBuyerSellerAIAgent1-with-subdelegation.json` drives the entire
workflow. It is a nested tree:

```
organizations → persons → agents → subAgents
```

Any add/remove operation must touch this file **and** the underlying KERIA state,
or the two will drift out of sync.

### 3.2 State lives in two places

- **Inside KERIA** (the Docker container) — the actual cryptographic identities,
  credentials, and event logs.
- **In `task-data/`** — JSON and text files that act as a cache and quick
  reference. The pattern is:
  - `{alias}-info.json` — full state of an entity
  - `{alias}-aid.txt` — just the AID string
  - `{agentAlias}-bran.txt` — the agent's cryptographic seed
  - `{agentAlias}-delegate-info.json` — delegation metadata
  - Shared registries: `agent-brans.json`, `subagent-brans.json`

### 3.3 The pieces already exist as small task-scripts

Under `task-scripts/le/`, `task-scripts/person/`, `task-scripts/agent/`, and
`task-scripts/subagent/` there are individual scripts: create AID, resolve OOBI,
issue credential, admit, present, verify, delete.

The new lifecycle scripts proposed below are **smart orchestrators** that call
the right subset of these for one entity. They are not rewrites — they coordinate
the existing low-level pieces.

### 3.4 A delete pattern already exists

`task-scripts/subagent/subagent-delete-from-keria.sh` already uses SignifyTS to
delete a local KERIA identifier. The same pattern extends naturally to agents,
officers, and LEs. This is the foundation for the "remove" half of every script.

---

## 4. The Plan — Five Lifecycle Scripts + One Bootstrap

The recommendation is **one script per entity type**, each supporting both `add`
and `remove` modes — rather than ten separate scripts. This keeps the file count
manageable and removes duplicated boilerplate.

### 4.0 Prerequisite: `bootstrap-root-qvi.sh` (run once per environment)

Sets up the GEDA root and the QVI delegated identity. This is exactly Section 2
of the existing 4C script (everything before any organization is created).

After this runs once, you never touch root or QVI again — matching the
requirement that there should be no changes to root or QVI in the lifecycle
scripts. The five management scripts below all assume this bootstrap has already
been completed.

---

### 4.1 Script 1 — `manage-company.sh add|remove`

Adds or removes a **company** (Legal Entity) under the already-bootstrapped QVI.

**Add mode**

- Inputs: a short ID, a display name, the LEI, and an alias.
- Validates the LEI is not already registered in the config.
- Appends a new `organizations[]` entry to the config.
- Runs the LE chain: create LE AID, exchange OOBIs between LE and QVI, create
  the QVI registry if not present, QVI issues the LE credential, LE admits it,
  LE presents it to Sally the verifier.
- Saves an audit entry to `task-data/`.
- **Does NOT** create any officer or agent — produces an empty company shell,
  ready for officers to be added next.

**Remove mode**

- Safety: refuses if the company still has officers or agents under it (must
  remove those first), unless `--force` is passed.
- Deletes the LE identifier from KERIA via SignifyTS (the same pattern as the
  existing sub-agent delete).
- Removes the company entry from the config.
- Cleans up `{orgAlias}-info.json` and `{orgAlias}-aid.txt`.
- Optionally archives the removed files under `task-data/archive/` instead of
  deleting them outright.

---

### 4.2 Script 2 — `manage-officer.sh add|remove`

Adds or removes an **officer** (Person + OOR credential) within an existing
company.

**Add mode**

- Inputs: company alias (must exist), officer alias, legal name, official role.
- Appends a new `persons[]` entry under the right organization in the config.
- Runs `person-aid-create`, then the full OOBI exchange (Person ↔ LE,
  Person ↔ QVI, Person ↔ Verifier).
- Creates the LE registry if not present.
- Runs the standard **two-step OOR issuance**:
  - LE issues OOR_AUTH to QVI
  - QVI admits OOR_AUTH
  - QVI issues OOR to the Person
  - Person admits OOR
- Person presents the OOR credential to Sally.
- **Does NOT** create any agent. The officer exists and can later delegate to
  an agent.

> Note: "OOR creates every time" — confirmed correct. Each officer needs their
> own OOR credential chain issued at the time they are added.

**Remove mode**

- Safety: refuses if the officer still has agents delegated under them.
- Optionally revokes the OOR credential (TEL revocation) if `--revoke` is
  passed — see caveats section for why this is opt-in, not default.
- Deletes the Person identifier from KERIA.
- Removes the `persons[]` entry from config.
- Cleans up `{personAlias}-info.json` and `{personAlias}-aid.txt`.

---

### 4.3 Script 3 — `manage-agent.sh add|remove`

Adds or removes an **AI agent** delegated by an existing officer.

Matches the assumed model: one agent typically per officer, with multiple
sub-agents underneath. A cryptographic constraint of KERI is that an agent
must be delegated **by an officer** (Person AID), not by a company directly.

**Add mode**

- Inputs: company alias, officer alias (must exist), new agent alias, agent
  type, `canDelegate` flag (true/false), and a scope label.
- Appends a new `agents[]` entry under the right person in the config.
- Generates a fresh unique 256-bit BRAN for the agent and adds it to
  `task-data/agent-brans.json` (see caveat B about the existing hardcoded
  function in the BRAN generator).
- Runs `agent-delegate-with-unique-bran` so the officer delegates a new agent
  AID.
- Resolves the agent's OOBIs to QVI, LE, and Sally.
- Runs the delegation verification.
- **Does NOT** create any sub-agent, credential registry, or credential. Pure
  identity plus delegation.

**Remove mode**

- Safety: refuses if the agent still has sub-agents under it.
- Deletes the agent identifier from KERIA via SignifyTS.
- Cleans up `{agentAlias}-info.json`, `{agentAlias}-bran.txt`,
  `{agentAlias}-delegate-info.json`.
- Removes the BRAN entry from `agent-brans.json`.
- Removes the `agents[]` entry from config.

---

### 4.4 Script 4 — `manage-subagent.sh add|remove`

Adds or removes a **sub-agent** under an existing agent. This generalizes the
4D-style sub-delegation so it works for any agent on demand, not just the
hardcoded Jupiter Treasury example.

**Add mode**

- Inputs: parent agent alias (must exist and must have `canDelegate: true`),
  new sub-agent alias, scope label.
- Validates the parent has delegation rights.
- Appends a new `subAgents[]` entry to that agent in the config.
- Generates a unique BRAN and adds it to `task-data/subagent-brans.json`.
- Runs `subagent-delegate-with-unique-bran` (parent agent delegates to the
  new sub-agent).
- Resolves sub-agent's OOBIs to QVI, LE, and Sally.
- Verifies the delegation.
- **Enforces** the scope-narrowing rule from the existing 4D trust tree — a
  sub-agent's scope must be a subset of its parent's scope. Currently this rule
  is only documented in the trust tree; the new script can actually enforce it.

**Remove mode**

- Already partially exists: the script invokes the existing
  `subagent-delete-from-keria.sh`, then cleans the config entry, the BRAN
  file, and the info files.
- This is the cheapest of the five scripts to implement because the KERIA-side
  delete is already proven.

---

### 4.5 Script 5 — `manage-status.sh` (read-only inventory)

A **read-only** inventory tool that lists every entity currently in the system,
built by scanning `task-data/`.

It shows: companies, their officers, their agents, their sub-agents — with each
entity's AID and verification status.

This is included as a first-class script (not a "bonus") because it is the
single most useful tool for safely operating the four add/remove scripts above.
You will want it before every add (to see what already exists) and before every
remove (to see what depends on what).

It is also the cheapest script to build and the lowest risk, so it is a good
first deliverable.

---

## 5. Cross-Cutting Design Choices

Five decisions to lock in once, applied uniformly to all five scripts.

### 5.1 Config is the single source of truth

- Every `add` updates the config **first**, then KERIA.
- Every `remove` updates KERIA **first**, then the config.
- This ordering ensures that accidental crashes never leave the config claiming
  something exists when KERIA does not have it (or vice versa).

### 5.2 Idempotent and resumable

Every script first checks "does this entity already exist?"

- If yes for `add`: skip and report (no error, no half-state).
- If no for `remove`: skip and report.

This matches how the existing 4D script already handles "4C already done — skip."

### 5.3 Consistent flag interface across all five scripts

| Flag | Purpose |
|------|---------|
| `--dry-run` | Show what *would* happen without doing it |
| `--config path/to/config.json` | Target a specific config file (the repo already has three different config files in `appconfig/`) |
| `--force` | Override safety blocks; use deliberately |
| `--json` | Structured output for the API server to consume |

### 5.4 Lifecycle metadata in the config

Add a small per-entity block to the config tree capturing:

- `createdAt`
- `createdBy`
- `status` (`active`, `archived`, `removed`)

The current config only stores the static structural tree. Adding lifecycle
metadata makes audits, rollback, and reporting possible.

### 5.5 Wire to existing task-scripts, do not rewrite

`manage-officer.sh` should call the existing `person-aid-create.sh`,
`le-acdc-issue-oor-auth.sh`, etc. The new scripts are **coordinators**, not
reimplementations. Any improvements to the low-level task-scripts automatically
benefit the new lifecycle layer. Keeps the codebase consistent.

### 5.6 Removal defaults: local KERIA delete + archive

By default, "remove" means **stop using locally + clean up files**. True
credential revocation is opt-in via `--revoke`. See caveat A below for why this
distinction matters.

---

## 6. Honest Caveats

Three real constraints to know before building.

### 6.1 Caveat A — KERI history is permanently immutable

When you "remove" an agent, you are locally deleting its alias from KERIA. The
KEL (Key Event Log) events still exist and are still anchored in the parent's
KEL on the witnesses.

"Remove" really means: stop using locally and clean up files.

If you ever need to genuinely **revoke** a credential (so verifiers reject it
forever), that is a different operation — TEL-based credential revocation
through the issuing registry. Recommended: build the simple local-delete path
first, add `--revoke` as a follow-up enhancement.

### 6.2 Caveat B — A hardcoded function in the current BRAN generator will block flexibility

In `generate-unique-agent-brans.sh`, the function `get_keria_alias` literally
checks:

> if org_name contains "Jupiter" → keriaAlias = jupiterSellerAgent
> else if org_name contains "Tommy" → keriaAlias = tommyBuyerAgent
> else → unknownAgent

If a third company is added, this function will assign `unknownAgent` and the
workflow will break.

**Fix this first.** Replace the function with one that either:

- (a) reads the agent alias directly from the config (which it already has), or
- (b) makes `keriaAlias` an explicit field in the config tree.

This is the **single most important fix** to make before any of the five
lifecycle scripts will work for arbitrary new companies.

### 6.3 Caveat C — The current 4C orchestrator overwrites some shared files

Files like `task-data/le-info.json` and `task-data/le-aid.txt` are overwritten
each time a new LE is processed in the org loop. Only the **per-alias** files
(`Jupiter_Knitting_Company-info.json`, `Tommy_Hilfiger_Europe-info.json`) are
truly per-entity.

The new lifecycle scripts must rely **only** on per-alias files and ignore the
shared `le-info.json` / `le-aid.txt` files — otherwise they will read stale
state. This is a pre-existing quirk in the codebase; the new scripts should
sidestep it, not propagate it.

---

## 7. Recommended Build Order

This order produces something usable at every step.

| Order | Deliverable | Why now |
|-------|-------------|---------|
| 1 | Fix the hardcoded `get_keria_alias` in `generate-unique-agent-brans.sh` | Half a day of work; unblocks everything else. Without this, no new company can ever work. |
| 2 | `bootstrap-root-qvi.sh` | Extracted from Section 2 of the existing 4C script. One-time setup, low risk. |
| 3 | `manage-status.sh` (read-only) | Cheapest to build, highest feedback value. Use it constantly while building the others. |
| 4 | `manage-company.sh` (add then remove) | Foundation — companies must exist before officers. |
| 5 | `manage-officer.sh` | Builds on companies. |
| 6 | `manage-agent.sh` | Builds on officers. |
| 7 | `manage-subagent.sh` | Already has a working delete pattern; this is mostly composition. |

At the end of this order, the original `run-all-buyerseller-4D-with-subdelegation.sh`
becomes equivalent to: "run bootstrap once, then loop through config calling
`manage-company` / `manage-officer` / `manage-agent` / `manage-subagent` for each
entry."

Same workflow, composed from reusable pieces — which is exactly the modularity
goal.

---

## 8. What's Deliberately NOT in This Plan

To keep scope honest:

- **No changes to root or QVI workflow.** Bootstrap is a one-time extraction of
  the existing Section 2.
- **No changes to credential schemas.** The invoice schema and SAIDification
  process remain as-is.
- **No new Docker services.** Only orchestration shell scripts.
- **No replacement of the existing task-scripts.** They are reused as-is.
- **No new API endpoints by default.** The existing `api-server/server.js`
  already has the pattern; new endpoints exposing these lifecycle scripts can
  be added later as a follow-up.

---

## 9. Quick Reference — Script Summary Table

| Script | Modes | Touches Config | Touches KERIA | Safety Checks |
|--------|-------|----------------|---------------|---------------|
| `bootstrap-root-qvi.sh` | run-once | No | Yes (GEDA + QVI) | Skips if already done |
| `manage-company.sh` | add, remove | Yes | Yes (LE) | Blocks remove if officers exist |
| `manage-officer.sh` | add, remove | Yes | Yes (Person + OOR) | Blocks remove if agents exist |
| `manage-agent.sh` | add, remove | Yes | Yes (Agent + BRAN) | Blocks remove if sub-agents exist |
| `manage-subagent.sh` | add, remove | Yes | Yes (Sub-agent + BRAN) | Validates parent `canDelegate` |
| `manage-status.sh` | read-only | No | No (reads task-data) | None — safe to run anytime |

---

## 10. Next Steps

When ready to execute this plan, the suggested first actions are:

1. Delete the partial `MODULAR_LIFECYCLE_PLAN.md` stub that was accidentally
   created earlier in the project root.
2. Save this full plan in the project (suggested path: `docs/` folder).
3. Begin with Order step 1 from Section 7: fix the hardcoded BRAN generator.

---

*End of plan.*
