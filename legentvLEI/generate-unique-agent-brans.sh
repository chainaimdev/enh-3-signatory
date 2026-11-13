#!/bin/bash
################################################################################
# generate-unique-agent-brans.sh
# Purpose: Generate unique cryptographic BRANs for ALL agents before creation
#
# FLAGS (all optional, defaults preserve the pre-Phase-0 behaviour):
#   --config <path>        Agent config JSON.
#                          default: ./appconfig/configBuyerSellerAIAgent1.json
#   --task-data <path>     Where *-bran.txt and agent-brans.json are written.
#                          default: ./task-data
#   --dd-root <path>       Root of the DynDiscounting A2A/js tree.
#                          default: ../Legent/A2A/js
#   --agents-subdir <rel>  Agent folder relative to --dd-root.
#                          default: src/agents
#   --env-mode <mode>      What to write into each agent's .env file:
#                            none       (DEFAULT) write nothing. The DD agent
#                                       reads AGENT_BRAN_PATH, which already
#                                       points at task-data/<alias>-bran.txt -
#                                       the exact file this script writes. There
#                                       is nothing left to push into .env, and
#                                       copying the secret in only creates a
#                                       second copy that goes stale.
#                            bran-path  rewrite AGENT_BRAN_PATH= to the bran
#                                       file this run produced, then verify.
#                            bran-value rewrite AGENT_BRAN= with the literal
#                                       BRAN (legacy), then verify.
#   --require-env-files    Exit 1 if an agent's .env file is missing.
#                          Ignored when --env-mode none. (default: warn)
#   --dry-run              Compute and print everything, write nothing
#   -h | --help            Show this help
#
# AGENTS_BASE_DIR is derived as "<dd-root>/<agents-subdir>".
# With no flags that is "../Legent/A2A/js/src/agents" - identical to the
# previous hardcoded value.
################################################################################

set -e

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

################################################################################
# Defaults - chosen so that running with NO flags reproduces the previous
# hardcoded behaviour exactly.
################################################################################
CONFIG_FILE="./appconfig/configBuyerSellerAIAgent1.json"
TASK_DATA_DIR="./task-data"
DD_ROOT="../Legent/A2A/js"
AGENTS_SUBDIR="src/agents"
REQUIRE_ENV_FILES=0
DRY_RUN=0
ENV_MODE="none"

usage() {
    # Print the header comment block. Keep the range in sync with the block
    # above - it grew when --env-mode was added and 2,25p started truncating.
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --config)          CONFIG_FILE="$2";   shift 2 ;;
        --task-data)       TASK_DATA_DIR="$2"; shift 2 ;;
        --dd-root)         DD_ROOT="$2";       shift 2 ;;
        --agents-subdir)   AGENTS_SUBDIR="$2"; shift 2 ;;
        --env-mode)        ENV_MODE="$2";      shift 2 ;;
        --require-env-files) REQUIRE_ENV_FILES=1; shift ;;
        --dry-run)         DRY_RUN=1;          shift ;;
        -h|--help)         usage ;;
        *)
            echo -e "${RED}ERROR: unknown argument: $1${NC}" >&2
            echo "Run '$0 --help' for usage." >&2
            exit 1
            ;;
    esac
done

case "$ENV_MODE" in
    none|bran-path|bran-value) ;;
    *) echo -e "${RED}ERROR: --env-mode must be none|bran-path|bran-value${NC}" >&2; exit 1 ;;
esac

AGENTS_BASE_DIR="${DD_ROOT%/}/${AGENTS_SUBDIR#/}"
OUTPUT_FILE="${TASK_DATA_DIR}/agent-brans.json"

echo -e "${BLUE}Configuration:${NC}"
echo "  config file      : $CONFIG_FILE"
echo "  task-data dir    : $TASK_DATA_DIR"
echo "  dd-root          : $DD_ROOT"
echo "  agents base dir  : $AGENTS_BASE_DIR"
echo "  env mode         : $ENV_MODE"
echo "  require env files: $REQUIRE_ENV_FILES"
echo "  dry run          : $DRY_RUN"
echo ""

if [ "$ENV_MODE" == "none" ]; then
    echo -e "${BLUE}  (--env-mode none: agent .env files will NOT be touched.${NC}"
    echo -e "${BLUE}   Agents resolve their BRAN via AGENT_BRAN_PATH ->${NC}"
    echo -e "${BLUE}   ${TASK_DATA_DIR}/<alias>-bran.txt, which this script writes.)${NC}"
    echo ""
fi

if [ "$DRY_RUN" -eq 0 ]; then
    mkdir -p "$TASK_DATA_DIR"
fi

if [ ! -f "$CONFIG_FILE" ]; then
    echo -e "${RED}ERROR: Configuration file not found: $CONFIG_FILE${NC}"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    echo -e "${RED}ERROR: jq is not installed${NC}"
    exit 1
