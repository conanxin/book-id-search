#!/usr/bin/env bash
# Web Release Production Deployment Execution Planner (S27T-5B)
#
# Read-only planner that validates the complete pre-claim contract
# (S27T-5A §5) and emits a machine-bound Execution Plan artifact.
#
# This script MUST NEVER:
#   - call claim-web-production-release-authorization.sh
#   - call deploy-web-release-candidate.sh directly
#   - run docker compose up / docker build / docker pull
#   - write production state
#   - create or modify authorization or claim artifacts
#
# It MAY:
#   - invoke the versioned L2 quick gate (verify-web-release-runtime-acceptance.py)
#   - invoke scripts/plan-web-production-release.sh
#   - invoke scripts/orchestrate-web-production-release.sh authorized-isolated-e2e
#     (per S27T-5A §23 MANDATORY_BEFORE_PRODUCTION=true)
#   - read progress/ artifacts and docker inspect for read-only preflight
#
# CLI:
#   scripts/plan-web-production-deployment-execution.sh \
#       --plan-production-deploy <SOURCE_SHA>
#
# Output (success):
#   STATUS=READY_TO_CLAIM
#   SOURCE_SHA=...
#   RELEASE_PLAN_FINGERPRINT=...
#   EXECUTION_PLAN_FINGERPRINT=...
#   IMAGE_TAG=...
#   IMAGE_ID=...
#   L2_QUICK=PASS
#   RELEASE_PLAN=PASS
#   AUTHORIZATION_VALIDATED=PASS
#   AUTHORIZATION_UNCLAIMED=true
#   PRECLAIM_IMAGE_IDENTITY=PASS
#   AUTHORIZED_ISOLATED_E2E=PASS
#   PRODUCTION_UNCHANGED=PASS
#   EXECUTION_PLAN_ARTIFACT=<path>
#   EXECUTION_PLAN_READY=true
#   CLAIM_EXECUTED=false
#   PRODUCTION_DEPLOY_STARTED=false
#   PRODUCTION_DEPLOY_EXECUTED=false
#   PRODUCTION_WRITE_EXECUTED=false
#   AUTO_RETRY=false
#   AUTO_ROLLBACK=false
#   EXECUTION_AUTHORIZED=false
#
# Output (blocked):
#   STATUS=BLOCKED
#   BLOCK_REASON=<ENUM>
#   READY_TO_CLAIM=false
#   EXECUTION_PLAN_READY=false
#   CLAIM_EXECUTED=false
#   PRODUCTION_DEPLOY_STARTED=false
#   PRODUCTION_DEPLOY_EXECUTED=false
#   PRODUCTION_WRITE_EXECUTED=false
#   EXECUTION_AUTHORIZED=false
#
# Exit code: 0 only on STATUS=READY_TO_CLAIM; nonzero otherwise.

set -uo pipefail

# ----------------------------------------------------------------------------
# Script-relative repo root resolution (no hardcoded /opt/...)
# ----------------------------------------------------------------------------
SCRIPT_DIR="$(
  CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd
)" || { echo "STATUS=BLOCKED"; echo "BLOCK_REASON=INTERNAL_SCRIPT_DIR_RESOLUTION_FAILED"; exit 2; }
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# ----------------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------------
emit_block() {
  local reason="$1"
  printf '%s\n' \
    "STATUS=BLOCKED" \
    "BLOCK_REASON=$reason" \
    "READY_TO_CLAIM=false" \
    "EXECUTION_PLAN_READY=false" \
    "CLAIM_EXECUTED=false" \
    "PRODUCTION_DEPLOY_STARTED=false" \
    "PRODUCTION_DEPLOY_EXECUTED=false" \
    "PRODUCTION_WRITE_EXECUTED=false" \
    "EXECUTION_AUTHORIZED=false"
  exit 1
}

sha256_file() {
  sha256sum -- "$1" 2>/dev/null | awk '{print $1}'
}

# Read KEY=*** value from a file (first occurrence, exact KEY=)
kv_get() {
  local file="$1" key="$2"
  awk -F= -v k="$key" '
    $1==k { sub(/^[^=]*=/, ""); print; exit }
  ' "$file"
}

# Parse KEY=*** from raw text (first occurrence)
kv_parse_text() {
  local text="$1" key="$2"
  printf '%s\n' "$text" | awk -F= -v k="$key" '
    $1==k { sub(/^[^=]*=/, ""); print; exit }
  '
}

# Count exact occurrences of KEY= in text
kv_count() {
  local text="$1" key="$2"
  printf '%s\n' "$text" | awk -F= -v k="$key" '
    $1==k {c++}
    END {print c+0}
  '
}

# Parse production container fact (CID / StartedAt / Image / ImageID)
# Args: container_name  field_name
prod_fact() {
  local cname="$1" field="$2"
  case "$field" in
    CID)        sudo -n docker inspect "$cname" --format='{{.Id}}' 2>/dev/null ;;
    STARTED_AT) sudo -n docker inspect "$cname" --format='{{.State.StartedAt}}' 2>/dev/null ;;
    IMAGE)      sudo -n docker inspect "$cname" --format='{{.Config.Image}}' 2>/dev/null ;;
    IMAGE_ID)   sudo -n docker inspect "$cname" --format='{{.Image}}' 2>/dev/null ;;
    RAW_IMAGE)  sudo -n docker inspect "$cname" --format='{{.Image}}' 2>/dev/null ;;
    *) echo "" ;;
  esac
}

