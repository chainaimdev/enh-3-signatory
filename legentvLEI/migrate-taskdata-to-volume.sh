#!/bin/bash
################################################################################
# migrate-taskdata-to-volume.sh - one-time migration of ./task-data from a host
# bind mount into a Docker-managed named volume.
#
# WHY THIS EXISTS
#   task-data holds every agent's BRAN (KERI private-key-equivalent passcode),
#   AID info file and credential info file. It used to be a host bind mount:
#     legentvLEI/docker-compose.yml   ->  ./task-data:/task-data
#     DD/docker-compose.yml           ->  /mnt/c/SATHYA/.../task-data:/task-data
#   That made the stack un-hostable. A bind mount cannot span machines, the
#   absolute path exists only on one laptop, and the key material sat loose on
#   the host filesystem.
#
#   Both compose files now mount an EXTERNAL Docker volume (default name
#   `vlei_task_data`) instead. This script creates that volume and copies the
#   existing task-data into it, so the month-old Jupiter/Tommy/Acme AIDs keep
#   working. The AIDs themselves live in keria-vol; these files are the BRANs
#   and metadata that address them, so losing them means losing access to
#   identities that still exist inside KERIA.
#
# SAFETY
#   - DRY RUN IS THE DEFAULT. Nothing is written without --apply. This mirrors
#     convert-docker-exec.sh, which is also dry-run-by-default, and is
#     deliberate for a script that moves private key material.
#   - Refuses to overwrite a volume that already has contents unless --force.
#   - NEVER deletes the source directory. After a successful migration the host
#     ./task-data is left untouched as a cold backup. Remove it yourself, once
#     you have confirmed the stack works, with:  rm -rf ./task-data
#     (and note it is git-ignored, so it was never committed.)
#
# USAGE
#   ./migrate-taskdata-to-volume.sh [flags]
#
# FLAGS
#   --apply             Actually perform the migration. Without this, the
#                       script only prints what it would do.
#   --volume NAME       Target volume name.
#                       Default: $VLEI_TASK_DATA_VOLUME, else vlei_task_data.
#                       Must match VLEI_TASK_DATA_VOLUME used by BOTH compose
#                       projects, or the two stacks read different data.
#   --source DIR        Source directory to copy from. Default: ./task-data
#   --uid N             Owner UID applied inside the volume. Default: $UID or
#                       current user's UID. Must match the `user:` value the
#                       containers run as, or they cannot write.
#   --gid N             Owner GID applied inside the volume. Default: current
#                       user's GID.
#   --force             Overwrite a non-empty target volume. Destructive.
#   --verify            Only inspect the volume and report contents; make no
#                       changes. Can be combined with --volume.
#   --helper-image IMG  Image used for the copy. Default: alpine:3.20
#   -h|--help           Show this help.
#
# EXAMPLES
#   ./migrate-taskdata-to-volume.sh                    # dry run, see the plan
#   ./migrate-taskdata-to-volume.sh --apply            # do it
#   ./migrate-taskdata-to-volume.sh --verify           # what is in there now?
#   ./migrate-taskdata-to-volume.sh --apply --force    # re-seed, overwriting
#   VLEI_TASK_DATA_VOLUME=vlei_task_data_staging \
#     ./migrate-taskdata-to-volume.sh --apply          # separate environment
################################################################################

set -euo pipefail

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

################################################################################
# Defaults + flag parsing
################################################################################
VOLUME_NAME="${VLEI_TASK_DATA_VOLUME:-vlei_task_data}"
SOURCE_DIR="./task-data"
HELPER_IMAGE="alpine:3.20"

################################################################################
# Ownership target - resolve the way COMPOSE does, not from the invoking user.
#
# The containers run as:
#   tsx-shell   user: "${UID}:${GID}"
#   api-server  user: "${UID:-1000}:${GID:-1000}"
#   dd-*        user: "${UID:-1000}:${GID:-1000}"
# and compose resolves ${UID}/${GID} from the .env file sitting next to
# docker-compose.yml (this repo ships one: UID=1000, GID=1000).
#
# Using `id -u` here would be WRONG whenever the script is run as root - which
# is the normal case in WSL, where the default shell user IS root. That would
# chown the volume to 0:0 while the containers run as 1000:1000, leaving them
# able to read but NOT write. The vLEI task scripts DO write new info files
# into task-data, so the failure would surface later as unexplained credential
# issuance errors rather than an obvious permissions error.
#
# Resolution order: --uid/--gid flag > environment > ./.env > 1000.
################################################################################
env_file_value() {
    # env_file_value KEY FILE - print KEY's value from a dotenv file, or nothing.
    local key="$1" file="$2"
    [ -f "$file" ] || return 0
    grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null \
        | tail -1 \
        | sed -E "s/^[[:space:]]*${key}=//; s/[[:space:]]*$//; s/^\"//; s/\"$//" \
        | tr -d '\r'
}

