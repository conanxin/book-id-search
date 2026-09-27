#!/usr/bin/env bash
set -euo pipefail

# Complete an INCOMPLETE R5 whose API is already active. This tool performs
# no container mutation. It verifies the active runtime, runs production-safe
# HTTP acceptance with Python stdlib, proves persistence, and only then writes
# the missing canonical R5 terminal result.

block(){
  printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nWRITE_EXECUTED=%s\n' "$1" "${2:-NO}"
  exit 1
}

[ "$#" -eq 6 ] && [ "$1" = "--recover-r5-active" ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"; FAILED_TOOL_SHA="$5"; RECOVERY_TOOL_SHA="$6"
for v in "$SRC" "$CTRL" "$FAILED_TOOL_SHA" "$RECOVERY_TOOL_SHA"; do
  printf '%s' "$v"|grep -qE '^[0-9a-f]{40}$' || block INVALID_SHA
done
printf '%s' "$FP"|grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT

ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
P="$ROOT/progress"
DK="${S32_R5_RECOVERY_DOCKER:-sudo -n docker}"
R0="${S32_R0_RECEIPT:-$P/s32-r0.env}"
R4="${S32_R4_RECEIPT:-$P/s32-rollout-${FP}-R4.result.env}"
AUTH="$P/s32-rollout-authorization-${FP}-R4_R5.env"
CLAIM="$P/s32-rollout-authorization-${FP}-R4_R5-claim.env"
START="$P/s32-rollout-${FP}-R5.start.env"
RESULT="$P/s32-rollout-${FP}-R5.result.env"
MAN="${S32_RELEASE_MANIFEST_JSON:-$P/s32-release-manifest.json}"
PG_ENV="${S32_POSTGRES_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/postgres.env}"
API_ENV="${S32_API_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/api.env}"

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

for f in "$R0" "$R4" "$AUTH" "$CLAIM" "$START" "$PG_ENV" "$API_ENV"; do
  regular600 "$f" || block REQUIRED_EVIDENCE_INVALID
done
[ -f "$MAN" ] && [ ! -L "$MAN" ] || block RELEASE_MANIFEST_MISSING
[ ! -e "$RESULT" ] && [ ! -L "$RESULT" ] || block R5_ALREADY_TERMINAL
[ "$(stat -c '%d:%i' "$AUTH")" = "$(stat -c '%d:%i' "$CLAIM")" ] || block R4_R5_CLAIM_NOT_SAME_INODE

[ "$(get "$R4" STATUS || true)" = PASS ]   && [ "$(get "$R4" STAGE || true)" = R4 ]   && [ "$(get "$R4" R4_API_DARK || true)" = PASS ]   && [ "$(get "$R4" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get "$R4" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   || block R4_NOT_PASS

[ "$(get "$CLAIM" STAGE_GROUP || true)" = R4_R5 ]   && [ "$(get "$CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get "$CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   && [ "$(get "$CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ]   || block R4_R5_CLAIM_MISMATCH
CLAIM_SHA256="$(sha256sum "$CLAIM"|cut -d' ' -f1)"

[ "$(get "$START" STATUS || true)" = STARTED ]   && [ "$(get "$START" STAGE || true)" = R5 ]   && [ "$(get "$START" S32_RELEASE_FINGERPRINT || true)" = "$FP" ]   && [ "$(get "$START" RELEASE_SOURCE_SHA || true)" = "$SRC" ]   && [ "$(get "$START" CONTROL_PLANE_SHA || true)" = "$CTRL" ]   && [ "$(get "$START" R4_R5_CLAIM_SHA256 || true)" = "$CLAIM_SHA256" ]   && [ "$(get "$START" EXTERNAL_TOOL_SHA || true)" = "$FAILED_TOOL_SHA" ]   || block R5_START_IDENTITY_MISMATCH
R5_START_SHA256="$(sha256sum "$START"|cut -d' ' -f1)"
API_ENV_SHA_PRE="$(sha256sum "$API_ENV"|cut -d' ' -f1)"

python3 - "$PG_ENV" "$API_ENV" <<'PY' || block API_ENV_CONTRACT_INVALID
import pathlib,re,sys,urllib.parse
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

MAN_OUT="$(python3 "$ROOT/scripts/s32-release-manifest.py" "$MAN" 2>&1)" || block RELEASE_MANIFEST_INVALID
[ "$(printf '%s\n' "$MAN_OUT"|awk -F= '$1=="S32_RELEASE_FINGERPRINT"{print $2;exit}')" = "$FP" ] || block RELEASE_MANIFEST_IDENTITY_MISMATCH
[ "$(printf '%s\n' "$MAN_OUT"|awk -F= '$1=="SOURCE_SHA"{print $2;exit}')" = "$SRC" ] || block RELEASE_MANIFEST_IDENTITY_MISMATCH
readarray -t MF < <(python3 - "$MAN" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
print(m['apiImageTag']); print(m['apiImageId']); print(m['apiOciRevision'])
PY
)
API_TAG="${MF[0]}"; API_CONFIG_DIGEST="${MF[1]}"; API_REV="${MF[2]}"
[ "$API_REV" = "$SRC" ] || block API_RELEASE_IDENTITY_MISMATCH

IMG_OUT="$(bash "$ROOT/scripts/verify-s32-local-image.sh" "$API_TAG" "$API_CONFIG_DIGEST" "$SRC" 2>&1)" || block API_RELEASE_IDENTITY_MISMATCH
API_OBSERVED_ID="$(printf '%s\n' "$IMG_OUT"|awk -F= '$1=="OBSERVED_IMAGE_ID"{print $2;exit}')"
[ "$API_OBSERVED_ID" = "$(get "$R4" API_IMAGE_ID || true)" ] || block API_RELEASE_IDENTITY_MISMATCH
[ "$API_CONFIG_DIGEST" = "$(get "$R4" API_CONFIG_DIGEST || true)" ] || block API_RELEASE_IDENTITY_MISMATCH

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT INT TERM
PRE="$TMPDIR/pre.json"; POST="$TMPDIR/post.json"
BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$ROOT/scripts/plan-s32-production-baseline.py" --json-out "$PRE" >/dev/null || block PRE_BASELINE_FAILED

API_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=api --format '{{.ID}}')"
MEILI_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=meilisearch --format '{{.ID}}')"
PG_CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=postgres --format '{{.ID}}')"
for cid in "$API_CID" "$MEILI_CID" "$PG_CID"; do
  [ "$(printf '%s\n' "$cid"|grep -c .)" = 1 ] && [ -n "$cid" ] || block CONTAINER_NOT_UNIQUE
done

API_RUNTIME_PRE="$($DK inspect "$API_CID" --format '{{.Id}}|{{.State.StartedAt}}|{{.Image}}')"
API_ENV_RUNTIME="$($DK inspect "$API_CID" --format '{{range .Config.Env}}{{println .}}{{end}}')"
count_key(){ printf '%s\n' "$1"|grep -cE "^$2=" || true; }
value_key(){ printf '%s\n' "$1"|grep -E "^$2="|head -1|cut -d= -f2-; }
[ "$(count_key "$API_ENV_RUNTIME" S32_FEATURES_ENABLED)" = 1 ] && [ "$(value_key "$API_ENV_RUNTIME" S32_FEATURES_ENABLED)" = true ] || block ACTIVE_RUNTIME_INVALID
[ "$(count_key "$API_ENV_RUNTIME" S32_DATABASE_URL)" = 1 ] && [ "$(value_key "$API_ENV_RUNTIME" S32_DATABASE_URL)" = "$(get "$API_ENV" S32_DATABASE_URL)" ] || block ACTIVE_RUNTIME_INVALID
[ "$(count_key "$API_ENV_RUNTIME" S32_PRIVATE_API_TOKEN)" = 1 ] && [ "$(value_key "$API_ENV_RUNTIME" S32_PRIVATE_API_TOKEN)" = "$(get "$API_ENV" S32_PRIVATE_API_TOKEN)" ] || block ACTIVE_RUNTIME_INVALID

python3 - "$PRE" "$R0" "$R4" <<'PY' || block ACTIVE_BASELINE_INVALID
import json,sys
p=json.load(open(sys.argv[1])); r0={}; r4={}
for path,target in ((sys.argv[2],r0),(sys.argv[3],r4)):
    for line in open(path):
        if "=" in line:
            k,v=line.rstrip("\n").split("=",1); target[k]=v
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

PG_PRE="$($DK inspect "$PG_CID" --format '{{.Id}}|{{.State.StartedAt}}|{{.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}|{{json .Mounts}}')"
[ "$(printf '%s' "$PG_PRE"|cut -d'|' -f4)" = healthy ] || block POSTGRES_NOT_HEALTHY
[ -z "$($DK port "$PG_CID" 2>/dev/null||true)" ] || block POSTGRES_PUBLIC_PORT_PRESENT

DB_NAME="$(get "$PG_ENV" S32_POSTGRES_DB || true)"
DB_ADMIN="$(get "$PG_ENV" S32_POSTGRES_USER || true)"
APP_PASSWORD="$(get "$PG_ENV" S32_APP_PASSWORD || true)"
[ "$DB_NAME" = book_id_search_s32 ] && [ "$DB_ADMIN" = s32_admin ] && [ -n "$APP_PASSWORD" ] || block POSTGRES_ENV_CONTRACT_INVALID
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
  [ "$HAS" = t ] && NONEMPTY_PRE=$((NONEMPTY_PRE+1))
done <<< "$TABLE_LIST"
[ "$NONEMPTY_PRE" = 0 ] || block PRE_RECOVERY_DB_NOT_EMPTY

APP_USER="$($DK exec -e "PGPASSWORD=$APP_PASSWORD" "$PG_CID" psql -U s32_app -d "$DB_NAME" -At -c 'SELECT current_user')" || block S32_APP_CONNECT_FAILED
[ "$APP_USER" = s32_app ] || block S32_APP_CONNECT_FAILED
unset APP_PASSWORD

ACCEPT="$(
python3 - "$API_ENV" "$FP" <<'PY'
import hashlib,json,os,pathlib,secrets,sys,urllib.error,urllib.parse,urllib.request

api_env={}
for raw in pathlib.Path(sys.argv[1]).read_text().splitlines():
    if not raw: continue
    k,v=raw.split("=",1)
    if k in api_env: raise SystemExit("duplicate api env key")
    api_env[k]=v
token=api_env.get("S32_PRIVATE_API_TOKEN","")
if not token: raise SystemExit("token missing")
fp=sys.argv[2]
base=os.environ.get("S32_R5_RECOVERY_HTTP_BASE","http://127.0.0.1:3001").rstrip("/")
private=base+"/api/private/s32"

def request(method,url,body=None,headers=None,expected=(200,)):
    data=None
    h=dict(headers or {})
    if body is not None:
        data=json.dumps(body,separators=(",",":")).encode()
        h["content-type"]="application/json"
    req=urllib.request.Request(url,data=data,headers=h,method=method)
    try:
        with urllib.request.urlopen(req,timeout=8) as resp:
            status=resp.status
            raw=resp.read()
    except urllib.error.HTTPError as e:
        status=e.code
        raw=e.read()
    if status not in expected:
        raise SystemExit(f"HTTP_{status}")
    if not raw:
        return status,None
    try:
        return status,json.loads(raw)
    except Exception:
        raise SystemExit("INVALID_JSON")

def auth(extra=None):
    h={"Authorization":"Bearer "+token}
    if extra: h.update(extra)
    return h

def deterministic_uuid(seed):
    chars=list(hashlib.sha256(seed.encode()).hexdigest()[:32])
    chars[12]="4"
    chars[16]=format((int(chars[16],16)&0x3)|0x8,"x")
    x="".join(chars)
    return f"{x[:8]}-{x[8:12]}-{x[12:16]}-{x[16:20]}-{x[20:]}"

# Security semantics.
unauth,_=request("GET",private+"/projects",expected=(401,))
wrong=secrets.token_hex(32)
while wrong==token: wrong=secrets.token_hex(32)
wrong_status,_=request("GET",private+"/projects",headers={"Authorization":"Bearer "+wrong},expected=(403,))
good_status,_=request("GET",private+"/projects",headers=auth(),expected=(200,))

# Legacy regression and catalog seed.
probes=[
 ("isbn","9787538455250"),("ssid","13000000"),("dxid","000008232537"),
 ("title","时尚秋冬披肩"),("author","鲁迅"),("publisher","人民文学出版社")
]
catalog_id=None
for kind,value in probes:
    _,obj=request("GET",base+"/api/search?"+urllib.parse.urlencode({"q":value}),expected=(200,))
    items=obj.get("items") if isinstance(obj,dict) else None
    if not isinstance(items,list) or not items: raise SystemExit("LEGACY_SEARCH_FAILED_"+kind.upper())
    if kind=="isbn":
        candidate=items[0].get("id") if isinstance(items[0],dict) else None
        if not isinstance(candidate,str) or not candidate.strip(): raise SystemExit("CATALOG_ID_MISSING")
        catalog_id=candidate.strip()
_,stats=request("GET",base+"/api/stats",expected=(200,))
if stats.get("numberOfDocuments")!=5115734 or stats.get("isIndexing") is not False: raise SystemExit("MEILI_DRIFT")

short=fp[:12]
project_name=f"[S32 Production Acceptance] {short}"
_,projects=request("GET",private+"/projects",headers=auth(),expected=(200,))
project=next((p for p in projects.get("projects",[]) if p.get("name")==project_name),None)
if project is None:
    _,created=request("POST",private+"/projects",{"name":project_name,"description":"S32 production acceptance audit fixture."},auth(),(201,))
    project=created["project"]
project_id=str(project["id"])

_,promoted=request("POST",private+f"/projects/{urllib.parse.quote(project_id)}/catalog-books",{"bookId":catalog_id},auth(),(200,201))
binding_id=str(promoted["item"]["bindingId"])

note_path=private+f"/projects/{urllib.parse.quote(project_id)}/items/{urllib.parse.quote(binding_id)}/note"
_,note=request("GET",note_path,headers=auth(),expected=(200,))
if not note.get("note"):
    request("POST",note_path,{"content":f"Production acceptance note {short}."},auth(),(201,))

issue_title=f"[Acceptance] {short}"
issues_path=private+f"/projects/{urllib.parse.quote(project_id)}/issues"
_,issues=request("GET",issues_path,headers=auth(),expected=(200,))
issue=next((x for x in issues.get("issues",[]) if x.get("title")==issue_title),None)
if issue is None:
    key=deterministic_uuid(f"s32-issue:{fp}:{project_id}")
    _,created=request("POST",issues_path,{"title":issue_title,"question":"Does the production S32 vertical slice persist correctly?"},auth({"Idempotency-Key":key}),(200,201))
    issue=created["issue"]
issue_id=str(issue["id"])

claim_statement=f"Production acceptance claim {short}."
claims_path=private+f"/projects/{urllib.parse.quote(project_id)}/issues/{urllib.parse.quote(issue_id)}/claims"
_,claims=request("GET",claims_path,headers=auth(),expected=(200,))
claim=next((x for x in claims.get("claims",[]) if x.get("statement")==claim_statement),None)
if claim is None:
    key=deterministic_uuid(f"s32-claim:{fp}:{project_id}:{issue_id}")
    _,created=request("POST",claims_path,{"statement":claim_statement},auth({"Idempotency-Key":key}),(200,201))
    claim=created["claim"]
claim_id=str(claim["id"])

claim_base=private+f"/projects/{urllib.parse.quote(project_id)}/issues/{urllib.parse.quote(issue_id)}/claims/{urllib.parse.quote(claim_id)}"
_,candidates=request("GET",claim_base+"/evidence-candidates",headers=auth(),expected=(200,))
candidate=(candidates.get("candidates") or [None])[0]
if not isinstance(candidate,dict) or not candidate.get("targetType") or not candidate.get("targetId"):
    raise SystemExit("EVIDENCE_CANDIDATE_MISSING")
items=[{"role":"SUPPORTING","targetType":candidate["targetType"],"targetId":candidate["targetId"],"note":None}]
_,preview=request("POST",claim_base+"/evidence-manifest-preview",{"items":items},auth(),(200,))
manifest_hash=((preview.get("draft") or {}).get("manifestSha256"))
if not isinstance(manifest_hash,str) or len(manifest_hash)!=64: raise SystemExit("PREVIEW_HASH_INVALID")

assessments=claim_base+"/assessments"
idempotency=deterministic_uuid(f"s32-production-acceptance:{fp}:{claim_id}:{manifest_hash}")
payload={
 "stance":"SUPPORTS","confidenceLevel":"HIGH",
 "reasoning":f"Production acceptance assessment {short}.",
 "expectedManifestSha256":manifest_hash,"items":items
}
headers=auth({"Idempotency-Key":idempotency})
first_status,first=request("POST",assessments,payload,headers,(200,201))
first_id=str(first["assessment"]["id"])
replay_status,replay=request("POST",assessments,payload,headers,(200,))
assessment_id=str(replay["assessment"]["id"])
if first_id!=assessment_id: raise SystemExit("ASSESSMENT_REPLAY_IDENTITY_MISMATCH")
_,detail=request("GET",assessments+"/"+urllib.parse.quote(assessment_id),headers=auth(),expected=(200,))
if str((detail.get("assessment") or {}).get("id"))!=assessment_id: raise SystemExit("ASSESSMENT_DETAIL_MISMATCH")

print("STATUS=PASS")
print("PROJECT_ID="+project_id)
print("ASSESSMENT_ID="+assessment_id)
print("LEGACY_SEARCH_REGRESSION=PASS")
print("ASSESSMENT_REPLAY=PASS")
print("S32_BACKEND_ACCEPTANCE=PASS")
print("MEILI_DOCUMENTS=5115734")
print("ACCEPTANCE_PROJECT_RETAINED=YES")
print("PRIVATE_UNAUTH_STATUS="+str(unauth))
print("PRIVATE_WRONG_TOKEN_STATUS="+str(wrong_status))
print("PRIVATE_AUTHORIZED_STATUS="+str(good_status))
PY
)" || block HTTP_ACCEPTANCE_FAILED YES

