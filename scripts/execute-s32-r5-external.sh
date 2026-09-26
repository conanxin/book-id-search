#!/usr/bin/env bash
set -euo pipefail

# External exact-head R5 activation for an in-flight R4_R5 stage group whose
# production checkout intentionally remains on the incident CTRL.
# One-shot: START without RESULT is incomplete and never auto-retried.

block(){
  printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nWRITE_EXECUTED=%s\n' "$1" "${2:-NO}"
  exit 1
}

[ "$#" -eq 5 ] && [ "$1" = "--execute-r5-external" ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"; TOOL_SHA="$5"
printf '%s' "$FP"|grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC"|grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL"|grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA
printf '%s' "$TOOL_SHA"|grep -qE '^[0-9a-f]{40}$' || block INVALID_TOOL_SHA

ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
P="$ROOT/progress"
DK="${S32_R5_EXTERNAL_DOCKER:-sudo -n docker}"
R0="${S32_R0_RECEIPT:-$P/s32-r0.env}"
R4="${S32_R4_RECEIPT:-$P/s32-rollout-${FP}-R4.result.env}"
CLAIM="$P/s32-rollout-authorization-${FP}-R4_R5-claim.env"
MAN="${S32_RELEASE_MANIFEST_JSON:-$P/s32-release-manifest.json}"
PROD_ENV="${S32_PRODUCTION_ENV_FILE:-$ROOT/.env}"
PG_ENV="${S32_POSTGRES_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/postgres.env}"
API_ENV="${S32_API_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/api.env}"
START="$P/s32-rollout-${FP}-R5.start.env"
RESULT="$P/s32-rollout-${FP}-R5.result.env"

get(){
  local f="$1" k="$2" n
  n="$(grep -cE "^${k}=" "$f" 2>/dev/null||true)"
  [ "$n" = 1 ] || return 1
  grep -E "^${k}=" "$f"|head -1|cut -d= -f2-
}
getout(){
  local text="$1" key="$2" n
  n="$(printf '%s\n' "$text"|grep -cE "^${key}=" || true)"
  [ "$n" = 1 ] || return 1
  printf '%s\n' "$text"|grep -E "^${key}="|head -1|cut -d= -f2-
}
regular600(){ [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c '%a' "$1")" = 600 ]; }

[ "$(git -C "$ROOT" branch --show-current)" = main ] || block NOT_MAIN_BRANCH
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$CTRL" ] || block PRODUCTION_HEAD_MISMATCH

for f in "$R0" "$R4" "$CLAIM" "$PG_ENV" "$API_ENV"; do regular600 "$f" || block REQUIRED_INPUT_INVALID; done
[ -f "$MAN" ] && [ ! -L "$MAN" ] || block RELEASE_MANIFEST_MISSING
[ -f "$PROD_ENV" ] && [ ! -L "$PROD_ENV" ] || block PRODUCTION_ENV_INVALID
[ ! -e "$START" ] && [ ! -L "$START" ] || block R5_ALREADY_STARTED
[ ! -e "$RESULT" ] && [ ! -L "$RESULT" ] || block R5_ALREADY_TERMINAL

[ "$(get "$R4" STATUS || true)" = PASS ]   && [ "$(get "$R4" STAGE || true)" = R4 ]   && [ "$(get "$R4" R4_API_DARK || true)" = PASS ]   && [ "$(get "$R4" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get "$R4" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   || block R4_NOT_PASS

for k in STAGE_GROUP S32_RELEASE_FINGERPRINT RELEASE_SOURCE_SHA CONTROL_PLANE_SHA EXPLICIT_APPROVAL CONSUMABLE_ONCE; do
  [ "$(grep -cE "^${k}=" "$CLAIM" 2>/dev/null||true)" = 1 ] || block R4_R5_CLAIM_INVALID
done
[ "$(get "$CLAIM" STAGE_GROUP)" = R4_R5 ]   && [ "$(get "$CLAIM" S32_RELEASE_FINGERPRINT)" = "$FP" ]   && [ "$(get "$CLAIM" RELEASE_SOURCE_SHA)" = "$SRC" ]   && [ "$(get "$CLAIM" CONTROL_PLANE_SHA)" = "$CTRL" ]   && [ "$(get "$CLAIM" EXPLICIT_APPROVAL)" = true ]   && [ "$(get "$CLAIM" CONSUMABLE_ONCE)" = true ]   || block R4_R5_CLAIM_MISMATCH
CLAIM_SHA256="$(sha256sum "$CLAIM"|cut -d' ' -f1)"

python3 - "$PG_ENV" "$API_ENV" <<'PY' || block API_ENV_CONTRACT_INVALID
import pathlib,sys,urllib.parse,re
def read(path):
    d={}
    for raw in pathlib.Path(path).read_text().splitlines():
        if not raw: continue
        if "=" not in raw: raise SystemExit(1)
        k,v=raw.split("=",1)
        if k in d: raise SystemExit(1)
        d[k]=v
    return d
pg=read(sys.argv[1]); api=read(sys.argv[2])
if set(api)!={"S32_DATABASE_URL","S32_PRIVATE_API_TOKEN"}: raise SystemExit(1)
pw=pg.get("S32_APP_PASSWORD")
if not pw: raise SystemExit(1)
u=urllib.parse.urlsplit(api["S32_DATABASE_URL"])
if u.scheme!="postgresql" or u.username!="s32_app" or u.hostname!="postgres" or u.port is not None: raise SystemExit(1)
if u.path!="/book_id_search_s32" or u.query or u.fragment: raise SystemExit(1)
if urllib.parse.unquote(u.password or "")!=pw: raise SystemExit(1)
if not re.fullmatch(r"[0-9a-f]{64}",api["S32_PRIVATE_API_TOKEN"]): raise SystemExit(1)
PY

DBURL="$(get "$API_ENV" S32_DATABASE_URL || true)"
TOKEN="$(get "$API_ENV" S32_PRIVATE_API_TOKEN || true)"
APP_PASSWORD="$(get "$PG_ENV" S32_APP_PASSWORD || true)"
[ -n "$DBURL" ] && [ -n "$TOKEN" ] && [ -n "$APP_PASSWORD" ] || block API_ENV_CONTRACT_INVALID

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
[ "$API_OBSERVED_ID" = "$(get "$R4" API_IMAGE_ID || true)" ] || block R4_API_IDENTITY_MISMATCH
[ "$API_CONFIG_DIGEST" = "$(get "$R4" API_CONFIG_DIGEST || true)" ] || block R4_API_IDENTITY_MISMATCH
case "$API_IDENTITY_MODE" in CONFIG_DIGEST|MANIFEST_DIGEST) ;; *) block API_RELEASE_IDENTITY_MISMATCH;; esac

BASE_API_REV="$(get "$R0" API_REVISION || true)"
BASE_WEB_REV="$(get "$R0" WEB_REVISION || true)"
BASE_MEILI_DOCUMENTS="$(get "$R0" MEILI_DOCUMENTS || true)"
printf '%s' "$BASE_MEILI_DOCUMENTS"|grep -qE '^[0-9]+$' || block R0_MEILI_DOCUMENTS_INVALID
API_OVERRIDE="${S32_R5_EXTERNAL_API_OVERRIDE:-/opt/book-id-search-runtime/s31/${BASE_API_REV}/api-production.override.yml}"
WEB_OVERRIDE="${S32_R5_EXTERNAL_WEB_OVERRIDE:-/opt/book-id-search-runtime/s32/${BASE_WEB_REV}/web-production.override.yml}"
for f in "$API_OVERRIDE" "$WEB_OVERRIDE"; do [ -f "$f" ] && [ ! -L "$f" ] || block BASELINE_OVERRIDE_INVALID; done

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT INT TERM
PRE="$TMPDIR/pre.json"; POST="$TMPDIR/post.json"; POST2="$TMPDIR/post2.json"
BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$ROOT/scripts/plan-s32-production-baseline.py" --json-out "$PRE" >/dev/null || block PRE_BASELINE_FAILED

python3 - "$PRE" "$R0" "$R4" <<'PY' || block PRE_RUNTIME_NOT_R4_DARK
import json,sys
p=json.load(open(sys.argv[1])); r0={}; r4={}
for line in open(sys.argv[2]):
    if "=" in line:
        k,v=line.rstrip("\n").split("=",1); r0[k]=v
for line in open(sys.argv[3]):
    if "=" in line:
        k,v=line.rstrip("\n").split("=",1); r4[k]=v
a=p["services"]["api"]
if a.get("imageId")!=r4.get("API_IMAGE_ID") or a.get("revision")!=r4.get("API_REVISION"): raise SystemExit(1)
for svc,prefix in (("web","WEB"),("meilisearch","MEILISEARCH")):
    s=p["services"][svc]
    for field,key in (("cid","CID"),("startedAt","STARTED_AT"),("imageId","IMAGE_ID"),("revision","REVISION")):
        if s.get(field)!=r0.get(prefix+"_"+key): raise SystemExit(1)
if p.get("httpStatus")!=200: raise SystemExit(1)
if set(p.get("s32EnvNames") or [])!={"S32_FEATURES_ENABLED","S32_DATABASE_URL","S32_PRIVATE_API_TOKEN"}: raise SystemExit(1)
if str(p.get("stats",{}).get("numberOfDocuments"))!=r0.get("MEILI_DOCUMENTS"): raise SystemExit(1)
if p.get("stats",{}).get("isIndexing") is not False: raise SystemExit(1)
for key in ("ISBN","SSID","DXID","title","author","publisher"):
    if p.get("searches",{}).get(key,{}).get("status")!="PASS": raise SystemExit(1)
PY

API_CID_PRE="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=api --format '{{.ID}}')"
MEILI_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=meilisearch --format '{{.ID}}')"
PG_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=postgres --format '{{.ID}}')"
for cid in "$API_CID_PRE" "$MEILI_CID" "$PG_CID"; do [ "$(printf '%s\n' "$cid"|grep -c .)" = 1 ] && [ -n "$cid" ] || block CONTAINER_NOT_UNIQUE; done

