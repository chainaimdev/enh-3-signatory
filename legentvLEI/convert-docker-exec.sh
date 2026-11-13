#!/bin/bash
################################################################################
# convert-docker-exec.sh
#
# PURPOSE (Phase 0 fix D0-2)
#   Convert every `docker compose exec` / `docker compose cp` call site in the
#   repo's shell scripts to the direct `docker exec` / `docker cp` equivalent,
#   so the scripts no longer need a compose project context and can be driven
#   from inside a container (the api-server) that only has the docker socket.
#
# WHY A SCRIPT AND NOT 94 HAND EDITS
#   There are ~170 exec sites and 8 cp sites across ~94 files. A re-runnable,
#   flag-driven converter with a dry-run and a backup is reviewable, auditable
#   and reversible; 94 hand edits are none of those.
#
# SERVICE -> CONTAINER MAPPING
#   Derived automatically from docker-compose.yml by reading `container_name:`.
#   Services WITHOUT a container_name (schema, keria) cannot be targeted by
#   `docker exec` without knowing the compose-generated name, so they are
#   SKIPPED by default. See --unnamed.
#
# USAGE
#   ./convert-docker-exec.sh --report            # inventory only, no changes
#   ./convert-docker-exec.sh                     # dry-run diff (default)
#   ./convert-docker-exec.sh --apply             # write changes + backup
#   ./convert-docker-exec.sh --apply --unnamed container-name
#
# FLAGS
#   --root <dir>          Tree to scan.            default: .
#   --compose <file>      Compose file to read the service->container map from.
#                                                  default: <root>/docker-compose.yml
#   --map svc=container   Add/override one mapping. Repeatable.
#   --unnamed <mode>      What to do with services that have no container_name
#                         (schema, keria, and the bogus 'sig-wallet'):
#                           skip            (default) leave them untouched
#                           container-name  rewrite as `docker exec -i <svc>`,
#                                           ONLY correct if you first add
#                                           `container_name: <svc>` to compose
#                           ps-lookup       rewrite as
#                                           `docker exec -i "$(docker compose ps -q <svc>)"`
#                                           (keeps working with generated names,
#                                            but still needs a compose context)
#   --include <glob>      Only files matching this shell glob. default: *.sh
#   --exclude <glob>      Skip files matching this glob. Repeatable.
#   --backup-dir <dir>    Where originals are copied before --apply.
#                                                  default: <root>/.docker-exec-backup
#   --no-backup           Skip the backup (not recommended).
#   --apply               Actually write. Without this, nothing is modified.
#   --report              Print the inventory table and exit.
#   -h | --help           This help.
#
# EXIT CODES
#   0 success   1 usage/precondition error   2 nothing to convert
################################################################################

# NOTE: deliberately NOT using `pipefail`. Several pipelines below legitimately
# end in a non-zero status - `diff` returns 1 when files differ, `grep -c`
# returns 1 on no match, and `head` closes the pipe early (SIGPIPE). With
# pipefail + `set -e` those abort the run after the first file.
set -eu

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'
RED='\033[0;31m';   CYAN='\033[0;36m'; NC='\033[0m'

ROOT="."
COMPOSE_FILE=""
UNNAMED="skip"
INCLUDE="*.sh"
BACKUP_DIR=""
DO_BACKUP=1
APPLY=0
REPORT_ONLY=0
declare -a EXTRA_MAP=()
declare -a EXCLUDES=()

usage() { sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
    case "$1" in
        --root)       ROOT="$2"; shift 2 ;;
        --compose)    COMPOSE_FILE="$2"; shift 2 ;;
        --map)        EXTRA_MAP+=("$2"); shift 2 ;;
        --unnamed)    UNNAMED="$2"; shift 2 ;;
        --include)    INCLUDE="$2"; shift 2 ;;
        --exclude)    EXCLUDES+=("$2"); shift 2 ;;
        --backup-dir) BACKUP_DIR="$2"; shift 2 ;;
        --no-backup)  DO_BACKUP=0; shift ;;
        --apply)      APPLY=1; shift ;;
        --report)     REPORT_ONLY=1; shift ;;
        -h|--help)    usage ;;
        *) echo -e "${RED}ERROR: unknown argument: $1${NC}" >&2
           echo "Run '$0 --help' for usage." >&2; exit 1 ;;
    esac
done

case "$UNNAMED" in
    skip|container-name|ps-lookup) ;;
    *) echo -e "${RED}ERROR: --unnamed must be skip|container-name|ps-lookup${NC}" >&2; exit 1 ;;
esac

ROOT="${ROOT%/}"
[ -d "$ROOT" ] || { echo -e "${RED}ERROR: --root not a directory: $ROOT${NC}" >&2; exit 1; }
[ -n "$COMPOSE_FILE" ] || COMPOSE_FILE="$ROOT/docker-compose.yml"
[ -f "$COMPOSE_FILE" ] || { echo -e "${RED}ERROR: compose file not found: $COMPOSE_FILE${NC}" >&2; exit 1; }
[ -n "$BACKUP_DIR" ] || BACKUP_DIR="$ROOT/.docker-exec-backup"