# Try sudo docker without sudo (if already root or docker is accessible)
prod_fact_safe() {
  local cname="$1" field="$2"
  if sudo -n true 2>/dev/null; then
    prod_fact "$cname" "$field"
  else
    docker inspect "$cname" --format="$(case $field in CID){{.Id}};; STARTED_AT){{.State.StartedAt}};; IMAGE){{.Config.Image}};; IMAGE_ID|RAW_IMAGE){{.Image}};; esac)" 2>/dev/null
  fi
}

# Project-scoped Compose service CID lookup (S27T-5E-R5B).
# Returns the exactly-one container ID of the current Compose project's
# <service>.  Exits 0 with exact one CID on stdout only when the project has
# exactly one container for the service.  Fails closed (exit 1, no stdout)
# when the project has zero or >1 containers for the service.  Never falls
# back to a hardcoded global container name.
#
# This is the canonical container identity source for the deployment-target
# service.  All preflight / post-preflight Web identity paths in this
# Planner must route through it before any docker inspect call.
current_compose_cid_safe() {
  local service="$1" cid count
  if sudo -n true 2>/dev/null; then
    cid="$(cd "$REPO_ROOT" && sudo -n docker compose ps -q "$service" 2>/dev/null)"
  else
    cid="$(cd "$REPO_ROOT" && docker compose ps -q "$service" 2>/dev/null)"
  fi
  count="$(printf '%s\n' "$cid" | awk 'NF{c++} END{print c+0}')"
  if [ -z "$cid" ] || [ "$count" -ne 1 ]; then
    return 1
  fi
  printf '%s' "$cid"
  return 0
}

# ----------------------------------------------------------------------------
# 1. Argument validation (CLI contract)
# ----------------------------------------------------------------------------
if [ "$#" -ne 2 ]; then
  echo "STATUS=BLOCKED" >&2
  echo "BLOCK_REASON=INVALID_ARGUMENTS" >&2
  printf '%s\n' \
    "STATUS=BLOCKED" \
    "BLOCK_REASON=INVALID_ARGUMENTS" \
    "READY_TO_CLAIM=false" \
    "EXECUTION_PLAN_READY=false" \
    "CLAIM_EXECUTED=false" \
    "PRODUCTION_DEPLOY_STARTED=false" \
    "PRODUCTION_DEPLOY_EXECUTED=false" \
    "PRODUCTION_WRITE_EXECUTED=false" \
    "EXECUTION_AUTHORIZED=false"
  exit 2
fi

FLAG="$1"
SOURCE_SHA_INPUT="$2"

if [ "$FLAG" != "--plan-production-deploy" ]; then
  emit_block INVALID_ARGUMENTS
fi

# Reject forbidden identity inputs
case "$SOURCE_SHA_INPUT" in
  --execute-production-deploy|--approve-production-deploy|--claim-production-deploy)
    emit_block INVALID_ARGUMENTS
    ;;
esac

if ! printf '%s' "$SOURCE_SHA_INPUT" | grep -qE '^[0-9a-fA-F]{40}$'; then
  emit_block INVALID_SOURCE_SHA
fi

# ----------------------------------------------------------------------------
# 2. Repository production-execution gate (branch / clean / HEAD == origin/main)
# ----------------------------------------------------------------------------
BRANCH="$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null)"
if [ "$BRANCH" != "main" ]; then
  emit_block NOT_MAIN_BRANCH
fi

if [ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null | grep -v -E '^\?\? (progress/|\.git/)')" ]; then
  emit_block WORKTREE_NOT_CLEAN
fi

HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null)"
ORIGIN_MAIN_SHA="$(git -C "$REPO_ROOT" rev-parse origin/main 2>/dev/null)"
if [ -z "$HEAD_SHA" ] || [ -z "$ORIGIN_MAIN_SHA" ] || [ "$HEAD_SHA" != "$ORIGIN_MAIN_SHA" ]; then
  emit_block HEAD_ORIGIN_MISMATCH
fi

# Canonicalize SOURCE_SHA
if ! git -C "$REPO_ROOT" cat-file -e "${SOURCE_SHA_INPUT}^{commit}" 2>/dev/null; then
  emit_block INVALID_SOURCE_SHA
fi
SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse "${SOURCE_SHA_INPUT}^{commit}")"

# ----------------------------------------------------------------------------
# 3. L2 Runtime Acceptance quick gate (subprocess, exact-byte python)
# ----------------------------------------------------------------------------
L2_OUT="$(mktemp)"
L2_ERR="$(mktemp)"
trap 'rm -f "$L2_OUT" "$L2_ERR"' EXIT INT TERM

if ! python3 "$REPO_ROOT/scripts/verify-web-release-runtime-acceptance.py" \
    --profile quick >"$L2_OUT" 2>"$L2_ERR"; then
  emit_block RUNTIME_ACCEPTANCE_QUICK_FAILED
