#!/usr/bin/env bash
set -euo pipefail

block(){ printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\nR3_SCHEMA=BLOCKED\n' "$1"; exit 1; }
[ "$#" -eq 4 ] || block INVALID_ARGUMENTS
MODE="$1"; FP="$2"; SRC="$3"; CTRL="$4"
case "$MODE" in --execute-r3|--recover-role-only) ;; *) block INVALID_ARGUMENTS;; esac
printf '%s' "$FP"|grep -qE '^[0-9a-f]{64}$' || block INVALID_RELEASE_FINGERPRINT
printf '%s' "$SRC"|grep -qE '^[0-9a-f]{40}$' || block INVALID_SOURCE_SHA
printf '%s' "$CTRL"|grep -qE '^[0-9a-f]{40}$' || block INVALID_CONTROL_PLANE_SHA
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
R2="${S32_R2_RECEIPT:-$ROOT/progress/s32-rollout-${FP}-R2.result.env}"
CLAIM="$ROOT/progress/s32-rollout-authorization-${FP}-R2_R3-claim.env"
MANIFEST="${S32_RELEASE_MANIFEST_JSON:-$ROOT/progress/s32-release-manifest.json}"
PG_ENV="${S32_POSTGRES_ENV_FILE:-/opt/book-id-search-runtime/s32/${FP}/postgres.env}"
START="$ROOT/progress/s32-rollout-${FP}-R3.start.env"
PARTIAL="$ROOT/progress/s32-rollout-${FP}-R3.schema.env"
RESULT="$ROOT/progress/s32-rollout-${FP}-R3.result.env"
NEGATIVE_SQL="$ROOT/db/tests/002_s32_negative_invariants.sql" # Explicitly forbidden on production; disposable PG only.

get_kv(){ local f="$1" k="$2" n; n="$(grep -cE "^${k}=" "$f" 2>/dev/null||true)"; [ "$n" = 1 ] || return 1; grep -E "^${k}=" "$f"|head -1|cut -d= -f2-; }
get_secret(){ local k="$1" n; n="$(grep -cE "^${k}=" "$PG_ENV" 2>/dev/null||true)"; [ "$n" = 1 ] || return 1; grep -E "^${k}=" "$PG_ENV"|head -1|cut -d= -f2-; }
sha(){ sha256sum "$1"|awk '{print $1}'; }

[ -f "$R2" ] && [ ! -L "$R2" ] || block R2_RECEIPT_MISSING
[ "$(get_kv "$R2" R2_POSTGRES || true)" = PASS ] || block R2_NOT_PASS
[ "$(get_kv "$R2" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] || block R2_FINGERPRINT_MISMATCH
[ -f "$CLAIM" ] && [ ! -L "$CLAIM" ] && [ "$(stat -c '%a' "$CLAIM")" = 600 ] || block R2_R3_CLAIM_MISSING
[ "$(get_kv "$CLAIM" STAGE_GROUP || true)" = R2_R3 ] && [ "$(get_kv "$CLAIM" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] && [ "$(get_kv "$CLAIM" RELEASE_SOURCE_SHA || true)" = "$SRC" ] && [ "$(get_kv "$CLAIM" CONTROL_PLANE_SHA || true)" = "$CTRL" ] || block R2_R3_CLAIM_MISMATCH
[ -f "$MANIFEST" ] && [ ! -L "$MANIFEST" ] || block RELEASE_MANIFEST_MISSING
[ -f "$PG_ENV" ] && [ ! -L "$PG_ENV" ] && [ "$(stat -c '%a' "$PG_ENV")" = 600 ] || block POSTGRES_ENV_UNSAFE
[ ! -e "$RESULT" ] && [ ! -L "$RESULT" ] || block R3_ALREADY_TERMINAL

MAN_OUT="$(python3 "$SCRIPT_DIR/s32-release-manifest.py" "$MANIFEST" 2>&1)" || block RELEASE_MANIFEST_INVALID
[ "$(printf '%s\n' "$MAN_OUT"|awk -F= '$1=="S32_RELEASE_FINGERPRINT"{print $2;exit}')" = "$FP" ] || block RELEASE_MANIFEST_IDENTITY_MISMATCH
readarray -t MF < <(python3 - "$MANIFEST" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))
for k in ('migrationPath','migrationSha256','roleBootstrapPath','roleBootstrapSha256'): print(m[k])
PY
)
MIG="$ROOT/${MF[0]}"; MIG_SHA="${MF[1]}"; ROLE="$ROOT/${MF[2]}"; ROLE_SHA="${MF[3]}"
ASSERT="$ROOT/db/tests/001_s32_schema_assertions.sql"
[ -f "$MIG" ] && [ "$(sha "$MIG")" = "$MIG_SHA" ] || block MIGRATION_SHA_MISMATCH
[ -f "$ROLE" ] && [ "$(sha "$ROLE")" = "$ROLE_SHA" ] || block ROLE_BOOTSTRAP_SHA_MISMATCH
[ -f "$ASSERT" ] || block SCHEMA_ASSERTIONS_MISSING

