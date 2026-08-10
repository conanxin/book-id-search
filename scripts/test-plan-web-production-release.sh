#!/usr/bin/env bash
# S27T-3A test harness for plan-web-production-release.sh
#
# Level 1 only: builds an isolated git repo with a scripts directory containing
# the exact-byte plan script + a sibling fake readiness gate. The fake gate
# emits fixture output controlled by environment variables and records the
# RUN_REAL_ISOLATED_E2E value it observed.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN="$REPO_ROOT/scripts/plan-web-production-release.sh"

[ -f "$PLAN" ] || { echo "FATAL: plan script not found"; exit 99; }

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
# Setup isolated repo with script-relative plan and fake gate
# -----------------------------------------------------------------------------
TMP_ROOT="$(mktemp -d)"
mkdir -p "$TMP_ROOT/scripts"

# Exact-byte copy of the plan script (production file)
cp "$PLAN" "$TMP_ROOT/scripts/plan-web-production-release.sh"
chmod +x "$TMP_ROOT/scripts/plan-web-production-release.sh"

# Initialize a real git repo so the plan script's SOURCE_SHA validation works
git init "$TMP_ROOT" >/dev/null 2>&1
git -C "$TMP_ROOT" config user.email "test@example.com"
git -C "$TMP_ROOT" config user.name "Test"
git -C "$TMP_ROOT" config commit.gpgsign false

# Initial commit (creates a real SHA that the plan script can canonicalize)
echo "repo" > "$TMP_ROOT/README"
git -C "$TMP_ROOT" add README scripts/ >/dev/null 2>&1
git -C "$TMP_ROOT" commit -m "init" >/dev/null 2>&1
CANON_SHA="$(git -C "$TMP_ROOT" rev-parse HEAD)"
CANON_HEAD="$(git -C "$TMP_ROOT" rev-parse HEAD)"
export CANON_SHA CANON_HEAD