fi

L2_STATUS="$(kv_parse_text "$(cat "$L2_OUT")" STATUS)"
L2_READY="$(kv_parse_text "$(cat "$L2_OUT")" RUNTIME_ACCEPTANCE_READY)"
L2_DEPLOY_MODE="$(kv_parse_text "$(cat "$L2_OUT")" PRODUCTION_DEPLOY_MODE)"
L2_DEPLOY_EXECUTED="$(kv_parse_text "$(cat "$L2_OUT")" PRODUCTION_DEPLOY_EXECUTED)"

if [ "$L2_STATUS" != "PASS" ] \
   || [ "$L2_READY" != "true" ] \
   || [ "$L2_DEPLOY_MODE" != "NOT_IMPLEMENTED" ] \
   || [ "$L2_DEPLOY_EXECUTED" != "false" ]; then
  emit_block RUNTIME_ACCEPTANCE_QUICK_FAILED
fi

# Capture runtime SHAs from each child verifier (re-run individually would be
# expensive; instead compute them from disk).
#
# PLAN_RUNTIME_SHA256 canonical semantic (S27T-5E-R4):
#   = SHA256 of plan-web-production-deployment-execution.sh
#   (THIS script — the script that produces the Execution Plan artifact).
#   The Executor reads this field and validates it equals the disk SHA of
#   $REPO_ROOT/scripts/plan-web-production-deployment-execution.sh.
#   Prior to S27T-5E-R4, this field was incorrectly set to the SHA of
#   plan-web-production-release.sh (a different script — the Release Plan).
#   That mismatch was hidden by test-side iterative reconciliation.
GATE_SHA256="$(sha256_file "$REPO_ROOT/scripts/verify-web-release-runtime-acceptance.py")"
PLAN_RUNTIME_SHA256="$(sha256_file "$REPO_ROOT/scripts/plan-web-production-deployment-execution.sh")"
AUTHORIZE_RUNTIME_SHA256="$(sha256_file "$REPO_ROOT/scripts/authorize-web-production-release.sh")"
CLAIM_RUNTIME_SHA256="$(sha256_file "$REPO_ROOT/scripts/claim-web-production-release-authorization.sh")"
ORCHESTRATOR_RUNTIME_SHA256="$(sha256_file "$REPO_ROOT/scripts/orchestrate-web-production-release.sh")"
DEPLOY_RUNTIME_SHA256="$(sha256_file "$REPO_ROOT/scripts/deploy-web-release-candidate.sh")"

# ----------------------------------------------------------------------------
# 4. Fresh Release Plan (subprocess)
# ----------------------------------------------------------------------------
PLAN_OUT="$(mktemp)"
PLAN_ERR="$(mktemp)"
trap 'rm -f "$L2_OUT" "$L2_ERR" "$PLAN_OUT" "$PLAN_ERR"' EXIT INT TERM

if ! bash "$REPO_ROOT/scripts/plan-web-production-release.sh" "$SOURCE_SHA" >"$PLAN_OUT" 2>"$PLAN_ERR"; then
  emit_block RELEASE_PLAN_FAILED
fi

PLAN_TEXT="$(cat "$PLAN_OUT")"

PLAN_STATUS="$(kv_parse_text "$PLAN_TEXT" STATUS)"
PLAN_READY="$(kv_parse_text "$PLAN_TEXT" RELEASE_PLAN_READY)"
PLAN_FP="$(kv_parse_text "$PLAN_TEXT" RELEASE_PLAN_FINGERPRINT)"
PLAN_IMAGE_TAG="$(kv_parse_text "$PLAN_TEXT" IMAGE_TAG)"
PLAN_IMAGE_ID="$(kv_parse_text "$PLAN_TEXT" IMAGE_ID)"
PLAN_MANIFEST_SHA="$(kv_parse_text "$PLAN_TEXT" MANIFEST_SHA)"
PLAN_LOCKFILE_SHA="$(kv_parse_text "$PLAN_TEXT" LOCKFILE_SHA)"
PLAN_SOURCE_SHA="$(kv_parse_text "$PLAN_TEXT" SOURCE_SHA)"

if [ "$PLAN_STATUS" != "PASS" ] || [ "$PLAN_READY" != "true" ]; then
  emit_block RELEASE_PLAN_FAILED
fi

# Mandatory field presence (exactly once)
PLAN_MANDATORY=(
  STATUS RELEASE_PLAN_VERSION SOURCE_SHA IMAGE_TAG IMAGE_ID
  MANIFEST_SHA LOCKFILE_SHA RELEASE_PLAN_FINGERPRINT
  READINESS_GATE ISOLATED_E2E PRODUCTION_UNCHANGED
  RELEASE_PLAN_READY DEPLOY_EXECUTED
)
for k in "${PLAN_MANDATORY[@]}"; do
  v="$(kv_parse_text "$PLAN_TEXT" "$k")"
  if [ -z "$v" ]; then emit_block RELEASE_PLAN_INCOMPLETE; fi
  c="$(kv_count "$PLAN_TEXT" "$k")"
  if [ "$c" -ne 1 ]; then emit_block RELEASE_PLAN_AMBIGUOUS; fi
