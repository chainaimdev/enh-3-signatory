#!/bin/bash
################################################################################
# invoice-ipex-grant.sh - Send IPEX grant for self-attested invoice
#
# Purpose: jupiterSellerAgent sends IPEX grant to tommyBuyerAgent
#          for the self-attested invoice credential
#
# Usage: ./invoice-ipex-grant.sh <SENDER_AGENT> <RECEIVER_AGENT>
#
# Example: ./invoice-ipex-grant.sh jupiterSellerAgent tommyBuyerAgent
#
# Date: November 27, 2025
################################################################################

set -e

# Color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SENDER_AGENT="${1:-jupiterSellerAgent}"
RECEIVER_AGENT="${2:-tommyBuyerAgent}"
ENV="${3:-docker}"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  IPEX GRANT: Invoice Credential${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Sender: $SENDER_AGENT"
echo "Receiver: $RECEIVER_AGENT"
echo ""

# Check if sender's BRAN file exists
SENDER_BRAN_FILE="./task-data/${SENDER_AGENT}-bran.txt"
if [ ! -f "$SENDER_BRAN_FILE" ]; then
    echo -e "${RED}ERROR: Sender BRAN file not found: $SENDER_BRAN_FILE${NC}"
    echo -e "${YELLOW}The agent must have been created with a unique BRAN.${NC}"
    exit 1
fi

# C2b (13 Nov): the BRAN is NOT passed on the command line (it would show in
# process lists and command logs). The task gets "" and reads
# /task-data/<alias>-bran.txt itself inside the container (same value: trim()).
echo "Using sender's unique BRAN: (hidden)"
echo ""

# Execute IPEX grant - pass empty passcode to let the script read from BRAN file
echo -e "${BLUE}→ Sending IPEX grant...${NC}"

docker exec -i tsx_shell tsx sig-wallet/src/tasks/invoice/invoice-ipex-grant.ts \
  "$ENV" \
  "" \
  "$SENDER_AGENT" \
  "$RECEIVER_AGENT" \
  "/task-data"

if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✓ IPEX grant sent successfully${NC}"
    echo ""
else
    echo ""
    echo -e "${RED}✗ IPEX grant failed${NC}"
    echo ""
    exit 1
fi

exit 0