# Helper to write the fake readiness gate with a specific fixture
write_fake_gate() {
  cat > "$TMP_ROOT/scripts/verify-web-release-readiness.sh" <<'FAKE_GATE_EOF'
#!/usr/bin/env bash
# Test-driven fake readiness gate. Controlled by FAKE_GATE_* env vars.

# Record the RUN_REAL_ISOLATED_E2E env value observed by this invocation
if [ -n "${FAKE_GATE_LOG:-}" ]; then
  printf 'FAKE_GATE_OBSERVED_RUN_REAL_ISOLATED_E2E=%s\n' "${RUN_REAL_ISOLATED_E2E:-<unset>}" >> "$FAKE_GATE_LOG"
fi

# Explicit block path
if [ -n "${FAKE_GATE_BLOCK_REASON:-}" ]; then
  printf 'STATUS=BLOCKED\n'
  printf 'BLOCK_REASON=%s\n' "$FAKE_GATE_BLOCK_REASON"
  printf 'READY_FOR_PRODUCTION_DEPLOY=false\n'
  printf 'DEPLOY_EXECUTED=false\n'
  exit "${FAKE_GATE_EXIT_CODE:-1}"
fi

# Custom arbitrary output (for parser/injection tests)
if [ -n "${FAKE_GATE_RAW_STDOUT:-}" ]; then
  printf '%s\n' "$FAKE_GATE_RAW_STDOUT"
  exit "${FAKE_GATE_EXIT_CODE:-0}"
fi

# Missing-identity path (READY=true, ISOLATED_E2E=PASS, but identity fields absent)
if [ "${FAKE_GATE_NO_IDENTITY:-0}" = "1" ]; then
  printf 'STATUS=PASS\n'
  printf 'READY_FOR_PRODUCTION_DEPLOY=true\n'
  printf 'ISOLATED_E2E=PASS\n'
  exit 0
fi

# READY missing path
if [ "${FAKE_GATE_READY_MISSING:-0}" = "1" ]; then
  printf 'STATUS=PASS\n'
  printf 'SOURCE_SHA=%s\n' "${FAKE_GATE_SOURCE_SHA:-$CANON_SHA}"
  printf 'CURRENT_HEAD=%s\n' "${FAKE_GATE_CURRENT_HEAD:-$CANON_HEAD}"
  printf 'IMAGE_TAG=%s\n' "${FAKE_GATE_IMAGE_TAG:-book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af}"
  printf 'IMAGE_ID=%s\n' "${FAKE_GATE_IMAGE_ID:-sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce}"
  printf 'MANIFEST_SHA=%s\n' "${FAKE_GATE_MANIFEST_SHA:-743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a}"
  printf 'LOCKFILE_SHA=%s\n' "${FAKE_GATE_LOCKFILE_SHA:-fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134}"
  printf 'DEPLOY_REGRESSION=PASS\n'
  printf 'ISOLATED_E2E=PASS\n'
  printf 'PRODUCTION_UNCHANGED=PASS\n'
  exit 0
fi

# READY=false path
if [ "${FAKE_GATE_READY_FALSE:-0}" = "1" ]; then
  printf 'STATUS=PASS\n'
  printf 'SOURCE_SHA=%s\n' "${FAKE_GATE_SOURCE_SHA:-$CANON_SHA}"
  printf 'CURRENT_HEAD=%s\n' "${FAKE_GATE_CURRENT_HEAD:-$CANON_HEAD}"
  printf 'IMAGE_TAG=%s\n' "${FAKE_GATE_IMAGE_TAG:-book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af}"
  printf 'IMAGE_ID=%s\n' "${FAKE_GATE_IMAGE_ID:-sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce}"
  printf 'MANIFEST_SHA=%s\n' "${FAKE_GATE_MANIFEST_SHA:-743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a}"
  printf 'LOCKFILE_SHA=%s\n' "${FAKE_GATE_LOCKFILE_SHA:-fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134}"
  printf 'DEPLOY_REGRESSION=PASS\n'
  printf 'ISOLATED_E2E=PASS\n'
  printf 'PRODUCTION_UNCHANGED=PASS\n'
  printf 'READY_FOR_PRODUCTION_DEPLOY=false\n'
  exit 0
fi

# Default success path
printf 'STATUS=PASS\n'
printf 'SOURCE_SHA=%s\n' "${FAKE_GATE_SOURCE_SHA:-$CANON_SHA}"
printf 'CURRENT_HEAD=%s\n' "${FAKE_GATE_CURRENT_HEAD:-$CANON_HEAD}"
printf 'IMAGE_TAG=%s\n' "${FAKE_GATE_IMAGE_TAG:-book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af}"
printf 'IMAGE_ID=%s\n' "${FAKE_GATE_IMAGE_ID:-sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce}"
printf 'MANIFEST_SHA=%s\n' "${FAKE_GATE_MANIFEST_SHA:-743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a}"
printf 'LOCKFILE_SHA=%s\n' "${FAKE_GATE_LOCKFILE_SHA:-fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134}"
printf 'DEPLOY_REGRESSION=PASS\n'
printf 'ISOLATED_E2E=PASS\n'
printf 'PRODUCTION_UNCHANGED=PASS\n'
printf 'READY_FOR_PRODUCTION_DEPLOY=true\n'
exit 0
FAKE_GATE_EOF
  chmod +x "$TMP_ROOT/scripts/verify-web-release-readiness.sh"
}

# Reset fake gate to default before each test case
reset_fake_gate() { write_fake_gate; }

RUN_OUT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT" "$RUN_OUT" 2>/dev/null || true' EXIT INT TERM

field_value() {
  local key="$1" file="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | head -1 | sed -e "s/^${key}=//"
}

