# ADR-001: Container topology and shared `task-data` for the vLEI / DynDiscounting stack

- **Status:** Accepted
- **Date:** 2026-07-25
- **Supersedes:** nothing
- **Applies to:** `vLEIEnh1/legentvLEI` (vLEI stack), `FINAGENTS/FINAGENTS1/DynDiscProject5/A2A/js` (DD agents)
- **Related:** `DESIGN-2/IMPLEMENTATION_PLAN.md`, `DESIGN-2/ARCHITECTURE_REVIEW.md`

> **Provenance note.** Decisions D1–D4 and D6 were verified directly against
> `docker-compose.yml`, `convert-docker-exec.sh`, `deploy.sh`, `server.js`,
> `api-server/.env` and `test-agent-verification-DEEP-EXT.sh` on 2026-07-25.
> The call-site *counts* (169 exec + 8 cp; 88 files converted; 51 remaining)
> come from `convert-docker-exec.sh --report` output recorded in the Phase 0
> session log, not from a re-run at authoring time. Re-run `--report` to confirm.

---

## Context

The vLEI stack runs as a Docker Compose project (`schema`, `witness`, `keria`,
`resource`, `verifier`, `vlei-verification`, `tsx-shell`, `vlei-shell`) on an
external network `vlei_workshop`. The DynDiscounting A2A agents (buyer, seller,
treasury, credit, inventory, logistics, audit-reporting) run separately as Node
processes and talk to the vLEI stack over HTTP.

Phase 1 containerises `api-server` — the Express service that exposes the
verification and IPEX endpoints. That single change forces four questions that
had never been written down.

### 1. `api-server` orchestrates other containers

`server.js` does not talk to KERIA directly for most work. It `exec`s bundled
shell scripts (`test-agent-verification-DEEP*.sh`,
`task-scripts/invoice/*.sh`) with `cwd` set to the repo root, and those scripts
in turn shell into the running containers.

Historically they used `docker compose exec <service>`. That form resolves the
target by asking the Compose engine to map *service name → running container*,
which needs a **compose project context**: the compose file, the project name,
and a working directory. A container holding only `/var/run/docker.sock` has
none of those. So every script the containerised `api-server` runs would break.

### 2. Not every service can be addressed by `docker exec`

`docker exec` needs a container **name**, not a service name. Only three
services declared `container_name` (`vlei_verification`, `tsx_shell`,
`vlei_shell`). `schema` and `keria` did not, so their containers had
Compose-generated names (`legentvlei-schema-1`), which are a function of the
project directory name and therefore not a stable contract.

### 3. `task-data/` is the integration surface, and it is addressed by absolute host path

`task-data/` holds every AID info file, delegate info file, credential info
file, and — critically — the per-agent BRAN files. It is already bind-mounted
into `tsx-shell` at `/task-data`.

The DD agents reach the same directory, but **by absolute Windows path**:

```
AGENT_BRAN_PATH=C:/SATHYA/.../legentvLEI/task-data/jupiterSellerAgent-bran.txt
```

DD `.env` files carry `AGENT_BRAN_PATH`, `KERIA_ADMIN_URL`, `KERIA_BOOT_URL`
and `KERIA_OOBI_BASE` — note there is **no** `AGENT_BRAN=<value>` and no
`KERIA_URL`. The agent reads its BRAN *by path* from the canonical file. Any
containerised consumer must therefore rewrite that path, not that value.

`api-server/.env` has the same disease in two more places:
`KRAM_SERVER_BRAN_PATH` and `KRAM_CALLER_INFO_PATHS` are `C:\SATHYA\...`
absolute paths, and its `KERIA_*_URL` values point at `localhost:390x`, which
is right from the Windows host and wrong from inside a container.

### 4. `api-server/node_modules` is Windows-built

It cannot be reused inside a Linux container. The naive fix — bind-mount the
repo over the app and shadow `node_modules` with an anonymous volume — works
until `package.json` changes, at which point the volume silently serves a stale
dependency tree.

---

## Decision

### D1 — Scripts address containers with `docker exec`, never `docker compose exec`

All call sites are converted by `convert-docker-exec.sh`, a re-runnable,
flag-driven, dry-run-by-default converter with a backup at
`.docker-exec-backup/`. Hand-editing ~94 files is neither reviewable nor
reversible; a script is both.

### D2 — `schema` and `keria` get an explicit `container_name`

`container_name: schema` and `container_name: keria` are added to
`docker-compose.yml`, and the remaining call sites are converted with
`--unnamed container-name`.

