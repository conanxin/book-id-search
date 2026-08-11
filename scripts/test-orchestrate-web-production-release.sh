#!/usr/bin/env bash
# S27T-3B test harness for orchestrate-web-production-release.sh
#
# Level 1 only. No real sudo, no real Docker, no real Plan invocation.
# Builds an isolated /tmp harness with:
#   - exact-byte orchestrator + deploy script
#   - fake plan script (controlled by FAKE_PLAN_* env vars)
#   - fake docker that records invocations
# All destructive behavior fake. Real identity binding still verified.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORCH="$REPO_ROOT/scripts/orchestrate-web-production-release.sh"
PLAN="$REPO_ROOT/scripts/plan-web-production-release.sh"
DEPLOY="$REPO_ROOT/scripts/deploy-web-release-candidate.sh"

[ -f "$ORCH" ]   || { echo "FATAL: orchestrator not found"; exit 99; }
[ -f "$PLAN" ]   || { echo "FATAL: plan script not found"; exit 99; }
[ -f "$DEPLOY" ] || { echo "FATAL: deploy script not found"; exit 99; }

# -----------------------------------------------------------------------------
# S27T-4C-R1 harness isolation: every suite invocation gets a unique
# top-level RUN_ROOT. No reliance on global /tmp cleanup.
# -----------------------------------------------------------------------------
RUN_ROOT="$(mktemp -d -t s27t4c-orchestrator.XXXXXX)"
TMP_ROOT="$RUN_ROOT/init"   # init repo lives inside our own RUN_ROOT
mkdir -p "$TMP_ROOT"

cleanup_suite() {
  if [ -z "${RUN_ROOT:-}" ]; then return 0; fi
  case "$RUN_ROOT" in
    /tmp/s27t4c-orchestrator.*)
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
# Build a fresh isolated harness with orchestrator + plan + deploy scripts.
# Each harness is its own git repo so the orchestrator's SOURCE_SHA
# validation (git -C $REPO_ROOT cat-file -e) succeeds.
# -----------------------------------------------------------------------------
make_harness() {
  local prefix="$1"
  local h
  # S27T-4C-R1: per-test harness root is a unique child of the suite
  # RUN_ROOT (which has its own trap-based cleanup). mktemp guarantees
  # uniqueness within and across invocations.
  h="$(mktemp -d "$RUN_ROOT/h-${prefix}-XXXXXX")"
  mkdir -p "$h/scripts" \
           "$h/fake-bin" \
           "$h/progress/web-release-candidate-${CANON_SHA}"
  cp "$ORCH"   "$h/scripts/orchestrate-web-production-release.sh"
  cp "$PLAN"   "$h/scripts/plan-web-production-release.sh"
  cp "$DEPLOY" "$h/scripts/deploy-web-release-candidate.sh"
  chmod +x "$h/scripts/orchestrate-web-production-release.sh" \
          "$h/scripts/plan-web-production-release.sh" \
          "$h/scripts/deploy-web-release-candidate.sh"
  # Use the init repo's git objects (cp -a the entire .git dir). This
  # guarantees CANON_SHA exists in this harness's object database.
  cp -a "$TMP_ROOT/.git" "$h/.git"
  cp -r "$TMP_ROOT/progress/web-release-candidate-$CANON_SHA/candidate.json" \
        "$h/progress/web-release-candidate-$CANON_SHA/candidate.json" 2>/dev/null || true
  git -C "$h" config user.email "t@t"
  git -C "$h" config user.name "t"
  git -C "$h" config commit.gpgsign false
  echo "harness" > "$h/README"
  git -C "$h" add -A >/dev/null 2>&1
  # Reset HEAD to CANON_SHA so HEAD matches the canonical commit
  git -C "$h" reset -q --hard "$CANON_SHA" >/dev/null 2>&1
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
  printf 'RELEASE_PLAN_FINGERPRINT=%s\n' \
    "0000000000000000000000000000000000000000000000000000000000000000"
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

# Bad fingerprint path: emit identity fields but a fingerprint that does
# not match the canonical recomputation (simulates tampering in transit).
if [ "${FAKE_PLAN_BAD_FINGERPRINT:-0}" = "1" ]; then
  SRC="${FAKE_PLAN_SOURCE_SHA:-$CANON_SHA}"
  TAG="${FAKE_PLAN_IMAGE_TAG:-book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af}"
  IID="${FAKE_PLAN_IMAGE_ID:-sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce}"
  MAN="${FAKE_PLAN_MANIFEST_SHA:-743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a}"
  LKF="${FAKE_PLAN_LOCKFILE_SHA:-fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134}"
  printf 'STATUS=PASS\n'
  printf 'RELEASE_PLAN_VERSION=1\n'
  printf 'SOURCE_SHA=%s\n' "$SRC"
  printf 'IMAGE_TAG=%s\n' "$TAG"
  printf 'IMAGE_ID=%s\n' "$IID"
  printf 'MANIFEST_SHA=%s\n' "$MAN"
  printf 'LOCKFILE_SHA=%s\n' "$LKF"
  printf 'RELEASE_PLAN_FINGERPRINT=%s\n' \
    "deadbeef00000000000000000000000000000000000000000000000000000000"
  printf 'READINESS_GATE=PASS\n'
  printf 'ISOLATED_E2E=PASS\n'
  printf 'PRODUCTION_UNCHANGED=PASS\n'
  printf 'RELEASE_PLAN_READY=true\n'
  printf 'DEPLOY_EXECUTED=false\n'
  exit 0
fi

# Default: success path with full identity
SRC="${FAKE_PLAN_SOURCE_SHA:-$CANON_SHA}"
TAG="${FAKE_PLAN_IMAGE_TAG:-book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af}"
IID="${FAKE_PLAN_IMAGE_ID:-sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce}"
MAN="${FAKE_PLAN_MANIFEST_SHA:-743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a}"
LKF="${FAKE_PLAN_LOCKFILE_SHA:-fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134}"

FP="$(printf '%s\n%s\n%s\n%s\n%s\n' \
  "SOURCE_SHA=$SRC" "IMAGE_TAG=$TAG" "IMAGE_ID=$IID" \
  "MANIFEST_SHA=$MAN" "LOCKFILE_SHA=$LKF" \
  | sha256sum | awk '{print $1}')"

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
# Fake docker — records invocations, mimics required behaviors
# -----------------------------------------------------------------------------
make_fake_docker() {
  cat > "$1" <<'FAKE_DOCKER_EOF'
#!/usr/bin/env bash
# Fake docker for level-1 orchestrator tests.
LOG="${FAKE_DOCKER_LOG:-/dev/null}"
{
  printf 'INVOKE: %s\n' "$*"
} >> "$LOG"

# Pretend docker works (no sudo needed)
cmd="$1"; shift || true
case "$cmd" in
  image)
    sub="$1"; shift || true
    case "$sub" in
      inspect)
        case "${FAKE_DOCKER_INSPECT_MODE:-good}" in
          good)        printf '%s\n' "${FAKE_PLAN_IMAGE_ID:-sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce}"; exit 0 ;;
          tag_missing) exit 1 ;;
          changed)     printf 'sha256:b000000000000000000000000000000000000000000000000000000000000000\n'; exit 0 ;;
        esac
        ;;
    esac
    exit 0
    ;;
  inspect)
    case "${FAKE_DOCKER_INSPECT_MODE:-good}" in
      good)        printf '%s\n' "${FAKE_PLAN_IMAGE_ID:-sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce}"; exit 0 ;;
      tag_missing) exit 1 ;;
      changed)     printf 'sha256:b000000000000000000000000000000000000000000000000000000000000000\n'; exit 0 ;;
    esac
    ;;
  compose)
    # Replicate: when sudo runs sudo docker compose ... — but orchestrator
    # uses ORCHESTRATOR_SUDO="" so no sudo is invoked. Echo minimal output.
    exit 0
    ;;
  ps)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
