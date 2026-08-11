#!/usr/bin/env bash
# S27T-4C test harness for claim-web-production-release-authorization.sh
#
# Level-1 only. No real sudo, no real Docker, no real Plan invocation.
# Builds an isolated /tmp harness with:
#   - exact-byte claim + authorize + plan + deploy scripts
#   - fake plan script (controlled by FAKE_PLAN_* env vars)
#   - fake authorization artifact (controlled by FAKE_AUTH_* env vars)
# All destructive behavior fake. Atomic claim still verified against the
# real filesystem `ln` primitive inside the isolated harness.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAIM="$REPO_ROOT/scripts/claim-web-production-release-authorization.sh"
AUTH="$REPO_ROOT/scripts/authorize-web-production-release.sh"
PLAN="$REPO_ROOT/scripts/plan-web-production-release.sh"
DEPLOY="$REPO_ROOT/scripts/deploy-web-release-candidate.sh"

[ -f "$CLAIM"  ] || { echo "FATAL: claim script not found"; exit 99; }
[ -f "$AUTH"   ] || { echo "FATAL: authorize script not found"; exit 99; }
[ -f "$PLAN"   ] || { echo "FATAL: plan script not found"; exit 99; }
[ -f "$DEPLOY" ] || { echo "FATAL: deploy script not found"; exit 99; }

# -----------------------------------------------------------------------------
# S27T-4C-R1 harness isolation: every suite invocation gets a unique
# top-level RUN_ROOT. No reliance on global /tmp cleanup. No broad pkill.
# -----------------------------------------------------------------------------
RUN_ROOT="$(mktemp -d -t s27t4c-claim.XXXXXX)"
TMP_ROOT="$RUN_ROOT/init"   # init repo lives inside our own RUN_ROOT
mkdir -p "$TMP_ROOT"

# Suite-final cleanup: only delete our own RUN_ROOT.
cleanup_suite() {
  if [ -z "${RUN_ROOT:-}" ]; then return 0; fi
  # Safety: only clean if it looks like our own (mktemp -t s27t4c-claim.*)
  case "$RUN_ROOT" in
    /tmp/s27t4c-claim.*)
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
# Build a fresh isolated harness with claim + authorize + plan + deploy.
# Each harness is its own git repo so the CLAIM script's SOURCE_SHA
# validation (git -C $REPO_ROOT cat-file -e) succeeds.
# -----------------------------------------------------------------------------
make_harness() {
  local prefix="$1"
  local h
  # S27T-4C-R1: per-test harness root is a unique child of the suite
  # RUN_ROOT. mktemp guarantees uniqueness within and across invocations.
  h="$(mktemp -d "$RUN_ROOT/h-${prefix}-XXXXXX")"
  mkdir -p "$h/scripts" "$h/progress"
  cp "$CLAIM"  "$h/scripts/claim-web-production-release-authorization.sh"
  cp "$AUTH"   "$h/scripts/authorize-web-production-release.sh"
  cp "$PLAN"   "$h/scripts/plan-web-production-release.sh"
  cp "$DEPLOY" "$h/scripts/deploy-web-release-candidate.sh"
  chmod +x "$h/scripts/claim-web-production-release-authorization.sh"
  chmod +x "$h/scripts/authorize-web-production-release.sh"
  chmod +x "$h/scripts/plan-web-production-release.sh"
  chmod +x "$h/scripts/deploy-web-release-candidate.sh"
  git init -q "$h"
  git -C "$h" config user.email "t@t"
  git -C "$h" config user.name "t"
  git -C "$h" config commit.gpgsign false
  echo "harness" > "$h/README"
  git -C "$h" add -A >/dev/null 2>&1
  git -C "$h" commit -q -m "init" >/dev/null 2>&1
  # Make CANON_SHA commit available in $h. The claim script does
  # `git -C $REPO_ROOT rev-parse ${SOURCE_SHA}^{commit}` to validate that
  # the SOURCE_SHA is a canonical commit object in the repo. We use a
  # direct push from TMP_ROOT to $h so that the commit is in $h's object
  # database under a known ref.
  _tmp_branch="$(git -C "$TMP_ROOT" symbolic-ref --short HEAD 2>/dev/null || git -C "$TMP_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
  git -C "$h" fetch -q "$TMP_ROOT" "${_tmp_branch}:refs/canon-src" 2>/dev/null || true
  git -C "$h" update-ref "refs/canon/${CANON_SHA}" "$CANON_SHA" 2>/dev/null || true
  # As a final fallback, ensure the loose object is fetched directly.
  git -C "$h" fetch -q "$TMP_ROOT" "$CANON_SHA" 2>/dev/null || true
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

# Duplicate test — emit IMAGE_TAG twice
if [ "${FAKE_PLAN_DUPLICATE_TAG:-0}" = "1" ]; then
  printf 'STATUS=PASS\n'
  printf 'RELEASE_PLAN_VERSION=1\n'
  printf 'SOURCE_SHA=%s\n' "$CANON_SHA"
  printf 'IMAGE_TAG=book-id-search-web:dup1\n'
  printf 'IMAGE_TAG=book-id-search-web:dup2\n'
  printf 'IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce\n'
  printf 'MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a\n'
  printf 'LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134\n'
  printf 'RELEASE_PLAN_FINGERPRINT=0000000000000000000000000000000000000000000000000000000000000000\n'
  printf 'READINESS_GATE=PASS\n'
  printf 'ISOLATED_E2E=PASS\n'
  printf 'PRODUCTION_UNCHANGED=PASS\n'
  printf 'RELEASE_PLAN_READY=true\n'
  printf 'DEPLOY_EXECUTED=false\n'
  exit 0
fi

SRC="${FAKE_PLAN_SOURCE_SHA:-$CANON_SHA}"
TAG="${FAKE_PLAN_IMAGE_TAG:-book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af}"
IID="${FAKE_PLAN_IMAGE_ID:-sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce}"
MAN="${FAKE_PLAN_MANIFEST_SHA:-743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a}"
LKF="${FAKE_PLAN_LOCKFILE_SHA:-fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134}"

# Default fingerprint recompute. If FAKE_PLAN_BAD_FINGERPRINT is set
# (non-empty), it overrides the recomputed fingerprint.
FP="$(printf '%s\n%s\n%s\n%s\n%s\n' \
  "SOURCE_SHA=$SRC" "IMAGE_TAG=$TAG" "IMAGE_ID=$IID" \
  "MANIFEST_SHA=$MAN" "LOCKFILE_SHA=$LKF" \
  | sha256sum | awk '{print $1}')"
if [ -n "${FAKE_PLAN_BAD_FINGERPRINT:-}" ]; then
  FP="$FAKE_PLAN_BAD_FINGERPRINT"
fi

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
# Compute the expected fingerprint for the canonical identity fixture
# -----------------------------------------------------------------------------
compute_expected_fingerprint() {
  printf '%s\n%s\n%s\n%s\n%s\n' \
    "SOURCE_SHA=$CANON_SHA" \
    "IMAGE_TAG=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af" \
    "IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce" \
    "MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a" \
    "LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134" \
    | sha256sum | awk '{print $1}'
}

# -----------------------------------------------------------------------------
# Fake Authorization artifact (FAKE_AUTH_* env vars drive content)
#
# Default fingerprint matches compute_expected_fingerprint.
# -----------------------------------------------------------------------------
make_fake_auth() {
  local harness="$1"
  local plan_fingerprint="$2"
  local path="$harness/progress/web-release-authorization-${plan_fingerprint}.env"

  AUTH_OUT_PATH="$path"

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

  mkdir -p "$harness/progress"
  if [ -n "${FAKE_AUTH_RAW:-}" ]; then
    printf '%s\n' "$FAKE_AUTH_RAW" > "$path"
    return 0
  fi

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

  chmod "${FAKE_AUTH_MODE:-600}" "$path"

  if [ -n "${FAKE_AUTH_SYMLINK:-}" ]; then
    local target="$harness/progress/.fake_auth_target_$$.env"
    printf 'AUTHORIZATION_VERSION=1\n' > "$target"
    rm -f "$path"
    ln -s "$target" "$path"
    AUTH_OUT_PATH="$path"
  fi
}

# -----------------------------------------------------------------------------
# FAKE_PLAN_OVERRIDES — env vars consumed by the fake plan.
# -----------------------------------------------------------------------------
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
  FAKE_PLAN_DUPLICATE_TAG
)

