#!/bin/bash
################################################################################
# subagent-oobi-resolve-qvi.sh
#
# Purpose: Sub-agent resolves QVI OOBI
#
# Usage: ./task-scripts/subagent/subagent-oobi-resolve-qvi.sh <sub_agent_alias>
################################################################################

set -e

SUB_AGENT_ALIAS=$1

if [ -z "$SUB_AGENT_ALIAS" ]; then
    echo "ERROR: Missing sub-agent alias"
    echo "Usage: $0 <sub_agent_alias>"
    exit 1
fi

echo "Sub-agent $SUB_AGENT_ALIAS resolving QVI OOBI..."

# Load QVI info
QVI_INFO_FILE="./task-data/qvi-info.json"
if [ ! -f "$QVI_INFO_FILE" ]; then
    echo "ERROR: QVI info file not found: $QVI_INFO_FILE"
    exit 1
fi

QVI_OOBI=$(jq -r '.oobi' "$QVI_INFO_FILE")

echo "Sub-agent $SUB_AGENT_ALIAS resolving QVI OOBI: $QVI_OOBI"

################################################################################
# Bug fix (hosting readiness pass): this used to pass "$SUB_AGENT_ALIAS" itself
# as the passcode to oobi-resolve.ts, instead of the sub-agent's real BRAN.
# oobi-resolve.ts pads/uses that value directly as the SignifyClient's
# passcode (see sig-wallet/src/client/identifiers.ts getOrCreateClient) - so
# this was booting/connecting a throwaway identity derived from the alias
# string, NOT the sub-agent's real identity created in
# subagent-delegate-inception.ts. The real sub-agent AID never actually
# performed OOBI resolution, which is the likely root cause of the
# "Agent AID not found in KEL" verification failures. Now reads the same real
# BRAN file subagent-delegate-with-unique-bran-FIXED.sh already requires.
# NO SILENT FALLBACK.
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
    "$QVI_OOBI" \
    "/task-data"

echo "✓ QVI OOBI resolved by sub-agent $SUB_AGENT_ALIAS"

exit 0