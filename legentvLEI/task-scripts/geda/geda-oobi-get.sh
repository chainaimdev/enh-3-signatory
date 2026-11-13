#!/bin/bash
# geda-get-oobi.sh - Get the OOBI for the GEDA AID

set -e
echo "Getting OOBI for GEDA AID"
source ./task-scripts/workshop-env-vars.sh
docker exec -i tsx_shell \
  /vlei/tsx-script-runner.sh common/oobi-get.ts \
    'docker' \
    "${GEDA_SALT}" \
    "${GEDA_AID_NAME}"