#!/bin/bash
################################################################################
# subagent-oobi-resolve-verifier.sh
#
# Purpose: Sub-agent resolves Sally verifier OOBI
#
# Usage: ./task-scripts/subagent/subagent-oobi-resolve-verifier.sh <sub_agent_alias>
################################################################################

set -e

SUB_AGENT_ALIAS=$1

if [ -z "$SUB_AGENT_ALIAS" ]; then
    echo "ERROR: Missing sub-agent alias"
    echo "Usage: $0 <sub_agent_alias>"
    exit 1
fi

echo "Sub-agent $SUB_AGENT_ALIAS resolving Sally verifier OOBI..."

# Verifier OOBI (Sally)
VERIFIER_OOBI="http://verifier:9723/oobi"

echo "Sub-agent $SUB_AGENT_ALIAS resolving Verifier (Sally) OOBI: $VERIFIER_OOBI"

################################################################################
# Bug fix (hosting readiness pass): see subagent-oobi-resolve-qvi.sh for the
# full explanation. This was passing "$SUB_AGENT_ALIAS" itself as the
# passcode instead of the sub-agent's real BRAN. NO SILENT FALLBACK.
################################################################################
SUB_AGENT_BRAN_FILE="./task-data/${SUB_AGENT_ALIAS}-bran.txt"
if [ ! -f "$SUB_AGENT_BRAN_FILE" ]; then
    echo "ERROR: Could not find real BRAN for sub-agent '${SUB_AGENT_ALIAS}': ${SUB_AGENT_BRAN_FILE}" >&2
    echo "Refusing to fall back to a fake/derived passcode. Create the sub-agent's BRAN first." >&2
    exit 1
fi
SUB_AGENT_BRAN=$(cat "$SUB_AGENT_BRAN_FILE")

# Run OOBI resolution
docker exec -i tsx_shell tsx \
    sig-wallet/src/tasks/common/oobi-resolve.ts \
    docker \
    "$SUB_AGENT_BRAN" \
    "$VERIFIER_OOBI" \
    "/task-data"

echo "✓ Verifier OOBI resolved by sub-agent $SUB_AGENT_ALIAS"

exit 0