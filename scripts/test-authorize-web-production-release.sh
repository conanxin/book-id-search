#!/usr/bin/env bash
# S27T-4A test harness for authorize-web-production-release.sh
#
# Level-1 only. No real sudo, no real Docker, no real Plan invocation.
# Builds an isolated /tmp harness with:
#   - exact-byte authorize + plan + deploy scripts
#   - fake plan script (controlled by FAKE_PLAN_* env vars)
# All destructive behavior fake. Authorization contract still verified.
#
# All artifacts are written under PROGRESS_DIR inside the isolated harness,
# never against the real /opt/book-id-search/progress.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTH="$REPO_ROOT/scripts/authorize-web-production-release.sh"
PLAN="$REPO_ROOT/scripts/plan-web-production-release.sh"
DEPLOY="$REPO_ROOT/scripts/deploy-web-release-candidate.sh"

[ -f "$AUTH" ]   || { echo "FATAL: authorize script not found"; exit 99; }
[ -f "$PLAN" ]   || { echo "FATAL: plan script not found"; exit 99; }
[ -f "$DEPLOY" ] || { echo "FATAL: deploy script not found"; exit 99; }

# -----------------------------------------------------------------------------
# S27T-4C-R1 minimal isolation hardening (same pattern as claim + orch).
# -----------------------------------------------------------------------------
RUN_ROOT="$(mktemp -d -t s27t4c-authorize.XXXXXX)"
TMP_ROOT="$RUN_ROOT/init"
mkdir -p "$TMP_ROOT"

cleanup_suite() {
  if [ -z "${RUN_ROOT:-}" ]; then return 0; fi
  case "$RUN_ROOT" in
    /tmp/s27t4c-authorize.*)
      rm -rf "$RUN_ROOT" 2>/dev/null || true
      ;;
    *)
      echo "FATAL cleanup_suite: refused to clean unexpected RUN_ROOT=$RUN_ROOT" >&2
      return 1
      ;;
  esac
}
trap 'cleanup_suite' EXIT INT TERM

PASS_COUNT=0
FAIL_COUNT=0
declare -a FAIL_DETAILS

assert_pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
assert_fail() {
  local name="$1" detail="$2"
  echo "FAIL: $name -- $detail"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAIL_DETAILS+=("$name: $detail")
}

# -----------------------------------------------------------------------------
# Build a fresh isolated harness with authorize + plan + deploy scripts.
# Each harness is its own git repo so the AUTHORIZE script's SOURCE_SHA
# validation (git -C $REPO_ROOT cat-file -e) succeeds.
# -----------------------------------------------------------------------------
make_harness() {
  local prefix="$1"
  local h
  # S27T-4C-R1: per-test harness root is a unique child of RUN_ROOT.
  h="$(mktemp -d "$RUN_ROOT/h-${prefix}-XXXXXX")"
  mkdir -p "$h/scripts" "$h/progress"
  cp "$AUTH"   "$h/scripts/authorize-web-production-release.sh"
  cp "$PLAN"   "$h/scripts/plan-web-production-release.sh"
  cp "$DEPLOY" "$h/scripts/deploy-web-release-candidate.sh"
  chmod +x "$h/scripts/authorize-web-production-release.sh"
  chmod +x "$h/scripts/plan-web-production-release.sh"
  chmod +x "$h/scripts/deploy-web-release-candidate.sh"
  # Strategy: create fresh git repo in harness, then FETCH the CANON_SHA
  # commit from TMP_ROOT into it. This makes CANON_SHA exist in the
  # harness object DB (satisfying git rev-parse checks) without changing
  # the harness HEAD (which can stay as its own commit for test isolation).
  git init -q "$h"
  git -C "$h" config user.email "t@t"
  git -C "$h" config user.name "t"
  git -C "$h" config commit.gpgsign false
  echo "harness" > "$h/README"
  git -C "$h" add -A >/dev/null 2>&1
  git -C "$h" commit -q -m "init" >/dev/null 2>&1
  # Fetch CANON_SHA commit (and its tree) into harness DB without touching HEAD
  git -C "$h" fetch -q "$TMP_ROOT" "$(git -C "$TMP_ROOT" rev-parse HEAD)" 2>/dev/null || true
  HARNESS="$h"
  echo "$h"
}

