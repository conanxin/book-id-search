#!/usr/bin/env bash
set -euo pipefail

# One-shot recovery for an INCOMPLETE R4 whose failed API-dark runtime was
# explicitly rolled back to canonical R0 and whose rollback is terminal PASS.
# This tool re-drives exactly one repaired API-dark recreate, preserves the
# original R4 START, and terminalizes R4 only after full post-verification.

block(){
  printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nWRITE_EXECUTED=%s\n' "$1" "${2:-NO}"
  exit 1
}

[ "$#" -eq 5 ] && [ "$1" = "--recover-r4-after-rollback" ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"; RECOVERY_TOOL_SHA="$5"
printf '%s' "$FP"|grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC"|grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL"|grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA
printf '%s' "$RECOVERY_TOOL_SHA"|grep -qE '^[0-9a-f]{40}$' || block INVALID_RECOVERY_TOOL_SHA

ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
P="$ROOT/progress"
DK="${S32_R4_RECOVERY_DOCKER:-sudo -n docker}"
R0="${S32_R0_RECEIPT:-$P/s32-r0.env}"
R3="${S32_R3_RECEIPT:-$P/s32-rollout-${FP}-R3.result.env}"
CAP="${S32_R4_CAPACITY_RECEIPT:-$P/s32-r4-capacity.env}"
MAN="${S32_RELEASE_MANIFEST_JSON:-$P/s32-release-manifest.json}"
PROD_ENV="${S32_PRODUCTION_ENV_FILE:-$ROOT/.env}"
PG_ENV="${S32_POSTGRES_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/postgres.env}"
AUTH="$P/s32-rollout-authorization-${FP}-R4_R5.env"
CLAIM="$P/s32-rollout-authorization-${FP}-R4_R5-claim.env"
R4_START="$P/s32-rollout-${FP}-R4.start.env"
R4_RESULT="$P/s32-rollout-${FP}-R4.result.env"
ROLLBACK_RESULT="$P/s32-rollback-${FP}-API_TO_R0.result.env"
RECOVERY_START="$P/s32-rollout-${FP}-R4.recovery.start.env"
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

require_regular_600(){
  [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c '%a' "$1")" = 600 ]
}

[ "$(git -C "$ROOT" branch --show-current)" = main ] || block NOT_MAIN_BRANCH
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$CTRL" ] || block PRODUCTION_HEAD_MISMATCH

for f in "$R0" "$R3" "$CAP" "$AUTH" "$CLAIM" "$R4_START" "$ROLLBACK_RESULT" "$PG_ENV"; do
  require_regular_600 "$f" || block REQUIRED_EVIDENCE_INVALID
done
[ -f "$MAN" ] && [ ! -L "$MAN" ] || block RELEASE_MANIFEST_INVALID
[ -f "$PROD_ENV" ] && [ ! -L "$PROD_ENV" ] || block PRODUCTION_ENV_INVALID
[ "$(stat -c '%d:%i' "$AUTH")" = "$(stat -c '%d:%i' "$CLAIM")" ] || block R4_R5_CLAIM_NOT_SAME_INODE
[ ! -e "$R4_RESULT" ] && [ ! -L "$R4_RESULT" ] || block R4_ALREADY_TERMINAL
[ ! -e "$RECOVERY_START" ] && [ ! -L "$RECOVERY_START" ] || block R4_RECOVERY_ALREADY_STARTED
for f in "$R5_START" "$R5_RESULT" "$R6_START" "$R6_RESULT" "$R7_START"; do
  [ ! -e "$f" ] && [ ! -L "$f" ] || block LATER_STAGE_PRESENT
done

[ "$(get "$R3" STATUS || true)" = PASS ]   && [ "$(get "$R3" R3_SCHEMA || true)" = PASS ]   && [ "$(get "$R3" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   || block R3_NOT_PASS
[ "$(get "$CAP" STATUS || true)" = PASS ]   && [ "$(get "$CAP" CAPACITY_GATE || true)" = PASS_PREFERRED ]   && [ "$(get "$CAP" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get "$CAP" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   || block R4_CAPACITY_NOT_PASS

for k in STAGE_GROUP S32_RELEASE_FINGERPRINT RELEASE_SOURCE_SHA CONTROL_PLANE_SHA EXPLICIT_APPROVAL CONSUMABLE_ONCE; do
  [ "$(grep -cE "^${k}=" "$CLAIM" 2>/dev/null||true)" = 1 ] || block R4_R5_CLAIM_INVALID
done
[ "$(get "$CLAIM" STAGE_GROUP)" = R4_R5 ]   && [ "$(get "$CLAIM" S32_RELEASE_FINGERPRINT)" = "$FP" ]   && [ "$(get "$CLAIM" RELEASE_SOURCE_SHA)" = "$SRC" ]   && [ "$(get "$CLAIM" CONTROL_PLANE_SHA)" = "$CTRL" ]   && [ "$(get "$CLAIM" EXPLICIT_APPROVAL)" = true ]   && [ "$(get "$CLAIM" CONSUMABLE_ONCE)" = true ]   || block R4_R5_CLAIM_MISMATCH

[ "$(get "$R4_START" STATUS || true)" = STARTED ]   && [ "$(get "$R4_START" STAGE || true)" = R4 ]   && [ "$(get "$R4_START" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   || block R4_START_IDENTITY_MISMATCH
R4_START_SHA256="$(sha256sum "$R4_START"|cut -d' ' -f1)"

[ "$(get "$ROLLBACK_RESULT" STATUS || true)" = PASS ]   && [ "$(get "$ROLLBACK_RESULT" ROLLBACK_SCOPE || true)" = API_TO_R0 ]   && [ "$(get "$ROLLBACK_RESULT" API_ROLLBACK || true)" = PASS ]   && [ "$(get "$ROLLBACK_RESULT" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get "$ROLLBACK_RESULT" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   && [ "$(get "$ROLLBACK_RESULT" CONTROL_PLANE_SHA || true)" = "$CTRL" ]   && [ "$(get "$ROLLBACK_RESULT" LEGACY_RUNTIME_RESTORED || true)" = PASS ]   || block ROLLBACK_NOT_TERMINAL_PASS
ROLLBACK_RESULT_SHA256="$(sha256sum "$ROLLBACK_RESULT"|cut -d' ' -f1)"

MAN_OUT="$(python3 "$ROOT/scripts/s32-release-manifest.py" "$MAN" 2>&1)" || block RELEASE_MANIFEST_INVALID
[ "$(printf '%s\n' "$MAN_OUT"|awk -F= '$1=="S32_RELEASE_FINGERPRINT"{print $2;exit}')" = "$FP" ] || block RELEASE_MANIFEST_IDENTITY_MISMATCH
[ "$(printf '%s\n' "$MAN_OUT"|awk -F= '$1=="SOURCE_SHA"{print $2;exit}')" = "$SRC" ] || block RELEASE_MANIFEST_IDENTITY_MISMATCH

readarray -t MF < <(python3 - "$MAN" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
print(m['apiImageTag'])
print(m['apiImageId'])
print(m['apiOciRevision'])
print(m['pgImageRef'])
print(m['s32OverridePath'])
PY
)
API_TAG="${MF[0]}"; API_CONFIG_DIGEST="${MF[1]}"; API_REV="${MF[2]}"; PG_IMAGE="${MF[3]}"; OVERRIDE="$ROOT/${MF[4]}"
[ "$API_REV" = "$SRC" ] || block API_RELEASE_IDENTITY_MISMATCH
[ -f "$OVERRIDE" ] && [ ! -L "$OVERRIDE" ] || block S32_OVERRIDE_INVALID

IMG_OUT="$(bash "$ROOT/scripts/verify-s32-local-image.sh" "$API_TAG" "$API_CONFIG_DIGEST" "$SRC" 2>&1)" || block API_RELEASE_IDENTITY_MISMATCH
API_OBSERVED_ID="$(printf '%s\n' "$IMG_OUT"|awk -F= '$1=="OBSERVED_IMAGE_ID"{print $2;exit}')"
API_IDENTITY_MODE="$(printf '%s\n' "$IMG_OUT"|awk -F= '$1=="BACKEND_IDENTITY_MODE"{print $2;exit}')"
printf '%s' "$API_OBSERVED_ID"|grep -qE '^sha256:[0-9a-f]{64}$' || block API_RELEASE_IDENTITY_MISMATCH
case "$API_IDENTITY_MODE" in CONFIG_DIGEST|MANIFEST_DIGEST) ;; *) block API_RELEASE_IDENTITY_MISMATCH;; esac

BASE_API_IMAGE="$(get "$R0" API_IMAGE || true)"
BASE_API_ID="$(get "$R0" API_IMAGE_ID || true)"
BASE_API_REV="$(get "$R0" API_REVISION || true)"
BASE_WEB_REV="$(get "$R0" WEB_REVISION || true)"
BASE_MEILI_DOCUMENTS="$(get "$R0" MEILI_DOCUMENTS || true)"
[ -n "$BASE_API_IMAGE" ] && [ -n "$BASE_API_ID" ] && [ -n "$BASE_API_REV" ] && [ -n "$BASE_WEB_REV" ] || block R0_API_IDENTITY_INVALID
printf '%s' "$BASE_MEILI_DOCUMENTS"|grep -qE '^[0-9]+$' || block R0_MEILI_DOCUMENTS_INVALID
API_OVERRIDE="/opt/book-id-search-runtime/s31/${BASE_API_REV}/api-production.override.yml"
WEB_OVERRIDE="/opt/book-id-search-runtime/s32/${BASE_WEB_REV}/web-production.override.yml"
for f in "$API_OVERRIDE" "$WEB_OVERRIDE"; do [ -f "$f" ] && [ ! -L "$f" ] || block BASELINE_OVERRIDE_INVALID; done

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT INT TERM
PRE="$TMPDIR/pre.json"; POST="$TMPDIR/post.json"
BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$ROOT/scripts/plan-s32-production-baseline.py" --json-out "$PRE" >/dev/null || block PRE_BASELINE_FAILED

python3 - "$PRE" "$R0" <<'PY' || block PRE_RUNTIME_NOT_R0
import json,sys
p=json.load(open(sys.argv[1]))
r={}
for line in open(sys.argv[2]):
    if "=" in line:
        k,v=line.rstrip("\n").split("=",1); r[k]=v
for svc,prefix in (("web","WEB"),("api","API"),("meilisearch","MEILISEARCH")):
    s=p["services"][svc]
    for field,key in (("imageId","IMAGE_ID"),("revision","REVISION")):
        if s.get(field)!=r.get(prefix+"_"+key): raise SystemExit(1)
    if svc!="api":
        for field,key in (("cid","CID"),("startedAt","STARTED_AT")):
            if s.get(field)!=r.get(prefix+"_"+key): raise SystemExit(1)
if p.get("httpStatus")!=200: raise SystemExit(1)
if p.get("s32EnvNames") not in ([],None): raise SystemExit(1)
if str(p.get("stats",{}).get("numberOfDocuments"))!=r.get("MEILI_DOCUMENTS"): raise SystemExit(1)
if p.get("stats",{}).get("isIndexing") is not False: raise SystemExit(1)
for key in ("ISBN","SSID","DXID","title","author","publisher"):
    if p.get("searches",{}).get(key,{}).get("status")!="PASS": raise SystemExit(1)
PY

compose_args=(compose --project-directory "$ROOT" --env-file "$PROD_ENV" --env-file "$PG_ENV"
  -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.override.yml"
  -f "$API_OVERRIDE" -f "$WEB_OVERRIDE" -f "$OVERRIDE")

RENDERED="$(sudo -n env S32_FEATURES_ENABLED=false S32_DATABASE_URL= S32_PRIVATE_API_TOKEN= "S32_API_IMAGE=$API_TAG" "S32_POSTGRES_IMAGE=$PG_IMAGE" docker "${compose_args[@]}" config --format json)" || block R4_RECOVERY_RENDER_FAILED
MEILI_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=meilisearch --format '{{.ID}}')"
[ "$(printf '%s\n' "$MEILI_CID"|grep -c .)" = 1 ] && [ -n "$MEILI_CID" ] || block MEILI_CONTAINER_NOT_UNIQUE
MEILI_ENV="$($DK inspect "$MEILI_CID" --format '{{range .Config.Env}}{{println .}}{{end}}')"
MEILI_KEY="$(printf '%s\n' "$MEILI_ENV"|grep -E '^MEILI_MASTER_KEY='|head -1|cut -d= -f2-)"
[ -n "$MEILI_KEY" ] || block MEILI_KEY_MISSING
python3 - "$RENDERED" "$API_TAG" "$(printf '%s' "$MEILI_KEY"|sha256sum|cut -d' ' -f1)" <<'PY' || block R4_RECOVERY_RENDER_MISMATCH
import hashlib,json,sys
d=json.loads(sys.argv[1]); expected_image=sys.argv[2]; expected_hash=sys.argv[3]
api=d.get("services",{}).get("api",{})
if api.get("image")!=expected_image: raise SystemExit(1)
env=api.get("environment") or {}
if str(env.get("S32_FEATURES_ENABLED","")).lower()!="false": raise SystemExit(1)
if env.get("S32_DATABASE_URL") not in ("",None): raise SystemExit(1)
if env.get("S32_PRIVATE_API_TOKEN") not in ("",None): raise SystemExit(1)
key=env.get("MEILI_MASTER_KEY")
if not isinstance(key,str) or not key: raise SystemExit(1)
if hashlib.sha256(key.encode()).hexdigest()!=expected_hash: raise SystemExit(1)
PY
unset MEILI_KEY MEILI_ENV RENDERED

PG_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=postgres --format '{{.ID}}')"
[ "$(printf '%s\n' "$PG_CID"|grep -c .)" = 1 ] && [ -n "$PG_CID" ] || block POSTGRES_CONTAINER_NOT_UNIQUE
PG_PRE="$($DK inspect "$PG_CID" --format '{{.Id}}|{{.State.StartedAt}}|{{.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}|{{json .Mounts}}')"
PG_PORTS="$($DK port "$PG_CID" 2>/dev/null||true)"
[ -z "$PG_PORTS" ] || block POSTGRES_PUBLIC_PORT_PRESENT
[ "$(printf '%s' "$PG_PRE"|cut -d'|' -f4)" = healthy ] || block POSTGRES_NOT_HEALTHY

umask 077
TMP_START="$(mktemp "$P/.r4-recovery-start.XXXXXX")"
cat >"$TMP_START" <<EOF
STATUS=STARTED
STAGE=R4_RECOVERY
R4_RECOVERY_MODE=AFTER_API_TO_R0_ROLLBACK
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
CONTROL_PLANE_SHA=$CTRL
R4_START_SHA256=$R4_START_SHA256
ROLLBACK_RESULT_SHA256=$ROLLBACK_RESULT_SHA256
RECOVERY_TOOL_SHA=$RECOVERY_TOOL_SHA
EOF
chmod 600 "$TMP_START"
ln -- "$TMP_START" "$RECOVERY_START" 2>/dev/null || { rm -f "$TMP_START"; block R4_RECOVERY_ALREADY_STARTED; }
rm -f "$TMP_START"

CMD=(docker "${compose_args[@]}" up -d --no-build --no-deps api)
sudo -n env S32_FEATURES_ENABLED=false S32_DATABASE_URL= S32_PRIVATE_API_TOKEN= "S32_API_IMAGE=$API_TAG" "S32_POSTGRES_IMAGE=$PG_IMAGE" "${CMD[@]}" || block R4_RECOVERY_API_RECREATE_FAILED YES

BASELINE_OK=false
for attempt in 1 2 3 4 5 6; do
  rm -f "$POST"
  if BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$ROOT/scripts/plan-s32-production-baseline.py" --json-out "$POST" >/dev/null 2>&1; then
    BASELINE_OK=true
    break
  fi
  [ "$attempt" = 6 ] || sleep 2
done
[ "$BASELINE_OK" = true ] || block R4_RECOVERY_POST_BASELINE_FAILED YES

code="$(curl -sS -o /dev/null -w '%{http_code}' https://books.conanxin.com/api/private/s32/projects || true)"
[ "$code" = 404 ] || block S32_NOT_DISABLED YES

python3 - "$POST" "$R0" "$API_OBSERVED_ID" "$SRC" <<'PY' || block R4_RECOVERY_POSTVERIFY_FAILED YES
import json,sys
p=json.load(open(sys.argv[1])); r={}
for line in open(sys.argv[2]):
    if "=" in line:
        k,v=line.rstrip("\n").split("=",1); r[k]=v
api=p["services"]["api"]
if api.get("imageId")!=sys.argv[3] or api.get("revision")!=sys.argv[4]: raise SystemExit(1)
for svc,prefix in (("web","WEB"),("meilisearch","MEILISEARCH")):
    s=p["services"][svc]
    for field,key in (("cid","CID"),("startedAt","STARTED_AT"),("imageId","IMAGE_ID"),("revision","REVISION")):
        if s.get(field)!=r.get(prefix+"_"+key): raise SystemExit(1)
if p.get("httpStatus")!=200: raise SystemExit(1)
if set(p.get("s32EnvNames") or [])!={"S32_FEATURES_ENABLED","S32_DATABASE_URL","S32_PRIVATE_API_TOKEN"}: raise SystemExit(1)
if str(p.get("stats",{}).get("numberOfDocuments"))!=r.get("MEILI_DOCUMENTS"): raise SystemExit(1)
if p.get("stats",{}).get("isIndexing") is not False: raise SystemExit(1)
for key in ("ISBN","SSID","DXID","title","author","publisher"):
    if p.get("searches",{}).get(key,{}).get("status")!="PASS": raise SystemExit(1)
PY

API_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=api --format '{{.ID}}')"
[ "$(printf '%s\n' "$API_CID"|grep -c .)" = 1 ] && [ -n "$API_CID" ] || block API_CONTAINER_NOT_UNIQUE YES
API_ENV="$($DK inspect "$API_CID" --format '{{range .Config.Env}}{{println .}}{{end}}')"
env_one(){
  local key="$1" count
  count="$(printf '%s\n' "$API_ENV"|grep -cE "^${key}=" || true)"
  [ "$count" = 1 ] || return 1
  printf '%s\n' "$API_ENV"|grep -E "^${key}="|head -1|cut -d= -f2-
}
[ "$(env_one S32_FEATURES_ENABLED || true)" = false ] || block S32_FEATURE_FLAG_INVALID YES
[ -z "$(env_one S32_DATABASE_URL || printf x)" ] || block S32_DATABASE_URL_NOT_EMPTY YES
[ -z "$(env_one S32_PRIVATE_API_TOKEN || printf x)" ] || block S32_PRIVATE_TOKEN_NOT_EMPTY YES