# FAKE_AUTH_OVERRIDES — env vars consumed by make_fake_auth.
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

run_claim() {
  local harness="$1"
  shift
  (
    cd "$harness" || exit 1
    export CANON_SHA="$CANON_SHA"
    local _v
    for _v in "${FAKE_PLAN_OVERRIDES[@]}" "${FAKE_AUTH_OVERRIDES[@]}"; do
      if [ -n "${!_v+x}" ]; then
        export "$_v=${!_v}"
      else
        unset "$_v" 2>/dev/null || true
      fi
    done
    export PATH="$harness/scripts:/usr/bin:/bin"
    bash "$harness/scripts/claim-web-production-release-authorization.sh" "$@"
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

clear_test_env() {
  local _v
  for _v in "${FAKE_PLAN_OVERRIDES[@]}" "${FAKE_AUTH_OVERRIDES[@]}"; do
    unset "$_v" 2>/dev/null || true
  done
}

# -----------------------------------------------------------------------------
# Discover CANON_SHA from a fresh init repo (so it's a real commit object).
# TMP_ROOT now lives inside our own RUN_ROOT (set near script top), so the
# suite-final trap will remove it without ever touching other suites.
# -----------------------------------------------------------------------------
mkdir -p "$TMP_ROOT/scripts"
cp "$CLAIM"  "$TMP_ROOT/scripts/claim-web-production-release-authorization.sh"
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

EXPECTED_FP="$(compute_expected_fingerprint)"

# =============================================================================
# Test 1 — explicit claim flag required
# =============================================================================
clear_test_env
H="$(make_harness explicitclaim)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_claim "$H" "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=EXPLICIT_CLAIM_REQUIRED' \
   && echo "$out" | grep -q 'AUTHORIZATION_CLAIMED=false' \
   && echo "$out" | grep -q 'PRODUCTION_DEPLOY_EXECUTED=false' \
   && echo "$out" | grep -q 'PRODUCTION_DEPLOY_STARTED=false'; then
  assert_pass "explicit claim required"
else
  assert_fail "explicit claim required" "exit=$ec out=$(echo "$out" | head -5)"
fi
cleanup_harness "$H"

# =============================================================================
# Test 2 — invalid args (no positional SOURCE_SHA)
# =============================================================================
clear_test_env
H="$(make_harness noargs)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_claim "$H" --claim-production-deploy 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=INVALID_ARGUMENTS'; then
  assert_pass "missing SOURCE_SHA → INVALID_ARGUMENTS"
else
  assert_fail "invalid args missing sha" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 3 — invalid SHA
# =============================================================================
clear_test_env
H="$(make_harness badsha)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(run_claim "$H" --claim-production-deploy "not-a-sha" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=INVALID_SOURCE_SHA'; then
  assert_pass "invalid SHA → INVALID_SOURCE_SHA"
else
  assert_fail "invalid sha" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 4 — Plan nonzero exit (via FAKE_PLAN_BLOCK_REASON)
# =============================================================================
clear_test_env
H="$(make_harness planblock)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  FAKE_PLAN_BLOCK_REASON=SIMULATED_PLAN_BLOCK \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_FAILED'; then
  assert_pass "Plan nonzero exit → RELEASE_PLAN_FAILED"
else
  assert_fail "plan nonzero exit" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 5 — Plan not ready
# =============================================================================
clear_test_env
H="$(make_harness plannotready)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  FAKE_PLAN_READINESS_GATE=FAIL \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_NOT_READY'; then
  assert_pass "Plan READINESS_GATE=FAIL → RELEASE_PLAN_NOT_READY"
else
  assert_fail "plan not ready" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 6 — Plan missing field
# =============================================================================
clear_test_env
H="$(make_harness planmiss)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  FAKE_PLAN_NO_IDENTITY=1 \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_OUTPUT_INCOMPLETE'; then
  assert_pass "Plan missing field → RELEASE_PLAN_OUTPUT_INCOMPLETE"
else
  assert_fail "plan missing field" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 7 — Plan duplicate field
# =============================================================================
clear_test_env
H="$(make_harness plandup)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  FAKE_PLAN_DUPLICATE_TAG=1 \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_OUTPUT_AMBIGUOUS'; then
  assert_pass "Plan duplicate field → RELEASE_PLAN_OUTPUT_AMBIGUOUS"
else
  assert_fail "plan duplicate" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 8 — fingerprint mismatch (Plan recompute vs Plan-emitted)
# =============================================================================
clear_test_env
H="$(make_harness fpmismatch)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  FAKE_PLAN_BAD_FINGERPRINT=deadbeef00000000000000000000000000000000000000000000000000000000 \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=RELEASE_PLAN_FINGERPRINT_MISMATCH'; then
  assert_pass "Plan fingerprint mismatch"
else
  assert_fail "plan fp mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 9 — Authorization missing
# =============================================================================
clear_test_env
H="$(make_harness authmiss)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
# Intentionally do NOT create the authorization file
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_MISSING'; then
  assert_pass "auth missing → AUTHORIZATION_MISSING"
else
  assert_fail "auth missing" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 10 — Authorization symlink
# =============================================================================
clear_test_env
H="$(make_harness authsym)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_AUTH_SYMLINK=1 make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_UNSAFE_FILE'; then
  assert_pass "auth symlink → AUTHORIZATION_UNSAFE_FILE"
else
  assert_fail "auth symlink" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 11 — Authorization unsafe permission
# =============================================================================
clear_test_env
H="$(make_harness authperm)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
chmod 644 "$H/progress/web-release-authorization-${EXPECTED_FP}.env"
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_UNSAFE_PERMISSIONS'; then
  assert_pass "auth mode 644 → AUTHORIZATION_UNSAFE_PERMISSIONS"
else
  assert_fail "auth unsafe perms" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 12 — Authorization missing field (direct file write; no MANIFEST_SHA)
# =============================================================================
clear_test_env
H="$(make_harness authmissfield)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
mkdir -p "$H/progress"
cat > "$H/progress/web-release-authorization-${EXPECTED_FP}.env" <<EOF
AUTHORIZATION_VERSION=1
AUTHORIZED_ACTION=production-deploy
SOURCE_SHA=${CANON_SHA}
RELEASE_PLAN_FINGERPRINT=${EXPECTED_FP}
IMAGE_TAG=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134
EXPLICIT_APPROVAL=true
CONSUMABLE_ONCE=true
PRODUCTION_DEPLOY_AUTHORIZED=true
PRODUCTION_DEPLOY_EXECUTED=false
EOF
chmod 600 "$H/progress/web-release-authorization-${EXPECTED_FP}.env"
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_INCOMPLETE'; then
  assert_pass "auth missing field → AUTHORIZATION_INCOMPLETE"
else
  assert_fail "auth missing field" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 13 — Authorization duplicate field (IMAGE_TAG twice)
# =============================================================================
clear_test_env
H="$(make_harness authdup)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
mkdir -p "$H/progress"
cat > "$H/progress/web-release-authorization-${EXPECTED_FP}.env" <<EOF
AUTHORIZATION_VERSION=1
AUTHORIZED_ACTION=production-deploy
SOURCE_SHA=${CANON_SHA}
RELEASE_PLAN_FINGERPRINT=${EXPECTED_FP}
IMAGE_TAG=dup1
IMAGE_TAG=dup2
IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a
LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134
EXPLICIT_APPROVAL=true
CONSUMABLE_ONCE=true
PRODUCTION_DEPLOY_AUTHORIZED=true
PRODUCTION_DEPLOY_EXECUTED=false
EOF
chmod 600 "$H/progress/web-release-authorization-${EXPECTED_FP}.env"
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_AMBIGUOUS'; then
  assert_pass "auth duplicate field → AUTHORIZATION_AMBIGUOUS"
else
  assert_fail "auth duplicate" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 14 — Authorization semantic flag invalid (EXPLICIT_APPROVAL=false)
# =============================================================================
clear_test_env
H="$(make_harness authsemantic)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_AUTH_EXPLICIT=false make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_NOT_CONSUMABLE'; then
  assert_pass "auth EXPLICIT_APPROVAL=false → AUTHORIZATION_NOT_CONSUMABLE"
else
  assert_fail "auth semantic" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 15 — Authorization EXECUTED=true → AUTHORIZATION_ALREADY_CONSUMED
# =============================================================================
clear_test_env
H="$(make_harness authexecuted)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_AUTH_EXECUTED=true make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_ALREADY_CONSUMED'; then
  assert_pass "auth EXECUTED=true → AUTHORIZATION_ALREADY_CONSUMED"
else
  assert_fail "auth executed" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 16 — Authorization SOURCE_SHA mismatch
# =============================================================================
clear_test_env
H="$(make_harness authsrc)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_AUTH_SOURCE_SHA=0000000000000000000000000000000000000000 \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth SOURCE_SHA mismatch → AUTHORIZATION_PLAN_MISMATCH"
else
  assert_fail "auth src mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 17 — Authorization fingerprint mismatch
# =============================================================================
clear_test_env
H="$(make_harness authfp)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_AUTH_FINGERPRINT=0000000000000000000000000000000000000000000000000000000000000000 \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth fingerprint mismatch"
else
  assert_fail "auth fp mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 18 — Authorization IMAGE_TAG mismatch
# =============================================================================
clear_test_env
H="$(make_harness authtag)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_AUTH_IMAGE_TAG="different/web:wrong" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth IMAGE_TAG mismatch"
else
  assert_fail "auth tag mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 19 — Authorization IMAGE_ID mismatch
# =============================================================================
clear_test_env
H="$(make_harness authiid)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_AUTH_IMAGE_ID="sha256:0000000000000000000000000000000000000000000000000000000000000000" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth IMAGE_ID mismatch"
else
  assert_fail "auth image_id mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 20 — Authorization MANIFEST_SHA mismatch
# =============================================================================
clear_test_env
H="$(make_harness authmanifest)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_AUTH_MANIFEST_SHA="0000000000000000000000000000000000000000000000000000000000000000" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth MANIFEST_SHA mismatch"
else
  assert_fail "auth manifest mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 21 — Authorization LOCKFILE_SHA mismatch
# =============================================================================
clear_test_env
H="$(make_harness authlockfile)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
FAKE_AUTH_LOCKFILE_SHA="0000000000000000000000000000000000000000000000000000000000000000" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_PLAN_MISMATCH'; then
  assert_pass "auth LOCKFILE_SHA mismatch"
else
  assert_fail "auth lockfile mismatch" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 22 — success claim (PASS, AUTHORIZATION_CLAIMED=true)
# =============================================================================
clear_test_env
H="$(make_harness success)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null

ORIG_SHA="$(sha256sum "$H/progress/web-release-authorization-${EXPECTED_FP}.env" | awk '{print $1}')"
ORIG_INODE="$(stat -c '%d:%i' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")"
ORIG_SIZE="$(stat -c '%s' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")"
ORIG_MODE="$(stat -c '%a' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")"

