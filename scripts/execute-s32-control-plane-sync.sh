#!/usr/bin/env bash
set -euo pipefail

block() {
  printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nPRODUCTION_WRITE_EXECUTED=%s\n' "$1" "${2:-false}"
  exit 1
}

[ "$#" -eq 4 ] && [ "$1" = "--execute-control-plane-sync" ] || block INVALID_ARGUMENTS
FP="$2"
SRC="$3"
CTRL="$4"

printf '%s' "$FP" | grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC" | grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL" | grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
# Preferred: CTRL-scoped claim (authorizations for a second sync under the
# same fingerprint but a different main commit coexist by design).
CLAIM="$ROOT/progress/s32-rollout-authorization-${FP}-CONTROL_PLANE_SYNC-${CTRL}-claim.env"
# Legacy fallback (first-sync historical evidence): only usable when no
# CTRL-scoped claim exists, the legacy file is a regular non-symlink mode-600
# file, and every field inside binds to exactly this FP/SRC/CTRL request.
LEGACY_CLAIM="$ROOT/progress/s32-rollout-authorization-${FP}-CONTROL_PLANE_SYNC-claim.env"
# Per-FP+CTRL execution state: START before the checkout mutation, RESULT
# only after a fully verified terminal PASS. START without RESULT means an
# INCOMPLETE/UNKNOWN attempt and must never auto-retry.
START="$ROOT/progress/s32-rollout-${FP}-CONTROL_PLANE_SYNC-${CTRL}.start.env"
RESULT="$ROOT/progress/s32-rollout-${FP}-CONTROL_PLANE_SYNC-${CTRL}.result.env"

claim_get_kv() {
  local file="$1" key="$2" count
  count="$(grep -cE "^${key}=" "$file" 2>/dev/null || true)"
  [ "$count" = 1 ] || return 1
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2-
}

if [ ! -f "$CLAIM" ] && [ ! -L "$CLAIM" ]; then
  if [ -f "$LEGACY_CLAIM" ] && [ ! -L "$LEGACY_CLAIM" ] && [ "$(stat -c '%a' "$LEGACY_CLAIM" 2>/dev/null)" = 600 ] \
     && [ "$(claim_get_kv "$LEGACY_CLAIM" STAGE_GROUP || true)" = CONTROL_PLANE_SYNC ] \
     && [ "$(claim_get_kv "$LEGACY_CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] \
     && [ "$(claim_get_kv "$LEGACY_CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ] \
     && [ "$(claim_get_kv "$LEGACY_CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ] \
     && [ "$(claim_get_kv "$LEGACY_CLAIM" EXPLICIT_APPROVAL || true)" = true ] \
     && [ "$(claim_get_kv "$LEGACY_CLAIM" CONSUMABLE_ONCE || true)" = true ] \
     && [ "$(claim_get_kv "$LEGACY_CLAIM" PRODUCTION_WRITE_EXECUTED || true)" = false ]; then
    CLAIM="$LEGACY_CLAIM"
  fi
fi

[ -f "$CLAIM" ] && [ ! -L "$CLAIM" ] || block CONTROL_PLANE_SYNC_CLAIM_MISSING
[ "$(stat -c '%a' "$CLAIM")" = 600 ] || block CONTROL_PLANE_SYNC_CLAIM_UNSAFE_MODE

# Execution-state preflight (before any checkout mutation): a terminal
# RESULT for this FP+CTRL forbids a second execution; a START without
# RESULT marks an INCOMPLETE/UNKNOWN attempt and is never auto-retried.
if [ -e "$RESULT" ] || [ -L "$RESULT" ]; then block CONTROL_PLANE_ALREADY_TERMINAL; fi
if [ -e "$START" ] || [ -L "$START" ]; then block INCOMPLETE_CONTROL_PLANE_SYNC; fi

get_kv() {
  local file="$1" key="$2" count
  count="$(grep -cE "^${key}=" "$file" 2>/dev/null || true)"
  [ "$count" = 1 ] || return 1
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2-
}

for key in   AUTHORIZATION_VERSION AUTHORIZED_ACTION STAGE_GROUP   S32_RELEASE_FINGERPRINT RELEASE_SOURCE_SHA CONTROL_PLANE_SHA   EXPLICIT_APPROVAL CONSUMABLE_ONCE CAPACITY_HARD_ONLY_ACCEPTED   PRODUCTION_WRITE_EXECUTED
do
  [ "$(grep -cE "^${key}=" "$CLAIM" 2>/dev/null || true)" = 1 ]     || block CONTROL_PLANE_SYNC_CLAIM_INVALID
done

[ "$(get_kv "$CLAIM" AUTHORIZATION_VERSION || true)" = 1 ]   && [ "$(get_kv "$CLAIM" AUTHORIZED_ACTION || true)" = S32_PRODUCTION_ROLLOUT ]   && [ "$(get_kv "$CLAIM" STAGE_GROUP || true)" = CONTROL_PLANE_SYNC ]   && [ "$(get_kv "$CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get_kv "$CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   && [ "$(get_kv "$CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ]   && [ "$(get_kv "$CLAIM" EXPLICIT_APPROVAL || true)" = true ]   && [ "$(get_kv "$CLAIM" CONSUMABLE_ONCE || true)" = true ]   && [ "$(get_kv "$CLAIM" CAPACITY_HARD_ONLY_ACCEPTED || true)" = false ]   && [ "$(get_kv "$CLAIM" PRODUCTION_WRITE_EXECUTED || true)" = false ]   || block CONTROL_PLANE_SYNC_CLAIM_MISMATCH

[ "$(git -C "$ROOT" branch --show-current)" = main ] || block NOT_MAIN_BRANCH

dirty_outside_runtime() {
  local line status path
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    status="${line:0:2}"
    path="${line:3}"
    case "$status:$path" in
      "??:progress/"*|"??:logs/"*) ;;
      *) return 0 ;;
    esac
  done < <(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)
  return 1
}

