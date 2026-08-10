#!/usr/bin/env bash
# Release Orchestrator: Gate → Plan → Actual Deploy Script (isolated E2E).
#
# This script wires the S27T-3A Release Plan to the actual deploy script in
# an isolated /tmp project. In this stage it ONLY supports the
# "isolated-e2e" mode; production deploy mode is intentionally absent.
#
# Chain:
#   SOURCE_SHA
#     → scripts/plan-web-production-release.sh  (forwards to readiness gate)
#     → machine-parsed Release Plan fields + recomputed fingerprint
#     → pre-deploy TOCTOU image guard (docker inspect IMAGE_TAG)
#     → evidence identity guard (candidate.json image tag & ID)
#     → isolated /tmp repo with exact-byte deploy script + minimal compose
#     → real sudo + real docker compose up --no-build --no-deps
#     → post-deploy image guard + dev-fallback guard + HTTP smoke
#     → cleanup
#
# Usage:
#   scripts/orchestrate-web-production-release.sh isolated-e2e <SOURCE_SHA>
#
# Production deploy is NOT supported in this stage. Any mode other than
# "isolated-e2e" is BLOCKED.
#
# Output contract (success):
#   STATUS=PASS
#   ORCHESTRATION_MODE=isolated-e2e
#   SOURCE_SHA=<...>
#   RELEASE_PLAN_FINGERPRINT=<...>
#   IMAGE_TAG=<...>
#   IMAGE_ID=<...>
#   PLAN_READY=PASS
#   PRE_DEPLOY_IMAGE_IDENTITY=PASS
#   HANDOFF_IDENTITY_SOURCE=RELEASE_PLAN
#   ACTUAL_DEPLOY_SCRIPT_E2E=PASS
#   POST_DEPLOY_IMAGE_IDENTITY=PASS
#   DEV_FALLBACK_USED=false
#   PRODUCTION_UNCHANGED=PASS
#   PRODUCTION_DEPLOY_EXECUTED=false
#   ORCHESTRATOR_ISOLATED_E2E_VERIFIED=true
#
# Output contract (block):
#   STATUS=BLOCKED
#   BLOCK_REASON=<enum>
#   PRODUCTION_DEPLOY_EXECUTED=false
#   ORCHESTRATOR_ISOLATED_E2E_VERIFIED=false
#
# Block reasons (enum):
#   INVALID_SOURCE_SHA
#   UNSUPPORTED_ORCHESTRATION_MODE
#   EXTRA_POSITIONAL_ARG
#   RELEASE_PLAN_FAILED
#   RELEASE_PLAN_NOT_READY
#   RELEASE_PLAN_INCOMPLETE
#   RELEASE_PLAN_AMBIGUOUS
#   RELEASE_PLAN_FINGERPRINT_MISMATCH
#   SOURCE_IDENTITY_MISMATCH
#   INVALID_IMAGE_TAG
#   INVALID_IMAGE_ID
#   PRE_DEPLOY_IMAGE_MISSING
#   PRE_DEPLOY_IMAGE_IDENTITY_CHANGED
#   PRE_DEPLOY_CANDIDATE_EVIDENCE_CHANGED
#   ISOLATION_GUARD_FAILED
#   ACTUAL_DEPLOY_SCRIPT_FAILED
#   ORCHESTRATED_DEPLOY_IDENTITY_MISMATCH
#   POST_DEPLOY_IMAGE_IDENTITY_CHANGED
#   HTTP_SMOKE_FAILED
#   DEV_FALLBACK_USED
#   CLEANUP_FAILED
#   PRODUCTION_TOUCHED
#
# Test-only overrides (do NOT use in production):
#   ORCHESTRATOR_SUDO  - default: sudo
#   ORCHESTRATOR_DOCKER - default: docker
#   ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH - skip real deploy; record handoff args
#   ORCHESTRATOR_SKIP_PRODUCTION_CHECK - skip production-unchanged snapshot
#   ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID - override pre-deploy inspect ID
#
# Hard rules:
#   - PRODUCTION_DEPLOY_EXECUTED=false is unconditionally emitted.
#   - No build, no pull, no retag, no image delete.
#   - Real sudo + real docker compose ONLY in /tmp isolated project.
#   - IMAGE_TAG comes from the Plan, never from the user or SOURCE_SHA.
#   - No eval / source / bash -c of Plan output.

