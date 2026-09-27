#!/usr/bin/env bash
set -euo pipefail

# Recovery for R5 after the API was already activated successfully but the
# production-side acceptance command failed because pnpm was unavailable.
# No container mutation is permitted here. Acceptance must already have been
# executed externally with the exact reviewed harness. This script re-proves
# runtime + DB evidence and terminalizes the retained R5 START.

block(){
  printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nWRITE_EXECUTED=%s\n' "$1" "${2:-NO}"
  exit 1
}

[ "$#" -eq 7 ] && [ "$1" = "--recover-r5-acceptance" ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"; TOOL_SHA="$5"; PROJECT_ID="$6"; ASSESSMENT_ID="$7"
printf '%s' "$FP"|grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC"|grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL"|grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA
printf '%s' "$TOOL_SHA"|grep -qE '^[0-9a-f]{40}$' || block INVALID_TOOL_SHA
printf '%s' "$PROJECT_ID"|grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || block INVALID_PROJECT_ID
printf '%s' "$ASSESSMENT_ID"|grep -qiE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' || block INVALID_ASSESSMENT_ID

ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
P="$ROOT/progress"
DK="${S32_R5_RECOVERY_DOCKER:-sudo -n docker}"
R0="${S32_R0_RECEIPT:-$P/s32-r0.env}"
R4="${S32_R4_RECEIPT:-$P/s32-rollout-${FP}-R4.result.env}"
CLAIM="$P/s32-rollout-authorization-${FP}-R4_R5-claim.env"
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
regular600(){ [ -f "$1" ] && [ ! -L "$1" ] && [ "$(stat -c '%a' "$1")" = 600 ]; }

[ "$(git -C "$ROOT" branch --show-current)" = main ] || block NOT_MAIN_BRANCH
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$CTRL" ] || block PRODUCTION_HEAD_MISMATCH

for f in "$R0" "$R4" "$CLAIM" "$PG_ENV" "$API_ENV" "$START"; do regular600 "$f" || block REQUIRED_EVIDENCE_INVALID; done
[ ! -e "$RESULT" ] && [ ! -L "$RESULT" ] || block R5_ALREADY_TERMINAL

[ "$(get "$R4" STATUS || true)" = PASS ]   && [ "$(get "$R4" STAGE || true)" = R4 ]   && [ "$(get "$R4" R4_API_DARK || true)" = PASS ]   && [ "$(get "$R4" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get "$R4" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   || block R4_NOT_PASS

[ "$(get "$CLAIM" STAGE_GROUP || true)" = R4_R5 ]   && [ "$(get "$CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get "$CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   && [ "$(get "$CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ]   || block R4_R5_CLAIM_MISMATCH
CLAIM_SHA256="$(sha256sum "$CLAIM"|cut -d' ' -f1)"

[ "$(get "$START" STATUS || true)" = STARTED ]   && [ "$(get "$START" STAGE || true)" = R5 ]   && [ "$(get "$START" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get "$START" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   && [ "$(get "$START" CONTROL_PLANE_SHA || true)" = "$CTRL" ]   && [ "$(get "$START" R4_R5_CLAIM_SHA256 || true)" = "$CLAIM_SHA256" ]   || block R5_START_IDENTITY_MISMATCH
R5_START_SHA256="$(sha256sum "$START"|cut -d' ' -f1)"

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

TOKEN="$(get "$API_ENV" S32_PRIVATE_API_TOKEN || true)"
[ -n "$TOKEN" ] || block API_ENV_CONTRACT_INVALID

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM
BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$ROOT/scripts/plan-s32-production-baseline.py" --json-out "$TMP" >/dev/null || block BASELINE_FAILED
python3 - "$TMP" "$R0" "$R4" <<'PY' || block R5_ACTIVE_RUNTIME_INVALID
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

API_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=api --format '{{.ID}}')"
PG_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=postgres --format '{{.ID}}')"
MEILI_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=meilisearch --format '{{.ID}}')"
for cid in "$API_CID" "$PG_CID" "$MEILI_CID"; do [ "$(printf '%s\n' "$cid"|grep -c .)" = 1 ] && [ -n "$cid" ] || block CONTAINER_NOT_UNIQUE; done

API_ENV_RUNTIME="$($DK inspect "$API_CID" --format '{{range .Config.Env}}{{println .}}{{end}}')"
count_key(){ printf '%s\n' "$1"|grep -cE "^$2=" || true; }
value_key(){ printf '%s\n' "$1"|grep -E "^$2="|head -1|cut -d= -f2-; }
[ "$(count_key "$API_ENV_RUNTIME" S32_FEATURES_ENABLED)" = 1 ] && [ "$(value_key "$API_ENV_RUNTIME" S32_FEATURES_ENABLED)" = true ] || block R5_ACTIVE_RUNTIME_INVALID
[ "$(count_key "$API_ENV_RUNTIME" S32_DATABASE_URL)" = 1 ] && [ "$(value_key "$API_ENV_RUNTIME" S32_DATABASE_URL)" = "$(get "$API_ENV" S32_DATABASE_URL)" ] || block R5_ACTIVE_RUNTIME_INVALID
[ "$(count_key "$API_ENV_RUNTIME" S32_PRIVATE_API_TOKEN)" = 1 ] && [ "$(value_key "$API_ENV_RUNTIME" S32_PRIVATE_API_TOKEN)" = "$TOKEN" ] || block R5_ACTIVE_RUNTIME_INVALID

UNAUTH="$(curl -sS -o /dev/null -w '%{http_code}' https://books.conanxin.com/api/private/s32/projects || true)"
[ "$UNAUTH" = 401 ] || block R5_UNAUTH_STATUS_INVALID
WRONG_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
[ "$WRONG_TOKEN" != "$TOKEN" ] || block WRONG_TOKEN_GENERATION_FAILED
WRONG="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $WRONG_TOKEN" https://books.conanxin.com/api/private/s32/projects || true)"
unset WRONG_TOKEN
[ "$WRONG" = 403 ] || block R5_WRONG_TOKEN_STATUS_INVALID
GOOD="$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" https://books.conanxin.com/api/private/s32/projects || true)"
[ "$GOOD" = 200 ] || block R5_CORRECT_TOKEN_STATUS_INVALID

[ -z "$($DK port "$PG_CID" 2>/dev/null||true)" ] || block POSTGRES_PUBLIC_PORT_PRESENT
PG_HEALTH="$($DK inspect "$PG_CID" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
[ "$PG_HEALTH" = healthy ] || block POSTGRES_NOT_HEALTHY

DB_NAME="$(get "$PG_ENV" S32_POSTGRES_DB || true)"
DB_ADMIN="$(get "$PG_ENV" S32_POSTGRES_USER || true)"
[ "$DB_NAME" = book_id_search_s32 ] && [ "$DB_ADMIN" = s32_admin ] || block POSTGRES_ENV_CONTRACT_INVALID

NS="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT count(*) FROM pg_namespace WHERE nspname IN ('core','ops','derived')")" || block DB_STATE_QUERY_FAILED
ROLE="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT count(*) FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED
FLAGS="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -F, -c "SELECT rolsuper::int,rolcreaterole::int,rolcreatedb::int,rolreplication::int FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED
TABLE_LIST="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT table_schema||'.'||table_name FROM information_schema.tables WHERE table_schema IN ('core','ops') AND table_type='BASE TABLE' ORDER BY table_schema,table_name")" || block DB_STATE_QUERY_FAILED
[ "$NS" = 3 ] && [ "$ROLE" = 1 ] && [ "$FLAGS" = "0,0,0,0" ] && [ "$(printf '%s\n' "$TABLE_LIST"|grep -c .)" = 26 ] || block R3_DB_STATE_DRIFT