out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?

CLAIM_PATH="$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env"

if [ $ec -eq 0 ] \
   && echo "$out" | grep -q '^STATUS=PASS$' \
   && echo "$out" | grep -q '^AUTHORIZATION_CLAIMED=true$' \
   && echo "$out" | grep -q '^AUTHORIZATION_REUSABLE=false$' \
   && echo "$out" | grep -q '^CONSUMABLE_ONCE=true$' \
   && echo "$out" | grep -q '^PRODUCTION_DEPLOY_EXECUTED=false$' \
   && echo "$out" | grep -q '^PRODUCTION_DEPLOY_STARTED=false$' \
   && [ -e "$CLAIM_PATH" ]; then
  assert_pass "successful claim (PASS, AUTHORIZATION_CLAIMED=true, claim file exists)"
else
  assert_fail "success claim" "exit=$ec out=$(echo "$out" | head -3)"
fi
cleanup_harness "$H"

# =============================================================================
# Test 23 — claim artifact exists; second claim BLOCK
# =============================================================================
clear_test_env
H="$(make_harness claimexists)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null

# First claim → PASS
run_claim "$H" --claim-production-deploy "$CANON_SHA" >/dev/null 2>&1
CLAIM_PATH="$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env"
if [ ! -f "$CLAIM_PATH" ]; then
  assert_fail "claim exists setup" "first claim did not produce claim artifact"
  cleanup_harness "$H"
