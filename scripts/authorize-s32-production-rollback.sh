#!/usr/bin/env bash
# Create a one-time API rollback authorization artifact. Does not execute rollback.
set -euo pipefail
block(){ printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\n' "$1"; exit 1; }
[ "$#" -eq 4 ] && [ "$1" = --authorize-api-to-r0 ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"
printf '%s' "$FP"|grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC"|grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL"|grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
DIR="$ROOT/progress"
mkdir -p "$DIR"
[ ! -L "$DIR" ] || block PROGRESS_DIR_SYMLINK
OUT="$DIR/s32-rollback-authorization-${FP}-API_TO_R0.env"
[ ! -e "$OUT" ] && [ ! -L "$OUT" ] || block AUTHORIZATION_EXISTS
umask 077
TMP="$(mktemp "$DIR/.s32-rollback-auth.XXXXXX")"
cat >"$TMP" <<EOF
AUTHORIZATION_VERSION=1
AUTHORIZED_ACTION=S32_PRODUCTION_ROLLBACK
ROLLBACK_SCOPE=API_TO_R0
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
CONTROL_PLANE_SHA=$CTRL
EXPLICIT_APPROVAL=true
CONSUMABLE_ONCE=true
PRODUCTION_WRITE_EXECUTED=false
EOF
chmod 600 "$TMP"
ln -- "$TMP" "$OUT" 2>/dev/null || { rm -f "$TMP"; block AUTHORIZATION_CREATE_FAILED; }
rm -f "$TMP"
printf 'STATUS=PASS\nROLLBACK_AUTHORIZATION=%s\nPRODUCTION_WRITE_EXECUTED=false\n' "$OUT"
