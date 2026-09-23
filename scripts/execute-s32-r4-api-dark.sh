#!/usr/bin/env bash
set -euo pipefail
block(){ printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nR4_API_DARK=BLOCKED\n' "$1"; exit 1; }
[ "$#" -eq 4 ] && [ "$1" = --execute-r4 ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"; SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
R0="${S32_R0_RECEIPT:-$ROOT/progress/s32-r0.env}"; R3="${S32_R3_RECEIPT:-$ROOT/progress/s32-rollout-${FP}-R3.result.env}"; CAP="${S32_R4_CAPACITY_RECEIPT:-$ROOT/progress/s32-r4-capacity.env}"; MAN="${S32_RELEASE_MANIFEST_JSON:-$ROOT/progress/s32-release-manifest.json}"; PG_ENV="${S32_POSTGRES_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/postgres.env}"; CLAIM="$ROOT/progress/s32-rollout-authorization-${FP}-R4_R5-claim.env"; START="$ROOT/progress/s32-rollout-${FP}-R4.start.env"; RESULT="$ROOT/progress/s32-rollout-${FP}-R4.result.env"
get(){ local f="$1" k="$2" n; n="$(grep -cE "^${k}=" "$f" 2>/dev/null||true)"; [ "$n" = 1 ] || return 1; grep -E "^${k}=" "$f"|head -1|cut -d= -f2-; }
for f in "$R0" "$R3" "$CAP" "$MAN" "$CLAIM" "$PG_ENV"; do [ -f "$f" ] && [ ! -L "$f" ] || block REQUIRED_INPUT_MISSING; done
[ "$(stat -c '%a' "$CLAIM")" = 600 ] || block R4_R5_CLAIM_UNSAFE_MODE
[ "$(stat -c '%a' "$PG_ENV")" = 600 ] || block POSTGRES_ENV_UNSAFE
[ "$(get "$R3" R3_SCHEMA || true)" = PASS ] && [ "$(get "$R3" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] || block R3_NOT_PASS
case "$(get "$CAP" CAPACITY_GATE || true)" in PASS_PREFERRED) ;; PASS_HARD_ONLY) [ "$(get "$CLAIM" CAPACITY_HARD_ONLY_ACCEPTED || true)" = true ] || block HARD_ONLY_NOT_ACCEPTED ;; *) block R4_CAPACITY_NOT_PASS;; esac
[ "$(get "$CLAIM" STAGE_GROUP || true)" = R4_R5 ] && [ "$(get "$CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] && [ "$(get "$CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ] && [ "$(get "$CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ] || block R4_R5_CLAIM_MISMATCH
[ ! -e "$START" ] && [ ! -e "$RESULT" ] || block INCOMPLETE_OR_TERMINAL_R4
OUT="$(python3 "$SCRIPT_DIR/s32-release-manifest.py" "$MAN" 2>&1)" || block RELEASE_MANIFEST_INVALID; [ "$(printf '%s\n' "$OUT"|awk -F= '$1=="S32_RELEASE_FINGERPRINT"{print $2;exit}')" = "$FP" ] || block RELEASE_MANIFEST_IDENTITY_MISMATCH
readarray -t M < <(python3 - "$MAN" <<'PY'
import json,sys
m=json.load(open(sys.argv[1])); print(m['apiImageTag']); print(m['apiImageId']); print(m['apiOciRevision']); print(m['pgImageRef']); print(m['s32OverridePath'])
PY
)
API_TAG="${M[0]}"; API_ID="${M[1]}"; API_REV="${M[2]}"; PG_IMAGE="${M[3]}"; OVERRIDE="$ROOT/${M[4]}"; [ "$API_REV" = "$SRC" ] || block API_RELEASE_IDENTITY_MISMATCH
BASE_API_REV="$(get "$R0" API_REVISION||true)"; BASE_WEB_REV="$(get "$R0" WEB_REVISION||true)"; API_OVERRIDE="/opt/book-id-search-runtime/s31/${BASE_API_REV}/api-production.override.yml"; WEB_OVERRIDE="/opt/book-id-search-runtime/s32/${BASE_WEB_REV}/web-production.override.yml"
if [ "${S32_R4_R5_TEST_MODE:-false}" = true ]; then API_OVERRIDE="$ROOT/api-production.override.yml"; WEB_OVERRIDE="$ROOT/web-production.override.yml"; :>"$API_OVERRIDE"; :>"$WEB_OVERRIDE"; else ACT="$(sudo -n docker image inspect "$API_TAG" --format '{{.Id}}')" || block API_IMAGE_NOT_LOCAL; [ "$ACT" = "$API_ID" ] || block API_RELEASE_IDENTITY_MISMATCH; REV="$(sudo -n docker image inspect "$API_TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"; [ "$REV" = "$SRC" ] || block API_RELEASE_IDENTITY_MISMATCH; fi
umask 077; T="$(mktemp "$ROOT/progress/.r4-start.XXXXXX")"; printf 'STATUS=STARTED\nSTAGE=R4\nS32_RELEASE_FINGERPRINT=%s\n' "$FP">"$T"; chmod 600 "$T"; ln -- "$T" "$START" || { rm -f "$T"; block INCOMPLETE_R4; }; rm -f "$T"
CMD=(docker compose --project-directory "$ROOT" --env-file "$PG_ENV" -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.override.yml" -f "$API_OVERRIDE" -f "$WEB_OVERRIDE" -f "$OVERRIDE" up -d --no-build --no-deps api)
if [ "${S32_R4_R5_TEST_MODE:-false}" = true ]; then printf 'S32_FEATURES_ENABLED=false S32_API_IMAGE=%s ' "$API_TAG" >>"${S32_R4_R5_COMMAND_LOG:?}"; printf '%q ' "${CMD[@]}" >>"$S32_R4_R5_COMMAND_LOG"; printf '\n' >>"$S32_R4_R5_COMMAND_LOG"; POST="${S32_R4_POST_FACTS_JSON:?}"; else sudo -n env S32_FEATURES_ENABLED=false S32_DATABASE_URL= S32_PRIVATE_API_TOKEN= "S32_API_IMAGE=$API_TAG" "S32_POSTGRES_IMAGE=$PG_IMAGE" "${CMD[@]}"; POST="$(mktemp)"; python3 "$SCRIPT_DIR/plan-s32-production-baseline.py" --json-out "$POST" >/dev/null || block R4_POST_BASELINE_FAILED; code="$(curl -sS -o /dev/null -w '%{http_code}' https://books.conanxin.com/api/private/s32/projects || true)"; [ "$code" = 404 ] || block S32_NOT_DISABLED; fi
VERIFY_ERR="$(mktemp)"
if ! python3 - "$R0" "$POST" "$API_ID" "$SRC" 2>"$VERIFY_ERR" <<'PY'
import json,sys
r={}
for line in open(sys.argv[1]):
 if '=' in line: k,v=line.rstrip().split('=',1); r[k]=v
p=json.load(open(sys.argv[2])); api=p['services']['api']
if api.get('imageId')!=sys.argv[3] or api.get('revision')!=sys.argv[4]: raise SystemExit('API_RELEASE_IDENTITY_MISMATCH')
for svc,prefix in [('web','WEB'),('meilisearch','MEILISEARCH')]:
 s=p['services'][svc]
 for f,k in [('cid','CID'),('startedAt','STARTED_AT'),('imageId','IMAGE_ID')]:
  if s.get(f)!=r.get(f'{prefix}_{k}'): raise SystemExit('UNINTENDED_SERVICE_DRIFT')
if p.get('httpStatus')!=200: raise SystemExit('PUBLIC_HTTP_FAILED')
if p.get('stats',{}).get('isIndexing') is not False: raise SystemExit('MEILI_INDEXING')
for k in ('ISBN','SSID','DXID','title','author','publisher'):
 if p.get('searches',{}).get(k,{}).get('status')!='PASS': raise SystemExit('LEGACY_SEARCH_REGRESSION')
if p.get('s32Enabled') not in (False,None): raise SystemExit('S32_NOT_DISABLED')
PY
then reason="$(tail -1 "$VERIFY_ERR")"; rm -f "$VERIFY_ERR"; block "${reason:-R4_POSTVERIFY_FAILED}"; fi
rm -f "$VERIFY_ERR"
[ "${S32_R4_R5_TEST_MODE:-false}" = true ] || rm -f "$POST"
T="$(mktemp "$ROOT/progress/.r4-result.XXXXXX")"; printf 'STATUS=PASS\nSTAGE=R4\nR4_API_DARK=PASS\nS32_RELEASE_FINGERPRINT=%s\nAPI_IMAGE_ID=%s\nAPI_REVISION=%s\nS32_FEATURES_ENABLED=false\n' "$FP" "$API_ID" "$SRC">"$T"; chmod 600 "$T"; ln -- "$T" "$RESULT"; rm -f "$T"; printf 'STATUS=PASS\nR4_API_DARK=PASS\nS32_FEATURES_ENABLED=false\n'
