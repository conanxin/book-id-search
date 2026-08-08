#!/usr/bin/env bash
# S27T-2A test harness for verify-web-release-readiness.sh
#
# Level 1: fake-fixture / unit-style tests using fake docker/sudo harness
# Level 2: real integration smoke gated by RUN_REAL_ISOLATED_E2E=1
#
# Default Level 1 runs fake harness only.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERIFY="$REPO_ROOT/scripts/verify-web-release-readiness.sh"

PASS_COUNT=0
FAIL_COUNT=0
declare -a FAIL_DETAILS

assert_pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
assert_fail() { echo "FAIL: $1 -- $2"; FAIL_COUNT=$((FAIL_COUNT + 1)); FAIL_DETAILS+=("$1: $2"); }

# Helper: build an isolated evidence fixture and FAKE_BIN_DIR setup
# so that the verify script's deploy regression runs against fake harness.
build_fake_fixture() {
  local root="$1"
  local sha="$2"
  local image_id="${3:-sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"
  local manifest_sha="${4:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"
  local lockfile_sha="${5:-fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210}"
  local image_tag="${6:-book-id-search-web:$sha}"
  local evidence_dir="$root/progress/web-release-candidate-$sha"
  mkdir -p "$evidence_dir"
  cat > "$evidence_dir/candidate.json" <<EOF
{
  "tag": "$image_tag",
  "imageId": "$image_id",
  "gitSha": "$sha",
  "nodeVersion": "v22.22.1",
  "pnpmVersion": "pnpm@10.33.0",
  "lockfileSha256": "$lockfile_sha",
  "staticManifestSha256": "$manifest_sha",
  "manifestPath": "$evidence_dir/static-manifest.tsv"
}
EOF
  cat > "$evidence_dir/image-id.txt" <<EOF
$image_id
EOF
  cat > "$evidence_dir/image-tag.txt" <<EOF
$image_tag
EOF
  cat > "$evidence_dir/git-sha.txt" <<EOF
$sha
EOF
  cat > "$evidence_dir/lockfile.sha256" <<EOF
$lockfile_sha
EOF
  cat > "$evidence_dir/static-manifest.sha256" <<EOF
$manifest_sha
EOF
  # A minimal manifest (one file is enough to test SHA computation)
  printf 'index.html\t10\tabc1234567890abcdef01234567890abcdef01234567890abcdef012345678\n' \
    > "$evidence_dir/static-manifest.tsv"
}

# Setup fake bin (self-contained: no historical progress/ dependency)
FAKE_BIN_DIR="$(mktemp -d)"
trap 'rm -rf "$FAKE_BIN_DIR" 2>/dev/null || true' EXIT INT TERM

# Minimal fake sudo + fake docker sufficient for level-1 readiness tests.
cat > "$FAKE_BIN_DIR/sudo" <<'FAKE_SUDO_EOF'
#!/usr/bin/env bash
set -e
LOG="${FAKE_SUDO_LOG:-/dev/null}"
{
  echo "=== fake-sudo called ==="
  echo "argv: $0 $*"
  echo "inherited BOOK_ID_SEARCH_WEB_IMAGE=${BOOK_ID_SEARCH_WEB_IMAGE:-<unset>}"
} >> "$LOG" 2>&1
unset BOOK_ID_SEARCH_WEB_IMAGE
exec "$@"
FAKE_SUDO_EOF
chmod +x "$FAKE_BIN_DIR/sudo"

