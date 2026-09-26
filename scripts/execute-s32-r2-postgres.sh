#!/usr/bin/env bash
set -euo pipefail

block() {
  local reason="$1"
  printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nR2_POSTGRES=BLOCKED\n' "$reason"
  exit 1
}

[ "$#" -eq 4 ] && [ "$1" = "--execute-r2" ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"
printf '%s' "$FP" | grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC" | grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL" | grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
R0="${S32_R0_RECEIPT:-$ROOT/progress/s32-r0.env}"
R1="${S32_R1_RECEIPT:-$ROOT/progress/s32-r1.env}"
MANIFEST="${S32_RELEASE_MANIFEST_JSON:-$ROOT/progress/s32-release-manifest.json}"
PG_ENV="${S32_POSTGRES_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/postgres.env}"
PGDATA="${S32_PG_DATA_DIR:-/data/book-id-search/postgres_data}"
CLAIM="$ROOT/progress/s32-rollout-authorization-${FP}-R2_R3-claim.env"
START="$ROOT/progress/s32-rollout-${FP}-R2.start.env"
RESULT="$ROOT/progress/s32-rollout-${FP}-R2.result.env"

[ -f "$R0" ] && [ ! -L "$R0" ] || block R0_RECEIPT_MISSING
[ -f "$R1" ] && [ ! -L "$R1" ] || block R1_RECEIPT_MISSING
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || block RELEASE_MANIFEST_MISSING
[ -f "$CLAIM" ] && [ ! -L "$CLAIM" ] || block R2_R3_CLAIM_MISSING
[ "$(stat -c '%a' "$CLAIM")" = 600 ] || block R2_R3_CLAIM_UNSAFE_MODE
[ -f "$PG_ENV" ] && [ ! -L "$PG_ENV" ] || block POSTGRES_ENV_MISSING
[ "$(stat -c '%a' "$PG_ENV")" = 600 ] || block POSTGRES_ENV_UNSAFE_MODE

if [ -e "$RESULT" ] || [ -L "$RESULT" ]; then block R2_ALREADY_TERMINAL; fi
if [ -e "$START" ] || [ -L "$START" ]; then block INCOMPLETE_R2; fi
if [ -L "$PGDATA" ]; then block PGDATA_SYMLINK; fi
if [ -d "$PGDATA" ] && [ -n "$(find "$PGDATA" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]; then block PGDATA_NOT_EMPTY; fi
if [ -e "$PGDATA" ] && [ ! -d "$PGDATA" ]; then block PGDATA_NOT_DIRECTORY; fi

get_kv() {
  local file="$1" key="$2" count
  count="$(grep -cE "^${key}=" "$file" 2>/dev/null || true)"
  [ "$count" = 1 ] || return 1
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2-
}

[ "$(get_kv "$R0" R0_FINAL || true)" = PASS ] || block R0_NOT_PASS
CAPACITY="$(get_kv "$R1" CAPACITY_GATE || true)"
case "$CAPACITY" in PASS_PREFERRED) ;; PASS_HARD_ONLY)
  [ "$(get_kv "$CLAIM" CAPACITY_HARD_ONLY_ACCEPTED || true)" = true ] || block HARD_ONLY_NOT_ACCEPTED ;;
  *) block R1_CAPACITY_NOT_ACCEPTABLE ;;
