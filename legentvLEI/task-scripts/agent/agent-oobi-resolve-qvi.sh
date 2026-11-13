#!/bin/bash
# agent-oobi-resolve-qvi.sh - Agent resolves QVI OOBI
# Usage: agent-oobi-resolve-qvi.sh <agentName>

set -e

AGENT_NAME=$1

if [ -z "$AGENT_NAME" ]; then
  echo "Usage: agent-oobi-resolve-qvi.sh <agentName>"
  echo "Example: agent-oobi-resolve-qvi.sh jupiterSellerAgent"
  exit 1
fi

echo "Agent ${AGENT_NAME} resolving QVI OOBI"

source ./task-scripts/workshop-env-vars.sh

QVI_OOBI=$(cat ./task-data/qvi-info.json | jq -r .oobi)

################################################################################
# Bug fix (hosting readiness pass): this used to pass "${AGENT_SALT:-AgentPass123}".
# AGENT_SALT is never set anywhere in workshop-env-vars.sh, so every call used
# the shared fake identity "AgentPass123" instead of this agent's own real
# BRAN - meaning the OOBI resolution was never actually performed as the real
# jupiterSellerAgent/tommyBuyerAgent/etc. identity created earlier in the
# delegation workflow. Now reads the agent's real BRAN, same file this agent
# was created from (see generate-unique-agent-brans.sh / agent-delegate-with-unique-bran.sh).
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
  /vlei/tsx-script-runner.sh agent/agent-oobi-resolve-qvi.ts \
    'docker' \
    "${AGENT_BRAN}" \
    "${AGENT_NAME}" \
    "${QVI_OOBI}"

echo "✓ QVI OOBI resolved by agent ${AGENT_NAME}"
