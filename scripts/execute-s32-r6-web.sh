#!/usr/bin/env bash
set -euo pipefail
block(){ printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nR6_WEB=BLOCKED\n' "$1"; exit 1; }
[ "$#" -eq 4 ] && [ "$1" = --execute-r6 ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"; SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
R5="${S32_R5_RECEIPT:-$ROOT/progress/s32-rollout-${FP}-R5.result.env}"; CAP="${S32_R6_CAPACITY_RECEIPT:-$ROOT/progress/s32-r6-capacity.env}"; CLAIM="$ROOT/progress/s32-rollout-authorization-${FP}-R6-claim.env"; MAN="${S32_RELEASE_MANIFEST_JSON:-$ROOT/progress/s32-release-manifest.json}"; CAND="${S32_R6_CANDIDATE_JSON:-$ROOT/progress/web-release-candidate-${SRC}/candidate.json}"; STATIC="${S32_R6_STATIC_DIR:-$ROOT/progress/web-release-candidate-${SRC}/static}"; API_ENV="${S32_API_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/api.env}"; START="$ROOT/progress/s32-rollout-${FP}-R6.start.env"; RESULT="$ROOT/progress/s32-rollout-${FP}-R6.result.env"
get(){ local f="$1" k="$2" n; n="$(grep -cE "^${k}=" "$f" 2>/dev/null||true)"; [ "$n" = 1 ] || return 1; grep -E "^${k}=" "$f"|head -1|cut -d= -f2-; }
for f in "$R5" "$CAP" "$CLAIM" "$MAN" "$CAND" "$API_ENV"; do [ -f "$f" ] && [ ! -L "$f" ] || block REQUIRED_INPUT_MISSING; done
[ "$(get "$R5" R5_S32_ACTIVATION || true)" = PASS ] && [ "$(get "$R5" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] || block R5_NOT_PASS
case "$(get "$CAP" CAPACITY_GATE || true)" in PASS_PREFERRED) ;; PASS_HARD_ONLY) [ "$(get "$CLAIM" CAPACITY_HARD_ONLY_ACCEPTED || true)" = true ] || block HARD_ONLY_NOT_ACCEPTED ;; *) block R6_CAPACITY_NOT_PASS;; esac
[ "$(get "$CLAIM" STAGE_GROUP || true)" = R6 ] && [ "$(get "$CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] && [ "$(get "$CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ] && [ "$(get "$CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ] || block R6_CLAIM_MISMATCH
[ ! -e "$START" ] && [ ! -e "$RESULT" ] || block INCOMPLETE_OR_TERMINAL_R6
OUT="$(python3 "$SCRIPT_DIR/s32-release-manifest.py" "$MAN" 2>&1)" || block RELEASE_MANIFEST_INVALID; [ "$(printf '%s\n' "$OUT"|awk -F= '$1=="S32_RELEASE_FINGERPRINT"{print $2;exit}')" = "$FP" ] || block RELEASE_MANIFEST_IDENTITY_MISMATCH
if ! python3 - "$MAN" "$CAND" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); c=json.load(open(sys.argv[2]))
checks=(c.get('tag')==m['webImageTag'],c.get('imageId')==m['webImageId'],c.get('gitSha')==m['sourceSha'],c.get('ociRevision')==m['sourceSha'],c.get('webS32Enabled') is True,c.get('staticManifestSha256')==m['webStaticManifestSha256'])
raise SystemExit(0 if all(checks) else 1)
PY
then block WEB_CANDIDATE_MISMATCH; fi
readarray -t WM < <(python3 - "$MAN" <<'PY'
import json,sys;m=json.load(open(sys.argv[1]));print(m['webImageTag']);print(m['webImageId']);print(m['apiImageId']);print(m['pgImageId'])
PY
); WEB_TAG="${WM[0]}"; WEB_ID="${WM[1]}"; API_ID="${WM[2]}"; PG_ID="${WM[3]}"
TOKEN="$(get "$API_ENV" S32_PRIVATE_API_TOKEN || true)"; [ -n "$TOKEN" ] || block PRIVATE_TOKEN_MISSING; [ -d "$STATIC" ] || block WEB_STATIC_TREE_MISSING; if grep -R -q -F -- "$TOKEN" "$STATIC"; then block PRIVATE_TOKEN_IN_WEB_BUNDLE; fi
capture_live(){ local out="$1" cid vals; python3 "$SCRIPT_DIR/plan-s32-production-baseline.py" --json-out "$out" >/dev/null || return 1; cid="$(sudo -n docker ps --filter label=com.docker.compose.service=postgres --format '{{.ID}}' | head -1)"; [ -n "$cid" ] || return 1; vals="$(sudo -n docker inspect "$cid" --format '{{.Id}}|{{.State.StartedAt}}|{{.Image}}')"; python3 - "$out" "$vals" <<'PY'
import json,sys
p=sys.argv[1]; cid,started,image=sys.argv[2].split('|'); d=json.load(open(p)); d['services']['postgres']={'cid':cid,'startedAt':started,'imageId':image}; open(p,'w').write(json.dumps(d))
PY
}
if [ "${S32_R6_TEST_MODE:-false}" = true ]; then PRE="${S32_R6_PRE_FACTS_JSON:?}"; else PRE="$(mktemp)"; capture_live "$PRE" || block R6_PRE_FACTS_FAILED; fi
python3 - "$PRE" "$SRC" "$API_ID" "$PG_ID" <<'PY' || block API_RELEASE_PARITY_REQUIRED
import json,sys;d=json.load(open(sys.argv[1])); a=d['services']['api']; p=d['services'].get('postgres',{})
if a.get('revision')!=sys.argv[2] or a.get('imageId')!=sys.argv[3] or p.get('imageId')!=sys.argv[4]: raise SystemExit(1)
PY
if [ "${S32_R6_TEST_MODE:-false}" != true ]; then ACT="$(sudo -n docker image inspect "$WEB_TAG" --format '{{.Id}}')" || block WEB_IMAGE_NOT_LOCAL; REV="$(sudo -n docker image inspect "$WEB_TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"; [ "$ACT" = "$WEB_ID" ] && [ "$REV" = "$SRC" ] || block WEB_RELEASE_IDENTITY_MISMATCH; fi
umask 077; T="$(mktemp "$ROOT/progress/.r6-start.XXXXXX")"; printf 'STATUS=STARTED\nSTAGE=R6\nS32_RELEASE_FINGERPRINT=%s\n' "$FP">"$T"; chmod 600 "$T"; ln -- "$T" "$START"; rm -f "$T"
if [ "${S32_R6_TEST_MODE:-false}" = true ]; then printf 'BOOK_ID_SEARCH_WEB_IMAGE=%s docker compose up -d --no-build --no-deps web\n' "$WEB_TAG" >"${S32_R6_COMMAND_LOG:?}"; POST="${S32_R6_POST_FACTS_JSON:?}"; else BOOK_ID_SEARCH_WEB_IMAGE="$WEB_TAG" bash "$ROOT/scripts/deploy-web-release-candidate.sh" "$WEB_TAG" >/dev/null || block WEB_DEPLOY_FAILED; POST="$(mktemp)"; capture_live "$POST" || block R6_POST_FACTS_FAILED; fi
VERIFY_ERR="$(mktemp)"; if ! python3 - "$PRE" "$POST" "$WEB_ID" "$SRC" 2>"$VERIFY_ERR" <<'PY'
import json,sys
pre=json.load(open(sys.argv[1])); post=json.load(open(sys.argv[2])); w=post['services']['web']
if w.get('imageId')!=sys.argv[3] or w.get('revision')!=sys.argv[4]: raise SystemExit('WEB_RELEASE_IDENTITY_MISMATCH')
for svc in ('api','meilisearch','postgres'):
 for f in ('cid','startedAt','imageId'):
  if post['services'][svc].get(f)!=pre['services'][svc].get(f): raise SystemExit('UNINTENDED_SERVICE_DRIFT')