# -----------------------------------------------------------------------------
# Fake Plan script (FAKE_PLAN_* env vars drive output)
# -----------------------------------------------------------------------------
make_fake_plan() {
  cat > "$1" <<'FAKE_PLAN_EOF'
#!/usr/bin/env bash
# Test-driven fake plan script. Controlled by FAKE_PLAN_* env vars.
set -uo pipefail

if [ -n "${FAKE_PLAN_BLOCK_REASON:-}" ]; then
  printf 'STATUS=BLOCKED\n'
  printf 'BLOCK_REASON=%s\n' "$FAKE_PLAN_BLOCK_REASON"
  printf 'RELEASE_PLAN_READY=false\n'
  printf 'DEPLOY_EXECUTED=false\n'
  exit 1
fi

if [ "${FAKE_PLAN_NO_IDENTITY:-0}" = "1" ]; then
  printf 'STATUS=PASS\n'
  printf 'RELEASE_PLAN_VERSION=1\n'
  printf 'SOURCE_SHA=%s\n' "$CANON_SHA"
  printf 'IMAGE_TAG=%s\n' "book-id-search-web:test"
  # intentionally missing MANIFEST_SHA / LOCKFILE_SHA / FINGERPRINT
  printf 'READINESS_GATE=PASS\n'
  printf 'ISOLATED_E2E=PASS\n'
  printf 'PRODUCTION_UNCHANGED=PASS\n'
  printf 'RELEASE_PLAN_READY=true\n'
  printf 'DEPLOY_EXECUTED=false\n'
  exit 0
fi

if [ -n "${FAKE_PLAN_RAW_OUTPUT:-}" ]; then
  printf '%s\n' "$FAKE_PLAN_RAW_OUTPUT"
  exit 0
fi

# Default: success path with full identity
SRC="${FAKE_PLAN_SOURCE_SHA:-$1}"
TAG="${FAKE_PLAN_IMAGE_TAG:-book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af}"
IID="${FAKE_PLAN_IMAGE_ID:-sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce}"
MAN="${FAKE_PLAN_MANIFEST_SHA:-743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a}"
LKF="${FAKE_PLAN_LOCKFILE_SHA:-fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134}"

# If FAKE_PLAN_BAD_FINGERPRINT is set, emit a fingerprint that intentionally
# does NOT match the recomputed one (used to test fingerprint mismatch).
# If FAKE_PLAN_BAD_FINGERPRINT is set (non-empty), use it directly as the
# fingerprint (emits a value that will NOT match authorization's recompute).
# This assignment form (${var:-default}) uses default ONLY when var is unset.
FP="$(printf '%s\n%s\n%s\n%s\n%s\n' \
  "SOURCE_SHA=$SRC" "IMAGE_TAG=$TAG" "IMAGE_ID=$IID" \
  "MANIFEST_SHA=$MAN" "LOCKFILE_SHA=$LKF" \
  | sha256sum | awk '{print $1}')"
FAKE_PLAN_BAD_FINGERPRINT="${FAKE_PLAN_BAD_FINGERPRINT:-${FP}}"
FP="$FAKE_PLAN_BAD_FINGERPRINT"

printf 'STATUS=PASS\n'
printf 'RELEASE_PLAN_VERSION=1\n'
printf 'SOURCE_SHA=%s\n' "$SRC"
printf 'IMAGE_TAG=%s\n' "$TAG"
printf 'IMAGE_ID=%s\n' "$IID"
printf 'MANIFEST_SHA=%s\n' "$MAN"
printf 'LOCKFILE_SHA=%s\n' "$LKF"
printf 'RELEASE_PLAN_FINGERPRINT=%s\n' "$FP"
printf 'READINESS_GATE=%s\n' "${FAKE_PLAN_READINESS_GATE:-PASS}"
printf 'ISOLATED_E2E=PASS\n'
printf 'PRODUCTION_UNCHANGED=PASS\n'
printf 'RELEASE_PLAN_READY=%s\n' "${FAKE_PLAN_READY:-true}"
printf 'DEPLOY_EXECUTED=%s\n' "${FAKE_PLAN_DEPLOY_EXECUTED:-false}"
exit 0
FAKE_PLAN_EOF
  chmod +x "$1"
}