dirty_outside_runtime && block WORKTREE_NOT_CLEAN

git -C "$ROOT" fetch origin main --no-tags >/dev/null 2>&1 || block FETCH_FAILED
TARGET="$(git -C "$ROOT" rev-parse "${CTRL}^{commit}" 2>/dev/null)" || block INVALID_TARGET
[ "$TARGET" = "$CTRL" ] || block CONTROL_PLANE_TARGET_MISMATCH
ORIGIN="$(git -C "$ROOT" rev-parse origin/main)"
git -C "$ROOT" merge-base --is-ancestor "$TARGET" "$ORIGIN" || block TARGET_NOT_REACHABLE_FROM_ORIGIN_MAIN

# Control plane is forward-only: a claim (scoped or legacy) must never
# enable an unauthorized rollback to an older checkout.
CURRENT="$(git -C "$ROOT" rev-parse HEAD)"
[ "$CURRENT" != "$TARGET" ] || block CONTROL_PLANE_ALREADY_AT_TARGET
git -C "$ROOT" merge-base --is-ancestor "$CURRENT" "$TARGET" || block CONTROL_PLANE_NON_FORWARD_TARGET

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
PRE="${S32_SYNC_PRE_FACTS_JSON:-$TMP/pre.json}"
POST="${S32_SYNC_POST_FACTS_JSON:-$TMP/post.json}"

if [ -z "${S32_SYNC_PRE_FACTS_JSON:-}" ]; then
  BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$SCRIPT_DIR/plan-s32-production-baseline.py" --json-out "$PRE" >/dev/null     || block PRE_BASELINE_FAILED
fi

# All gates passed: atomically publish START (regular, non-symlink, 600,
# no overwrite) immediately before the checkout mutation. A failure after
# this point leaves START behind as INCOMPLETE/UNKNOWN evidence.
umask 077
TMP_START="$(mktemp "$ROOT/progress/.cp-sync-start.XXXXXX")"
printf 'STATUS=STARTED\nSTAGE=CONTROL_PLANE_SYNC\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\nPRE_CONTROL_PLANE_SHA=%s\n' "$FP" "$SRC" "$CTRL" "$CURRENT" > "$TMP_START"
chmod 600 "$TMP_START"
ln -- "$TMP_START" "$START" 2>/dev/null || { rm -f "$TMP_START"; block CONTROL_PLANE_ALREADY_TERMINAL; }
rm -f "$TMP_START"

git -C "$ROOT" reset --hard "$TARGET" >/dev/null || block CHECKOUT_SYNC_FAILED true

if [ -z "${S32_SYNC_POST_FACTS_JSON:-}" ]; then
  BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$SCRIPT_DIR/plan-s32-production-baseline.py" --json-out "$POST" >/dev/null     || block POST_BASELINE_FAILED true
fi

python3 - "$PRE" "$POST" <<'PY' || block CONTROL_PLANE_RUNTIME_DRIFT true
import json,sys
pre=json.load(open(sys.argv[1]))
post=json.load(open(sys.argv[2]))
for k in ('web','api','meilisearch'):
    for f in ('cid','startedAt','imageId'):
        if pre['services'][k][f] != post['services'][k][f]:
            raise SystemExit(1)
if pre.get('httpStatus') != post.get('httpStatus'):
    raise SystemExit(1)
PY

# Fully verified terminal PASS: atomically publish RESULT (600, non-symlink,
# no overwrite). START is retained alongside RESULT as the audit chain.
umask 077
TMP_RESULT="$(mktemp "$ROOT/progress/.cp-sync-result.XXXXXX")"
printf 'STATUS=PASS\nSTAGE=CONTROL_PLANE_SYNC\nCONTROL_PLANE_SYNC=PASS\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\nPRE_CONTROL_PLANE_SHA=%s\nPOST_CONTROL_PLANE_SHA=%s\nRUNTIME_UNCHANGED=PASS\n' "$FP" "$SRC" "$CTRL" "$CURRENT" "$TARGET" > "$TMP_RESULT"
chmod 600 "$TMP_RESULT"
ln -- "$TMP_RESULT" "$RESULT" 2>/dev/null || { rm -f "$TMP_RESULT"; block CONTROL_PLANE_ALREADY_TERMINAL true; }
rm -f "$TMP_RESULT"

printf 'STATUS=PASS\nCONTROL_PLANE_SYNC=PASS\nTARGET_CONTROL_PLANE_SHA=%s\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nPRODUCTION_WRITE_EXECUTED=true\nRUNTIME_UNCHANGED=PASS\n'   "$TARGET" "$FP" "$SRC"