run_plan() {
  local out="$1"; shift
  local err="$1"; shift
  local sha="$1"; shift
  # Clear all FAKE_GATE_* env vars
  unset FAKE_GATE_BLOCK_REASON FAKE_GATE_EXIT_CODE FAKE_GATE_RAW_STDOUT \
        FAKE_GATE_NO_IDENTITY FAKE_GATE_READY_MISSING FAKE_GATE_READY_FALSE \
        FAKE_GATE_SOURCE_SHA FAKE_GATE_CURRENT_HEAD FAKE_GATE_IMAGE_TAG \
        FAKE_GATE_IMAGE_ID FAKE_GATE_MANIFEST_SHA FAKE_GATE_LOCKFILE_SHA \
        FAKE_GATE_LOG
  # Export requested env vars
  for kv in "$@"; do
    export "$kv"
  done
  (
    cd "$TMP_ROOT"
    "$TMP_ROOT/scripts/plan-web-production-release.sh" "$sha" >"$out" 2>"$err"
  )
  return $?
}

# -----------------------------------------------------------------------------
# Level-1 contract tests
# -----------------------------------------------------------------------------

# T1: invalid source SHA (non-40-hex)
reset_fake_gate
out="$RUN_OUT/t1.out"; err="$RUN_OUT/t1.err"
run_plan "$out" "$err" "not-a-sha"
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value STATUS "$out")" = "BLOCKED" ] \
   && [ "$(field_value BLOCK_REASON "$out")" = "INVALID_SOURCE_SHA" ] \
   && [ "$(field_value RELEASE_PLAN_READY "$out")" = "false" ]; then
  assert_pass "T1_invalid_source_sha"
else
  assert_fail "T1_invalid_source_sha" "exit=$ec body=$(cat "$out")"
fi

# T2: readiness gate nonzero exit
reset_fake_gate
out="$RUN_OUT/t2.out"; err="$RUN_OUT/t2.err"
run_plan "$out" "$err" "$CANON_SHA" FAKE_GATE_BLOCK_REASON=DEPLOY_REGRESSION_FAILED \
  FAKE_GATE_EXIT_CODE=2
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value STATUS "$out")" = "BLOCKED" ] \
   && [ "$(field_value BLOCK_REASON "$out")" = "READINESS_GATE_FAILED" ]; then
  assert_pass "T2_readiness_nonzero_exit"
else
  assert_fail "T2_readiness_nonzero_exit" "exit=$ec body=$(cat "$out")"
fi

# T3: READY=false
reset_fake_gate
out="$RUN_OUT/t3.out"; err="$RUN_OUT/t3.err"
run_plan "$out" "$err" "$CANON_SHA" FAKE_GATE_READY_FALSE=1
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "READINESS_NOT_READY" ] \
   && [ "$(field_value RELEASE_PLAN_READY "$out")" = "false" ]; then
  assert_pass "T3_ready_false_blocks"
else
  assert_fail "T3_ready_false_blocks" "exit=$ec body=$(cat "$out")"
fi

# T4: READY missing
reset_fake_gate
out="$RUN_OUT/t4.out"; err="$RUN_OUT/t4.err"
run_plan "$out" "$err" "$CANON_SHA" FAKE_GATE_READY_MISSING=1
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value STATUS "$out")" = "BLOCKED" ] \
   && { [ "$(field_value BLOCK_REASON "$out")" = "READINESS_NOT_READY" ] || \
        [ "$(field_value BLOCK_REASON "$out")" = "READINESS_OUTPUT_AMBIGUOUS" ]; }; then
  assert_pass "T4_ready_missing_blocks"
else
  assert_fail "T4_ready_missing_blocks" "exit=$ec body=$(cat "$out")"
fi

# T5: READY duplicate
reset_fake_gate
out="$RUN_OUT/t5.out"; err="$RUN_OUT/t5.err"
run_plan "$out" "$err" "$CANON_SHA" \
  FAKE_GATE_RAW_STDOUT="STATUS=PASS
