#!/bin/bash
# D1 - READ-ONLY IPEX diagnosis. Never prints the BRAN, never boots or writes to KERIA.
# Usage: ./task-scripts/invoice/invoice-ipex-diagnose.sh [receiver] [sender] [env]
set -e
RECEIVER_AGENT="${1:-tommyBuyerAgent}"
SENDER_AGENT="${2:-jupiterSellerAgent}"
ENV="${3:-docker}"
docker exec -i tsx_shell tsx sig-wallet/src/tasks/invoice/invoice-ipex-diagnose.ts \
  "$ENV" "$RECEIVER_AGENT" "$SENDER_AGENT" "/task-data"
