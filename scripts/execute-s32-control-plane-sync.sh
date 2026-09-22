#!/usr/bin/env bash
set -euo pipefail
block(){ printf 'STATUS=BLOCKED
BLOCK_REASON=%s
PRODUCTION_WRITE_EXECUTED=%s
' "$1" "${2:-false}"; exit 1; }
[ "$#" -eq 2 ] && [ "$1" = "--execute-control-plane-sync" ] || block INVALID_ARGUMENTS
TARGET="$2"; ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
[ "${S32_CONTROL_PLANE_SYNC_AUTHORIZED:-}" = "true" ] || block AUTHORIZATION_REQUIRED
[ "$(git -C "$ROOT" branch --show-current)" = "main" ] || block NOT_MAIN_BRANCH
[ -z "$(git -C "$ROOT" status --porcelain)" ] || block WORKTREE_NOT_CLEAN
TARGET="$(git -C "$ROOT" rev-parse "${TARGET}^{commit}" 2>/dev/null)" || block INVALID_TARGET
ORIGIN="$(git -C "$ROOT" rev-parse origin/main)"; git -C "$ROOT" merge-base --is-ancestor "$TARGET" "$ORIGIN" || block TARGET_NOT_REACHABLE_FROM_ORIGIN_MAIN
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PRE="${S32_SYNC_PRE_FACTS_JSON:-$TMP/pre.json}"; POST="${S32_SYNC_POST_FACTS_JSON:-$TMP/post.json}"
if [ -z "${S32_SYNC_PRE_FACTS_JSON:-}" ]; then python3 "$ROOT/scripts/plan-s32-production-baseline.py" --json-out "$PRE" >/dev/null || block PRE_BASELINE_FAILED; fi
git -C "$ROOT" fetch origin main --no-tags >/dev/null 2>&1 || block FETCH_FAILED
git -C "$ROOT" reset --hard "$TARGET" >/dev/null || block CHECKOUT_SYNC_FAILED true
if [ -z "${S32_SYNC_POST_FACTS_JSON:-}" ]; then python3 "$ROOT/scripts/plan-s32-production-baseline.py" --json-out "$POST" >/dev/null || block POST_BASELINE_FAILED true; fi
python3 - "$PRE" "$POST" <<'PY' || block CONTROL_PLANE_RUNTIME_DRIFT true
import json,sys
pre=json.load(open(sys.argv[1])); post=json.load(open(sys.argv[2]))
for k in ('web','api','meilisearch'):
 for f in ('cid','startedAt','imageId'):
  if pre['services'][k][f]!=post['services'][k][f]: raise SystemExit(1)
if pre.get('httpStatus')!=post.get('httpStatus'): raise SystemExit(1)
PY
printf 'STATUS=PASS
CONTROL_PLANE_SYNC=PASS
TARGET_CONTROL_PLANE_SHA=%s
PRODUCTION_WRITE_EXECUTED=true
RUNTIME_UNCHANGED=PASS
' "$TARGET"