fi

if ! command -v openssl &> /dev/null; then
    echo -e "${RED}ERROR: openssl is not installed${NC}"
    exit 1
fi

if [ "$ENV_MODE" != "none" ] && [ ! -d "$AGENTS_BASE_DIR" ]; then
    echo -e "${YELLOW}WARNING: agents base dir does not exist: $AGENTS_BASE_DIR${NC}"
    echo -e "${YELLOW}         No agent .env file will be updated.${NC}"
    echo -e "${YELLOW}         Pass --dd-root <path-to-DynDisc .../A2A/js> to point at the real tree.${NC}"
    if [ "$REQUIRE_ENV_FILES" -eq 1 ]; then
        echo -e "${RED}ERROR: --require-env-files was passed and the base dir is missing.${NC}"
        exit 1
    fi
    echo ""
fi

generate_bran() {
    openssl rand -base64 32 | tr -d '\n='
}

################################################################################
# Phase A.1 fix (vLEIEnh1 Phase A - KRAM validation).
#
# BUG FIXED: the previous version of this function did two things wrong:
#   1. It compared $agent_type against the literal string "AI Agent" but the
#      config uses agentType="AI", so the case-statement never matched. Every
#      call fell through to the *) branch and silently returned "unknownAgent".
#   2. Even when it matched, it string-searched "Jupiter" / "Tommy" in the
#      org name and returned a hardcoded alias. Adding a 3rd company
#      (e.g. Acme_Corp) was impossible - it would always get "unknownAgent".
#
# FIX: read the alias from the config JSON. The agent's `alias` field in
# configBuyerSellerAIAgent1.json IS the KERIA alias - they are the same value
# (e.g. "jupiterSellerAgent", "tommyBuyerAgent"). No schema change needed.
#
# NO SILENT FALLBACK: if the caller passes empty/null, we exit non-zero so
# the bug surfaces immediately - no more "unknownAgent" hiding bad config.
################################################################################
get_keria_alias() {
    local agent_alias=$1

    if [ -z "$agent_alias" ] || [ "$agent_alias" == "null" ]; then
        echo -e "${RED}ERROR: get_keria_alias called with empty/null agent alias.${NC}" >&2
        echo -e "${RED}  Check $CONFIG_FILE - every agent entry must have an 'alias' field.${NC}" >&2
        exit 1
    fi

    echo "$agent_alias"
}

################################################################################
# Phase 0 fix D0-1 (containerisation prep).
#
# BUG FIXED: get_agent_role() used to substring-match the ORGANISATION name:
#     [[ "$org_name" == *"Jupiter"* ]] -> "seller"
#     [[ "$org_name" == *"Tommy"*   ]] -> "buyer"
#     else                             -> "unknown"
#   The config stores names UPPERCASE ("JUPITER KNITTING COMPANY",
#   "TOMMY HILFIGER EUROPE B.V."), so *every* org fell through to "unknown"
#   and the script wrote agent .env paths under ".../unknown-agent/.env",
#   a directory that does not exist. Silent, every run.
#   Case-insensitivity alone would NOT have been enough: the config also
#   carries a third org (ACME CORPORATION / acmeOperationsAgent) that no
#   substring rule covers.
#
# FIX: the role is now an explicit `role` field on each agent entry in the
# config, read directly - same pattern as get_keria_alias() above. Adding
# org N+1 is a config edit, not a script edit.
#
# NO SILENT FALLBACK: missing/empty/null role exits non-zero.
################################################################################
get_agent_role() {
    local agent_alias=$1
    local agent_role=$2

    if [ -z "$agent_role" ] || [ "$agent_role" == "null" ]; then
        echo -e "${RED}ERROR: agent '${agent_alias}' has no 'role' field in $CONFIG_FILE.${NC}" >&2
        echo -e "${RED}  Every entry under organizations[].persons[].agents[] must declare${NC}" >&2
        echo -e "${RED}  a 'role' (e.g. \"role\": \"seller\"). This value selects the agent${NC}" >&2
        echo -e "${RED}  .env path: ${AGENTS_BASE_DIR}/<role>-agent/.env${NC}" >&2
        exit 1
    fi

    echo "$agent_role"
}

echo -e "${BLUE}Generating Unique Agent BRANs...${NC}"

if [ "$DRY_RUN" -eq 0 ]; then
    echo "{" > "$OUTPUT_FILE"
    echo "  \"generated_at\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"," >> "$OUTPUT_FILE"
    echo "  \"agents\": [" >> "$OUTPUT_FILE"
fi

