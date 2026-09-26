#!/usr/bin/env bash
set -euo pipefail

# Verify-only recovery for an INCOMPLETE API_TO_R0 rollback.
# It never recreates/restarts any container. Its only production write is the
# missing terminal rollback result receipt after re-proving the restored R0 runtime.

block(){
  printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nWRITE_EXECUTED=%s\n' "$1" "${2:-NO}"
  exit 1
}

[ "$#" -eq 5 ] && [ "$1" = "--recover-api-to-r0-verify-only" ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"; RECOVERY_TOOL_SHA="$5"
printf '%s' "$FP"|grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC"|grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL"|grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA
printf '%s' "$RECOVERY_TOOL_SHA"|grep -qE '^[0-9a-f]{40}$' || block INVALID_RECOVERY_TOOL_SHA

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
DK="${S32_ROLLBACK_RECOVERY_DOCKER:-sudo -n docker}"
P="$ROOT/progress"
R0="${S32_R0_RECEIPT:-$P/s32-r0.env}"
AUTH="$P/s32-rollback-authorization-${FP}-API_TO_R0.env"
CLAIM="$P/s32-rollback-authorization-${FP}-API_TO_R0-claim.env"
START="$P/s32-rollback-${FP}-API_TO_R0.start.env"
RESULT="$P/s32-rollback-${FP}-API_TO_R0.result.env"
R4_START="$P/s32-rollout-${FP}-R4.start.env"
R4_RESULT="$P/s32-rollout-${FP}-R4.result.env"
R5_START="$P/s32-rollout-${FP}-R5.start.env"
R5_RESULT="$P/s32-rollout-${FP}-R5.result.env"
R6_START="$P/s32-rollout-${FP}-R6.start.env"
R6_RESULT="$P/s32-rollout-${FP}-R6.result.env"
R7_START="$P/s32-rollout-${FP}-R7.start.env"

get(){
  local f="$1" k="$2" n
  n="$(grep -cE "^${k}=" "$f" 2>/dev/null||true)"
  [ "$n" = 1 ] || return 1
  grep -E "^${k}=" "$f"|head -1|cut -d= -f2-
}

[ "$(git -C "$ROOT" branch --show-current)" = main ] || block NOT_MAIN_BRANCH
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$CTRL" ] || block PRODUCTION_HEAD_MISMATCH

for f in "$R0" "$AUTH" "$CLAIM" "$START" "$R4_START"; do
  [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c '%a' "$f")" = 600 ] || block REQUIRED_EVIDENCE_INVALID
done
[ ! -e "$RESULT" ] && [ ! -L "$RESULT" ] || block ROLLBACK_ALREADY_TERMINAL
[ ! -e "$R4_RESULT" ] && [ ! -L "$R4_RESULT" ] || block R4_RESULT_PRESENT
for f in "$R5_START" "$R5_RESULT" "$R6_START" "$R6_RESULT" "$R7_START"; do
  [ ! -e "$f" ] && [ ! -L "$f" ] || block LATER_STAGE_PRESENT
done

[ "$(stat -c '%d:%i' "$AUTH")" = "$(stat -c '%d:%i' "$CLAIM")" ] || block ROLLBACK_CLAIM_NOT_SAME_INODE
for key in AUTHORIZATION_VERSION AUTHORIZED_ACTION ROLLBACK_SCOPE S32_RELEASE_FINGERPRINT RELEASE_SOURCE_SHA CONTROL_PLANE_SHA EXPLICIT_APPROVAL CONSUMABLE_ONCE PRODUCTION_WRITE_EXECUTED; do
  [ "$(grep -cE "^${key}=" "$AUTH" 2>/dev/null||true)" = 1 ] || block ROLLBACK_AUTHORIZATION_INVALID
done
[ "$(get "$AUTH" AUTHORIZATION_VERSION)" = 1 ]   && [ "$(get "$AUTH" AUTHORIZED_ACTION)" = S32_PRODUCTION_ROLLBACK ]   && [ "$(get "$AUTH" ROLLBACK_SCOPE)" = API_TO_R0 ]   && [ "$(get "$AUTH" S32_RELEASE_FINGERPRINT)" = "$FP" ]   && [ "$(get "$AUTH" RELEASE_SOURCE_SHA)" = "$SRC" ]   && [ "$(get "$AUTH" CONTROL_PLANE_SHA)" = "$CTRL" ]   && [ "$(get "$AUTH" EXPLICIT_APPROVAL)" = true ]   && [ "$(get "$AUTH" CONSUMABLE_ONCE)" = true ]   && [ "$(get "$AUTH" PRODUCTION_WRITE_EXECUTED)" = false ]   || block ROLLBACK_AUTHORIZATION_MISMATCH

[ "$(get "$START" STATUS || true)" = STARTED ]   && [ "$(get "$START" ROLLBACK_SCOPE || true)" = API_TO_R0 ]   && [ "$(get "$START" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   || block ROLLBACK_START_IDENTITY_MISMATCH
[ "$(get "$R4_START" STATUS || true)" = STARTED ]   && [ "$(get "$R4_START" STAGE || true)" = R4 ]   && [ "$(get "$R4_START" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   || block R4_START_IDENTITY_MISMATCH

ROLLBACK_START_SHA256="$(sha256sum "$START"|cut -d' ' -f1)"
R4_START_SHA256="$(sha256sum "$R4_START"|cut -d' ' -f1)"

[ "$(get "$R0" R0_FINAL || true)" = PASS ] || block R0_NOT_PASS
BASE_API_IMAGE="$(get "$R0" API_IMAGE || true)"
BASE_API_ID="$(get "$R0" API_IMAGE_ID || true)"
BASE_API_REV="$(get "$R0" API_REVISION || true)"
BASE_WEB_REV="$(get "$R0" WEB_REVISION || true)"
BASE_MEILI_DOCUMENTS="$(get "$R0" MEILI_DOCUMENTS || true)"
[ -n "$BASE_API_IMAGE" ] && [ -n "$BASE_API_ID" ] && [ -n "$BASE_API_REV" ] && [ -n "$BASE_WEB_REV" ] || block R0_API_IDENTITY_INVALID
printf '%s' "$BASE_MEILI_DOCUMENTS"|grep -qE '^[0-9]+$' || block R0_MEILI_DOCUMENTS_INVALID

ACTUAL_BASE_ID="$($DK image inspect "$BASE_API_IMAGE" --format '{{.Id}}' 2>/dev/null)" || block BASELINE_API_IMAGE_MISSING
[ "$ACTUAL_BASE_ID" = "$BASE_API_ID" ] || block BASELINE_API_IMAGE_ID_MISMATCH

POST_JSON="${S32_ROLLBACK_RECOVERY_BASELINE_JSON:-}"
TMP=""
trap '[ -z "${TMP:-}" ] || rm -f "$TMP"' EXIT
if [ -z "$POST_JSON" ]; then
  TMP="$(mktemp)"; POST_JSON="$TMP"
  BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$SCRIPT_DIR/plan-s32-production-baseline-with-grace.py" --json-out "$POST_JSON" >/dev/null || block BASELINE_FAILED
fi

python3 - "$POST_JSON" "$R0" <<'PY' || block LEGACY_RUNTIME_NOT_R0
import json,sys
p=json.load(open(sys.argv[1]))
r={}
for line in open(sys.argv[2]):
    if "=" in line:
        k,v=line.rstrip("\n").split("=",1); r[k]=v
for svc,prefix in (("web","WEB"),("api","API"),("meilisearch","MEILISEARCH")):
    s=p.get("services",{}).get(svc,{})
    for field,key in (("imageId","IMAGE_ID"),("revision","REVISION")):
        if s.get(field)!=r.get(prefix+"_"+key):
            raise SystemExit(1)
    if svc!="api":
        for field,key in (("cid","CID"),("startedAt","STARTED_AT")):
            if s.get(field)!=r.get(prefix+"_"+key):
                raise SystemExit(1)
if p.get("httpStatus")!=200:
    raise SystemExit(1)
if p.get("s32EnvNames") not in ([],None):
    raise SystemExit(1)
if str(p.get("stats",{}).get("numberOfDocuments"))!=r.get("MEILI_DOCUMENTS"):
    raise SystemExit(1)
if p.get("stats",{}).get("isIndexing") is not False:
    raise SystemExit(1)
for key in ("ISBN","SSID","DXID","title","author","publisher"):
    if p.get("searches",{}).get(key,{}).get("status")!="PASS":
        raise SystemExit(1)
PY

api_cids="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=api --format '{{.ID}}')"
meili_cids="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=meilisearch --format '{{.ID}}')"
[ "$(printf '%s\n' "$api_cids"|grep -c .)" = 1 ] && [ -n "$api_cids" ] || block API_CONTAINER_NOT_UNIQUE
[ "$(printf '%s\n' "$meili_cids"|grep -c .)" = 1 ] && [ -n "$meili_cids" ] || block MEILI_CONTAINER_NOT_UNIQUE

env_value(){
  local cid="$1" key="$2" lines count
  lines="$($DK inspect "$cid" --format '{{range .Config.Env}}{{println .}}{{end}}')"
  count="$(printf '%s\n' "$lines"|grep -cE "^${key}=" || true)"
  [ "$count" = 1 ] || return 1
  printf '%s\n' "$lines"|grep -E "^${key}="|head -1|cut -d= -f2-
}
API_MEILI_KEY="$(env_value "$api_cids" MEILI_MASTER_KEY || true)"
MEILI_KEY="$(env_value "$meili_cids" MEILI_MASTER_KEY || true)"
[ -n "$API_MEILI_KEY" ] && [ -n "$MEILI_KEY" ] || block MEILI_KEY_MISSING
[ "$(printf '%s' "$API_MEILI_KEY"|sha256sum|cut -d' ' -f1)" = "$(printf '%s' "$MEILI_KEY"|sha256sum|cut -d' ' -f1)" ] || block MEILI_KEY_MISMATCH
unset API_MEILI_KEY MEILI_KEY

pg_cids="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=postgres --format '{{.ID}}')"
[ "$(printf '%s\n' "$pg_cids"|grep -c .)" = 1 ] && [ -n "$pg_cids" ] || block POSTGRES_CONTAINER_NOT_UNIQUE
HEALTH="$($DK inspect "$pg_cids" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
[ "$HEALTH" = healthy ] || block POSTGRES_NOT_HEALTHY
PORTS="$($DK port "$pg_cids" 2>/dev/null||true)"; [ -z "$PORTS" ] || block POSTGRES_PUBLIC_PORT_PRESENT

PGENV="${S32_POSTGRES_ENV_PATH:-/opt/book-id-search-runtime/s32/${FP}/postgres.env}"
[ -f "$PGENV" ] && [ ! -L "$PGENV" ] && [ "$(stat -c '%a' "$PGENV")" = 600 ] || block POSTGRES_ENV_INVALID
DB_NAME="$(get "$PGENV" S32_POSTGRES_DB || true)"
DB_ADMIN="$(get "$PGENV" S32_POSTGRES_USER || true)"
[ "$DB_NAME" = book_id_search_s32 ] && [ "$DB_ADMIN" = s32_admin ] || block POSTGRES_ENV_CONTRACT_INVALID

NS="$($DK exec "$pg_cids" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT count(*) FROM pg_namespace WHERE nspname IN ('core','ops','derived')")" || block DB_STATE_QUERY_FAILED
ROLE="$($DK exec "$pg_cids" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT count(*) FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED
FLAGS="$($DK exec "$pg_cids" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -F, -c "SELECT rolsuper::int,rolcreaterole::int,rolcreatedb::int,rolreplication::int FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED
TABLE_LIST="$($DK exec "$pg_cids" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('core','ops') AND table_type='BASE TABLE' ORDER BY table_schema,table_name")" || block DB_STATE_QUERY_FAILED
TABLES="$(printf '%s\n' "$TABLE_LIST"|grep -c .)"
[ "$NS" = 3 ] && [ "$ROLE" = 1 ] && [ "$FLAGS" = "0,0,0,0" ] && [ "$TABLES" = 26 ] || block R3_DB_STATE_DRIFT
while IFS= read -r table; do
  [ -n "$table" ] || continue
  printf '%s' "$table" | grep -qE "^(core|ops)\.[A-Za-z_][A-Za-z0-9_]*$" || block DB_TABLE_NAME_INVALID
  HAS_ROWS="$($DK exec "$pg_cids" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT EXISTS (SELECT 1 FROM $table LIMIT 1)")" || block DB_STATE_QUERY_FAILED
  [ "$HAS_ROWS" = f ] || block R3_DB_NOT_EMPTY