DB="$(get_secret S32_POSTGRES_DB || true)"; ADMIN="$(get_secret S32_POSTGRES_USER || true)"; ADMIN_PASS="$(get_secret S32_POSTGRES_PASSWORD || true)"; APP_PASS="$(get_secret S32_APP_PASSWORD || true)"
[ "$DB" = book_id_search_s32 ] && [ "$ADMIN" = s32_admin ] && [ -n "$ADMIN_PASS" ] && [ -n "$APP_PASS" ] || block POSTGRES_SECRET_CONTRACT_INVALID

PG_CID=""
if [ "${S32_R3_TEST_MODE:-false}" != true ]; then
  PROJECT="${BOOK_ID_SEARCH_COMPOSE_PROJECT:-book-id-search}"
  mapfile -t PG_IDS < <(sudo -n docker ps \
    --filter "label=com.docker.compose.project=${PROJECT}" \
    --filter "label=com.docker.compose.service=postgres" \
    --format '{{.ID}}')
  [ "${#PG_IDS[@]}" -eq 1 ] || block POSTGRES_CONTAINER_IDENTITY_INVALID
  PG_CID="${PG_IDS[0]}"
  EXPECTED_PG_IMAGE_ID="$(get_kv "$R2" PG_IMAGE_ID || true)"
  ACTUAL_PG_IMAGE_ID="$(sudo -n docker inspect "$PG_CID" --format '{{.Image}}' 2>/dev/null)" || block POSTGRES_CONTAINER_IDENTITY_INVALID
  [ -n "$EXPECTED_PG_IMAGE_ID" ] && [ "$ACTUAL_PG_IMAGE_ID" = "$EXPECTED_PG_IMAGE_ID" ] || block POSTGRES_CONTAINER_IDENTITY_INVALID
  PG_HEALTH="$(sudo -n docker inspect "$PG_CID" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' 2>/dev/null)" || block POSTGRES_CONTAINER_IDENTITY_INVALID
  [ "$PG_HEALTH" = healthy ] || block POSTGRES_NOT_HEALTHY
fi

if [ "$MODE" = --recover-role-only ]; then
  [ -f "$PARTIAL" ] && [ ! -L "$PARTIAL" ] && [ "$(stat -c '%a' "$PARTIAL")" = 600 ] || block ROLE_RECOVERY_RECEIPT_MISSING
  [ "$(get_kv "$PARTIAL" SCHEMA_ASSERTIONS || true)" = PASS ] && [ "$(get_kv "$PARTIAL" S32_RELEASE_FINGERPRINT || true)" = "$FP" ] || block ROLE_RECOVERY_RECEIPT_INVALID
else
  [ ! -e "$START" ] && [ ! -L "$START" ] || block INCOMPLETE_R3
  if [ "${S32_R3_TEST_MODE:-false}" = true ]; then
    [ "${S32_R3_FAKE_SCHEMA_PRESENT:-false}" != true ] || block SCHEMA_STATE_UNKNOWN
  else
    COUNT="$(sudo -n docker exec -i "$PG_CID" psql -X -U "$ADMIN" -d "$DB" -Atc "SELECT count(*) FROM pg_namespace WHERE nspname IN ('core','ops','derived')")" || block SCHEMA_PREFLIGHT_FAILED
    [ "$COUNT" = 0 ] || block SCHEMA_STATE_UNKNOWN
  fi
  umask 077; T="$(mktemp "$ROOT/progress/.r3-start.XXXXXX")"; printf 'STATUS=STARTED\nSTAGE=R3\nS32_RELEASE_FINGERPRINT=%s\n' "$FP" >"$T"; chmod 600 "$T"; ln -- "$T" "$START" 2>/dev/null || { rm -f "$T"; block INCOMPLETE_R3; }; rm -f "$T"
fi

