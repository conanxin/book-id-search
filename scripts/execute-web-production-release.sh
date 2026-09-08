#!/usr/bin/env bash
# Web Release Production Deployment Execution Executor (S27T-5D)
#
# First irreversible production deployment contract.  Validates the complete
# §5 preflight, atomically claims the production authorization, writes the
# attempt start artifact, hands the deployment to the exact-byte
# deploy-web-release-candidate.sh runtime, post-verifies identity / static /
# smoke / API / Meili, and writes the attempt result artifact.
#
# This script:
#   - is the ONLY future production deploy entrypoint
#   - requires --execute-production-deploy explicit intent (no default execution)
#   - uses BASH_SOURCE[0] to resolve its own repo root (relocatable)
#   - does NOT accept any env override of identity (SOURCE/IMAGE/FP)
#   - does NOT retry / rollback automatically
#   - does NOT delete or replace existing artifacts (atomic create only)
#   - does NOT touch production on its own (production is reached only via the
#     exact-byte deploy runtime, which is the same script already exercised by
#     the S27S / S27T authorized-isolated-e2e preflight)
#
# CLI:
#   scripts/execute-web-production-release.sh \
#       --execute-production-deploy <SOURCE_SHA>
#
# Output (success):
#   STATUS=PASS
#   SOURCE_SHA=<40hex>
#   RELEASE_PLAN_FINGERPRINT=<64hex>
#   EXECUTION_PLAN_FINGERPRINT=<64hex>
#   IMAGE_TAG=<tag>
#   IMAGE_ID=sha256:<64hex>
#   AUTHORIZATION_CLAIMED=true
#   AUTHORIZATION_CONSUMED=true
#   ATTEMPT_STARTED=true
#   PRODUCTION_DEPLOY_STARTED=true
#   PRODUCTION_DEPLOY_EXECUTED=true
#   PRODUCTION_WRITE_EXECUTED=true
#   PRODUCTION_DEPLOY_VERIFIED=true
#   IMAGE_IDENTITY_VERIFIED=PASS
#   STATIC_IDENTITY_VERIFIED=PASS
#   PRODUCTION_SMOKE=PASS
#   API_UNCHANGED=PASS
#   MEILI_UNCHANGED=PASS
#   AUTO_RETRY=false
#   AUTO_ROLLBACK=false
#   ATTEMPT_START_ARTIFACT=<path>
#   ATTEMPT_RESULT_ARTIFACT=<path>
#
# Output (failure):
#   STATUS=BLOCKED
#   BLOCK_REASON=<ENUM>
#   CLAIM_EXECUTED=<true|false>
#   AUTHORIZATION_CONSUMED=<true|false>
#   PRODUCTION_DEPLOY_STARTED=<true|false>
#   PRODUCTION_DEPLOY_EXECUTED=<true|false>
#   PRODUCTION_WRITE_EXECUTED=<true|false>
#   PRODUCTION_TOUCHED=<true|false|unknown>
#   AUTO_RETRY=false
#   AUTO_ROLLBACK=false
#
# Exit code: 0 only on STATUS=PASS; nonzero otherwise.

set -uo pipefail

# ----------------------------------------------------------------------------
# Script-relative repo root resolution (no hardcoded /opt/...)
# ----------------------------------------------------------------------------
SCRIPT_DIR="$(
  CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd
)" || { printf 'STATUS=BLOCKED\nBLOCK_REASON=INTERNAL_SCRIPT_DIR_RESOLUTION_FAILED\n' >&2; exit 2; }
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

# ----------------------------------------------------------------------------
# Sibling runtime paths (exact-byte contract; no env override)
# ----------------------------------------------------------------------------
PLANNER_REL="scripts/plan-web-production-deployment-execution.sh"
CLAIM_REL="scripts/claim-web-production-release-authorization.sh"
DEPLOY_REL="scripts/deploy-web-release-candidate.sh"
GATE_REL="scripts/verify-web-release-runtime-acceptance.py"

PLANNER_SCRIPT="$REPO_ROOT/$PLANNER_REL"
CLAIM_SCRIPT="$REPO_ROOT/$CLAIM_REL"
DEPLOY_SCRIPT="$REPO_ROOT/$DEPLOY_REL"
GATE_SCRIPT="$REPO_ROOT/$GATE_REL"

# ----------------------------------------------------------------------------
# Environment allowlist (strip everything else)
# ----------------------------------------------------------------------------
ALLOWED_ENV_KEYS=(
  PATH HOME USER LOGNAME SHELL LANG LC_ALL TZ TMPDIR
  BOOK_ID_SEARCH_WEB_IMAGE DOCKER_SUDO
)
build_clean_env() {
  local clean=()
  local k
  for k in "${ALLOWED_ENV_KEYS[@]}"; do
    if [ -n "${!k+x}" ]; then
      clean+=("$k=${!k}")
    fi
  done
  printf '%s\n' "${clean[@]}"
}
if declare -F build_clean_env >/dev/null 2>&1; then
  while read -r kv; do
    [ -n "$kv" ] && export "$kv" || true
  done < <(build_clean_env)
  unset $(env | awk -F= '$1 !~ /^PATH$|^HOME$|^USER$|^LOGNAME$|^SHELL$|^LANG$|^LC_ALL$|^TZ$|^TMPDIR$|^BOOK_ID_SEARCH_WEB_IMAGE$|^DOCKER_SUDO$/ {print $1}') 2>/dev/null || true
fi

# ----------------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------------
emit_block() {
  local reason="$1"
  local claim_executed="${2:-false}"
  local auth_consumed="${3:-false}"
  local deploy_started="${4:-false}"
  local deploy_executed="${5:-false}"
  local write_executed="${6:-false}"
  local touched="${7:-false}"
  printf '%s\n' \
    "STATUS=BLOCKED" \
    "BLOCK_REASON=$reason" \
    "CLAIM_EXECUTED=$claim_executed" \
    "AUTHORIZATION_CONSUMED=$auth_consumed" \
    "PRODUCTION_DEPLOY_STARTED=$deploy_started" \
    "PRODUCTION_DEPLOY_EXECUTED=$deploy_executed" \
    "PRODUCTION_WRITE_EXECUTED=$write_executed" \
    "PRODUCTION_TOUCHED=$touched" \
    "AUTO_RETRY=false" \
    "AUTO_ROLLBACK=false"
  exit 1
}

emit_kv() { printf '%s=%s\n' "$1" "$2"; }