done <<< "$TABLE_LIST"

[ -z "$TMP" ] || { rm -f "$TMP"; TMP=""; }

umask 077
TMP_RESULT="$(mktemp "$P/.api-rollback-recovery.XXXXXX")"
cat >"$TMP_RESULT" <<EOF
STATUS=PASS
ROLLBACK_SCOPE=API_TO_R0
API_ROLLBACK=PASS
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
CONTROL_PLANE_SHA=$CTRL
BASELINE_API_IMAGE=$BASE_API_IMAGE
BASELINE_API_IMAGE_ID=$BASE_API_ID
BASELINE_API_REVISION=$BASE_API_REV
POSTGRES_DATA_RETAINED=YES
MEILI_UNCHANGED=YES
AUTO_RETRY=NO
ROLLBACK_RECOVERY_MODE=VERIFY_ONLY
ROLLBACK_START_SHA256=$ROLLBACK_START_SHA256
R4_START_SHA256=$R4_START_SHA256
RECOVERY_TOOL_SHA=$RECOVERY_TOOL_SHA
LEGACY_RUNTIME_RESTORED=PASS
EOF
chmod 600 "$TMP_RESULT"
ln -- "$TMP_RESULT" "$RESULT" 2>/dev/null || { rm -f "$TMP_RESULT"; block RESULT_WRITE_FAILED; }
rm -f "$TMP_RESULT"

printf 'STATUS=PASS\nROLLBACK_RECOVERY=VERIFY_ONLY_PASS\nCONTROL_PLANE_SHA=%s\nROLLBACK_START_SHA256=%s\nR4_START_SHA256=%s\nRECOVERY_TOOL_SHA=%s\nWRITE_EXECUTED=YES\n' "$CTRL" "$ROLLBACK_START_SHA256" "$R4_START_SHA256" "$RECOVERY_TOOL_SHA"