log(){ [ -n "${S32_R3_COMMAND_LOG:-}" ] && printf '%s\n' "$1" >>"$S32_R3_COMMAND_LOG" || true; }
if [ "$MODE" = --execute-r3 ]; then
  log MIGRATION
  if [ "${S32_R3_TEST_MODE:-false}" = true ]; then
    [ "${S32_R3_FAKE_MIGRATION_EXIT:-0}" = 0 ] || block MIGRATION_FAILED
  else
    cat "$MIG" | sudo -n docker exec -i "$PG_CID" psql -X -v ON_ERROR_STOP=1 -U "$ADMIN" -d "$DB" >/dev/null || block MIGRATION_FAILED
  fi
  log SCHEMA_ASSERTIONS
  if [ "${S32_R3_TEST_MODE:-false}" = true ]; then
    if [ "${S32_R3_FAKE_ASSERTION_EXIT:-0}" != 0 ]; then block SCHEMA_INTEGRITY_INCIDENT; fi
  else
    cat "$ASSERT" | sudo -n docker exec -i "$PG_CID" psql -X -v ON_ERROR_STOP=1 -U "$ADMIN" -d "$DB" >/dev/null || block SCHEMA_INTEGRITY_INCIDENT
  fi
  umask 077; P="$(mktemp "$ROOT/progress/.r3-schema.XXXXXX")"; printf 'STATUS=PASS\nSTAGE=R3_SCHEMA\nS32_RELEASE_FINGERPRINT=%s\nMIGRATION_SHA256=%s\nSCHEMA_ASSERTIONS=PASS\n' "$FP" "$MIG_SHA" >"$P"; chmod 600 "$P"; ln -- "$P" "$PARTIAL" 2>/dev/null || { rm -f "$P"; block PARTIAL_RECEIPT_WRITE_FAILED; }; rm -f "$P"
fi

log ROLE_BOOTSTRAP
if [ "${S32_R3_TEST_MODE:-false}" = true ]; then
  if [ "${S32_R3_FAKE_ROLE_EXIT:-0}" != 0 ]; then block ROLE_BOOTSTRAP_FAILED; fi
else
  { printf '\\set db_name %s\n\\set app_role %s\n\\set app_password %s\n' "$DB" s32_app "$APP_PASS"; cat "$ROLE"; } | sudo -n docker exec -i "$PG_CID" psql -X -v ON_ERROR_STOP=1 -U "$ADMIN" -d "$DB" >/dev/null || block ROLE_BOOTSTRAP_FAILED
  FLAGS="$(sudo -n docker exec -i "$PG_CID" psql -X -U "$ADMIN" -d "$DB" -Atc "SELECT rolsuper::int||','||rolcreaterole::int||','||rolcreatedb::int||','||rolreplication::int FROM pg_roles WHERE rolname='s32_app'")" || block ROLE_VERIFY_FAILED
  [ "$FLAGS" = 0,0,0,0 ] || block ROLE_VERIFY_FAILED
fi

log EMPTY_BASELINE
if [ "${S32_R3_TEST_MODE:-false}" = true ]; then
  [ "${S32_R3_FAKE_EMPTY_EXIT:-0}" = 0 ] || block EMPTY_BASELINE_FAILED
else
  cat <<'SQL' | sudo -n docker exec -i "$PG_CID" psql -X -v ON_ERROR_STOP=1 -U "$ADMIN" -d "$DB" >/dev/null || block EMPTY_BASELINE_FAILED
DO $$
DECLARE r record; n bigint;
BEGIN
 FOR r IN SELECT schemaname, tablename FROM pg_tables WHERE schemaname IN ('core','ops') LOOP
  EXECUTE format('SELECT count(*) FROM %I.%I', r.schemaname, r.tablename) INTO n;
  IF n <> 0 THEN RAISE EXCEPTION 'S32_EMPTY_BASELINE_FAIL: %.% has % rows', r.schemaname, r.tablename, n; END IF;
 END LOOP;
END $$;
SQL
fi

umask 077; T="$(mktemp "$ROOT/progress/.r3-result.XXXXXX")"; printf 'STATUS=PASS\nSTAGE=R3\nR3_SCHEMA=PASS\nS32_RELEASE_FINGERPRINT=%s\nMIGRATION_SHA256=%s\nROLE_BOOTSTRAP_SHA256=%s\nSCHEMA_ASSERTIONS=PASS\nEMPTY_BASELINE=PASS\n' "$FP" "$MIG_SHA" "$ROLE_SHA" >"$T"; chmod 600 "$T"; ln -- "$T" "$RESULT" 2>/dev/null || { rm -f "$T"; block RESULT_WRITE_FAILED; }; rm -f "$T"
printf 'STATUS=PASS\nR3_SCHEMA=PASS\nS32_RELEASE_FINGERPRINT=%s\nSCHEMA_ASSERTIONS=PASS\nEMPTY_BASELINE=PASS\n' "$FP"
