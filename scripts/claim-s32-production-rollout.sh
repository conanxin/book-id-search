#!/usr/bin/env bash
set -euo pipefail
block(){ printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nPRODUCTION_WRITE_EXECUTED=false\n' "$1"; exit 1; }
[ "$#" -eq 5 ] && [ "$1" = "--claim-production-rollout" ] || block INVALID_ARGUMENTS
STAGE="$2"; FP="$3"; SRC="$4"; CTRL="$5"
case "$STAGE" in CONTROL_PLANE_SYNC|R2_R3|R4_R5|R6|R7) ;; *) block INVALID_STAGE_GROUP;; esac
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"; DIR="$ROOT/progress"; AUTH="$DIR/s32-rollout-authorization-${FP}-${STAGE}.env"; CLAIM="$DIR/s32-rollout-authorization-${FP}-${STAGE}-claim.env"
[ -e "$AUTH" ] || block AUTHORIZATION_MISSING
[ ! -L "$AUTH" ] && [ -f "$AUTH" ] || block AUTHORIZATION_UNSAFE_FILE
[ "$(stat -c '%a' "$AUTH")" = 600 ] || block AUTHORIZATION_UNSAFE_PERMISSIONS
for k in AUTHORIZATION_VERSION AUTHORIZED_ACTION STAGE_GROUP S32_RELEASE_FINGERPRINT RELEASE_SOURCE_SHA CONTROL_PLANE_SHA EXPLICIT_APPROVAL CONSUMABLE_ONCE PRODUCTION_WRITE_EXECUTED; do [ "$(grep -cE "^${k}=" "$AUTH" || true)" = 1 ] || block AUTHORIZATION_INCOMPLETE; done
get(){ grep -E "^$1=" "$AUTH"|head -1|cut -d= -f2-; }
[ "$(get AUTHORIZATION_VERSION)" = 1 ] && [ "$(get AUTHORIZED_ACTION)" = S32_PRODUCTION_ROLLOUT ] && [ "$(get STAGE_GROUP)" = "$STAGE" ] && [ "$(get S32_RELEASE_FINGERPRINT)" = "$FP" ] && [ "$(get RELEASE_SOURCE_SHA)" = "$SRC" ] && [ "$(get CONTROL_PLANE_SHA)" = "$CTRL" ] && [ "$(get EXPLICIT_APPROVAL)" = true ] && [ "$(get CONSUMABLE_ONCE)" = true ] && [ "$(get PRODUCTION_WRITE_EXECUTED)" = false ] || block AUTHORIZATION_PLAN_MISMATCH
[ ! -L "$CLAIM" ] || block AUTHORIZATION_UNSAFE_CLAIM_FILE
[ ! -e "$CLAIM" ] || block AUTHORIZATION_ALREADY_CLAIMED
ln -- "$AUTH" "$CLAIM" 2>/dev/null || { [ -e "$CLAIM" ] && block AUTHORIZATION_ALREADY_CLAIMED; block AUTHORIZATION_CLAIM_FAILED; }
[ "$(stat -c '%d:%i' "$AUTH")" = "$(stat -c '%d:%i' "$CLAIM")" ] || { rm -f "$CLAIM"; block AUTHORIZATION_CLAIM_VALIDATION_FAILED; }
[ "$(stat -c '%a' "$CLAIM")" = 600 ] || { rm -f "$CLAIM"; block AUTHORIZATION_CLAIM_VALIDATION_FAILED; }
printf 'STATUS=PASS\nAUTHORIZATION_CLAIMED=true\nCLAIM_ARTIFACT=%s\nSTAGE_GROUP=%s\nPRODUCTION_WRITE_EXECUTED=false\n' "$CLAIM" "$STAGE"