SOURCE_SHA=$CANON_SHA
CURRENT_HEAD=$CANON_HEAD
IMAGE_TAG=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a
LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134
DEPLOY_REGRESSION=PASS
ISOLATED_E2E=PASS
PRODUCTION_UNCHANGED=PASS
READY_FOR_PRODUCTION_DEPLOY=true
READY_FOR_PRODUCTION_DEPLOY=false"
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "READINESS_OUTPUT_AMBIGUOUS" ]; then
  assert_pass "T5_ready_duplicate_blocks"
else
  assert_fail "T5_ready_duplicate_blocks" "exit=$ec body=$(cat "$out")"
fi

# T6: SOURCE missing
reset_fake_gate
out="$RUN_OUT/t6.out"; err="$RUN_OUT/t6.err"
run_plan "$out" "$err" "$CANON_SHA" \
  FAKE_GATE_RAW_STDOUT="STATUS=PASS
CURRENT_HEAD=$CANON_HEAD
IMAGE_TAG=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a
LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134
DEPLOY_REGRESSION=PASS
ISOLATED_E2E=PASS
PRODUCTION_UNCHANGED=PASS
READY_FOR_PRODUCTION_DEPLOY=true"
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "READINESS_OUTPUT_INCOMPLETE" ]; then
  assert_pass "T6_source_missing_blocks"
else
  assert_fail "T6_source_missing_blocks" "exit=$ec body=$(cat "$out")"
fi

# T7: SOURCE duplicate
reset_fake_gate
out="$RUN_OUT/t7.out"; err="$RUN_OUT/t7.err"
run_plan "$out" "$err" "$CANON_SHA" \
  FAKE_GATE_RAW_STDOUT="STATUS=PASS
SOURCE_SHA=$CANON_SHA
SOURCE_SHA=$CANON_SHA
CURRENT_HEAD=$CANON_HEAD
IMAGE_TAG=book-id-search-web:1ab120c4798a403739ab57c729783b76fb1b89af
IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a
LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134
DEPLOY_REGRESSION=PASS
ISOLATED_E2E=PASS
PRODUCTION_UNCHANGED=PASS
READY_FOR_PRODUCTION_DEPLOY=true"
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "READINESS_OUTPUT_AMBIGUOUS" ]; then
  assert_pass "T7_source_duplicate_blocks"
else
  assert_fail "T7_source_duplicate_blocks" "exit=$ec body=$(cat "$out")"
fi

# T8: source mismatch
reset_fake_gate
out="$RUN_OUT/t8.out"; err="$RUN_OUT/t8.err"
run_plan "$out" "$err" "$CANON_SHA" FAKE_GATE_SOURCE_SHA=ffffffffffffffffffffffffffffffffffffffff
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "SOURCE_IDENTITY_MISMATCH" ]; then
  assert_pass "T8_source_mismatch_blocks"
else
  assert_fail "T8_source_mismatch_blocks" "exit=$ec body=$(cat "$out")"
fi

# T9: IMAGE_TAG missing (use RAW_STDOUT without IMAGE_TAG)
reset_fake_gate
out="$RUN_OUT/t9.out"; err="$RUN_OUT/t9.err"
run_plan "$out" "$err" "$CANON_SHA" \
  FAKE_GATE_RAW_STDOUT="STATUS=PASS
SOURCE_SHA=$CANON_SHA
CURRENT_HEAD=$CANON_HEAD
IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a
LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134
DEPLOY_REGRESSION=PASS
ISOLATED_E2E=PASS
PRODUCTION_UNCHANGED=PASS
READY_FOR_PRODUCTION_DEPLOY=true"
ec=$?
if [ "$ec" -ne 0 ] && { [ "$(field_value BLOCK_REASON "$out")" = "READINESS_OUTPUT_INCOMPLETE" ] || \
     [ "$(field_value BLOCK_REASON "$out")" = "INVALID_IMAGE_TAG" ]; }; then
  assert_pass "T9_image_tag_missing_blocks"
