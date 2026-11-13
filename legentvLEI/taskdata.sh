#!/bin/bash
################################################################################
# taskdata.sh - host-side access to the Docker-managed task-data volume.
#
# WHY THIS EXISTS
#   task-data used to be a plain host directory you could open in Explorer or
#   `cat` directly. It is now a Docker-managed named volume (see
#   migrate-taskdata-to-volume.sh and ADR-001), which is what makes the stack
#   hostable - but it also means the files are no longer browsable from the
#   host filesystem. That is the accepted trade-off, not an oversight.
#
#   This script is the supported way to look at and move that data without
#   reintroducing a bind mount.
#
# USAGE
#   ./taskdata.sh <command> [args] [flags]
#
# COMMANDS
#   ls                    List files in the volume (long format).
#   tree                  Recursive listing.
#   cat <file>            Print one file, e.g. ./taskdata.sh cat tommyBuyerAgent-info.json
#   export <dir>          Copy the ENTIRE volume out to <dir> on the host.
#                         Use for backups. <dir> is created if absent.
#   import <dir>          Copy <dir> from the host INTO the volume (merge,
#                         overwriting same-named files). Use to restore.
#   shell                 Open an interactive shell with the volume at /task-data.
#   size                  Report how much space the volume uses.
#
# FLAGS
#   --volume NAME         Volume to operate on.
#                         Default: $VLEI_TASK_DATA_VOLUME, else vlei_task_data.
#   --helper-image IMG    Image used to run the operation. Default: alpine:3.20
#   --uid N / --gid N     Ownership applied after `import`. Defaults to the
#                         current user, matching docker-compose.yml `user:`.
#   -h|--help             Show this help.
#
# EXAMPLES
#   ./taskdata.sh ls
#   ./taskdata.sh cat jupiterSellerAgent-info.json
#   ./taskdata.sh export ./task-data-backup-$(date +%F)
#   ./taskdata.sh import ./task-data-backup-2026-08-03
#   ./taskdata.sh --volume vlei_task_data_staging ls
#
# SECURITY NOTE
#   `export` writes BRAN files (KERI private-key-equivalent passcodes) to the
#   host in plaintext. Treat the output directory accordingly: keep it out of
#   git (the repo .gitignore already excludes task-data/, but a differently
#   named export directory is NOT covered), and delete it when done.
################################################################################

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

VOLUME_NAME="${VLEI_TASK_DATA_VOLUME:-vlei_task_data}"
HELPER_IMAGE="alpine:3.20"

# Ownership for `import` (and for the exported copy on `export`). Resolved the
# same way compose does - from ./.env - NOT from `id -u`. In WSL the shell user
# is root, so `id -u` returns 0, which would leave an imported volume writable
# only by root while the containers run as 1000:1000. See the equivalent block
# in migrate-taskdata-to-volume.sh for the full rationale.
env_file_value() {
    local key="$1" file="$2"
    [ -f "$file" ] || return 0
    grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null \
        | tail -1 \
        | sed -E "s/^[[:space:]]*${key}=//; s/[[:space:]]*$//; s/^\"//; s/\"$//" \
        | tr -d '\r'
}
TARGET_UID="$(env_file_value UID ./.env)"; [ -n "$TARGET_UID" ] || TARGET_UID=1000
TARGET_GID="$(env_file_value GID ./.env)"; [ -n "$TARGET_GID" ] || TARGET_GID=1000

usage() {
    sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

# Separate the subcommand + positional args from the flags, so flags can appear
# anywhere: `./taskdata.sh cat foo.json --volume x` and
# `./taskdata.sh --volume x cat foo.json` both work.
ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --volume)       VOLUME_NAME="${2:?--volume needs a value}";        shift 2 ;;
        --helper-image) HELPER_IMAGE="${2:?--helper-image needs a value}"; shift 2 ;;
        --uid)          TARGET_UID="${2:?--uid needs a value}";            shift 2 ;;
        --gid)          TARGET_GID="${2:?--gid needs a value}";            shift 2 ;;
        -h|--help)      usage ;;
        -*)
            echo -e "${RED}ERROR: unknown flag: $1${NC}" >&2
            echo "Run '$0 --help' for usage." >&2
            exit 1
            ;;
        *)  ARGS+=("$1"); shift ;;
    esac
