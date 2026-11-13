#!/bin/bash
################################################################################
# subagent-oobi-resolve-le.sh
#
# Purpose: Sub-agent resolves LE OOBI
#
# Usage: ./task-scripts/subagent/subagent-oobi-resolve-le.sh <sub_agent_alias> <le_alias>
################################################################################

set -e

SUB_AGENT_ALIAS=$1
LE_ALIAS=$2

if [ -z "$SUB_AGENT_ALIAS" ] || [ -z "$LE_ALIAS" ]; then
    echo "ERROR: Missing arguments"
    echo "Usage: $0 <sub_agent_alias> <le_alias>"
    exit 1
fi

echo "Sub-agent $SUB_AGENT_ALIAS resolving LE OOBI for $LE_ALIAS..."

# Load LE info of THIS sub-agent's own company.
# Bug fix (open item 1): this used ./task-data/le-info.json, which le-aid-create
# overwrites for every company, so it held the LAST company processed (Tommy)
# and Jupiter's sub-agents resolved Tommy's LE OOBI. le-aid-create.ts also
# writes ./task-data/<le_alias>-info.json per company; agent-oobi-resolve-le.sh
# already reads that file. NO FALLBACK to the shared file (it would be wrong).
LE_INFO_FILE="./task-data/${LE_ALIAS}-info.json"
if [ ! -f "$LE_INFO_FILE" ]; then
    echo "ERROR: LE info file not found: $LE_INFO_FILE" >&2
    echo "Refusing to fall back to ./task-data/le-info.json (holds the last company's LE)." >&2
    exit 1
fi

LE_OOBI=$(jq -r '.oobi' "$LE_INFO_FILE")

echo "Sub-agent $SUB_AGENT_ALIAS resolving LE OOBI: $LE_OOBI"

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
    "$LE_OOBI" \
    "/task-data"

echo "✓ LE OOBI resolved by sub-agent $SUB_AGENT_ALIAS"

exit 0