else
  # Second claim → BLOCK AUTHORIZATION_ALREADY_CLAIMED
  out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
    PATH="$H/scripts:/usr/bin:/bin" \
    bash "$H/scripts/claim-web-production-release-authorization.sh" \
      --claim-production-deploy "$CANON_SHA" 2>&1)"
  ec=$?
  if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_ALREADY_CLAIMED'; then
    assert_pass "second claim → AUTHORIZATION_ALREADY_CLAIMED"
  else
    assert_fail "second claim BLOCK" "exit=$ec"
  fi
fi
cleanup_harness "$H"

# =============================================================================
# Test 24 — claim symlink → AUTHORIZATION_UNSAFE_CLAIM_FILE
# =============================================================================
clear_test_env
H="$(make_harness claimsym)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null

# Create symlink claim before invoking
mkdir -p "$H/progress"
ln -s "$H/progress/web-release-authorization-${EXPECTED_FP}.env" \
      "$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env"

out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_UNSAFE_CLAIM_FILE'; then
  assert_pass "claim symlink → AUTHORIZATION_UNSAFE_CLAIM_FILE"
else
  assert_fail "claim symlink" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 25 — claim mode = 600 (hardlink inherits mode; chmod verification)
# =============================================================================
clear_test_env
H="$(make_harness claimmode)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
CLAIM_PATH="$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env"
CLAIM_MODE="$(stat -c '%a' "$CLAIM_PATH" 2>/dev/null || echo "")"
if [ $ec -eq 0 ] && [ "$CLAIM_MODE" = "600" ]; then
  assert_pass "claim mode = 600"