sha256_file() {
  sha256sum -- "$1" 2>/dev/null | awk '{print $1}'
}

kv_parse_text() {
  local text="$1" key="$2"
  printf '%s\n' "$text" | awk -F= -v k="$key" '
    $1==k { sub(/^[^=]*=/, ""); print; exit }
  '
}

kv_count() {
  local text="$1" key="$2"
  printf '%s\n' "$text" | awk -F= -v k="$key" '
    $1==k {c++}
    END {print c+0}
  '
}

prod_fact_safe() {
  local cname="$1" field="$2"
  if sudo -n true 2>/dev/null; then
    case "$field" in
      CID)        sudo -n docker inspect "$cname" --format='{{.Id}}' 2>/dev/null ;;
      STARTED_AT) sudo -n docker inspect "$cname" --format='{{.State.StartedAt}}' 2>/dev/null ;;
      IMAGE)      sudo -n docker inspect "$cname" --format='{{.Config.Image}}' 2>/dev/null ;;
      IMAGE_ID)   sudo -n docker inspect "$cname" --format='{{.Image}}' 2>/dev/null ;;
      *) echo "" ;;
    esac
  else
    case "$field" in
      CID)        docker inspect "$cname" --format='{{.Id}}' 2>/dev/null ;;
      STARTED_AT) docker inspect "$cname" --format='{{.State.StartedAt}}' 2>/dev/null ;;
      IMAGE)      docker inspect "$cname" --format='{{.Config.Image}}' 2>/dev/null ;;
      IMAGE_ID)   docker inspect "$cname" --format='{{.Image}}' 2>/dev/null ;;
      *) echo "" ;;
    esac
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
# service.  All postdeploy / preflight inspect paths in this Executor must
# route through it before any docker inspect call.
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
# 1. Argument validation
# ----------------------------------------------------------------------------
if [ "$#" -ne 2 ]; then
  emit_block INVALID_ARGUMENTS
fi

FLAG="$1"
SOURCE_SHA_INPUT="$2"

if [ "$FLAG" != "--execute-production-deploy" ]; then
  emit_block INVALID_ARGUMENTS
fi

# Reject forbidden identity inputs
case "$SOURCE_SHA_INPUT" in
  --execute-production-deploy|--approve-production-deploy|--claim-production-deploy)
    emit_block INVALID_ARGUMENTS
    ;;
esac

if ! printf '%s' "$SOURCE_SHA_INPUT" | grep -qE '^[0-9a-f]{40}$'; then
  emit_block INVALID_SOURCE_SHA
fi

# ----------------------------------------------------------------------------
# 2. Repository production-execution gate (branch / clean / HEAD == origin/main)
# ----------------------------------------------------------------------------
BRANCH="$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null)"
if [ "$BRANCH" != "main" ]; then
  emit_block NOT_MAIN_BRANCH
fi

# Worktree: only the expected untracked 5A/5B/5C/5D working set is allowed.
# Refuse if anything else is dirty.
DIRTY="$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null \
  | grep -v -E '^\?\? (progress/|\.git/|reports/WEB_RELEASE_PRODUCTION_DEPLOYMENT_EXECUTION_CONTRACT\.md$|scripts/plan-web-production-deployment-execution\.sh$|scripts/test-plan-web-production-deployment-execution\.py$|scripts/verify/simulate_web_production_execution_state_machine\.py$|scripts/test-simulate-web-production-execution-state-machine\.py$|scripts/execute-web-production-release\.sh$|scripts/test-execute-web-production-release\.py$|scripts/__pycache__/|scripts/verify/__pycache__/)')"
if [ -n "$DIRTY" ]; then
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
# 3. Preexisting attempt state recovery (filesystem-only, no implicit resume)
# ----------------------------------------------------------------------------
# Locate any pre-existing plan/claim/start/result artifacts that match this
# pipeline.  If a finalized result exists, this attempt is already terminal.
# If a start exists without result, status is unknown.  If a claim exists
# without start, status is CLAIMED_NOT_STARTED.
ATTEMPT_DIR_GUESS=()
# Will be filled in after Execution Plan is known.  Here we just confirm the
# working tree has not been sabotaged by stale attempt artifacts in the wrong
# place — actual artifact reconciliation happens after we know EXECUTION_PLAN_FP.

# ----------------------------------------------------------------------------
# 4. Runtime contract verification (sibling files exist + exact-byte SHA provenance)
# ----------------------------------------------------------------------------
for f in "$PLANNER_SCRIPT" "$CLAIM_SCRIPT" "$DEPLOY_SCRIPT" "$GATE_SCRIPT"; do
  if [ ! -f "$f" ]; then
    emit_block RUNTIME_CONTRACT_MISSING
  fi
done

EXECUTOR_RUNTIME_SHA256="$(sha256_file "$SCRIPT_DIR/execute-web-production-release.sh")"
PLAN_RUNTIME_SHA256="$(sha256_file "$PLANNER_SCRIPT")"
CLAIM_RUNTIME_SHA256="$(sha256_file "$CLAIM_SCRIPT")"
DEPLOY_RUNTIME_SHA256="$(sha256_file "$DEPLOY_SCRIPT")"
RUNTIME_ACCEPTANCE_GATE_SHA256="$(sha256_file "$GATE_SCRIPT")"

# ----------------------------------------------------------------------------
# 5. Run the read-only Planner (exact-byte sibling)
# ----------------------------------------------------------------------------
PLANNER_OUT="$(mktemp)"
PLANNER_ERR="$(mktemp)"
trap 'rm -f "${PLANNER_OUT:-}" "${PLANNER_ERR:-}" "${CLAIM_OUT:-}" "${CLAIM_ERR:-}" "${DEPLOY_OUT:-}" "${DEPLOY_ERR:-}" 2>/dev/null' EXIT INT TERM

if ! bash "$PLANNER_SCRIPT" --plan-production-deploy "$SOURCE_SHA" >"$PLANNER_OUT" 2>"$PLANNER_ERR"; then
  emit_block PLANNER_FAILED
fi

PLANNER_TEXT="$(cat "$PLANNER_OUT")"

PLANNER_STATUS="$(kv_parse_text "$PLANNER_TEXT" STATUS)"
if [ "$PLANNER_STATUS" != "READY_TO_CLAIM" ]; then
  emit_block PLANNER_NOT_READY
fi

