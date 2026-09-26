#!/usr/bin/env bash
set -euo pipefail

# Verify-only recovery for an INCOMPLETE R2 (START exists, RESULT absent).
# This tool NEVER continues R2 execution: it proves the production side
# effects of R2 already completed successfully (container healthy on the
# exact image, PGDATA initialized, legacy runtime unchanged, no R3
# artifacts, no schema/role side effects), and its ONLY write is the
# atomic no-overwrite publication of the terminal R2 receipt.

block() {
  printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nWRITE_EXECUTED=%s\n' "$1" "${2:-NO}"
  exit 1
}

[ "$#" -eq 5 ] && [ "$1" = "--recover-r2-verify-only" ] || block INVALID_ARGUMENTS
FP="$2"; SRC="$3"; CTRL="$4"; RECOVERY_TOOL_SHA="$5"

printf '%s' "$FP" | grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC" | grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL" | grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA
printf '%s' "$RECOVERY_TOOL_SHA" | grep -qE '^[0-9a-f]{40}$' || block INVALID_RECOVERY_TOOL_SHA

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
# Docker prefix: production uses `sudo -n`; tests can override with a bare
# PATH-stubbed docker via S32_RECOVERY_DOCKER=docker.
DK="${S32_RECOVERY_DOCKER:-sudo -n docker}"
P="$ROOT/progress"
START="$P/s32-rollout-${FP}-R2.start.env"
RESULT="$P/s32-rollout-${FP}-R2.result.env"
R3_START="$P/s32-rollout-${FP}-R3.start.env"
R3_SCHEMA="$P/s32-rollout-${FP}-R3.schema.env"
R3_RESULT="$P/s32-rollout-${FP}-R3.result.env"
PGDATA="${S32_PGDATA_PATH:-/data/book-id-search/postgres_data}"
PG_IMAGE_REF="postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea"

get_kv() {
  local file="$1" key="$2" count
  count="$(grep -cE "^${key}=" "$file" 2>/dev/null || true)"
  [ "$count" = 1 ] || return 1
  grep -E "^${key}=" "$file" | head -1 | cut -d= -f2-
}

# --- §4 recovery preconditions ---------------------------------------------
[ "$(git -C "$ROOT" branch --show-current)" = main ] || block NOT_MAIN_BRANCH
[ "$(git -C "$ROOT" rev-parse HEAD)" = "$CTRL" ] || block PRODUCTION_HEAD_MISMATCH

[ -f "$START" ] && [ ! -L "$START" ] || block R2_RECOVERY_START_MISSING
[ "$(stat -c '%a' "$START")" = 600 ] || block R2_START_UNSAFE_MODE
if [ -e "$RESULT" ] || [ -L "$RESULT" ]; then block R2_ALREADY_TERMINAL; fi
for f in "$R3_START" "$R3_SCHEMA" "$R3_RESULT"; do
  [ ! -e "$f" ] && [ ! -L "$f" ] || block R3_ARTIFACT_PRESENT
done
R2_START_SHA256="$(sha256sum "$START" | cut -d' ' -f1)"

[ "$(get_kv "$START" STATUS)" = STARTED ] \
  && [ "$(get_kv "$START" STAGE)" = R2 ] \
  && [ "$(get_kv "$START" S32_RELEASE_FINGERPRINT)" = "$FP" ] \
  && [ "$(get_kv "$START" RELEASE_SOURCE_SHA)" = "$SRC" ] \
  && [ "$(get_kv "$START" CONTROL_PLANE_SHA)" = "$CTRL" ] \
  || block R2_START_IDENTITY_MISMATCH

# --- §5 canonical prerequisites --------------------------------------------
for f in "$P/s32-r0.env" "$P/s32-r1.env" "$P/s32-release-manifest.json"; do
  [ -f "$f" ] && [ ! -L "$f" ] && [ "$(stat -c '%a' "$f")" = 600 ] || block CANONICAL_ARTIFACT_INVALID