################################################################################
# Build the service -> container_name map from docker-compose.yml.
# Services are at 2-space indent, keys at 4-space indent.
################################################################################
declare -A MAP=()
while IFS='=' read -r svc cname; do
    [ -n "$svc" ] && MAP["$svc"]="$cname"
done < <(awk '
    /^[[:space:]]{2}[A-Za-z0-9_.-]+:[[:space:]]*$/ { s=$1; sub(/:$/,"",s); gsub(/[[:space:]]/,"",s); svc=s; next }
    /^[[:space:]]{4}container_name:[[:space:]]*/   { c=$2; gsub(/["\047]/,"",c); if (svc!="") print svc "=" c }
' "$COMPOSE_FILE")

for kv in ${EXTRA_MAP+"${EXTRA_MAP[@]}"}; do
    MAP["${kv%%=*}"]="${kv#*=}"
done

echo -e "${CYAN}service -> container_name map (from $(basename "$COMPOSE_FILE")):${NC}"
if [ ${#MAP[@]} -eq 0 ]; then
    echo -e "${RED}  (empty - no container_name found; use --map svc=container)${NC}"
else
    for s in "${!MAP[@]}"; do printf '  %-22s -> %s\n' "$s" "${MAP[$s]}"; done
fi
echo ""

################################################################################
# Collect target files
################################################################################
SELF="$(basename "$0")"
mapfile -t FILES < <(find "$ROOT" -type f -name "$INCLUDE" \
    -not -path "*/node_modules/*" -not -path "*/.git/*" \
    -not -name "$SELF" \
    -not -path "${BACKUP_DIR#./}/*" -not -path "*/.docker-exec-backup*/*" | sort)
# NOTE the trailing * in .docker-exec-backup*: this used to be an exact match on
# the DEFAULT backup dir name only. A run using --backup-dir .docker-exec-backup-r2
# excluded that dir during --apply (via $BACKUP_DIR), but a LATER --report without
# the same flag scanned it, found the pre-conversion originals, and reported 50
# live call sites that did not exist. The glob makes every backup generation
# invisible regardless of which flags a given invocation happens to carry.

filtered=()
for f in ${FILES+"${FILES[@]}"}; do
    skip=0
    for ex in ${EXCLUDES+"${EXCLUDES[@]}"}; do
        case "$(basename "$f")" in $ex) skip=1 ;; esac
        case "$f" in $ex) skip=1 ;; esac
    done
    [ $skip -eq 0 ] && filtered+=("$f")
done
FILES=(${filtered+"${filtered[@]}"})

echo -e "${CYAN}scanning ${#FILES[@]} file(s) under $ROOT matching '$INCLUDE'${NC}"
echo ""

################################################################################
# Inventory
################################################################################
EXEC_RE='docker[ -]compose[[:space:]]+exec'
CP_RE='docker[ -]compose[[:space:]]+cp'

echo -e "${CYAN}inventory - exec call sites by target service:${NC}"
declare -A COUNTS=()
for f in ${FILES+"${FILES[@]}"}; do
    while read -r svc; do
        [ -n "$svc" ] && COUNTS["$svc"]=$(( ${COUNTS["$svc"]:-0} + 1 ))
    done < <(grep -hoE "${EXEC_RE}([[:space:]]+-[A-Za-z]+)*[[:space:]]+[A-Za-z0-9_.-]+" "$f" 2>/dev/null \
             | sed -E "s@${EXEC_RE}([[:space:]]+-[A-Za-z]+)*[[:space:]]+@@")
done

TOTAL=0; MAPPED=0; UNMAPPED=0
for s in "${!COUNTS[@]}"; do
    n=${COUNTS[$s]}; TOTAL=$((TOTAL+n))
    if [ -n "${MAP[$s]:-}" ]; then
        printf "  ${GREEN}%-22s %4d  -> %s${NC}\n" "$s" "$n" "${MAP[$s]}"
        MAPPED=$((MAPPED+n))
    else
        printf "  ${YELLOW}%-22s %4d  -> NO container_name (mode: %s)${NC}\n" "$s" "$n" "$UNNAMED"
        UNMAPPED=$((UNMAPPED+n))
    fi
done
CP_TOTAL=$( { grep -hcE "$CP_RE" ${FILES+"${FILES[@]}"} 2>/dev/null || true; } | awk '{s+=$1} END {print s+0}')
echo ""
printf "  total exec sites : %d  (mapped %d, unmapped %d)\n" "$TOTAL" "$MAPPED" "$UNMAPPED"
printf "  total cp sites   : %d\n" "$CP_TOTAL"
echo ""

[ "$REPORT_ONLY" -eq 1 ] && exit 0
[ "$TOTAL" -eq 0 ] && [ "$CP_TOTAL" -eq 0 ] && { echo -e "${GREEN}Nothing to convert.${NC}"; exit 2; }

################################################################################
# Rewrite one file into stdout
################################################################################
rewrite() {
    local src=$1
    local tmp; tmp=$(mktemp)
    cp "$src" "$tmp"

    local svc cn
    # --- exec, mapped services -------------------------------------------
    for svc in "${!MAP[@]}"; do
        cn="${MAP[$svc]}"
        sed -i -E "s@${EXEC_RE}([[:space:]]+-[A-Za-z]+)*[[:space:]]+${svc}([[:space:]]|\$)@docker exec -i ${cn}\2@g" "$tmp"
    done

    # --- exec, unmapped services -----------------------------------------
    if [ "$UNNAMED" != "skip" ]; then
        for svc in $(printf '%s\n' "${!COUNTS[@]}"); do
            [ -n "${MAP[$svc]:-}" ] && continue
            if [ "$UNNAMED" == "container-name" ]; then
                sed -i -E "s@${EXEC_RE}([[:space:]]+-[A-Za-z]+)*[[:space:]]+${svc}([[:space:]]|\$)@docker exec -i ${svc}\2@g" "$tmp"
            else
                sed -i -E "s@${EXEC_RE}([[:space:]]+-[A-Za-z]+)*[[:space:]]+${svc}([[:space:]]|\$)@docker exec -i \"\$(docker compose ps -q ${svc})\"\2@g" "$tmp"
            fi
        done
    fi

    # --- cp ---------------------------------------------------------------
    # Only touch lines that are a compose cp, and only rewrite the
    # "<service>:" endpoint on those lines.
    for svc in "${!MAP[@]}"; do
        cn="${MAP[$svc]}"
        sed -i -E "/${CP_RE}/ s@(^|[[:space:]\"'])${svc}:@\1${cn}:@g" "$tmp"
    done
    sed -i -E "s@${CP_RE}@docker cp@g" "$tmp"

    cat "$tmp"; rm -f "$tmp"
}

################################################################################
# Apply / dry-run
################################################################################
CHANGED=0
[ "$APPLY" -eq 1 ] && [ "$DO_BACKUP" -eq 1 ] && mkdir -p "$BACKUP_DIR"

for f in ${FILES+"${FILES[@]}"}; do
    grep -qE "${EXEC_RE}|${CP_RE}" "$f" || continue
    new=$(mktemp); rewrite "$f" > "$new"
    if cmp -s "$f" "$new"; then rm -f "$new"; continue; fi
    CHANGED=$((CHANGED+1))
    rel="${f#$ROOT/}"
    if [ "$APPLY" -eq 1 ]; then
        if [ "$DO_BACKUP" -eq 1 ]; then
            mkdir -p "$BACKUP_DIR/$(dirname "$rel")"
            cp -p "$f" "$BACKUP_DIR/$rel"
        fi
        cat "$new" > "$f"
        echo -e "${GREEN}  converted ${NC}$rel"
    else
        echo -e "${BLUE}--- $rel${NC}"
        { diff -u "$f" "$new" || true; } | sed -n '3,$p' \
            | { grep -E '^[+-]' || true; } | { grep -vE '^(\+\+\+|---)' || true; } | head -12
    fi
    rm -f "$new"
done

echo ""
if [ "$APPLY" -eq 1 ]; then
    echo -e "${GREEN}✓ ${CHANGED} file(s) converted.${NC}"
    [ "$DO_BACKUP" -eq 1 ] && echo -e "${CYAN}  originals backed up to: $BACKUP_DIR${NC}"
    echo ""
    echo -e "${CYAN}post-conversion syntax check:${NC}"
    bad=0
    for f in ${FILES+"${FILES[@]}"}; do
        bash -n "$f" 2>/dev/null || { echo -e "${RED}  SYNTAX ERROR: $f${NC}"; bad=1; }
    done
    [ $bad -eq 0 ] && echo -e "${GREEN}  all files parse cleanly${NC}"
    echo ""
    echo -e "${CYAN}remaining 'docker compose exec' call sites (comments excluded):${NC}"
    { grep -rhoE "${EXEC_RE}([[:space:]]+-[A-Za-z]+)*[[:space:]]+[A-Za-z0-9_.-]+" \
        ${FILES+"${FILES[@]}"} 2>/dev/null || true; } \
        | sed -E "s@${EXEC_RE}([[:space:]]+-[A-Za-z]+)*[[:space:]]+@@" \
        | sort | uniq -c | sort -rn | sed 's/^/  /'
    echo -e "${CYAN}to revert:${NC}  cp -r $BACKUP_DIR/. $ROOT/"
else
    echo -e "${YELLOW}DRY RUN - ${CHANGED} file(s) WOULD change. Nothing written.${NC}"
    echo -e "${YELLOW}Re-run with --apply to write.${NC}"
fi