API_ENV_PRE="$($DK inspect "$API_CID_PRE" --format '{{range .Config.Env}}{{println .}}{{end}}')"
count_key(){ printf '%s\n' "$1"|grep -cE "^$2=" || true; }
value_key(){ printf '%s\n' "$1"|grep -E "^$2="|head -1|cut -d= -f2-; }
[ "$(count_key "$API_ENV_PRE" S32_FEATURES_ENABLED)" = 1 ] && [ "$(value_key "$API_ENV_PRE" S32_FEATURES_ENABLED)" = false ] || block PRE_RUNTIME_NOT_R4_DARK
[ "$(count_key "$API_ENV_PRE" S32_DATABASE_URL)" = 1 ] && [ -z "$(value_key "$API_ENV_PRE" S32_DATABASE_URL)" ] || block PRE_RUNTIME_NOT_R4_DARK
[ "$(count_key "$API_ENV_PRE" S32_PRIVATE_API_TOKEN)" = 1 ] && [ -z "$(value_key "$API_ENV_PRE" S32_PRIVATE_API_TOKEN)" ] || block PRE_RUNTIME_NOT_R4_DARK

PG_PRE="$($DK inspect "$PG_CID" --format '{{.Id}}|{{.State.StartedAt}}|{{.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}|{{json .Mounts}}')"
[ "$(printf '%s' "$PG_PRE"|cut -d'|' -f4)" = healthy ] || block POSTGRES_NOT_HEALTHY
[ -z "$($DK port "$PG_CID" 2>/dev/null||true)" ] || block POSTGRES_PUBLIC_PORT_PRESENT

