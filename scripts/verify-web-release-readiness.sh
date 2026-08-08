#!/usr/bin/env bash
# Unified Web Release Readiness Gate.
#
# Validates a candidate source SHA is ready for production deploy by
# checking source identity, candidate evidence, image identity, static
# manifest, lockfile identity, deploy-script regression, and actual-script
# isolated E2E (real sudo + real docker compose in an isolated project).
#
# Usage:
#   scripts/verify-web-release-readiness.sh <candidate-source-sha>
#
# Output contract (machine-parseable):
#   STATUS=PASS
#   SOURCE_SHA=<...>
#   IMAGE_TAG=<...>
#   IMAGE_ID=<...>
#   MANIFEST_SHA=<...>
#   LOCKFILE_SHA=<...>
#   DEPLOY_REGRESSION=PASS
#   ISOLATED_E2E=PASS
#   PRODUCTION_UNCHANGED=PASS
#   READY_FOR_PRODUCTION_DEPLOY=true
#
# Or on failure:
#   STATUS=BLOCKED
#   BLOCK_REASON=<enum>
#   READY_FOR_PRODUCTION_DEPLOY=false
#
# Block reasons (enum):
#   INVALID_SOURCE_SHA
#   CANDIDATE_EVIDENCE_MISSING
#   CANDIDATE_EVIDENCE_INCOMPLETE
#   CANDIDATE_SOURCE_MISMATCH
#   CANDIDATE_IMAGE_MISSING
#   CANDIDATE_IMAGE_IDENTITY
#   CANDIDATE_MANIFEST_IDENTITY
#   CANDIDATE_LOCKFILE_IDENTITY
#   DEPLOY_REGRESSION_FAILED
#   ISOLATION_GUARD
#   ISOLATED_E2E_FAILED
#   PRODUCTION_TOUCHED
#   WORKTREE_CHANGED
#
# Levels:
#   Default: real sudo + real docker compose + isolated E2E runs.
#   RUN_REAL_ISOLATED_E2E=0 : skip the real-docker E2E (for sandboxed tests).
#
# Hard rules:
#   - No build, no production deploy, no restart, no tag.
#   - No mutation of tracked worktree.
#   - Real docker compose ONLY in /tmp isolated project.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRESS_DIR="$REPO_ROOT/progress"
FAKE_BIN_DIR="${FAKE_BIN_DIR:-}"   # for level-1 tests only

# -----------------------------------------------------------------------------
# Output helpers
# -----------------------------------------------------------------------------
emit_kv() { printf '%s=%s\n' "$1" "$2"; }
block() {
  local reason="$1"
  emit_kv STATUS BLOCKED
  emit_kv BLOCK_REASON "$reason"
  emit_kv READY_FOR_PRODUCTION_DEPLOY false
  exit 1
}
pass_field() {
  emit_kv STATUS PASS
  emit_kv READY_FOR_PRODUCTION_DEPLOY true
}

# -----------------------------------------------------------------------------
# A4 — Source Identity
# -----------------------------------------------------------------------------
SOURCE_SHA="${1:-}"
[ -n "$SOURCE_SHA" ] || block INVALID_SOURCE_SHA
# 40 hex chars
if ! printf '%s' "$SOURCE_SHA" | grep -qE '^[0-9a-f]{40}$'; then
  block INVALID_SOURCE_SHA
fi
git -C "$REPO_ROOT" cat-file -e "${SOURCE_SHA}^{commit}" 2>/dev/null \
  || block CANDIDATE_EVIDENCE_MISSING

CURRENT_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"

# -----------------------------------------------------------------------------
# A5 — Candidate Evidence
# -----------------------------------------------------------------------------
EVIDENCE_DIR="$PROGRESS_DIR/web-release-candidate-${SOURCE_SHA}"
[ -d "$EVIDENCE_DIR" ] || block CANDIDATE_EVIDENCE_MISSING