PLANNER_SOURCE="$(kv_parse_text "$PLANNER_TEXT" SOURCE_SHA)"
RELEASE_PLAN_FP="$(kv_parse_text "$PLANNER_TEXT" RELEASE_PLAN_FINGERPRINT)"
EXECUTION_PLAN_FP="$(kv_parse_text "$PLANNER_TEXT" EXECUTION_PLAN_FINGERPRINT)"
EXECUTION_PLAN_PATH="$(kv_parse_text "$PLANNER_TEXT" EXECUTION_PLAN_ARTIFACT)"
IMAGE_TAG="$(kv_parse_text "$PLANNER_TEXT" IMAGE_TAG)"
IMAGE_ID="$(kv_parse_text "$PLANNER_TEXT" IMAGE_ID)"

if [ -z "$EXECUTION_PLAN_PATH" ] || [ ! -f "$EXECUTION_PLAN_PATH" ]; then
  emit_block EXECUTION_PLAN_MISSING
fi

# Plan ↔ Source binding
if [ "$PLANNER_SOURCE" != "$SOURCE_SHA" ]; then
  emit_block EXECUTION_PLAN_SOURCE_MISMATCH
fi

# ----------------------------------------------------------------------------
# 6. Execution Plan validation (read-only, exact-byte, mode 600)
# ----------------------------------------------------------------------------
if [ -L "$EXECUTION_PLAN_PATH" ]; then
  emit_block EXECUTION_PLAN_UNSAFE_FILE
fi
if [ ! -f "$EXECUTION_PLAN_PATH" ]; then
  emit_block EXECUTION_PLAN_UNSAFE_FILE
fi
PLAN_MODE="$(stat -c '%a' "$EXECUTION_PLAN_PATH")"
if [ "$PLAN_MODE" != "600" ]; then
  emit_block EXECUTION_PLAN_UNSAFE_PERMISSIONS
fi

PLAN_TEXT="$(cat "$EXECUTION_PLAN_PATH")"

# Canonical source for MANIFEST_SHA / LOCKFILE_SHA is the Execution Plan artifact
# (PLAN_TEXT), NOT Planner stdout.  Planner stdout contract (S27T-5E-R5H-C)
# does NOT emit these two fields; sourcing them from PLANNER_TEXT produced empty
# shell variables and a deterministic REC_FP divergence at SITE_4.  The artifact
# body is mandatory (validated by PLAN_MANDATORY below), so reading from
# PLAN_TEXT is the unique canonical source for these two fields.
MANIFEST_SHA="$(kv_parse_text "$PLAN_TEXT" MANIFEST_SHA)"
LOCKFILE_SHA="$(kv_parse_text "$PLAN_TEXT" LOCKFILE_SHA)"

PLAN_MANDATORY=(
  EXECUTION_PLAN_VERSION SOURCE_SHA RELEASE_PLAN_FINGERPRINT
  EXECUTION_PLAN_FINGERPRINT IMAGE_TAG IMAGE_ID
  MANIFEST_SHA LOCKFILE_SHA AUTHORIZATION_SHA256
  CANDIDATE_EVIDENCE_SHA256 PIPELINE_HEAD
  PLAN_RUNTIME_SHA256 AUTHORIZE_RUNTIME_SHA256 CLAIM_RUNTIME_SHA256
  ORCHESTRATOR_RUNTIME_SHA256 DEPLOY_RUNTIME_SHA256
  RUNTIME_ACCEPTANCE_GATE_SHA256
  PRE_WEB_CID PRE_WEB_STARTED_AT PRE_WEB_CONFIG_IMAGE PRE_WEB_IMAGE_ID
  PRE_API_CID PRE_API_STARTED_AT
  PRE_MEILI_CID PRE_MEILI_STARTED_AT
  EXECUTION_PLAN_READY
)
for k in "${PLAN_MANDATORY[@]}"; do
  v="$(kv_parse_text "$PLAN_TEXT" "$k")"
  if [ -z "$v" ]; then emit_block EXECUTION_PLAN_INCOMPLETE; fi
  c="$(kv_count "$PLAN_TEXT" "$k")"
  if [ "$c" -ne 1 ]; then emit_block EXECUTION_PLAN_AMBIGUOUS; fi
done

if [ "$(kv_parse_text "$PLAN_TEXT" EXECUTION_PLAN_VERSION)" != "1" ]; then
  emit_block EXECUTION_PLAN_INCOMPLETE
fi
if [ "$(kv_parse_text "$PLAN_TEXT" SOURCE_SHA)" != "$SOURCE_SHA" ]; then
  emit_block EXECUTION_PLAN_SOURCE_MISMATCH
fi
if [ "$(kv_parse_text "$PLAN_TEXT" RELEASE_PLAN_FINGERPRINT)" != "$RELEASE_PLAN_FP" ]; then
  emit_block EXECUTION_PLAN_RELEASE_PLAN_MISMATCH
fi
if [ "$(kv_parse_text "$PLAN_TEXT" EXECUTION_PLAN_FINGERPRINT)" != "$EXECUTION_PLAN_FP" ]; then
  emit_block EXECUTION_PLAN_FINGERPRINT_MISMATCH
fi
if [ "$(kv_parse_text "$PLAN_TEXT" IMAGE_TAG)" != "$IMAGE_TAG" ]; then
  emit_block EXECUTION_PLAN_IMAGE_MISMATCH
fi
if [ "$(kv_parse_text "$PLAN_TEXT" IMAGE_ID)" != "$IMAGE_ID" ]; then
  emit_block EXECUTION_PLAN_IMAGE_MISMATCH
fi
if [ "$(kv_parse_text "$PLAN_TEXT" EXECUTION_PLAN_READY)" != "true" ]; then
  emit_block EXECUTION_PLAN_NOT_READY
fi
if [ "$(kv_parse_text "$PLAN_TEXT" CLAIM_EXECUTED)" != "false" ]; then
  emit_block EXECUTION_PLAN_NOT_READY
fi
if [ "$(kv_parse_text "$PLAN_TEXT" PRODUCTION_WRITE_EXECUTED)" != "false" ]; then
  emit_block EXECUTION_PLAN_NOT_READY
fi

# Validate that the Execution Plan's stored EXECUTION_PLAN_FINGERPRINT matches
# the value the Planner reported.  This is a consistency check between the
# Planner's stdout and the artifact's stored value; it does NOT recompute the
# fingerprint (the Planner already did that with its own observed inputs).
if [ "$(kv_parse_text "$PLAN_TEXT" EXECUTION_PLAN_FINGERPRINT)" != "$EXECUTION_PLAN_FP" ]; then
  emit_block EXECUTION_PLAN_FINGERPRINT_MISMATCH