if post.get('httpStatus')!=200: raise SystemExit('PUBLIC_HTTP_FAILED')
for k in ('ISBN','SSID','DXID','title','author','publisher'):
 if post.get('searches',{}).get(k,{}).get('status')!='PASS': raise SystemExit('LEGACY_SEARCH_REGRESSION')
PY
then reason="$(tail -1 "$VERIFY_ERR")"; rm -f "$VERIFY_ERR"; block "${reason:-R6_POSTVERIFY_FAILED}"; fi; rm -f "$VERIFY_ERR"
if [ "${S32_R6_TEST_MODE:-false}" != true ]; then rm -f "$PRE" "$POST"; fi
T="$(mktemp "$ROOT/progress/.r6-result.XXXXXX")"; printf 'STATUS=PASS\nSTAGE=R6\nR6_WEB=PASS\nS32_RELEASE_FINGERPRINT=%s\nWEB_IMAGE_ID=%s\nWEB_REVISION=%s\nAPI_WEB_PARITY=PASS\n' "$FP" "$WEB_ID" "$SRC">"$T"; chmod 600 "$T"; ln -- "$T" "$RESULT"; rm -f "$T"; printf 'STATUS=PASS\nR6_WEB=PASS\nAPI_WEB_PARITY=PASS\n'