else
  assert_fail "claim mode" "exit=$ec mode=$CLAIM_MODE"
fi
cleanup_harness "$H"

# =============================================================================
# Test 26 — claim same inode as authorization (true hard-link)
# =============================================================================
clear_test_env
H="$(make_harness claiminode)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null

ORIG_INODE="$(stat -c '%d:%i' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")"
run_claim "$H" --claim-production-deploy "$CANON_SHA" >/dev/null 2>&1
CLAIM_INODE="$(stat -c '%d:%i' "$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env" 2>/dev/null || echo "")"
if [ "$CLAIM_INODE" = "$ORIG_INODE" ] && [ -n "$CLAIM_INODE" ]; then
  assert_pass "claim same device:inode as authorization (true hard-link)"
else
  assert_fail "claim same inode" "orig=$ORIG_INODE claim=$CLAIM_INODE"
fi
cleanup_harness "$H"

# =============================================================================
# Test 27 — claim same SHA as authorization (byte-identical)
# =============================================================================
clear_test_env
H="$(make_harness claimsha)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null

ORIG_SHA="$(sha256sum "$H/progress/web-release-authorization-${EXPECTED_FP}.env" | awk '{print $1}')"
run_claim "$H" --claim-production-deploy "$CANON_SHA" >/dev/null 2>&1
CLAIM_SHA="$(sha256sum "$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env" | awk '{print $1}')"
if [ "$CLAIM_SHA" = "$ORIG_SHA" ] && [ -n "$CLAIM_SHA" ]; then
  assert_pass "claim same sha256 as authorization"
else
  assert_fail "claim sha identity" "orig=$ORIG_SHA claim=$CLAIM_SHA"
fi
cleanup_harness "$H"

# =============================================================================
# Test 28 — original authorization unchanged after claim
# =============================================================================
clear_test_env
H="$(make_harness originalauth)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null

ORIG_SHA="$(sha256sum "$H/progress/web-release-authorization-${EXPECTED_FP}.env" | awk '{print $1}')"
ORIG_MODE="$(stat -c '%a' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")"
ORIG_INODE="$(stat -c '%d:%i' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")"
ORIG_SIZE="$(stat -c '%s' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")"

run_claim "$H" --claim-production-deploy "$CANON_SHA" >/dev/null 2>&1

NOW_SHA="$(sha256sum "$H/progress/web-release-authorization-${EXPECTED_FP}.env" | awk '{print $1}')"
NOW_MODE="$(stat -c '%a' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")"
NOW_INODE="$(stat -c '%d:%i' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")"
NOW_SIZE="$(stat -c '%s' "$H/progress/web-release-authorization-${EXPECTED_FP}.env")"

if [ "$NOW_SHA" = "$ORIG_SHA" ] \
   && [ "$NOW_MODE" = "$ORIG_MODE" ] \
   && [ "$NOW_INODE" = "$ORIG_INODE" ] \
   && [ "$NOW_SIZE" = "$ORIG_SIZE" ]; then
  assert_pass "original authorization byte/mode/inode/size unchanged"
else
  assert_fail "original auth invariant" "sha=$NOW_SHA vs $ORIG_SHA; mode=$NOW_MODE vs $ORIG_MODE; inode=$NOW_INODE vs $ORIG_INODE; size=$NOW_SIZE vs $ORIG_SIZE"
fi
cleanup_harness "$H"

# =============================================================================
# Test 29 — second claim BLOCK (no overwrite, no unlink, no replace)
# =============================================================================
clear_test_env
H="$(make_harness secondblock)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null