fi

# Validate that the disk-time PLAN_RUNTIME_SHA256 matches the artifact's
# stored value (drift check).  The Planner embedded this SHA into the
# fingerprint when it created the artifact; if the Planner script changed
# since, this fails closed.
DISK_PLAN_SHA="$(sha256_file "$PLANNER_SCRIPT")"
if [ "$DISK_PLAN_SHA" != "$(kv_parse_text "$PLAN_TEXT" PLAN_RUNTIME_SHA256)" ]; then
  emit_block EXECUTION_PLAN_FINGERPRINT_MISMATCH
fi

# Recompute the Execution Plan fingerprint from the artifact's 24 canonical
# fields (using disk-time PLAN_RUNTIME_SHA256).  The stored
# EXECUTION_PLAN_FINGERPRINT must equal this computation; any tampering of
# the artifact body is caught here.  This is the canonical fingerprint
# recomputation mandated by §12 of the S27T-5D contract.
REC_FP="$( {
  printf '%s\n' \
    'EXECUTION_PLAN_VERSION=1' \
    "SOURCE_SHA=$SOURCE_SHA" \
    "RELEASE_PLAN_FINGERPRINT=$RELEASE_PLAN_FP" \
    "IMAGE_TAG=$IMAGE_TAG" \
    "IMAGE_ID=$IMAGE_ID" \
    "MANIFEST_SHA=$MANIFEST_SHA" \
    "LOCKFILE_SHA=$LOCKFILE_SHA" \
    "AUTHORIZATION_SHA256=$(kv_parse_text "$PLAN_TEXT" AUTHORIZATION_SHA256)" \
    "CANDIDATE_EVIDENCE_SHA256=$(kv_parse_text "$PLAN_TEXT" CANDIDATE_EVIDENCE_SHA256)" \
    "PIPELINE_HEAD=$HEAD_SHA" \
    "PLAN_RUNTIME_SHA256=$DISK_PLAN_SHA" \
    "AUTHORIZE_RUNTIME_SHA256=$(kv_parse_text "$PLAN_TEXT" AUTHORIZE_RUNTIME_SHA256)" \
    "CLAIM_RUNTIME_SHA256=$(kv_parse_text "$PLAN_TEXT" CLAIM_RUNTIME_SHA256)" \
    "ORCHESTRATOR_RUNTIME_SHA256=$(kv_parse_text "$PLAN_TEXT" ORCHESTRATOR_RUNTIME_SHA256)" \
    "DEPLOY_RUNTIME_SHA256=$DEPLOY_RUNTIME_SHA256" \
    "RUNTIME_ACCEPTANCE_GATE_SHA256=$RUNTIME_ACCEPTANCE_GATE_SHA256" \
    "PRE_WEB_CID=$(kv_parse_text "$PLAN_TEXT" PRE_WEB_CID)" \
    "PRE_WEB_STARTED_AT=$(kv_parse_text "$PLAN_TEXT" PRE_WEB_STARTED_AT)" \
    "PRE_WEB_CONFIG_IMAGE=$(kv_parse_text "$PLAN_TEXT" PRE_WEB_CONFIG_IMAGE)" \
    "PRE_WEB_IMAGE_ID=$(kv_parse_text "$PLAN_TEXT" PRE_WEB_IMAGE_ID)" \
    "PRE_API_CID=$(kv_parse_text "$PLAN_TEXT" PRE_API_CID)" \
    "PRE_API_STARTED_AT=$(kv_parse_text "$PLAN_TEXT" PRE_API_STARTED_AT)" \
    "PRE_MEILI_CID=$(kv_parse_text "$PLAN_TEXT" PRE_MEILI_CID)" \
    "PRE_MEILI_STARTED_AT=$(kv_parse_text "$PLAN_TEXT" PRE_MEILI_STARTED_AT)"
} | sha256sum | awk '{print $1}' )"
if [ "$REC_FP" != "$EXECUTION_PLAN_FP" ]; then
  emit_block EXECUTION_PLAN_FINGERPRINT_MISMATCH
fi

# Validate that the artifact's 24-field body matches what we expect (canonical
# input is identical to what the Planner used).  This is the integrity check
# that catches tampering of any field in the artifact body.

# ----------------------------------------------------------------------------
# 7. Plan freshness re-validation (pre-claim integrity guard)
# ----------------------------------------------------------------------------
# Current pipeline HEAD must equal Plan PIPELINE_HEAD.
if [ "$(kv_parse_text "$PLAN_TEXT" PIPELINE_HEAD)" != "$HEAD_SHA" ]; then
  emit_block PIPELINE_HEAD_DRIFT
fi

# Authorization SHA must be the current SHA on disk.
PLAN_AUTH_SHA="$(kv_parse_text "$PLAN_TEXT" AUTHORIZATION_SHA256)"
AUTH_PATH="$REPO_ROOT/progress/web-release-authorization-${RELEASE_PLAN_FP}.env"
if [ ! -f "$AUTH_PATH" ]; then
  emit_block AUTHORIZATION_MISSING
fi
CURR_AUTH_SHA="$(sha256_file "$AUTH_PATH")"
if [ "$CURR_AUTH_SHA" != "$PLAN_AUTH_SHA" ]; then
  emit_block AUTHORIZATION_DRIFT
fi

# Current production pre-state must equal Plan PRE_* state.
PLAN_PRE_WEB_CID="$(kv_parse_text "$PLAN_TEXT" PRE_WEB_CID)"
PLAN_PRE_WEB_STARTED_AT="$(kv_parse_text "$PLAN_TEXT" PRE_WEB_STARTED_AT)"
PLAN_PRE_WEB_CONFIG_IMAGE="$(kv_parse_text "$PLAN_TEXT" PRE_WEB_CONFIG_IMAGE)"
PLAN_PRE_WEB_IMAGE_ID="$(kv_parse_text "$PLAN_TEXT" PRE_WEB_IMAGE_ID)"
PLAN_PRE_API_CID="$(kv_parse_text "$PLAN_TEXT" PRE_API_CID)"
PLAN_PRE_API_STARTED_AT="$(kv_parse_text "$PLAN_TEXT" PRE_API_STARTED_AT)"
PLAN_PRE_MEILI_CID="$(kv_parse_text "$PLAN_TEXT" PRE_MEILI_CID)"
PLAN_PRE_MEILI_STARTED_AT="$(kv_parse_text "$PLAN_TEXT" PRE_MEILI_STARTED_AT)"