emit() {
    # Append a line to OUTPUT_FILE unless running --dry-run.
    if [ "$DRY_RUN" -eq 0 ]; then
        echo "$1" >> "$OUTPUT_FILE"
    fi
}

ORG_COUNT=$(jq -r '.organizations | length' "$CONFIG_FILE")
TOTAL_AGENTS=0

# Count agents
for ((org_idx=0; org_idx<$ORG_COUNT; org_idx++)); do
    PERSON_COUNT=$(jq -r ".organizations[$org_idx].persons | length" "$CONFIG_FILE")
    for ((person_idx=0; person_idx<$PERSON_COUNT; person_idx++)); do
        AGENT_COUNT=$(jq -r ".organizations[$org_idx].persons[$person_idx].agents | length" "$CONFIG_FILE")
        TOTAL_AGENTS=$((TOTAL_AGENTS + AGENT_COUNT))
    done
done

echo -e "${GREEN}✓ Found $TOTAL_AGENTS agent(s)${NC}"

if [ "$TOTAL_AGENTS" -eq 0 ]; then
    echo -e "${RED}ERROR: no agents found in $CONFIG_FILE - nothing to generate.${NC}"
    exit 1
fi

declare -a generated_brans=()
CURRENT_AGENT=0
MISSING_ENV_FILES=0