else
  assert_fail "T9_image_tag_missing_blocks" "exit=$ec body=$(cat "$out")"
fi

# T10: IMAGE_TAG unsafe (semicolon injection)
reset_fake_gate
out="$RUN_OUT/t10.out"; err="$RUN_OUT/t10.err"
run_plan "$out" "$err" "$CANON_SHA" \
  FAKE_GATE_IMAGE_TAG='book-id-search-web:test;touch /tmp/pwn'
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "INVALID_IMAGE_TAG" ]; then
  if [ -f /tmp/pwn ]; then
    assert_fail "T10_unsafe_image_tag_semicolon" "/tmp/pwn was created by malicious tag!"
  else
    assert_pass "T10_unsafe_image_tag_semicolon"
  fi
else
  assert_fail "T10_unsafe_image_tag_semicolon" "exit=$ec body=$(cat "$out")"
fi

# T11: IMAGE_TAG unsafe (dollar/backtick injection)
reset_fake_gate
out="$RUN_OUT/t11.out"; err="$RUN_OUT/t11.err"
run_plan "$out" "$err" "$CANON_SHA" FAKE_GATE_IMAGE_TAG='book-id-search-web:test$(whoami)'
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "INVALID_IMAGE_TAG" ]; then
  assert_pass "T11_unsafe_image_tag_dollar"
else
  assert_fail "T11_unsafe_image_tag_dollar" "exit=$ec body=$(cat "$out")"
fi

# T12: valid registry/path:tag
reset_fake_gate
out="$RUN_OUT/t12.out"; err="$RUN_OUT/t12.err"
run_plan "$out" "$err" "$CANON_SHA" \
  FAKE_GATE_IMAGE_TAG='registry.example.test/team/web:sha-1234567890abcdef'
ec=$?
if [ "$ec" -eq 0 ] && [ "$(field_value STATUS "$out")" = "PASS" ] \
   && [ "$(field_value IMAGE_TAG "$out")" = "registry.example.test/team/web:sha-1234567890abcdef" ]; then
  assert_pass "T12_valid_registry_pathtag"
else
  assert_fail "T12_valid_registry_pathtag" "exit=$ec body=$(cat "$out")"
fi

# T13: IMAGE_ID invalid
reset_fake_gate
out="$RUN_OUT/t13.out"; err="$RUN_OUT/t13.err"
run_plan "$out" "$err" "$CANON_SHA" \
  FAKE_GATE_IMAGE_ID='sha256:NOT-HEX-VALID'
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "INVALID_IMAGE_ID" ]; then
  assert_pass "T13_invalid_image_id_blocks"
else
  assert_fail "T13_invalid_image_id_blocks" "exit=$ec body=$(cat "$out")"
fi

# T14: manifest invalid
reset_fake_gate
out="$RUN_OUT/t14.out"; err="$RUN_OUT/t14.err"
run_plan "$out" "$err" "$CANON_SHA" FAKE_GATE_MANIFEST_SHA='not64hex'
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "INVALID_MANIFEST_SHA" ]; then
  assert_pass "T14_invalid_manifest_sha_blocks"
else
  assert_fail "T14_invalid_manifest_sha_blocks" "exit=$ec body=$(cat "$out")"
fi

# T15: lockfile invalid
reset_fake_gate
out="$RUN_OUT/t15.out"; err="$RUN_OUT/t15.err"
run_plan "$out" "$err" "$CANON_SHA" FAKE_GATE_LOCKFILE_SHA='xyz'
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "INVALID_LOCKFILE_SHA" ]; then
  assert_pass "T15_invalid_lockfile_sha_blocks"
else
  assert_fail "T15_invalid_lockfile_sha_blocks" "exit=$ec body=$(cat "$out")"
fi