CURR_PRE_WEB_CID=""
CURR_PRE_WEB_STARTED_AT=""
if WEB_CID="$(current_compose_cid_safe web)"; then
  CURR_PRE_WEB_CID="$(prod_fact_safe "$WEB_CID" CID)"
  CURR_PRE_WEB_STARTED_AT="$(prod_fact_safe "$WEB_CID" STARTED_AT)"
fi
CURR_PRE_API_CID="$(prod_fact_safe book-id-search-api-1 CID)"
CURR_PRE_API_STARTED_AT="$(prod_fact_safe book-id-search-api-1 STARTED_AT)"
CURR_PRE_MEILI_CID="$(prod_fact_safe book-id-search-meilisearch-1 CID)"
CURR_PRE_MEILI_STARTED_AT="$(prod_fact_safe book-id-search-meilisearch-1 STARTED_AT)"

if [ -z "$CURR_PRE_WEB_CID" ] || [ -z "$CURR_PRE_WEB_STARTED_AT" ]; then
  emit_block PRODUCTION_PRE_STATE_DRIFT
fi

if [ "$CURR_PRE_WEB_CID" != "$PLAN_PRE_WEB_CID" ] \
   || [ "$CURR_PRE_WEB_STARTED_AT" != "$PLAN_PRE_WEB_STARTED_AT" ] \
   || [ "$CURR_PRE_API_CID" != "$PLAN_PRE_API_CID" ] \
   || [ "$CURR_PRE_API_STARTED_AT" != "$PLAN_PRE_API_STARTED_AT" ] \
   || [ "$CURR_PRE_MEILI_CID" != "$PLAN_PRE_MEILI_CID" ] \
   || [ "$CURR_PRE_MEILI_STARTED_AT" != "$PLAN_PRE_MEILI_STARTED_AT" ]; then
  emit_block PRODUCTION_PRE_STATE_DRIFT
fi

# Image must still be locally present and identity-stable.
if ! docker image inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  emit_block IMAGE_NOT_LOCALLY_PRESENT
fi
CURR_IMAGE_ID="$(docker image inspect "$IMAGE_TAG" --format='{{.Id}}' 2>/dev/null)"
if [ "$CURR_IMAGE_ID" != "$IMAGE_ID" ]; then
  emit_block IMAGE_IDENTITY_DRIFT
fi

# ----------------------------------------------------------------------------
# 8. Preexisting attempt artifacts (filesystem recovery)
# ----------------------------------------------------------------------------
CLAIM_ARTIFACT_PATH="$REPO_ROOT/progress/web-release-authorization-claim-${RELEASE_PLAN_FP}.env"
START_ARTIFACT_PATH="$REPO_ROOT/progress/web-release-production-attempt-${EXECUTION_PLAN_FP}.start.env"
RESULT_ARTIFACT_PATH="$REPO_ROOT/progress/web-release-production-attempt-${EXECUTION_PLAN_FP}.result.env"

if [ -f "$RESULT_ARTIFACT_PATH" ]; then
  # Already finalized — do NOT re-execute.
  emit_block ATTEMPT_ALREADY_FINALIZED false false false false false false
fi

if [ -f "$START_ARTIFACT_PATH" ] && [ ! -f "$RESULT_ARTIFACT_PATH" ]; then
  emit_block PRODUCTION_ATTEMPT_STATUS_UNKNOWN false false false false true unknown
fi

if [ -f "$CLAIM_ARTIFACT_PATH" ] && [ ! -f "$START_ARTIFACT_PATH" ]; then
  emit_block CLAIMED_NOT_STARTED true true false false false false
fi

# Existing claim is NOT allowed at this point (claim is atomic, this executor
# owns it).
if [ -f "$CLAIM_ARTIFACT_PATH" ]; then
  emit_block AUTHORIZATION_ALREADY_CLAIMED true true false false false false
fi

# Pre-claim write count must be 0.
CLAIM_EXECUTED=false
AUTHORIZATION_CONSUMED=false
PRODUCTION_DEPLOY_STARTED=false
PRODUCTION_DEPLOY_EXECUTED=false
PRODUCTION_WRITE_EXECUTED=false
PRODUCTION_TOUCHED=false

# ----------------------------------------------------------------------------
# 9. CLAIM (first irreversible transition; exact-byte Claim runtime)
# ----------------------------------------------------------------------------
CLAIM_OUT="$(mktemp)"
CLAIM_ERR="$(mktemp)"

if ! bash "$CLAIM_SCRIPT" --claim-production-deploy "$SOURCE_SHA" >"$CLAIM_OUT" 2>"$CLAIM_ERR"; then
  emit_block CLAIM_FAILED false false false false false false
fi

CLAIM_TEXT="$(cat "$CLAIM_OUT")"
if [ "$(kv_parse_text "$CLAIM_TEXT" STATUS)" != "PASS" ]; then
  emit_block CLAIM_FAILED true true false false false false
fi
if [ "$(kv_parse_text "$CLAIM_TEXT" AUTHORIZATION_CLAIMED)" != "true" ]; then
  emit_block CLAIM_FAILED true true false false false false
fi

# Claim output binding
CLAIM_SOURCE="$(kv_parse_text "$CLAIM_TEXT" SOURCE_SHA)"
CLAIM_PLAN_FP="$(kv_parse_text "$CLAIM_TEXT" RELEASE_PLAN_FINGERPRINT)"
CLAIM_IMAGE_TAG="$(kv_parse_text "$CLAIM_TEXT" IMAGE_TAG)"
CLAIM_IMAGE_ID="$(kv_parse_text "$CLAIM_TEXT" IMAGE_ID)"

if [ "$CLAIM_SOURCE" != "$SOURCE_SHA" ] \
   || [ "$CLAIM_PLAN_FP" != "$RELEASE_PLAN_FP" ] \
   || [ "$CLAIM_IMAGE_TAG" != "$IMAGE_TAG" ] \
   || [ "$CLAIM_IMAGE_ID" != "$IMAGE_ID" ]; then
  emit_block CLAIM_OUTPUT_BINDING_FAILED true true false false false false
fi

CLAIM_EXECUTED=true
AUTHORIZATION_CONSUMED=true

