#!/usr/bin/env bash
set -euo pipefail

block() {
  printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nR7_ACCEPTANCE=BLOCKED\nAUTO_RETRY=NO\n' "$1"
  exit 1
}

MODE="${1:-}"
case "$MODE" in
  --begin-r7-external|--execute-r7-api|--complete-r7)
    [ "$#" -eq 4 ] || block INVALID_ARGUMENTS
    ;;
  --record-r7-api-external|--record-r7-web-external)
    [ "$#" -eq 5 ] || block INVALID_ARGUMENTS
    ;;
  *)
    block INVALID_ARGUMENTS
    ;;
esac

FP="$2"; SRC="$3"; CTRL="$4"; EVIDENCE="${5:-}"
printf '%s' "$FP" | grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC" | grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL" | grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
R0="${S32_R0_RECEIPT:-$ROOT/progress/s32-r0.env}"
R6="${S32_R6_RECEIPT:-$ROOT/progress/s32-rollout-${FP}-R6.result.env}"
CLAIM="$ROOT/progress/s32-rollout-authorization-${FP}-R7-claim.env"
MANIFEST="${S32_RELEASE_MANIFEST_JSON:-$ROOT/progress/s32-release-manifest.json}"
API_ENV="${S32_API_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/api.env}"
PG_ENV="${S32_POSTGRES_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/postgres.env}"
START="$ROOT/progress/s32-rollout-${FP}-R7.start.env"
API_RESULT="$ROOT/progress/s32-rollout-${FP}-R7.api.env"
WEB_RESULT="${S32_R7_WEB_ACCEPTANCE_RECEIPT:-$ROOT/progress/s32-rollout-${FP}-R7.web.env}"
RESULT="$ROOT/progress/s32-rollout-${FP}-R7.result.env"
DK="${S32_R7_DOCKER:-sudo -n docker}"

get_kv() {
  local file="$1" key="$2" count
  count="$(grep -cE "^${key}=" "$file" 2>/dev/null || true)"
  [ "$count" = 1 ] || return 1
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2-
}

regular600() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c '%a' "$1" 2>/dev/null)" = 600 ]
}