esac
[ "$(get_kv "$R1" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] && [ "$(get_kv "$R1" RELEASE_SOURCE_SHA || true)" = "$SRC" ] || block CAPACITY_RELEASE_MISMATCH
BASE_MEILI_DOCUMENTS="$(get_kv "$R0" MEILI_DOCUMENTS || true)"
printf '%s' "$BASE_MEILI_DOCUMENTS" | grep -qE '^[0-9]+$' || block R0_MEILI_DOCUMENTS_INVALID
[ "$(get_kv "$CLAIM" STAGE_GROUP || true)" = R2_R3 ] || block R2_R3_CLAIM_MISMATCH
[ "$(get_kv "$CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] || block R2_R3_CLAIM_MISMATCH
[ "$(get_kv "$CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ] || block R2_R3_CLAIM_MISMATCH
[ "$(get_kv "$CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ] || block R2_R3_CLAIM_MISMATCH

MAN_OUT="$(python3 "$SCRIPT_DIR/s32-release-manifest.py" "$MANIFEST" 2>&1)" || block RELEASE_MANIFEST_INVALID
MAN_FP="$(printf '%s\n' "$MAN_OUT" | awk -F= '$1=="S32_RELEASE_FINGERPRINT"{print $2; exit}')"
MAN_SRC="$(printf '%s\n' "$MAN_OUT" | awk -F= '$1=="SOURCE_SHA"{print $2; exit}')"
[ "$MAN_FP" = "$FP" ] && [ "$MAN_SRC" = "$SRC" ] || block RELEASE_MANIFEST_IDENTITY_MISMATCH

readarray -t MAN_FIELDS < <(python3 - "$MANIFEST" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
for k in ('pgImageRef','pgImageId','apiImageTag','s32OverridePath'):
 print(str(m[k]))
PY
)
PG_IMAGE="${MAN_FIELDS[0]}"; PG_IMAGE_ID="${MAN_FIELDS[1]}"; FUTURE_API_IMAGE="${MAN_FIELDS[2]}"; OVERRIDE_REL="${MAN_FIELDS[3]}"
OVERRIDE="$ROOT/$OVERRIDE_REL"
[ -f "$OVERRIDE" ] || block S32_OVERRIDE_MISSING

BASE_API_IMAGE="$(get_kv "$R0" API_IMAGE || true)"; BASE_API_REV="$(get_kv "$R0" API_REVISION || true)"; BASE_WEB_REV="$(get_kv "$R0" WEB_REVISION || true)"
[ -n "$BASE_API_IMAGE" ] && [ -n "$BASE_API_REV" ] && [ -n "$BASE_WEB_REV" ] || block R0_RUNTIME_FIELDS_MISSING
API_OVERRIDE="/opt/book-id-search-runtime/s31/${BASE_API_REV}/api-production.override.yml"
WEB_OVERRIDE="/opt/book-id-search-runtime/s32/${BASE_WEB_REV}/web-production.override.yml"
if [ "${S32_R2_TEST_MODE:-false}" = true ]; then
  API_OVERRIDE="$ROOT/api-production.override.yml"; WEB_OVERRIDE="$ROOT/web-production.override.yml"
  : > "$API_OVERRIDE"; : > "$WEB_OVERRIDE"
fi

if [ "${S32_R2_TEST_MODE:-false}" = true ]; then
  PG_UID="${S32_R2_FAKE_PG_UID:?}"; PG_GID="${S32_R2_FAKE_PG_GID:?}"
  ACTUAL_PG_ID="$PG_IMAGE_ID"
  EXPECTED_MANIFEST_DIGEST="${PG_IMAGE##*@}"
else
  ACTUAL_PG_ID="$(sudo -n docker image inspect "$PG_IMAGE" --format '{{.Id}}' 2>/dev/null)" || block PG_IMAGE_NOT_LOCAL
  EXPECTED_MANIFEST_DIGEST="${PG_IMAGE##*@}"
  case "$ACTUAL_PG_ID" in
    "$PG_IMAGE_ID"|"$EXPECTED_MANIFEST_DIGEST") ;;
    *) block PG_IMAGE_ID_MISMATCH ;;
  esac
  REPO_DIGEST_PROOF="$(sudo -n docker image inspect "$PG_IMAGE" --format '{{join .RepoDigests " "}}' 2>/dev/null)" || block PG_IMAGE_REPODIGEST_MISMATCH
  DIGEST_SEEN=false
  for REF in $REPO_DIGEST_PROOF; do
    case "$REF" in *"$EXPECTED_MANIFEST_DIGEST") DIGEST_SEEN=true; break ;; esac
  done
  [ "$DIGEST_SEEN" = true ] || block PG_IMAGE_REPODIGEST_MISMATCH
  PG_UID="$(sudo -n docker run --rm --network none --pull never --entrypoint sh "$PG_IMAGE" -c 'id -u postgres')" || block PG_UID_LOOKUP_FAILED
  PG_GID="$(sudo -n docker run --rm --network none --pull never --entrypoint sh "$PG_IMAGE" -c 'id -g postgres')" || block PG_GID_LOOKUP_FAILED
fi

umask 077
TMP_START="$(mktemp "$ROOT/progress/.r2-start.XXXXXX")"
printf 'STATUS=STARTED\nSTAGE=R2\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\n' "$FP" "$SRC" "$CTRL" > "$TMP_START"
chmod 600 "$TMP_START"
ln -- "$TMP_START" "$START" 2>/dev/null || { rm -f "$TMP_START"; block INCOMPLETE_R2; }
rm -f "$TMP_START"

mkdir -p "$PGDATA"
chmod 700 "$PGDATA"
if [ "${S32_R2_TEST_MODE:-false}" != true ]; then sudo -n chown "$PG_UID:$PG_GID" "$PGDATA"; fi