# ----------------------------------------------------------------------------
# 10. Post-claim minimal TOCTOU (image identity only; no L2/Planner/E2E rerun)
# ----------------------------------------------------------------------------
POST_CLAIM_IMAGE_ID="$(docker image inspect "$IMAGE_TAG" --format='{{.Id}}' 2>/dev/null)"
if [ -z "$POST_CLAIM_IMAGE_ID" ] || [ "$POST_CLAIM_IMAGE_ID" != "$IMAGE_ID" ]; then
  emit_block POST_CLAIM_IMAGE_TOCLOU_FAILED true true false false false false
fi

# ----------------------------------------------------------------------------
# 11. Start artifact (mode 600, atomic create, no overwrite)
# ----------------------------------------------------------------------------
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

START_BODY="$(
  printf '%s\n' \
    "ATTEMPT_VERSION=1" \
    "SOURCE_SHA=$SOURCE_SHA" \
    "RELEASE_PLAN_FINGERPRINT=$RELEASE_PLAN_FP" \
    "IMAGE_TAG=$IMAGE_TAG" \
    "IMAGE_ID=$IMAGE_ID" \
    "PIPELINE_HEAD=$HEAD_SHA" \
    "PIPELINE_EXECUTOR_SHA256=$EXECUTOR_RUNTIME_SHA256" \
    "PIPELINE_PLAN_SHA256=$PLAN_RUNTIME_SHA256" \
    "PIPELINE_CLAIM_SHA256=$CLAIM_RUNTIME_SHA256" \
    "PIPELINE_DEPLOY_SHA256=$DEPLOY_RUNTIME_SHA256" \
    "PIPELINE_RUNTIME_GATE_SHA256=$RUNTIME_ACCEPTANCE_GATE_SHA256" \
    "AUTHORIZED=true" \
    "CLAIMED=true" \
    "PRODUCTION_DEPLOY_STARTED=true" \
    "STARTED_AT=$STARTED_AT" \
    "PRE_WEB_CID=$PLAN_PRE_WEB_CID" \
    "PRE_WEB_STARTED_AT=$PLAN_PRE_WEB_STARTED_AT" \
    "PRE_WEB_CONFIG_IMAGE=$PLAN_PRE_WEB_CONFIG_IMAGE" \
    "PRE_WEB_IMAGE_ID=$PLAN_PRE_WEB_IMAGE_ID" \
    "PRE_API_CID=$PLAN_PRE_API_CID" \
    "PRE_API_STARTED_AT=$PLAN_PRE_API_STARTED_AT" \
    "PRE_MEILI_CID=$PLAN_PRE_MEILI_CID" \
    "PRE_MEILI_STARTED_AT=$PLAN_PRE_MEILI_STARTED_AT"
)"

# Atomic create
START_TMP="$(mktemp "$REPO_ROOT/progress/.web-release-production-attempt.XXXXXX")"
if ! printf '%s\n' "$START_BODY" > "$START_TMP"; then
  rm -f "$START_TMP"
  emit_block START_ARTIFACT_WRITE_FAILED true true false false false false
fi
chmod 600 "$START_TMP"
if ! mv "$START_TMP" "$START_ARTIFACT_PATH"; then
  rm -f "$START_TMP"
  emit_block START_ARTIFACT_WRITE_FAILED true true false false false false
fi

# Verify atomic write
if [ ! -f "$START_ARTIFACT_PATH" ]; then
  emit_block START_ARTIFACT_WRITE_FAILED true true false false false false
fi
START_MODE="$(stat -c '%a' "$START_ARTIFACT_PATH")"
if [ "$START_MODE" != "600" ]; then
  emit_block START_ARTIFACT_UNSAFE_PERMISSIONS true true true false false true
fi

ATTEMPT_STARTED=true
PRODUCTION_WRITE_EXECUTED=false  # still no real write yet — Deploy must succeed

# ----------------------------------------------------------------------------
# 12. First production write — exact-byte deploy runtime handoff
# ----------------------------------------------------------------------------
DEPLOY_OUT="$(mktemp)"
DEPLOY_ERR="$(mktemp)"

# IMAGE_TAG comes ONLY from Execution Plan; no caller override accepted.
# Use BOOK_ID_SEARCH_WEB_IMAGE to be unambiguous about override (it is in
# the allowlist).  Strict value: exactly the Plan IMAGE_TAG.
export BOOK_ID_SEARCH_WEB_IMAGE="$IMAGE_TAG"

PRODUCTION_DEPLOY_STARTED=true
# Exactly one deploy invocation per executor invocation.  No retry.  No pull.
# No build.  IMAGE_TAG sourced from Execution Plan only.
if bash "$DEPLOY_SCRIPT" "$IMAGE_TAG" >"$DEPLOY_OUT" 2>"$DEPLOY_ERR"; then
  DEPLOY_EXIT_CODE=0