done

if [ "${#ARGS[@]}" -eq 0 ]; then
    usage
fi

CMD="${ARGS[0]}"

if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}✗ Docker daemon not reachable.${NC}" >&2
    exit 1
fi

if ! docker volume inspect "$VOLUME_NAME" > /dev/null 2>&1; then
    echo -e "${RED}✗ Volume '${VOLUME_NAME}' does not exist.${NC}" >&2
    echo -e "${YELLOW}  Create and seed it with:  ./migrate-taskdata-to-volume.sh --apply${NC}" >&2
    exit 1
fi

case "$CMD" in
    ls)
        docker run --rm -v "$VOLUME_NAME":/task-data:ro "$HELPER_IMAGE" ls -la /task-data
        ;;

    tree)
        docker run --rm -v "$VOLUME_NAME":/task-data:ro "$HELPER_IMAGE" \
            find /task-data -printf '%M %u:%g %10s %p\n' 2>/dev/null \
            || docker run --rm -v "$VOLUME_NAME":/task-data:ro "$HELPER_IMAGE" \
                 sh -c 'find /task-data -exec ls -ld {} \;'
        ;;

    cat)
        FILE="${ARGS[1]:-}"
        if [ -z "$FILE" ]; then
            echo -e "${RED}✗ Usage: $0 cat <filename>${NC}" >&2
            exit 1
        fi
        docker run --rm -v "$VOLUME_NAME":/task-data:ro "$HELPER_IMAGE" \
            sh -c "cat /task-data/\"$FILE\""
        ;;

    size)
        docker run --rm -v "$VOLUME_NAME":/task-data:ro "$HELPER_IMAGE" \
            du -sh /task-data
        ;;

    export)
        DEST="${ARGS[1]:-}"
        if [ -z "$DEST" ]; then
            echo -e "${RED}✗ Usage: $0 export <directory>${NC}" >&2
            exit 1
        fi
        mkdir -p "$DEST"
        DEST_ABS="$(cd "$DEST" && pwd)"
        docker run --rm \
            -v "$VOLUME_NAME":/task-data:ro \
            -v "$DEST_ABS":/dest \
            "$HELPER_IMAGE" \
            sh -c "cp -a /task-data/. /dest/ && chown -R ${TARGET_UID}:${TARGET_GID} /dest"
        echo -e "${GREEN}✓ Exported volume '${VOLUME_NAME}' to ${DEST_ABS}${NC}"
        echo -e "${YELLOW}  ⚠ This directory now contains BRAN private-key material in plaintext.${NC}"
        echo -e "${YELLOW}    Keep it out of git and delete it when you are done.${NC}"
        ;;

    import)
        SRC="${ARGS[1]:-}"
        if [ -z "$SRC" ]; then
            echo -e "${RED}✗ Usage: $0 import <directory>${NC}" >&2
            exit 1
        fi
        if [ ! -d "$SRC" ]; then
            echo -e "${RED}✗ Source directory not found: ${SRC}${NC}" >&2
            exit 1
        fi
        SRC_ABS="$(cd "$SRC" && pwd)"
        echo -e "${YELLOW}Merging ${SRC_ABS} into volume '${VOLUME_NAME}'.${NC}"
        echo -e "${YELLOW}Same-named files WILL be overwritten. Ctrl-C now to abort.${NC}"
        sleep 3
        docker run --rm \
            -v "$VOLUME_NAME":/task-data \
            -v "$SRC_ABS":/src:ro \
            "$HELPER_IMAGE" \
            sh -c "cp -a /src/. /task-data/ && chown -R ${TARGET_UID}:${TARGET_GID} /task-data"
        echo -e "${GREEN}✓ Imported ${SRC_ABS} into '${VOLUME_NAME}'${NC}"
        ;;

    shell)
        echo -e "${CYAN}Volume '${VOLUME_NAME}' mounted at /task-data. Type exit to leave.${NC}"
        docker run --rm -it -v "$VOLUME_NAME":/task-data "$HELPER_IMAGE" sh
        ;;

    *)
        echo -e "${RED}✗ Unknown command: ${CMD}${NC}" >&2
        echo "Run '$0 --help' for usage." >&2
        exit 1
        ;;
esac
