#!/usr/bin/env bash
# S27T-5E-R3A-I3 regression test for scripts/deploy-web-release-candidate.sh
#
# Uses a fake command harness to safely reproduce the
# RELEASE_PIPELINE_ENV_PROPAGATION_INCIDENT observed during S27S-R2.
#
# This test does NOT touch real Docker, real production, or real compose.
# All commands exercised by the deploy script are intercepted by fake
# binaries in $RUN_TMP/bin (a docker shim and a sudo shim that simulates
# env_reset behavior).
#
# Design constraints (I3):
# - HOST_SYSTEM_BINARY_MUTATION_ALLOWED=false
# - No mount/umount/unshare/nsenter
# - DOCKER_SUDO resolution via harness-owned absolute fake sudo
# - Fake sudo self-locates via $0; no FAKE_BIN_DIR inheritance
# - Fake sudo simulates env_reset with env -i
# - Fake docker self-locates via $0; logs to $SELF_DIR/fake-docker.log
# - Fake docker fail-closed (no fallback to real docker)
#
# Tests:
#   TEST 1 — sudo env_reset reproduction: caller BOOK_ID_SEARCH_WEB_IMAGE
#            is stripped; only deploy-explicit image survives.
#   TEST 2 — no-sudo path: candidate image override propagates.
#   TEST 3 — exact image identity: registry/path:tag survives unchanged.
#   TEST 4 — no build flag in compose invocation.
#   TEST 5 — no unexpected pull.
#   TEST 6 — missing candidate fails closed.
set -uo pipefail

# Cleanup on exit (any reason): remove self-created fake harness tmp dir
trap 'rm -rf "$RUN_TMP" 2>/dev/null || true' EXIT INT TERM

# Locate repo and script under test
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_SCRIPT="$APP_DIR/scripts/deploy-web-release-candidate.sh"

if [ ! -f "$DEPLOY_SCRIPT" ]; then
  echo "FATAL: deploy script not found at $DEPLOY_SCRIPT" >&2
  exit 99
fi

# Per-run working directory (self-contained: no historical evidence dependency)
RUN_TMP="$(mktemp -d -t s27t-XXXXXX)"
mkdir -p "$RUN_TMP/bin"

# Self-create fake sudo + fake docker at runtime. These are recreated on
# every test invocation so the test is portable across fresh checkouts and
# does not depend on any gitignored historical progress/ evidence.

cat > "$RUN_TMP/bin/sudo" <<'FAKE_SUDO_EOF'
# S27T-5E-R3A-I3 fake-sudo
# - Self-locates via $0 (SELF_DIR parameter expansion)
# - Simulates real sudo env_reset via `env -i` (clean environment)
# - Preserves harness-controlled PATH so sibling fake docker is found
# - Logs to self-contained $SELF_DIR/fake-sudo.log
# - NO FAKE_BIN_DIR / FAKE_SUDO_LOG / FAKE_DOCKER_LOG dependency
# - Fail-closed: invoked without a path -> nonzero

