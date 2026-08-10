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
  h="$(mktemp -d /tmp/s27t3b-test-${prefix}-XXXXXX)"
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
# Init git repo to produce a real canonical SHA for tests
# -----------------------------------------------------------------------------
TMP_ROOT="$(mktemp -d /tmp/s27t3b-init-XXXXXX)"
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
  if [ -n "$h" ] && [ -d "$h" ]; then
    rm -rf "$h" 2>/dev/null || true
  fi
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
FAKE_PLAN_IMAGE_TAG="book-id-search-web:test;touch /tmp/pwn_should_not_exist" \
  out="$(run_orch "$H" isolated-e2e "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=INVALID_IMAGE_TAG' \
   && [ ! -f /tmp/pwn_should_not_exist ]; then
  assert_pass "unsafe IMAGE_TAG blocked; /tmp/pwn not created"
else
  pwn=$([ -f /tmp/pwn_should_not_exist ] && echo yes || echo no)
  assert_fail "unsafe IMAGE_TAG blocked" "exit=$ec, pwn=$pwn"
fi
rm -f /tmp/pwn_should_not_exist
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