# Every docker compose invocation that resolves the S32 override must carry
# the same interpolation variables. This is the exact R2-INCOMPLETE incident
# contract: both up and the later ps must see all three values.
compose_pg() {
  local -a compose_args
  compose_args=(compose --project-directory "$ROOT" --env-file "$PG_ENV"
    -f "$ROOT/docker-compose.yml" -f "$ROOT/docker-compose.override.yml"
    -f "$API_OVERRIDE" -f "$WEB_OVERRIDE" -f "$OVERRIDE" "$@")
  if [ "${S32_R2_TEST_MODE:-false}" = true ]; then
    {
      printf 'S32_POSTGRES_IMAGE=%s S32_API_IMAGE=%s S32_PG_DATA_DIR=%s ' "$PG_IMAGE" "$BASE_API_IMAGE" "$PGDATA"
      printf '%q ' "${compose_args[@]}"
      printf '\n'
    } >> "${S32_R2_COMMAND_LOG:?}"
    env "S32_POSTGRES_IMAGE=$PG_IMAGE" "S32_API_IMAGE=$BASE_API_IMAGE" "S32_PG_DATA_DIR=$PGDATA"       "${S32_R2_DOCKER_CMD:?}" "${compose_args[@]}"
  else
    sudo -n env "S32_POSTGRES_IMAGE=$PG_IMAGE" "S32_API_IMAGE=$BASE_API_IMAGE" "S32_PG_DATA_DIR=$PGDATA"       docker "${compose_args[@]}"
  fi
}

compose_pg up -d --no-build --no-deps postgres

POST_JSON="${S32_R2_POST_FACTS_JSON:-}"
TMP_POST=""
if [ -z "$POST_JSON" ]; then
  TMP_POST="$(mktemp)"; POST_JSON="$TMP_POST"
  python3 "$SCRIPT_DIR/plan-s32-production-baseline.py" --json-out "$POST_JSON" >/dev/null || block POST_R0_FAILED
fi
VERIFY_ERR="$(mktemp)"
if ! python3 - "$R0" "$POST_JSON" 2>"$VERIFY_ERR" <<'PY'
import json,sys
r0={}
for line in open(sys.argv[1]):
 if '=' in line:
  k,v=line.rstrip('\n').split('=',1); r0[k]=v
post=json.load(open(sys.argv[2]))
for svc,prefix in [('web','WEB'),('api','API'),('meilisearch','MEILISEARCH')]:
 s=post['services'][svc]
 for f,k in [('cid','CID'),('startedAt','STARTED_AT'),('imageId','IMAGE_ID')]:
  if s[f] != r0[f'{prefix}_{k}']: raise SystemExit('LEGACY_RUNTIME_DRIFT')
if post.get('httpStatus') != 200: raise SystemExit('PUBLIC_HTTP_FAILED')
if str(post.get('stats',{}).get('numberOfDocuments')) != r0.get('MEILI_DOCUMENTS'):
 raise SystemExit('MEILI_DOCUMENT_COUNT_DRIFT')
PY
then
  reason="$(tail -1 "$VERIFY_ERR")"
  rm -f "$VERIFY_ERR"
  block "${reason:-LEGACY_RUNTIME_DRIFT}"
fi
rm -f "$VERIFY_ERR"
[ -z "$TMP_POST" ] || rm -f "$TMP_POST"

CID="$(compose_pg ps -q postgres)"
[ -n "$CID" ] || block POSTGRES_CONTAINER_MISSING
if [ "${S32_R2_TEST_MODE:-false}" != true ]; then
  HEALTH="$(sudo -n docker inspect "$CID" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
  [ "$HEALTH" = healthy ] || block POSTGRES_NOT_HEALTHY
  PORTS="$(sudo -n docker port "$CID" 2>/dev/null || true)"; [ -z "$PORTS" ] || block POSTGRES_PUBLIC_PORT_PRESENT
fi

TMP_RESULT="$(mktemp "$ROOT/progress/.r2-result.XXXXXX")"
printf 'STATUS=PASS\nSTAGE=R2\nR2_POSTGRES=PASS\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nMEILI_DOCUMENTS=%s\nPG_IMAGE_ID=%s\nPG_MANIFEST_DIGEST=%s\nPGDATA=%s\nLEGACY_RUNTIME_UNCHANGED=PASS\n' "$FP" "$SRC" "$BASE_MEILI_DOCUMENTS" "$ACTUAL_PG_ID" "$EXPECTED_MANIFEST_DIGEST" "$PGDATA" > "$TMP_RESULT"
chmod 600 "$TMP_RESULT"
ln -- "$TMP_RESULT" "$RESULT" 2>/dev/null || { rm -f "$TMP_RESULT"; block RESULT_WRITE_FAILED; }
rm -f "$TMP_RESULT"
printf 'STATUS=PASS\nR2_POSTGRES=PASS\nS32_RELEASE_FINGERPRINT=%s\nLEGACY_RUNTIME_UNCHANGED=PASS\n' "$FP"