# -----------------------------------------------------------------------------
# Helper to invoke authorization in a harness
# -----------------------------------------------------------------------------
# FAKE_PLAN_OVERRIDES list: all env vars the fake plan may read.
# Tests set these with `export` in the outer shell; run_auth re-exports them
# so the inner subshell (which runs the fake plan) sees the same values.
FAKE_PLAN_OVERRIDES=(
  FAKE_PLAN_SOURCE_SHA
  FAKE_PLAN_IMAGE_TAG
  FAKE_PLAN_IMAGE_ID
  FAKE_PLAN_MANIFEST_SHA
  FAKE_PLAN_LOCKFILE_SHA
  FAKE_PLAN_BLOCK_REASON
  FAKE_PLAN_RAW_OUTPUT
  FAKE_PLAN_READY
  FAKE_PLAN_DEPLOY_EXECUTED
  FAKE_PLAN_READINESS_GATE
  FAKE_PLAN_NO_IDENTITY
  FAKE_PLAN_BAD_FINGERPRINT
)

run_auth() {
  local harness="$1"
  shift
  (
    cd "$harness" || exit 1
    export CANON_SHA="$CANON_SHA"
    local _v
    for _v in "${FAKE_PLAN_OVERRIDES[@]}"; do
      # Export only when set in caller; never force empty.
      if [ -n "${!_v+x}" ]; then
        export "$_v=${!_v}"
      else
        unset "$_v" 2>/dev/null || true
      fi
    done
    export PATH="$harness/scripts:/usr/bin:/bin"
    bash "$harness/scripts/authorize-web-production-release.sh" "$@"
  )
  return $?
}

