#!/usr/bin/env bash
# Explicit, one-time rollback of the API service to the exact R0 identity.
# Never invoked automatically by a forward rollout stage.
set -euo pipefail

block(){ printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nAPI_ROLLBACK=BLOCKED\nAUTO_RETRY=NO\n' "$1"; exit 1; }
[ "$#" -eq 4 ] && [ "$1" = --rollback-api-to-r0 ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"
printf '%s' "$FP"|grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC"|grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL"|grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
R0="${S32_R0_RECEIPT:-$ROOT/progress/s32-r0.env}"
AUTH="$ROOT/progress/s32-rollback-authorization-${FP}-API_TO_R0.env"
CLAIM="$ROOT/progress/s32-rollback-authorization-${FP}-API_TO_R0-claim.env"
START="$ROOT/progress/s32-rollback-${FP}-API_TO_R0.start.env"
RESULT="$ROOT/progress/s32-rollback-${FP}-API_TO_R0.result.env"
R4_START="$ROOT/progress/s32-rollout-${FP}-R4.start.env"
R5_START="$ROOT/progress/s32-rollout-${FP}-R5.start.env"
R6_START="$ROOT/progress/s32-rollout-${FP}-R6.start.env"
R6_RESULT="$ROOT/progress/s32-rollout-${FP}-R6.result.env"
R7_START="$ROOT/progress/s32-rollout-${FP}-R7.start.env"

get(){
  local file="$1" key="$2" n
  n="$(grep -cE "^${key}=" "$file" 2>/dev/null||true)"
  [ "$n" = 1 ] || return 1
  grep -E "^${key}=" "$file"|head -1|cut -d= -f2-
}

[ -f "$R0" ] && [ ! -L "$R0" ] || block R0_RECEIPT_MISSING
[ -f "$AUTH" ] && [ ! -L "$AUTH" ] && [ "$(stat -c '%a' "$AUTH")" = 600 ] || block ROLLBACK_AUTHORIZATION_MISSING
for key in AUTHORIZATION_VERSION AUTHORIZED_ACTION ROLLBACK_SCOPE S32_RELEASE_FINGERPRINT RELEASE_SOURCE_SHA CONTROL_PLANE_SHA EXPLICIT_APPROVAL CONSUMABLE_ONCE PRODUCTION_WRITE_EXECUTED; do
  [ "$(grep -cE "^${key}=" "$AUTH" 2>/dev/null||true)" = 1 ] || block ROLLBACK_AUTHORIZATION_INVALID
done
[ "$(get "$AUTH" AUTHORIZATION_VERSION || true)" = 1 ]   && [ "$(get "$AUTH" AUTHORIZED_ACTION || true)" = S32_PRODUCTION_ROLLBACK ]   && [ "$(get "$AUTH" ROLLBACK_SCOPE || true)" = API_TO_R0 ]   && [ "$(get "$AUTH" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get "$AUTH" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   && [ "$(get "$AUTH" CONTROL_PLANE_SHA || true)" = "$CTRL" ]   && [ "$(get "$AUTH" EXPLICIT_APPROVAL || true)" = true ]   && [ "$(get "$AUTH" CONSUMABLE_ONCE || true)" = true ]   && [ "$(get "$AUTH" PRODUCTION_WRITE_EXECUTED || true)" = false ]   || block ROLLBACK_AUTHORIZATION_MISMATCH

[ ! -e "$CLAIM" ] && [ ! -L "$CLAIM" ] || block ROLLBACK_AUTH_ALREADY_CLAIMED
ln -- "$AUTH" "$CLAIM" 2>/dev/null || block ROLLBACK_AUTH_CLAIM_FAILED
[ "$(stat -c '%a' "$CLAIM")" = 600 ] || block ROLLBACK_CLAIM_UNSAFE_MODE

([ -e "$R4_START" ] || [ -e "$R5_START" ]) || block API_ROLLOUT_NOT_STARTED
[ ! -e "$R6_START" ] && [ ! -e "$R6_RESULT" ] && [ ! -e "$R7_START" ] || block LATER_STAGE_PRESENT
[ ! -e "$START" ] && [ ! -e "$RESULT" ] || block INCOMPLETE_OR_TERMINAL_ROLLBACK

BASE_API_IMAGE="$(get "$R0" API_IMAGE || true)"
BASE_API_ID="$(get "$R0" API_IMAGE_ID || true)"
BASE_API_REV="$(get "$R0" API_REVISION || true)"
BASE_WEB_REV="$(get "$R0" WEB_REVISION || true)"
[ -n "$BASE_API_IMAGE" ] && [ -n "$BASE_API_ID" ] && [ -n "$BASE_API_REV" ] && [ -n "$BASE_WEB_REV" ] || block R0_API_IDENTITY_INVALID

API_OVERRIDE="/opt/book-id-search-runtime/s31/${BASE_API_REV}/api-production.override.yml"
WEB_OVERRIDE="/opt/book-id-search-runtime/s32/${BASE_WEB_REV}/web-production.override.yml"
if [ "${S32_API_ROLLBACK_TEST_MODE:-false}" = true ]; then
  API_OVERRIDE="$ROOT/api-production.override.yml"; WEB_OVERRIDE="$ROOT/web-production.override.yml"
  :>"$API_OVERRIDE"; :>"$WEB_OVERRIDE"
else
  [ -f "$API_OVERRIDE" ] && [ ! -L "$API_OVERRIDE" ] || block BASELINE_API_OVERRIDE_MISSING
  [ -f "$WEB_OVERRIDE" ] && [ ! -L "$WEB_OVERRIDE" ] || block BASELINE_WEB_OVERRIDE_MISSING
  ACTUAL_BASE_ID="$(sudo -n docker image inspect "$BASE_API_IMAGE" --format '{{.Id}}' 2>/dev/null)" || block BASELINE_API_IMAGE_MISSING
  [ "$ACTUAL_BASE_ID" = "$BASE_API_ID" ] || block BASELINE_API_IMAGE_ID_MISMATCH
  RENDERED="$(sudo -n docker compose --project-directory "$ROOT"     -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.override.yml"     -f "$API_OVERRIDE" -f "$WEB_OVERRIDE" config --format json)" || block BASELINE_COMPOSE_RENDER_FAILED
  printf '%s' "$RENDERED" | python3 -c 'import json,sys; d=json.load(sys.stdin); expected=sys.argv[1]; raise SystemExit(0 if d.get("services",{}).get("api",{}).get("image")==expected else 1)' "$BASE_API_IMAGE"     || block BASELINE_API_RENDER_IDENTITY_MISMATCH
fi

umask 077
TMP="$(mktemp "$ROOT/progress/.api-rollback-start.XXXXXX")"
printf 'STATUS=STARTED\nROLLBACK_SCOPE=API_TO_R0\nS32_RELEASE_FINGERPRINT=%s\n' "$FP" >"$TMP"
chmod 600 "$TMP"
ln -- "$TMP" "$START" 2>/dev/null || { rm -f "$TMP"; block INCOMPLETE_ROLLBACK; }
rm -f "$TMP"

CMD=(docker compose --project-directory "$ROOT"   -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.override.yml"   -f "$API_OVERRIDE" -f "$WEB_OVERRIDE"   up -d --no-build --no-deps api)

if [ "${S32_API_ROLLBACK_TEST_MODE:-false}" = true ]; then
  printf '%q ' "${CMD[@]}" >>"${S32_API_ROLLBACK_COMMAND_LOG:?}"; printf '\n' >>"$S32_API_ROLLBACK_COMMAND_LOG"
  POST="${S32_API_ROLLBACK_POST_FACTS_JSON:?}"
else
  sudo -n "${CMD[@]}"
  POST="$(mktemp)"
  trap 'rm -f "$POST"' EXIT INT TERM
  python3 "$SCRIPT_DIR/plan-s32-production-baseline.py" --json-out "$POST" >/dev/null || block POST_ROLLBACK_BASELINE_FAILED
fi

python3 - "$POST" "$R0" <<'PY' || block POST_ROLLBACK_VERIFY_FAILED
import json,sys
p=json.load(open(sys.argv[1]))
r={}
for line in open(sys.argv[2]):
    if "=" in line:
        k,v=line.rstrip("\n").split("=",1); r[k]=v
for svc,prefix in (("web","WEB"),("api","API"),("meilisearch","MEILISEARCH")):
    s=p.get("services",{}).get(svc,{})
    for field,key in (("imageId","IMAGE_ID"),("revision","REVISION")):
        if s.get(field)!=r.get(prefix+"_"+key): raise SystemExit(1)
    if svc!="api":
        for field,key in (("cid","CID"),("startedAt","STARTED_AT")):
            if s.get(field)!=r.get(prefix+"_"+key): raise SystemExit(1)
if p.get("httpStatus")!=200: raise SystemExit(1)
if p.get("s32EnvNames") not in ([],None): raise SystemExit(1)
if p.get("stats",{}).get("isIndexing") is not False: raise SystemExit(1)
for key in ("ISBN","SSID","DXID","title","author","publisher"):
    if p.get("searches",{}).get(key,{}).get("status")!="PASS": raise SystemExit(1)
PY

TMP="$(mktemp "$ROOT/progress/.api-rollback-result.XXXXXX")"
cat >"$TMP" <<EOF
STATUS=PASS
ROLLBACK_SCOPE=API_TO_R0
API_ROLLBACK=PASS
S32_RELEASE_FINGERPRINT=$FP
BASELINE_API_IMAGE=$BASE_API_IMAGE
BASELINE_API_IMAGE_ID=$BASE_API_ID
BASELINE_API_REVISION=$BASE_API_REV
POSTGRES_DATA_RETAINED=YES
MEILI_UNCHANGED=YES
AUTO_RETRY=NO
EOF
chmod 600 "$TMP"
ln -- "$TMP" "$RESULT" 2>/dev/null || { rm -f "$TMP"; block RESULT_WRITE_FAILED; }
rm -f "$TMP"
[ "${S32_API_ROLLBACK_TEST_MODE:-false}" = true ] || rm -f "$POST"
trap - EXIT INT TERM 2>/dev/null || true
printf 'STATUS=PASS\nAPI_ROLLBACK=PASS\nPOSTGRES_DATA_RETAINED=YES\nMEILI_UNCHANGED=YES\nAUTO_RETRY=NO\n'