COMPOSE_ENV_FILE="./.env"
TARGET_UID="${UID_OVERRIDE:-}"
TARGET_GID="${GID_OVERRIDE:-}"
[ -n "$TARGET_UID" ] || TARGET_UID="$(env_file_value UID "$COMPOSE_ENV_FILE")"
[ -n "$TARGET_GID" ] || TARGET_GID="$(env_file_value GID "$COMPOSE_ENV_FILE")"
[ -n "$TARGET_UID" ] || TARGET_UID=1000
[ -n "$TARGET_GID" ] || TARGET_GID=1000
UID_SOURCE="resolved from ${COMPOSE_ENV_FILE} / compose default"
APPLY=0
FORCE=0
VERIFY_ONLY=0

usage() {
    sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --apply)        APPLY=1;              shift ;;
        --force)        FORCE=1;              shift ;;
        --verify)       VERIFY_ONLY=1;        shift ;;
        --volume)       VOLUME_NAME="${2:?--volume needs a value}";       shift 2 ;;
        --source)       SOURCE_DIR="${2:?--source needs a value}";        shift 2 ;;
        --uid)          TARGET_UID="${2:?--uid needs a value}"; UID_SOURCE="--uid flag"; shift 2 ;;
        --gid)          TARGET_GID="${2:?--gid needs a value}"; UID_SOURCE="--gid flag"; shift 2 ;;
        --helper-image) HELPER_IMAGE="${2:?--helper-image needs a value}"; shift 2 ;;
        -h|--help)      usage ;;
        *)
            echo -e "${RED}ERROR: unknown argument: $1${NC}" >&2
            echo "Run '$0 --help' for usage." >&2
            exit 1
            ;;
    esac
done

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║      task-data  ->  Docker volume migration                  ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

################################################################################
# Pre-flight
################################################################################
if ! command -v docker > /dev/null 2>&1; then
    echo -e "${RED}  ✗ docker binary not found on PATH.${NC}" >&2
    exit 1
fi

if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}  ✗ docker CLI found, but the Docker daemon is not reachable.${NC}" >&2
    echo -e "${YELLOW}    On Windows: start Docker Desktop, and if you are in WSL check${NC}" >&2
    echo -e "${YELLOW}    Settings > Resources > WSL Integration is enabled for this distro.${NC}" >&2
    exit 1
fi
echo -e "${GREEN}  ✓ Docker daemon reachable${NC}"

# volume_exists <name>
volume_exists() {
    docker volume inspect "$1" > /dev/null 2>&1
}

# volume_file_count <name> - number of entries in the volume root, 0 if absent.
volume_file_count() {
    docker run --rm -v "$1":/v "$HELPER_IMAGE" sh -c 'ls -A /v 2>/dev/null | wc -l' 2>/dev/null | tr -d '[:space:]'
}

################################################################################
# --verify: report and exit
################################################################################
if [ "$VERIFY_ONLY" -eq 1 ]; then
    echo ""
    echo -e "${YELLOW}Verifying volume '${VOLUME_NAME}'...${NC}"
    if ! volume_exists "$VOLUME_NAME"; then
        echo -e "${RED}  ✗ Volume '${VOLUME_NAME}' does not exist.${NC}"
        echo -e "${YELLOW}    Run this script with --apply to create and seed it.${NC}"
        exit 1
    fi
    COUNT="$(volume_file_count "$VOLUME_NAME")"
    echo -e "${GREEN}  ✓ Volume exists${NC}  (${COUNT} entries at volume root)"
    echo ""
    echo -e "${BLUE}  Contents:${NC}"
    docker run --rm -v "$VOLUME_NAME":/v "$HELPER_IMAGE" \
        sh -c 'ls -la /v' | sed 's/^/    /'
    echo ""
    echo -e "${BLUE}  BRAN files present:${NC}"
    docker run --rm -v "$VOLUME_NAME":/v "$HELPER_IMAGE" \
        sh -c 'ls -1 /v/*-bran.txt 2>/dev/null || echo "(none)"' | sed 's/^/    /'
    echo ""
    exit 0
fi