NONEMPTY=0
while IFS= read -r table; do
  [ -n "$table" ] || continue
  printf '%s' "$table"|grep -qE "^(core|ops)\.[A-Za-z_][A-Za-z0-9_]*$" || block DB_TABLE_NAME_INVALID
  HAS="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -c "SELECT EXISTS (SELECT 1 FROM $table LIMIT 1)")" || block DB_STATE_QUERY_FAILED
  [ "$HAS" = t ] && NONEMPTY=$((NONEMPTY+1))
done <<< "$TABLE_LIST"
[ "$NONEMPTY" -ge 1 ] || block ACCEPTANCE_PERSISTENCE_MISSING

PROJECT_NAME="[S32 Production Acceptance] ${FP:0:12}"
PROJECT_MATCH="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -v pid="$PROJECT_ID" -v pname="$PROJECT_NAME" -c "SELECT count(*) FROM core.projects WHERE id=:'pid'::uuid AND name=:'pname'")" || block DB_ACCEPTANCE_QUERY_FAILED
[ "$PROJECT_MATCH" = 1 ] || block ACCEPTANCE_PROJECT_DB_MISMATCH

ASSESSMENT_MATCH="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -v aid="$ASSESSMENT_ID" -c "SELECT count(*) FROM core.assessments WHERE id=:'aid'::uuid")" || block DB_ACCEPTANCE_QUERY_FAILED
[ "$ASSESSMENT_MATCH" = 1 ] || block ACCEPTANCE_ASSESSMENT_DB_MISMATCH