CANDIDATE_JSON="$EVIDENCE_DIR/candidate.json"
[ -f "$CANDIDATE_JSON" ] || block CANDIDATE_EVIDENCE_INCOMPLETE

# Parse JSON via python (already available in repo)
read_evidence_field() {
  python3 -c "import json,sys; d=json.load(open('$CANDIDATE_JSON')); v=d.get('$1',''); print(v if v is not None else '')"
}

EVIDENCE_SOURCE_SHA="$(read_evidence_field gitSha)"
EVIDENCE_IMAGE_TAG="$(read_evidence_field tag)"
EVIDENCE_IMAGE_ID="$(read_evidence_field imageId)"
EVIDENCE_LOCKFILE_SHA="$(read_evidence_field lockfileSha256)"
EVIDENCE_MANIFEST_SHA="$(read_evidence_field staticManifestSha256)"
EVIDENCE_MANIFEST_PATH="$(read_evidence_field manifestPath)"

# Validate required fields
for f in "$EVIDENCE_SOURCE_SHA" "$EVIDENCE_IMAGE_TAG" "$EVIDENCE_IMAGE_ID" \
         "$EVIDENCE_LOCKFILE_SHA" "$EVIDENCE_MANIFEST_SHA"; do
  [ -n "$f" ] || block CANDIDATE_EVIDENCE_INCOMPLETE
done
[ -f "$EVIDENCE_MANIFEST_PATH" ] || block CANDIDATE_EVIDENCE_INCOMPLETE

# Source SHA must match evidence
[ "$SOURCE_SHA" = "$EVIDENCE_SOURCE_SHA" ] || block CANDIDATE_SOURCE_MISMATCH

# -----------------------------------------------------------------------------
# A12 — Production Identity Snapshot (before)
# -----------------------------------------------------------------------------
read_prod_web() {
  local cid; cid="$(sudo docker compose -f "$REPO_ROOT/docker-compose.yml" ps -q web)"
  [ -n "$cid" ] || return 1
  sudo docker inspect "$cid" --format '{{.Id}} {{.Image}} {{.State.StartedAt}}'
}

PROD_WEB_BEFORE="$(read_prod_web)" || block PRODUCTION_TOUCHED
PROD_API_CID_BEFORE="$(sudo docker compose -f "$REPO_ROOT/docker-compose.yml" ps -q api)"
PROD_MEILI_CID_BEFORE="$(sudo docker compose -f "$REPO_ROOT/docker-compose.yml" ps -q meilisearch)"
PROD_API_BEFORE="$(sudo docker inspect "$PROD_API_CID_BEFORE" --format '{{.Id}} {{.State.StartedAt}}')"
PROD_MEILI_BEFORE="$(sudo docker inspect "$PROD_MEILI_CID_BEFORE" --format '{{.Id}} {{.State.StartedAt}}')"

# -----------------------------------------------------------------------------
# A13 — Worktree snapshot (must not change during gate)
# -----------------------------------------------------------------------------
WORKTREE_BEFORE="$(git -C "$REPO_ROOT" status --porcelain | sha256sum | awk '{print $1}')"

# -----------------------------------------------------------------------------
# A6 — Image Identity
# -----------------------------------------------------------------------------
ACTUAL_IMAGE_ID="$(sudo docker image inspect "$EVIDENCE_IMAGE_TAG" --format '{{.Id}}' 2>/dev/null || true)"
[ -n "$ACTUAL_IMAGE_ID" ] || block CANDIDATE_IMAGE_MISSING
[ "$ACTUAL_IMAGE_ID" = "$EVIDENCE_IMAGE_ID" ] || block CANDIDATE_IMAGE_IDENTITY

