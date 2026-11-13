#!/bin/bash
# G-36 - READ-ONLY export of an invoice credential's issuance proof (TEL iss + KEL anchor).
# Never prints the BRAN, never boots or writes to KERIA.
# Writes ./task-data/<issuer>-invoice-issuance-<said>.json
# Usage: ./task-scripts/invoice/invoice-export-issuance.sh [issuer] [credentialSAID] [env]
#   credentialSAID default: "said" in ./task-data/<issuer>-self-invoice-credential-info.json
set -e
export MSYS_NO_PATHCONV=1   # Git Bash: keep /task-data as a container path (no effect on Linux)
ISSUER_AGENT="${1:-jupiterSellerAgent}"
CRED_SAID="${2:-}"
ENV="${3:-docker}"
docker exec -i tsx_shell tsx sig-wallet/src/tasks/invoice/invoice-export-issuance.ts \
  "$ENV" "$ISSUER_AGENT" "$CRED_SAID" "/task-data"