[ "$(getout "$ACCEPT" STATUS || true)" = PASS ] || block HTTP_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" LEGACY_SEARCH_REGRESSION || true)" = PASS ] || block HTTP_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" ASSESSMENT_REPLAY || true)" = PASS ] || block HTTP_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" S32_BACKEND_ACCEPTANCE || true)" = PASS ] || block HTTP_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" MEILI_DOCUMENTS || true)" = 5115734 ] || block HTTP_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" ACCEPTANCE_PROJECT_RETAINED || true)" = YES ] || block HTTP_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" PRIVATE_UNAUTH_STATUS || true)" = 401 ] || block HTTP_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" PRIVATE_WRONG_TOKEN_STATUS || true)" = 403 ] || block HTTP_ACCEPTANCE_FAILED YES
[ "$(getout "$ACCEPT" PRIVATE_AUTHORIZED_STATUS || true)" = 200 ] || block HTTP_ACCEPTANCE_FAILED YES
PROJECT_ID="$(getout "$ACCEPT" PROJECT_ID || true)"
ASSESSMENT_ID="$(getout "$ACCEPT" ASSESSMENT_ID || true)"
[ -n "$PROJECT_ID" ] && [ -n "$ASSESSMENT_ID" ] || block HTTP_ACCEPTANCE_FAILED YES

