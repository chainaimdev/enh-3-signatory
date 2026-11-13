#!/bin/bash
# C1d - <agent> resolves <counterparty>'s OOBI and its delegator chain BEFORE an IPEX grant.
# Additive, idempotent, never prints the BRAN, never boots, never fails the run.
# Usage: ./task-scripts/agent/agent-oobi-resolve-counterparty.sh <agent> <counterparty> [env] [maxDepth]
AGENT="${1:?agent alias required}"
COUNTERPARTY="${2:?counterparty alias required}"
ENV="${3:-docker}"
MAX_DEPTH="${4:-4}"
docker exec -i tsx_shell tsx sig-wallet/src/tasks/agent/agent-oobi-resolve-counterparty.ts \
  "$ENV" "$AGENT" "$COUNTERPARTY" "/task-data" "$MAX_DEPTH" || true