Rejected: `--unnamed ps-lookup`, which emits
`docker exec -i "$(docker compose ps -q schema)"`. That still requires a
compose project context and therefore re-introduces exactly the dependency D1
exists to remove. It would have "worked" on the host and failed only inside the
container — the worst possible failure mode.

**Migration consequence:** changing `container_name` changes container
identity, so the next `docker compose up` **recreates** `schema` and `keria`.
`keria-vol` is a *named* volume mounted at `/usr/local/var/keri`, so all AIDs,
habitats and credentials survive. Deploy with `./deploy.sh --preserve` (the
default). **Never `--fresh`** for this migration.

### D3 — The `api-server` image is self-contained at `/app`; the repo is bind-mounted at `/vlei-repo`

- Image: app code + Linux-built `node_modules` at `/app`, produced by `npm ci`
  during build. `.dockerignore` keeps the host `node_modules` and `.env` out of
  the build context.
- Runtime: the repo is bind-mounted read-write at `/vlei-repo`; the container
  locates it through a new `VLEI_DIR` environment variable.

`server.js` gains a one-line, backward-compatible override:

```js
const VLEI_DIR = process.env.VLEI_DIR
  ? path.resolve(process.env.VLEI_DIR)
  : path.join(__dirname, '..');   // unset => previous behaviour exactly
```

This is what makes the app/data split possible; without it `__dirname/..`
resolves to `/` inside the container.

Rejected: bind-mounting `./` over the app plus a `node_modules` shadow volume.
It is the common pattern, but the shadow volume is seeded from the image only
on first creation and then goes stale silently on every dependency change.

### D4 — Socket access is granted by `group_add` at run time, not by a group baked into the image

The docker socket's GID is a property of the **host**, so it cannot be known at
build time. Compose supplies it:

```yaml
user: "${UID:-1000}:${GID:-1000}"
group_add:
  - "${DOCKER_GID:-999}"
```

`user` matches `tsx-shell` so files written into the bind-mounted `task-data`
stay owned by the developer and interoperable between the two containers.
Find the GID with `stat -c '%g' /var/run/docker.sock`.

### D5 — `task-data/` stays a single shared directory; BRANs are addressed by container-relative path

`AGENT_BRAN_PATH` becomes `/task-data/<alias>-bran.txt` for containerised
consumers, and stays the Windows path for host-run DD agents. The BRAN file
remains the single source of truth — the agent reads it by path, so relocating
it is a configuration change, not a code change.

This is what makes the previously-open **Option B** (isolating BRANs onto a
private volume per agent, rather than one shared `task-data`) *feasible without
touching agent code*: repoint `AGENT_BRAN_PATH` and mount the private volume.
Option B is **not adopted now** — see Open Questions.

### D6 — The `api-server` image ships the docker CLI **without** the compose plugin

Deliberate. If a script ever regresses to `docker compose exec`, it fails
immediately and loudly inside the container rather than half-working.

### D7 — `no_cache: true` is not copied onto the new service

`tsx-shell` and `vlei-verification` both set `build.no_cache: true`, which
forces a full image rebuild on every `docker compose up`. That is the reason
those two are slow to start. The new service does not inherit it.

---

## Consequences

**Positive**

- Scripts become context-free: identical behaviour from WSL, from PowerShell,
  and from inside a container.
- `container_name` makes `docker exec`, `docker inspect` and `docker logs`
  targets stable and greppable, independent of the project directory name.
- The app/data split removes the Windows/Linux `node_modules` conflict class
  entirely rather than working around it.
- `keria-vol` survives the migration, so the month-old Jupiter/Tommy/Acme AIDs
  are preserved.

**Negative / accepted costs**

- `container_name` makes these services non-scalable (`--scale schema=2` now
  fails) and globally unique per Docker host. Both are acceptable: this is a
  single-host developer stack with singleton services.
- `api-server` source changes now require an image rebuild. Mitigation for
  active development: bind-mount `./api-server/server.js` over `/app/server.js`
  in a compose override file.
- Mounting `/var/run/docker.sock` grants the container effective root on the
  host. Acceptable for a local developer stack; **not** acceptable if this is
  ever deployed multi-tenant. Flagged, not solved.
- Migration recreates two containers, so there is a brief window where AIDs are
  unreachable.

**Risk that is NOT yet resolved — line endings**

