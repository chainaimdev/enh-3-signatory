#!/bin/bash
set -e

AGENT_NAME="${1:-jupiterSellerAgent}"
OOR_HOLDER_NAME="${2:-Jupiter_Chief_Sales_Officer}"
ENV="${3:-docker}"
JSON_OUTPUT="${4:-}"  # NEW: Optional --json flag

# Directory where agent info files are stored
TASK_DATA_DIR="./task-data"

# Try to read agent's BRAN from agent-brans.json (array structure)
AGENT_BRAN=""
if [ -f "${TASK_DATA_DIR}/agent-brans.json" ]; then
    # The structure is: { "agents": [ { "alias": "...", "keriaAlias": "...", "bran": "..." }, ... ] }
    # Since the D0-1 fix, alias == keriaAlias. Match on either so this script
    # works against agent-brans.json files written before or after that fix.
    AGENT_BRAN=$(jq -r ".agents[] | select(.keriaAlias == \"${AGENT_NAME}\" or .alias == \"${AGENT_NAME}\") | .bran" "${TASK_DATA_DIR}/agent-brans.json" 2>/dev/null || echo "")
fi

# If BRAN not found in agent-brans.json, try the agent BRAN file directly
if [ -z "$AGENT_BRAN" ] || [ "$AGENT_BRAN" == "null" ]; then
    BRAN_FILE="${TASK_DATA_DIR}/${AGENT_NAME}-bran.txt"
    if [ -f "$BRAN_FILE" ]; then
        AGENT_BRAN=$(cat "$BRAN_FILE" 2>/dev/null || echo "")
    fi
fi

# If still not found, try reading from agent info file
if [ -z "$AGENT_BRAN" ] || [ "$AGENT_BRAN" == "null" ]; then
    AGENT_INFO_FILE="${TASK_DATA_DIR}/${AGENT_NAME}-info.json"
    if [ -f "$AGENT_INFO_FILE" ]; then
        AGENT_BRAN=$(jq -r '.bran // .passcode // empty' "$AGENT_INFO_FILE" 2>/dev/null || echo "")
    fi
fi

################################################################################
# Phase 0 fix D0-3: NO SILENT FALLBACK.
#
# This block used to do:  AGENT_BRAN="AgentPass123"
# That meant a missing/stale agent-brans.json produced a verification run
# against a passcode that belongs to no real agent. The run would then fail
# deep inside signify-ts with an opaque error, or - worse - appear to pass
# against a leftover AID incepted from that same default. Either way the
# actual defect (BRANs never generated) was hidden.
#
# Now: hard fail with the exact list of paths that were checked.
################################################################################
if [ -z "$AGENT_BRAN" ] || [ "$AGENT_BRAN" == "null" ]; then
    if [ "$JSON_OUTPUT" == "--json" ]; then
        printf '{"success":false,"error":"agent_bran_not_found","agent":"%s","taskDataDir":"%s"}\n' \
            "${AGENT_NAME}" "${TASK_DATA_DIR}"
    else
        echo "❌ ERROR: Could not find a BRAN for agent '${AGENT_NAME}'." >&2
        echo "   Checked:" >&2
        echo "   - ${TASK_DATA_DIR}/agent-brans.json (alias/keriaAlias: ${AGENT_NAME})" >&2
        echo "   - ${TASK_DATA_DIR}/${AGENT_NAME}-bran.txt" >&2
        echo "   - ${TASK_DATA_DIR}/${AGENT_NAME}-info.json" >&2
        echo "" >&2
        echo "   Refusing to fall back to a default passcode - that hides the real" >&2
        echo "   failure. Run ./generate-unique-agent-brans.sh first, then re-run" >&2
        echo "   the 4D workflow so the agent AIDs are incepted from these BRANs." >&2
    fi
    exit 1
fi

# OOR Holder passcode - try to read from info file
################################################################################
# Bug fix (hosting readiness pass): this used to re-hardcode the literal
# PERSON_SALT value directly, duplicated from task-scripts/workshop-env-vars.sh
# with no connection between the two - if that file's PERSON_SALT was ever
# rotated, this would silently keep using the stale copy. Now sources the
# same file and uses $PERSON_SALT as the default (it is itself overridable
# via env var - see workshop-env-vars.sh for the full explanation and the
# warning about NOT changing it for an environment with existing identities).
################################################################################
source ./task-scripts/workshop-env-vars.sh
OOR_PASSCODE="${PERSON_SALT}"
OOR_INFO_FILE="${TASK_DATA_DIR}/${OOR_HOLDER_NAME}-info.json"
if [ -f "$OOR_INFO_FILE" ]; then
    OOR_PASSCODE_FROM_FILE=$(jq -r '.bran // .passcode // empty' "$OOR_INFO_FILE" 2>/dev/null || echo "")
    if [ -n "$OOR_PASSCODE_FROM_FILE" ] && [ "$OOR_PASSCODE_FROM_FILE" != "null" ]; then
        OOR_PASSCODE="$OOR_PASSCODE_FROM_FILE"
    fi
fi

# Only show header if not JSON mode
if [ "$JSON_OUTPUT" != "--json" ]; then
    echo "=========================================="
    echo "DEEP AGENT DELEGATION VERIFICATION"
    echo "=========================================="
    echo ""
    echo "Configuration:"
    echo "  Agent: ${AGENT_NAME}"
    echo "  OOR Holder: ${OOR_HOLDER_NAME}"
    echo "  ENV: ${ENV}"
    echo "  Agent Passcode: (hidden)"
    echo "  OOR Passcode: ${OOR_PASSCODE:0:20}..."
    echo ""
fi

docker exec -i tsx_shell tsx sig-wallet/src/tasks/agent/agent-verify-delegation-deep.ts \
  "${ENV}" \
  "${AGENT_BRAN}" \
  "${OOR_PASSCODE}" \
  "${AGENT_NAME}" \
  "${OOR_HOLDER_NAME}" \
  "${JSON_OUTPUT}"  # Pass JSON flag to TypeScript

if [ $? -eq 0 ]; then
    # Only show text if not JSON mode
    if [ "$JSON_OUTPUT" != "--json" ]; then
        echo ""
        echo "=========================================="
        echo "✅ DEEP VERIFICATION PASSED!"
        echo "=========================================="
    fi
else
    echo ""
    echo "=========================================="
    echo "❌ DEEP VERIFICATION FAILED"
    echo "=========================================="
    exit 1
fi