cleanup_harness() {
  local h="$1"
  # S27T-4C-R1: explicit ownership.
  if [ -z "$h" ] || [ ! -d "$h" ]; then
    return 0
  fi
  case "$h" in
    "/"|"/tmp"|"/tmp/"|"$RUN_ROOT")
      echo "FATAL cleanup_harness: refused dangerous root '$h'" >&2
      return 1
      ;;
  esac
  case "$h" in
    "$RUN_ROOT"/*) ;;
    *)
      echo "FATAL cleanup_harness: '$h' is outside RUN_ROOT" >&2
      return 1
      ;;
  esac
  rm -rf "$h" 2>/dev/null || true
}

clear_test_env() {
  # Wipe all fake-plan overrides so each test starts clean.
  local _v
  for _v in "${FAKE_PLAN_OVERRIDES[@]}"; do
    unset "$_v" 2>/dev/null || true
  done
}

# Discover CANON_SHA from a fresh init repo (so it's a real commit object).
# TMP_ROOT now lives inside our own RUN_ROOT (set near script top).
mkdir -p "$TMP_ROOT/scripts"
cp "$AUTH"   "$TMP_ROOT/scripts/authorize-web-production-release.sh"
cp "$PLAN"   "$TMP_ROOT/scripts/plan-web-production-release.sh"
cp "$DEPLOY" "$TMP_ROOT/scripts/deploy-web-release-candidate.sh"
git init -q "$TMP_ROOT"
git -C "$TMP_ROOT" config user.email "t@t"
git -C "$TMP_ROOT" config user.name "t"
git -C "$TMP_ROOT" config commit.gpgsign false
echo "init" > "$TMP_ROOT/README"
git -C "$TMP_ROOT" add -A >/dev/null 2>&1
git -C "$TMP_ROOT" commit -q -m "init" >/dev/null 2>&1
CANON_SHA="$(git -C "$TMP_ROOT" rev-parse HEAD)"
export CANON_SHA

# =============================================================================
# Test 1 — no approval flag
# =============================================================================
clear_test_env
H="$(make_harness noflag)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=EXPLICIT_APPROVAL_REQUIRED' \
              && echo "$out" | grep -q 'PRODUCTION_DEPLOY_AUTHORIZED=false'; then
  assert_pass "no approval flag blocks with EXPLICIT_APPROVAL_REQUIRED"
else
  assert_fail "no approval flag blocks" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 2 — wrong approval flag
# =============================================================================
clear_test_env
H="$(make_harness wrongflag)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -qE 'BLOCK_REASON=(EXPLICIT_APPROVAL_REQUIRED|INVALID_ARGUMENTS)'; then
  assert_pass "wrong approval flag blocks"
else
  assert_fail "wrong approval flag blocks" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 3 — invalid SHA
# =============================================================================
clear_test_env
H="$(make_harness invsha)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "not-a-sha" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=INVALID_SOURCE_SHA'; then
  assert_pass "invalid SHA blocks with INVALID_SOURCE_SHA"
else
  assert_fail "invalid SHA blocks" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 4 — plan nonzero exit
# =============================================================================
clear_test_env
H="$(make_harness plannonzero)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_PLAN_BLOCK_REASON=READINESS_GATE_FAILED \
  out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_FAILED'; then
  assert_pass "plan nonzero exit → RELEASE_PLAN_FAILED"
else
  assert_fail "plan nonzero exit" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 5 — plan READY=false
# =============================================================================
clear_test_env
H="$(make_harness planreadyfalse)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_PLAN_READY=false \
  out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_NOT_READY'; then
  assert_pass "plan READY=false → RELEASE_PLAN_NOT_READY"
else
  assert_fail "plan READY=false" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 6 — missing Plan field (INCOMPLETE)
# =============================================================================
clear_test_env
H="$(make_harness incomplete)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_PLAN_NO_IDENTITY=1 \
  out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_OUTPUT_INCOMPLETE'; then
  assert_pass "missing Plan field → INCOMPLETE"
else
  assert_fail "missing Plan field" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 7 — duplicate Plan field (AMBIGUOUS)
# =============================================================================
clear_test_env
H="$(make_harness ambig)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_PLAN_RAW_OUTPUT="STATUS=PASS
RELEASE_PLAN_VERSION=1
SOURCE_SHA=$CANON_SHA
IMAGE_TAG=good
IMAGE_TAG=evil
IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a
LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134
RELEASE_PLAN_FINGERPRINT=0000000000000000000000000000000000000000000000000000000000000000
READINESS_GATE=PASS
ISOLATED_E2E=PASS
PRODUCTION_UNCHANGED=PASS
RELEASE_PLAN_READY=true
DEPLOY_EXECUTED=false" \
  out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_OUTPUT_AMBIGUOUS'; then
  assert_pass "duplicate IMAGE_TAG → AMBIGUOUS"
else
  assert_fail "duplicate IMAGE_TAG" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 8 — source mismatch
# =============================================================================
clear_test_env
H="$(make_harness srcmis)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
export FAKE_PLAN_SOURCE_SHA=0000000000000000000000000000000000000000
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=SOURCE_IDENTITY_MISMATCH'; then
  assert_pass "Plan SOURCE_SHA mismatch → SOURCE_IDENTITY_MISMATCH"
else
  assert_fail "Plan SOURCE_SHA mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 9 — fingerprint mismatch
# =============================================================================
clear_test_env
H="$(make_harness fpmis)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
export FAKE_PLAN_BAD_FINGERPRINT=0000000000000000000000000000000000000000000000000000000000000000
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_FINGERPRINT_MISMATCH'; then
  assert_pass "Plan fingerprint mismatch → RELEASE_PLAN_FINGERPRINT_MISMATCH"
else
  assert_fail "Plan fingerprint mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 10 — successful authorization
# =============================================================================
clear_test_env
H="$(make_harness success)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -eq 0 ] && echo "$out" | grep -q '^STATUS=PASS$' \
   && echo "$out" | grep -q 'EXPLICIT_APPROVAL=true' \
   && echo "$out" | grep -q 'CONSUMABLE_ONCE=true' \
   && echo "$out" | grep -q 'PRODUCTION_DEPLOY_AUTHORIZED=true' \
   && echo "$out" | grep -q 'PRODUCTION_DEPLOY_EXECUTED=false' \
   && echo "$out" | grep -qE '^AUTHORIZATION_ARTIFACT=.*/web-release-authorization-[0-9a-f]{64}\.env$'; then
  assert_pass "successful authorization (deterministic artifact path)"
else
  assert_fail "successful authorization" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 11 — artifact exists after PASS
# =============================================================================
clear_test_env
H="$(make_harness exists)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ARTIFACT="$(echo "$out" | grep -E '^AUTHORIZATION_ARTIFACT=' | head -1 | sed 's/^AUTHORIZATION_ARTIFACT=//')"
if [ -f "$ARTIFACT" ]; then
  assert_pass "artifact exists after PASS"