done
[ "$(get_kv "$P/s32-r1.env" CAPACITY_GATE)" = PASS_PREFERRED ] || block R1_NOT_PREFERRED
PGENV="${S32_POSTGRES_ENV_PATH:-/opt/book-id-search-runtime/s32/${FP}/postgres.env}"
[ -f "$PGENV" ] && [ ! -L "$PGENV" ] && [ "$(stat -c '%a' "$PGENV")" = 600 ] || block POSTGRES_ENV_INVALID

MANIFEST_OUT="$(python3 "$SCRIPT_DIR/s32-release-manifest.py" "$P/s32-release-manifest.json")" || block MANIFEST_INVALID
printf '%s\n' "$MANIFEST_OUT" | grep -q '^STATUS=PASS$' || block MANIFEST_INVALID
printf '%s\n' "$MANIFEST_OUT" | grep -q "^SOURCE_SHA=${SRC}$" || block MANIFEST_SOURCE_MISMATCH
printf '%s\n' "$MANIFEST_OUT" | grep -q "^S32_RELEASE_FINGERPRINT=${FP}$" || block MANIFEST_FP_MISMATCH
printf '%s\n' "$MANIFEST_OUT" | grep -q '^MANIFEST_VALIDATED=true$' || block MANIFEST_INVALID

CLAIM="$P/s32-rollout-authorization-${FP}-R2_R3-claim.env"
[ -f "$CLAIM" ] && [ ! -L "$CLAIM" ] && [ "$(stat -c '%a' "$CLAIM")" = 600 ] || block R2_R3_CLAIM_INVALID
[ "$(get_kv "$CLAIM" STAGE_GROUP)" = R2_R3 ] \
  && [ "$(get_kv "$CLAIM" S32_RELEASE_FINGERPRINT)" = "$FP" ] \
  && [ "$(get_kv "$CLAIM" RELEASE_SOURCE_SHA)" = "$SRC" ] \
  && [ "$(get_kv "$CLAIM" CONTROL_PLANE_SHA)" = "$CTRL" ] \
  && [ "$(get_kv "$CLAIM" CONSUMABLE_ONCE)" = true ] \
  || block R2_R3_CLAIM_MISMATCH

# --- §6 exact image ---------------------------------------------------------
EXPECTED_MANIFEST_DIGEST="${PG_IMAGE_REF##*@}"
MANIFEST_OUT2="$MANIFEST_OUT"
ACTUAL_PG_ID="$($DK image inspect "$PG_IMAGE_REF" --format '{{.Id}}' 2>/dev/null)" || block PG_IMAGE_NOT_LOCAL
# Backend-compatible identity: observed .Id may be the manifest's config
# digest (classic store) or the manifest digest itself (containerd store).
case "$ACTUAL_PG_ID" in
  "$EXPECTED_MANIFEST_DIGEST") ;;
  sha256:81bd698b4594e751a3269e4dcd3e03a4a0ec0daf7b72e7aa1abd43cce9887542) ;;
  *) block PG_IMAGE_ID_MISMATCH ;;
esac
REPODIGESTS="$($DK image inspect "$PG_IMAGE_REF" --format '{{json .RepoDigests}}')"
printf '%s' "$REPODIGESTS" | grep -q "$EXPECTED_MANIFEST_DIGEST" || block PG_IMAGE_REPODIGEST_MISMATCH

# --- §7 PGDATA --------------------------------------------------------------
[ -d "$PGDATA" ] && [ ! -L "$PGDATA" ] || block PGDATA_INVALID
[ "$(stat -c '%a' "$PGDATA")" = 700 ] || block PGDATA_MODE_INVALID
[ -n "$(ls -A "$PGDATA")" ] || block PGDATA_EMPTY

# --- §8 container identity (labels, not compose) ---------------------------
CID="$($DK ps --filter label=com.docker.compose.project=book-id-search --filter label=com.docker.compose.service=postgres --format '{{.ID}}')"
[ "$(printf '%s\n' "$CID" | grep -c .)" = 1 ] && [ -n "$CID" ] || block POSTGRES_CONTAINER_NOT_UNIQUE
HEALTH="$($DK inspect "$CID" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')"
[ "$HEALTH" = healthy ] || block POSTGRES_NOT_HEALTHY
CONTAINER_IMAGE="$($DK inspect "$CID" --format '{{.Image}}')"
[ "$CONTAINER_IMAGE" = "$ACTUAL_PG_ID" ] || block POSTGRES_IMAGE_BINDING_MISMATCH
PORTS="$($DK port "$CID" 2>/dev/null || true)"; [ -z "$PORTS" ] || block POSTGRES_PUBLIC_PORT_PRESENT