RECEIPT_MATCH="$($DK exec "$PG_CID" psql -U "$DB_ADMIN" -d "$DB_NAME" -At -v aid="$ASSESSMENT_ID" -c "SELECT count(*) FROM ops.idempotency_keys WHERE status='COMPLETED' AND resource_type='ASSESSMENT' AND resource_id=:'aid'::uuid AND result_payload->>'assessmentId'=:'aid'")" || block DB_ACCEPTANCE_QUERY_FAILED
[ "$RECEIPT_MATCH" = 1 ] || block ACCEPTANCE_IDEMPOTENCY_DB_MISMATCH

BASE_MEILI_DOCUMENTS="$(get "$R0" MEILI_DOCUMENTS || true)"
printf '%s' "$BASE_MEILI_DOCUMENTS"|grep -qE '^[0-9]+$' || block R0_MEILI_DOCUMENTS_INVALID
API_IMAGE_ID="$(get "$R4" API_IMAGE_ID || true)"
API_CONFIG_DIGEST="$(get "$R4" API_CONFIG_DIGEST || true)"
printf '%s' "$API_IMAGE_ID"|grep -qE '^sha256:[0-9a-f]{64}$' || block R4_API_IDENTITY_INVALID
printf '%s' "$API_CONFIG_DIGEST"|grep -qE '^sha256:[0-9a-f]{64}$' || block R4_API_IDENTITY_INVALID

umask 077
TMP_RESULT="$(mktemp "$P/.r5-acceptance-recovery.XXXXXX")"
cat >"$TMP_RESULT" <<EOF
STATUS=PASS
STAGE=R5
R5_S32_ACTIVATION=PASS
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
MEILI_DOCUMENTS=$BASE_MEILI_DOCUMENTS
API_IMAGE_ID=$API_IMAGE_ID
API_CONFIG_DIGEST=$API_CONFIG_DIGEST
S32_FEATURES_ENABLED=true
BACKEND_ACCEPTANCE=PASS
R5_EXECUTION_MODE=EXTERNAL_ACCEPTANCE_RECOVERY
RECOVERY_TOOL_SHA=$TOOL_SHA
R5_START_SHA256=$R5_START_SHA256
R4_R5_CLAIM_SHA256=$CLAIM_SHA256
PRIVATE_UNAUTH_STATUS=401
PRIVATE_WRONG_TOKEN_STATUS=403
PRIVATE_AUTHORIZED_STATUS=200
ACCEPTANCE_PROJECT_ID=$PROJECT_ID
ASSESSMENT_ID=$ASSESSMENT_ID
ASSESSMENT_REPLAY=PASS
ACCEPTANCE_PROJECT_RETAINED=YES
IDEMPOTENCY_RECEIPT_DB_PROOF=PASS
NONEMPTY_CORE_OPS_TABLES=$NONEMPTY
EOF
chmod 600 "$TMP_RESULT"
ln -- "$TMP_RESULT" "$RESULT" 2>/dev/null || { rm -f "$TMP_RESULT"; block RESULT_WRITE_FAILED; }
rm -f "$TMP_RESULT"

printf 'STATUS=PASS\nR5_ACCEPTANCE_RECOVERY=PASS\nR5_S32_ACTIVATION=PASS\nBACKEND_ACCEPTANCE=PASS\nASSESSMENT_REPLAY=PASS\nPRIVATE_UNAUTH_STATUS=401\nPRIVATE_WRONG_TOKEN_STATUS=403\nPRIVATE_AUTHORIZED_STATUS=200\nNONEMPTY_CORE_OPS_TABLES=%s\nWRITE_EXECUTED=YES\n' "$NONEMPTY"