# -----------------------------------------------------------------------------
# A7 — Static Manifest Re-extraction
#
# Uses the SAME algorithm as scripts/build-web-release-candidate.sh so the
# fresh manifest has identical byte layout to the frozen one.
# -----------------------------------------------------------------------------
TMP_STATIC_DIR="$(mktemp -d /tmp/s27t2a-static-XXXXXX)"
# Pre-extract dir is root-owned (docker cp via sudo); cleanup must use sudo
trap 'sudo rm -rf "$TMP_STATIC_DIR" 2>/dev/null || true' EXIT

FRESH_MANIFEST="$(mktemp)"
FRESH_FILES_TXT="$(mktemp)"
# Create ephemeral container from candidate image to extract static files
sudo docker create --name "s27t2a-static-${SOURCE_SHA:0:8}" "$EVIDENCE_IMAGE_TAG" \
  > /dev/null 2>&1
sudo docker cp "s27t2a-static-${SOURCE_SHA:0:8}:/usr/share/nginx/html/." "$TMP_STATIC_DIR/" \
  > /dev/null 2>&1
sudo docker rm "s27t2a-static-${SOURCE_SHA:0:8}" > /dev/null 2>&1

# Same algorithm as build script
( cd "$TMP_STATIC_DIR" && find . -type f -printf '%P\t%s\n' | sort > "$FRESH_FILES_TXT" )
: > "$FRESH_MANIFEST"
while IFS=$'\t' read -r FILE SIZE; do
  HASH="$(sha256sum "${TMP_STATIC_DIR}/${FILE}" | awk '{print $1}')"
  printf '%s\t%s\t%s\n' "$FILE" "$SIZE" "$HASH" >> "$FRESH_MANIFEST"
done < "$FRESH_FILES_TXT"

FRESH_MANIFEST_SHA="$(sha256sum "$FRESH_MANIFEST" | awk '{print $1}')"
[ "$FRESH_MANIFEST_SHA" = "$EVIDENCE_MANIFEST_SHA" ] || block CANDIDATE_MANIFEST_IDENTITY

rm -f "$FRESH_MANIFEST" "$FRESH_FILES_TXT"
rm -rf "$TMP_STATIC_DIR"

# -----------------------------------------------------------------------------
# A8 — Lockfile Identity (vs candidate source commit, not HEAD)
# -----------------------------------------------------------------------------
LOCKFILE_SHA_AT_SOURCE="$(git -C "$REPO_ROOT" show "${SOURCE_SHA}:pnpm-lock.yaml" 2>/dev/null \
  | sha256sum | awk '{print $1}')"
[ -n "$LOCKFILE_SHA_AT_SOURCE" ] || block CANDIDATE_LOCKFILE_IDENTITY
[ "$LOCKFILE_SHA_AT_SOURCE" = "$EVIDENCE_LOCKFILE_SHA" ] || block CANDIDATE_LOCKFILE_IDENTITY

# -----------------------------------------------------------------------------
# A9 — Deploy Script Regression
# -----------------------------------------------------------------------------
DEPLOY_REG_LOG="$(mktemp)"
# The deploy regression test script is now self-contained (creates its own
# fake harness at runtime). We DO NOT auto-discover any historical evidence.
if [ -n "${FAKE_BIN_SOURCE:-}" ]; then
  FAKE_BIN_SOURCE="$FAKE_BIN_SOURCE" \
    bash "$REPO_ROOT/scripts/test-deploy-web-release-candidate.sh" \
    > "$DEPLOY_REG_LOG" 2>&1
else
  bash "$REPO_ROOT/scripts/test-deploy-web-release-candidate.sh" > "$DEPLOY_REG_LOG" 2>&1
fi
DEPLOY_REG_EXIT=$?
DEPLOY_REG_SUMMARY="$(grep -E '^TOTAL:|^RESULT:' "$DEPLOY_REG_LOG" | tail -2 | tr '\n' ' ')"
if [ "$DEPLOY_REG_EXIT" -ne 0 ]; then
  echo "deploy regression FAILED:" >&2
  tail -10 "$DEPLOY_REG_LOG" >&2
  rm -f "$DEPLOY_REG_LOG"
  block DEPLOY_REGRESSION_FAILED