done

# Identity mismatch
if [ "$PLAN_SOURCE_SHA" != "$SOURCE_SHA" ]; then
  emit_block SOURCE_IDENTITY_MISMATCH
fi

# Recompute Plan fingerprint
# Canonical: 5 fields each followed by exactly one '\n' (5 newlines total).
# Matches Python: hashlib.sha256(("\n".join([..., ""])).encode()) which also produces
# "...last\n" — one trailing newline.
REC_FP="$(printf '%s\n%s\n%s\n%s\n%s\n' \
  "SOURCE_SHA=$PLAN_SOURCE_SHA" \
  "IMAGE_TAG=$PLAN_IMAGE_TAG" \
  "IMAGE_ID=$PLAN_IMAGE_ID" \
  "MANIFEST_SHA=$PLAN_MANIFEST_SHA" \
  "LOCKFILE_SHA=$PLAN_LOCKFILE_SHA" | sha256sum | awk '{print $1}')"

if [ -z "$PLAN_FP" ] || [ "$PLAN_FP" != "$REC_FP" ]; then
  emit_block RELEASE_PLAN_FINGERPRINT_MISMATCH
fi

# ----------------------------------------------------------------------------
# 5. Authorization artifact (auto-derived path; not overridable)
# ----------------------------------------------------------------------------
AUTH_PATH="$REPO_ROOT/progress/web-release-authorization-${PLAN_FP}.env"
CLAIM_PATH="$REPO_ROOT/progress/web-release-authorization-claim-${PLAN_FP}.env"

if [ ! -e "$AUTH_PATH" ]; then emit_block AUTHORIZATION_MISSING; fi
if [ -L "$AUTH_PATH" ]; then emit_block AUTHORIZATION_UNSAFE_FILE; fi
if [ ! -f "$AUTH_PATH" ]; then emit_block AUTHORIZATION_UNSAFE_FILE; fi

AUTH_MODE="$(stat -c '%a' "$AUTH_PATH")"
if [ "$AUTH_MODE" != "600" ]; then emit_block AUTHORIZATION_UNSAFE_PERMISSIONS; fi

AUTH_TEXT="$(cat "$AUTH_PATH")"
AUTH_MANDATORY=(
  AUTHORIZATION_VERSION AUTHORIZED_ACTION SOURCE_SHA
  RELEASE_PLAN_FINGERPRINT IMAGE_TAG IMAGE_ID
  MANIFEST_SHA LOCKFILE_SHA EXPLICIT_APPROVAL
  CONSUMABLE_ONCE PRODUCTION_DEPLOY_AUTHORIZED
  PRODUCTION_DEPLOY_EXECUTED
)
for k in "${AUTH_MANDATORY[@]}"; do
  v="$(kv_parse_text "$AUTH_TEXT" "$k")"
  if [ -z "$v" ]; then emit_block AUTHORIZATION_INCOMPLETE; fi
  c="$(kv_count "$AUTH_TEXT" "$k")"
  if [ "$c" -ne 1 ]; then emit_block AUTHORIZATION_AMBIGUOUS; fi
done

# Semantic correctness
if [ "$(kv_parse_text "$AUTH_TEXT" AUTHORIZATION_VERSION)" != "1" ]; then emit_block AUTHORIZATION_INCOMPLETE; fi
if [ "$(kv_parse_text "$AUTH_TEXT" AUTHORIZED_ACTION)" != "production-deploy" ]; then emit_block AUTHORIZATION_INCOMPLETE; fi
if [ "$(kv_parse_text "$AUTH_TEXT" EXPLICIT_APPROVAL)" != "true" ]; then emit_block AUTHORIZATION_INCOMPLETE; fi
if [ "$(kv_parse_text "$AUTH_TEXT" CONSUMABLE_ONCE)" != "true" ]; then emit_block AUTHORIZATION_INCOMPLETE; fi
if [ "$(kv_parse_text "$AUTH_TEXT" PRODUCTION_DEPLOY_AUTHORIZED)" != "true" ]; then emit_block AUTHORIZATION_INCOMPLETE; fi
if [ "$(kv_parse_text "$AUTH_TEXT" PRODUCTION_DEPLOY_EXECUTED)" != "false" ]; then emit_block AUTHORIZATION_NOT_CONSUMABLE; fi

# Authorization ↔ Fresh Plan binding
for k in SOURCE_SHA RELEASE_PLAN_FINGERPRINT IMAGE_TAG IMAGE_ID MANIFEST_SHA LOCKFILE_SHA; do
  auth_v="$(kv_parse_text "$AUTH_TEXT" "$k")"
  case "$k" in
    SOURCE_SHA)                plan_v="$PLAN_SOURCE_SHA" ;;
    RELEASE_PLAN_FINGERPRINT)  plan_v="$PLAN_FP" ;;
    IMAGE_TAG)                 plan_v="$PLAN_IMAGE_TAG" ;;
    IMAGE_ID)                  plan_v="$PLAN_IMAGE_ID" ;;
    MANIFEST_SHA)              plan_v="$PLAN_MANIFEST_SHA" ;;
    LOCKFILE_SHA)              plan_v="$PLAN_LOCKFILE_SHA" ;;
  esac
  if [ "$auth_v" != "$plan_v" ]; then emit_block AUTHORIZATION_PLAN_MISMATCH; fi
