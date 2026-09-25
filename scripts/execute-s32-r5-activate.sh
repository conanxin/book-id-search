#!/usr/bin/env bash
set -euo pipefail
block(){ printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nR5_S32_ACTIVATION=BLOCKED\n' "$1"; exit 1; }
[ "$#" -eq 4 ] && [ "$1" = --execute-r5 ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"; SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"; ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"; R0="${S32_R0_RECEIPT:-$ROOT/progress/s32-r0.env}"; R4="$ROOT/progress/s32-rollout-${FP}-R4.result.env"; CLAIM="$ROOT/progress/s32-rollout-authorization-${FP}-R4_R5-claim.env"; MAN="${S32_RELEASE_MANIFEST_JSON:-$ROOT/progress/s32-release-manifest.json}"; PG_ENV="${S32_POSTGRES_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/postgres.env}"; API_ENV="${S32_API_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/api.env}"; START="$ROOT/progress/s32-rollout-${FP}-R5.start.env"; RESULT="$ROOT/progress/s32-rollout-${FP}-R5.result.env"
get(){ local f="$1" k="$2" n; n="$(grep -cE "^${k}=" "$f" 2>/dev/null||true)"; [ "$n" = 1 ] || return 1; grep -E "^${k}=" "$f"|head -1|cut -d= -f2-; }; secret(){ get "$API_ENV" "$1"; }
[ -f "$R0" ] && [ ! -L "$R0" ] || block R0_RECEIPT_MISSING
[ -f "$R4" ] && [ ! -L "$R4" ] || block R4_RECEIPT_MISSING
[ "$(get "$R4" R4_API_DARK || true)" = PASS ] && [ "$(get "$R4" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] || block R4_NOT_PASS
[ -f "$CLAIM" ] && [ ! -L "$CLAIM" ] && [ "$(stat -c '%a' "$CLAIM")" = 600 ] || block R4_R5_CLAIM_MISSING
[ "$(get "$CLAIM" STAGE_GROUP || true)" = R4_R5 ] && [ "$(get "$CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] && [ "$(get "$CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ] && [ "$(get "$CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ] || block R4_R5_CLAIM_MISMATCH
BASE_MEILI_DOCUMENTS="$(get "$R0" MEILI_DOCUMENTS || true)"; printf '%s' "$BASE_MEILI_DOCUMENTS" | grep -qE '^[0-9]+$' || block R0_MEILI_DOCUMENTS_INVALID
[ -f "$API_ENV" ] && [ ! -L "$API_ENV" ] && [ "$(stat -c '%a' "$API_ENV")" = 600 ] || block API_ENV_UNSAFE
[ -f "$PG_ENV" ] && [ ! -L "$PG_ENV" ] && [ "$(stat -c '%a' "$PG_ENV")" = 600 ] || block POSTGRES_ENV_UNSAFE
[ -f "$MAN" ] && [ ! -L "$MAN" ] || block RELEASE_MANIFEST_MISSING
[ ! -e "$START" ] && [ ! -e "$RESULT" ] || block INCOMPLETE_OR_TERMINAL_R5
MAN_OUT="$(python3 "$SCRIPT_DIR/s32-release-manifest.py" "$MAN" 2>&1)" || block RELEASE_MANIFEST_INVALID
MAN_FP="$(printf '%s\n' "$MAN_OUT"|awk -F= '$1=="S32_RELEASE_FINGERPRINT"{print $2;exit}')"
MAN_SRC="$(printf '%s\n' "$MAN_OUT"|awk -F= '$1=="SOURCE_SHA"{print $2;exit}')"
[ "$MAN_FP" = "$FP" ] && [ "$MAN_SRC" = "$SRC" ] || block RELEASE_MANIFEST_IDENTITY_MISMATCH
DBURL="$(secret S32_DATABASE_URL || true)"; TOKEN="$(secret S32_PRIVATE_API_TOKEN || true)"; [ -n "$DBURL" ] && [ -n "$TOKEN" ] || block API_ENV_CONTRACT_INVALID; printf '%s' "$DBURL"|grep -qE '^postgresql://s32_app:' || block API_DATABASE_ROLE_INVALID; printf '%s' "$DBURL"|grep -q '@postgres/book_id_search_s32' || block API_DATABASE_TARGET_INVALID
readarray -t M < <(python3 - "$MAN" <<'PY'
import json,sys;m=json.load(open(sys.argv[1]));print(m['apiImageTag']);print(m['apiImageId']);print(m['pgImageRef']);print(m['s32OverridePath'])
PY
); API_TAG="${M[0]}"; API_ID="${M[1]}"; PG_IMAGE="${M[2]}"; OVERRIDE="$ROOT/${M[3]}"
BASE_API_REV="$(get "$R0" API_REVISION)"; BASE_WEB_REV="$(get "$R0" WEB_REVISION)"; API_OVERRIDE="/opt/book-id-search-runtime/s31/${BASE_API_REV}/api-production.override.yml"; WEB_OVERRIDE="/opt/book-id-search-runtime/s32/${BASE_WEB_REV}/web-production.override.yml"
if [ "${S32_R4_R5_TEST_MODE:-false}" = true ]; then API_OVERRIDE="$ROOT/api-production.override.yml"; WEB_OVERRIDE="$ROOT/web-production.override.yml"; :>"$API_OVERRIDE"; :>"$WEB_OVERRIDE"; fi
umask 077; T="$(mktemp "$ROOT/progress/.r5-start.XXXXXX")"; printf 'STATUS=STARTED\nSTAGE=R5\nS32_RELEASE_FINGERPRINT=%s\n' "$FP">"$T"; chmod 600 "$T"; ln -- "$T" "$START"; rm -f "$T"
CMD=(docker compose --project-directory "$ROOT" --env-file "$PG_ENV" --env-file "$API_ENV" -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.override.yml" -f "$API_OVERRIDE" -f "$WEB_OVERRIDE" -f "$OVERRIDE" up -d --no-build --no-deps api)
if [ "${S32_R4_R5_TEST_MODE:-false}" = true ]; then printf 'S32_FEATURES_ENABLED=true S32_API_IMAGE=%s ' "$API_TAG" >>"${S32_R4_R5_COMMAND_LOG:?}"; printf '%q ' "${CMD[@]}" >>"$S32_R4_R5_COMMAND_LOG"; printf '\n' >>"$S32_R4_R5_COMMAND_LOG"; POST="${S32_R5_POST_FACTS_JSON:?}"; else sudo -n env S32_FEATURES_ENABLED=true "S32_API_IMAGE=$API_TAG" "S32_POSTGRES_IMAGE=$PG_IMAGE" "${CMD[@]}"; env S32_PRIVATE_API_TOKEN="$TOKEN" S32_RELEASE_FINGERPRINT="$FP" S32_ACCEPTANCE_BACKEND_ONLY=true pnpm s32:production:acceptance >/dev/null || block BACKEND_ACCEPTANCE_FAILED; POST="$(mktemp)"; python3 "$SCRIPT_DIR/plan-s32-production-baseline.py" --json-out "$POST" >/dev/null || block R5_POST_BASELINE_FAILED; fi
python3 - "$POST" "$API_ID" "$SRC" "$R0" <<'PY' || block R5_POSTVERIFY_FAILED
import json,sys
p=json.load(open(sys.argv[1])); a=p["services"]["api"]
if a.get("imageId")!=sys.argv[2] or a.get("revision")!=sys.argv[3]: raise SystemExit(1)
r={}
for line in open(sys.argv[4]):
 if "=" in line:
  k,v=line.rstrip("\n").split("=",1); r[k]=v
for svc,prefix in [("web","WEB"),("meilisearch","MEILISEARCH")]:
 s=p["services"].get(svc,{})
 for field,key in [("cid","CID"),("startedAt","STARTED_AT"),("imageId","IMAGE_ID")]:
  if s.get(field)!=r.get(prefix+"_"+key): raise SystemExit(1)
if p.get("httpStatus")!=200: raise SystemExit(1)
if p.get("postgresPresent") is not True: raise SystemExit(1)
required={"S32_FEATURES_ENABLED","S32_DATABASE_URL","S32_PRIVATE_API_TOKEN"}
if not required.issubset(set(p.get("s32EnvNames") or [])): raise SystemExit(1)
if str(p.get("stats",{}).get("numberOfDocuments")) != r.get("MEILI_DOCUMENTS"): raise SystemExit(1)
if p.get("stats",{}).get("isIndexing") is not False: raise SystemExit(1)
for key in ("ISBN","SSID","DXID","title","author","publisher"):
 if p.get("searches",{}).get(key,{}).get("status")!="PASS": raise SystemExit(1)
if "backendAcceptance" in p and p["backendAcceptance"]!="PASS": raise SystemExit(1)
PY
[ "${S32_R4_R5_TEST_MODE:-false}" = true ] || rm -f "$POST"
T="$(mktemp "$ROOT/progress/.r5-result.XXXXXX")"; printf 'STATUS=PASS\nSTAGE=R5\nR5_S32_ACTIVATION=PASS\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nMEILI_DOCUMENTS=%s\nAPI_IMAGE_ID=%s\nS32_FEATURES_ENABLED=true\nBACKEND_ACCEPTANCE=PASS\n' "$FP" "$SRC" "$BASE_MEILI_DOCUMENTS" "$API_ID">"$T"; chmod 600 "$T"; ln -- "$T" "$RESULT"; rm -f "$T"; printf 'STATUS=PASS\nR5_S32_ACTIVATION=PASS\nS32_FEATURES_ENABLED=true\n'