for ((org_idx=0; org_idx<$ORG_COUNT; org_idx++)); do
    ORG_NAME=$(jq -r ".organizations[$org_idx].name" "$CONFIG_FILE")
    ORG_ALIAS=$(jq -r ".organizations[$org_idx].alias" "$CONFIG_FILE")
    ORG_LEI=$(jq -r ".organizations[$org_idx].lei" "$CONFIG_FILE")
    PERSON_COUNT=$(jq -r ".organizations[$org_idx].persons | length" "$CONFIG_FILE")

    for ((person_idx=0; person_idx<$PERSON_COUNT; person_idx++)); do
        PERSON_ALIAS=$(jq -r ".organizations[$org_idx].persons[$person_idx].alias" "$CONFIG_FILE")
        PERSON_NAME=$(jq -r ".organizations[$org_idx].persons[$person_idx].legalName" "$CONFIG_FILE")
        PERSON_ROLE=$(jq -r ".organizations[$org_idx].persons[$person_idx].officialRole" "$CONFIG_FILE")
        AGENT_COUNT=$(jq -r ".organizations[$org_idx].persons[$person_idx].agents | length" "$CONFIG_FILE")

        if [ "$AGENT_COUNT" -gt 0 ]; then
            for ((agent_idx=0; agent_idx<$AGENT_COUNT; agent_idx++)); do
                AGENT_ALIAS=$(jq -r ".organizations[$org_idx].persons[$person_idx].agents[$agent_idx].alias" "$CONFIG_FILE")
                AGENT_TYPE=$(jq -r ".organizations[$org_idx].persons[$person_idx].agents[$agent_idx].agentType" "$CONFIG_FILE")
                AGENT_ROLE_RAW=$(jq -r ".organizations[$org_idx].persons[$person_idx].agents[$agent_idx].role // empty" "$CONFIG_FILE")

                echo -e "${BLUE}→ Processing: ${AGENT_ALIAS}${NC}"

                BRAN=$(generate_bran)
                while [[ " ${generated_brans[*]} " =~ " ${BRAN} " ]]; do
                    BRAN=$(generate_bran)
                done
                generated_brans+=("$BRAN")

                KERIA_ALIAS=$(get_keria_alias "$AGENT_ALIAS")
                AGENT_ROLE=$(get_agent_role "$AGENT_ALIAS" "$AGENT_ROLE_RAW")

                echo -e "${GREEN}  ✓ role: ${AGENT_ROLE}${NC}"
                echo -e "${GREEN}  ✓ BRAN: (hidden)${NC}"

                BRAN_FILE="${TASK_DATA_DIR}/${AGENT_ALIAS}-bran.txt"
                if [ "$DRY_RUN" -eq 0 ]; then
                    echo "$BRAN" > "$BRAN_FILE"
                fi

                if [ $CURRENT_AGENT -gt 0 ]; then
                    emit ","
                fi

                # Write JSON entry directly without heredoc
                emit "    {"
                emit "      \"alias\": \"$AGENT_ALIAS\","
                emit "      \"keriaAlias\": \"$KERIA_ALIAS\","
                emit "      \"agentType\": \"$AGENT_TYPE\","
                emit "      \"role\": \"$AGENT_ROLE\","
                emit "      \"organization\": \"$ORG_NAME\","
                emit "      \"orgAlias\": \"$ORG_ALIAS\","
                emit "      \"orgLEI\": \"$ORG_LEI\","
                emit "      \"oorHolder\": \"$PERSON_NAME\","
                emit "      \"oorHolderAlias\": \"$PERSON_ALIAS\","
                emit "      \"oorRole\": \"$PERSON_ROLE\","
                emit "      \"bran\": \"$BRAN\","
                emit "      \"aid\": null,"
                emit "      \"envFile\": \"${AGENTS_BASE_DIR}/${AGENT_ROLE}-agent/.env\","
                emit "      \"branFile\": \"$BRAN_FILE\""
                emit "    }"

                CURRENT_AGENT=$((CURRENT_AGENT + 1))

                ENV_FILE="${AGENTS_BASE_DIR}/${AGENT_ROLE}-agent/.env"

                if [ "$ENV_MODE" == "none" ]; then
                    : # intentionally untouched - the agent reads AGENT_BRAN_PATH
                elif [ ! -f "$ENV_FILE" ]; then
                    # Previously this was a SILENT skip - the whole reason the
                    # unknown-agent bug survived so long. Now it is loud.
                    MISSING_ENV_FILES=$((MISSING_ENV_FILES + 1))
                    echo -e "${YELLOW}  ⚠ NOT updated - .env not found: $ENV_FILE${NC}"
                    echo -e "${YELLOW}    (role '${AGENT_ROLE}' -> expected dir '${AGENT_ROLE}-agent')${NC}"
                elif [ "$DRY_RUN" -eq 1 ]; then
                    echo -e "${YELLOW}  [dry-run] would set ${ENV_MODE} in: $ENV_FILE${NC}"
                else
                    ############################################################
                    # Phase 0 fix D0-6: VERIFY THE WRITE.
                    #
                    # The previous version ran a sed and then printed
                    # "✓ Updated" unconditionally. Against a real DD agent .env
                    # that sed matched nothing - it anchored on "KERIA_URL=",
                    # but the file actually has "KERIA_ADMIN_URL=" - so the
                    # script reported success having written precisely nothing.
                    #
                    # Two changes: append when the key is absent (an append
                    # always lands, unlike an anchored insert), and read the
                    # file back afterwards to prove the value is there.
                    ############################################################
                    if [ "$ENV_MODE" == "bran-path" ]; then
                        ENV_KEY="AGENT_BRAN_PATH"
                        ENV_VAL="$(cd "$(dirname "$BRAN_FILE")" && pwd)/$(basename "$BRAN_FILE")"
                    else
                        ENV_KEY="AGENT_BRAN"
                        ENV_VAL="$BRAN"
                    fi

                    if grep -q "^${ENV_KEY}=" "$ENV_FILE"; then
                        sed -i "s|^${ENV_KEY}=.*|${ENV_KEY}=${ENV_VAL}|" "$ENV_FILE"
                    else
                        printf '\n# Written by generate-unique-agent-brans.sh\n%s=%s\n' \
                            "$ENV_KEY" "$ENV_VAL" >> "$ENV_FILE"
                    fi

                    if grep -q "^AGENT_NAME=" "$ENV_FILE"; then
                        sed -i "s|^AGENT_NAME=.*|AGENT_NAME=$KERIA_ALIAS|" "$ENV_FILE"
                    fi

                    chmod 600 "$ENV_FILE"

                    if grep -qF "${ENV_KEY}=${ENV_VAL}" "$ENV_FILE"; then
                        echo -e "${GREEN}  ✓ Set ${ENV_KEY} in: $ENV_FILE${NC}"
                    else
                        echo -e "${RED}  ✗ WRITE VERIFICATION FAILED: $ENV_FILE${NC}" >&2
                        echo -e "${RED}    Expected to find: ${ENV_KEY}=${ENV_VAL}${NC}" >&2
                        exit 1
                    fi
                fi
            done
        fi
    done
done

emit ""
emit "  ]"
emit "}"

echo -e "${GREEN}✅ Complete! Generated $TOTAL_AGENTS unique BRANs${NC}"

if [ "$MISSING_ENV_FILES" -gt 0 ]; then
    echo -e "${YELLOW}⚠ $MISSING_ENV_FILES agent .env file(s) were NOT updated (see warnings above).${NC}"
    if [ "$REQUIRE_ENV_FILES" -eq 1 ]; then
        echo -e "${RED}✗ ERROR: --require-env-files was passed.${NC}"
        exit 1
    fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
    echo -e "${YELLOW}[dry-run] No files were written.${NC}"
    exit 0
fi

UNIQUE_COUNT=$(cat "$OUTPUT_FILE" | jq -r '.agents[].bran' | sort | uniq | wc -l)
if [ "$UNIQUE_COUNT" -eq "$TOTAL_AGENTS" ]; then
    echo -e "${GREEN}✓ All BRANs are unique${NC}"
else
    echo -e "${RED}✗ ERROR: BRAN collision detected!${NC}"
    exit 1
fi

exit 0