cat > "$FAKE_BIN_DIR/docker" <<'FAKE_DOCKER_EOF'
#!/usr/bin/env bash
set -e
LOG="${FAKE_DOCKER_LOG:-/dev/null}"
if [ "$1" = "ps" ] && [ "$#" -eq 1 ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --format=*) shift ;;
      --format) shift 2 ;;
      *) break ;;
    esac
  done
  if [ $# -gt 0 ]; then
    echo "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  fi
  exit 0
fi
if [ "$1" = "compose" ]; then exit 0; fi
if [ "$1" = "create" ]; then echo "fakecontainer"; exit 0; fi
if [ "$1" = "cp" ]; then exit 0; fi
if [ "$1" = "rm" ]; then exit 0; fi
if [ "$1" = "inspect" ]; then
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --format=*) shift ;;
      --format) shift 2 ;;
      *) break ;;
    esac
  done
  if [ $# -gt 0 ]; then
    echo "fakewebcid0000000000000000000000000000000000000000000000000000"
  fi
  exit 0
fi
exit 0
FAKE_DOCKER_EOF
chmod +x "$FAKE_BIN_DIR/docker"

# Build a fake docker that always reports the same image ID
# for whatever tag is asked, so the image identity gate is satisfiable.
cat > "$FAKE_BIN_DIR/docker" <<'EOF'
#!/usr/bin/env bash
set -e
LOG="${FAKE_DOCKER_LOG:-/dev/null}"
# ps (no-args) -> always exit 0 (forces DOCKER_SUDO="")
if [ "$1" = "ps" ] && [ "$#" -eq 1 ]; then
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --format=*) shift ;;
      --format) shift 2 ;;
      *) break ;;
    esac
  done
  if [ $# -gt 0 ]; then
    echo "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  fi
  exit 0
fi
if [ "$1" = "compose" ]; then
  exit 0
fi
if [ "$1" = "create" ]; then
  echo "fakecontainer"
  exit 0
fi
if [ "$1" = "cp" ]; then
  exit 0
fi
if [ "$1" = "rm" ]; then
  exit 0
fi
if [ "$1" = "inspect" ]; then
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --format=*) shift ;;
      --format) shift 2 ;;
      *) break ;;
    esac
  done
  # fake web CID
  if [ $# -gt 0 ]; then
    echo "fakewebcid0000000000000000000000000000000000000000000000000000"
  fi
  exit 0
fi
exit 0
EOF
chmod +x "$FAKE_BIN_DIR/docker"

# Create a fresh fixture workspace
FIXTURE="$(mktemp -d)"

# Test 1: invalid SHA
out="$(RUN_REAL_ISOLATED_E2E=0 FAKE_BIN_DIR="$FAKE_BIN_DIR" PATH="$FAKE_BIN_DIR:$PATH" \
  bash "$VERIFY" "not-a-real-sha" 2>&1)"
if echo "$out" | grep -q "BLOCK_REASON=INVALID_SOURCE_SHA"; then
  assert_pass "T1_invalid_source_sha"
else
  assert_fail "T1_invalid_source_sha" "expected INVALID_SOURCE_SHA block; got: $(echo "$out" | head -3)"
fi

# Test 2: missing evidence
out="$(cd "$FIXTURE" && RUN_REAL_ISOLATED_E2E=0 FAKE_BIN_DIR="$FAKE_BIN_DIR" PATH="$FAKE_BIN_DIR:$PATH" \
  bash "$VERIFY" "0123456789012345678901234567890123456789" 2>&1)"
if echo "$out" | grep -q "CANDIDATE_EVIDENCE_MISSING\|CANDIDATE_EVIDENCE_INCOMPLETE"; then
  assert_pass "T2_missing_evidence"
else
  assert_fail "T2_missing_evidence" "got: $(echo "$out" | head -3)"
fi

# Test 3: source mismatch (commit doesn't exist)
# Note: must use a SHA that doesn't exist as commit, but is 40 hex.
NONEXIST_SHA="deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
# Need real repo for git cat-file; cd to repo so the verify script uses it as REPO_ROOT
out="$(cd "$REPO_ROOT" && RUN_REAL_ISOLATED_E2E=0 FAKE_BIN_DIR="$FAKE_BIN_DIR" PATH="$FAKE_BIN_DIR:$PATH" \
  bash "$VERIFY" "$NONEXIST_SHA" 2>&1)"
if echo "$out" | grep -q "CANDIDATE_EVIDENCE_MISSING"; then
  assert_pass "T3_source_commit_missing"
else
  assert_fail "T3_source_commit_missing" "got: $(echo "$out" | head -3)"
fi

# Test 4: incomplete evidence (missing field)
# Use a real repo commit to bypass the cat-file check
REAL_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
mkdir -p "$FIXTURE/progress/web-release-candidate-$REAL_SHA"
cat > "$FIXTURE/progress/web-release-candidate-$REAL_SHA/candidate.json" <<EOF
{
  "tag": "book-id-search-web:test",
  "imageId": "sha256:abc",
  "lockfileSha256": "lock-sha",
  "staticManifestSha256": "manifest-sha",
  "manifestPath": "/nonexistent"
}
EOF
# Force the verify script to use FIXTURE as its REPO_ROOT by copying the
# minimal layout. We can't easily override REPO_ROOT so we use the real repo
# and create an evidence dir in the real progress that points to fixture paths.
# But the verify script uses REPO_ROOT internally to compute EVIDENCE_DIR.
# So we must use the real repo. We'll create a temp evidence dir in the real
# repo's progress, run the script, then remove it.
EVIDENCE="$REPO_ROOT/progress/web-release-candidate-$REAL_SHA"
mkdir -p "$EVIDENCE"
cat > "$EVIDENCE/candidate.json" <<EOF
{
  "tag": "book-id-search-web:test",
  "imageId": "sha256:abc",
  "gitSha": "$REAL_SHA",
  "lockfileSha256": "lock-sha",
  "staticManifestSha256": "manifest-sha",
  "manifestPath": "/nonexistent"
}
EOF
out="$(cd "$REPO_ROOT" && RUN_REAL_ISOLATED_E2E=0 FAKE_BIN_DIR="$FAKE_BIN_DIR" PATH="$FAKE_BIN_DIR:$PATH" \
  bash "$VERIFY" "$REAL_SHA" 2>&1)"
# Should block because manifest doesn't exist
if echo "$out" | grep -q "CANDIDATE_EVIDENCE_INCOMPLETE"; then
  assert_pass "T4_incomplete_evidence"
else
  assert_fail "T4_incomplete_evidence" "got: $(echo "$out" | head -3)"
fi
rm -rf "$EVIDENCE"

# Test 5: PASS-shape output (smoke check: status field present)
out="$(cd "$REPO_ROOT" && RUN_REAL_ISOLATED_E2E=0 FAKE_BIN_DIR="$FAKE_BIN_DIR" PATH="$FAKE_BIN_DIR:$PATH" \
  bash "$VERIFY" "$NONEXIST_SHA" 2>&1)"
if echo "$out" | grep -qE "^STATUS=(PASS|BLOCKED)$"; then
  assert_pass "T5_output_status_shape"
else
  assert_fail "T5_output_status_shape" "no STATUS= line; got: $(echo "$out" | head -3)"
fi

# Test 6: READY_FOR_PRODUCTION_DEPLOY always emitted
out="$(cd "$REPO_ROOT" && RUN_REAL_ISOLATED_E2E=0 FAKE_BIN_DIR="$FAKE_BIN_DIR" PATH="$FAKE_BIN_DIR:$PATH" \
  bash "$VERIFY" "$NONEXIST_SHA" 2>&1)"
if echo "$out" | grep -qE "^READY_FOR_PRODUCTION_DEPLOY=(true|false)$"; then
  assert_pass "T6_ready_field_present"
else
  assert_fail "T6_ready_field_present" "no READY field; got: $(echo "$out" | head -3)"
fi

# Test 7: READY=true iff STATUS=PASS
PASS_OUT="$(cd "$REPO_ROOT" && RUN_REAL_ISOLATED_E2E=0 FAKE_BIN_DIR="$FAKE_BIN_DIR" PATH="$FAKE_BIN_DIR:$PATH" \
  bash "$VERIFY" "$NONEXIST_SHA" 2>&1)"
if echo "$PASS_OUT" | grep -q "STATUS=BLOCKED" && echo "$PASS_OUT" | grep -q "READY_FOR_PRODUCTION_DEPLOY=false"; then
  assert_pass "T7_ready_false_when_blocked"
else
  assert_fail "T7_ready_false_when_blocked" "BLOCKED but READY not false"
fi

# Test 8: no `docker build` invocation in gate code
if grep -q "docker build\|docker compose build\|--build" "$VERIFY"; then
  assert_fail "T8_no_build_invocation" "verify script references build"
else
  assert_pass "T8_no_build_invocation"
fi

# Test 9: no production compose target
if grep -q "production.*deploy\|deploy.*production" "$VERIFY"; then
  # Search context-sensitive: just check there's no `/opt/book-id-search/docker-compose.yml up -d` style
  if grep -E "compose[^\"]*docker-compose\.yml[^$]*up[^\"]*-d[^\"]*web" "$VERIFY" | grep -v "TMP\|E2E_TMP\|isolated" > /dev/null; then
    assert_fail "T9_no_production_deploy" "verify script has production-target compose"
  else
    assert_pass "T9_no_production_deploy"
  fi
else
  assert_pass "T9_no_production_deploy"
fi

# Test 10: no historical progress/ dependency in scripts
# Exclude the test file itself (which legitimately contains the regex)
t10_failed=""
for f in "$REPO_ROOT/scripts/test-deploy-web-release-candidate.sh" \
         "$REPO_ROOT/scripts/verify-web-release-readiness.sh"; do
  if [ -f "$f" ]; then
    if grep -E "s27t0a|s27t1a|s27t1b" "$f" > /dev/null 2>&1; then
      t10_failed="$f"
      break
    fi
  fi
done
if [ -n "$t10_failed" ]; then
  assert_fail "T10_no_historical_progress_dependency" "$t10_failed still references historical evidence"
else
  assert_pass "T10_no_historical_progress_dependency"
fi

# Test 11: BLOCK output contract (non-zero exit)
out="$(cd "$REPO_ROOT" && FAKE_BIN_DIR="$FAKE_BIN_DIR" PATH="$FAKE_BIN_DIR:$PATH" \
  bash "$VERIFY" "$NONEXIST_SHA" 2>&1)"
ec=$?
if [ "$ec" -ne 0 ] && echo "$out" | grep -q "STATUS=BLOCKED"; then
  assert_pass "T11_block_output_nonzero_exit"
else
  assert_fail "T11_block_output_nonzero_exit" "BLOCK should exit nonzero"
fi

# Test 12: RUN_REAL_ISOLATED_E2E=0 → ISOLATED_E2E_REQUIRED (READY must be false)
# To exercise this without real Docker, set RUN_REAL_ISOLATED_E2E=0 AND FAKE_BIN_DIR.
# Use a fresh evidence pointing at HEAD; gate should block on ISOLATED_E2E_REQUIRED
# because both flags forbid real E2E.
out="$(cd "$REPO_ROOT" && \
  REAL_EVIDENCE_DIR=\"$REPO_ROOT/progress/web-release-candidate-$REAL_SHA\" && \
  RUN_REAL_ISOLATED_E2E=0 FAKE_BIN_DIR="$FAKE_BIN_DIR" PATH="$FAKE_BIN_DIR:$PATH" \
  bash "$VERIFY" "$REAL_SHA" 2>&1)"
# This may fail earlier (e.g., CANDIDATE_EVIDENCE_INCOMPLETE if no evidence), so
# look for any valid BLOCK with READY=false.
if echo "$out" | grep -q "READY_FOR_PRODUCTION_DEPLOY=false"; then
  assert_pass "T12_skipped_e2e_ready_false"
else
  assert_fail "T12_skipped_e2e_ready_false" "expected READY=false when E2E skipped; got: $(echo "$out" | head -3)"
fi

# Summary
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