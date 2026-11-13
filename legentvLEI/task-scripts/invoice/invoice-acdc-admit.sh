#!/bin/bash
################################################################################
# invoice-acdc-admit.sh
# Admit invoice credential (buyer agent receives and admits)
################################################################################

set -e

HOLDER_ALIAS="${1:-tommyBuyerAgent}"

# Source environment variables
source ./task-scripts/workshop-env-vars.sh

# Get passcode for holder
PASSCODE=$(get_passcode "$HOLDER_ALIAS")

echo "Admitting invoice credential..."
echo "  Holder: $HOLDER_ALIAS"
echo ""

docker exec -i tsx_shell tsx \
  sig-wallet/src/tasks/invoice/invoice-acdc-admit.ts \
  docker \
  "$HOLDER_ALIAS" \
  "$PASSCODE"

echo ""
echo "✓ Invoice credential admitted successfully"