done

AUTHORIZATION_SHA256="$(sha256_file "$AUTH_PATH")"

# ----------------------------------------------------------------------------
# 6. Unclaimed hard gate (claim artifact must NOT exist)
# ----------------------------------------------------------------------------
if [ -e "$CLAIM_PATH" ]; then emit_block AUTHORIZATION_ALREADY_CLAIMED; fi

# ----------------------------------------------------------------------------
# 7. Candidate evidence (read-only identity check)
# ----------------------------------------------------------------------------
CAND_DIR="$REPO_ROOT/progress/web-release-candidate-${SOURCE_SHA}"
if [ ! -d "$CAND_DIR" ]; then emit_block CANDIDATE_EVIDENCE_MISSING; fi

CAND_JSON="$CAND_DIR/candidate.json"
if [ ! -f "$CAND_JSON" ]; then emit_block CANDIDATE_EVIDENCE_MISSING; fi

# candidate.json contains tag/imageId/lockfileSha256/staticManifestSha256
# Use awk to extract plain JSON string fields without eval/source
CAND_TAG="$(awk -F'"' '/"tag":/ {for(i=1;i<=NF;i++) if($i=="tag") {print $(i+2); exit}}' "$CAND_JSON")"
CAND_IMAGE_ID_FIELD="$(awk -F'"' '/"imageId":/ {for(i=1;i<=NF;i++) if($i=="imageId") {print $(i+2); exit}}' "$CAND_JSON")"
CAND_LOCKFILE="$(awk -F'"' '/"lockfileSha256":/ {for(i=1;i<=NF;i++) if($i=="lockfileSha256") {print $(i+2); exit}}' "$CAND_JSON")"
CAND_MANIFEST="$(awk -F'"' '/"staticManifestSha256":/ {for(i=1;i<=NF;i++) if($i=="staticManifestSha256") {print $(i+2); exit}}' "$CAND_JSON")"

if [ -z "$CAND_TAG" ] || [ -z "$CAND_IMAGE_ID_FIELD" ] || [ -z "$CAND_LOCKFILE" ] || [ -z "$CAND_MANIFEST" ]; then
  emit_block CANDIDATE_EVIDENCE_MISSING
fi

if [ "$CAND_TAG" != "$PLAN_IMAGE_TAG" ]; then emit_block CANDIDATE_EVIDENCE_MISMATCH; fi
if [ "$CAND_IMAGE_ID_FIELD" != "$PLAN_IMAGE_ID" ]; then emit_block CANDIDATE_EVIDENCE_MISMATCH; fi
if [ "$CAND_LOCKFILE" != "$PLAN_LOCKFILE_SHA" ]; then emit_block CANDIDATE_EVIDENCE_MISMATCH; fi
if [ "$CAND_MANIFEST" != "$PLAN_MANIFEST_SHA" ]; then emit_block CANDIDATE_EVIDENCE_MISMATCH; fi

# Canonical candidate evidence SHA (over candidate.json + static-manifest.tsv)
CANDIDATE_EVIDENCE_SHA256="$(
  {
    sha256_file "$CAND_JSON"
    sha256_file "$CAND_DIR/static-manifest.tsv"
  } | sha256sum | awk '{print $1}'
)"

# ----------------------------------------------------------------------------
# 8. Pre-claim image identity (no pull; read-only)
# ----------------------------------------------------------------------------
if ! sudo -n docker image inspect "$PLAN_IMAGE_TAG" >/dev/null 2>&1; then
  emit_block PRECLAIM_IMAGE_IDENTITY_CHANGED
fi

INSPECT_ID="$(sudo -n docker image inspect "$PLAN_IMAGE_TAG" --format='{{.Id}}' 2>/dev/null)"
if [ -z "$INSPECT_ID" ] || [ "$INSPECT_ID" != "$PLAN_IMAGE_ID" ]; then
  emit_block PRECLAIM_IMAGE_IDENTITY_CHANGED
fi

# ----------------------------------------------------------------------------
# 9. Production pre-state (read-only baseline)
# ----------------------------------------------------------------------------
PRE_WEB_CID=""
PRE_WEB_STARTED_AT=""
PRE_WEB_CONFIG_IMAGE=""
PRE_WEB_IMAGE_ID=""
if WEB_CID="$(current_compose_cid_safe web)"; then
  PRE_WEB_CID="$(prod_fact_safe "$WEB_CID" CID)"
  PRE_WEB_STARTED_AT="$(prod_fact_safe "$WEB_CID" STARTED_AT)"
  PRE_WEB_CONFIG_IMAGE="$(prod_fact_safe "$WEB_CID" IMAGE)"
  PRE_WEB_IMAGE_ID="$(prod_fact_safe "$WEB_CID" IMAGE_ID)"
fi

PRE_API_CID="$(prod_fact_safe book-id-search-api-1 CID)"
PRE_API_STARTED_AT="$(prod_fact_safe book-id-search-api-1 STARTED_AT)"