else
  assert_fail "artifact exists" "missing: $ARTIFACT"
fi
cleanup_harness "$H"

# =============================================================================
# Test 12 — artifact mode=600
# =============================================================================
clear_test_env
H="$(make_harness mode)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ARTIFACT="$(echo "$out" | grep -E '^AUTHORIZATION_ARTIFACT=' | head -1 | sed 's/^AUTHORIZATION_ARTIFACT=//')"
MODE=$(stat -c '%a' "$ARTIFACT" 2>/dev/null)
if [ "$MODE" = "600" ]; then
  assert_pass "artifact mode=600"
else
  assert_fail "artifact mode" "got=$MODE"
fi
cleanup_harness "$H"

# =============================================================================
# Test 13 — artifact fields exact
# =============================================================================
clear_test_env
H="$(make_harness fields)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ARTIFACT="$(echo "$out" | grep -E '^AUTHORIZATION_ARTIFACT=' | head -1 | sed 's/^AUTHORIZATION_ARTIFACT=//')"
miss=()
for k in AUTHORIZATION_VERSION AUTHORIZED_ACTION SOURCE_SHA RELEASE_PLAN_FINGERPRINT IMAGE_TAG IMAGE_ID MANIFEST_SHA LOCKFILE_SHA EXPLICIT_APPROVAL CONSUMABLE_ONCE PRODUCTION_DEPLOY_AUTHORIZED PRODUCTION_DEPLOY_EXECUTED; do
  if ! grep -qE "^${k}=" "$ARTIFACT"; then miss+=("$k"); fi
