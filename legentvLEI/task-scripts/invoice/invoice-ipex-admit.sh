#!/bin/bash
################################################################################
# invoice-ipex-admit.sh - Admit IPEX grant for invoice credential
#
# Purpose: tommyBuyerAgent admits the IPEX grant from jupiterSellerAgent
#          for the invoice credential
#
# Usage: ./invoice-ipex-admit.sh <RECEIVER_AGENT> <SENDER_AGENT>
#
# Example: ./invoice-ipex-admit.sh tommyBuyerAgent jupiterSellerAgent
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

RECEIVER_AGENT="${1:-tommyBuyerAgent}"
SENDER_AGENT="${2:-jupiterSellerAgent}"
ENV="${3:-docker}"
WAIT_S="${4:-${IPEX_ADMIT_WAIT_S:-60}}"   # seconds to wait for the grant notification

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  IPEX ADMIT: Invoice Credential${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Receiver: $RECEIVER_AGENT"
echo "Sender: $SENDER_AGENT"
echo ""

# Check if receiver's BRAN file exists
RECEIVER_BRAN_FILE="./task-data/${RECEIVER_AGENT}-bran.txt"
if [ ! -f "$RECEIVER_BRAN_FILE" ]; then
    echo -e "${RED}ERROR: Receiver BRAN file not found: $RECEIVER_BRAN_FILE${NC}"
    echo -e "${YELLOW}The agent must have been created with a unique BRAN.${NC}"
    exit 1
fi

# C2b (13 Nov): the BRAN is NOT passed on the command line (it would show in
# process lists and command logs). The task gets "" and reads
# /task-data/<alias>-bran.txt itself inside the container (same value: trim()).
echo "Using receiver's unique BRAN: (hidden)"
echo ""

# Execute IPEX admit
echo -e "${BLUE}→ Admitting IPEX grant...${NC}"

docker exec -i tsx_shell tsx sig-wallet/src/tasks/invoice/invoice-ipex-admit.ts \
  "$ENV" \
  "" \
  "$RECEIVER_AGENT" \
  "$SENDER_AGENT" \
  "/task-data" \
  "$WAIT_S" | tee /tmp/ipex-admit-$$.out
RC=${PIPESTATUS[0]}
RESULT_LINE=$(grep -m1 '^IPEX_ADMIT_RESULT=' /tmp/ipex-admit-$$.out || true); rm -f /tmp/ipex-admit-$$.out

if [ $RC -eq 0 ]; then
    echo ""
    case "$RESULT_LINE" in
      *SUCCESS*credentialHeld=true*)
        echo -e "${GREEN}✓ IPEX admit completed successfully${NC}"
        echo -e "${GREEN}✓ Invoice credential now available in $RECEIVER_AGENT's KERIA${NC}" ;;
      *SUCCESS*)
        echo -e "${GREEN}✓ IPEX admit submitted${NC}"
        echo -e "${YELLOW}⚠ Invoice credential not yet visible in $RECEIVER_AGENT's KERIA (check with invoice-ipex-diagnose.sh)${NC}" ;;
      *)
        echo -e "${YELLOW}⚠ IPEX admit NOT done (${RESULT_LINE:-no result line})${NC}" ;;
    esac
    echo ""
else
    echo ""
    echo -e "${RED}✗ IPEX admit failed${NC}"
    echo ""
    exit 1
fi

exit 0
