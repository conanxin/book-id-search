#!/usr/bin/env bash
set -euo pipefail

block() {
  printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nR7_ACCEPTANCE=BLOCKED\nAUTO_RETRY=NO\n' "$1"
  exit 1
}

[ "$#" -eq 4 ] || block INVALID_ARGUMENTS
MODE="$1"
case "$MODE" in --execute-r7-api|--complete-r7) ;; *) block INVALID_ARGUMENTS;; esac
FP="$2"; SRC="$3"; CTRL="$4"
printf '%s' "$FP" | grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC" | grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL" | grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
R6="${S32_R6_RECEIPT:-$ROOT/progress/s32-rollout-${FP}-R6.result.env}"
CLAIM="$ROOT/progress/s32-rollout-authorization-${FP}-R7-claim.env"
MANIFEST="${S32_RELEASE_MANIFEST_JSON:-$ROOT/progress/s32-release-manifest.json}"
API_ENV="${S32_API_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/api.env}"
START="$ROOT/progress/s32-rollout-${FP}-R7.start.env"
API_RESULT="$ROOT/progress/s32-rollout-${FP}-R7.api.env"
WEB_RESULT="${S32_R7_WEB_ACCEPTANCE_RECEIPT:-$ROOT/progress/s32-rollout-${FP}-R7.web.env}"
RESULT="$ROOT/progress/s32-rollout-${FP}-R7.result.env"

get_kv() {
  local file="$1" key="$2" count
  count="$(grep -cE "^${key}=" "$file" 2>/dev/null || true)"
  [ "$count" = 1 ] || return 1
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2-
}