PG_POST="$($DK inspect "$PG_CID" --format '{{.Id}}|{{.State.StartedAt}}|{{.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}|{{json .Mounts}}')"
[ "$PG_POST" = "$PG_PRE" ] || block POSTGRES_RUNTIME_DRIFT YES
PG_PORTS="$($DK port "$PG_CID" 2>/dev/null||true)"
[ -z "$PG_PORTS" ] || block POSTGRES_PUBLIC_PORT_PRESENT YES

DB_NAME="$(get "$PG_ENV" S32_POSTGRES_DB || true)"
DB_ADMIN="$(get "$PG_ENV" S32_POSTGRES_USER || true)"
[ "$DB_NAME" = book_id_search_s32 ] && [ "$DB_ADMIN" = s32_admin ] || block POSTGRES_ENV_CONTRACT_INVALID YES
NS="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT count(*) FROM pg_namespace WHERE nspname IN ('core','ops','derived')")" || block DB_STATE_QUERY_FAILED YES
ROLE="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT count(*) FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED YES
FLAGS="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -F, -c "SELECT rolsuper::int,rolcreaterole::int,rolcreatedb::int,rolreplication::int FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED YES
TABLE_LIST="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('core','ops') AND table_type='BASE TABLE' ORDER BY table_schema,table_name")" || block DB_STATE_QUERY_FAILED YES
TABLES="$(printf '%s\n' "$TABLE_LIST"|grep -c .)"
[ "$NS" = 3 ] && [ "$ROLE" = 1 ] && [ "$FLAGS" = "0,0,0,0" ] && [ "$TABLES" = 26 ] || block R3_DB_STATE_DRIFT YES
while IFS= read -r table; do
  [ -n "$table" ] || continue
  printf '%s' "$table"|grep -qE "^(core|ops)\.[A-Za-z_][A-Za-z0-9_]*$" || block DB_TABLE_NAME_INVALID YES
  HAS_ROWS="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT EXISTS (SELECT 1 FROM $table LIMIT 1)")" || block DB_STATE_QUERY_FAILED YES
  [ "$HAS_ROWS" = f ] || block R3_DB_NOT_EMPTY YES
