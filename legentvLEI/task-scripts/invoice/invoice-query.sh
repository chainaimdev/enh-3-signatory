#!/bin/bash
################################################################################
# invoice-query.sh - Query invoice credentials from KERIA agent
#
# Purpose: Query and display invoice credentials stored in an agent's KERIA
#
# Usage: ./invoice-query.sh <AGENT_NAME> [ENV]
#
# Example: ./invoice-query.sh jupiterSalesAgent
#          ./invoice-query.sh tommyBuyerAgent
#
# Date: November 14, 2025
################################################################################

set -e

# Color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
NC='\033[0m'

AGENT_NAME="${1:-jupiterSalesAgent}"
ENV="${2:-docker}"

################################################################################
# Bug fix (hosting readiness pass): this used to hardcode
#   AGENT_PASSCODE="AgentPass123"
# which connects as a shared fake identity instead of this agent's real one -
# getOrCreateClient() derives the actual signing keys from this value, so the
# wrong passcode means this script silently operates as the wrong AID.
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
echo -e "${BLUE}  QUERY INVOICE CREDENTIALS${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Agent: $AGENT_NAME"
echo ""

# Execute query
echo -e "${BLUE}→ Querying credentials from KERIA...${NC}"
echo ""

docker exec -i tsx_shell tsx sig-wallet/src/tasks/invoice/invoice-query.ts \
  "$ENV" \
  "$AGENT_PASSCODE" \
  "$AGENT_NAME"

QUERY_EXIT_CODE=$?

if [ $QUERY_EXIT_CODE -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ Query completed successfully${NC}"
    echo ""
    
    # Check if results file exists
    RESULTS_FILE="./task-data/${AGENT_NAME}-invoice-query-results.json"
    if [ -f "$RESULTS_FILE" ]; then
        echo -e "${CYAN}Query Results:${NC}"
        cat "$RESULTS_FILE" | jq '.'
        echo ""
        
        # Display summary
        INVOICE_COUNT=$(cat "$RESULTS_FILE" | jq '.invoices | length' 2>/dev/null || echo "0")
        echo -e "${GREEN}Total Invoice Credentials: ${INVOICE_COUNT}${NC}"
        echo ""
        
        # Display each invoice
        if [ "$INVOICE_COUNT" -gt 0 ]; then
            echo -e "${MAGENTA}Invoice Details:${NC}"
            for ((i=0; i<$INVOICE_COUNT; i++)); do
                INVOICE_SAID=$(cat "$RESULTS_FILE" | jq -r ".invoices[$i].said" 2>/dev/null || echo "N/A")
                INVOICE_NUM=$(cat "$RESULTS_FILE" | jq -r ".invoices[$i].invoiceNumber" 2>/dev/null || echo "N/A")
                INVOICE_AMOUNT=$(cat "$RESULTS_FILE" | jq -r ".invoices[$i].totalAmount" 2>/dev/null || echo "N/A")
                INVOICE_CURRENCY=$(cat "$RESULTS_FILE" | jq -r ".invoices[$i].currency" 2>/dev/null || echo "N/A")
                SELF_ATTESTED=$(cat "$RESULTS_FILE" | jq -r ".invoices[$i].selfAttested" 2>/dev/null || echo "false")
                
                echo -e "${BLUE}  Invoice #$((i+1)):${NC}"
                echo "    SAID: $INVOICE_SAID"
                echo "    Number: $INVOICE_NUM"
                echo "    Amount: $INVOICE_AMOUNT $INVOICE_CURRENCY"
                echo "    Self-Attested: $SELF_ATTESTED"
                echo ""
            done
        fi
    else
        echo -e "${YELLOW}⚠ Query results file not found: ${RESULTS_FILE}${NC}"
        echo ""
    fi
else
    echo ""
    echo -e "${YELLOW}⚠ Query completed with warnings or no invoices found${NC}"
    echo ""
fi

exit 0