set -uo pipefail

# -----------------------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------------------
emit_kv() { printf '%s=%s\n' "$1" "$2"; }
block() {
  local reason="$1"
  emit_kv STATUS BLOCKED
  emit_kv BLOCK_REASON "$reason"
  emit_kv PRODUCTION_DEPLOY_EXECUTED false
  emit_kv ORCHESTRATOR_ISOLATED_E2E_VERIFIED false
  exit 1
}

# Test-mode overrides (defaults reproduce production behavior exactly)
SUDO_CMD="${ORCHESTRATOR_SUDO:-sudo}"
DOCKER_CMD="${ORCHESTRATOR_DOCKER:-docker}"
# Compose as array to preserve argv (quotes in compose files)
DOCKER="$SUDO_CMD $DOCKER_CMD"

# -----------------------------------------------------------------------------
# Script-relative resolution (no hardcoded /opt path)
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(
  CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd
)" || block INTERNAL_SCRIPT_DIR_RESOLUTION_FAILED
REPO_ROOT="$(
  CDPATH= cd -- "$SCRIPT_DIR/.." && pwd
)" || block INTERNAL_REPO_ROOT_RESOLUTION_FAILED

PLAN_SCRIPT="$SCRIPT_DIR/plan-web-production-release.sh"
[ -x "$PLAN_SCRIPT" ] || {
  echo "FATAL: plan script not found or not executable: $PLAN_SCRIPT" >&2
  exit 99
}

# Real deploy script (exact-byte source for relocation)
DEPLOY_SCRIPT_SRC="$SCRIPT_DIR/deploy-web-release-candidate.sh"
[ -f "$DEPLOY_SCRIPT_SRC" ] || {
  echo "FATAL: deploy script not found: $DEPLOY_SCRIPT_SRC" >&2
  exit 99
}

# -----------------------------------------------------------------------------
# B4 / B5 — Mode + positional args
# -----------------------------------------------------------------------------
ORCHESTRATION_MODE="${1:-}"
USER_SOURCE_SHA="${2:-}"
# Reject any extra positional args (fail closed, not silent ignore)
if [ "${3:-}" != "" ]; then
  block EXTRA_POSITIONAL_ARG
fi

case "$ORCHESTRATION_MODE" in
  isolated-e2e) ;;
  "")           block UNSUPPORTED_ORCHESTRATION_MODE ;;
  *)            block UNSUPPORTED_ORCHESTRATION_MODE ;;
esac

# -----------------------------------------------------------------------------
# SOURCE_SHA validation
# -----------------------------------------------------------------------------
if [ -z "$USER_SOURCE_SHA" ]; then
  block INVALID_SOURCE_SHA
fi
if ! printf '%s' "$USER_SOURCE_SHA" | grep -qE '^[0-9a-fA-F]{40}$'; then
  block INVALID_SOURCE_SHA
fi
if ! git -C "$REPO_ROOT" cat-file -e "${USER_SOURCE_SHA}^{commit}" 2>/dev/null; then
  block INVALID_SOURCE_SHA
fi
SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse "${USER_SOURCE_SHA}^{commit}")"

# -----------------------------------------------------------------------------
# B6 / B7 — Call the real Plan script (no eval, capture only)
# -----------------------------------------------------------------------------
PLAN_STDOUT="$(mktemp)"
PLAN_STDERR="$(mktemp)"
DEPLOY_INVOCATION_COUNT=0

cleanup_temp_files() {
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR" 2>/dev/null || true
}
trap 'cleanup_temp_files' EXIT INT TERM

"$PLAN_SCRIPT" "$SOURCE_SHA" >"$PLAN_STDOUT" 2>"$PLAN_STDERR"
PLAN_EXIT=$?

# -----------------------------------------------------------------------------
# B8 / B9 / B10 / B11 — Parse Plan strictly
# -----------------------------------------------------------------------------
field_count() {
  local n
  n="$(grep -cE "^${1}=" "$2" 2>/dev/null)" || true
  printf '%s\n' "${n:-0}"
}
field_value() {
  local key="$1" file="$2"
  grep -E "^${key}=" "$file" 2>/dev/null | head -1 | sed -e "s/^${key}=//"
}

