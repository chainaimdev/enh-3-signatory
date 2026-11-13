#!/bin/bash
# ============================================================================
#  copy-brans-to-dd-local.sh
#  PHASE A.3 ONLY — THROWAWAY BRIDGE SCRIPT. DELETE IN PHASE B (B.6.3).
#
#  In Phase B, manage-agent.sh replaces this with an automatic dual-write at
#  BRAN-generation time. Do NOT build anything that depends on this script
#  long-term — it exists purely so KramSigner (A.4/A.5) has a BRAN to read
#  during Phase A.
#
#  NOTE (Windows): the primary runnable version on this machine is the
#  PowerShell sibling copy-brans-to-dd-local.ps1. This .sh is the literal
#  Phase-A artifact for WSL / Linux / CI. Same logic, chmod 600 instead of ACL.
#
#  What it does:
#    Reads the agent BRANs the vLEI 4D pipeline produced in ./task-data/ and
#    copies the buyer + seller BRANs into the DD agents' local .secret/ folders
#    as agent-bran.txt, then chmod 600.
#
#  Source of truth: ./task-data/agent-brans.json (from generate-unique-agent-brans.sh)
#    Only role=buyer and role=seller are copied. role=unknown (e.g. Acme) skipped.
#
#  Idempotent: if destination already byte-matches source (cmp), it is left
#    untouched and reported "unchanged". Safe to run repeatedly.
#
#  No silent fallback: missing manifest / BRAN / DD folder => exit non-zero.
# ============================================================================

set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; GRAY='\033[1;30m'; NC='\033[0m'

# vLEI root = this script's directory.
VLEI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# DD agents dir. Phase-A-only path coupling (removed in B.6.3). Override via
# DD_AGENTS_DIR env var so nothing is hardcoded permanently.
DD_AGENTS_DIR="${DD_AGENTS_DIR:-/c/SATHYA/CHAINAIM3003/mcp-servers/DynDiscounting/DynDisc4-ent1/A2A/js/src/agents}"

fail() { echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || fail "jq is not installed."

TASK_DATA="${VLEI_ROOT}/task-data"
BRANS_JSON="${TASK_DATA}/agent-brans.json"

echo -e "${CYAN}PHASE A.3 — copy vLEI BRANs to DD-local .secret/ (throwaway bridge)${NC}"
echo "  vLEI root : ${VLEI_ROOT}"
echo "  DD agents : ${DD_AGENTS_DIR}"
echo ""

[ -f "$BRANS_JSON" ] || fail "agent-brans.json not found at: $BRANS_JSON
       Run the 4D pipeline first (generate-unique-agent-brans.sh) so BRANs exist."
[ -d "$DD_AGENTS_DIR" ] || fail "DD agents directory not found: $DD_AGENTS_DIR
       Set DD_AGENTS_DIR to the real path."

COPIED=0
UNCHANGED=0

AGENT_COUNT=$(jq -r '.agents | length' "$BRANS_JSON")
[ "$AGENT_COUNT" -gt 0 ] || fail "$BRANS_JSON has no agents — pipeline output looks malformed."

for ((i=0; i<AGENT_COUNT; i++)); do
    ALIAS=$(jq -r ".agents[$i].alias" "$BRANS_JSON")
    ALIAS_LC=$(echo "$ALIAS" | tr '[:upper:]' '[:lower:]')

    # Map to DD agent folder by alias substring. The JSON "role" field is NOT
    # reliable here: upstream get_agent_role in generate-unique-agent-brans.sh
    # matches "Jupiter"/"Tommy" case-sensitively against UPPERCASE org names, so
    # it always writes "unknown". The alias itself is canonical (e.g.
    # jupiterSellerAgent / tommyBuyerAgent), so we key off that instead.
    if [[ "$ALIAS_LC" == *seller* ]]; then
        ROLE="seller"
    elif [[ "$ALIAS_LC" == *buyer* ]]; then
        ROLE="buyer"
    else
        echo -e "  ${GRAY}- skip ${ALIAS} (no buyer/seller in alias, no DD agent)${NC}"
        continue
    fi

    SRC_BRAN="${TASK_DATA}/${ALIAS}-bran.txt"
    [ -f "$SRC_BRAN" ] || fail "BRAN file missing for ${ALIAS}: ${SRC_BRAN}
       Re-run the 4D pipeline."

    DEST_DIR="${DD_AGENTS_DIR}/${ROLE}-agent/.secret"
    DEST_BRAN="${DEST_DIR}/agent-bran.txt"

    if [ -f "$DEST_BRAN" ] && cmp -s "$SRC_BRAN" "$DEST_BRAN"; then
        echo -e "  ${GREEN}= ${ROLE}-agent: unchanged (already byte-equal)${NC}"
        UNCHANGED=$((UNCHANGED + 1))
        continue
    fi

    mkdir -p "$DEST_DIR"
    cp "$SRC_BRAN" "$DEST_BRAN"
    chmod 600 "$DEST_BRAN"

    echo -e "  ${GREEN}+ ${ROLE}-agent: copied <- ${ALIAS}-bran.txt (chmod 600)${NC}"
    COPIED=$((COPIED + 1))
done

echo ""
if [ "$COPIED" -eq 0 ]; then
    echo -e "${GREEN}no changes needed${NC}"
else
    echo -e "${GREEN}Done: ${COPIED} copied, ${UNCHANGED} unchanged.${NC}"
fi
exit 0
