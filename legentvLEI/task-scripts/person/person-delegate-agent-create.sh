#!/bin/bash
# person-delegate-agent-create.sh - Person/OOR Holder initiates agent delegation
# Usage: person-delegate-agent-create.sh <oorHolderName> <agentName>

set -e

OOR_HOLDER_NAME=$1
AGENT_NAME=$2

if [ -z "$OOR_HOLDER_NAME" ] || [ -z "$AGENT_NAME" ]; then
  echo "Usage: person-delegate-agent-create.sh <oorHolderName> <agentName>"
  echo "Example: person-delegate-agent-create.sh Jupiter_Chief_Sales_Officer jupiterSellerAgent"
  exit 1
fi

echo "Creating agent delegation request: ${AGENT_NAME} from ${OOR_HOLDER_NAME}"

source ./task-scripts/workshop-env-vars.sh

################################################################################
# Bug fix (hosting readiness pass): this used to pass "${AGENT_SALT:-AgentPass123}"
# as the agent's passcode. person-delegate-agent-create.ts uses this value to
# CREATE the agent's AID (see agent-delegate-with-unique-bran.sh, the correct
# caller of this same .ts file, which reads the real pre-generated BRAN for
# exactly this reason). AGENT_SALT is never set, so this standalone wrapper
# was always creating the agent under a shared fake identity instead of its
# real unique BRAN. NO SILENT FALLBACK.
#
# NOTE: this script is not currently called by run-all-buyerseller-4C/4D -
# those use agent-delegate-with-unique-bran.sh, which already does this
# correctly. Fixing here for anyone who invokes this script directly.
################################################################################
AGENT_BRAN_FILE="./task-data/${AGENT_NAME}-bran.txt"
if [ ! -f "$AGENT_BRAN_FILE" ]; then
    echo "ERROR: Could not find real BRAN for agent '${AGENT_NAME}': ${AGENT_BRAN_FILE}" >&2
    echo "Refusing to fall back to a shared fake passcode. Run ./generate-unique-agent-brans.sh first." >&2
    exit 1
fi
AGENT_BRAN=$(cat "$AGENT_BRAN_FILE")

docker exec -i tsx_shell \
  /vlei/tsx-script-runner.sh person/person-delegate-agent-create.ts \
    'docker' \
    "${AGENT_BRAN}" \
    "/task-data" \
    "${OOR_HOLDER_NAME}" \
    "${AGENT_NAME}"

echo "✓ Agent delegation request created"
echo "   File: ./task-data/${AGENT_NAME}-delegate-info.json"