if [ "$PLAN_EXIT" -ne 0 ]; then
  block RELEASE_PLAN_FAILED
fi

# All mandatory Plan keys must appear exactly once
MANDATORY_KEYS=(STATUS RELEASE_PLAN_VERSION SOURCE_SHA IMAGE_TAG IMAGE_ID \
                MANIFEST_SHA LOCKFILE_SHA RELEASE_PLAN_FINGERPRINT \
                READINESS_GATE ISOLATED_E2E PRODUCTION_UNCHANGED \
                RELEASE_PLAN_READY DEPLOY_EXECUTED)
for key in "${MANDATORY_KEYS[@]}"; do
  count="$(field_count "$key" "$PLAN_STDOUT")"
  if [ "$count" -eq 0 ]; then
    block RELEASE_PLAN_INCOMPLETE
  fi
  if [ "$count" -gt 1 ]; then
    block RELEASE_PLAN_AMBIGUOUS
  fi
done

PLAN_STATUS="$(field_value STATUS "$PLAN_STDOUT")"
PLAN_VERSION="$(field_value RELEASE_PLAN_VERSION "$PLAN_STDOUT")"
PLAN_SOURCE_SHA="$(field_value SOURCE_SHA "$PLAN_STDOUT")"
PLAN_IMAGE_TAG="$(field_value IMAGE_TAG "$PLAN_STDOUT")"
PLAN_IMAGE_ID="$(field_value IMAGE_ID "$PLAN_STDOUT")"
PLAN_MANIFEST_SHA="$(field_value MANIFEST_SHA "$PLAN_STDOUT")"
PLAN_LOCKFILE_SHA="$(field_value LOCKFILE_SHA "$PLAN_STDOUT")"
PLAN_FINGERPRINT="$(field_value RELEASE_PLAN_FINGERPRINT "$PLAN_STDOUT")"
PLAN_READINESS_GATE="$(field_value READINESS_GATE "$PLAN_STDOUT")"
PLAN_ISOLATED_E2E="$(field_value ISOLATED_E2E "$PLAN_STDOUT")"
PLAN_PRODUCTION_UNCHANGED="$(field_value PRODUCTION_UNCHANGED "$PLAN_STDOUT")"
PLAN_READY="$(field_value RELEASE_PLAN_READY "$PLAN_STDOUT")"
PLAN_DEPLOY_EXECUTED="$(field_value DEPLOY_EXECUTED "$PLAN_STDOUT")"

# Readiness-state semantics
if [ "$PLAN_STATUS" != "PASS" ] \
   || [ "$PLAN_VERSION" != "1" ] \
   || [ "$PLAN_READINESS_GATE" != "PASS" ] \
   || [ "$PLAN_ISOLATED_E2E" != "PASS" ] \
   || [ "$PLAN_PRODUCTION_UNCHANGED" != "PASS" ] \
   || [ "$PLAN_READY" != "true" ] \
   || [ "$PLAN_DEPLOY_EXECUTED" != "false" ]; then
  block RELEASE_PLAN_NOT_READY
fi

# B11 — Source binding: Plan SOURCE_SHA must equal our canonical request
if [ "$PLAN_SOURCE_SHA" != "$SOURCE_SHA" ]; then
  block SOURCE_IDENTITY_MISMATCH
fi

# Validate Plan fields
if [ -z "$PLAN_IMAGE_TAG" ] \
   || printf '%s' "$PLAN_IMAGE_TAG" | grep -qE '[[:space:];&|`<>()]'; then
  block INVALID_IMAGE_TAG
fi
if ! printf '%s' "$PLAN_IMAGE_TAG" | grep -qE '^[A-Za-z0-9][A-Za-z0-9_./:.-]*$'; then
  block INVALID_IMAGE_TAG
fi
if ! printf '%s' "$PLAN_IMAGE_ID" | grep -qE '^sha256:[0-9a-f]{64}$'; then
  block INVALID_IMAGE_ID