done
if [ ${#miss[@]} -eq 0 ]; then
  assert_pass "artifact fields exact"
else
  assert_fail "artifact fields" "missing=${miss[*]}"
fi
cleanup_harness "$H"

# =============================================================================
# Test 14 — deterministic artifact filename
# =============================================================================
clear_test_env
H="$(make_harness detname)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ARTIFACT="$(echo "$out" | grep -E '^AUTHORIZATION_ARTIFACT=' | head -1 | sed 's/^AUTHORIZATION_ARTIFACT=//')"
ARTIFACT_FP="$(grep -E '^RELEASE_PLAN_FINGERPRINT=' "$ARTIFACT" | head -1 | sed 's/^RELEASE_PLAN_FINGERPRINT=//')"
EXPECTED_NAME="web-release-authorization-${ARTIFACT_FP}.env"
ACTUAL_NAME="$(basename "$ARTIFACT")"
if [ "$ACTUAL_NAME" = "$EXPECTED_NAME" ]; then
  assert_pass "deterministic artifact filename"
else
  assert_fail "deterministic filename" "got=$ACTUAL_NAME expected=$EXPECTED_NAME"
fi
cleanup_harness "$H"

# =============================================================================
# Test 15 — second authorization same fingerprint BLOCKS
# =============================================================================
clear_test_env
H="$(make_harness twice)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
run_auth "$H" --approve-production-deploy "$CANON_SHA" >/dev/null 2>&1
out2="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out2" | grep -q 'BLOCK_REASON=AUTHORIZATION_ALREADY_EXISTS'; then
  assert_pass "second authorization same fingerprint blocks"
else
  assert_fail "second authorization blocks" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 16 — no artifact on BLOCK
# =============================================================================
clear_test_env
H="$(make_harness noartifact)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "not-a-sha" 2>&1)"
ARTIFACT_COUNT=$(find "$H/progress" -name 'web-release-authorization-*.env' 2>/dev/null | wc -l)
if [ "$ARTIFACT_COUNT" -eq 0 ] && echo "$out" | grep -q 'INVALID_SOURCE_SHA'; then
  assert_pass "no artifact on BLOCK"
else
  assert_fail "no artifact on BLOCK" "count=$ARTIFACT_COUNT"
fi
cleanup_harness "$H"

# =============================================================================
# Test 17 — no deploy invocation
# =============================================================================
clear_test_env
H="$(make_harness nodeploy)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
DEPLOY_CALLS="$(grep -c 'deploy-web-release-candidate' "$H/scripts/authorize-web-production-release.sh" 2>/dev/null | tr -d '[:space:]')"
[ -z "$DEPLOY_CALLS" ] && DEPLOY_CALLS=0
SCAN="$(grep -E 'deploy-web-release-candidate|docker compose up|docker build' "$H/scripts/authorize-web-production-release.sh" | wc -l | tr -d '[:space:]')"
[ -z "$SCAN" ] && SCAN=0
# Authorization script should never invoke deploy in code path
if [ "$DEPLOY_CALLS" -eq 0 ] && [ "$SCAN" -eq 0 ]; then
  assert_pass "no deploy invocation in authorize script"
else
  assert_fail "no deploy invocation" "calls=$DEPLOY_CALLS scan=$SCAN"
fi
cleanup_harness "$H"

# =============================================================================
# Test 18 — no orchestrator invocation in authorize script source
# =============================================================================
clear_test_env
H="$(make_harness noorch)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
SCAN=$(grep -E "orchestrate-web-production-release" "$H/scripts/authorize-web-production-release.sh" | wc -l)
if [ "$SCAN" -eq 0 ]; then
  assert_pass "no orchestrator invocation in authorize script"
else
  assert_fail "no orchestrator invocation" "static=$SCAN"
fi
cleanup_harness "$H"

# =============================================================================
# Test 19 — no docker compose in authorize script source
# =============================================================================
clear_test_env
H="$(make_harness nodock)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
SCAN=$(grep -E "docker compose|docker build|docker pull" "$H/scripts/authorize-web-production-release.sh" | wc -l)
if [ "$SCAN" -eq 0 ]; then
  assert_pass "no docker compose / build / pull in authorize script"
else
  assert_fail "no docker compose" "static=$SCAN"
fi
cleanup_harness "$H"

# =============================================================================
# Test 20 — approval true ONLY with explicit flag
# =============================================================================
clear_test_env
H="$(make_harness flagcheck)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
if ! echo "$out" | grep -qE '^EXPLICIT_APPROVAL=+$'; then
  assert_pass "EXPLICIT_APPROVAL key present only after explicit flag"
else
  assert_fail "EXPLICIT_APPROVAL" "empty?"
fi
cleanup_harness "$H"

# =============================================================================
# Test 21 — no image positional input
# =============================================================================
clear_test_env
H="$(make_harness noimgpos)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" "extra-image-tag" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=INVALID_ARGUMENTS'; then
  assert_pass "extra positional arg blocks as INVALID_ARGUMENTS"
else
  assert_fail "no image positional input" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 22 — extra args block
# =============================================================================
clear_test_env
H="$(make_harness extra)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" --extra 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=INVALID_ARGUMENTS'; then
  assert_pass "extra --flag blocks as INVALID_ARGUMENTS"
else
  assert_fail "extra --flag blocks" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 23 — output PASS shape
# =============================================================================
clear_test_env
H="$(make_harness passshape)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
miss=()
for k in STATUS SOURCE_SHA RELEASE_PLAN_FINGERPRINT IMAGE_TAG IMAGE_ID AUTHORIZATION_VERSION AUTHORIZED_ACTION EXPLICIT_APPROVAL CONSUMABLE_ONCE PRODUCTION_DEPLOY_AUTHORIZED PRODUCTION_DEPLOY_EXECUTED AUTHORIZATION_ARTIFACT; do
  if ! echo "$out" | grep -qE "^${k}="; then miss+=("$k"); fi
done
if [ $ec -eq 0 ] && [ ${#miss[@]} -eq 0 ]; then
  assert_pass "PASS output shape (12 keys)"
else
  assert_fail "PASS output shape" "exit=$ec missing=${miss[*]}"
fi
cleanup_harness "$H"

# =============================================================================
# Test 24 — output BLOCK shape
# =============================================================================
clear_test_env
H="$(make_harness blockshape)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(run_auth "$H" --approve-production-deploy "bad" 2>&1)"
ec=$?
if [ $ec -ne 0 ] \
   && echo "$out" | grep -q '^STATUS=BLOCKED$' \
   && echo "$out" | grep -q '^BLOCK_REASON=' \
   && echo "$out" | grep -q '^PRODUCTION_DEPLOY_AUTHORIZED=false$' \
   && echo "$out" | grep -q '^PRODUCTION_DEPLOY_EXECUTED=false$'; then
  assert_pass "BLOCK output shape"
else
  assert_fail "BLOCK output shape" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 25 — PASS exit 0
# =============================================================================
clear_test_env
H="$(make_harness exitpass)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
run_auth "$H" --approve-production-deploy "$CANON_SHA" >/dev/null 2>&1
ec=$?
if [ "$ec" -eq 0 ]; then
  assert_pass "PASS exit 0"
else
  assert_fail "PASS exit" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 26 — BLOCK exit nonzero
# =============================================================================
clear_test_env
H="$(make_harness exitblock)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
run_auth "$H" --approve-production-deploy "bad" >/dev/null 2>&1
ec=$?
if [ "$ec" -ne 0 ]; then
  assert_pass "BLOCK exit nonzero"
else
  assert_fail "BLOCK exit" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 27 — no eval
# =============================================================================
clear_test_env
H="$(make_harness noeval)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
SCAN=$(grep -E '\beval\b' "$H/scripts/authorize-web-production-release.sh" | wc -l)
if [ "$SCAN" -eq 0 ]; then
  assert_pass "no eval in authorize script"
else
  assert_fail "no eval" "count=$SCAN"
fi
cleanup_harness "$H"

# =============================================================================
# Test 28 — no source of Plan output
# =============================================================================
clear_test_env
H="$(make_harness nosource)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
SCAN=$(grep -E "source .*plan-web-production-release" "$H/scripts/authorize-web-production-release.sh" | wc -l)
if [ "$SCAN" -eq 0 ]; then
  assert_pass "no source of Plan output"
else
  assert_fail "no source Plan" "count=$SCAN"
fi
cleanup_harness "$H"

# =============================================================================
# Test 29 — caller cwd independence (set -uo + BASH_SOURCE)
# =============================================================================
clear_test_env
H="$(make_harness cwd)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
# Run from /tmp
out="$(cd /tmp && bash "$H/scripts/authorize-web-production-release.sh" --approve-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ "$ec" -eq 0 ] && echo "$out" | grep -q '^STATUS=PASS$'; then
  assert_pass "caller cwd independence (BASH_SOURCE auto-resolves sibling)"
else
  assert_fail "caller cwd independence" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 30 — path with spaces
# S27T-4C-R2B: harness path still includes a space (test requirement),
# but is now rooted under RUN_ROOT and uniquified with $RANDOM-$$.
# =============================================================================
clear_test_env
H="$(mktemp -d "$RUN_ROOT/s27t4a space-$RANDOM-$$-XXXXXX")"
mkdir -p "$H/scripts"
cp "$AUTH" "$H/scripts/authorize-web-production-release.sh"
cp "$PLAN" "$H/scripts/plan-web-production-release.sh"
cp "$DEPLOY" "$H/scripts/deploy-web-release-candidate.sh"
chmod +x "$H/scripts/authorize-web-production-release.sh" \
        "$H/scripts/plan-web-production-release.sh" \
        "$H/scripts/deploy-web-release-candidate.sh"
git init -q "$H"
git -C "$H" config user.email "t@t"
git -C "$H" config user.name "t"
git -C "$H" config commit.gpgsign false
echo "init" > "$H/README"
git -C "$H" add -A >/dev/null 2>&1
git -C "$H" commit -q -m "init" >/dev/null 2>&1
SPACE_SHA="$(git -C "$H" rev-parse HEAD)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
out="$(
  cd "$H" || exit 1
  export CANON_SHA="$SPACE_SHA"
  export PATH="$H/scripts:/usr/bin:/bin"
  bash "$H/scripts/authorize-web-production-release.sh" --approve-production-deploy "$SPACE_SHA" 2>&1
)"
ec=$?
if [ "$ec" -eq 0 ] && echo "$out" | grep -q '^STATUS=PASS$'; then
  assert_pass "path with spaces"
else
  assert_fail "path with spaces" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "=================================="
echo "TOTAL: $((PASS_COUNT + FAIL_COUNT))"
echo "PASS:  $PASS_COUNT"
echo "FAIL:  $FAIL_COUNT"
if [ $FAIL_COUNT -gt 0 ]; then
  echo ""
  echo "FAILURES:"
  for d in "${FAIL_DETAILS[@]}"; do echo "  - $d"; done
  exit 1
fi
exit 0