The repo carries pervasive CRLF/LF inconsistency (~700 files show as modified
repo-wide; `git diff --ignore-cr-at-eol` is the standard review workaround). On
Windows this is cosmetic. Inside a Linux container, a `#!/bin/bash` script with
CRLF line endings **fails at the shebang**. Line-ending normalisation was
previously a low-priority backlog item; **D3 promotes it to a Phase 1
blocker.**

---

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Leave the 51 `docker compose exec` sites for `schema`/`keria` | Works from the host, fails inside `api-server`. Blocks Phase 1 outright. |
| `--unnamed ps-lookup` | Keeps the compose-context dependency D1 removes; fails only in the container. |
| Run `api-server` on the host, containerise nothing | Preserves the Windows `node_modules` problem and the host-path coupling; defers, does not solve. |
| Give `api-server` a Docker-in-Docker sidecar instead of the host socket | Heavier, and the target containers live on the host daemon — DinD cannot see them. |
| Replace shell-outs with direct signify-ts calls from `server.js` | The correct long-term architecture, but a rewrite of every task script. Out of scope for Phase 1. |
| Run `api-server` as root to simplify socket access | Root-owned files in `task-data` break `tsx-shell`, which runs as `${UID}:${GID}`. |

---

## Open questions

1. **Option B (per-agent BRAN isolation).** D5 establishes that it is feasible
   via `AGENT_BRAN_PATH` alone. Not adopted — decide once the DD agents are
   themselves containerised.
2. **DD agent containerisation.** DD agents still run on the host with Windows
   `AGENT_BRAN_PATH` values. Until they move, `task-data` must remain reachable
   by both a Windows path and a container path.
3. **Socket exposure.** If this stack ever leaves the developer laptop, replace
   the raw socket mount with a scoped proxy (e.g. an allow-listed socket proxy
   restricted to `exec` on named containers).
4. **Secrets.** `PERSON_SALT` is hardcoded in 5 files and `AgentPass123` remains
   in 7 `task-scripts/*.sh`. DD agent `.env` files contain live third-party
   credentials that were pasted into a chat log and **must be rotated**.
   Tracked separately; this ADR does not address secret handling.

---

# Addendum A - 2026-08-03 - hosting-readiness pass

**Status:** Accepted. Amends D5; resolves Open Questions 2 and 3.

All changes below were verified against a live Docker stack on 2026-08-03
except where explicitly marked otherwise.

## D8 - `task-data` moves from a host bind mount to an external Docker volume

**Supersedes the storage half of D5.** D5's contract - *"BRANs are addressed by
container-relative path"* - is unchanged and is precisely what made this
possible without touching agent code. What changes is what sits behind that
path.

### Context that changed since the original ADR

Open Question 2 said DD agents still ran on the host with Windows
`AGENT_BRAN_PATH` values, and that *"until they move, `task-data` must remain
reachable by both a Windows path and a container path."*

**The DD agents have since been containerised** (`DynDiscProject5/A2A/js/
docker-compose.yml`, services `dd-seller`, `dd-buyer`, `dd-treasury`). Nothing
outside Docker reads `task-data` any more. The dual-addressing requirement is
therefore obsolete, and with it the last reason to keep a bind mount.

The bind mount was actively blocking hosting:

- A bind mount cannot span machines, so both compose projects were pinned to a
  single workstation.
- The DD side addressed it by absolute laptop path
  (`/mnt/c/SATHYA/.../legentvLEI/task-data`), which exists on no server.
- BRAN private-key material sat loose on the host filesystem.

### Decision

One **external** Docker volume, default name `vlei_task_data`, mounted by both
compose projects:

| Container | Mount point | Why that path |
|---|---|---|
| `tsx_shell` | `/task-data` | unchanged from the bind-mount era |
| `api_server` | `/vlei-repo/task-data` | resolved via `VLEI_DIR`, per D3 |
| `dd_seller`, `dd_buyer` | `/task-data` | matches the `AGENT_*_PATH` values |
| `dd_treasury` | *not mounted* | has no vLEI identity to load, so mounting key material into it would be gratuitous exposure |

`external: true` is **mandatory, not stylistic**. Without it each compose
project creates its own project-prefixed volume (`legentvlei_task-data-vol` vs
`js_task-data-vol`) and the two stacks silently read different data - a
failure mode that looks like corrupted identities rather than a mount problem.
This is the same reasoning that already applies to the external `vlei_workshop`
network.

The name is overridable per environment via `VLEI_TASK_DATA_VOLUME`, which must
be set identically for both projects.

### Supporting tooling