PRE_MEILI_CID="$(prod_fact_safe book-id-search-meilisearch-1 CID)"
PRE_MEILI_STARTED_AT="$(prod_fact_safe book-id-search-meilisearch-1 STARTED_AT)"

if [ -z "$PRE_WEB_CID" ] || [ -z "$PRE_API_CID" ] || [ -z "$PRE_MEILI_CID" ]; then
  emit_block PRODUCTION_SNAPSHOT_FAILED
fi

# ----------------------------------------------------------------------------
# 10. Mandatory authorized-isolated-e2e preflight (S27T-5A §23)
# ----------------------------------------------------------------------------
AUTH_SHA_BEFORE="$AUTHORIZATION_SHA256"

ORCH_OUT="$(mktemp)"
ORCH_ERR="$(mktemp)"
trap 'rm -f "$L2_OUT" "$L2_ERR" "$PLAN_OUT" "$PLAN_ERR" "$ORCH_OUT" "$ORCH_ERR"' EXIT INT TERM

if ! bash "$REPO_ROOT/scripts/orchestrate-web-production-release.sh" \
    authorized-isolated-e2e "$SOURCE_SHA" >"$ORCH_OUT" 2>"$ORCH_ERR"; then
  emit_block AUTHORIZED_ISOLATED_E2E_FAILED
fi