BOOK_ID_SEARCH_REPO_ROOT="$ROOT" python3 "$ROOT/scripts/plan-s32-production-baseline.py" --json-out "$POST" >/dev/null || block POST_BASELINE_FAILED YES

API_RUNTIME_POST="$($DK inspect "$API_CID" --format '{{.Id}}|{{.State.StartedAt}}|{{.Image}}')"
[ "$API_RUNTIME_POST" = "$API_RUNTIME_PRE" ] || block API_RUNTIME_DRIFT YES
PG_POST="$($DK inspect "$PG_CID" --format '{{.Id}}|{{.State.StartedAt}}|{{.Image}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}|{{json .Mounts}}')"
[ "$PG_POST" = "$PG_PRE" ] || block POSTGRES_RUNTIME_DRIFT YES
[ -z "$($DK port "$PG_CID" 2>/dev/null||true)" ] || block POSTGRES_PUBLIC_PORT_PRESENT YES

python3 - "$PRE" "$POST" <<'PY' || block SERVICE_RUNTIME_DRIFT YES
import json,sys
a=json.load(open(sys.argv[1])); b=json.load(open(sys.argv[2]))
for svc in ("web","api","meilisearch"):
    x=a["services"][svc]; y=b["services"][svc]
    for field in ("cid","startedAt","imageId","revision"):
        if x.get(field)!=y.get(field): raise SystemExit(1)
