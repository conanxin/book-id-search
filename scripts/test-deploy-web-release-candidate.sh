#!/usr/bin/env bash
# S27T-0A regression test for scripts/deploy-web-release-candidate.sh
#
# Uses a fake command harness to safely reproduce the
# RELEASE_PIPELINE_ENV_PROPAGATION_INCIDENT observed during S27S-R2.
#
# This test does NOT touch real Docker, real production, or real compose.
# All commands exercised by the deploy script are intercepted by fake
# binaries in $TMP/bin (a docker shim and a sudo shim that simulates
# env_reset behavior).
#
# Tests:
#   TEST 1 — sudo env_reset reproduction: current script fails to deliver
#             BOOK_ID_SEARCH_WEB_IMAGE to docker compose.
#   TEST 2 — no-sudo path: candidate image override propagates.
#   TEST 3 — exact image identity: registry/path:tag survives unchanged.
#   TEST 4 — no build flag in compose invocation.
#   TEST 5 — no unexpected pull.
#   TEST 6 — missing candidate fails closed.
set -uo pipefail

# Locate repo and script under test
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEPLOY_SCRIPT="$APP_DIR/scripts/deploy-web-release-candidate.sh"

if [ ! -f "$DEPLOY_SCRIPT" ]; then
  echo "FATAL: deploy script not found at $DEPLOY_SCRIPT" >&2
  exit 99
fi

# Per-run working directory
RUN_TMP="$(mktemp -d -t s27t0a-XXXXXX)"
mkdir -p "$RUN_TMP/bin"

# Copy fake-bin scaffolding into RUN_TMP
SOURCE_BIN="${FAKE_BIN_SOURCE:-}"
if [ -z "$SOURCE_BIN" ] || [ ! -x "$SOURCE_BIN/sudo" ] || [ ! -x "$SOURCE_BIN/docker" ]; then
  echo "FATAL: FAKE_BIN_SOURCE must point to a dir containing fake sudo+docker" >&2
  exit 98
fi
cp "$SOURCE_BIN/sudo" "$RUN_TMP/bin/sudo"
cp "$SOURCE_BIN/docker" "$RUN_TMP/bin/docker"
chmod +x "$RUN_TMP/bin/sudo" "$RUN_TMP/bin/docker"

# Confirm the test harness will resolve docker/sudo via PATH (NOT the real ones)
RESOLVED_SUDO="$(PATH="$RUN_TMP/bin" command -v sudo)"
RESOLVED_DOCKER="$(PATH="$RUN_TMP/bin" command -v docker)"
if [ "$RESOLVED_SUDO" != "$RUN_TMP/bin/sudo" ] || [ "$RESOLVED_DOCKER" != "$RUN_TMP/bin/docker" ]; then
  echo "FATAL: fake harness not on PATH for child processes" >&2
  echo "  resolved sudo=$RESOLVED_SUDO" >&2
  echo "  resolved docker=$RESOLVED_DOCKER" >&2
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

  # Build environment to pass to the deploy script invocation
  local EXPORT_VARS=(
    "FAKE_SUDO_LOG=$SUDO_LOG"
    "FAKE_DOCKER_LOG=$DOCKER_LOG"
    "PATH=$RUN_TMP/bin:$PATH"
  )
  for kv in "${extra_env[@]}"; do
    EXPORT_VARS+=("$kv")
  done

  # Force DOCKER_SUDO detection: if expect_sudo="sudo", make `docker ps` FAIL
  # so the deploy script's detection sets DOCKER_SUDO="sudo". We'll achieve
  # this by prepending a tiny wrapper script to PATH that shadows `docker`
  # *only* for the detection phase. Simplest: set a flag env var that the
  # fake-docker itself checks. But to keep fake-docker simple, we use a
  # second wrapper inside $RUN_TMP/bin that overrides ONLY for `docker ps`.
  #
  # Approach: create $SCEN_TMP/bin that re-exports docker depending on need.
  # To keep this simple, we use the existing fake-docker and instead force
  # DOCKER_SUDO via a known flag. The deploy script reads DOCKER_SUDO only
  # via its own detection. To make detection reproducible, we'll create a
  # directory $SCEN_TMP/bin that:
  #   - contains a `docker` shim that exits 0 on `docker ps` for the nosudo
  #     scenario, and exits non-zero (with sudo required) for the sudo scenario.
  #   - delegates all other docker subcommands to the standard fake-docker
  #     from RUN_TMP/bin/docker.
  # Simpler: we use the standard fake-docker for both (which always says
  # `docker ps` exits 0 → DOCKER_SUDO=""). For the "sudo" scenario we
  # intentionally override DOCKER_SUDO via a sentinel approach: we put a
  # tiny `docker` shim in $SCEN_TMP/bin that fails `docker ps` so detection
  # sets DOCKER_SUDO="sudo", and delegates everything else to the standard
  # fake-docker.
  mkdir -p "$SCEN_TMP/bin"
  cat > "$SCEN_TMP/bin/docker" <<EOSUDOCHECK
#!/usr/bin/env bash
# scenario docker: `docker ps` exits 1 (forces DOCKER_SUDO="sudo" detection)
# everything else delegates to the standard fake-docker.
if [ "\$1" = "ps" ] && [ "\$#" -eq 1 ]; then
  echo "FAKE: docker ps denied (scenario=$scenario_name)" >&2
  exit 1
fi
exec "$RUN_TMP/bin/docker" "\$@"
EOSUDOCHECK
  chmod +x "$SCEN_TMP/bin/docker"

  # PATH for the deploy script = SCEN_TMP/bin first (so detection sees this docker),
  # then RUN_TMP/bin (so subsequent docker commands use the real fake docker).
  # For the "nosudo" scenario we want detection to succeed, so we need the
  # SCEN_TMP/bin docker to ALLOW docker ps. Override per-scenario below.
  if [ "$expect_sudo" = "nosudo" ]; then
    cat > "$SCEN_TMP/bin/docker" <<EONOSUDO
#!/usr/bin/env bash
# scenario docker: all calls pass through to standard fake-docker
exec "$RUN_TMP/bin/docker" "\$@"
EONOSUDO
    chmod +x "$SCEN_TMP/bin/docker"
  fi

  # Set up compose-seen log path
  local COMPOSE_SEEN_LOG="$SCEN_TMP/compose-seen-env.txt"
  : > "$COMPOSE_SEEN_LOG"

  # Patch FAKE_DOCKER_LOG via a per-scenario override so we can capture
  # exactly what the deploy script's docker compose call saw. We use an
  # env-var trick: extend FAKE_DOCKER_LOG to also tee into COMPOSE_SEEN_LOG.
  local DOCKER_LOG_AND_SEEN="$DOCKER_LOG"
  # Use the docker log directly; we'll grep it after the run.

  # Run the deploy script under the controlled environment.
  (
    cd "$APP_DIR"
    env "${EXPORT_VARS[@]}" \
      PATH="$SCEN_TMP/bin:$RUN_TMP/bin:$PATH" \
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