ORCH_TEXT="$(cat "$ORCH_OUT")"
ORCH_REQUIRED=(
  STATUS ORCHESTRATION_MODE
  AUTHORIZATION_VALIDATED AUTHORIZATION_CONSUMABLE
  PRE_DEPLOY_IMAGE_IDENTITY HANDOFF_IDENTITY_SOURCE
  ACTUAL_DEPLOY_SCRIPT_E2E POST_DEPLOY_IMAGE_IDENTITY
  DEV_FALLBACK_USED PRODUCTION_UNCHANGED
  PRODUCTION_DEPLOY_EXECUTED AUTHORIZATION_CONSUMED
)
for k in "${ORCH_REQUIRED[@]}"; do
  v="$(kv_parse_text "$ORCH_TEXT" "$k")"
  if [ -z "$v" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
done

if [ "$(kv_parse_text "$ORCH_TEXT" STATUS)" != "PASS" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
if [ "$(kv_parse_text "$ORCH_TEXT" AUTHORIZATION_VALIDATED)" != "PASS" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
if [ "$(kv_parse_text "$ORCH_TEXT" AUTHORIZATION_CONSUMABLE)" != "PASS" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
if [ "$(kv_parse_text "$ORCH_TEXT" PRE_DEPLOY_IMAGE_IDENTITY)" != "PASS" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
if [ "$(kv_parse_text "$ORCH_TEXT" HANDOFF_IDENTITY_SOURCE)" != "RELEASE_PLAN" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
if [ "$(kv_parse_text "$ORCH_TEXT" ACTUAL_DEPLOY_SCRIPT_E2E)" != "PASS" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
if [ "$(kv_parse_text "$ORCH_TEXT" POST_DEPLOY_IMAGE_IDENTITY)" != "PASS" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
if [ "$(kv_parse_text "$ORCH_TEXT" DEV_FALLBACK_USED)" != "false" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
if [ "$(kv_parse_text "$ORCH_TEXT" PRODUCTION_UNCHANGED)" != "PASS" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
if [ "$(kv_parse_text "$ORCH_TEXT" PRODUCTION_DEPLOY_EXECUTED)" != "false" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi
if [ "$(kv_parse_text "$ORCH_TEXT" AUTHORIZATION_CONSUMED)" != "false" ]; then emit_block AUTHORIZED_ISOLATED_E2E_FAILED; fi

# Authorization immutability across isolated run
AUTH_SHA_AFTER="$(sha256_file "$AUTH_PATH")"
if [ "$AUTH_SHA_BEFORE" != "$AUTH_SHA_AFTER" ]; then emit_block AUTHORIZATION_MUTATED_DURING_PREFLIGHT; fi

# Claim artifact still absent
if [ -e "$CLAIM_PATH" ]; then emit_block AUTHORIZATION_MUTATED_DURING_PREFLIGHT; fi

# ----------------------------------------------------------------------------
# 11. Production unchanged AFTER preflight
# ----------------------------------------------------------------------------
POST_WEB_CID=""
POST_WEB_STARTED_AT=""
POST_WEB_CONFIG_IMAGE=""
POST_WEB_IMAGE_ID=""
if WEB_CID="$(current_compose_cid_safe web)"; then
  POST_WEB_CID="$(prod_fact_safe "$WEB_CID" CID)"
  POST_WEB_STARTED_AT="$(prod_fact_safe "$WEB_CID" STARTED_AT)"
  POST_WEB_CONFIG_IMAGE="$(prod_fact_safe "$WEB_CID" IMAGE)"
  POST_WEB_IMAGE_ID="$(prod_fact_safe "$WEB_CID" IMAGE_ID)"
fi

POST_API_CID="$(prod_fact_safe book-id-search-api-1 CID)"
POST_API_STARTED_AT="$(prod_fact_safe book-id-search-api-1 STARTED_AT)"

POST_MEILI_CID="$(prod_fact_safe book-id-search-meilisearch-1 CID)"
POST_MEILI_STARTED_AT="$(prod_fact_safe book-id-search-meilisearch-1 STARTED_AT)"

if [ "$PRE_WEB_CID" != "$POST_WEB_CID" ] \
   || [ "$PRE_WEB_STARTED_AT" != "$POST_WEB_STARTED_AT" ] \
   || [ "$PRE_API_CID" != "$POST_API_CID" ] \
   || [ "$PRE_API_STARTED_AT" != "$POST_API_STARTED_AT" ] \
   || [ "$PRE_MEILI_CID" != "$POST_MEILI_CID" ] \
   || [ "$PRE_MEILI_STARTED_AT" != "$POST_MEILI_STARTED_AT" ]; then
  emit_block PRODUCTION_CHANGED_DURING_PREFLIGHT
fi

# ----------------------------------------------------------------------------
# 12. Execution Plan fingerprint (canonical serialization)
# ----------------------------------------------------------------------------
PIPELINE_HEAD="$HEAD_SHA"

# Canonical input — fixed key order, NO timestamp / hostname / random
# Canonical: 24 fields, each followed by one newline.
# S27T-5E-R4 bugfix: POSIX printf '%s\n' repeats for all 24 args. The prior
# format had only 22 '%s\n' pairs, silently dropping PRE_MEILI_CID +
# PRE_MEILI_STARTED_AT - producing a different FP than the Executor canonical.
EXECUTION_PLAN_CANONICAL="$(
  printf '%s\n' \
    "EXECUTION_PLAN_VERSION=1" \
    "SOURCE_SHA=$SOURCE_SHA" \
    "RELEASE_PLAN_FINGERPRINT=$PLAN_FP" \
    "IMAGE_TAG=$PLAN_IMAGE_TAG" \
    "IMAGE_ID=$PLAN_IMAGE_ID" \
    "MANIFEST_SHA=$PLAN_MANIFEST_SHA" \
    "LOCKFILE_SHA=$PLAN_LOCKFILE_SHA" \
    "AUTHORIZATION_SHA256=$AUTHORIZATION_SHA256" \
    "CANDIDATE_EVIDENCE_SHA256=$CANDIDATE_EVIDENCE_SHA256" \
    "PIPELINE_HEAD=$PIPELINE_HEAD" \
    "PLAN_RUNTIME_SHA256=$PLAN_RUNTIME_SHA256" \
    "AUTHORIZE_RUNTIME_SHA256=$AUTHORIZE_RUNTIME_SHA256" \
    "CLAIM_RUNTIME_SHA256=$CLAIM_RUNTIME_SHA256" \
    "ORCHESTRATOR_RUNTIME_SHA256=$ORCHESTRATOR_RUNTIME_SHA256" \
    "DEPLOY_RUNTIME_SHA256=$DEPLOY_RUNTIME_SHA256" \
    "RUNTIME_ACCEPTANCE_GATE_SHA256=$GATE_SHA256" \
    "PRE_WEB_CID=$PRE_WEB_CID" \
    "PRE_WEB_STARTED_AT=$PRE_WEB_STARTED_AT" \
    "PRE_WEB_CONFIG_IMAGE=$PRE_WEB_CONFIG_IMAGE" \
    "PRE_WEB_IMAGE_ID=$PRE_WEB_IMAGE_ID" \
    "PRE_API_CID=$PRE_API_CID" \
    "PRE_API_STARTED_AT=$PRE_API_STARTED_AT" \
    "PRE_MEILI_CID=$PRE_MEILI_CID" \
    "PRE_MEILI_STARTED_AT=$PRE_MEILI_STARTED_AT"
)"

EXECUTION_PLAN_FINGERPRINT="$(printf '%s\n' "$EXECUTION_PLAN_CANONICAL" | sha256sum | awk '{print $1}')"

# ----------------------------------------------------------------------------
# 13. Execution Plan artifact atomic write (mode 600)
# ----------------------------------------------------------------------------
EXECUTION_PLAN_PATH="$REPO_ROOT/progress/web-release-production-execution-plan-${EXECUTION_PLAN_FINGERPRINT}.env"

if [ -e "$EXECUTION_PLAN_PATH" ]; then emit_block EXECUTION_PLAN_ALREADY_EXISTS; fi

EXECUTION_PLAN_BODY="$(
  printf '%s\n' \
    "EXECUTION_PLAN_VERSION=1" \
    "SOURCE_SHA=$SOURCE_SHA" \
    "RELEASE_PLAN_FINGERPRINT=$PLAN_FP" \
    "EXECUTION_PLAN_FINGERPRINT=$EXECUTION_PLAN_FINGERPRINT" \
    "IMAGE_TAG=$PLAN_IMAGE_TAG" \
    "IMAGE_ID=$PLAN_IMAGE_ID" \
    "MANIFEST_SHA=$PLAN_MANIFEST_SHA" \
    "LOCKFILE_SHA=$PLAN_LOCKFILE_SHA" \
    "AUTHORIZATION_SHA256=$AUTHORIZATION_SHA256" \
    "CANDIDATE_EVIDENCE_SHA256=$CANDIDATE_EVIDENCE_SHA256" \
    "PIPELINE_HEAD=$PIPELINE_HEAD" \
    "PLAN_RUNTIME_SHA256=$PLAN_RUNTIME_SHA256" \
    "AUTHORIZE_RUNTIME_SHA256=$AUTHORIZE_RUNTIME_SHA256" \
    "CLAIM_RUNTIME_SHA256=$CLAIM_RUNTIME_SHA256" \
    "ORCHESTRATOR_RUNTIME_SHA256=$ORCHESTRATOR_RUNTIME_SHA256" \
    "DEPLOY_RUNTIME_SHA256=$DEPLOY_RUNTIME_SHA256" \
    "RUNTIME_ACCEPTANCE_GATE_SHA256=$GATE_SHA256" \
    "PRE_WEB_CID=$PRE_WEB_CID" \
    "PRE_WEB_STARTED_AT=$PRE_WEB_STARTED_AT" \
    "PRE_WEB_CONFIG_IMAGE=$PRE_WEB_CONFIG_IMAGE" \
    "PRE_WEB_IMAGE_ID=$PRE_WEB_IMAGE_ID" \
    "PRE_API_CID=$PRE_API_CID" \
    "PRE_API_STARTED_AT=$PRE_API_STARTED_AT" \
    "PRE_MEILI_CID=$PRE_MEILI_CID" \
    "PRE_MEILI_STARTED_AT=$PRE_MEILI_STARTED_AT" \
    "L2_QUICK=PASS" \
    "RELEASE_PLAN=PASS" \
    "AUTHORIZATION_VALIDATED=PASS" \
    "AUTHORIZATION_UNCLAIMED=true" \
    "AUTHORIZED_ISOLATED_E2E=PASS" \
    "PRECLAIM_IMAGE_IDENTITY=PASS" \
    "PRODUCTION_UNCHANGED=PASS" \
    "AUTO_RETRY=false" \
    "AUTO_ROLLBACK=false" \
    "CLAIM_EXECUTED=false" \
    "PRODUCTION_DEPLOY_STARTED=false" \
    "PRODUCTION_DEPLOY_EXECUTED=false" \
    "PRODUCTION_WRITE_EXECUTED=false" \
    "EXECUTION_PLAN_READY=true" \
    "EXECUTION_AUTHORIZED=false"
)"

EXECUTION_PLAN_TMP="$(mktemp "$REPO_ROOT/progress/.web-release-production-execution-plan.XXXXXX")"
if ! printf '%s\n' "$EXECUTION_PLAN_BODY" > "$EXECUTION_PLAN_TMP"; then
  rm -f "$EXECUTION_PLAN_TMP"
  emit_block EXECUTION_PLAN_WRITE_FAILED
fi
chmod 600 "$EXECUTION_PLAN_TMP"
if ! mv "$EXECUTION_PLAN_TMP" "$EXECUTION_PLAN_PATH"; then
  rm -f "$EXECUTION_PLAN_TMP"
  emit_block EXECUTION_PLAN_WRITE_FAILED
fi

# Verify artifact
if [ ! -f "$EXECUTION_PLAN_PATH" ]; then emit_block EXECUTION_PLAN_WRITE_FAILED; fi
ARTIFACT_MODE="$(stat -c '%a' "$EXECUTION_PLAN_PATH")"
if [ "$ARTIFACT_MODE" != "600" ]; then emit_block EXECUTION_PLAN_VALIDATION_FAILED; fi

# ----------------------------------------------------------------------------
# 14. Success output
# ----------------------------------------------------------------------------
printf '%s\n' \
  "STATUS=READY_TO_CLAIM" \
  "SOURCE_SHA=$SOURCE_SHA" \
  "RELEASE_PLAN_FINGERPRINT=$PLAN_FP" \
  "EXECUTION_PLAN_FINGERPRINT=$EXECUTION_PLAN_FINGERPRINT" \
  "IMAGE_TAG=$PLAN_IMAGE_TAG" \
  "IMAGE_ID=$PLAN_IMAGE_ID" \
  "L2_QUICK=PASS" \
  "RELEASE_PLAN=PASS" \
  "AUTHORIZATION_VALIDATED=PASS" \
  "AUTHORIZATION_UNCLAIMED=true" \
  "PRECLAIM_IMAGE_IDENTITY=PASS" \
  "AUTHORIZED_ISOLATED_E2E=PASS" \
  "PRODUCTION_UNCHANGED=PASS" \
  "EXECUTION_PLAN_ARTIFACT=$EXECUTION_PLAN_PATH" \
  "EXECUTION_PLAN_READY=true" \
  "CLAIM_EXECUTED=false" \
  "PRODUCTION_DEPLOY_STARTED=false" \
  "PRODUCTION_DEPLOY_EXECUTED=false" \
  "PRODUCTION_WRITE_EXECUTED=false" \
  "AUTO_RETRY=false" \
  "AUTO_ROLLBACK=false" \
  "EXECUTION_AUTHORIZED=false"
exit 0
