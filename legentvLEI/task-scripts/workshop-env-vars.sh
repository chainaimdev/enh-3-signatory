#!/bin/bash
# workshop-env-vars.sh - Environment variables for vLEI workshop module

# Witness AID Prefixes
export WAN_WIT_PRE='BBilc4-L3tFUnfM_wJr4S4OJanAv_VmF_dJNN6vkf2Ha'
export GEDA_PRE='invalid-aid-will-be-replaced'

# GEDA AID details
################################################################################
# Bug fix (hosting readiness pass): these 4 salts used to be hardcoded
# literals with no override mechanism. They are root-of-trust secrets for
# GEDA/QVI/LE/every-OOR-holder - anyone who can read this repo (including the
# public GLEIF hackathon workshop this is based on) already knows these exact
# default values, so they provide NO real confidentiality for a hosted
# deployment.
#
# Now overridable via environment variables, defaulting to the original
# values so existing/already-incepted environments are completely unaffected.
#
# !!! DO NOT change these for an environment that already has identities  !!!
# !!! incepted (i.e. anything with existing task-data/*.json files) - the !!!
# !!! GEDA/QVI/LE/person AIDs were derived from these exact salts. Changing!!!
# !!! them here does NOT rotate an existing identity, it orphans it. A    !!!
# !!! real rotation requires ./stop.sh --fresh && ./deploy.sh --fresh and !!!
# !!! rebuilding the entire trust chain from scratch.                    !!!
#
# For a genuinely private/hosted deployment: generate fresh random salts
# ONCE, before the first deploy, and set them via a git-ignored .env file
# (e.g. GEDA_SALT=$(python3 -c "import secrets,base64; print('0A'+base64.urlsafe_b64encode(secrets.token_bytes(15)).decode()[:21])")).
################################################################################
export GEDA_SALT="${GEDA_SALT:-0AD45YWdzWSwNREuAoitH_CC}"
export QVI_SALT="${QVI_SALT:-0ABZi_wCWBhxFNEenxtf40mL}"
export LE_SALT="${LE_SALT:-0ACzkItDY-F7lqI9ZtTQ1qR5}"
export PERSON_SALT="${PERSON_SALT:-0ADckowyGuNwtJUPLeRqZvTp}"

export GEDA_REGISTRY='geda-qvi-registry'

export QVI_SCHEMA_SAID='EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao'
export LE_SCHEMA_SAID='ENPXp1vQzRF6JwIuS-mp2U8Uf1MoADoP_GqQ62VsDZWY'
export OOR_AUTH_SCHEMA_SAID='EKA57bKBKxr_kN7iN5i7lMUxpMG-s19dRcmov1iDxz-E'
export OOR_SCHEMA_SAID='EBNaNu-M9P5cgrnfl2Fvymy4E_jvxxyjb70PRtiANlJy'
export ECR_AUTH_SCHEMA_SAID='EH6ekLjSr8V32WyFbGe1zXjTzFs9PkTYmupJ9H65O14g'
export ECR_SCHEMA_SAID='EEy9PkikFcANV1l7EHukCeXqrzT1hNZjGlUk7wuMO5jw'
export GEDA_AID_NAME='geda'
export QVI_AID_NAME='qvi'

export VERIFIER_AID='EMrjKv0T43sslqFfhlEHC9v3t9UoxHWrGznQ1EveRXUO'
export VERIFIER_OOBI='http://verifier:9723/oobi'