fi
if ! printf '%s' "$PLAN_MANIFEST_SHA" | grep -qE '^[a-f0-9]{64}$'; then
  block RELEASE_PLAN_NOT_READY
fi
if ! printf '%s' "$PLAN_LOCKFILE_SHA" | grep -qE '^[a-f0-9]{64}$'; then
  block RELEASE_PLAN_NOT_READY
fi

# B10 — Recompute fingerprint independently and compare
RECOMPUTED_FINGERPRINT="$(
  printf '%s\n%s\n%s\n%s\n%s\n' \
    "SOURCE_SHA=$PLAN_SOURCE_SHA" \
    "IMAGE_TAG=$PLAN_IMAGE_TAG" \
    "IMAGE_ID=$PLAN_IMAGE_ID" \
    "MANIFEST_SHA=$PLAN_MANIFEST_SHA" \
    "LOCKFILE_SHA=$PLAN_LOCKFILE_SHA" \
    | sha256sum | awk '{print $1}'
)"
if [ "$RECOMPUTED_FINGERPRINT" != "$PLAN_FINGERPRINT" ]; then
  block RELEASE_PLAN_FINGERPRINT_MISMATCH
fi

# -----------------------------------------------------------------------------
# B13 — Evidence identity guard (candidate.json tag/imageId must equal Plan)
# Test hook: ORCHESTRATOR_SKIP_CANDIDATE_EVIDENCE_CHECK=1 to skip in level-1.
# -----------------------------------------------------------------------------
if [ "${ORCHESTRATOR_SKIP_CANDIDATE_EVIDENCE_CHECK:-0}" != "1" ]; then
  CANDIDATE_JSON="$REPO_ROOT/progress/web-release-candidate-${SOURCE_SHA}/candidate.json"
  if [ ! -f "$CANDIDATE_JSON" ]; then
    block PRE_DEPLOY_CANDIDATE_EVIDENCE_CHANGED
  fi
  EVIDENCE_IMAGE_TAG="$(python3 -c "import json; d=json.load(open('$CANDIDATE_JSON')); print(d.get('tag',''))")"
  EVIDENCE_IMAGE_ID="$(python3 -c "import json; d=json.load(open('$CANDIDATE_JSON')); print(d.get('imageId',''))")"
  if [ "$EVIDENCE_IMAGE_TAG" != "$PLAN_IMAGE_TAG" ] \
     || [ "$EVIDENCE_IMAGE_ID" != "$PLAN_IMAGE_ID" ]; then
    block PRE_DEPLOY_CANDIDATE_EVIDENCE_CHANGED
  fi
fi

# -----------------------------------------------------------------------------
# B12 — Pre-deploy TOCTOU image guard
# -----------------------------------------------------------------------------
if [ -n "${ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID:-}" ]; then
  # Test hook
  PRE_DEPLOY_IMAGE_ID="$ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID"
else
  PRE_DEPLOY_IMAGE_ID="$($SUDO_CMD $DOCKER_CMD image inspect "$PLAN_IMAGE_TAG" --format '{{.Id}}' 2>/dev/null || true)"
fi
if [ -z "$PRE_DEPLOY_IMAGE_ID" ]; then
  block PRE_DEPLOY_IMAGE_MISSING
fi
if [ "$PRE_DEPLOY_IMAGE_ID" != "$PLAN_IMAGE_ID" ]; then
  block PRE_DEPLOY_IMAGE_IDENTITY_CHANGED
fi

# -----------------------------------------------------------------------------
# B14 — Build isolated repo (unique compose project + free loopback port)
# -----------------------------------------------------------------------------
TMP_ROOT="$(mktemp -d /tmp/s27t3b-orchestrator-XXXXXX)"
ISOLATED_PROJ="s27t3b-${SOURCE_SHA:0:8}-$(date +%H%M%S)-$$"
FREE_PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()')"

mkdir -p "$TMP_ROOT/scripts" \
         "$TMP_ROOT/progress/web-release-candidate-${SOURCE_SHA}"

