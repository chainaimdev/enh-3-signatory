#!/bin/bash
################################################################################
# invoice-acdc-admit-self.sh - Admit self-attested invoice credential
#
# Purpose: Agent admits its own self-attested invoice credential
#          This completes the self-attestation process
#
# Usage: ./invoice-acdc-admit-self.sh <AGENT_NAME>
#
# Example: ./invoice-acdc-admit-self.sh jupiterSalesAgent
#
# Date: November 14, 2025
################################################################################

set -e

# Color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

AGENT_NAME="${1:-jupiterSalesAgent}"
ENV="${2:-docker}"

################################################################################
# Bug fix (hosting readiness pass): this used to hardcode
#   AGENT_PASSCODE="AgentPass123"
# which connects as a shared fake identity instead of this agent's real one -
# getOrCreateClient() derives the actual signing keys from this value, so the
# wrong passcode means this script would admit credentials as the wrong AID.
# NO SILENT FALLBACK: same pattern as test-agent-verification-DEEP.sh.
################################################################################
TASK_DATA_DIR="./task-data"
AGENT_PASSCODE=""
if [ -f "${TASK_DATA_DIR}/agent-brans.json" ]; then
    AGENT_PASSCODE=$(jq -r ".agents[] | select(.alias == \"${AGENT_NAME}\" or .keriaAlias == \"${AGENT_NAME}\") | .bran" "${TASK_DATA_DIR}/agent-brans.json" 2>/dev/null || echo "")
fi
if [ -z "$AGENT_PASSCODE" ] || [ "$AGENT_PASSCODE" == "null" ]; then
    BRAN_FILE="${TASK_DATA_DIR}/${AGENT_NAME}-bran.txt"
    [ -f "$BRAN_FILE" ] && AGENT_PASSCODE=$(cat "$BRAN_FILE" 2>/dev/null || echo "")
fi
if [ -z "$AGENT_PASSCODE" ] || [ "$AGENT_PASSCODE" == "null" ]; then
    AGENT_INFO_FILE="${TASK_DATA_DIR}/${AGENT_NAME}-info.json"
    [ -f "$AGENT_INFO_FILE" ] && AGENT_PASSCODE=$(jq -r '.bran // .passcode // empty' "$AGENT_INFO_FILE" 2>/dev/null || echo "")
fi
if [ -z "$AGENT_PASSCODE" ] || [ "$AGENT_PASSCODE" == "null" ]; then
    echo -e "${RED}ERROR: Could not find a real BRAN for agent '${AGENT_NAME}'.${NC}" >&2
    echo "   Checked: ${TASK_DATA_DIR}/agent-brans.json, ${TASK_DATA_DIR}/${AGENT_NAME}-bran.txt, ${TASK_DATA_DIR}/${AGENT_NAME}-info.json" >&2
    echo "   Refusing to fall back to a shared fake passcode. Run ./generate-unique-agent-brans.sh first." >&2
    exit 1
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  ADMIT SELF-ATTESTED INVOICE${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Agent: $AGENT_NAME"
echo ""

# Execute admit
echo -e "${BLUE}→ Admitting self-attested invoice credential...${NC}"

docker exec -i tsx_shell tsx sig-wallet/src/tasks/invoice/invoice-acdc-admit-self.ts \
  "$ENV" \
  "$AGENT_PASSCODE" \
  "$AGENT_NAME"

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ Self-attested invoice admitted successfully${NC}"
    echo -e "${GREEN}✓ Credential now fully stored in $AGENT_NAME's KERIA${NC}"
    echo ""
else
    echo ""
    echo -e "${RED}✗ Admit failed${NC}"
    echo ""
    exit 1
fi

exit 0