if b.get("httpStatus")!=200: raise SystemExit(1)
if b.get("stats",{}).get("numberOfDocuments")!=5115734 or b.get("stats",{}).get("isIndexing") is not False: raise SystemExit(1)
for key in ("ISBN","SSID","DXID","title","author","publisher"):
    if b.get("searches",{}).get(key,{}).get("status")!="PASS": raise SystemExit(1)
PY

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
[ "$NONEMPTY_POST" -ge 1 ] || block PERSISTENCE_NOT_OBSERVED YES

[ "$(sha256sum "$API_ENV"|cut -d' ' -f1)" = "$API_ENV_SHA_PRE" ] || block API_ENV_DRIFT YES
[ "$(sha256sum "$START"|cut -d' ' -f1)" = "$R5_START_SHA256" ] || block R5_START_DRIFT YES
[ "$(sha256sum "$CLAIM"|cut -d' ' -f1)" = "$CLAIM_SHA256" ] || block CLAIM_DRIFT YES
[ "$(stat -c '%d:%i' "$AUTH")" = "$(stat -c '%d:%i' "$CLAIM")" ] || block R4_R5_CLAIM_NOT_SAME_INODE YES

TMP_RESULT="$(mktemp "$P/.r5-recovery-result.XXXXXX")"
cat >"$TMP_RESULT" <<EOF
STATUS=PASS
STAGE=R5
R5_S32_ACTIVATION=PASS
S32_RELEASE_FINGERPRINT=$FP
RELEASE_SOURCE_SHA=$SRC
MEILI_DOCUMENTS=5115734
API_IMAGE_ID=$API_OBSERVED_ID
API_CONFIG_DIGEST=$API_CONFIG_DIGEST
S32_FEATURES_ENABLED=true
BACKEND_ACCEPTANCE=PASS
R5_RECOVERY_MODE=ACTIVE_RUNTIME_ACCEPTANCE_ONLY
FAILED_R5_TOOL_SHA=$FAILED_TOOL_SHA
RECOVERY_TOOL_SHA=$RECOVERY_TOOL_SHA
R5_START_SHA256=$R5_START_SHA256
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

printf 'STATUS=PASS\nR5_RECOVERY=ACTIVE_RUNTIME_ACCEPTANCE_ONLY_PASS\nR5_S32_ACTIVATION=PASS\nBACKEND_ACCEPTANCE=PASS\nASSESSMENT_REPLAY=PASS\nPRIVATE_UNAUTH_STATUS=401\nPRIVATE_WRONG_TOKEN_STATUS=403\nPRIVATE_AUTHORIZED_STATUS=200\nNONEMPTY_CORE_OPS_TABLES=%s\nWRITE_EXECUTED=YES\n' "$NONEMPTY_POST"