run_claim "$H" --claim-production-deploy "$CANON_SHA" >/dev/null 2>&1
ORIG_CLAIM_INODE="$(stat -c '%d:%i' "$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env")"

# Second claim must not modify the existing claim
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?

NOW_CLAIM_INODE="$(stat -c '%d:%i' "$H/progress/web-release-authorization-claim-${EXPECTED_FP}.env")"
if [ $ec -ne 0 ] \
   && echo "$out" | grep -q 'BLOCK_REASON=AUTHORIZATION_ALREADY_CLAIMED' \
   && [ "$NOW_CLAIM_INODE" = "$ORIG_CLAIM_INODE" ]; then
  assert_pass "second claim blocks and preserves claim inode"
else
  assert_fail "second claim block+preserve" "exit=$ec inode_before=$ORIG_CLAIM_INODE inode_after=$NOW_CLAIM_INODE"
fi
cleanup_harness "$H"

# =============================================================================
# Test 30 — no overwrite (no --force / -f flag on ln command)
# =============================================================================
clear_test_env
H="$(make_harness nooverwrite)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null

# Strip shell comments before scanning, so that mentions of "--force" or
# "no overwrite" in comments don't trigger false positives.
SCRIPT_NO_COMMENTS="$(grep -vE '^[[:space:]]*#' "$H/scripts/claim-web-production-release-authorization.sh")"
SCAN="$(printf '%s\n' "$SCRIPT_NO_COMMENTS" | grep -cE 'ln[[:space:]]+[^|;&]*[[:space:]](-[bf]|--force|--backup)')"
if [ "${SCAN:-0}" -eq 0 ]; then
  assert_pass "no -f / --force flag on ln (no overwrite primitive)"
else
  assert_fail "no overwrite" "force-flag count=$SCAN"
fi
cleanup_harness "$H"

# =============================================================================
# Test 31 — claim script does NOT invoke orchestrator
# =============================================================================
clear_test_env
H="$(make_harness noorch)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
SCAN="$(grep -E 'orchestrate-web-production-release' "$H/scripts/claim-web-production-release-authorization.sh" | wc -l | tr -d '[:space:]')"
if [ "${SCAN:-0}" -eq 0 ]; then
  assert_pass "claim script does not invoke orchestrator"
else
  assert_fail "no orchestrator" "count=$SCAN"
fi
cleanup_harness "$H"

# =============================================================================
# Test 32 — claim script does NOT invoke deploy / docker / compose
# =============================================================================
clear_test_env
H="$(make_harness nodeploy)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
SCAN_DEPLOY="$(grep -E 'deploy-web-release-candidate' "$H/scripts/claim-web-production-release-authorization.sh" | wc -l | tr -d '[:space:]')"
SCAN_DOCKER="$(grep -E '^[[:space:]]*[^#]*docker[[:space:]]+(compose|build)' "$H/scripts/claim-web-production-release-authorization.sh" | wc -l | tr -d '[:space:]')"
SCAN_COMPOSE="$(grep -E 'compose[[:space:]]+(up|-p)' "$H/scripts/claim-web-production-release-authorization.sh" | wc -l | tr -d '[:space:]')"
if [ "${SCAN_DEPLOY:-0}" -eq 0 ] && [ "${SCAN_DOCKER:-0}" -eq 0 ] && [ "${SCAN_COMPOSE:-0}" -eq 0 ]; then
  assert_pass "claim script does not invoke deploy / docker compose / docker build"
else
  assert_fail "no deploy capability" "deploy=$SCAN_DEPLOY docker=$SCAN_DOCKER compose=$SCAN_COMPOSE"
fi
cleanup_harness "$H"

# =============================================================================
# Test 33 — no source / eval / bash -c on artifact content (comments stripped)
# =============================================================================
clear_test_env
H="$(make_harness nosource)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
# Strip comments so that descriptions like "no eval" in comments don't trigger.
SCRIPT_NO_COMMENTS="$(grep -vE '^[[:space:]]*#' "$H/scripts/claim-web-production-release-authorization.sh")"
SCAN_EVAL="$(printf '%s\n' "$SCRIPT_NO_COMMENTS" | grep -cE '\beval\b')"
SCAN_SOURCE="$(printf '%s\n' "$SCRIPT_NO_COMMENTS" | grep -cE '\bsource\b[[:space:]]+/')"
SCAN_BASHC="$(printf '%s\n' "$SCRIPT_NO_COMMENTS" | grep -cE 'bash[[:space:]]+-c')"
if [ "${SCAN_EVAL:-0}" -eq 0 ] && [ "${SCAN_SOURCE:-0}" -eq 0 ] && [ "${SCAN_BASHC:-0}" -eq 0 ]; then
  assert_pass "no eval/source/bash -c on artifact content"
else
  assert_fail "no source/eval" "eval=$SCAN_EVAL source=$SCAN_SOURCE bash_c=$SCAN_BASHC"
fi
cleanup_harness "$H"

# =============================================================================
# Test 34 — no human identity input (no --image / --tag / --fingerprint / etc.)
# =============================================================================
clear_test_env
H="$(make_harness nohuman)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" \
    --image-tag "evil:tag" \
    --image-id "sha256:0000000000000000000000000000000000000000000000000000000000000000" \
    --fingerprint "0000000000000000000000000000000000000000000000000000000000000000" \
    --authorization-path "/tmp/evil" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && echo "$out" | grep -q 'BLOCK_REASON=INVALID_ARGUMENTS'; then
  assert_pass "no human identity input (--image/--tag/--fp/--auth-path rejected)"