DB_NAME="$(get "$PG_ENV" S32_POSTGRES_DB || true)"
DB_ADMIN="$(get "$PG_ENV" S32_POSTGRES_USER || true)"
[ "$DB_NAME" = book_id_search_s32 ] && [ "$DB_ADMIN" = s32_admin ] || block POSTGRES_ENV_CONTRACT_INVALID
NS="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT count(*) FROM pg_namespace WHERE nspname IN ('core','ops','derived')")" || block DB_STATE_QUERY_FAILED
ROLE="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT count(*) FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED
FLAGS="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -F, -c "SELECT rolsuper::int,rolcreaterole::int,rolcreatedb::int,rolreplication::int FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED
TABLE_LIST="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('core','ops') AND table_type='BASE TABLE' ORDER BY table_schema,table_name")" || block DB_STATE_QUERY_FAILED
[ "$NS" = 3 ] && [ "$ROLE" = 1 ] && [ "$FLAGS" = "0,0,0,0" ] && [ "$(printf '%s\n' "$TABLE_LIST"|grep -c .)" = 26 ] || block R3_DB_STATE_DRIFT
NONEMPTY_PRE=0
while IFS= read -r table; do
  [ -n "$table" ] || continue
  printf '%s' "$table"|grep -qE "^(core|ops)\.[A-Za-z_][A-Za-z0-9_]*$" || block DB_TABLE_NAME_INVALID
  HAS="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT EXISTS (SELECT 1 FROM $table LIMIT 1)")" || block DB_STATE_QUERY_FAILED
  [ "$HAS" = f ] || NONEMPTY_PRE=$((NONEMPTY_PRE+1))