set -e
case "$0" in
  */*) SELF_DIR="${0%/*}" ;;
  *) echo "ERROR: fake-sudo invoked without path: $0" >&2; exit 1 ;;
esac
SELF_DIR="$(cd "$SELF_DIR" && pwd)"

# Simulate sudo env_reset: drop ALL inherited env except PATH/HOME.
# PATH is preserved (not minimized) because the harness places per-scenario
# fake docker directories ahead of system dirs; this keeps resolution correct
# after env_reset without leaking caller BOOK_ID_SEARCH_WEB_IMAGE.
ENV_ARGS=(
  env -i
  PATH="${PATH:-$SELF_DIR:/usr/bin:/bin}"
  HOME="${HOME:-/tmp}"
)

# Log call to self-contained path
LOG="$SELF_DIR/fake-sudo.log"
{
  echo "=== fake-sudo called ==="
  echo "argv0: $0"
  echo "SELF_DIR: $SELF_DIR"
  echo "argv: $*"
  echo "inherited BOOK_ID_SEARCH_WEB_IMAGE=${BOOK_ID_SEARCH_WEB_IMAGE:-<unset>}"
} >> "$LOG" 2>&1 || true

# Simulate env_reset and execute the command sudo would have run.
exec "${ENV_ARGS[@]}" "$@"
FAKE_SUDO_EOF

chmod +x "$RUN_TMP/bin/sudo"

# Generate a fake docker executable at $1 with a hardcoded `docker ps` exit
# code ($2).  The fake docker self-locates via $0, logs to
# "$SELF_DIR/../fake-docker.log", and is fail-closed (no real docker
# fallback).  This satisfies the I3 requirement that logging must be
# self-contained and not depend on inherited env vars.

# Write fake docker identity state for the current scenario.
write_fake_docker_state() {
  local state_file="$1"
  local candidate_tag="$2"
  local candidate_id="$3"
  local container_id="$4"
  local container_image_id="$5"
  {
    printf "CANDIDATE_TAG='%s'\n" "$candidate_tag"
    printf "CANDIDATE_ID='%s'\n" "$candidate_id"
    printf "CONTAINER_ID='%s'\n" "$container_id"
    printf "CONTAINER_IMAGE_ID='%s'\n" "$container_image_id"
  } > "$state_file"
}

# Compute a deterministic image ID from an image tag.
image_id_from_tag() {
  printf 'sha256:%s' "$(printf '%s' "$1" | sha256sum | awk '{print $1}')"
}


# Generate a fake docker executable at $1 with a hardcoded `docker ps` exit
# code ($2).  The fake docker self-locates via $0, logs to
# "$SELF_DIR/../fake-docker.log", and is fail-closed (no real docker
# fallback).  If a state file "$SELF_DIR/../fake-docker-state" exists, it is
# sourced and used to answer identity queries consistently:
#   - docker inspect <CANDIDATE_TAG>  -> CANDIDATE_ID
#   - docker inspect <CONTAINER_ID>   -> CONTAINER_IMAGE_ID
#   - docker compose ps -q web         -> CONTAINER_ID
# Missing state makes image inspect fail closed.
make_fake_docker() {
  local target_path="$1"
  local ps_exit_code="$2"
  mkdir -p "$(dirname "$target_path")"
  cat > "$target_path" <<'FAKE_DOCKER_EOF'
#!/usr/bin/env bash
# S27T-5E-R3A-I3 fake-docker (stateful identity model)
# - Self-locates via $0 (SELF_DIR parameter expansion)
# - Logs to self-contained $SELF_DIR/../fake-docker.log
# - Fail-closed (unknown argv -> exit 1)
# - NO fallback to real docker
# - NO dependency on FAKE_DOCKER_LOG / FAKE_BIN_DIR / outer env

set -e
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$SELF_DIR/../fake-docker.log"
LOG_STATE="$SELF_DIR/../fake-docker-state"

log_kv() {
  printf '%s=%s\n' "$1" "$2" >> "$LOG"
}

CANDIDATE_TAG=""
CANDIDATE_ID=""
CONTAINER_ID=""
CONTAINER_IMAGE_ID=""
if [ -f "$LOG_STATE" ]; then
  . "$LOG_STATE"
fi

parse_target() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --format=*) shift ;;
      --format) shift 2 ;;
      *) break ;;
    esac
  done
  printf '%s' "$1"
}

case "$1" in
  "ps")
    exit $ps_exit_code
    ;;
  "image")
    if [ "$2" = "inspect" ]; then
      shift 2
      TARGET="$(parse_target "$@")"
      if [ -n "$CANDIDATE_TAG" ] && [ "$TARGET" = "$CANDIDATE_TAG" ]; then
        log_kv INSPECT_IMAGE "$TARGET"
        log_kv INSPECT_ID "$CANDIDATE_ID"
        echo "$CANDIDATE_ID"
        exit 0
      fi
      echo "ERROR: fake-docker image inspect: unregistered image: $TARGET" >&2
      exit 1
    fi
    echo "ERROR: fake-docker does not support: docker image $*" >&2
    exit 1
    ;;
  "inspect")
    shift
    TARGET="$(parse_target "$@")"
    if [ -n "$CANDIDATE_TAG" ] && [ "$TARGET" = "$CANDIDATE_TAG" ]; then
      log_kv INSPECT_IMAGE "$TARGET"
      log_kv INSPECT_ID "$CANDIDATE_ID"
      echo "$CANDIDATE_ID"
      exit 0
    fi
    if [ -n "$CONTAINER_ID" ] && [ "$TARGET" = "$CONTAINER_ID" ]; then
      log_kv INSPECT_IMAGE "$TARGET"
      log_kv INSPECT_ID "$CONTAINER_IMAGE_ID"
      echo "$CONTAINER_IMAGE_ID"
      exit 0
    fi
    echo "ERROR: fake-docker inspect: unregistered target: $TARGET" >&2
    exit 1
    ;;
  "compose")
    shift
    log_kv PWD "${PWD:-<unset>}"
    log_kv PATH "${PATH}"
    log_kv ARGV "$*"
    log_kv COMPOSE_ARGV "$*"
    log_kv COMPOSE_SEEN_IMAGE "${BOOK_ID_SEARCH_WEB_IMAGE:-<unset>}"
    case "$1" in
      "up")
        log_kv COMPOSE_UP_CALLED "true"
        exit 0
        ;;
      "ps")
        if [ "$2" = "-q" ] && [ "$3" = "web" ]; then
          if [ -n "$CONTAINER_ID" ]; then
            echo "$CONTAINER_ID"
          fi
          exit 0
        fi
        echo "NAME                IMAGE"
        echo "fake-web-1          book-id-search-web"
        exit 0
        ;;
      *)
        echo "ERROR: fake-docker compose subcommand not supported: $*" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "ERROR: fake-docker does not support argv: $*" >&2
    exit 1
    ;;
esac
FAKE_DOCKER_EOF
  chmod +x "$target_path"
}


make_fake_docker "$RUN_TMP/bin/docker" 0
# Confirm the test harness owns the absolute fake sudo used for TEST1/TEST3.
# DOCKER_SUDO will resolve to "$RUN_TMP/bin/sudo" because the harness places
# that directory first in PATH for every deploy invocation.
RESOLVED_SUDO="$(PATH="$RUN_TMP/bin" command -v sudo)"
if [ "$RESOLVED_SUDO" != "$RUN_TMP/bin/sudo" ]; then
  echo "FATAL: harness-owned fake sudo not absolute-resolvable" >&2
  echo "  resolved sudo=$RESOLVED_SUDO" >&2
  exit 97
fi

PASS_COUNT=0
FAIL_COUNT=0
declare -a FAIL_DETAILS

assert_pass() {
  local name="$1"
  echo "PASS: $name"
  PASS_COUNT=$((PASS_COUNT + 1))
}
assert_fail() {
  local name="$1" detail="$2"
  echo "FAIL: $name -- $detail"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAIL_DETAILS+=("$name: $detail")
}

# R2-3 / R2-4: Fail-closed guard for root-resolution tests.
#
# Verifies that all required artifacts (fake-docker.log, fixture root,
# expected root, actual root) are present and non-empty BEFORE the
# root-resolution comparison runs. This prevents the false-positive
# "" == "" PASS observed in S27T-3B-R1 where both EXPECTED_RELO_ROOT
# and ACTUAL_PWD were empty strings (RUN_TMP was deleted mid-test) and
# the assertion `$ACTUAL_PWD = $EXPECTED_RELO_ROOT` matched trivially.
#
# Args:
#   $1 = test_name (used for fail message)
#   $2 = expected_root (non-empty required)
#   $3 = actual_root (non-empty required)
#   $4 = fake_docker_log_path (file must exist and be non-empty)
#   $5 = fixture_root (directory must exist)
#
# Returns 0 if all guards pass, 1 otherwise (also calls assert_fail).
check_root_resolution_artifacts() {
  local test_name="$1"
  local expected="$2"
  local actual="$3"
  local fake_log="$4"
  local fixture_root="$5"
  local missing=()

  [ -n "$expected" ] || missing+=("expected_root is EMPTY")
  [ -n "$actual" ] || missing+=("actual_root is EMPTY")
  [ -f "$fake_log" ] || missing+=("fake_docker_log missing: $fake_log")
  [ -d "$fixture_root" ] || missing+=("fixture_root missing: $fixture_root")

  if [ "${#missing[@]}" -gt 0 ]; then
    local joined
    joined=$(IFS='; '; echo "${missing[*]}")
    assert_fail "${test_name}_fixture_guard" "$joined"
    return 1
  fi
  return 0
}

# Run the deploy script under a given scenario. The script will be invoked
# inside a subshell with PATH prefix and FAKE_DOCKER_LOG/FAKE_SUDO_LOG set.
run_scenario() {
  local scenario_name="$1"
  local image_tag="$2"
  local expect_sudo="$3"   # "sudo" or "nosudo"
  shift 3
  local extra_env=("$@")

  local SCEN_TMP="$RUN_TMP/$scenario_name"
  mkdir -p "$SCEN_TMP"
  local SUDO_LOG="$SCEN_TMP/fake-sudo.log"
  local DOCKER_LOG="$SCEN_TMP/fake-docker.log"
  local COMPOSE_LOG="$SCEN_TMP/fake-docker.log"
  local ARGS_LOG="$SCEN_TMP/args.log"
  local EXIT_FILE="$SCEN_TMP/exit.txt"
  rm -f "$SUDO_LOG" "$DOCKER_LOG" "$EXIT_FILE"

  # Build environment to pass to the deploy script invocation.
  # Only PATH is explicitly controlled; no FAKE_* vars are leaked to the
  # fake boundary, satisfying the I3 self-contained/logging requirement.
  local EXPORT_VARS=(
    "PATH=$SCEN_TMP/bin:$RUN_TMP/bin:$PATH"
  )
  for kv in "${extra_env[@]}"; do
    EXPORT_VARS+=("$kv")
  done

  # Create a per-scenario fake docker that self-locates and logs to
  # $SCEN_TMP/fake-docker.log.  Its `docker ps` exit code drives the deploy
  # script's DOCKER_SUDO detection: 1 -> DOCKER_SUDO="sudo", 0 -> "".
  if [ "$expect_sudo" = "sudo" ]; then
    make_fake_docker "$SCEN_TMP/bin/docker" 1
  else
    make_fake_docker "$SCEN_TMP/bin/docker" 0
  fi
  # Register deterministic candidate/container identity for this scenario.
  local CAND_ID
  CAND_ID="$(image_id_from_tag "$image_tag")"
  write_fake_docker_state     "$SCEN_TMP/fake-docker-state"     "$image_tag"     "$CAND_ID"     "fakewebcid0000000000000000000000000000000000000000000000000000"     "$CAND_ID"

  # Set up compose-seen log path
  local COMPOSE_SEEN_LOG="$SCEN_TMP/compose-seen-env.txt"
  : > "$COMPOSE_SEEN_LOG"

  # Run the deploy script under the controlled environment.
  # DOCKER_SUDO resolves to the absolute path "$RUN_TMP/bin/sudo" because
  # "sudo" is looked up in the PATH we provide (which has RUN_TMP/bin first).
  (
    cd "$APP_DIR"
    env "${EXPORT_VARS[@]}" \
      bash "$DEPLOY_SCRIPT" "$image_tag" \
      > "$SCEN_TMP/stdout.txt" 2> "$SCEN_TMP/stderr.txt"
    echo $? > "$EXIT_FILE"
  )

  # Read the docker log and extract COMPOSE_SEEN_IMAGE captured at the
  # `docker compose up` point (the actual deploy command), NOT from the
  # subsequent verification loop's `docker compose ps` calls.
  COMPOSE_SEEN_IMAGE="<no_compose_invocation>"
  if [ -f "$DOCKER_LOG" ]; then
    # Pair up COMPOSE_ARGV with COMPOSE_SEEN_IMAGE; find the one whose
    # ARGV starts with "up ".
    val=$(awk -F= '
      /^COMPOSE_ARGV=/ { argv=$2 }
      /^COMPOSE_SEEN_IMAGE=/ && argv ~ /^up[ ]/ { print substr($0, length("COMPOSE_SEEN_IMAGE=")+1); argv="" }
    ' "$DOCKER_LOG" | head -1)
    if [ -n "$val" ]; then
      COMPOSE_SEEN_IMAGE="$val"
    fi
  fi

  # Save what the deploy script actually invoked for compose
  echo "scenario=$scenario_name" > "$COMPOSE_SEEN_LOG"
  echo "expect_sudo=$expect_sudo" >> "$COMPOSE_SEEN_LOG"
  echo "image_tag=$image_tag" >> "$COMPOSE_SEEN_LOG"
  echo "COMPOSE_SEEN_IMAGE=$COMPOSE_SEEN_IMAGE" >> "$COMPOSE_SEEN_LOG"
  echo "deploy_exit=$(cat "$EXIT_FILE")" >> "$COMPOSE_SEEN_LOG"

  # Save the actual compose argv too
  if [ -f "$DOCKER_LOG" ]; then
    grep -E '^COMPOSE_ARGV=' "$DOCKER_LOG" | tail -1 >> "$COMPOSE_SEEN_LOG"
  fi

  echo "[scenario=$scenario_name] COMPOSE_SEEN_IMAGE=$COMPOSE_SEEN_IMAGE exit=$(cat "$EXIT_FILE")" >&2
}

# ============================================================
# TEST 1: sudo env_reset reproduction
# ============================================================
SCEN="test1_sudo_envreset"
run_scenario "$SCEN" "book-id-search-web:test-frozen-candidate" "sudo"

COMPOSE_SEEN=$(grep '^COMPOSE_SEEN_IMAGE=' "$RUN_TMP/$SCEN/compose-seen-env.txt" | cut -d= -f2-)
EXIT_VAL=$(grep '^deploy_exit=' "$RUN_TMP/$SCEN/compose-seen-env.txt" | cut -d= -f2)
if [ "$COMPOSE_SEEN" = "book-id-search-web:test-frozen-candidate" ]; then
  assert_pass "TEST1_sudo_envreset_image_override_visible_to_compose"
else
  assert_fail "TEST1_sudo_envreset_image_override_visible_to_compose" \
    "compose saw COMPOSE_SEEN_IMAGE=$COMPOSE_SEEN (expected book-id-search-web:test-frozen-candidate); this is the BUG_REPRODUCED signal"
fi

# ============================================================
# TEST 2: no-sudo path
# ============================================================
SCEN="test2_nosudo"
run_scenario "$SCEN" "book-id-search-web:test-frozen-candidate" "nosudo"

COMPOSE_SEEN=$(grep '^COMPOSE_SEEN_IMAGE=' "$RUN_TMP/$SCEN/compose-seen-env.txt" | cut -d= -f2-)
if [ "$COMPOSE_SEEN" = "book-id-search-web:test-frozen-candidate" ]; then
  assert_pass "TEST2_nosudo_image_override_visible_to_compose"
else
  assert_fail "TEST2_nosudo_image_override_visible_to_compose" \
    "compose saw COMPOSE_SEEN_IMAGE=$COMPOSE_SEEN (expected book-id-search-web:test-frozen-candidate)"
fi

# ============================================================
# TEST 3: exact image identity (registry/path:tag survives)
# ============================================================
SCEN="test3_exact_identity"
EXACT_IMAGE="registry.example.test/team/web:sha-1234567890abcdef"
run_scenario "$SCEN" "$EXACT_IMAGE" "sudo"

COMPOSE_SEEN=$(grep '^COMPOSE_SEEN_IMAGE=' "$RUN_TMP/$SCEN/compose-seen-env.txt" | cut -d= -f2-)
if [ "$COMPOSE_SEEN" = "$EXACT_IMAGE" ]; then
  assert_pass "TEST3_exact_identity_registry_pathtag_preserved"
else
  assert_fail "TEST3_exact_identity_registry_pathtag_preserved" \
    "compose saw COMPOSE_SEEN_IMAGE=$COMPOSE_SEEN (expected $EXACT_IMAGE)"
fi

# ============================================================
# TEST 4: no build flag in compose invocation
# ============================================================
SCEN="test4_no_build"
run_scenario "$SCEN" "book-id-search-web:test-frozen-candidate" "sudo"

# Extract the compose-up argv (first ARGV that starts with "up ")
COMPOSE_ARGV=$(awk -F= '/^COMPOSE_ARGV=/ { argv=$2 } argv ~ /^up[ ]/ { print argv; argv="" }' "$RUN_TMP/$SCEN/fake-docker.log" | head -1)
# Should not contain `build` as a verb or `--build` (note: `--no-build` is allowed)
if echo "$COMPOSE_ARGV" | grep -qE '(^| )build( |$)|(^| )--build( |$)'; then
  assert_fail "TEST4_no_build_flag_in_compose" \
    "compose argv contained build token: $COMPOSE_ARGV"
else
  assert_pass "TEST4_no_build_flag_in_compose"
fi

# Also check sudo log for any direct docker build invocations
if grep -qE 'docker[[:space:]]+build' "$RUN_TMP/$SCEN/fake-sudo.log" 2>/dev/null; then
  assert_fail "TEST4_no_docker_build_direct" \
    "fake-sudo log shows direct docker build invocation"
else
  assert_pass "TEST4_no_docker_build_direct"
fi

# ============================================================
# TEST 5: no unexpected pull
# ============================================================
SCEN="test5_no_pull"
run_scenario "$SCEN" "book-id-search-web:test-frozen-candidate" "sudo"

# Extract the compose-up argv (first ARGV that starts with "up ")
COMPOSE_ARGV=$(awk -F= '/^COMPOSE_ARGV=/ { argv=$2 } argv ~ /^up[ ]/ { print argv; argv="" }' "$RUN_TMP/$SCEN/fake-docker.log" | head -1)
if echo "$COMPOSE_ARGV" | grep -qE '\bpull\b'; then
  assert_fail "TEST5_no_pull_in_compose" \
    "compose argv contained pull token: $COMPOSE_ARGV"
else
  assert_pass "TEST5_no_pull_in_compose"
fi

# ============================================================
# TEST 6: missing candidate fails closed
# ============================================================
SCEN="test6_missing_candidate"
mkdir -p "$RUN_TMP/$SCEN"
# Use a never-existing image tag; deploy script should exit non-zero
# BEFORE invoking docker compose up.
EXIT_FILE="$RUN_TMP/$SCEN/exit.txt"
rm -f "$EXIT_FILE"
(
  cd "$APP_DIR"
  PATH="$RUN_TMP/bin:$PATH" \
    bash "$DEPLOY_SCRIPT" "nonexistent-image:will-not-be-found" \
    > "$RUN_TMP/$SCEN/stdout.txt" 2> "$RUN_TMP/$SCEN/stderr.txt"
  echo $? > "$EXIT_FILE"
)
EXIT_VAL=$(cat "$EXIT_FILE")
# Expect exit code 3 (image-not-found per current deploy script semantics)
if [ "$EXIT_VAL" = "3" ] || [ "$EXIT_VAL" = "4" ]; then
  assert_pass "TEST6_missing_candidate_fails_closed (exit=$EXIT_VAL)"
else
  # Anything else (especially 0) would mean a fail-open or unexpected pass
  assert_fail "TEST6_missing_candidate_fails_closed" \
    "expected exit 3 or 4, got exit=$EXIT_VAL"
fi

# ============================================================
# S27T-1A: Path-resolution tests (script-relative APP_DIR)
#
# These tests verify the patched deploy script resolves its APP_DIR from
# its own location (BASH_SOURCE[0]) instead of from a hardcoded absolute
# path. They DO NOT touch real Docker / production; they use the same fake
# docker harness but record PWD at compose-time.
# ============================================================

# Helper: extract the PWD observed by fake docker at the compose-up call
compose_seen_pwd() {
  local log="$1"
  awk -F= '/^PWD=/ && !seen { print $2; seen=1 }' "$log"
}

# Helper: set up a relocated copy of the deploy script at a given parent
# directory, with a docker-compose.yml marker so the script's fail-closed
# root validation accepts it. Echoes the absolute path to the relocated
# script.
relocate_deploy_script() {
  local parent_dir="$1"
  local scripts_dir="$parent_dir/scripts"
  mkdir -p "$scripts_dir"
  cp "$DEPLOY_SCRIPT" "$scripts_dir/deploy-web-release-candidate.sh"
  cp "$APP_DIR/docker-compose.yml" "$parent_dir/docker-compose.yml"
  echo "$scripts_dir/deploy-web-release-candidate.sh"
}

# Helper: run the deploy script under a given scenario. Records PWD via
# the fake docker log.
run_root_scenario() {
  local scenario_name="$1"
  local script_path="$2"   # absolute path to deploy script
  local caller_cwd="$3"    # where to cd before invocation
  local image_tag="$4"     # image tag to deploy
  local extra_env=("${@:5}")

  local SCEN_TMP="$RUN_TMP/$scenario_name"
  mkdir -p "$SCEN_TMP"
  local DOCKER_LOG="$SCEN_TMP/fake-docker.log"
  rm -f "$DOCKER_LOG"

  # Self-contained per-scenario fake docker.  For root-resolution tests we
  # do not need sudo simulation, so `docker ps` exits 0 -> DOCKER_SUDO="".
  make_fake_docker "$SCEN_TMP/bin/docker" 0
  # Register deterministic candidate/container identity for this scenario.
  local CAND_ID
  CAND_ID="$(image_id_from_tag "$image_tag")"
  write_fake_docker_state     "$SCEN_TMP/fake-docker-state"     "$image_tag"     "$CAND_ID"     "fakewebcid0000000000000000000000000000000000000000000000000000"     "$CAND_ID"

  # No FAKE_* env vars are passed; fake boundary logs are self-contained.
  local EXPORT_VARS=(
    "PATH=$SCEN_TMP/bin:$RUN_TMP/bin:$PATH"
  )
  for kv in "${extra_env[@]}"; do
    EXPORT_VARS+=("$kv")
  done

  (
    cd "$caller_cwd"
    env "${EXPORT_VARS[@]}" \
      bash "$script_path" "$image_tag" \
      > "$SCEN_TMP/stdout.txt" 2> "$SCEN_TMP/stderr.txt"
    echo $? > "$SCEN_TMP/exit.txt"
  )

  echo "[scenario=$scenario_name] caller_cwd=$caller_cwd script=$script_path" \
    > "$SCEN_TMP/scenario-info.txt"
  cat "$SCEN_TMP/scenario-info.txt"
}

# ============================================================
# TEST 7: production-layout root resolution
# (script at /opt/book-id-search/scripts/, PWD at compose-time must
# equal /opt/book-id-search)
# ============================================================
SCEN="test7_production_layout_root"
run_root_scenario "$SCEN" "$DEPLOY_SCRIPT" "$APP_DIR" "book-id-search-web:test-root-resolution" "FAKE_SUDO_LOG=$RUN_TMP/$SCEN/fake-sudo.log"

# Compute expected root via script-location resolution (independent of
# any hardcode in the script).
EXPECTED_ROOT="$(cd "$APP_DIR" && pwd)"
ACTUAL_PWD="$(compose_seen_pwd "$RUN_TMP/$SCEN/fake-docker.log")"
if check_root_resolution_artifacts "TEST7_production_layout_root" \
     "$EXPECTED_ROOT" "$ACTUAL_PWD" \
     "$RUN_TMP/$SCEN/fake-docker.log" "$APP_DIR"; then
  if [ "$ACTUAL_PWD" = "$EXPECTED_ROOT" ]; then
    assert_pass "TEST7_production_layout_root (compose PWD=$ACTUAL_PWD)"
  else
    assert_fail "TEST7_production_layout_root" \
      "compose PWD=$ACTUAL_PWD, expected $EXPECTED_ROOT"
  fi
fi

# ============================================================
# TEST 8: exact-byte relocated copy resolves to its own root
# (NOT /opt/book-id-search)
# ============================================================
RELO_TMP="$RUN_TMP/test8_relocated"
rm -rf "$RELO_TMP"
RELO_SCRIPT="$(relocate_deploy_script "$RELO_TMP")"
# Sanity: SHA of relocated copy matches the production script
RELO_SHA="$(sha256sum "$RELO_SCRIPT" | awk '{print $1}')"
ORIG_SHA="$(sha256sum "$DEPLOY_SCRIPT" | awk '{print $1}')"
if [ "$RELO_SHA" != "$ORIG_SHA" ]; then
  assert_fail "TEST8_exact_byte_sha_match" \
    "relocated SHA=$RELO_SHA differs from original SHA=$ORIG_SHA"
else
  assert_pass "TEST8_exact_byte_sha_match"
fi

SCEN="test8_relocated_root"
run_root_scenario "$SCEN" "$RELO_SCRIPT" "$RELO_TMP" "book-id-search-web:test-root-resolution"

EXPECTED_RELO_ROOT="$(cd "$RELO_TMP" && pwd)"
ACTUAL_PWD="$(compose_seen_pwd "$RUN_TMP/$SCEN/fake-docker.log")"
# Hard requirement: must NOT be the production root.
# R2-3: Fail closed if either expected or actual is empty (regression of
# S27T-3B-R1 where both were empty and ""=="" produced a false-positive PASS).
if check_root_resolution_artifacts "TEST8_relocated_root" \
     "$EXPECTED_RELO_ROOT" "$ACTUAL_PWD" \
     "$RUN_TMP/$SCEN/fake-docker.log" "$RELO_TMP"; then
  if [ "$ACTUAL_PWD" = "$APP_DIR" ]; then
    assert_fail "TEST8_relocated_root_does_not_resolve_to_production" \
      "relocated script resolved to production APP_DIR=$APP_DIR (bug)"
  elif [ "$ACTUAL_PWD" = "$EXPECTED_RELO_ROOT" ]; then
    assert_pass "TEST8_relocated_root (compose PWD=$ACTUAL_PWD)"
  else
    assert_fail "TEST8_relocated_root" \
      "compose PWD=$ACTUAL_PWD, expected $EXPECTED_RELO_ROOT (and NOT $APP_DIR)"
  fi
fi

# ============================================================
# TEST 9: caller-cwd independence (production script, called from /tmp)
# ============================================================
SCEN="test9_caller_cwd_independence"
run_root_scenario "$SCEN" "$DEPLOY_SCRIPT" "/tmp" "book-id-search-web:test-root-resolution"

EXPECTED_ROOT="$(cd "$APP_DIR" && pwd)"
ACTUAL_PWD="$(compose_seen_pwd "$RUN_TMP/$SCEN/fake-docker.log")"
if check_root_resolution_artifacts "TEST9_caller_cwd_independence" \
     "$EXPECTED_ROOT" "$ACTUAL_PWD" \
     "$RUN_TMP/$SCEN/fake-docker.log" "$APP_DIR"; then
  if [ "$ACTUAL_PWD" = "$EXPECTED_ROOT" ]; then
    assert_pass "TEST9_caller_cwd_independence (compose PWD=$ACTUAL_PWD despite caller_cwd=/tmp)"
  else
    assert_fail "TEST9_caller_cwd_independence" \
      "compose PWD=$ACTUAL_PWD, expected $EXPECTED_ROOT"
  fi
fi

# ============================================================
# TEST 10: relocated copy, called from / (different cwd)
# ============================================================
SCEN="test10_relocated_different_cwd"
run_root_scenario "$SCEN" "$RELO_SCRIPT" "/" "book-id-search-web:test-root-resolution"

EXPECTED_RELO_ROOT="$(cd "$RELO_TMP" && pwd)"
ACTUAL_PWD="$(compose_seen_pwd "$RUN_TMP/$SCEN/fake-docker.log")"
if check_root_resolution_artifacts "TEST10_relocated_different_cwd" \
     "$EXPECTED_RELO_ROOT" "$ACTUAL_PWD" \
     "$RUN_TMP/$SCEN/fake-docker.log" "$RELO_TMP"; then
  if [ "$ACTUAL_PWD" = "$EXPECTED_RELO_ROOT" ]; then
    assert_pass "TEST10_relocated_different_cwd (compose PWD=$ACTUAL_PWD despite caller_cwd=/)"
  else
    assert_fail "TEST10_relocated_different_cwd" \
      "compose PWD=$ACTUAL_PWD, expected $EXPECTED_RELO_ROOT"
  fi
fi

# ============================================================
# TEST 11: path with spaces
# ============================================================
SPACE_TMP="/tmp/s27t space $(date +%s)-$$"
SPACE_TMP="$(echo "$SPACE_TMP" | tr ' ' '_')"  # mktemp disallows spaces; use underscores but log intent
# Actually the task wants real spaces; use a name with real spaces.
SPACE_NAME="s27t space $(date +%s)-$$"
SPACE_TMP="/tmp/$SPACE_NAME"
rm -rf "$SPACE_TMP"
SPACE_SCRIPT="$(relocate_deploy_script "$SPACE_TMP")"

SCEN="test11_path_with_spaces"
run_root_scenario "$SCEN" "$SPACE_SCRIPT" "/tmp" "book-id-search-web:test-root-resolution"

EXPECTED_SPACE_ROOT="$(cd "$SPACE_TMP" && pwd)"
ACTUAL_PWD="$(compose_seen_pwd "$RUN_TMP/$SCEN/fake-docker.log")"
if check_root_resolution_artifacts "TEST11_path_with_spaces" \
     "$EXPECTED_SPACE_ROOT" "$ACTUAL_PWD" \
     "$RUN_TMP/$SCEN/fake-docker.log" "$SPACE_TMP"; then
  if [ "$ACTUAL_PWD" = "$EXPECTED_SPACE_ROOT" ]; then
    assert_pass "TEST11_path_with_spaces (compose PWD=$ACTUAL_PWD)"
  else
    assert_fail "TEST11_path_with_spaces" \
      "compose PWD=$ACTUAL_PWD, expected $EXPECTED_SPACE_ROOT"
  fi
fi
rm -rf "$SPACE_TMP"

# ============================================================
# TEST 12: missing docker-compose.yml at resolved root fails closed
# ============================================================
MISSING_TMP="$RUN_TMP/test12_missing_compose"
rm -rf "$MISSING_TMP"
mkdir -p "$MISSING_TMP/scripts"
# Copy deploy script but NOT docker-compose.yml
cp "$DEPLOY_SCRIPT" "$MISSING_TMP/scripts/deploy-web-release-candidate.sh"

EXIT_FILE="$MISSING_TMP/exit.txt"
(
  cd "$MISSING_TMP"
  PATH="$RUN_TMP/bin:$PATH" \
    bash "$MISSING_TMP/scripts/deploy-web-release-candidate.sh" "book-id-search-web:test-root-resolution" \
    > "$MISSING_TMP/stdout.txt" 2> "$MISSING_TMP/stderr.txt"
  echo $? > "$EXIT_FILE"
)
EXIT_VAL="$(cat "$EXIT_FILE")"
# Expect exit 6 per the fail-closed root validation
if [ "$EXIT_VAL" = "6" ]; then
  assert_pass "TEST12_missing_compose_yml_fails_closed (exit=6)"
else
  assert_fail "TEST12_missing_compose_yml_fails_closed" \
    "expected exit 6, got exit=$EXIT_VAL"
fi
rm -rf "$MISSING_TMP"

# ============================================================
# TEST 13: false-positive regression (R2-5)
#
# Reproduces the exact failure mode observed in S27T-3B-R1: when
# fake-docker.log is absent, EXPECTED_RELO_ROOT and ACTUAL_PWD are both
# empty strings, and the original assertion `$ACTUAL_PWD = $EXPECTED_RELO_ROOT`
# matched `"" == ""` and reported a false-positive PASS.
#
# This test deliberately sets up an EMPTY fixture root and an EMPTY fake
# docker log. We then run the SAME guard logic that real root-resolution
# tests use (check_root_resolution_artifacts) and verify it returns
# non-zero (i.e. would have blocked a false-positive PASS).
#
# The guard itself calls assert_fail internally. To avoid polluting the
# regression total, we snapshot FAIL_COUNT and PASS_COUNT before invoking
# the guard and restore them after. We then meta-assert that the guard
# fired (FAIL delta = 1) AND that the regression total stays at zero.
# ============================================================
SCEN="test13_empty_fixture_false_positive_guard"
EMPTY_FIXTURE="$RUN_TMP/$SCEN/empty_relocated_root"
mkdir -p "$EMPTY_FIXTURE"
EMPTY_FAKE_LOG="$RUN_TMP/$SCEN/fake-docker.log"
: > "$EMPTY_FAKE_LOG"  # create empty log (no `PWD=` lines)

# Snapshot counters so we can verify the guard fired without polluting
# the regression total.
PRE_FAIL_COUNT="$FAIL_COUNT"
PRE_PASS_COUNT="$PASS_COUNT"

EXPECTED_RELO_ROOT="$(cd "$EMPTY_FIXTURE" && pwd)"
# Force expected to be empty too (delete fixture after cd)
rm -rf "$EMPTY_FIXTURE"
ACTUAL_PWD="$(compose_seen_pwd "$EMPTY_FAKE_LOG")"
EXPECTED_RELO_ROOT=""

# Run the guard. It SHOULD fire assert_fail and return 1.
if check_root_resolution_artifacts "TEST13_empty_fixture_false_positive_guard" \
     "$EXPECTED_RELO_ROOT" "$ACTUAL_PWD" \
     "$EMPTY_FAKE_LOG" "$EMPTY_FIXTURE"; then
  # Guard returned 0 → regression: guard didn't catch empty values.
  FAIL_COUNT="$PRE_FAIL_COUNT"
  PASS_COUNT="$PRE_PASS_COUNT"
  assert_fail "TEST13_empty_fixture_false_positive_guard" \
    "GUARD REGRESSED: empty expected/actual passed check_root_resolution_artifacts"
else
  # Guard correctly returned 1 (and called assert_fail internally).
  # Restore counters: the guard's assert_fail was EXPECTED.
  FAIL_COUNT="$PRE_FAIL_COUNT"
  PASS_COUNT="$PRE_PASS_COUNT"
  assert_pass "TEST13_empty_fixture_false_positive_guard (guard correctly returned non-zero on empty values; false-positive PASS path blocked)"
fi
rm -rf "$RUN_TMP/$SCEN"

# ============================================================
# Negative guard: never allow book-id-search/web:dev fallback
# ============================================================
# This guard runs after all tests. It asserts that across ALL scenarios,
# no scenario produced COMPOSE_SEEN_IMAGE matching the dev fallback.
DEV_FALLBACK="book-id-search/web:dev"
FOUND_DEV=0
for scen_dir in "$RUN_TMP"/test*; do
  [ -d "$scen_dir" ] || continue
  seen=$(grep '^COMPOSE_SEEN_IMAGE=' "$scen_dir/compose-seen-env.txt" 2>/dev/null | cut -d= -f2-)
  if [ "$seen" = "$DEV_FALLBACK" ]; then
    FOUND_DEV=1
    echo "  DEV_FALLBACK observed in $scen_dir" >&2
  fi
done
if [ "$FOUND_DEV" = "0" ]; then
  assert_pass "NEG_no_dev_fallback_observed"
else
  assert_fail "NEG_no_dev_fallback_observed" \
    "compose saw book-id-search/web:dev fallback in at least one scenario"
fi

# ============================================================
# Summary
# ============================================================
echo
echo "=========================================="
echo "TOTAL: PASS=$PASS_COUNT  FAIL=$FAIL_COUNT"
echo "=========================================="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL DETAILS:"
  for d in "${FAIL_DETAILS[@]}"; do
    echo "  - $d"
  done
  echo
  echo "RESULT: REGRESSION FAILED"
  exit 1
else
  echo "RESULT: REGRESSION PASSED"
  exit 0
fi