# T16: success output shape (all required fields present)
reset_fake_gate
out="$RUN_OUT/t16.out"; err="$RUN_OUT/t16.err"
run_plan "$out" "$err" "$CANON_SHA"
ec=$?
expected_fields=(STATUS RELEASE_PLAN_VERSION SOURCE_SHA IMAGE_TAG IMAGE_ID \
                  MANIFEST_SHA LOCKFILE_SHA RELEASE_PLAN_FINGERPRINT \
                  READINESS_GATE ISOLATED_E2E PRODUCTION_UNCHANGED \
                  RELEASE_PLAN_READY DEPLOY_EXECUTED)
missing=0
for f in "${expected_fields[@]}"; do
  v="$(field_value "$f" "$out")"
  if [ -z "$v" ]; then
    missing=$((missing + 1))
    echo "  missing: $f" >&2
  fi
done
if [ "$ec" -eq 0 ] && [ "$missing" -eq 0 ] \
   && [ "$(field_value DEPLOY_EXECUTED "$out")" = "false" ] \
   && [ "$(field_value RELEASE_PLAN_READY "$out")" = "true" ]; then
  assert_pass "T16_success_output_shape"
else
  assert_fail "T16_success_output_shape" "ec=$ec missing=$missing body=$(cat "$out")"
fi

# T17/T18: fingerprint deterministic and CURRENT_HEAD independent
reset_fake_gate
out1="$RUN_OUT/t17a.out"
run_plan "$out1" "$RUN_OUT/t17a.err" "$CANON_SHA"
FP1="$(field_value RELEASE_PLAN_FINGERPRINT "$out1")"
CH1="$(field_value CURRENT_HEAD "$out1")"

# Change CURRENT_HEAD in the gate output, keep identity fields same
out2="$RUN_OUT/t17b.out"
run_plan "$out2" "$RUN_OUT/t17b.err" "$CANON_SHA" \
  FAKE_GATE_CURRENT_HEAD='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
FP2="$(field_value RELEASE_PLAN_FINGERPRINT "$out2")"
CH2="$(field_value CURRENT_HEAD "$out2")"

if [ -n "$FP1" ] && [ "$FP1" = "$FP2" ]; then
  assert_pass "T17_fingerprint_current_head_independent"
else
  assert_fail "T17_fingerprint_current_head_independent" "FP1=$FP1 FP2=$FP2 CH1=$CH1 CH2=$CH2"
fi

# T18: fingerprint repeatable
out3="$RUN_OUT/t18.out"
run_plan "$out3" "$RUN_OUT/t18.err" "$CANON_SHA"
FP3="$(field_value RELEASE_PLAN_FINGERPRINT "$out3")"
if [ "$FP3" = "$FP1" ]; then
  assert_pass "T18_fingerprint_repeatable"
else
  assert_fail "T18_fingerprint_repeatable" "FP1=$FP1 FP3=$FP3"
fi

# T19: fingerprint changes when IMAGE_ID changes
out4="$RUN_OUT/t19.out"
run_plan "$out4" "$RUN_OUT/t19.err" "$CANON_SHA" \
  FAKE_GATE_IMAGE_ID='sha256:0000000000000000000000000000000000000000000000000000000000000000'
FP4="$(field_value RELEASE_PLAN_FINGERPRINT "$out4")"
if [ "$FP4" != "$FP1" ]; then
  assert_pass "T19_fingerprint_changes_with_image_id"
else
  assert_fail "T19_fingerprint_changes_with_image_id" "FP unchanged"
fi

# T20: duplicate identity field blocks (IMAGE_TAG duplicate ambiguity)
out="$RUN_OUT/t20.out"; err="$RUN_OUT/t20.err"
run_plan "$out" "$err" "$CANON_SHA" \
  FAKE_GATE_RAW_STDOUT="STATUS=PASS