done <<< "$TABLE_LIST"
[ "$NONEMPTY_PRE" = 0 ] || block R5_PRE_DB_NOT_EMPTY

APP_USER="$($DK exec -e "PGPASSWORD=$APP_PASSWORD" "$PG_CID" psql -U s32_app -d "$DB_NAME" -At -c 'SELECT current_user')" || block S32_APP_CONNECT_FAILED
[ "$APP_USER" = s32_app ] || block S32_APP_CONNECT_FAILED

compose_args=(compose --project-directory "$ROOT" --env-file "$PROD_ENV" --env-file "$PG_ENV" --env-file "$API_ENV"
  -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.override.yml"
  -f "$API_OVERRIDE" -f "$WEB_OVERRIDE" -f "$OVERRIDE")

RENDERED="$(sudo -n env S32_FEATURES_ENABLED=true "S32_API_IMAGE=$API_TAG" "S32_POSTGRES_IMAGE=$PG_IMAGE" docker "${compose_args[@]}" config --format json)" || block R5_RENDER_FAILED
MEILI_ENV="$($DK inspect "$MEILI_CID" --format '{{range .Config.Env}}{{println .}}{{end}}')"
MEILI_KEY="$(printf '%s\n' "$MEILI_ENV"|grep -E '^MEILI_MASTER_KEY='|head -1|cut -d= -f2-)"
[ -n "$MEILI_KEY" ] || block MEILI_KEY_MISSING
python3 - "$RENDERED" "$API_TAG" "$DBURL" "$TOKEN" "$(printf '%s' "$MEILI_KEY"|sha256sum|cut -d' ' -f1)" <<'PY' || block R5_RENDER_MISMATCH
import hashlib,json,sys
d=json.loads(sys.argv[1]); api=d.get("services",{}).get("api",{})
if api.get("image")!=sys.argv[2]: raise SystemExit(1)
env=api.get("environment") or {}
if str(env.get("S32_FEATURES_ENABLED","")).lower()!="true": raise SystemExit(1)
if env.get("S32_DATABASE_URL")!=sys.argv[3]: raise SystemExit(1)
if env.get("S32_PRIVATE_API_TOKEN")!=sys.argv[4]: raise SystemExit(1)
key=env.get("MEILI_MASTER_KEY")
if not isinstance(key,str) or not key: raise SystemExit(1)
if hashlib.sha256(key.encode()).hexdigest()!=sys.argv[5]: raise SystemExit(1)
ports=api.get("ports") or []
if not any("127.0.0.1" in str(p) for p in ports): raise SystemExit(1)
PY
unset RENDERED MEILI_ENV MEILI_KEY

umask 077
TMP_START="$(mktemp "$P/.r5-start.XXXXXX")"
cat >"$TMP_START" <<EOF
STATUS=STARTED
STAGE=R5
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
CONTROL_PLANE_SHA=$CTRL
R4_R5_CLAIM_SHA256=$CLAIM_SHA256
EXTERNAL_TOOL_SHA=$TOOL_SHA
EOF
chmod 600 "$TMP_START"
ln -- "$TMP_START" "$START" 2>/dev/null || { rm -f "$TMP_START"; block INCOMPLETE_R5; }
rm -f "$TMP_START"

CMD=(docker "${compose_args[@]}" up -d --no-build --no-deps api)
sudo -n env S32_FEATURES_ENABLED=true "S32_API_IMAGE=$API_TAG" "S32_POSTGRES_IMAGE=$PG_IMAGE" "${CMD[@]}" || block R5_API_RECREATE_FAILED YES

BASELINE_OK=false
for attempt in 1 2 3 4 5 6; do
  rm -f "$POST"
  if BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$ROOT/scripts/plan-s32-production-baseline.py" --json-out "$POST" >/dev/null 2>&1; then
    BASELINE_OK=true
    break
  fi
  [ "$attempt" = 6 ] || sleep 2
done
[ "$BASELINE_OK" = true ] || block R5_POST_BASELINE_FAILED YES