validate_common() {
  for f in "$R0" "$R6" "$CLAIM" "$MANIFEST"; do
    [ -f "$f" ] && [ ! -L "$f" ] || {
      [ "$f" = "$CLAIM" ] && block R7_CLAIM_MISSING
      block REQUIRED_INPUT_MISSING
    }
  done
  [ "$(stat -c '%a' "$CLAIM")" = 600 ] || block R7_CLAIM_UNSAFE_MODE
  [ ! -e "$RESULT" ] && [ ! -L "$RESULT" ] || block R7_ALREADY_TERMINAL

  BASE_MEILI_DOCUMENTS="$(get_kv "$R0" MEILI_DOCUMENTS || true)"
  printf '%s' "$BASE_MEILI_DOCUMENTS" | grep -qE '^[0-9]+$' || block R0_MEILI_DOCUMENTS_INVALID

  [ "$(get_kv "$R6" STATUS || true)" = PASS ] \
    && [ "$(get_kv "$R6" R6_WEB || true)" = PASS ] \
    && [ "$(get_kv "$R6" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] \
    && [ "$(get_kv "$R6" RELEASE_SOURCE_SHA || true)" = "$SRC" ] \
    && [ "$(get_kv "$R6" MEILI_DOCUMENTS || true)" = "$BASE_MEILI_DOCUMENTS" ] \
    || block R6_NOT_PASS

  for key in \
    AUTHORIZATION_VERSION AUTHORIZED_ACTION STAGE_GROUP \
    S32_RELEASE_FINGERPRINT RELEASE_SOURCE_SHA CONTROL_PLANE_SHA \
    EXPLICIT_APPROVAL CONSUMABLE_ONCE CAPACITY_HARD_ONLY_ACCEPTED \
    PRODUCTION_WRITE_EXECUTED
  do
    [ "$(grep -cE "^${key}=" "$CLAIM" 2>/dev/null || true)" = 1 ] \
      || block R7_CLAIM_INVALID
  done

  [ "$(get_kv "$CLAIM" AUTHORIZATION_VERSION || true)" = 1 ] \
    && [ "$(get_kv "$CLAIM" AUTHORIZED_ACTION || true)" = S32_PRODUCTION_ROLLOUT ] \
    && [ "$(get_kv "$CLAIM" STAGE_GROUP || true)" = R7 ] \
    && [ "$(get_kv "$CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] \
    && [ "$(get_kv "$CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ] \
    && [ "$(get_kv "$CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ] \
    && [ "$(get_kv "$CLAIM" EXPLICIT_APPROVAL || true)" = true ] \
    && [ "$(get_kv "$CLAIM" CONSUMABLE_ONCE || true)" = true ] \
    && [ "$(get_kv "$CLAIM" PRODUCTION_WRITE_EXECUTED || true)" = false ] \
    || block R7_CLAIM_MISMATCH

  MAN_OUT="$(python3 "$SCRIPT_DIR/s32-release-manifest.py" "$MANIFEST" 2>&1)" \
    || block RELEASE_MANIFEST_INVALID
  MAN_FP="$(printf '%s\n' "$MAN_OUT" | awk -F= '$1=="S32_RELEASE_FINGERPRINT"{print $2;exit}')"
  MAN_SRC="$(printf '%s\n' "$MAN_OUT" | awk -F= '$1=="SOURCE_SHA"{print $2;exit}')"
  [ "$MAN_FP" = "$FP" ] && [ "$MAN_SRC" = "$SRC" ] \
    || block RELEASE_MANIFEST_IDENTITY_MISMATCH
}

validate_start() {
  regular600 "$START" || block R7_START_INVALID
  [ "$(get_kv "$START" STATUS || true)" = STARTED ] \
    && [ "$(get_kv "$START" STAGE || true)" = R7 ] \
    && [ "$(get_kv "$START" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] \
    && [ "$(get_kv "$START" RELEASE_SOURCE_SHA || true)" = "$SRC" ] \
    && [ "$(get_kv "$START" CONTROL_PLANE_SHA || true)" = "$CTRL" ] \
    || block R7_START_IDENTITY_MISMATCH
}

validate_api_acceptance() {
  local file="$1" expected_project key
  expected_project="[S32 Production Acceptance] ${FP:0:12}"
  local required=(
    STATUS PROJECT_ID PROJECT_NAME ASSESSMENT_ID
    LEGACY_SEARCH_REGRESSION ASSESSMENT_REPLAY
    S32_BACKEND_ACCEPTANCE MEILI_DOCUMENTS ACCEPTANCE_PROJECT_RETAINED
  )
  for key in "${required[@]}"; do
    [ "$(grep -cE "^${key}=" "$file" 2>/dev/null || true)" = 1 ] || return 1
  done
  [ "$(get_kv "$file" STATUS || true)" = PASS ] \
    && [ "$(get_kv "$file" PROJECT_NAME || true)" = "$expected_project" ] \
    && [ "$(get_kv "$file" LEGACY_SEARCH_REGRESSION || true)" = PASS ] \
    && [ "$(get_kv "$file" ASSESSMENT_REPLAY || true)" = PASS ] \
    && [ "$(get_kv "$file" S32_BACKEND_ACCEPTANCE || true)" = PASS ] \
    && [ "$(get_kv "$file" MEILI_DOCUMENTS || true)" = "$BASE_MEILI_DOCUMENTS" ] \
    && [ "$(get_kv "$file" ACCEPTANCE_PROJECT_RETAINED || true)" = YES ] \
    || return 1
  printf '%s' "$(get_kv "$file" PROJECT_ID || true)" \
    | grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || return 1
  printf '%s' "$(get_kv "$file" ASSESSMENT_ID || true)" \
    | grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || return 1
}

write_api_result() {
  local source="$1" project_id assessment_id project_name tmp
  project_id="$(get_kv "$source" PROJECT_ID)"
  assessment_id="$(get_kv "$source" ASSESSMENT_ID)"
  project_name="$(get_kv "$source" PROJECT_NAME)"
  umask 077
  tmp="$(mktemp "$ROOT/progress/.r7-api.XXXXXX")"
  cat >"$tmp" <<EOF
STATUS=PASS
STAGE=R7_API
R7_API_ACCEPTANCE=PASS
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
PROJECT_ID=$project_id
PROJECT_NAME=$project_name
ASSESSMENT_ID=$assessment_id
LEGACY_SEARCH_REGRESSION=PASS
ASSESSMENT_REPLAY=PASS
S32_BACKEND_ACCEPTANCE=PASS
MEILI_DOCUMENTS=$BASE_MEILI_DOCUMENTS
ACCEPTANCE_PROJECT_RETAINED=YES
IDEMPOTENCY_RECEIPT_DB_PROOF=PASS
AUTO_RETRY=NO
EOF
  chmod 600 "$tmp"
  ln -- "$tmp" "$API_RESULT" 2>/dev/null || {
    rm -f "$tmp"
    block API_RESULT_WRITE_FAILED
  }
  rm -f "$tmp"
}

verify_api_db_proof() {
  local source="$1" project_id assessment_id project_name pg_cid db_name db_admin
  local project_match assessment_match receipt_match

  if [ "${S32_R7_TEST_MODE:-false}" = true ]; then
    [ "${S32_R7_FAKE_DB_PROOF:-PASS}" = PASS ] || block R7_API_DB_PROOF_FAILED
    return 0
  fi

  regular600 "$PG_ENV" || block POSTGRES_ENV_INVALID
  project_id="$(get_kv "$source" PROJECT_ID)"
  assessment_id="$(get_kv "$source" ASSESSMENT_ID)"
  project_name="$(get_kv "$source" PROJECT_NAME)"

  pg_cid="$($DK ps \
    --filter label=com.docker.compose.project=book-id-search \
    --filter label=com.docker.compose.service=postgres \
    --format '{{.ID}}')"
  [ "$(printf '%s\n' "$pg_cid" | grep -c .)" = 1 ] && [ -n "$pg_cid" ] \
    || block POSTGRES_CONTAINER_NOT_UNIQUE
  [ -z "$($DK port "$pg_cid" 2>/dev/null || true)" ] || block POSTGRES_PUBLIC_PORT_PRESENT
  [ "$($DK inspect "$pg_cid" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')" = healthy ] \
    || block POSTGRES_NOT_HEALTHY

  db_name="$(get_kv "$PG_ENV" S32_POSTGRES_DB || true)"
  db_admin="$(get_kv "$PG_ENV" S32_POSTGRES_USER || true)"
  [ "$db_name" = book_id_search_s32 ] && [ "$db_admin" = s32_admin ] \
    || block POSTGRES_ENV_CONTRACT_INVALID

  project_match="$($DK exec "$pg_cid" psql -U "$db_admin" -d "$db_name" -At \
    -c "SELECT count(*) FROM core.projects WHERE id::text='$project_id' AND name='$project_name'")" \
    || block R7_API_DB_PROOF_FAILED
  [ "$project_match" = 1 ] || block R7_API_PROJECT_DB_MISMATCH

  assessment_match="$($DK exec "$pg_cid" psql -U "$db_admin" -d "$db_name" -At \
    -c "SELECT count(*) FROM core.assessments WHERE id::text='$assessment_id'")" \
    || block R7_API_DB_PROOF_FAILED
  [ "$assessment_match" = 1 ] || block R7_API_ASSESSMENT_DB_MISMATCH

  receipt_match="$($DK exec "$pg_cid" psql -U "$db_admin" -d "$db_name" -At \
    -c "SELECT count(*) FROM ops.idempotency_keys WHERE status='COMPLETED' AND resource_type='ASSESSMENT' AND resource_id::text='$assessment_id' AND result_payload->>'assessmentId'='$assessment_id'")" \
    || block R7_API_DB_PROOF_FAILED
  [ "$receipt_match" = 1 ] || block R7_API_IDEMPOTENCY_DB_MISMATCH
}

validate_web_receipt() {
  local file="$1" expected_mode="${2:-browser}" key expected_hash actual_hash project_id token
  if grep -Eq '(^|_)(TOKEN|PASSWORD|SECRET|DATABASE_URL)=' "$file"; then
    return 1
  fi
  local required=(
    STATUS STAGE S32_RELEASE_FINGERPRINT PROJECT_ID
    S32_WEB_ACCEPTANCE MOBILE_390x844 NO_HORIZONTAL_OVERFLOW
    RUNNER_VERSION RUNNER_SOURCE_SHA RUNNER_ID RUNNER_MODE RECEIPT_SHA256
  )
  for key in "${required[@]}"; do
    [ "$(grep -cE "^${key}=" "$file" 2>/dev/null || true)" = 1 ] || return 1
  done
  project_id="$(get_kv "$API_RESULT" PROJECT_ID || true)"
  [ "$(get_kv "$file" STATUS || true)" = PASS ] \
    && [ "$(get_kv "$file" STAGE || true)" = R7_WEB ] \
    && [ "$(get_kv "$file" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] \
    && [ "$(get_kv "$file" PROJECT_ID || true)" = "$project_id" ] \
    && [ "$(get_kv "$file" S32_WEB_ACCEPTANCE || true)" = PASS ] \
    && [ "$(get_kv "$file" MOBILE_390x844 || true)" = PASS ] \
    && [ "$(get_kv "$file" NO_HORIZONTAL_OVERFLOW || true)" = PASS ] \
    && [ "$(get_kv "$file" RUNNER_VERSION || true)" = 1 ] \
    && [ "$(get_kv "$file" RUNNER_SOURCE_SHA || true)" = "$CTRL" ] \
    && [ "$(get_kv "$file" RUNNER_ID || true)" = s32-r7-browser-receipt-producer ] \
    && [ "$(get_kv "$file" RUNNER_MODE || true)" = "$expected_mode" ] \
    || return 1

  expected_hash="$(get_kv "$file" RECEIPT_SHA256 || true)"
  printf '%s' "$expected_hash" | grep -qE '^[0-9a-f]{64}$' || return 1
  actual_hash="$(python3 - "$file" <<'PY'
import hashlib,pathlib,sys
raw=pathlib.Path(sys.argv[1]).read_text(encoding="utf-8")
lines=raw.splitlines()
base="\n".join(line for line in lines if not line.startswith("RECEIPT_SHA256="))+"\n"
print(hashlib.sha256(base.encode("utf-8")).hexdigest())
PY
)"
  [ "$actual_hash" = "$expected_hash" ] || return 1

  if regular600 "$API_ENV"; then
    token="$(get_kv "$API_ENV" S32_PRIVATE_API_TOKEN || true)"
    if [ -n "$token" ] && grep -F -q -- "$token" "$file"; then
      return 1
    fi
  fi
}

validate_common

if [ "$MODE" = --begin-r7-external ]; then
  [ ! -e "$START" ] && [ ! -L "$START" ] || block INCOMPLETE_R7
  [ ! -e "$API_RESULT" ] && [ ! -L "$API_RESULT" ] || block R7_API_ALREADY_COMPLETE
  [ ! -e "$WEB_RESULT" ] && [ ! -L "$WEB_RESULT" ] || block R7_WEB_ACCEPTANCE_ALREADY_COMPLETE

  umask 077
  TMP_START="$(mktemp "$ROOT/progress/.r7-start.XXXXXX")"
  printf 'STATUS=STARTED\nSTAGE=R7\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\n' \
    "$FP" "$SRC" "$CTRL" > "$TMP_START"
  chmod 600 "$TMP_START"
  ln -- "$TMP_START" "$START" 2>/dev/null || {
    rm -f "$TMP_START"
    block INCOMPLETE_R7
  }
  rm -f "$TMP_START"

  printf 'STATUS=PASS\nR7_EXTERNAL_BEGIN=PASS\nR7_ACCEPTANCE=PENDING_EXTERNAL_API\nAUTO_RETRY=NO\n'
  exit 0
fi

if [ "$MODE" = --execute-r7-api ]; then
  if [ "${S32_R7_TEST_MODE:-false}" != true ]; then
    block EXTERNAL_ACCEPTANCE_REQUIRED
  fi
  [ ! -e "$START" ] && [ ! -L "$START" ] || block INCOMPLETE_R7
  [ ! -e "$API_RESULT" ] && [ ! -L "$API_RESULT" ] || block R7_API_ALREADY_COMPLETE
  [ -f "${S32_R7_ACCEPTANCE_OUTPUT_FILE:?}" ] || block R7_ACCEPTANCE_FIXTURE_MISSING
  [ "${S32_R7_FAKE_ACCEPTANCE_EXIT:-0}" = 0 ] || block R7_ACCEPTANCE_FAILED

  umask 077
  TMP_START="$(mktemp "$ROOT/progress/.r7-start.XXXXXX")"
  printf 'STATUS=STARTED\nSTAGE=R7\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\n' \
    "$FP" "$SRC" "$CTRL" > "$TMP_START"
  chmod 600 "$TMP_START"
  ln -- "$TMP_START" "$START" 2>/dev/null || {
    rm -f "$TMP_START"
    block INCOMPLETE_R7
  }
  rm -f "$TMP_START"

  validate_api_acceptance "$S32_R7_ACCEPTANCE_OUTPUT_FILE" \
    || block R7_ACCEPTANCE_CONTRACT_INVALID
  verify_api_db_proof "$S32_R7_ACCEPTANCE_OUTPUT_FILE"
  write_api_result "$S32_R7_ACCEPTANCE_OUTPUT_FILE"

  printf 'STATUS=PASS\nR7_API_ACCEPTANCE=PASS\nR7_ACCEPTANCE=PENDING_WEB\nS32_RELEASE_FINGERPRINT=%s\nPROJECT_ID=%s\nAUTO_RETRY=NO\n' \
    "$FP" "$(get_kv "$API_RESULT" PROJECT_ID)"
  exit 0
fi

if [ "$MODE" = --record-r7-api-external ]; then
  validate_start
  [ ! -e "$API_RESULT" ] && [ ! -L "$API_RESULT" ] || block R7_API_ALREADY_COMPLETE
  regular600 "$EVIDENCE" || block R7_EXTERNAL_API_EVIDENCE_INVALID
  validate_api_acceptance "$EVIDENCE" || block R7_ACCEPTANCE_CONTRACT_INVALID
  verify_api_db_proof "$EVIDENCE"
  write_api_result "$EVIDENCE"
  printf 'STATUS=PASS\nR7_API_ACCEPTANCE=PASS\nR7_ACCEPTANCE=PENDING_WEB\nS32_RELEASE_FINGERPRINT=%s\nPROJECT_ID=%s\nAUTO_RETRY=NO\n' \
    "$FP" "$(get_kv "$API_RESULT" PROJECT_ID)"
  exit 0
fi

if [ "$MODE" = --record-r7-web-external ]; then
  validate_start
  regular600 "$API_RESULT" || block R7_API_RECEIPT_MISSING
  [ ! -e "$WEB_RESULT" ] && [ ! -L "$WEB_RESULT" ] || block R7_WEB_ACCEPTANCE_ALREADY_COMPLETE
  regular600 "$EVIDENCE" || block R7_EXTERNAL_WEB_EVIDENCE_INVALID
  validate_web_receipt "$EVIDENCE" browser || block R7_WEB_ACCEPTANCE_CONTRACT_INVALID

  umask 077
  TMP_WEB="$(mktemp "$ROOT/progress/.r7-web.XXXXXX")"
  cp -- "$EVIDENCE" "$TMP_WEB"
  chmod 600 "$TMP_WEB"
  ln -- "$TMP_WEB" "$WEB_RESULT" 2>/dev/null || {
    rm -f "$TMP_WEB"
    block R7_WEB_RESULT_WRITE_FAILED
  }
  rm -f "$TMP_WEB"
  printf 'STATUS=PASS\nR7_WEB_ACCEPTANCE=PASS\nR7_ACCEPTANCE=PENDING_COMPLETE\nPROJECT_ID=%s\nAUTO_RETRY=NO\n' \
    "$(get_kv "$API_RESULT" PROJECT_ID)"
  exit 0
fi

# --complete-r7: API and Web evidence are already durable; completion only
# validates those receipts and writes the terminal result.
validate_start
regular600 "$API_RESULT" || block R7_API_RECEIPT_MISSING
regular600 "$WEB_RESULT" || block R7_WEB_ACCEPTANCE_MISSING

[ "$(get_kv "$API_RESULT" STATUS || true)" = PASS ] \
  && [ "$(get_kv "$API_RESULT" R7_API_ACCEPTANCE || true)" = PASS ] \
  && [ "$(get_kv "$API_RESULT" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] \
  && [ "$(get_kv "$API_RESULT" RELEASE_SOURCE_SHA || true)" = "$SRC" ] \
  && [ "$(get_kv "$API_RESULT" S32_BACKEND_ACCEPTANCE || true)" = PASS ] \
  && [ "$(get_kv "$API_RESULT" MEILI_DOCUMENTS || true)" = "$BASE_MEILI_DOCUMENTS" ] \
  && [ "$(get_kv "$API_RESULT" ACCEPTANCE_PROJECT_RETAINED || true)" = YES ] \
  || block R7_API_RECEIPT_INVALID

EXPECTED_WEB_MODE=browser
if [ "${S32_R7_TEST_MODE:-false}" = true ]; then
  case "$(get_kv "$WEB_RESULT" RUNNER_MODE || true)" in
    fixture|browser) EXPECTED_WEB_MODE="$(get_kv "$WEB_RESULT" RUNNER_MODE)" ;;
    *) block R7_WEB_ACCEPTANCE_CONTRACT_INVALID ;;
  esac
fi
validate_web_receipt "$WEB_RESULT" "$EXPECTED_WEB_MODE" \
  || block R7_WEB_ACCEPTANCE_CONTRACT_INVALID

PROJECT_ID="$(get_kv "$API_RESULT" PROJECT_ID || true)"
ASSESSMENT_ID="$(get_kv "$API_RESULT" ASSESSMENT_ID || true)"
EXPECTED_PROJECT="[S32 Production Acceptance] ${FP:0:12}"

umask 077
TMP_RESULT="$(mktemp "$ROOT/progress/.r7-result.XXXXXX")"
cat >"$TMP_RESULT" <<EOF
STATUS=PASS
STAGE=R7
R7_ACCEPTANCE=PASS
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
PROJECT_ID=$PROJECT_ID
PROJECT_NAME=$EXPECTED_PROJECT
ASSESSMENT_ID=$ASSESSMENT_ID
LEGACY_SEARCH_REGRESSION=PASS
ASSESSMENT_REPLAY=PASS
S32_BACKEND_ACCEPTANCE=PASS
MEILI_DOCUMENTS=$BASE_MEILI_DOCUMENTS
S32_WEB_ACCEPTANCE=PASS
MOBILE_390x844=PASS
NO_HORIZONTAL_OVERFLOW=PASS
ACCEPTANCE_PROJECT_RETAINED=YES
AUTO_RETRY=NO
EOF
chmod 600 "$TMP_RESULT"
ln -- "$TMP_RESULT" "$RESULT" 2>/dev/null || {
  rm -f "$TMP_RESULT"
  block RESULT_WRITE_FAILED
}
rm -f "$TMP_RESULT"

printf 'STATUS=PASS\nR7_ACCEPTANCE=PASS\nS32_WEB_ACCEPTANCE=PASS\nMOBILE_390x844=PASS\nS32_RELEASE_FINGERPRINT=%s\nPROJECT_ID=%s\nACCEPTANCE_PROJECT_RETAINED=YES\nAUTO_RETRY=NO\n' \
  "$FP" "$PROJECT_ID"