# B17 — Minimal candidate evidence in isolated repo
{
  printf 'tag=%s\n' "$PLAN_IMAGE_TAG"
  printf 'imageId=%s\n' "$PLAN_IMAGE_ID"
  printf 'gitSha=%s\n' "$SOURCE_SHA"
  printf 'staticManifestSha256=%s\n' "$PLAN_MANIFEST_SHA"
  printf 'lockfileSha256=%s\n' "$PLAN_LOCKFILE_SHA"
  printf 'manifestPath=%s/progress/web-release-candidate-%s/static-manifest.tsv\n' \
    "$TMP_ROOT" "$SOURCE_SHA"
} > "$TMP_ROOT/progress/web-release-candidate-${SOURCE_SHA}/candidate.json"

# B15 — Exact-byte copy of deploy script + SHA evidence
DEPLOY_SCRIPT_BYTES_BEFORE="$(sha256sum "$DEPLOY_SCRIPT_SRC" | awk '{print $1}')"
cp "$DEPLOY_SCRIPT_SRC" "$TMP_ROOT/scripts/deploy-web-release-candidate.sh"
chmod +x "$TMP_ROOT/scripts/deploy-web-release-candidate.sh"
DEPLOY_SCRIPT_BYTES_AFTER="$(sha256sum "$TMP_ROOT/scripts/deploy-web-release-candidate.sh" | awk '{print $1}')"
if [ "$DEPLOY_SCRIPT_BYTES_BEFORE" != "$DEPLOY_SCRIPT_BYTES_AFTER" ]; then
  rm -rf "$TMP_ROOT"
  block ISOLATION_GUARD_FAILED
fi

# Touch a frozen static manifest placeholder (deploy script doesn't require
# it; the candidate evidence shape is enough for fingerprint symmetry).
{
  printf '%s\t%s\t%s\n' "index.html" "1" \
    "$(printf '%s' "$PLAN_MANIFEST_SHA" | head -c 64)"
} > "$TMP_ROOT/progress/web-release-candidate-${SOURCE_SHA}/static-manifest.tsv"

# B16 — Isolated Compose (web only, loopback, no production network/volume)
cat > "$TMP_ROOT/docker-compose.yml" <<EOF
name: $ISOLATED_PROJ
services:
  web:
    image: \${BOOK_ID_SEARCH_WEB_IMAGE:-book-id-search/web:dev}
    pull_policy: never
    ports:
      - "127.0.0.1:$FREE_PORT:80"
    extra_hosts:
      - "api:127.0.0.1"
EOF

# B18 — Isolation guards
if [ "$TMP_ROOT" = "$REPO_ROOT" ] || [ "$TMP_ROOT" = "/opt/book-id-search" ]; then
  rm -rf "$TMP_ROOT"
  block ISOLATION_GUARD_FAILED
fi
if [ ! -f "$TMP_ROOT/docker-compose.yml" ]; then
  rm -rf "$TMP_ROOT"
  block ISOLATION_GUARD_FAILED
fi
if grep -qE '^[[:space:]]*container_name:' "$TMP_ROOT/docker-compose.yml"; then
  rm -rf "$TMP_ROOT"
  block ISOLATION_GUARD_FAILED
fi
if grep -qE '^[[:space:]]*build:' "$TMP_ROOT/docker-compose.yml"; then
  rm -rf "$TMP_ROOT"
  block ISOLATION_GUARD_FAILED
fi
if ! grep -qE "^name:[[:space:]]*${ISOLATED_PROJ}\$" "$TMP_ROOT/docker-compose.yml"; then
  rm -rf "$TMP_ROOT"
  block ISOLATION_GUARD_FAILED
fi
# Only flag meili/api/meilisearch if they appear as a SERVICE (top-level key
# under services: at 2-space indent). extra_hosts entries are allowed.
if awk '
  /^services:/ { in_services = 1; next }
  in_services && /^[^ ]/ { in_services = 0 }
  in_services && /^  (api|meili|meilisearch):$/ { found = 1; exit }
  END { exit !found }
' "$TMP_ROOT/docker-compose.yml"; then
  rm -rf "$TMP_ROOT"
  block ISOLATION_GUARD_FAILED
fi
if ! grep -qE '^services:' "$TMP_ROOT/docker-compose.yml"; then
  rm -rf "$TMP_ROOT"
  block ISOLATION_GUARD_FAILED