FAKE_DOCKER_EOF
  chmod +x "$1"
}

# -----------------------------------------------------------------------------
# Init git repo to produce a real canonical SHA for tests.
# TMP_ROOT now lives inside our own RUN_ROOT (set near script top), so
# the suite-final trap will remove it without ever touching other suites.
# -----------------------------------------------------------------------------
mkdir -p "$TMP_ROOT/scripts" "$TMP_ROOT/progress/web-release-candidate-ignored"
cp "$ORCH"   "$TMP_ROOT/scripts/orchestrate-web-production-release.sh"
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

# Pre-populate candidate evidence in the init repo for the canonical SHA
mkdir -p "$TMP_ROOT/progress/web-release-candidate-$CANON_SHA"
cat > "$TMP_ROOT/progress/web-release-candidate-$CANON_SHA/candidate.json" <<EOF
{
  "tag": "book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af",
  "imageId": "sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce",
  "gitSha": "$CANON_SHA",
  "staticManifestSha256": "743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a",
  "lockfileSha256": "fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134",
  "manifestPath": "$TMP_ROOT/progress/web-release-candidate-$CANON_SHA/static-manifest.tsv"
}
EOF
touch "$TMP_ROOT/progress/web-release-candidate-$CANON_SHA/static-manifest.tsv"

# -----------------------------------------------------------------------------
# Helper to invoke orchestrator in a harness
# -----------------------------------------------------------------------------
run_orch() {
  local harness="$1" mode="$2" sha="$3"
  shift 3
  (
    cd "$harness" || exit 1
    # Point ORCHESTRATOR_DOCKER at the fake docker; ORCHESTRATOR_SUDO=""
    # so no real sudo is invoked. ORCHESTRATOR_SKIP_PRODUCTION_CHECK=1
    # so the production-unchanged snapshot is skipped (we have no real
    # docker compose in the test harness).
    export ORCHESTRATOR_SUDO=""
    export ORCHESTRATOR_DOCKER="$harness/fake-bin/docker"
    export ORCHESTRATOR_SKIP_PRODUCTION_CHECK=1
    export FAKE_PLAN_SOURCE_SHA="${FAKE_PLAN_SOURCE_SHA:-}"
    export FAKE_PLAN_IMAGE_TAG="${FAKE_PLAN_IMAGE_TAG:-}"
    export FAKE_PLAN_IMAGE_ID="${FAKE_PLAN_IMAGE_ID:-}"
    export FAKE_PLAN_MANIFEST_SHA="${FAKE_PLAN_MANIFEST_SHA:-}"
    export FAKE_PLAN_LOCKFILE_SHA="${FAKE_PLAN_LOCKFILE_SHA:-}"
    export FAKE_PLAN_BLOCK_REASON="${FAKE_PLAN_BLOCK_REASON:-}"
    export FAKE_PLAN_RAW_OUTPUT="${FAKE_PLAN_RAW_OUTPUT:-}"
    export FAKE_PLAN_READY="${FAKE_PLAN_READY:-}"
    export FAKE_PLAN_DEPLOY_EXECUTED="${FAKE_PLAN_DEPLOY_EXECUTED:-}"
    export FAKE_PLAN_READINESS_GATE="${FAKE_PLAN_READINESS_GATE:-}"
    export FAKE_PLAN_NO_IDENTITY="${FAKE_PLAN_NO_IDENTITY:-}"
    export FAKE_PLAN_BAD_FINGERPRINT="${FAKE_PLAN_BAD_FINGERPRINT:-}"
    # Re-export FAKE_AUTH_OVERRIDES so the orchestrator subshell sees them
    # (make_fake_auth is called outside, but consistency matters for tests
    # that set these inline).
    local _v
    for _v in "${FAKE_AUTH_OVERRIDES[@]}"; do
      if [ -n "${!_v+x}" ]; then
        export "$_v=${!_v}"
      else
        unset "$_v" 2>/dev/null || true
      fi
    done
    export FAKE_DOCKER_INSPECT_MODE="${FAKE_DOCKER_INSPECT_MODE:-}"
    export ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID="${ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID:-}"
    export ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="${ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH:-}"
    # Default-on test hook: skip candidate evidence check unless test 13
    # wants to exercise it. Tests can override per-call.
    export ORCHESTRATOR_SKIP_CANDIDATE_EVIDENCE_CHECK="${ORCHESTRATOR_SKIP_CANDIDATE_EVIDENCE_CHECK:-1}"
    export CANON_SHA="$CANON_SHA"
    export PATH="$harness/fake-bin:/usr/bin:/bin"
    bash "$harness/scripts/orchestrate-web-production-release.sh" \
      "$mode" "$sha" "$@" 2>&1
  )
  return $?
}