- `legentvLEI/migrate-taskdata-to-volume.sh` - one-time seeding of the volume
  from the existing host directory. Dry-run by default (matching
  `convert-docker-exec.sh`), refuses to overwrite a non-empty volume without
  `--force`, never deletes the source, and verifies file and BRAN counts match
  before reporting success. `chown`s to the container `user:` UID/GID, without
  which the agents can read but not write.
- `legentvLEI/taskdata.sh` - host access to the volume (`ls`, `tree`, `cat`,
  `size`, `export`, `import`, `shell`). Necessary because volume contents are
  no longer browsable in Explorer.
- `deploy.sh` step 1 now creates the volume alongside the network, and warns
  loudly if the volume is empty while a populated host `./task-data` still
  exists - i.e. the migration was never run.

### Consequences

**Positive**

- The stack becomes host-portable: no absolute host paths in either compose
  file for identity data.
- Key material moves out of the host filesystem into Docker-managed storage.
- `docker compose down --volumes` (`deploy.sh --fresh`) does **not** delete
  external volumes, so BRANs now survive a `--fresh` teardown that destroys
  `keria-vol`. Note the asymmetry: after `--fresh` you keep the BRANs but lose
  the AIDs they address, so the workflow must still be re-run.

**Negative / accepted costs**

- `task-data` is no longer browsable or editable from the host without
  `taskdata.sh`. This is the main ergonomic regression and it is deliberate.
- The volume must exist before `docker compose up` in either project.
  `deploy.sh` handles this for the normal path; anyone running `docker compose
  up` directly in the DD repo first will get "external volume not found".
- Migration is a manual one-time step. Skipping it produces an empty volume and
  a stack with no resolvable identities - hence the explicit warning in
  `deploy.sh`.

### Deliberately NOT included in D8

- **`api-server/.kram-server-bran.txt`** is still a host bind mount. It is the
  same class of problem (key material on the host) and should follow, but the
  create-if-missing semantics in `kram-verify-middleware.js` were not audited
  in this pass, so it was left alone rather than changed on an assumption.
- **`src/audits/` and `src/escalations/`** in the DD repo remain host bind
  mounts. They hold runtime business records (pricing, LEIs, counterparty
  terms) and belong in a volume for a hosted deployment, but the repo-root
  `Test-AuditV6-Iter*.ps1` and `Migrate-Escalations-To-Audits-Iter1.ps1`
  scripts read them by host path and would break. Separate decision.

## Open Question 3 - RESOLVED

> *"If this stack ever leaves the developer laptop, replace the raw socket
> mount with a scoped proxy (e.g. an allow-listed socket proxy restricted to
> `exec` on named containers)."*

Done. `docker-compose.yml` now runs `tecnativa/docker-socket-proxy` as service
`docker-socket-proxy`. `api-server` reaches Docker only through it, via
`DOCKER_HOST: tcp://docker-socket-proxy:2375`; the raw `/var/run/docker.sock`
mount and the `group_add: DOCKER_GID` block from **D4 are removed from
`api-server`**. Only `VERSION`, `PING`, `CONTAINERS`, `EXEC` and `POST` are
allowed; every other category is explicitly `0`.

Verified on 2026-08-03: `docker exec -i tsx_shell` succeeds from inside
`api_server`, and a full DEEP-EXT delegation verification completed through the
proxy during a live negotiation.

**Known limitation:** the proxy filters by Docker API *category*, not by
container name. `EXEC=1` therefore permits exec into **any** container on the
host, not just `tsx_shell`. This is inherent to the image and is a large
reduction in blast radius (no image pulls, no volume access, no container
creation) rather than the container-scoped restriction Open Question 3
literally asked for. Container-scoped exec would need a purpose-built proxy.

## Still open after this addendum

- Open Question 1 (per-agent BRAN isolation, "Option B") - still not adopted.
  D8 makes it *easier*: it is now one volume per agent plus a repointed
  `AGENT_BRAN_PATH`, with no host paths involved.
- Open Question 4 (secrets) - unchanged and now the oldest open item.
  `PERSON_SALT`, `AgentPass123`, and the DD `.env` third-party credentials all
  still need rotation.
- **Line endings** (the "Risk that is NOT yet resolved" section) - still
  unaudited. The new `.sh` files added by this addendum are written LF-only.
- Four DD agents - credit, inventory, logistics, audit-reporting - plus
  `engine-decide-server` have **no compose services at all** and therefore no
  deployment path. This is the largest remaining structural gap for hosting.