# --- §9 fresh legacy runtime baseline --------------------------------------
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
POST_JSON="${S32_RECOVERY_BASELINE_JSON:-$TMP/post.json}"
if [ "$POST_JSON" = "$TMP/post.json" ]; then
  python3 "$SCRIPT_DIR/plan-s32-production-baseline.py" --json-out "$POST_JSON" >/dev/null || block BASELINE_FAILED
fi
python3 - "$P/s32-r0.env" "$POST_JSON" <<'PY' || block LEGACY_RUNTIME_DRIFT
import json,sys
r0={}
for line in open(sys.argv[1]):
    if '=' in line:
        k,v=line.rstrip('\n').split('=',1); r0[k]=v
post=json.load(open(sys.argv[2]))
for svc,prefix in [('web','WEB'),('api','API'),('meilisearch','MEILISEARCH')]:
    s=post['services'][svc]
    for f,k in [('cid','CID'),('startedAt','STARTED_AT'),('imageId','IMAGE_ID')]:
        if s[f] != r0[f'{prefix}_{k}']: raise SystemExit(1)
if post.get('httpStatus') != 200: raise SystemExit(1)
if str(post.get('stats',{}).get('numberOfDocuments')) != '5115734': raise SystemExit(1)
PY

# --- §10 read-only pre-R3 DB state -----------------------------------------
DB_SSID="$($DK exec "$CID" psql -U s32_admin -d book_id_search_s32 -At -c \
  "SELECT count(*) FROM pg_namespace WHERE nspname IN ('core','ops','derived')")" || block DB_STATE_QUERY_FAILED
[ "$DB_SSID" = 0 ] || block S32_SCHEMA_NAMESPACE_PRESENT
ROLE_COUNT="$($DK exec "$CID" psql -U s32_admin -d book_id_search_s32 -At -c \
  "SELECT count(*) FROM pg_roles WHERE rolname='s32_app'")" || block DB_STATE_QUERY_FAILED
[ "$ROLE_COUNT" = 0 ] || block S32_APP_ROLE_PRESENT

# --- §11 terminal recovery receipt (the ONLY write) ------------------------
umask 077
TMP_RESULT="$(mktemp "$P/.r2-recovery.XXXXXX")"
printf 'STATUS=PASS\nSTAGE=R2\nR2_POSTGRES=PASS\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nMEILI_DOCUMENTS=5115734\nPG_IMAGE_ID=%s\nPG_MANIFEST_DIGEST=%s\nPGDATA=%s\nLEGACY_RUNTIME_UNCHANGED=PASS\nR2_RECOVERY_MODE=VERIFY_ONLY\nR2_START_SHA256=%s\nRECOVERY_TOOL_SHA=%s\n' \
  "$FP" "$SRC" "$ACTUAL_PG_ID" "$EXPECTED_MANIFEST_DIGEST" "$PGDATA" "$R2_START_SHA256" "$RECOVERY_TOOL_SHA" > "$TMP_RESULT"
chmod 600 "$TMP_RESULT"
ln -- "$TMP_RESULT" "$RESULT" 2>/dev/null || { rm -f "$TMP_RESULT"; block RESULT_WRITE_FAILED; }
rm -f "$TMP_RESULT"

printf 'STATUS=PASS\nR2_RECOVERY=VERIFY_ONLY_PASS\nS32_RELEASE_FINGERPRINT=%s\nRELEASE_SOURCE_SHA=%s\nCONTROL_PLANE_SHA=%s\nR2_START_SHA256=%s\nRECOVERY_TOOL_SHA=%s\nWRITE_EXECUTED=YES\n' "$FP" "$SRC" "$CTRL" "$R2_START_SHA256" "$RECOVERY_TOOL_SHA"