UNAUTH="$(curl -sS -o /dev/null -w '%{http_code}' https://books.conanxin.com/api/private/s32/projects || true)"
[ "$UNAUTH" = 401 ] || block R5_UNAUTH_STATUS_INVALID YES
WRONG_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
[ "$WRONG_TOKEN" != "$TOKEN" ] || block R5_WRONG_TOKEN_GENERATION_FAILED YES
WRONG="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $WRONG_TOKEN" https://books.conanxin.com/api/private/s32/projects || true)"
unset WRONG_TOKEN
[ "$WRONG" = 403 ] || block R5_WRONG_TOKEN_STATUS_INVALID YES
GOOD="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" https://books.conanxin.com/api/private/s32/projects || true)"
[ "$GOOD" = 200 ] || block R5_CORRECT_TOKEN_STATUS_INVALID YES

ACCEPT="$(
  cd "$ROOT"
  env S32_PRIVATE_API_TOKEN="$TOKEN"       S32_RELEASE_FINGERPRINT="$FP"       S32_ACCEPTANCE_BACKEND_ONLY=true       S32_EXPECTED_DOCUMENT_COUNT="$BASE_MEILI_DOCUMENTS"       pnpm s32:production:acceptance
)" || block BACKEND_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" STATUS || true)" = PASS ] || block BACKEND_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" LEGACY_SEARCH_REGRESSION || true)" = PASS ] || block BACKEND_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" ASSESSMENT_REPLAY || true)" = PASS ] || block BACKEND_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" S32_BACKEND_ACCEPTANCE || true)" = PASS ] || block BACKEND_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" MEILI_DOCUMENTS || true)" = "$BASE_MEILI_DOCUMENTS" ] || block BACKEND_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" ACCEPTANCE_PROJECT_RETAINED || true)" = YES ] || block BACKEND_ACCEPTANCE_FAILED YES
PROJECT_ID="$(getout "$ACCEPT" PROJECT_ID || true)"
ASSESSMENT_ID="$(getout "$ACCEPT" ASSESSMENT_ID || true)"
[ -n "$PROJECT_ID" ] && [ -n "$ASSESSMENT_ID" ] || block BACKEND_ACCEPTANCE_FAILED YES

BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$ROOT/scripts/plan-s32-production-baseline.py" --json-out "$POST2" >/dev/null || block R5_FINAL_BASELINE_FAILED YES
python3 - "$POST2" "$R0" "$R4" <<'PY' || block R5_FINAL_VERIFY_FAILED YES
import json,sys
p=json.load(open(sys.argv[1])); r0={}; r4={}
for line in open(sys.argv[2]):
    if "=" in line:
        k,v=line.rstrip("\n").split("=",1); r0[k]=v
for line in open(sys.argv[3]):
    if "=" in line:
        k,v=line.rstrip("\n").split("=",1); r4[k]=v
a=p["services"]["api"]
if a.get("imageId")!=r4.get("API_IMAGE_ID") or a.get("revision")!=r4.get("API_REVISION"): raise SystemExit(1)
for svc,prefix in (("web","WEB"),("meilisearch","MEILISEARCH")):
    s=p["services"][svc]
    for field,key in (("cid","CID"),("startedAt","STARTED_AT"),("imageId","IMAGE_ID"),("revision","REVISION")):
        if s.get(field)!=r0.get(prefix+"_"+key): raise SystemExit(1)
if p.get("httpStatus")!=200: raise SystemExit(1)
if set(p.get("s32EnvNames") or [])!={"S32_FEATURES_ENABLED","S32_DATABASE_URL","S32_PRIVATE_API_TOKEN"}: raise SystemExit(1)
if str(p.get("stats",{}).get("numberOfDocuments"))!=r0.get("MEILI_DOCUMENTS"): raise SystemExit(1)
if p.get("stats",{}).get("isIndexing") is not False: raise SystemExit(1)
for key in ("ISBN","SSID","DXID","title","author","publisher"):
    if p.get("searches",{}).get(key,{}).get("status")!="PASS": raise SystemExit(1)
PY