################################################################################
# Resolve + validate source
################################################################################
if [ ! -d "$SOURCE_DIR" ]; then
    echo -e "${RED}  ✗ Source directory not found: ${SOURCE_DIR}${NC}" >&2
    echo -e "${YELLOW}    Run this from the legentvLEI repo root, or pass --source.${NC}" >&2
    exit 1
fi

SOURCE_ABS="$(cd "$SOURCE_DIR" && pwd)"
SOURCE_COUNT="$(find "$SOURCE_ABS" -maxdepth 1 -mindepth 1 | wc -l | tr -d '[:space:]')"

if [ "$SOURCE_COUNT" -eq 0 ]; then
    echo -e "${RED}  ✗ Source directory is empty: ${SOURCE_ABS}${NC}" >&2
    echo -e "${YELLOW}    Nothing to migrate. If the AIDs were never generated, run the${NC}" >&2
    echo -e "${YELLOW}    4D workflow first, then re-run this script.${NC}" >&2
    exit 1
fi

echo -e "${GREEN}  ✓ Source: ${SOURCE_ABS}${NC}  (${SOURCE_COUNT} entries)"

BRAN_COUNT="$(find "$SOURCE_ABS" -maxdepth 1 -name '*-bran.txt' | wc -l | tr -d '[:space:]')"
echo -e "${GREEN}  ✓ BRAN files to migrate: ${BRAN_COUNT}${NC}"

################################################################################
# Target volume state
################################################################################
echo ""
echo -e "${YELLOW}Target volume: ${VOLUME_NAME}${NC}"

VOLUME_PREEXISTS=0
TARGET_COUNT=0
if volume_exists "$VOLUME_NAME"; then
    VOLUME_PREEXISTS=1
    TARGET_COUNT="$(volume_file_count "$VOLUME_NAME")"
    echo -e "${YELLOW}  - Volume already exists (${TARGET_COUNT} entries)${NC}"
    if [ "$TARGET_COUNT" -gt 0 ] && [ "$FORCE" -eq 0 ]; then
        echo ""
        echo -e "${RED}  ✗ REFUSING TO OVERWRITE: volume '${VOLUME_NAME}' is not empty.${NC}" >&2
        echo -e "${YELLOW}    It already holds ${TARGET_COUNT} entries. Overwriting could destroy${NC}" >&2
        echo -e "${YELLOW}    BRANs for AIDs that still exist inside keria-vol.${NC}" >&2
        echo "" >&2
        echo -e "${YELLOW}    Inspect it first:   $0 --verify${NC}" >&2
        echo -e "${YELLOW}    Overwrite anyway:   $0 --apply --force${NC}" >&2
        exit 1
    fi
else
    echo -e "${YELLOW}  - Volume does not exist yet; it will be created${NC}"
fi

################################################################################
# Plan
################################################################################
echo ""
echo -e "${CYAN}Plan:${NC}"
[ "$VOLUME_PREEXISTS" -eq 0 ] && \
    echo "  1. docker volume create ${VOLUME_NAME}" || \
    echo "  1. (volume ${VOLUME_NAME} already exists - reusing)"
[ "$FORCE" -eq 1 ] && [ "$TARGET_COUNT" -gt 0 ] && \
    echo "  2. WIPE existing volume contents (--force)" || \
    echo "  2. (no wipe needed)"
echo "  3. Copy ${SOURCE_COUNT} entries from ${SOURCE_ABS} into the volume"
echo "  4. chown -R ${TARGET_UID}:${TARGET_GID} inside the volume  (${UID_SOURCE})"
echo "  5. Verify file count and BRAN presence"

# Guard: 0:0 is almost never right. The containers run as a non-root user, so
# a root-owned volume leaves them read-only. Refuse rather than produce a
# subtly broken stack.
if [ "$TARGET_UID" = "0" ] || [ "$TARGET_GID" = "0" ]; then
    echo ""
    echo -e "${RED}  ✗ REFUSING: ownership resolved to ${TARGET_UID}:${TARGET_GID} (root).${NC}" >&2
    echo -e "${YELLOW}    The containers run as a non-root user (see \`user:\` in${NC}" >&2
    echo -e "${YELLOW}    docker-compose.yml, driven by UID/GID in ./.env). A root-owned${NC}" >&2
    echo -e "${YELLOW}    volume would be readable but NOT writable by them.${NC}" >&2
    echo -e "${YELLOW}    Pass the real values explicitly, e.g.:  --uid 1000 --gid 1000${NC}" >&2
    exit 1