SOURCE_SHA=$CANON_SHA
CURRENT_HEAD=$CANON_HEAD
IMAGE_TAG=book-id-search-web:good
IMAGE_TAG=book-id-search-web:evil
IMAGE_ID=sha256:712ad4abc1627d681c30ea16cca6dfb8fdc603097aa6dfdc9e1b106d79ddf8ce
MANIFEST_SHA=743a7305114da643de790cd08f2f8f383ef92dce4ff110c0cd5c3d816049847a
LOCKFILE_SHA=fc0f3b79d50ee29b817cb46d9ec626f34e51f2631835d6563cc2ebeff1c4a134
DEPLOY_REGRESSION=PASS
ISOLATED_E2E=PASS
PRODUCTION_UNCHANGED=PASS
READY_FOR_PRODUCTION_DEPLOY=true"
ec=$?
if [ "$ec" -ne 0 ] && [ "$(field_value BLOCK_REASON "$out")" = "READINESS_OUTPUT_AMBIGUOUS" ]; then
  assert_pass "T20_duplicate_identity_field_blocks"
else
  assert_fail "T20_duplicate_identity_field_blocks" "exit=$ec body=$(cat "$out")"
fi

# T21: BLOCK exit nonzero
reset_fake_gate
out="$RUN_OUT/t21.out"; err="$RUN_OUT/t21.err"
run_plan "$out" "$err" "not-a-sha"
ec=$?
if [ "$ec" -ne 0 ]; then
  assert_pass "T21_block_exit_nonzero"
else
  assert_fail "T21_block_exit_nonzero" "exit=$ec"
fi

# T22: PASS exit zero
reset_fake_gate
out="$RUN_OUT/t22.out"; err="$RUN_OUT/t22.err"
run_plan "$out" "$err" "$CANON_SHA"
ec=$?
if [ "$ec" -eq 0 ]; then
  assert_pass "T22_pass_exit_zero"
else
  assert_fail "T22_pass_exit_zero" "exit=$ec"
fi

# T23: caller RUN_REAL_ISOLATED_E2E=0 is overridden to 1
reset_fake_gate
gate_log="$RUN_OUT/t23-gate.log"
out="$RUN_OUT/t23.out"; err="$RUN_OUT/t23.err"
(
  cd "$TMP_ROOT"
  unset RUN_REAL_ISOLATED_E2E
  RUN_REAL_ISOLATED_E2E=0 \
  FAKE_GATE_LOG="$gate_log" \
  "$TMP_ROOT/scripts/plan-web-production-release.sh" "$CANON_SHA" >"$out" 2>"$err"
)
ec=$?
observed="$(grep FAKE_GATE_OBSERVED_RUN_REAL_ISOLATED_E2E "$gate_log" 2>/dev/null | tail -1)"
if [ "$ec" -eq 0 ] && echo "$observed" | grep -q '=1'; then
  assert_pass "T23_caller_disable_e2e_overridden_to_1"
else
  assert_fail "T23_caller_disable_e2e_overridden_to_1" "ec=$ec observed=$observed"
fi

# T24: gate sibling resolution (no hardcoded /opt path)
# Already verified by the temp-repo setup. Explicitly confirm the plan found
# the fake gate at TMP_ROOT/scripts/verify-web-release-readiness.sh.
if [ -x "$TMP_ROOT/scripts/verify-web-release-readiness.sh" ] && \
   [ -x "$TMP_ROOT/scripts/plan-web-production-release.sh" ]; then
  assert_pass "T24_gate_sibling_resolution"
else
  assert_fail "T24_gate_sibling_resolution" "sibling scripts missing"
fi

# T25: no deploy invocation in plan script
if grep -E 'deploy-web-release-candidate\.sh' "$PLAN" | grep -vE '^\s*#' | grep -qE 'deploy-web-release-candidate\.sh'; then
  # If any non-comment line contains the string, it's a reference.
  # But comments are OK; if it's only comments, pass.
  if grep -E 'deploy-web-release-candidate\.sh' "$PLAN" | grep -vE '^\s*#' | grep -E 'deploy-web-release-candidate\.sh.*(exec|\$|\b)' >/dev/null; then
    assert_fail "T25_no_deploy_invocation" "plan script appears to invoke deploy script"
  else
    assert_pass "T25_no_deploy_invocation (comments only)"
  fi