API_CID_POST="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=api --format '{{.ID}}')"
[ -n "$API_CID_POST" ] && [ "$API_CID_POST" != "$API_CID_PRE" ] || block API_NOT_RECREATED YES
API_ENV_POST="$($DK inspect "$API_CID_POST" --format '{{range .Config.Env}}{{println .}}{{end}}')"
[ "$(count_key "$API_ENV_POST" S32_FEATURES_ENABLED)" = 1 ] && [ "$(value_key "$API_ENV_POST" S32_FEATURES_ENABLED)" = true ] || block S32_FEATURE_FLAG_INVALID YES
[ "$(count_key "$API_ENV_POST" S32_DATABASE_URL)" = 1 ] && [ "$(value_key "$API_ENV_POST" S32_DATABASE_URL)" = "$DBURL" ] || block S32_DATABASE_URL_INVALID YES
[ "$(count_key "$API_ENV_POST" S32_PRIVATE_API_TOKEN)" = 1 ] && [ "$(value_key "$API_ENV_POST" S32_PRIVATE_API_TOKEN)" = "$TOKEN" ] || block S32_PRIVATE_TOKEN_INVALID YES

PG_POST="$($DK inspect "$PG_CID" --format '{{.Id}}|{{.State.StartedAt}}|{{.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}|{{json .Mounts}}')"
[ "$PG_POST" = "$PG_PRE" ] || block POSTGRES_RUNTIME_DRIFT YES
[ -z "$($DK port "$PG_CID" 2>/dev/null||true)" ] || block POSTGRES_PUBLIC_PORT_PRESENT YES

NS2="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT count(*) FROM pg_namespace WHERE nspname IN ('core','ops','derived')")" || block DB_STATE_QUERY_FAILED YES
ROLE2="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT count(*) FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED YES
FLAGS2="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -F, -c "SELECT rolsuper::int,rolcreaterole::int,rolcreatedb::int,rolreplication::int FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED YES
TABLE_LIST2="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('core','ops') AND table_type='BASE TABLE' ORDER BY table_schema,table_name")" || block DB_STATE_QUERY_FAILED YES
[ "$NS2" = 3 ] && [ "$ROLE2" = 1 ] && [ "$FLAGS2" = "0,0,0,0" ] && [ "$(printf '%s\n' "$TABLE_LIST2"|grep -c .)" = 26 ] || block R3_DB_STATE_DRIFT YES
NONEMPTY_POST=0
while IFS= read -r table; do
  [ -n "$table" ] || continue
  HAS="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT EXISTS (SELECT 1 FROM $table LIMIT 1)")" || block DB_STATE_QUERY_FAILED YES
  [ "$HAS" = t ] && NONEMPTY_POST=$((NONEMPTY_POST+1))
done <<< "$TABLE_LIST2"
[ "$NONEMPTY_POST" -ge 1 ] || block BACKEND_PERSISTENCE_NOT_OBSERVED YES

TMP_RESULT="$(mktemp "$P/.r5-result.XXXXXX")"
cat >"$TMP_RESULT" <<EOF
STATUS=PASS
STAGE=R5
R5_S32_ACTIVATION=PASS
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
MEILI_DOCUMENTS=$BASE_MEILI_DOCUMENTS
API_IMAGE_ID=$API_OBSERVED_ID
API_CONFIG_DIGEST=$API_CONFIG_DIGEST
S32_FEATURES_ENABLED=true
BACKEND_ACCEPTANCE=PASS
R5_EXECUTION_MODE=EXTERNAL_EXACT_HEAD
EXTERNAL_TOOL_SHA=$TOOL_SHA
R4_R5_CLAIM_SHA256=$CLAIM_SHA256
PRIVATE_UNAUTH_STATUS=401
PRIVATE_WRONG_TOKEN_STATUS=403
PRIVATE_AUTHORIZED_STATUS=200
ACCEPTANCE_PROJECT_ID=$PROJECT_ID
ASSESSMENT_ID=$ASSESSMENT_ID
ASSESSMENT_REPLAY=PASS
ACCEPTANCE_PROJECT_RETAINED=YES
NONEMPTY_CORE_OPS_TABLES=$NONEMPTY_POST
EOF
chmod 600 "$TMP_RESULT"
ln -- "$TMP_RESULT" "$RESULT" 2>/dev/null || { rm -f "$TMP_RESULT"; block RESULT_WRITE_FAILED YES; }
rm -f "$TMP_RESULT"

printf 'STATUS=PASS\nR5_S32_ACTIVATION=PASS\nS32_FEATURES_ENABLED=true\nBACKEND_ACCEPTANCE=PASS\nPRIVATE_UNAUTH_STATUS=401\nPRIVATE_WRONG_TOKEN_STATUS=403\nPRIVATE_AUTHORIZED_STATUS=200\nNONEMPTY_CORE_OPS_TABLES=%s\nWRITE_EXECUTED=YES\n' "$NONEMPTY_POST"