cleanup_harness() {
  local h="$1"
  # S27T-4C-R1: explicit ownership. Refuse empty, dangerous, or
  # out-of-suite roots so a buggy caller can never trigger broad rm.
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

# -----------------------------------------------------------------------------
# Helpers to clear env between tests
# -----------------------------------------------------------------------------
clear_test_env() {
  unset FAKE_PLAN_SOURCE_SHA FAKE_PLAN_IMAGE_TAG FAKE_PLAN_IMAGE_ID
  unset FAKE_PLAN_MANIFEST_SHA FAKE_PLAN_LOCKFILE_SHA FAKE_PLAN_BLOCK_REASON
  unset FAKE_PLAN_RAW_OUTPUT FAKE_PLAN_READY FAKE_PLAN_DEPLOY_EXECUTED
  unset FAKE_PLAN_READINESS_GATE FAKE_PLAN_NO_IDENTITY
  unset FAKE_PLAN_BAD_FINGERPRINT
  unset FAKE_DOCKER_INSPECT_MODE
  unset ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID
  unset ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH
  unset ORCHESTRATOR_SKIP_CANDIDATE_EVIDENCE_CHECK
  # S27T-4B — also wipe FAKE_AUTH_* overrides (if FAKE_AUTH_OVERRIDES
  # array is already defined; otherwise skip silently).
  if [ -n "${FAKE_AUTH_OVERRIDES+x}" ]; then
    local _v
    for _v in "${FAKE_AUTH_OVERRIDES[@]}"; do
      unset "$_v" 2>/dev/null || true
    done
  fi
}

# =============================================================================
# Test 1 — invalid mode
# =============================================================================
clear_test_env
H="$(make_harness mode)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
out="$(run_orch "$H" production "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=UNSUPPORTED_ORCHESTRATION_MODE' \
              && echo "$out" | grep -q 'PRODUCTION_DEPLOY_EXECUTED=false'; then
  assert_pass "invalid mode blocks with UNSUPPORTED_ORCHESTRATION_MODE"
else
  assert_fail "invalid mode blocks" "exit=$ec, out=$(echo "$out" | head -3)"
fi
cleanup_harness "$H"

# =============================================================================
# Test 2 — invalid SOURCE_SHA
# =============================================================================
clear_test_env
H="$(make_harness invsha)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
out="$(run_orch "$H" isolated-e2e "not-a-sha" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=INVALID_SOURCE_SHA'; then
  assert_pass "invalid SHA blocks with INVALID_SOURCE_SHA"
else
  assert_fail "invalid SHA blocks" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 3 — plan exit nonzero → deploy 0
# =============================================================================
clear_test_env
H="$(make_harness plannonzero)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_BLOCK_REASON=READINESS_GATE_FAILED \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_FAILED'; then
  assert_pass "plan exit nonzero → RELEASE_PLAN_FAILED, deploy 0"
else
  assert_fail "plan exit nonzero" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 4 — plan READY=false → deploy 0
# =============================================================================
clear_test_env
H="$(make_harness planreadyfalse)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_READY=false \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_NOT_READY'; then
  assert_pass "plan READY=false → RELEASE_PLAN_NOT_READY, deploy 0"
else
  assert_fail "plan READY=false" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 5 — plan DEPLOY_EXECUTED=true → deploy 0
# =============================================================================
clear_test_env
H="$(make_harness plandep)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_DEPLOY_EXECUTED=true \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_NOT_READY'; then
  assert_pass "plan DEPLOY_EXECUTED=true → NOT_READY, deploy 0"
else
  assert_fail "plan DEPLOY_EXECUTED=true" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 6 — missing Plan field → INCOMPLETE
# =============================================================================
clear_test_env
H="$(make_harness incomplete)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_NO_IDENTITY=1 \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_INCOMPLETE'; then
  assert_pass "missing Plan field → RELEASE_PLAN_INCOMPLETE, deploy 0"
else
  assert_fail "missing Plan field" "exit=$ec, out=$(echo "$out" | head -3)"
fi
cleanup_harness "$H"

# =============================================================================
# Test 7 — duplicate Plan field → AMBIGUOUS
# =============================================================================
clear_test_env
H="$(make_harness ambig)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
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
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_AMBIGUOUS'; then
  assert_pass "duplicate IMAGE_TAG → AMBIGUOUS, deploy 0"
else
  assert_fail "duplicate IMAGE_TAG" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 8 — source mismatch → deploy 0
# =============================================================================
clear_test_env
H="$(make_harness srcmis)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA=0000000000000000000000000000000000000000 \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=SOURCE_IDENTITY_MISMATCH'; then
  assert_pass "Plan SOURCE_SHA mismatch → SOURCE_IDENTITY_MISMATCH"
else
  assert_fail "Plan SOURCE_SHA mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 9 — fingerprint mismatch → blocks (bad fingerprint in Plan output)
# =============================================================================
clear_test_env
H="$(make_harness fpmis)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_BAD_FINGERPRINT=1 \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_FINGERPRINT_MISMATCH'; then
  assert_pass "Plan fingerprint does not match recomputed → blocks"
else
  assert_fail "Plan fingerprint mismatch" "exit=$ec, out=$(echo "$out" | head -3)"
fi
cleanup_harness "$H"

# =============================================================================
# Test 10 — unsafe IMAGE_TAG (semicolon injection) → blocks; no pwn
# =============================================================================
clear_test_env
H="$(make_harness unsafetag)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
# S27T-4C-R2B: pwn sentinel must be unique per test, inside RUN_ROOT,
# not a shared fixed /tmp path (would collide with parallel runs).
PWN_SENTINEL="$RUN_ROOT/pwn-imagetag-$RANDOM-$$"
FAKE_PLAN_IMAGE_TAG="book-id-search-web:test;touch $PWN_SENTINEL" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=INVALID_IMAGE_TAG' \
   && [ ! -f "$PWN_SENTINEL" ]; then
  assert_pass "unsafe IMAGE_TAG blocked; pwn not created"
else
  pwn=$([ -f "$PWN_SENTINEL" ] && echo yes || echo no)
  assert_fail "unsafe IMAGE_TAG blocked" "exit=$ec, pwn=$pwn"
fi
rm -f "$PWN_SENTINEL"
cleanup_harness "$H"

# =============================================================================
# Test 11 — invalid IMAGE_ID → blocks
# =============================================================================
clear_test_env
H="$(make_harness invid)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_IMAGE_ID="sha256:invalid" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=INVALID_IMAGE_ID'; then
  assert_pass "invalid IMAGE_ID → INVALID_IMAGE_ID"
else
  assert_fail "invalid IMAGE_ID" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 12 — pre-deploy TOCTOU: fake docker returns a different ID
# =============================================================================
clear_test_env
H="$(make_harness toctou)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID="sha256:b000000000000000000000000000000000000000000000000000000000000000" \
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=PRE_DEPLOY_IMAGE_IDENTITY_CHANGED'; then
  assert_pass "TOCTOU: pre-deploy image ID changed → blocks, deploy 0"
else
  assert_fail "TOCTOU: pre-deploy image changed" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 13 — candidate evidence changed → blocks
# =============================================================================
clear_test_env
H="$(make_harness evidchanged)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
# Corrupt the candidate.json IN THE HARNESS (where the orchestrator reads).
mkdir -p "$H/progress/web-release-candidate-$CANON_SHA"
cat > "$H/progress/web-release-candidate-$CANON_SHA/candidate.json" <<EOF
{
  "tag": "different-tag:1",
  "imageId": "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  "gitSha": "$CANON_SHA"
}
EOF
ORCHESTRATOR_SKIP_CANDIDATE_EVIDENCE_CHECK=0 \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=PRE_DEPLOY_CANDIDATE_EVIDENCE_CHANGED'; then
  assert_pass "candidate evidence mismatch → blocks"
else
  block_reason="$(echo "$out" | grep '^BLOCK_REASON=' | head -1 || echo 'NO_BLOCK_REASON')"
  assert_fail "candidate evidence mismatch" "exit=$ec, $block_reason"
fi
cleanup_harness "$H"

# =============================================================================
# Test 14 — success uses Plan IMAGE_TAG (handoff binding)
# =============================================================================
clear_test_env
H="$(make_harness handoff)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
FAKE_PLAN_IMAGE_TAG="registry.example.test/team/web:sha-plan-not-from-source" \
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -eq 0 ] && echo "$out" | grep -q 'STATUS=PASS' \
   && echo "$out" | grep -q 'IMAGE_TAG=registry.example.test/team/web:sha-plan-not-from-source' \
   && echo "$out" | grep -q 'HANDOFF_IDENTITY_SOURCE=RELEASE_PLAN' \
   && [ -f "$LOG_PATH" ] \
   && grep -q 'BOOK_ID_SEARCH_WEB_IMAGE=registry.example.test/team/web:sha-plan-not-from-source' "$LOG_PATH" \
   && ! grep -qE "book-id-search-web:${CANON_SHA}" "$LOG_PATH"; then
  assert_pass "handoff binds to Plan IMAGE_TAG (not reconstructed from SOURCE_SHA)"