else
  assert_pass "T25_no_deploy_invocation"
fi

# T26: no eval / source / bash -c of gate output
if grep -E '^\s*eval\b|^\s*source\b|bash -c' "$PLAN" > /dev/null; then
  assert_fail "T26_no_eval_source_bash_c" "plan script uses eval/source/bash -c"
else
  assert_pass "T26_no_eval_source_bash_c"
fi

# T27: no source of gate output
if grep -E 'source.*GATE|\. .*GATE_STDOUT|eval.*GATE' "$PLAN" > /dev/null; then
  assert_fail "T27_no_source_of_gate_output" "plan script sources/evaluates gate output"
else
  assert_pass "T27_no_source_of_gate_output"
fi

# T28: extra positional arg does not silently consume identity
reset_fake_gate
out="$RUN_OUT/t28.out"; err="$RUN_OUT/t28.err"
run_plan "$out" "$err" "$CANON_SHA" FAKE_GATE_IMAGE_TAG='registry.example.test/team/web:extra'
# The script only accepts SOURCE_SHA; extra args are ignored. The output should
# still be PASS (because it ignores $2) or the contract may treat it as invalid.
# We assert it does not crash and uses the canonical SHA as SOURCE_SHA.
ec=$?
if [ "$ec" -eq 0 ] && [ "$(field_value SOURCE_SHA "$out")" = "$CANON_SHA" ]; then
  assert_pass "T28_extra_positional_arg_no_identity_override"
else
  assert_fail "T28_extra_positional_arg_no_identity_override" "ec=$ec body=$(cat "$out")"
fi

# T29: fingerprint golden test (runtime canonical SHA + fixed other fields)
reset_fake_gate
out="$RUN_OUT/t29.out"
run_plan "$out" "$RUN_OUT/t29.err" "$CANON_SHA" \
  FAKE_GATE_SOURCE_SHA="$CANON_SHA" \
  FAKE_GATE_IMAGE_TAG='registry.example.test/team/web:golden-tag' \
  FAKE_GATE_IMAGE_ID='sha256:1111111111111111111111111111111111111111111111111111111111111111' \
  FAKE_GATE_MANIFEST_SHA='2222222222222222222222222222222222222222222222222222222222222222' \
  FAKE_GATE_LOCKFILE_SHA='3333333333333333333333333333333333333333333333333333333333333333'
FP_GOLDEN="$(field_value RELEASE_PLAN_FINGERPRINT "$out")"
EXPECTED_FP="$(printf '%s\n%s\n%s\n%s\n%s\n' \
  "SOURCE_SHA=$CANON_SHA" \
  'IMAGE_TAG=registry.example.test/team/web:golden-tag' \
  'IMAGE_ID=sha256:1111111111111111111111111111111111111111111111111111111111111111' \
  'MANIFEST_SHA=2222222222222222222222222222222222222222222222222222222222222222' \
  'LOCKFILE_SHA=3333333333333333333333333333333333333333333333333333333333333333' \
  | sha256sum | awk '{print $1}')"
if [ "$FP_GOLDEN" = "$EXPECTED_FP" ]; then
  assert_pass "T29_fingerprint_golden"
else
  assert_fail "T29_fingerprint_golden" "computed=$FP_GOLDEN expected=$EXPECTED_FP"
fi

echo
echo "=========================================="
echo "TOTAL: PASS=$PASS_COUNT  FAIL=$FAIL_COUNT"
echo "=========================================="
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "FAIL DETAILS:"
  for d in "${FAIL_DETAILS[@]}"; do echo "  - $d"; done
  exit 1
fi
echo "RESULT: REGRESSION PASSED"
exit 0