#!/usr/bin/env bash
set -euo pipefail
block(){ printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nPRODUCTION_WRITE_EXECUTED=false\n' "$1"; exit 1; }
[ "$#" -eq 5 ] && [ "$1" = "--authorize-production-rollout" ] || block INVALID_ARGUMENTS
STAGE="$2"; FP="$3"; SRC="$4"; CTRL="$5"
case "$STAGE" in CONTROL_PLANE_SYNC|R2_R3|R4_R5|R6|R7) ;; *) block INVALID_STAGE_GROUP;; esac
[ "${S32_EXPLICIT_APPROVAL:-}" = true ] || block EXPLICIT_APPROVAL_REQUIRED
printf '%s' "$FP"|grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC"|grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL"|grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA
CAPACITY_HARD_ONLY_ACCEPTED=false
if [ "$STAGE" != CONTROL_PLANE_SYNC ] && [ "${S32_CAPACITY_HARD_ONLY_ACCEPTED:-false}" = true ]; then CAPACITY_HARD_ONLY_ACCEPTED=true; fi
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"; DIR="$ROOT/progress"; mkdir -p "$DIR"
OUT="$DIR/s32-rollout-authorization-${FP}-${STAGE}.env"; [ ! -e "$OUT" ] && [ ! -L "$OUT" ] || block AUTHORIZATION_ALREADY_EXISTS
TMP="$(mktemp "$DIR/.s32-auth.XXXXXX")"; trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"
cat >"$TMP" <<EOF
AUTHORIZATION_VERSION=1
AUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT
STAGE_GROUP=$STAGE
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
CONTROL_PLANE_SHA=$CTRL
EXPLICIT_APPROVAL=true
CONSUMABLE_ONCE=true
CAPACITY_HARD_ONLY_ACCEPTED=$CAPACITY_HARD_ONLY_ACCEPTED
PRODUCTION_WRITE_EXECUTED=false
EOF
ln -- "$TMP" "$OUT" 2>/dev/null || block AUTHORIZATION_CREATE_FAILED
rm -f "$TMP"; trap - EXIT
printf 'STATUS=PASS\nAUTHORIZATION_ARTIFACT=%s\nSTAGE_GROUP=%s\nPRODUCTION_WRITE_EXECUTED=false\n' "$OUT" "$STAGE"