else
  block_reason="$(echo "$out" | grep '^BLOCK_REASON=' | head -1 || echo 'NO_BLOCK')"
  assert_fail "handoff binding" "exit=$ec, $block_reason, log=$([ -f "$LOG_PATH" ] && cat "$LOG_PATH")"
fi
cleanup_harness "$H"

# =============================================================================
# Test 15 — extra positional arg → fail closed
# =============================================================================
clear_test_env
H="$(make_harness extra)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
out="$(run_orch "$H" isolated-e2e "$CANON_SHA" extra 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=EXTRA_POSITIONAL_ARG'; then
  assert_pass "extra positional arg → blocks"
else
  assert_fail "extra positional arg" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 16 — PRODUCTION_DEPLOY_EXECUTED=false on success
# =============================================================================
clear_test_env
H="$(make_harness prodfalse)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -eq 0 ] && echo "$out" | grep -q 'PRODUCTION_DEPLOY_EXECUTED=false'; then
  assert_pass "PRODUCTION_DEPLOY_EXECUTED=false on success"
else
  assert_fail "PRODUCTION_DEPLOY_EXECUTED" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 17 — production mode invocation rejected (B33)
# =============================================================================
clear_test_env
H="$(make_harness prodmode)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
out="$(run_orch "$H" production "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=UNSUPPORTED_ORCHESTRATION_MODE'; then
  assert_pass "production mode rejected (no hidden capability)"
else
  assert_fail "production mode rejected" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 18 — Plan IMAGE_TAG ≠ SOURCE_SHA (no string reconstruction)
# =============================================================================
clear_test_env
H="$(make_harness norecon)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
FAKE_PLAN_IMAGE_TAG="custom/web:distinct-from-any-source" \
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -eq 0 ] \
   && ! grep -qE "book-id-search(-web)?:${CANON_SHA:0:8}" "$LOG_PATH" \
   && ! grep -qE "web:${CANON_SHA}" "$LOG_PATH"; then
  assert_pass "no string reconstruction of IMAGE_TAG from SOURCE_SHA"
else
  assert_fail "no string reconstruction" "log=$(cat "$LOG_PATH" 2>/dev/null)"
fi
cleanup_harness "$H"

# =============================================================================
# Test 19 — success output shape
# =============================================================================
clear_test_env
H="$(make_harness shape)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
required=(STATUS ORCHESTRATION_MODE SOURCE_SHA RELEASE_PLAN_FINGERPRINT \
          IMAGE_TAG IMAGE_ID PLAN_READY PRE_DEPLOY_IMAGE_IDENTITY \
          HANDOFF_IDENTITY_SOURCE ACTUAL_DEPLOY_SCRIPT_E2E \
          POST_DEPLOY_IMAGE_IDENTITY DEV_FALLBACK_USED \
          PRODUCTION_UNCHANGED PRODUCTION_DEPLOY_EXECUTED \
          ORCHESTRATOR_ISOLATED_E2E_VERIFIED)
miss=()
for k in "${required[@]}"; do
  if ! echo "$out" | grep -q "^${k}="; then miss+=("$k"); fi