else
  DEPLOY_EXIT_CODE=$?
  PRODUCTION_TOUCHED=true  # production partially touched
  PRODUCTION_WRITE_EXECUTED=true
  # Best-effort result write even on deploy failure.
  DEPLOY_RC_FOR_RESULT=$DEPLOY_EXIT_CODE
  FIN_FAILURE="DEPLOY_FAILED"
  POST_WEB_CID_AT_FAIL=""
  POST_WEB_IMAGE_ID_AT_FAIL=""
  POST_WEB_CONFIG_IMAGE_AT_FAIL=""
  if WEB_CID_AT_FAIL="$(current_compose_cid_safe web)"; then
    POST_WEB_CID_AT_FAIL="$(prod_fact_safe "$WEB_CID_AT_FAIL" CID)"
    POST_WEB_IMAGE_ID_AT_FAIL="$(prod_fact_safe "$WEB_CID_AT_FAIL" IMAGE_ID)"
    POST_WEB_CONFIG_IMAGE_AT_FAIL="$(prod_fact_safe "$WEB_CID_AT_FAIL" IMAGE)"
  fi
  RESULT_BODY="$(
    printf '%s\n' \
      "RESULT_VERSION=1" \
      "SOURCE_SHA=$SOURCE_SHA" \
      "RELEASE_PLAN_FINGERPRINT=$RELEASE_PLAN_FP" \
      "EXECUTION_PLAN_FINGERPRINT=$EXECUTION_PLAN_FP" \
      "DEPLOY_EXIT_CODE=$DEPLOY_RC_FOR_RESULT" \
      "DEPLOY_SCRIPT_SHA256=$DEPLOY_RUNTIME_SHA256" \
      "PRODUCTION_TOUCHED=true" \
      "POST_WEB_CID=$POST_WEB_CID_AT_FAIL" \
      "POST_WEB_CONFIG_IMAGE=$POST_WEB_CONFIG_IMAGE_AT_FAIL" \
      "POST_WEB_IMAGE_ID=$POST_WEB_IMAGE_ID_AT_FAIL" \
      "IMAGE_IDENTITY_VERIFIED=false" \
      "STATIC_IDENTITY_VERIFIED=false" \
      "DIRECT_PRODUCTION_SMOKE=INCOMPLETE" \
      "DIRECT_PRODUCTION_SMOKE_REPORT=" \
      "API_UNCHANGED=false" \
      "MEILI_UNCHANGED=false" \
      "FINAL_STATUS=FAILED" \
      "FINAL_FAILURE_REASON=$FIN_FAILURE" \
      "FINALIZED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "AUTO_RETRY=false" \
      "AUTO_ROLLBACK=false"
  )"
  RESULT_TMP="$(mktemp "$REPO_ROOT/progress/.web-release-production-attempt-result.XXXXXX")"
  if printf '%s\n' "$RESULT_BODY" > "$RESULT_TMP"; then
    chmod 600 "$RESULT_TMP"
    mv "$RESULT_TMP" "$RESULT_ARTIFACT_PATH" 2>/dev/null || rm -f "$RESULT_TMP"
  else
    rm -f "$RESULT_TMP"
  fi
  emit_block DEPLOY_FAILED true true true true true true
fi

PRODUCTION_DEPLOY_EXECUTED=true
PRODUCTION_WRITE_EXECUTED=true
PRODUCTION_TOUCHED=true

# ----------------------------------------------------------------------------
# 13. Post-deploy identity verification (Web Config.Image + Image ID)
# ----------------------------------------------------------------------------
WEB_CID="$(current_compose_cid_safe web)" || emit_block POST_DEPLOY_INSPECTION_FAILED true true true true true true
POST_WEB_CID="$WEB_CID"
POST_WEB_CONFIG_IMAGE="$(prod_fact_safe "$WEB_CID" IMAGE)"
POST_WEB_IMAGE_ID="$(prod_fact_safe "$WEB_CID" IMAGE_ID)"

if [ -z "$POST_WEB_CID" ]; then
  emit_block POST_DEPLOY_INSPECTION_FAILED true true true true true true
fi

# Identity check 1: Config.Image == IMAGE_TAG
if [ "$POST_WEB_CONFIG_IMAGE" != "$IMAGE_TAG" ]; then
  emit_block POST_DEPLOY_CONFIG_IMAGE_MISMATCH true true true true true true
fi
# Identity check 2: Image ID == IMAGE_ID
if [ "$POST_WEB_IMAGE_ID" != "$IMAGE_ID" ]; then
  emit_block POST_DEPLOY_IMAGE_ID_MISMATCH true true true true true true
fi

IMAGE_IDENTITY_VERIFIED=true

# ----------------------------------------------------------------------------
# 14. Static identity verification (candidate vs running)
# ----------------------------------------------------------------------------
# Re-extract static-manifest from the running container using the existing
# release pipeline algorithm.  In the exact-byte production pipeline this
# is `scripts/verify-static-identity.sh` if present, else falls back to a
# sha256sum over the assets directory in the container.
STATIC_VERIFY_SCRIPT="$REPO_ROOT/scripts/verify-static-identity.sh"
STATIC_IDENTITY_VERIFIED=false

CAND_TSV="$REPO_ROOT/progress/web-release-candidate-${SOURCE_SHA}/static-manifest.tsv"
if [ -x "$STATIC_VERIFY_SCRIPT" ]; then
  # Primary path: dedicated multi-file verifier consumes the real manifest and
  # the project-aware WEB_CID.  Verifier fails closed on any malformed input.
  if [ -f "$CAND_TSV" ] && [ -n "$WEB_CID" ]; then
    if bash "$STATIC_VERIFY_SCRIPT" --manifest "$CAND_TSV" --web-cid "$WEB_CID" >/dev/null 2>&1; then
      STATIC_IDENTITY_VERIFIED=true
    fi
  fi
else
  # Fallback path (S27T-5E-R6C): if the dedicated verifier is missing, the
  # postverify MUST fail closed with STATIC_VERIFIER_UNAVAILABLE.  The legacy
  # "sha256sum of candidate.tsv == sha256sum of /usr/share/nginx/html/assets"
  # comparison was structurally incorrect (the assets path is a directory;
  # sha256sum on a directory errors with "Is a directory"), so it is removed.
  STATIC_IDENTITY_VERIFIED=false
fi

# ----------------------------------------------------------------------------
# 15. Mandatory direct-production smoke
# ----------------------------------------------------------------------------
SMOKE_RESULT=FAIL
SMOKE_REPORT=""
if [ -x "$REPO_ROOT/scripts/health-check.ts" ] || [ -f "$REPO_ROOT/scripts/health-check.ts" ]; then
  # S27T-5E-R6C: smoke gate requires only the script and node runtime.
  # node_modules directory prerequisite removed — scripts/health-check.ts
  # imports only Node built-ins (node:http) and has no third-party deps.
  if command -v node >/dev/null 2>&1; then
    SMOKE_OUT="$(mktemp)"
    if (cd "$REPO_ROOT" && timeout 60 node --experimental-strip-types \
        scripts/health-check.ts >"$SMOKE_OUT" 2>&1); then
      if grep -q '"status":"up"' "$SMOKE_OUT" 2>/dev/null; then
        SMOKE_RESULT=PASS
        SMOKE_REPORT="$SMOKE_OUT"
      else
        SMOKE_RESULT=FAIL
        SMOKE_REPORT="$SMOKE_OUT"
      fi
    else
      SMOKE_RESULT=FAIL
      SMOKE_REPORT="$SMOKE_OUT"
    fi
  fi
fi

PRODUCTION_SMOKE="$SMOKE_RESULT"
DIRECT_PRODUCTION_SMOKE_REPORT="$SMOKE_REPORT"

