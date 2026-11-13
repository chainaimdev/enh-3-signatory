#!/bin/bash
# agent-oobi-resolve-le.sh - Agent resolves LE OOBI
# Usage: agent-oobi-resolve-le.sh <agentName> <leName>

set -e

AGENT_NAME=$1
LE_NAME=$2

if [ -z "$AGENT_NAME" ] || [ -z "$LE_NAME" ]; then
  echo "Usage: agent-oobi-resolve-le.sh <agentName> <leName>"
  echo "Example: agent-oobi-resolve-le.sh jupiterSellerAgent Jupiter_Knitting"
  exit 1
fi

echo "Agent ${AGENT_NAME} resolving LE OOBI for ${LE_NAME}"

source ./task-scripts/workshop-env-vars.sh

LE_OOBI=$(cat ./task-data/${LE_NAME}-info.json | jq -r .oobi)

################################################################################
# Bug fix (hosting readiness pass): see agent-oobi-resolve-qvi.sh for full
# explanation. AGENT_SALT is never set, so this always used the shared fake
# identity "AgentPass123" instead of this agent's own real BRAN.
# NO SILENT FALLBACK.
################################################################################
AGENT_BRAN_FILE="./task-data/${AGENT_NAME}-bran.txt"
if [ ! -f "$AGENT_BRAN_FILE" ]; then
    echo "ERROR: Could not find real BRAN for agent '${AGENT_NAME}': ${AGENT_BRAN_FILE}" >&2
    echo "Refusing to fall back to a shared fake passcode. Run ./generate-unique-agent-brans.sh first." >&2
    exit 1
fi
AGENT_BRAN=$(cat "$AGENT_BRAN_FILE")

docker exec -i tsx_shell \
  /vlei/tsx-script-runner.sh agent/agent-oobi-resolve-le.ts \
    'docker' \
    "${AGENT_BRAN}" \
    "${AGENT_NAME}" \
    "${LE_OOBI}"

echo "✓ LE OOBI resolved by agent ${AGENT_NAME}"