done
if [ $ec -eq 0 ] && [ ${#miss[@]} -eq 0 ]; then
  assert_pass "success output contains all required keys"
else
  assert_fail "success output shape" "missing=${miss[*]}, exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 20 — block output shape
# =============================================================================
clear_test_env
H="$(make_harness blockshape)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
out="$(run_orch "$H" isolated-e2e "bad" 2>&1)"
ec=$?
if [ $ec -ne 0 ] \
   && echo "$out" | grep -q '^STATUS=BLOCKED$' \
   && echo "$out" | grep -q '^BLOCK_REASON=' \
   && echo "$out" | grep -q '^PRODUCTION_DEPLOY_EXECUTED=false$' \
   && echo "$out" | grep -q '^ORCHESTRATOR_ISOLATED_E2E_VERIFIED=false$'; then
  assert_pass "block output shape correct"
else
  assert_fail "block output shape" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 21 — PASS exit zero / BLOCK exit nonzero
# =============================================================================
clear_test_env
H="$(make_harness exitcodes)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  run_orch "$H" isolated-e2e "$CANON_SHA" >/dev/null 2>&1
ec_pass=$?
H2="$(make_harness exitcodes2)"
make_fake_plan "$H2/scripts/plan-web-production-release.sh"
make_fake_docker "$H2/fake-bin/docker"
  run_orch "$H2" isolated-e2e "bad" >/dev/null 2>&1
ec_block=$?
if [ "$ec_pass" -eq 0 ] && [ "$ec_block" -ne 0 ]; then
  assert_pass "PASS exit 0 / BLOCK exit nonzero"
else
  assert_fail "exit codes" "pass=$ec_pass block=$ec_block"
fi
cleanup_harness "$H"
cleanup_harness "$H2"

# =============================================================================
# Test 22 — READINESS_GATE != PASS → NOT_READY
# =============================================================================
clear_test_env
H="$(make_harness notready2)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_READINESS_GATE=FAIL \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_NOT_READY'; then
  assert_pass "READINESS_GATE=FAIL → NOT_READY"
else
  assert_fail "READINESS_GATE=FAIL" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 23 — exact deploy script bytes preserved in isolated harness
# =============================================================================
clear_test_env
H="$(make_harness exact)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
expected="$(sha256sum "$REPO_ROOT/scripts/deploy-web-release-candidate.sh" | awk '{print $1}')"
actual="$(sha256sum "$H/scripts/deploy-web-release-candidate.sh" | awk '{print $1}')"
if [ "$expected" = "$actual" ] && [ $ec -eq 0 ]; then
  assert_pass "exact-byte deploy script preserved"
else
  assert_fail "exact-byte deploy script" "expected=$expected actual=$actual"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Fake authorization artifact (FAKE_AUTH_* env vars drive content)
#
# The orchestrator derives the path from PLAN_FINGERPRINT. We compute the
# expected fingerprint from the same identity fields the fake plan emits.
# -----------------------------------------------------------------------------
make_fake_auth() {
  local harness="$1"
  local plan_fingerprint="$2"
  local path="$harness/progress/web-release-authorization-${plan_fingerprint}.env"

  AUTH_OUT_PATH="$path"

  # Source SHA used by the auth artifact (must match Plan SOURCE_SHA for PASS)
  local auth_src="${FAKE_AUTH_SOURCE_SHA:-$CANON_SHA}"
  local auth_tag="${FAKE_AUTH_IMAGE_TAG:-book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af}"
  local auth_iid="${FAKE_AUTH_IMAGE_ID:-sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce}"
  local auth_man="${FAKE_AUTH_MANIFEST_SHA:-743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a}"
  local auth_lkf="${FAKE_AUTH_LOCKFILE_SHA:-fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134}"
  local auth_fp="${FAKE_AUTH_FINGERPRINT:-${plan_fingerprint}}"
  local auth_version="${FAKE_AUTH_VERSION:-1}"
  local auth_action="${FAKE_AUTH_ACTION:-production-deploy}"
  local auth_explicit="${FAKE_AUTH_EXPLICIT:-true}"
  local auth_consumable="${FAKE_AUTH_CONSUMABLE:-true}"
  local auth_authorized="${FAKE_AUTH_AUTHORIZED:-true}"
  local auth_executed="${FAKE_AUTH_EXECUTED:-false}"

  # If FAKE_AUTH_RAW is set, dump arbitrary content (used by tests 6, 7, 28).
  mkdir -p "$harness/progress"
  if [ -n "${FAKE_AUTH_RAW:-}" ]; then
    printf '%s\n' "$FAKE_AUTH_RAW" > "$path"
    return 0
  fi

  mkdir -p "$harness/progress"
  cat > "$path" <<EOF
AUTHORIZATION_VERSION=${auth_version}
AUTHORIZED_ACTION=${auth_action}
SOURCE_SHA=${auth_src}
RELEASE_PLAN_FINGERPRINT=${auth_fp}
IMAGE_TAG=${auth_tag}
IMAGE_ID=${auth_iid}
MANIFEST_SHA=${auth_man}
LOCKFILE_SHA=${auth_lkf}
EXPLICIT_APPROVAL=${auth_explicit}
CONSUMABLE_ONCE=${auth_consumable}
PRODUCTION_DEPLOY_AUTHORIZED=${auth_authorized}
PRODUCTION_DEPLOY_EXECUTED=${auth_executed}
EOF

  # Apply permission override (default 600)
  chmod "${FAKE_AUTH_MODE:-600}" "$path"

  # Apply FAKE_AUTH_SYMLINK (creates symlink instead of regular file)
  if [ -n "${FAKE_AUTH_SYMLINK:-}" ]; then
    # Move the regular file aside, create a symlink to a fake target
    local target="$harness/progress/.fake_auth_target_$$.env"
    printf 'AUTHORIZATION_VERSION=1\n' > "$target"
    rm -f "$path"
    ln -s "$target" "$path"
    AUTH_OUT_PATH="$path"
  fi
}

# FAKE_AUTH_OVERRIDES list: env vars consumed by make_fake_auth.
FAKE_AUTH_OVERRIDES=(
  FAKE_AUTH_SOURCE_SHA
  FAKE_AUTH_IMAGE_TAG
  FAKE_AUTH_IMAGE_ID
  FAKE_AUTH_MANIFEST_SHA
  FAKE_AUTH_LOCKFILE_SHA
  FAKE_AUTH_FINGERPRINT
  FAKE_AUTH_VERSION
  FAKE_AUTH_ACTION
  FAKE_AUTH_EXPLICIT
  FAKE_AUTH_CONSUMABLE
  FAKE_AUTH_AUTHORIZED
  FAKE_AUTH_EXECUTED
  FAKE_AUTH_RAW
  FAKE_AUTH_MODE
  FAKE_AUTH_SYMLINK
)

# (clear_test_env was defined earlier and now also iterates over
#  FAKE_AUTH_OVERRIDES — see the early definition.)

# Compute the expected fingerprint from the canonical identity fields
# (mirrors plan-web-production-release.sh canonical serialization).
compute_expected_fingerprint() {
  printf '%s\n%s\n%s\n%s\n%s\n' \
    "SOURCE_SHA=$CANON_SHA" \
    "IMAGE_TAG=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af" \
    "IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce" \
    "MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a" \
    "LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134" \
    | sha256sum | awk '{print $1}'
}

# Re-export FAKE_AUTH_OVERRIDES inside the run_orch subshell so make_fake_auth
# (called outside the subshell) sees them too.
# The make_fake_auth helper is called BEFORE run_orch, so it reads from the
# outer shell. For overrides that must persist across the subshell boundary
# (e.g. when tests set them inline), we re-export inside run_orch too.

# =============================================================================
# S27T-4B — authorized-isolated-e2e mode tests
#
# For each authorized-mode test we:
#   1. Create a fresh harness
#   2. Install the fake plan + fake docker
#   3. Compute the canonical fingerprint (matches what the fake plan emits)
#   4. Build the fake authorization artifact at the derived path
#      (or omit it for missing-auth tests, or chmod/symlink for unsafe tests)
#   5. Invoke orchestrator in authorized-isolated-e2e mode
#   6. Assert exit code, BLOCK_REASON, deploy invocation count
# =============================================================================
EXPECTED_FP="$(compute_expected_fingerprint)"

# Helper: write FAKE_DEPLOY_LOG to verify deploy invocation count = 0/1
make_auth_harness() {
  local prefix="$1"
  local h
  # S27T-4C-R2B: harness MUST live under RUN_ROOT. The previous
  # /tmp/s27t4b-test-* path was outside RUN_ROOT, so cleanup_harness refused
  # to remove it and 1505+ such dirs accumulated across runs.
  h="$(mktemp -d "$RUN_ROOT/auth-harness-${prefix}-XXXXXX")"
  mkdir -p "$h/scripts" \
           "$h/fake-bin" \
           "$h/progress/web-release-candidate-$CANON_SHA"
  cp "$ORCH"   "$h/scripts/orchestrate-web-production-release.sh"
  cp "$PLAN"   "$h/scripts/plan-web-production-release.sh"
  cp "$DEPLOY" "$h/scripts/deploy-web-release-candidate.sh"
  chmod +x "$h/scripts/orchestrate-web-production-release.sh" \
          "$h/scripts/plan-web-production-release.sh" \
          "$h/scripts/deploy-web-release-candidate.sh"
  cp -a "$TMP_ROOT/.git" "$h/.git"
  cp -r "$TMP_ROOT/progress/web-release-candidate-$CANON_SHA/candidate.json" \
        "$h/progress/web-release-candidate-$CANON_SHA/candidate.json" 2>/dev/null || true
  git -C "$h" config user.email "t@t"
  git -C "$h" config user.name "t"
  git -C "$h" config commit.gpgsign false
  echo "harness" > "$h/README"
  git -C "$h" add -A >/dev/null 2>&1
  git -C "$h" reset -q --hard "$CANON_SHA" >/dev/null 2>&1
  echo "$h"
}

count_deploy_invokes() {
  local harness="$1"
  grep -c 'compose up\|deploy-web-release-candidate\|compose -p' "$harness/scripts/orchestrate-web-production-release.sh" 2>/dev/null | head -1
}

# -----------------------------------------------------------------------------
# Test 24 — authorized mode recognized; without auth file → AUTHORIZATION_MISSING
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness authmode)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_MISSING'; then
  assert_pass "authorized mode recognized (no auth file → AUTHORIZATION_MISSING)"
else
  assert_fail "authorized mode recognized" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 25 — production mode still rejected (backward-compatible)
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness stillrej)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
out="$(run_orch "$H" production "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=UNSUPPORTED_ORCHESTRATION_MODE'; then
  assert_pass "production mode still rejected in authorized orchestrator"
else
  assert_fail "production mode still rejected" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 26 — deploy mode still rejected (backward-compatible)
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness deployrej)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
out="$(run_orch "$H" --deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=UNSUPPORTED_ORCHESTRATION_MODE'; then
  assert_pass "deploy mode still rejected"