# ----------------------------------------------------------------------------
# 16. API / Meili invariance (hard gate)
# ----------------------------------------------------------------------------
POST_API_CID="$(prod_fact_safe book-id-search-api-1 CID)"
POST_API_STARTED_AT="$(prod_fact_safe book-id-search-api-1 STARTED_AT)"
POST_MEILI_CID="$(prod_fact_safe book-id-search-meilisearch-1 CID)"
POST_MEILI_STARTED_AT="$(prod_fact_safe book-id-search-meilisearch-1 STARTED_AT)"

API_UNCHANGED=false
MEILI_UNCHANGED=false
if [ "$POST_API_CID" = "$PLAN_PRE_API_CID" ] && [ "$POST_API_STARTED_AT" = "$PLAN_PRE_API_STARTED_AT" ]; then
  API_UNCHANGED=true
fi
if [ "$POST_MEILI_CID" = "$PLAN_PRE_MEILI_CID" ] && [ "$POST_MEILI_STARTED_AT" = "$PLAN_PRE_MEILI_STARTED_AT" ]; then
  MEILI_UNCHANGED=true
fi

if [ "$API_UNCHANGED" != "true" ] || [ "$MEILI_UNCHANGED" != "true" ]; then
  PRODUCTION_SCOPE_VIOLATION_OCCURRED=true
else
  PRODUCTION_SCOPE_VIOLATION_OCCURRED=false
fi

# ----------------------------------------------------------------------------
# 17. Result artifact (mode 600, atomic create, no overwrite)
# ----------------------------------------------------------------------------
FINALIZED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "$PRODUCTION_SCOPE_VIOLATION_OCCURRED" = "true" ]; then
  FINAL_STATUS=FAILED
  FINAL_FAILURE_REASON=PRODUCTION_SCOPE_VIOLATION
elif [ "$IMAGE_IDENTITY_VERIFIED" != "true" ] || [ "$STATIC_IDENTITY_VERIFIED" != "true" ] || [ "$PRODUCTION_SMOKE" != "PASS" ]; then
  FINAL_STATUS=FAILED
  FINAL_FAILURE_REASON=POST_VERIFY_FAILED
else
  FINAL_STATUS=PASS
  FINAL_FAILURE_REASON=NONE
fi

RESULT_BODY="$(
  printf '%s\n' \
    "RESULT_VERSION=1" \
    "SOURCE_SHA=$SOURCE_SHA" \
    "RELEASE_PLAN_FINGERPRINT=$RELEASE_PLAN_FP" \
    "EXECUTION_PLAN_FINGERPRINT=$EXECUTION_PLAN_FP" \
    "DEPLOY_EXIT_CODE=$DEPLOY_EXIT_CODE" \
    "DEPLOY_SCRIPT_SHA256=$DEPLOY_RUNTIME_SHA256" \
    "PRODUCTION_TOUCHED=true" \
    "POST_WEB_CID=$POST_WEB_CID" \
    "POST_WEB_CONFIG_IMAGE=$POST_WEB_CONFIG_IMAGE" \
    "POST_WEB_IMAGE_ID=$POST_WEB_IMAGE_ID" \
    "IMAGE_IDENTITY_VERIFIED=$IMAGE_IDENTITY_VERIFIED" \
    "STATIC_IDENTITY_VERIFIED=$STATIC_IDENTITY_VERIFIED" \
    "DIRECT_PRODUCTION_SMOKE=$PRODUCTION_SMOKE" \
    "DIRECT_PRODUCTION_SMOKE_REPORT=$DIRECT_PRODUCTION_SMOKE_REPORT" \
    "API_UNCHANGED=$API_UNCHANGED" \
    "MEILI_UNCHANGED=$MEILI_UNCHANGED" \
    "FINAL_STATUS=$FINAL_STATUS" \
    "FINAL_FAILURE_REASON=$FINAL_FAILURE_REASON" \
    "FINALIZED_AT=$FINALIZED_AT" \
    "AUTO_RETRY=false" \
    "AUTO_ROLLBACK=false"
)"

RESULT_TMP="$(mktemp "$REPO_ROOT/progress/.web-release-production-attempt-result.XXXXXX")"
if ! printf '%s\n' "$RESULT_BODY" > "$RESULT_TMP"; then
  rm -f "$RESULT_TMP"
  emit_block RESULT_ARTIFACT_WRITE_FAILED true true true true true true
fi
chmod 600 "$RESULT_TMP"
if ! mv "$RESULT_TMP" "$RESULT_ARTIFACT_PATH"; then
  rm -f "$RESULT_TMP"
  emit_block RESULT_ARTIFACT_WRITE_FAILED true true true true true true
fi

RESULT_MODE="$(stat -c '%a' "$RESULT_ARTIFACT_PATH")"
if [ "$RESULT_MODE" != "600" ]; then
  emit_block RESULT_ARTIFACT_UNSAFE_PERMISSIONS true true true true true true
fi

# ----------------------------------------------------------------------------
# 18. Success output
# ----------------------------------------------------------------------------
if [ "$FINAL_STATUS" = "PASS" ]; then
  printf '%s\n' \
    "STATUS=PASS" \
    "SOURCE_SHA=$SOURCE_SHA" \
    "RELEASE_PLAN_FINGERPRINT=$RELEASE_PLAN_FP" \
    "EXECUTION_PLAN_FINGERPRINT=$EXECUTION_PLAN_FP" \
    "IMAGE_TAG=$IMAGE_TAG" \
    "IMAGE_ID=$IMAGE_ID" \
    "AUTHORIZATION_CLAIMED=true" \
    "AUTHORIZATION_CONSUMED=true" \
    "ATTEMPT_STARTED=true" \
    "PRODUCTION_DEPLOY_STARTED=true" \
    "PRODUCTION_DEPLOY_EXECUTED=true" \
    "PRODUCTION_WRITE_EXECUTED=true" \
    "PRODUCTION_DEPLOY_VERIFIED=true" \
    "IMAGE_IDENTITY_VERIFIED=PASS" \
    "STATIC_IDENTITY_VERIFIED=PASS" \
    "PRODUCTION_SMOKE=PASS" \
    "API_UNCHANGED=PASS" \
    "MEILI_UNCHANGED=PASS" \
    "AUTO_RETRY=false" \
    "AUTO_ROLLBACK=false" \
    "ATTEMPT_START_ARTIFACT=$START_ARTIFACT_PATH" \
    "ATTEMPT_RESULT_ARTIFACT=$RESULT_ARTIFACT_PATH"
  exit 0
else
  emit_block "$FINAL_FAILURE_REASON" true true true true true true
fi