else
  assert_fail "no human identity input" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 35 — cwd independence (set -uo + BASH_SOURCE)
# =============================================================================
clear_test_env
H="$(make_harness cwd)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd /tmp && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -eq 0 ] && echo "$out" | grep -q '^STATUS=PASS$'; then
  assert_pass "caller cwd independence"
else
  assert_fail "cwd independence" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 36 — path with spaces
# S27T-4C-R2B: harness path still includes a space (test requirement),
# but is now rooted under RUN_ROOT and uniquified with $RANDOM-$$.
# =============================================================================
clear_test_env
H="$(mktemp -d "$RUN_ROOT/s27t4c space-$RANDOM-$$-XXXXXX")"
mkdir -p "$H/scripts" "$H/progress"
cp "$CLAIM"  "$H/scripts/claim-web-production-release-authorization.sh"
cp "$AUTH"   "$H/scripts/authorize-web-production-release.sh"
cp "$PLAN"   "$H/scripts/plan-web-production-release.sh"
cp "$DEPLOY" "$H/scripts/deploy-web-release-candidate.sh"
chmod +x "$H/scripts/claim-web-production-release-authorization.sh" \
        "$H/scripts/authorize-web-production-release.sh" \
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
git -C "$H" fetch -q "$TMP_ROOT" "$CANON_SHA" 2>/dev/null || true
make_fake_plan "$H/scripts/plan-web-production-release.sh"

# We need to recompute the expected fingerprint with SPACE_SHA for this harness
SPACE_FP="$(printf '%s\n%s\n%s\n%s\n%s\n' \
    "SOURCE_SHA=$SPACE_SHA" \
    "IMAGE_TAG=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af" \
    "IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce" \
    "MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a" \
    "LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134" \
    | sha256sum | awk '{print $1}')"

# Create authorization with SPACE_SHA-matching values
FAKE_AUTH_SOURCE_SHA="$SPACE_SHA" FAKE_AUTH_FINGERPRINT="$SPACE_FP" \
  make_fake_auth "$H" "$SPACE_FP" >/dev/null

out="$(cd "$H" && CANON_SHA="$SPACE_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$SPACE_SHA" 2>&1)"
ec=$?
if [ $ec -eq 0 ] && echo "$out" | grep -q '^STATUS=PASS$' \
   && [ -f "$H/progress/web-release-authorization-claim-$SPACE_FP.env" ]; then
  assert_pass "path with spaces"
else
  assert_fail "path with spaces" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 37 — Output PASS shape (success contract)
# =============================================================================
clear_test_env
H="$(make_harness passshape)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
miss=()
for k in STATUS SOURCE_SHA RELEASE_PLAN_FINGERPRINT IMAGE_TAG IMAGE_ID \
         AUTHORIZED_ACTION AUTHORIZATION_ARTIFACT AUTHORIZATION_CLAIM_ARTIFACT \
         AUTHORIZATION_CLAIMED AUTHORIZATION_REUSABLE CONSUMABLE_ONCE \
         PRODUCTION_DEPLOY_AUTHORIZED PRODUCTION_DEPLOY_EXECUTED \
         PRODUCTION_DEPLOY_STARTED; do
  if ! echo "$out" | grep -qE "^${k}="; then miss+=("$k"); fi