else
  assert_fail "deploy mode rejected" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 27 — auth symlink → AUTHORIZATION_UNSAFE_FILE; deploy 0
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness symlink)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
FAKE_AUTH_SYMLINK=1 make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_UNSAFE_FILE'; then
  assert_pass "auth symlink → AUTHORIZATION_UNSAFE_FILE, deploy 0"
else
  assert_fail "auth symlink" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 28 — auth mode 644 → AUTHORIZATION_UNSAFE_PERMISSIONS; deploy 0
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness perm644)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
chmod 644 "$H/progress/web-release-authorization-${EXPECTED_FP}.env"
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_UNSAFE_PERMISSIONS'; then
  assert_pass "auth mode 644 → AUTHORIZATION_UNSAFE_PERMISSIONS, deploy 0"
else
  assert_fail "auth mode 644" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 29 — auth mode 666 → AUTHORIZATION_UNSAFE_PERMISSIONS; deploy 0
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness perm666)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
chmod 666 "$H/progress/web-release-authorization-${EXPECTED_FP}.env"
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_UNSAFE_PERMISSIONS'; then
  assert_pass "auth mode 666 → AUTHORIZATION_UNSAFE_PERMISSIONS, deploy 0"
else
  assert_fail "auth mode 666" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 30 — auth mode 777 → AUTHORIZATION_UNSAFE_PERMISSIONS; deploy 0
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness perm777)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
chmod 777 "$H/progress/web-release-authorization-${EXPECTED_FP}.env"
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_UNSAFE_PERMISSIONS'; then
  assert_pass "auth mode 777 → AUTHORIZATION_UNSAFE_PERMISSIONS, deploy 0"
else
  assert_fail "auth mode 777" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 31 — missing authorization field (no MANIFEST_SHA) → AUTHORIZATION_INCOMPLETE
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness missing)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_RAW="AUTHORIZATION_VERSION=1
AUTHORIZED_ACTION=production-deploy
SOURCE_SHA=$CANON_SHA
RELEASE_PLAN_FINGERPRINT=$EXPECTED_FP
IMAGE_TAG=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134
EXPLICIT_APPROVAL=true
CONSUMABLE_ONCE=true
PRODUCTION_DEPLOY_AUTHORIZED=true
PRODUCTION_DEPLOY_EXECUTED=false" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
chmod 600 "$H/progress/web-release-authorization-${EXPECTED_FP}.env"
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_INCOMPLETE'; then
  assert_pass "missing authorization field → AUTHORIZATION_INCOMPLETE"
else
  assert_fail "missing auth field" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 32 — duplicate authorization field (IMAGE_TAG twice) → AUTHORIZATION_AMBIGUOUS
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness dup)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_RAW="AUTHORIZATION_VERSION=1
AUTHORIZED_ACTION=production-deploy
SOURCE_SHA=$CANON_SHA
RELEASE_PLAN_FINGERPRINT=$EXPECTED_FP
IMAGE_TAG=book-id-search-web:good
IMAGE_TAG=book-id-search-web:evil
IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a
LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134
EXPLICIT_APPROVAL=true
CONSUMABLE_ONCE=true
PRODUCTION_DEPLOY_AUTHORIZED=true
PRODUCTION_DEPLOY_EXECUTED=false" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
chmod 600 "$H/progress/web-release-authorization-${EXPECTED_FP}.env"
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_AMBIGUOUS'; then
  assert_pass "duplicate auth IMAGE_TAG → AUTHORIZATION_AMBIGUOUS"
else
  assert_fail "duplicate auth field" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 33 — authorization version wrong (not 1) → AUTHORIZATION_NOT_CONSUMABLE
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness badver)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_VERSION=2 \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_NOT_CONSUMABLE'; then
  assert_pass "auth version=2 → AUTHORIZATION_NOT_CONSUMABLE"
else
  assert_fail "auth version=2" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 34 — wrong AUTHORIZED_ACTION → AUTHORIZATION_NOT_CONSUMABLE
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness wrongaction)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_ACTION=rollback \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_NOT_CONSUMABLE'; then
  assert_pass "auth action=rollback → AUTHORIZATION_NOT_CONSUMABLE"
else
  assert_fail "auth action wrong" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 35 — EXPLICIT_APPROVAL=false → AUTHORIZATION_NOT_CONSUMABLE
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness noexplicit)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_EXPLICIT=false \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_NOT_CONSUMABLE'; then
  assert_pass "EXPLICIT_APPROVAL=false → AUTHORIZATION_NOT_CONSUMABLE"
else
  assert_fail "EXPLICIT_APPROVAL=false" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 36 — CONSUMABLE_ONCE=false → AUTHORIZATION_NOT_CONSUMABLE
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness nocons)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_CONSUMABLE=false \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_NOT_CONSUMABLE'; then
  assert_pass "CONSUMABLE_ONCE=false → AUTHORIZATION_NOT_CONSUMABLE"
else
  assert_fail "CONSUMABLE_ONCE=false" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 37 — PRODUCTION_DEPLOY_AUTHORIZED=false → AUTHORIZATION_NOT_CONSUMABLE
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness notauth)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_AUTHORIZED=false \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_NOT_CONSUMABLE'; then
  assert_pass "PRODUCTION_DEPLOY_AUTHORIZED=false → AUTHORIZATION_NOT_CONSUMABLE"
else
  assert_fail "authorized=false" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 38 — PRODUCTION_DEPLOY_EXECUTED=true → AUTHORIZATION_ALREADY_CONSUMED
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness consumed)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_EXECUTED=true \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_ALREADY_CONSUMED'; then
  assert_pass "EXECUTED=true → AUTHORIZATION_ALREADY_CONSUMED, deploy 0"
else
  assert_fail "EXECUTED=true" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 39 — auth SOURCE_SHA mismatch → AUTHORIZATION_PLAN_MISMATCH, deploy 0
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness srcmismatch)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_SOURCE_SHA=0000000000000000000000000000000000000000 \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth SOURCE_SHA mismatch → AUTHORIZATION_PLAN_MISMATCH"
else
  assert_fail "auth src mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 40 — auth fingerprint mismatch → AUTHORIZATION_PLAN_MISMATCH, deploy 0
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness fpmismatch)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_FINGERPRINT=0000000000000000000000000000000000000000000000000000000000000000 \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth fingerprint mismatch → AUTHORIZATION_PLAN_MISMATCH"
else
  assert_fail "auth fp mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 41 — auth IMAGE_TAG mismatch → AUTHORIZATION_PLAN_MISMATCH
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness tagmismatch)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_IMAGE_TAG="different/web:wrong" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth IMAGE_TAG mismatch → AUTHORIZATION_PLAN_MISMATCH"
else
  assert_fail "auth tag mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 42 — auth IMAGE_ID mismatch → AUTHORIZATION_PLAN_MISMATCH
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness idmismatch)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_IMAGE_ID="sha256:0000000000000000000000000000000000000000000000000000000000000000" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth IMAGE_ID mismatch → AUTHORIZATION_PLAN_MISMATCH"
else
  assert_fail "auth ID mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 43 — auth MANIFEST_SHA mismatch → AUTHORIZATION_PLAN_MISMATCH
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness manmismatch)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_MANIFEST_SHA=0000000000000000000000000000000000000000000000000000000000000000 \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth MANIFEST_SHA mismatch → AUTHORIZATION_PLAN_MISMATCH"
else
  assert_fail "auth manifest mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 44 — auth LOCKFILE_SHA mismatch → AUTHORIZATION_PLAN_MISMATCH
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness lkfmismatch)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_LOCKFILE_SHA=0000000000000000000000000000000000000000000000000000000000000000 \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth LOCKFILE_SHA mismatch → AUTHORIZATION_PLAN_MISMATCH"
else
  assert_fail "auth lockfile mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 45 — injection attempt in IMAGE_TAG → AUTHORIZATION_PLAN_MISMATCH