fi
rm -f "$DEPLOY_REG_LOG"

# -----------------------------------------------------------------------------
# A10/A11 — Actual-script Isolated E2E (real sudo + real docker compose)
#
# Fail-closed contract:
#   ISOLATED_E2E must be PASS for READY=true.
#   If RUN_REAL_ISOLATED_E2E is explicitly 0, or if FAKE_BIN_DIR is set
#   (level-1 mode), the gate blocks with ISOLATED_E2E_REQUIRED.
# -----------------------------------------------------------------------------
if [ "${RUN_REAL_ISOLATED_E2E:-1}" = "0" ]; then
  echo "RUN_REAL_ISOLATED_E2E=0: isolated E2E skipped; READY cannot be true" >&2
  block ISOLATED_E2E_REQUIRED
elif [ -n "${FAKE_BIN_DIR:-}" ]; then
  echo "FAKE_BIN_DIR set: isolated E2E skipped; READY cannot be true" >&2
  block ISOLATED_E2E_REQUIRED
else
  # Real E2E (delegated to helper if available)
  if [ -f "$REPO_ROOT/scripts/lib/verify-deploy-isolated-e2e.sh" ]; then
    if ! bash "$REPO_ROOT/scripts/lib/verify-deploy-isolated-e2e.sh" \
         "$REPO_ROOT" "$EVIDENCE_IMAGE_TAG" "$SOURCE_SHA"; then
      block ISOLATED_E2E_FAILED
    fi
    ISOLATED_E2E_RESULT="PASS"
  else
    # Inline minimal E2E
    E2E_TMP="$(mktemp -d /tmp/s27t2a-e2e-XXXXXX)"
    E2E_PROJ="s27t2a-${SOURCE_SHA:0:8}-$(date +%H%M%S)"
    FREE_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()')"
    mkdir -p "$E2E_TMP/scripts"
    cp "$REPO_ROOT/scripts/deploy-web-release-candidate.sh" "$E2E_TMP/scripts/"
    cat > "$E2E_TMP/docker-compose.yml" <<EOF
name: $E2E_PROJ
services:
  web:
    image: \${BOOK_ID_SEARCH_WEB_IMAGE:-book-id-search/web:dev}
    pull_policy: never
    ports:
      - "127.0.0.1:$FREE_PORT:80"
    extra_hosts:
      - "api:127.0.0.1"
EOF
    E2E_LOG="$(mktemp)"
    ( cd / && BOOK_ID_SEARCH_WEB_IMAGE="$EVIDENCE_IMAGE_TAG" \
      bash "$E2E_TMP/scripts/deploy-web-release-candidate.sh" \
      > "$E2E_LOG" 2>&1 )
    if [ $? -ne 0 ]; then
      tail -10 "$E2E_LOG" >&2
      rm -f "$E2E_LOG"
      ( cd "$E2E_TMP" && sudo docker compose -p "$E2E_PROJ" -f docker-compose.yml down --remove-orphans > /dev/null 2>&1 )
      rm -rf "$E2E_TMP"
      block ISOLATED_E2E_FAILED
    fi
    E2E_CID="$(sudo docker compose -p "$E2E_PROJ" -f "$E2E_TMP/docker-compose.yml" ps -q web 2>/dev/null)"
    if [ -z "$E2E_CID" ]; then
      ( cd "$E2E_TMP" && sudo docker compose -p "$E2E_PROJ" -f docker-compose.yml down --remove-orphans > /dev/null 2>&1 )
      rm -rf "$E2E_TMP"
      block ISOLATED_E2E_FAILED
    fi
    E2E_IMG="$(sudo docker inspect "$E2E_CID" --format '{{.Image}}')"
    E2E_CFG="$(sudo docker inspect "$E2E_CID" --format '{{.Config.Image}}')"
    if [ "$E2E_IMG" != "$EVIDENCE_IMAGE_ID" ] || [ "$E2E_CFG" != "$EVIDENCE_IMAGE_TAG" ]; then
      ( cd "$E2E_TMP" && sudo docker compose -p "$E2E_PROJ" -f docker-compose.yml down --remove-orphans > /dev/null 2>&1 )
      rm -rf "$E2E_TMP"
      block ISOLATED_E2E_FAILED
    fi
    # Cleanup
    ( cd "$E2E_TMP" && sudo docker compose -p "$E2E_PROJ" -f docker-compose.yml down --remove-orphans > /dev/null 2>&1 )
    rm -rf "$E2E_TMP"
    rm -f "$E2E_LOG"
    ISOLATED_E2E_RESULT="PASS"
  fi
