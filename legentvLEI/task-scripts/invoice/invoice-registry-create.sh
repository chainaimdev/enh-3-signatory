#!/bin/bash
################################################################################
# invoice-registry-create.sh
# Create credential registry for invoice credentials
################################################################################

set -e

ISSUER_ALIAS="${1:-Jupiter_Chief_Sales_Officer}"
REGISTRY_NAME="${2:-JUPITER_SALES_REGISTRY}"

# Source environment variables
source ./task-scripts/workshop-env-vars.sh

# Get passcode for issuer
PASSCODE=$(get_passcode "$ISSUER_ALIAS")

echo "Creating invoice credential registry..."
echo "  Issuer: $ISSUER_ALIAS"
echo "  Registry: $REGISTRY_NAME"
echo ""

docker exec -i tsx_shell tsx \
  sig-wallet/src/tasks/invoice/invoice-registry-create.ts \
  docker \
  "$ISSUER_ALIAS" \
  "$PASSCODE" \
  "$REGISTRY_NAME"

echo ""
echo "✓ Invoice registry created successfully"