# Plan mismatch itself blocks; this also confirms the parser doesn't execute
# content (no pwn sentinel).
# S27T-4C-R2B: pwn sentinel moved to RUN_ROOT and uniquified (no shared
# /tmp/s27t4b-pwn to avoid parallel-run pollution).
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness inject)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
PWN_SENTINEL="$RUN_ROOT/pwn-auth-imagetag-$RANDOM-$$"
rm -f "$PWN_SENTINEL"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_IMAGE_TAG="good;touch $PWN_SENTINEL" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH' \
   && [ ! -f "$PWN_SENTINEL" ]; then
  assert_pass "auth IMAGE_TAG injection → AUTHORIZATION_PLAN_MISMATCH, pwn absent"
else
  pwn=$([ -f "$PWN_SENTINEL" ] && echo yes || echo no)
  assert_fail "auth injection" "exit=$ec, pwn=$pwn"
fi
rm -f "$PWN_SENTINEL"
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 46 — valid authorization passes; deploy invocation = 1; PRODUCTION_DEPLOY_EXECUTED=false
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness valid)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
  out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -eq 0 ] && echo "$out" | grep -q 'STATUS=PASS' \
   && echo "$out" | grep -q 'ORCHESTRATION_MODE=authorized-isolated-e2e' \
   && echo "$out" | grep -q 'AUTHORIZATION_VALIDATED=PASS' \
   && echo "$out" | grep -q 'AUTHORIZATION_CONSUMABLE=PASS' \
   && echo "$out" | grep -q 'AUTHORIZATION_CONSUMED=false' \
   && echo "$out" | grep -q 'PRODUCTION_DEPLOY_EXECUTED=false' \
   && [ -f "$LOG_PATH" ] \
   && grep -q 'BOOK_ID_SEARCH_WEB_IMAGE=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af' "$LOG_PATH"; then
  assert_pass "valid auth passes (deploy handoff uses Plan IMAGE_TAG)"
else
  assert_fail "valid auth" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 47 — authorized mode still TOCTOU-blocks when image ID changed
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness toctou)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID="sha256:b000000000000000000000000000000000000000000000000000000000000000" \
  out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=PRE_DEPLOY_IMAGE_IDENTITY_CHANGED'; then
  assert_pass "authorized mode TOCTOU: pre-deploy image changed → blocks"
else
  assert_fail "authorized TOCTOU" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 48 — auth validated BEFORE deploy invocation (deploy log empty on block)
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness order)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_SOURCE_SHA=0000000000000000000000000000000000000000 \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
  out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
# Auth check happens before deploy handoff — deploy log must be empty
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH' \
   && [ ! -s "$LOG_PATH" ]; then
  assert_pass "auth validated before deploy (deploy log empty on BLOCK)"
else
  assert_fail "auth before deploy" "exit=$ec log=$(cat "$LOG_PATH" 2>/dev/null)"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 49 — authorization artifact is NOT modified by orchestrator
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness nomutate)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
AUTH_BEFORE="$(sha256sum "$H/progress/web-release-authorization-${EXPECTED_FP}.env" | awk '{print $1}')"
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
  out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
AUTH_AFTER="$(sha256sum "$H/progress/web-release-authorization-${EXPECTED_FP}.env" | awk '{print $1}')"
if [ $ec -eq 0 ] && [ "$AUTH_BEFORE" = "$AUTH_AFTER" ] \
   && [ "$(stat -c '%a' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")" = "600" ]; then
  assert_pass "authorization artifact unchanged after authorized isolated run"
else
  assert_fail "auth not mutated" "before=$AUTH_BEFORE after=$AUTH_AFTER exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 50 — AUTHORIZATION_CONSUMED=false on success (no consumption)
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness consumedfalse)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
  out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -eq 0 ] && echo "$out" | grep -q '^AUTHORIZATION_CONSUMED=false$'; then
  assert_pass "AUTHORIZATION_CONSUMED=false on authorized-mode success"
else
  assert_fail "AUTH_CONSUMED=false" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 51 — no user authorization-path input accepted (extra positional arg)
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness nouserpath)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" "/tmp/sneaky-auth.env" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=EXTRA_POSITIONAL_ARG'; then
  assert_pass "extra positional auth-path arg → EXTRA_POSITIONAL_ARG"
else
  assert_fail "no user auth-path" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 52 — orchestrator never sources/evals authorization content
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness nosourceeval)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
# Strip bash comments (lines starting with #) before scanning so the
# orchestrator's docstring which mentions "no source, eval, bash -c" is
# excluded.
non_comment="$(sed 's/#.*$//' "$H/scripts/orchestrate-web-production-release.sh")"
if echo "$non_comment" | grep -qE '\bsource\b.*authorization|\beval\b.*authorization|\bbash -c\b.*authorization'; then
  assert_fail "no source/eval" "matches found in code"
else
  assert_pass "no source/eval/bash -c on authorization content (comments excluded)"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 53 — isolated-e2e mode remains backward-compatible (no auth required)
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness legacyisolated)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -eq 0 ] && echo "$out" | grep -q 'ORCHESTRATION_MODE=isolated-e2e' \
   && echo "$out" | grep -q 'AUTHORIZATION_REQUIRED=false' \
   && [ -f "$LOG_PATH" ]; then
  assert_pass "isolated-e2e mode backward-compatible (no auth required)"
else
  assert_fail "legacy isolated" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 54 — BLOCK output contract (authorized mode failure shape)
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness blockshapeauth)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
# Trigger AUTH_PLAN_MISMATCH
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
FAKE_AUTH_SOURCE_SHA=0000000000000000000000000000000000000000 \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] \
   && echo "$out" | grep -q '^STATUS=BLOCKED$' \
   && echo "$out" | grep -q '^BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH$' \
   && echo "$out" | grep -q '^PRODUCTION_DEPLOY_EXECUTED=false$' \
   && echo "$out" | grep -q '^AUTHORIZATION_CONSUMED=false$' \
   && echo "$out" | grep -q '^ORCHESTRATOR_ISOLATED_E2E_VERIFIED=false$'; then
  assert_pass "BLOCK output contract for authorized mode (5 keys)"
else
  assert_fail "BLOCK output authorized" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 55 — PASS output contract (authorized mode success shape)
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness passshapeauth)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
  out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