validate_common() {
  for f in "$R6" "$CLAIM" "$MANIFEST"; do
    [ -f "$f" ] && [ ! -L "$f" ] || {
      [ "$f" = "$CLAIM" ] && block R7_CLAIM_MISSING
      block REQUIRED_INPUT_MISSING
    }
  done
  [ "$(stat -c '%a' "$CLAIM")" = 600 ] || block R7_CLAIM_UNSAFE_MODE
  [ ! -e "$RESULT" ] && [ ! -L "$RESULT" ] || block R7_ALREADY_TERMINAL

  [ "$(get_kv "$R6" STATUS || true)" = PASS ]     && [ "$(get_kv "$R6" R6_WEB || true)" = PASS ]     && [ "$(get_kv "$R6" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]     || block R6_NOT_PASS

  for key in     AUTHORIZATION_VERSION AUTHORIZED_ACTION STAGE_GROUP     S32_RELEASE_FINGERPRINT RELEASE_SOURCE_SHA CONTROL_PLANE_SHA     EXPLICIT_APPROVAL CONSUMABLE_ONCE CAPACITY_HARD_ONLY_ACCEPTED     PRODUCTION_WRITE_EXECUTED
  do
    [ "$(grep -cE "^${key}=" "$CLAIM" 2>/dev/null || true)" = 1 ]       || block R7_CLAIM_INVALID
  done

  [ "$(get_kv "$CLAIM" AUTHORIZATION_VERSION || true)" = 1 ]     && [ "$(get_kv "$CLAIM" AUTHORIZED_ACTION || true)" = S32_PRODUCTION_ROLLOUT ]     && [ "$(get_kv "$CLAIM" STAGE_GROUP || true)" = R7 ]     && [ "$(get_kv "$CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]     && [ "$(get_kv "$CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ]     && [ "$(get_kv "$CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ]     && [ "$(get_kv "$CLAIM" EXPLICIT_APPROVAL || true)" = true ]     && [ "$(get_kv "$CLAIM" CONSUMABLE_ONCE || true)" = true ]     && [ "$(get_kv "$CLAIM" PRODUCTION_WRITE_EXECUTED || true)" = false ]     || block R7_CLAIM_MISMATCH

  MAN_OUT="$(python3 "$SCRIPT_DIR/s32-release-manifest.py" "$MANIFEST" 2>&1)"     || block RELEASE_MANIFEST_INVALID
  MAN_FP="$(printf '%s\n' "$MAN_OUT" | awk -F= '$1=="S32_RELEASE_FINGERPRINT"{print $2;exit}')"
  MAN_SRC="$(printf '%s\n' "$MAN_OUT" | awk -F= '$1=="SOURCE_SHA"{print $2;exit}')"
  [ "$MAN_FP" = "$FP" ] && [ "$MAN_SRC" = "$SRC" ]     || block RELEASE_MANIFEST_IDENTITY_MISMATCH
}

validate_api_acceptance() {
  local file="$1" expected_project
  expected_project="[S32 Production Acceptance] ${FP:0:12}"
  local required=(
    STATUS PROJECT_ID PROJECT_NAME ASSESSMENT_ID
    LEGACY_SEARCH_REGRESSION ASSESSMENT_REPLAY
    S32_BACKEND_ACCEPTANCE ACCEPTANCE_PROJECT_RETAINED
  )
  local key
  for key in "${required[@]}"; do
    [ "$(grep -cE "^${key}=" "$file" 2>/dev/null || true)" = 1 ]       || return 1
  done
  [ "$(get_kv "$file" STATUS || true)" = PASS ]     && [ "$(get_kv "$file" PROJECT_NAME || true)" = "$expected_project" ]     && [ "$(get_kv "$file" LEGACY_SEARCH_REGRESSION || true)" = PASS ]     && [ "$(get_kv "$file" ASSESSMENT_REPLAY || true)" = PASS ]     && [ "$(get_kv "$file" S32_BACKEND_ACCEPTANCE || true)" = PASS ]     && [ "$(get_kv "$file" ACCEPTANCE_PROJECT_RETAINED || true)" = YES ]     || return 1
  printf '%s' "$(get_kv "$file" PROJECT_ID || true)" | grep -qE '^[0-9a-f-]{36}$' || return 1
  printf '%s' "$(get_kv "$file" ASSESSMENT_ID || true)" | grep -qE '^[0-9a-f-]{36}$' || return 1
}

validate_common

if [ "$MODE" = --execute-r7-api ]; then
  [ ! -e "$START" ] && [ ! -L "$START" ] || block INCOMPLETE_R7
  [ ! -e "$API_RESULT" ] && [ ! -L "$API_RESULT" ] || block R7_API_ALREADY_COMPLETE
  [ -f "$API_ENV" ] && [ ! -L "$API_ENV" ] || block API_ENV_MISSING
  [ "$(stat -c '%a' "$API_ENV")" = 600 ] || block API_ENV_UNSAFE_MODE
  TOKEN="$(get_kv "$API_ENV" S32_PRIVATE_API_TOKEN || true)"
  [ -n "$TOKEN" ] || block PRIVATE_TOKEN_MISSING

  umask 077
  TMP_START="$(mktemp "$ROOT/progress/.r7-start.XXXXXX")"
  printf 'STATUS=STARTED\nSTAGE=R7\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\n'     "$FP" "$SRC" "$CTRL" > "$TMP_START"
  chmod 600 "$TMP_START"
  ln -- "$TMP_START" "$START" 2>/dev/null || {
    rm -f "$TMP_START"
    block INCOMPLETE_R7
  }
  rm -f "$TMP_START"

  ACCEPT_OUT="$(mktemp)"
  ACCEPT_ERR="$(mktemp)"
  trap 'rm -f "$ACCEPT_OUT" "$ACCEPT_ERR"' EXIT INT TERM

  if [ "${S32_R7_TEST_MODE:-false}" = true ]; then
    [ -f "${S32_R7_ACCEPTANCE_OUTPUT_FILE:?}" ] || block R7_ACCEPTANCE_FIXTURE_MISSING
    cp -- "${S32_R7_ACCEPTANCE_OUTPUT_FILE}" "$ACCEPT_OUT"
    [ "${S32_R7_FAKE_ACCEPTANCE_EXIT:-0}" = 0 ] || block R7_ACCEPTANCE_FAILED
  else
    (
      cd "$ROOT"
      env         S32_PRIVATE_API_TOKEN="$TOKEN"         S32_RELEASE_FINGERPRINT="$FP"         S32_API_BASE_URL="${S32_API_BASE_URL:-https://books.conanxin.com}"         S32_PUBLIC_URL="${S32_PUBLIC_URL:-https://books.conanxin.com}"         pnpm s32:production:acceptance
    ) >"$ACCEPT_OUT" 2>"$ACCEPT_ERR" || block R7_ACCEPTANCE_FAILED
  fi

  validate_api_acceptance "$ACCEPT_OUT" || block R7_ACCEPTANCE_CONTRACT_INVALID

  PROJECT_ID="$(get_kv "$ACCEPT_OUT" PROJECT_ID)"
  ASSESSMENT_ID="$(get_kv "$ACCEPT_OUT" ASSESSMENT_ID)"
  PROJECT_NAME="$(get_kv "$ACCEPT_OUT" PROJECT_NAME)"

  TMP_API="$(mktemp "$ROOT/progress/.r7-api.XXXXXX")"
  cat >"$TMP_API" <<EOF
STATUS=PASS
STAGE=R7_API
R7_API_ACCEPTANCE=PASS
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
PROJECT_ID=$PROJECT_ID
PROJECT_NAME=$PROJECT_NAME
ASSESSMENT_ID=$ASSESSMENT_ID
LEGACY_SEARCH_REGRESSION=PASS
ASSESSMENT_REPLAY=PASS
S32_BACKEND_ACCEPTANCE=PASS
ACCEPTANCE_PROJECT_RETAINED=YES
AUTO_RETRY=NO
EOF
  chmod 600 "$TMP_API"
  ln -- "$TMP_API" "$API_RESULT" 2>/dev/null || {
    rm -f "$TMP_API"
    block API_RESULT_WRITE_FAILED
  }
  rm -f "$TMP_API"

  printf 'STATUS=PASS\nR7_API_ACCEPTANCE=PASS\nR7_ACCEPTANCE=PENDING_WEB\nS32_RELEASE_FINGERPRINT=%s\nPROJECT_ID=%s\nAUTO_RETRY=NO\n'     "$FP" "$PROJECT_ID"
  exit 0
fi

# --complete-r7: API canary is already durable; completion is read-only receipt validation.
[ -f "$START" ] && [ ! -L "$START" ] || block R7_API_RECEIPT_MISSING
[ -f "$API_RESULT" ] && [ ! -L "$API_RESULT" ] || block R7_API_RECEIPT_MISSING
[ "$(stat -c '%a' "$API_RESULT")" = 600 ] || block R7_API_RECEIPT_UNSAFE_MODE
[ -f "$WEB_RESULT" ] && [ ! -L "$WEB_RESULT" ] || block R7_WEB_ACCEPTANCE_MISSING
[ "$(stat -c '%a' "$WEB_RESULT")" = 600 ] || block R7_WEB_ACCEPTANCE_UNSAFE_MODE

[ "$(get_kv "$API_RESULT" STATUS || true)" = PASS ]   && [ "$(get_kv "$API_RESULT" R7_API_ACCEPTANCE || true)" = PASS ]   && [ "$(get_kv "$API_RESULT" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get_kv "$API_RESULT" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   && [ "$(get_kv "$API_RESULT" S32_BACKEND_ACCEPTANCE || true)" = PASS ]   && [ "$(get_kv "$API_RESULT" ACCEPTANCE_PROJECT_RETAINED || true)" = YES ]   || block R7_API_RECEIPT_INVALID

if grep -Eq '(^|_)(TOKEN|PASSWORD|SECRET|DATABASE_URL)=' "$WEB_RESULT"; then
  block R7_WEB_ACCEPTANCE_SECRET_FIELD
fi
for key in STATUS STAGE S32_RELEASE_FINGERPRINT PROJECT_ID S32_WEB_ACCEPTANCE MOBILE_390x844 NO_HORIZONTAL_OVERFLOW; do
  [ "$(grep -cE "^${key}=" "$WEB_RESULT" 2>/dev/null || true)" = 1 ]     || block R7_WEB_ACCEPTANCE_CONTRACT_INVALID
done

PROJECT_ID="$(get_kv "$API_RESULT" PROJECT_ID || true)"
ASSESSMENT_ID="$(get_kv "$API_RESULT" ASSESSMENT_ID || true)"
EXPECTED_PROJECT="[S32 Production Acceptance] ${FP:0:12}"
[ "$(get_kv "$API_RESULT" PROJECT_NAME || true)" = "$EXPECTED_PROJECT" ]   && [ "$(get_kv "$WEB_RESULT" STATUS || true)" = PASS ]   && [ "$(get_kv "$WEB_RESULT" STAGE || true)" = R7_WEB ]   && [ "$(get_kv "$WEB_RESULT" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get_kv "$WEB_RESULT" PROJECT_ID || true)" = "$PROJECT_ID" ]   && [ "$(get_kv "$WEB_RESULT" S32_WEB_ACCEPTANCE || true)" = PASS ]   && [ "$(get_kv "$WEB_RESULT" MOBILE_390x844 || true)" = PASS ]   && [ "$(get_kv "$WEB_RESULT" NO_HORIZONTAL_OVERFLOW || true)" = PASS ]   || block R7_WEB_ACCEPTANCE_CONTRACT_INVALID

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

printf 'STATUS=PASS\nR7_ACCEPTANCE=PASS\nS32_WEB_ACCEPTANCE=PASS\nMOBILE_390x844=PASS\nS32_RELEASE_FINGERPRINT=%s\nPROJECT_ID=%s\nACCEPTANCE_PROJECT_RETAINED=YES\nAUTO_RETRY=NO\n'   "$FP" "$PROJECT_ID"
