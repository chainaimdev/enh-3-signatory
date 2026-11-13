#!/bin/bash
################################################################################
# agent-oobi-resolve-agent.sh - Resolve OOBI between two agents
#
# Purpose: Allow one agent to resolve the OOBI of another agent
#          for peer-to-peer communication and credential exchange
#
# Usage: ./agent-oobi-resolve-agent.sh <SOURCE_AGENT> <TARGET_AGENT>
#
# Example: ./agent-oobi-resolve-agent.sh jupiterSalesAgent tommyBuyerAgent
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

SOURCE_AGENT="${1}"
TARGET_AGENT="${2}"
ENV="${3:-docker}"

if [ -z "$SOURCE_AGENT" ] || [ -z "$TARGET_AGENT" ]; then
    echo -e "${RED}ERROR: Missing required arguments${NC}"
    echo "Usage: $0 <SOURCE_AGENT> <TARGET_AGENT>"
    exit 1
fi

################################################################################
# KNOWN GAP (found during hosting readiness pass, not fixed here):
# sig-wallet/src/tasks/agent/agent-oobi-resolve-agent.ts does NOT EXIST in
# this repo. This script has never been runnable - it would fail with a
# tsx "module not found" error the moment anything actually called it.
# Confirmed NOT called by run-all-buyerseller-4C-with-agents.sh or
# run-all-buyerseller-4D-with-subdelegation.sh, so it hasn't blocked anything
# so far. Failing loudly here instead of leaving a silent landmine for
# whoever eventually tries to use it standalone.
################################################################################
REQUIRED_TS="./sig-wallet/src/tasks/agent/agent-oobi-resolve-agent.ts"
if [ ! -f "$REQUIRED_TS" ]; then
    echo -e "${RED}ERROR: $REQUIRED_TS does not exist.${NC}" >&2
    echo -e "${RED}This script's agent-to-agent OOBI resolution was never implemented.${NC}" >&2
    echo -e "${YELLOW}It is not called by any known workflow (4C/4D) - safe to ignore unless${NC}" >&2
    echo -e "${YELLOW}you specifically need direct agent-to-agent OOBI resolution.${NC}" >&2
    exit 1
fi

################################################################################
# Bug fix (hosting readiness pass): this used to hardcode
#   AGENT_PASSCODE="AgentPass123"
# unconditionally - not even a fallback, always this value regardless of
# which SOURCE_AGENT was passed in. Fixed to use SOURCE_AGENT's own real BRAN,
# since it is that agent's identity performing the resolution.
# NO SILENT FALLBACK.
################################################################################
AGENT_BRAN_FILE="./task-data/${SOURCE_AGENT}-bran.txt"
if [ ! -f "$AGENT_BRAN_FILE" ]; then
    echo -e "${RED}ERROR: Could not find real BRAN for agent '${SOURCE_AGENT}': ${AGENT_BRAN_FILE}${NC}" >&2
    echo -e "${RED}Refusing to fall back to a shared fake passcode. Run ./generate-unique-agent-brans.sh first.${NC}" >&2
    exit 1
fi
AGENT_PASSCODE=$(cat "$AGENT_BRAN_FILE")

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Agent OOBI Resolution${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Source Agent: $SOURCE_AGENT"
echo "Target Agent: $TARGET_AGENT"
echo ""

# Execute OOBI resolution
echo -e "${BLUE}→ Resolving $TARGET_AGENT OOBI from $SOURCE_AGENT...${NC}"

docker exec -i tsx_shell tsx sig-wallet/src/tasks/agent/agent-oobi-resolve-agent.ts \
  "$ENV" \
  "$AGENT_PASSCODE" \
  "$SOURCE_AGENT" \
  "$TARGET_AGENT"

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ OOBI resolution successful${NC}"
    echo -e "${GREEN}✓ $SOURCE_AGENT can now communicate with $TARGET_AGENT${NC}"
    echo ""
else
    echo ""
    echo -e "${RED}✗ OOBI resolution failed${NC}"
    echo ""
    exit 1
fi

exit 0
