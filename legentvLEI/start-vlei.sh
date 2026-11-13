#!/bin/bash
################################################################################
# start-vlei.sh - Restart the vLEI stack with the identities from the last
#                 4D run (no 4D re-run needed).
#
# WHAT IT DOES
#   1. Sets up the shell for Git Bash on Windows:
#        MSYS_NO_PATHCONV=1   (stop /vlei/... paths being rewritten)
#        PATH=$HOME/bin:...   (picks up the jq / openssl wrappers there)
#   2. Checks jq and openssl print LF line endings (no hidden \r).
#   3. Reads the GLEIF root AID from task-data and exports GEDA_PRE, so the
#      Sally verifier starts with YOUR root instead of the compose default.
#   4. Runs ./deploy.sh in preserve mode (never --fresh: keria-vol, i.e. every
#      AID and credential, is kept).
#   5. Checks the run's identities are all present in task-data
#      (print-org-trust-tree.js --strict) and that KERIA serves the QVI's
#      key history live.
#
# USAGE
#   ./start-vlei.sh [flags]
#
# FLAGS
#   --config <file>     Config of the 4D run, for the identity check.
#                       default: ./appconfig/generated/config-4d.json
#   --geda-file <file>  File holding the GLEIF root (GEDA) AID.
#                       default: ./task-data/geda-aid.txt
#   --skip-clean        Pass --skip-clean to deploy.sh (no `compose down`).
#   --no-check          Skip step 5.
#   --dry-run           Pass --dry-run to deploy.sh; skip step 5.
#   -h | --help         Show this help.
#
# This script never wipes data. To start over from nothing use
#   ./stop.sh --fresh && ./deploy.sh --fresh   and re-run 4D.
################################################################################

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

CONFIG_FILE="./appconfig/generated/config-4d.json"
GEDA_FILE="./task-data/geda-aid.txt"
DEPLOY_ARGS=()
RUN_CHECK=1

while [ $# -gt 0 ]; do
    case "$1" in
        --config|--geda-file)
            if [ -z "$2" ]; then
                echo -e "${RED}ERROR: $1 requires a value${NC}" >&2; exit 1
            fi
            if [ "$1" = "--config" ]; then CONFIG_FILE="$2"; else GEDA_FILE="$2"; fi
            shift 2 ;;
        --skip-clean) DEPLOY_ARGS+=(--skip-clean); shift ;;
        --no-check)   RUN_CHECK=0; shift ;;
        --dry-run)    DEPLOY_ARGS+=(--dry-run); RUN_CHECK=0; shift ;;
        --fresh)
            echo -e "${RED}ERROR: start-vlei.sh never wipes data.${NC}" >&2
            echo "Use ./stop.sh --fresh && ./deploy.sh --fresh, then re-run 4D." >&2
            exit 1 ;;
        -h|--help)
            sed -n '3,/^####/p' "$0" | grep -v '^####' | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)
            echo -e "${RED}ERROR: unknown argument: $1 (see --help)${NC}" >&2; exit 1 ;;
    esac
done

cd "$(dirname "$0")"

echo -e "${CYAN}══ start-vlei.sh: restart with existing identities ══${NC}"

# ── 1. shell setup ───────────────────────────────────────────────────────────
export MSYS_NO_PATHCONV=1
export PATH="$HOME/bin:$PATH"
hash -r
echo -e "${GREEN}[1/5] MSYS_NO_PATHCONV=1, \$HOME/bin first in PATH${NC}"

# ── 2. tools print LF only ───────────────────────────────────────────────────
for tool in jq openssl node docker; do
    if ! command -v "$tool" > /dev/null 2>&1; then
        echo -e "${RED}ERROR: $tool not found on PATH${NC}" >&2; exit 1
    fi
done
if [ "$(echo '{"a":"x"}' | jq -r .a | od -c | grep -c '\\r')" -ne 0 ]; then
    echo -e "${RED}ERROR: jq prints \\r line endings. Install the ~/bin/jq --binary wrapper.${NC}" >&2; exit 1
fi
if [ "$(openssl rand -base64 4 | od -c | grep -c '\\r')" -ne 0 ]; then
    echo -e "${RED}ERROR: openssl prints \\r line endings. Install the ~/bin/openssl wrapper.${NC}" >&2; exit 1
fi
echo -e "${GREEN}[2/5] jq, openssl, node, docker found; jq/openssl print LF${NC}"

# ── 3. GEDA_PRE for Sally ────────────────────────────────────────────────────
if [ ! -f "$GEDA_FILE" ]; then
    echo -e "${RED}ERROR: $GEDA_FILE not found - no 4D run to restart from.${NC}" >&2
    echo "Run 4D first, or pass --geda-file <file>." >&2
    exit 1
fi
GEDA_PRE="$(tr -d ' \r\n' < "$GEDA_FILE")"
if ! [[ "$GEDA_PRE" =~ ^E[A-Za-z0-9_-]{43}$ ]]; then
    echo -e "${RED}ERROR: $GEDA_FILE does not hold a valid AID: '$GEDA_PRE'${NC}" >&2; exit 1
fi
export GEDA_PRE
echo -e "${GREEN}[3/5] GEDA_PRE=$GEDA_PRE${NC}"

# ── 4. deploy, preserve mode ─────────────────────────────────────────────────
echo -e "${GREEN}[4/5] ./deploy.sh ${DEPLOY_ARGS[*]}${NC}"
./deploy.sh "${DEPLOY_ARGS[@]}"

# ── 5. identity checks ───────────────────────────────────────────────────────
if [ "$RUN_CHECK" -eq 0 ]; then
    echo -e "${YELLOW}[5/5] checks skipped${NC}"
    exit 0
fi

echo -e "${GREEN}[5/5] Checking identities...${NC}"
node ./print-org-trust-tree.js --config "$CONFIG_FILE" --task-data ./task-data --strict

QVI_OOBI="$(jq -r '.oobi // empty' ./task-data/qvi-info.json 2>/dev/null || true)"
QVI_AID="$(jq -r '.aid // empty' ./task-data/qvi-info.json 2>/dev/null || true)"
if [ -n "$QVI_OOBI" ] && [ -n "$QVI_AID" ]; then
    HOST_OOBI="${QVI_OOBI/http:\/\/keria:3902/http://127.0.0.1:3902}"
    if curl -sf "$HOST_OOBI" | grep -q "\"i\":\"$QVI_AID\""; then
        echo -e "${GREEN}  ✓ KERIA serves the QVI key history live ($QVI_AID)${NC}"
    else
        echo -e "${RED}  ✗ KERIA did not return the QVI key history ($HOST_OOBI)${NC}" >&2
        exit 1
    fi
else
    echo -e "${YELLOW}  ⚠ qvi-info.json has no oobi/aid - live KERIA check skipped${NC}"
fi

echo ""
echo -e "${GREEN}✓ vLEI stack is up with the identities from the last 4D run.${NC}"