done
if [ $ec -eq 0 ] && [ ${#miss[@]} -eq 0 ]; then
  assert_pass "PASS output shape (14 keys)"
else
  assert_fail "PASS output shape" "exit=$ec missing=${miss[*]}"
fi
cleanup_harness "$H"

# =============================================================================
# Test 38 — Output BLOCK shape
# =============================================================================
clear_test_env
H="$(make_harness blockshape)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
# Capture stdout+stderr to a file so we can read exit code independently
# of the variable assignment (which would always be 0).
BLOCKS_OUT="$(mktemp)"
( cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "badsha1234" ) >"$BLOCKS_OUT" 2>&1
ec=$?
out="$(cat "$BLOCKS_OUT")"
rm -f "$BLOCKS_OUT"
if [ $ec -ne 0 ] \
   && echo "$out" | grep -q '^STATUS=BLOCKED$' \
   && echo "$out" | grep -q '^BLOCK_REASON=' \
   && echo "$out" | grep -q '^AUTHORIZATION_CLAIMED=false$' \
   && echo "$out" | grep -q '^PRODUCTION_DEPLOY_EXECUTED=false$' \
   && echo "$out" | grep -q '^PRODUCTION_DEPLOY_STARTED=false$'; then
  assert_pass "BLOCK output shape"
else
  assert_fail "BLOCK output shape" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 39 — PASS exit 0
# =============================================================================
clear_test_env
H="$(make_harness exitpass)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
( cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" ) >/dev/null 2>&1
ec=$?
if [ "$ec" -eq 0 ]; then
  assert_pass "PASS exit 0"
else
  assert_fail "PASS exit" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 40 — BLOCK exit nonzero
# =============================================================================
clear_test_env
H="$(make_harness exitblock)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
( cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "badsha1234" ) >/dev/null 2>&1
ec=$?
if [ "$ec" -ne 0 ]; then
  assert_pass "BLOCK exit nonzero"
else
  assert_fail "BLOCK exit" "exit=$ec"
fi
cleanup_harness "$H"

# =============================================================================
# Test 41 — claim injection safety (auth IMAGE_TAG contains shell metachars)
# S27T-4C-R2B: pwn sentinel moved to RUN_ROOT and uniquified.
# =============================================================================
clear_test_env
H="$(make_harness injection)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
# S27T-4C-R2B: pwn sentinel is unique per test under RUN_ROOT, not a
# shared /tmp path that would collide with parallel runs.
PWN_SENTINEL="$RUN_ROOT/pwn-claim-imagetag-$RANDOM-$$"
FAKE_AUTH_IMAGE_TAG="good;touch $PWN_SENTINEL" \
  make_fake_auth "$H" "$EXPECTED_FP" >/dev/null
rm -f "$PWN_SENTINEL"
out="$(cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" 2>&1)"
ec=$?
if [ $ec -ne 0 ] && [ ! -e "$PWN_SENTINEL" ]; then
  assert_pass "auth injection safe (Plan mismatch blocks; pwn absent)"
else
  assert_fail "auth injection" "exit=$ec pwn_present=$([ -e "$PWN_SENTINEL" ] && echo YES || echo NO)"
fi
rm -f "$PWN_SENTINEL"
cleanup_harness "$H"

# =============================================================================
# Test 42 — concurrent claim attempts (C22)
#
# Real filesystem `ln` primitive arbitrates. Plan can be fake.
# Expect: exactly one PASS, exactly one BLOCK (AUTHORIZATION_ALREADY_CLAIMED).
# =============================================================================
clear_test_env
H="$(make_harness concurrent)"
make_fake_plan "$H/scripts/plan-web-production-release.sh"
make_fake_auth "$H" "$EXPECTED_FP" >/dev/null

OUT_DIR="$(mktemp -d)"
# Two concurrent claim processes in background
( cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" ) > "$OUT_DIR/claim_a.log" 2>&1 &
PID_A=$!
( cd "$H" && CANON_SHA="$CANON_SHA" \
  PATH="$H/scripts:/usr/bin:/bin" \
  bash "$H/scripts/claim-web-production-release-authorization.sh" \
    --claim-production-deploy "$CANON_SHA" ) > "$OUT_DIR/claim_b.log" 2>&1 &
PID_B=$!
wait $PID_A; EA=$?
wait $PID_B; EB=$?

# Wait for both, examine outputs
PASS_A=$(grep -c '^STATUS=PASS$' "$OUT_DIR/claim_a.log")
PASS_B=$(grep -c '^STATUS=PASS$' "$OUT_DIR/claim_b.log")
BLOCK_A=$(grep -c '^BLOCK_REASON=AUTHORIZATION_ALREADY_CLAIMED$' "$OUT_DIR/claim_a.log")
BLOCK_B=$(grep -c '^BLOCK_REASON=AUTHORIZATION_ALREADY_CLAIMED$' "$OUT_DIR/claim_b.log")

# Exactly one claim artifact must exist
CLAIM_FILE_COUNT=$(find "$H/progress" -maxdepth 1 -name "web-release-authorization-claim-*.env" 2>/dev/null | wc -l | tr -d '[:space:]')

if [ "$PASS_A" -eq 1 ] && [ "$PASS_B" -eq 0 ] && [ "$BLOCK_A" -eq 0 ] && [ "$BLOCK_B" -eq 1 ] \
   && [ "$CLAIM_FILE_COUNT" = "1" ]; then
  assert_pass "concurrent claim: exactly one PASS, one BLOCK, one artifact (case A>B)"
elif [ "$PASS_A" -eq 0 ] && [ "$PASS_B" -eq 1 ] && [ "$BLOCK_A" -eq 1 ] && [ "$BLOCK_B" -eq 0 ] \
   && [ "$CLAIM_FILE_COUNT" = "1" ]; then
  assert_pass "concurrent claim: exactly one PASS, one BLOCK, one artifact (case B>A)"
elif [ "$PASS_A" -eq 1 ] && [ "$PASS_B" -eq 1 ] \
   && [ "$CLAIM_FILE_COUNT" = "1" ]; then
  # Both processes reported STATUS=PASS. This is a violation of the atomic
  # primitive contract: there must be exactly one PASS. Even if the second
  # process found an existing claim at precheck, the claim script returns
  # BLOCK with AUTHORIZATION_ALREADY_CLAIMED, not PASS. Two PASSes always
  # means the atomic ln primitive was bypassed.
  assert_fail "concurrent claim" "two PASSes detected (PASS_A=$PASS_A PASS_B=$PASS_B) — atomic primitive violated"
else
  assert_fail "concurrent claim" "PASS_A=$PASS_A PASS_B=$PASS_B BLOCK_A=$BLOCK_A BLOCK_B=$BLOCK_B claim_files=$CLAIM_FILE_COUNT"
fi

# Verify only one claim artifact exists at end
rm -rf "$OUT_DIR"
cleanup_harness "$H"

# =============================================================================
# Summary
# =============================================================================
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