fi
echo ""
echo -e "${BLUE}  Source is NOT deleted. It remains as a cold backup.${NC}"
echo ""

if [ "$APPLY" -eq 0 ]; then
    echo -e "${YELLOW}DRY RUN - nothing was changed.${NC}"
    echo -e "${YELLOW}Re-run with --apply to perform the migration.${NC}"
    echo ""
    exit 0
fi

################################################################################
# Apply
################################################################################
echo -e "${YELLOW}[1/5] Ensuring volume exists...${NC}"
if [ "$VOLUME_PREEXISTS" -eq 0 ]; then
    docker volume create "$VOLUME_NAME" > /dev/null
    echo -e "${GREEN}  ✓ Created volume ${VOLUME_NAME}${NC}"
else
    echo -e "${GREEN}  ✓ Reusing existing volume ${VOLUME_NAME}${NC}"
fi

if [ "$FORCE" -eq 1 ] && [ "$TARGET_COUNT" -gt 0 ]; then
    echo -e "${YELLOW}[2/5] Wiping existing volume contents (--force)...${NC}"
    docker run --rm -v "$VOLUME_NAME":/dest "$HELPER_IMAGE" \
        sh -c 'rm -rf /dest/..?* /dest/.[!.]* /dest/* 2>/dev/null || true'
    echo -e "${GREEN}  ✓ Volume emptied${NC}"
else
    echo -e "${YELLOW}[2/5] No wipe needed${NC}"
fi

echo -e "${YELLOW}[3/5] Copying task-data into the volume...${NC}"
# `cp -a` preserves timestamps and permissions. The trailing /. copies the
# CONTENTS of /src rather than the directory itself.
docker run --rm \
    -v "$VOLUME_NAME":/dest \
    -v "$SOURCE_ABS":/src:ro \
    "$HELPER_IMAGE" \
    sh -c 'cp -a /src/. /dest/'
echo -e "${GREEN}  ✓ Copied${NC}"

echo -e "${YELLOW}[4/5] Setting ownership to ${TARGET_UID}:${TARGET_GID}...${NC}"
# Containers run as ${UID}:${GID} (see docker-compose.yml `user:`). A fresh
# Docker volume is root-owned, so without this the agents can read but not
# write - and the vLEI task scripts DO write new info files here.
docker run --rm -v "$VOLUME_NAME":/dest "$HELPER_IMAGE" \
    sh -c "chown -R ${TARGET_UID}:${TARGET_GID} /dest"
echo -e "${GREEN}  ✓ Ownership set${NC}"

echo -e "${YELLOW}[5/5] Verifying...${NC}"
FINAL_COUNT="$(volume_file_count "$VOLUME_NAME")"
FINAL_BRANS="$(docker run --rm -v "$VOLUME_NAME":/v "$HELPER_IMAGE" \
    sh -c 'ls -1 /v/*-bran.txt 2>/dev/null | wc -l' | tr -d '[:space:]')"

echo "    Entries in volume : ${FINAL_COUNT}  (source had ${SOURCE_COUNT})"
echo "    BRAN files        : ${FINAL_BRANS}  (source had ${BRAN_COUNT})"

if [ "$FINAL_COUNT" -lt "$SOURCE_COUNT" ] || [ "$FINAL_BRANS" -lt "$BRAN_COUNT" ]; then
    echo -e "${RED}  ✗ MISMATCH - the volume has fewer entries than the source.${NC}" >&2
    echo -e "${YELLOW}    Do NOT delete ./task-data. Investigate before proceeding.${NC}" >&2
    exit 1
fi
echo -e "${GREEN}  ✓ Counts match${NC}"

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║              ✓ MIGRATION COMPLETE                            ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  1. Restart the vLEI stack:      ./deploy.sh"
echo "  2. Restart the DD agents:       (in the DD repo) docker compose up -d --build"
echo "  3. Confirm the agents can read the volume:"
echo "       docker exec -i tsx_shell ls -la /task-data"
echo "       docker exec -i dd_seller ls -la /task-data"
echo "  4. Run a negotiation end to end."
echo "  5. ONLY after all of the above passes, remove the host copy:"
echo "       rm -rf ./task-data"
echo ""
echo -e "${YELLOW}Host access to the volume from now on:${NC}"
echo "  ./taskdata.sh ls                 list files"
echo "  ./taskdata.sh cat <file>         print a file"
echo "  ./taskdata.sh export <dir>       copy the volume out to a directory"
echo "  ./taskdata.sh import <dir>       copy a directory into the volume"
echo ""