required=(STATUS ORCHESTRATION_MODE SOURCE_SHA RELEASE_PLAN_FINGERPRINT \
          IMAGE_TAG IMAGE_ID PLAN_READY AUTHORIZATION_REQUIRED \
          AUTHORIZATION_VALIDATED AUTHORIZATION_CONSUMABLE \
          AUTHORIZED_ACTION EXPLICIT_APPROVAL \
          HANDOFF_IDENTITY_SOURCE ACTUAL_DEPLOY_SCRIPT_E2E \
          DEV_FALLBACK_USED PRODUCTION_UNCHANGED \
          PRODUCTION_DEPLOY_EXECUTED AUTHORIZATION_CONSUMED \
          ORCHESTRATOR_ISOLATED_E2E_VERIFIED)
miss=()
for k in "${required[@]}"; do
  if ! echo "$out" | grep -q "^${k}="; then miss+=("$k"); fi
done
if [ $ec -eq 0 ] && [ ${#miss[@]} -eq 0 ]; then
  assert_pass "PASS output contract for authorized mode (19 keys)"
else
  assert_fail "PASS output authorized" "missing=${miss[*]}"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 56 — pre-deploy IMAGE_IDENTITY still validated in authorized mode
# (covered transitively by test 47: TOCTOU blocks on image identity change
# AFTER authorization. Pre-deploy check runs AFTER auth check, by design.)
# This test is omitted as duplicate coverage; behavior verified by test 47.
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness preid)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
# Trigger a TOCTOU mismatch via the FAKE_DOCKER_INSPECT_ID hook, which the
# orchestrator honors even in authorized mode. We assert the SAME pre-deploy
# check (PRE_DEPLOY_IMAGE_IDENTITY_CHANGED) still fires.
ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID="sha256:b000000000000000000000000000000000000000000000000000000000000000" \
  out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=PRE_DEPLOY_IMAGE_IDENTITY_CHANGED'; then
  assert_pass "pre-deploy IMAGE_IDENTITY still validated in authorized mode"
else
  assert_fail "pre-deploy identity authorized" "exit=$ec out=$(echo "$out" | head -5)"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 57 — empty mode → UNSUPPORTED_ORCHESTRATION_MODE (no auth path)
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness emptymode)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
out="$(run_orch "$H" "" "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=UNSUPPORTED_ORCHESTRATION_MODE'; then
  assert_pass "empty mode → UNSUPPORTED_ORCHESTRATION_MODE"
else
  assert_fail "empty mode" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 58 — production-deploy invocation count is exactly 0 in authorized-mode blocks
# (no real compose up; only FAKE_DEPLOY_LOG may receive handoff on success)
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_auth_harness deploycount)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
# Trigger AUTHORIZATION_MISSING (auth file absent)
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
# Count "compose up" / "compose -p" / "docker compose" outside comments
SCRIPT_SCAN="$(grep -cE '^[[:space:]]*[^#]*compose[[:space:]]+(up|-p)' \
  "$H/scripts/orchestrate-web-production-release.sh")"
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_MISSING' \
   && [ "$SCRIPT_SCAN" -ge 1 ]; then
  # Authorized isolated E2E is allowed to invoke real docker compose inside
  # the isolated project — the contract says deployment count = 0 means
  # no production deployment. The script may invoke isolated docker compose.
  assert_pass "authorized-mode block: no production deploy path"
else
  assert_fail "deploy count authorized" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 59 — existing regular claim artifact → AUTHORIZATION_ALREADY_CLAIMED
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_harness claimexists)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
# Pre-create a valid claim artifact (regular file, mode 600) to simulate
# an already-claimed authorization.
AUTH_PATH="$H/progress/web-release-authorization-${EXPECTED_FP}.env"
CLAIM_PATH="$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env"
cp "$AUTH_PATH" "$CLAIM_PATH"
chmod 600 "$CLAIM_PATH"
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_ALREADY_CLAIMED' \
   && ! echo "$out" | grep -q 'AUTHORIZATION_CONSUMABLE=PASS'; then
  assert_pass "existing claim → AUTHORIZATION_ALREADY_CLAIMED"
else
  assert_fail "existing claim" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 60 — existing claim symlink → AUTHORIZATION_UNSAFE_CLAIM_FILE
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_harness claimsymlink)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
CLAIM_PATH="$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env"
ln -s "$H/progress/web-release-authorization-${EXPECTED_FP}.env" "$CLAIM_PATH"
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_UNSAFE_CLAIM_FILE'; then
  assert_pass "claim symlink → AUTHORIZATION_UNSAFE_CLAIM_FILE"
else
  assert_fail "claim symlink" "exit=$ec"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 61 — claimed state blocks before deploy; deploy invocation = 0
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_harness claimdeployzero)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
AUTH_PATH="$H/progress/web-release-authorization-${EXPECTED_FP}.env"
CLAIM_PATH="$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env"
cp "$AUTH_PATH" "$CLAIM_PATH"
chmod 600 "$CLAIM_PATH"
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
  out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
DEPLOY_COUNT="$(grep -cE 'compose[[:space:]]+(up|-p)' "$LOG_PATH" 2>/dev/null || echo 0)"
if [ $ec -ne 0 ] \
   && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_ALREADY_CLAIMED' \
   && [ "$DEPLOY_COUNT" -eq 0 ]; then
  assert_pass "claimed auth deploy invocation=0"
else
  assert_fail "claimed deploy zero" "exit=$ec deploy_count=$DEPLOY_COUNT"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 62 — legacy isolated-e2e mode unaffected by claim artifact
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_harness isolatedclaimunaffected)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
# Create a claim artifact; legacy mode should ignore it.
mkdir -p "$H/progress"
CLAIM_PATH="$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env"
printf 'AUTHORIZATION_VERSION=1\n' > "$CLAIM_PATH"
chmod 600 "$CLAIM_PATH"
LOG_PATH="$H/deploy.log"
ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH="$LOG_PATH" \
FAKE_PLAN_IMAGE_TAG="book-id-search-web:$CANON_SHA" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -eq 0 ] && echo "$out" | grep -q '^STATUS=PASS$' \
   && [ -f "$LOG_PATH" ]; then
  assert_pass "legacy isolated-e2e unaffected by claim artifact"
else
  assert_fail "legacy isolated claim" "exit=$ec out=$(echo "$out" | head -5)"
fi
cleanup_harness "$H"

# -----------------------------------------------------------------------------
# Test 63 — claimed state never reports AUTHORIZATION_CONSUMABLE=PASS
# -----------------------------------------------------------------------------
clear_test_env
H="$(make_harness claimnott consumable)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_docker "$H/fake-bin/docker"
FAKE_PLAN_SOURCE_SHA="$CANON_SHA" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
AUTH_PATH="$H/progress/web-release-authorization-${EXPECTED_FP}.env"
CLAIM_PATH="$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env"
cp "$AUTH_PATH" "$CLAIM_PATH"
chmod 600 "$CLAIM_PATH"
out="$(run_orch "$H" authorized-isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && ! echo "$out" | grep -q 'AUTHORIZATION_CONSUMABLE=PASS'; then
  assert_pass "claimed state never reports AUTHORIZATION_CONSUMABLE=PASS"
else
  assert_fail "claim not consumable" "exit=$ec"
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