fi

# -----------------------------------------------------------------------------
# A13 — Worktree unchanged check
# -----------------------------------------------------------------------------
WORKTREE_AFTER="$(git -C "$REPO_ROOT" status --porcelain | sha256sum | awk '{print $1}')"
[ "$WORKTREE_BEFORE" = "$WORKTREE_AFTER" ] || block WORKTREE_CHANGED

# -----------------------------------------------------------------------------
# A12 — Production Identity Snapshot (after)
# -----------------------------------------------------------------------------
PROD_WEB_AFTER="$(read_prod_web)" || block PRODUCTION_TOUCHED
PROD_API_CID_AFTER="$(sudo docker compose -f "$REPO_ROOT/docker-compose.yml" ps -q api)"
PROD_MEILI_CID_AFTER="$(sudo docker compose -f "$REPO_ROOT/docker-compose.yml" ps -q meilisearch)"
PROD_API_AFTER="$(sudo docker inspect "$PROD_API_CID_AFTER" --format '{{.Id}} {{.State.StartedAt}}')"
PROD_MEILI_AFTER="$(sudo docker inspect "$PROD_MEILI_CID_AFTER" --format '{{.Id}} {{.State.StartedAt}}')"

[ "$PROD_WEB_BEFORE" = "$PROD_WEB_AFTER" ] || block PRODUCTION_TOUCHED
[ "$PROD_API_BEFORE" = "$PROD_API_AFTER" ] || block PRODUCTION_TOUCHED
[ "$PROD_MEILI_BEFORE" = "$PROD_MEILI_AFTER" ] || block PRODUCTION_TOUCHED

# -----------------------------------------------------------------------------
# A10/B9 — READY contract: READY=true ⇔ ISOLATED_E2E=PASS
# -----------------------------------------------------------------------------
# Defensive hard guarantee that ISOLATED_E2E must be exactly PASS before
# READY_FOR_PRODUCTION_DEPLOY=true is emitted.
[ "$ISOLATED_E2E_RESULT" = "PASS" ] || block ISOLATED_E2E_REQUIRED

# -----------------------------------------------------------------------------
# Output
# -----------------------------------------------------------------------------
emit_kv STATUS PASS
emit_kv SOURCE_SHA "$SOURCE_SHA"
emit_kv CURRENT_HEAD "$CURRENT_HEAD"
emit_kv IMAGE_TAG "$EVIDENCE_IMAGE_TAG"
emit_kv IMAGE_ID "$EVIDENCE_IMAGE_ID"
emit_kv MANIFEST_SHA "$EVIDENCE_MANIFEST_SHA"
emit_kv LOCKFILE_SHA "$EVIDENCE_LOCKFILE_SHA"
emit_kv DEPLOY_REGRESSION "PASS"
emit_kv DEPLOY_REGRESSION_SUMMARY "$DEPLOY_REG_SUMMARY"
emit_kv ISOLATED_E2E "$ISOLATED_E2E_RESULT"
emit_kv PRODUCTION_UNCHANGED "PASS"
emit_kv READY_FOR_PRODUCTION_DEPLOY true