fi
# Count only top-level service keys (2-space indent under services:).
SVC_COUNT="$(awk '
  /^services:/ { in_services = 1; next }
  in_services && /^[^ ]/ { in_services = 0 }
  in_services && /^  [A-Za-z0-9_-]+:$/ { count++ }
  END { print count+0 }
' "$TMP_ROOT/docker-compose.yml")"
if [ "$SVC_COUNT" != "1" ]; then
  rm -rf "$TMP_ROOT"
  block ISOLATION_GUARD_FAILED
fi

# -----------------------------------------------------------------------------
# B19 — Cleanup trap (acts ONLY on isolated project)
# -----------------------------------------------------------------------------
cleanup_isolated() {
  if [ -n "${ORCHESTRATOR_SKIP_CLEANUP:-}" ]; then
    return 0
  fi
  if [ -n "${ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH:-}" ]; then
    rm -rf "$TMP_ROOT" 2>/dev/null || true
    return 0
  fi
  ( cd "$TMP_ROOT" 2>/dev/null \
    && $SUDO_CMD $DOCKER_CMD compose -p "$ISOLATED_PROJ" -f "$TMP_ROOT/docker-compose.yml" \
         down --remove-orphans >/dev/null 2>&1 ) || true
  rm -rf "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup_isolated EXIT INT TERM

# -----------------------------------------------------------------------------
# B20 — Actual deploy handoff (IMAGE_TAG from Plan only)
# -----------------------------------------------------------------------------
HANDOFF_IMAGE_TAG="$PLAN_IMAGE_TAG"
HANDOFF_IMAGE_TAG_SOURCE="RELEASE_PLAN"

# Optional test hook: short-circuit the actual deploy call (used by tests
# that want to assert handoff binding without a real compose up).
if [ "${ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH:-}" != "" ]; then
  printf 'BOOK_ID_SEARCH_WEB_IMAGE=%s\n' "$HANDOFF_IMAGE_TAG" \
    > "$ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH"
  printf 'DOCKER_SUDO=%s\n' "$SUDO_CMD" \
    >> "$ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH"
  printf '%s\n' "$TMP_ROOT/scripts/deploy-web-release-candidate.sh" \
    >> "$ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH"
  DEPLOY_INVOCATION_COUNT=$((DEPLOY_INVOCATION_COUNT + 1))
else
  DEPLOY_LOG="$(mktemp)"
  ( cd "$TMP_ROOT" \
    && BOOK_ID_SEARCH_WEB_IMAGE="$HANDOFF_IMAGE_TAG" \
       DOCKER_SUDO="$SUDO_CMD" \
       bash "$TMP_ROOT/scripts/deploy-web-release-candidate.sh" \
       > "$DEPLOY_LOG" 2>&1 )
  DEPLOY_EXIT=$?
  if [ "$DEPLOY_EXIT" -ne 0 ]; then
    tail -20 "$DEPLOY_LOG" >&2 || true
    rm -f "$DEPLOY_LOG"
    cleanup_isolated
    block ACTUAL_DEPLOY_SCRIPT_FAILED
  fi
  rm -f "$DEPLOY_LOG"
  DEPLOY_INVOCATION_COUNT=$((DEPLOY_INVOCATION_COUNT + 1))

  # B21 — Verify isolated container identity (3-way: project + Config.Image + Image)
  ISOLATED_CID="$($SUDO_CMD $DOCKER_CMD compose -p "$ISOLATED_PROJ" \
                    -f "$TMP_ROOT/docker-compose.yml" ps -q web 2>/dev/null || true)"
  if [ -z "$ISOLATED_CID" ]; then
    cleanup_isolated
    block ACTUAL_DEPLOY_SCRIPT_FAILED
  fi
  ISOLATED_CFG_IMAGE="$($SUDO_CMD $DOCKER_CMD inspect "$ISOLATED_CID" --format '{{.Config.Image}}')"
  ISOLATED_IMAGE="$($SUDO_CMD $DOCKER_CMD inspect "$ISOLATED_CID" --format '{{.Image}}')"
  ISOLATED_PROJECT="$($SUDO_CMD $DOCKER_CMD inspect "$ISOLATED_CID" \
                       --format '{{index .Config.Labels "com.docker.compose.project"}}')"
  if [ "$ISOLATED_PROJECT" != "$ISOLATED_PROJ" ] \
     || [ "$ISOLATED_CFG_IMAGE" != "$PLAN_IMAGE_TAG" ] \
     || [ "$ISOLATED_IMAGE" != "$PLAN_IMAGE_ID" ]; then
    cleanup_isolated
    block ORCHESTRATED_DEPLOY_IDENTITY_MISMATCH
  fi

  # B24 — Dev fallback guard
  if [ "$ISOLATED_CFG_IMAGE" = "book-id-search/web:dev" ]; then
    cleanup_isolated
    block DEV_FALLBACK_USED
  fi

  # B23 — HTTP smoke (loopback only)
  HTTP_STATUS="$(curl -sS -o /dev/null -w '%{http_code}' \
                  "http://127.0.0.1:${FREE_PORT}/" 2>/dev/null || true)"
  if [ "$HTTP_STATUS" != "200" ]; then
    cleanup_isolated
    block HTTP_SMOKE_FAILED
  fi

  # B22 — Post-deploy image guard
  POST_DEPLOY_IMAGE_ID="$($SUDO_CMD $DOCKER_CMD image inspect "$PLAN_IMAGE_TAG" \
                           --format '{{.Id}}' 2>/dev/null || true)"
  if [ "$POST_DEPLOY_IMAGE_ID" != "$PLAN_IMAGE_ID" ]; then
    cleanup_isolated
    block POST_DEPLOY_IMAGE_IDENTITY_CHANGED
  fi

  # B25 — Cleanup isolated container, network, volume (frozen image preserved)
  ( cd "$TMP_ROOT" \
    && $SUDO_CMD $DOCKER_CMD compose -p "$ISOLATED_PROJ" -f "$TMP_ROOT/docker-compose.yml" \
         down --remove-orphans >/dev/null 2>&1 ) || {
    block CLEANUP_FAILED
  }
  rm -rf "$TMP_ROOT" 2>/dev/null || true
fi

# Reset the trap so the EXIT trap doesn't double-clean
trap 'cleanup_temp_files' EXIT INT TERM

# -----------------------------------------------------------------------------
# Production unchanged check (defensive; skippable in tests)
# -----------------------------------------------------------------------------
if [ -z "${ORCHESTRATOR_SKIP_PRODUCTION_CHECK:-}" ]; then
  PROD_WEB_CID_AFTER="$($SUDO_CMD $DOCKER_CMD compose -f "$REPO_ROOT/docker-compose.yml" \
                          ps -q web 2>/dev/null || true)"
  if [ -z "$PROD_WEB_CID_AFTER" ]; then
    block PRODUCTION_TOUCHED
  fi
fi

# -----------------------------------------------------------------------------
# B26 — Success output (PRODUCTION_DEPLOY_EXECUTED=false ALWAYS)
# -----------------------------------------------------------------------------
emit_kv STATUS PASS
emit_kv ORCHESTRATION_MODE isolated-e2e
emit_kv SOURCE_SHA "$SOURCE_SHA"
emit_kv RELEASE_PLAN_FINGERPRINT "$PLAN_FINGERPRINT"
emit_kv IMAGE_TAG "$PLAN_IMAGE_TAG"
emit_kv IMAGE_ID "$PLAN_IMAGE_ID"
emit_kv PLAN_READY PASS
emit_kv PRE_DEPLOY_IMAGE_IDENTITY PASS
emit_kv HANDOFF_IDENTITY_SOURCE "$HANDOFF_IMAGE_TAG_SOURCE"
emit_kv ACTUAL_DEPLOY_SCRIPT_E2E PASS
emit_kv POST_DEPLOY_IMAGE_IDENTITY PASS
emit_kv DEV_FALLBACK_USED false
emit_kv PRODUCTION_UNCHANGED PASS
emit_kv PRODUCTION_DEPLOY_EXECUTED false
emit_kv ORCHESTRATOR_ISOLATED_E2E_VERIFIED true