done <<< "$TABLE_LIST"

TMP_RESULT="$(mktemp "$P/.r4-recovery-result.XXXXXX")"
cat >"$TMP_RESULT" <<EOF
STATUS=PASS
STAGE=R4
R4_API_DARK=PASS
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
MEILI_DOCUMENTS=$BASE_MEILI_DOCUMENTS
API_IMAGE_ID=$API_OBSERVED_ID
API_CONFIG_DIGEST=$API_CONFIG_DIGEST
API_IDENTITY_MODE=$API_IDENTITY_MODE
API_REVISION=$SRC
S32_FEATURES_ENABLED=false
R4_RECOVERY_MODE=AFTER_API_TO_R0_ROLLBACK
R4_START_SHA256=$R4_START_SHA256
ROLLBACK_RESULT_SHA256=$ROLLBACK_RESULT_SHA256
RECOVERY_TOOL_SHA=$RECOVERY_TOOL_SHA
EOF
chmod 600 "$TMP_RESULT"
ln -- "$TMP_RESULT" "$R4_RESULT" 2>/dev/null || { rm -f "$TMP_RESULT"; block RESULT_WRITE_FAILED YES; }
rm -f "$TMP_RESULT"

printf 'STATUS=PASS\nR4_RECOVERY=AFTER_API_TO_R0_ROLLBACK_PASS\nR4_API_DARK=PASS\nCONTROL_PLANE_SHA=%s\nR4_START_SHA256=%s\nROLLBACK_RESULT_SHA256=%s\nRECOVERY_TOOL_SHA=%s\nWRITE_EXECUTED=YES\n' "$CTRL" "$R4_START_SHA256" "$ROLLBACK_RESULT_SHA256" "$RECOVERY_TOOL_SHA"
