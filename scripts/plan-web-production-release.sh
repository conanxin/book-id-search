#!/usr/bin/env bash
# Production Release Plan Contract Tool.
#
# Calls the Unified Web Release Readiness Gate (forces real isolated E2E),
# parses its machine-readable output, validates every identity field,
# generates a deterministic Release Plan with a fingerprint that binds:
#   SOURCE_SHA + IMAGE_TAG + IMAGE_ID + MANIFEST_SHA + LOCKFILE_SHA
#
# This script NEVER deploys. It does not invoke the deploy script, does
# not run `docker compose up`, and does not modify production.
#
# Usage:
#   scripts/plan-web-production-release.sh <SOURCE_SHA>
#
# Output contract (success):
#   STATUS=PASS
#   RELEASE_PLAN_VERSION=1
#   SOURCE_SHA=<...>
#   IMAGE_TAG=<...>
#   IMAGE_ID=<...>
#   MANIFEST_SHA=<...>
#   LOCKFILE_SHA=<...>
#   RELEASE_PLAN_FINGERPRINT=<...>
#   READINESS_GATE=PASS
#   ISOLATED_E2E=PASS
#   PRODUCTION_UNCHANGED=PASS
#   RELEASE_PLAN_READY=true
#   DEPLOY_EXECUTED=false
#   CURRENT_HEAD=<...>   (informational; not in fingerprint)
#
# Output contract (block):
#   STATUS=BLOCKED
#   BLOCK_REASON=<enum>
#   RELEASE_PLAN_READY=false
#   DEPLOY_EXECUTED=false
#
# Block reasons (enum):
#   INVALID_SOURCE_SHA
#   READINESS_GATE_FAILED
#   READINESS_NOT_READY
#   READINESS_OUTPUT_INCOMPLETE
#   READINESS_OUTPUT_AMBIGUOUS
#   SOURCE_IDENTITY_MISMATCH
#   INVALID_IMAGE_TAG
#   INVALID_IMAGE_ID
#   INVALID_MANIFEST_SHA
#   INVALID_LOCKFILE_SHA

set -uo pipefail

block() {
  local reason="$1"
  printf '%s\n' \
    "STATUS=BLOCKED" \
    "BLOCK_REASON=$reason" \
    "RELEASE_PLAN_READY=false" \
    "DEPLOY_EXECUTED=false"
  exit 1
}

# -----------------------------------------------------------------------------
# Resolve script directory (script-relative, no hardcoded /opt path)
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(
  CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd
)" || block INTERNAL_SCRIPT_DIR_RESOLUTION_FAILED

# Readiness gate is a sibling file in the same scripts directory
READINESS_GATE="$SCRIPT_DIR/verify-web-release-readiness.sh"
if [ ! -x "$READINESS_GATE" ]; then
  block READINESS_GATE_NOT_FOUND
fi

REPO_ROOT="$SCRIPT_DIR/.."

# -----------------------------------------------------------------------------
# A4 — INPUT: SOURCE_SHA only
# -----------------------------------------------------------------------------
USER_SOURCE_SHA="${1:-}"
if [ -z "$USER_SOURCE_SHA" ]; then
  block INVALID_SOURCE_SHA
fi

# Must be 40 hex characters; accept mixed case input, canonicalize to lowercase
if ! printf '%s' "$USER_SOURCE_SHA" | grep -qE '^[0-9a-fA-F]{40}$'; then
  block INVALID_SOURCE_SHA
fi

# Must be a valid commit object in the repository (case-insensitive lookup)
if ! git -C "$REPO_ROOT" cat-file -e "${USER_SOURCE_SHA}^{commit}" 2>/dev/null; then
  block INVALID_SOURCE_SHA
fi

SOURCE_SHA="$(git -C "$REPO_ROOT" rev-parse "${USER_SOURCE_SHA}^{commit}")"
CURRENT_HEAD="$(git -C "$REPO_ROOT" rev-parse HEAD)"

# -----------------------------------------------------------------------------
# A5 — Force REAL isolated E2E (override caller)
# -----------------------------------------------------------------------------
# Caller-supplied RUN_REAL_ISOLATED_E2E is intentionally ignored.
export RUN_REAL_ISOLATED_E2E=1

# -----------------------------------------------------------------------------
# A7 — Capture gate output safely (text only, never eval)
# -----------------------------------------------------------------------------
GATE_STDOUT="$(mktemp)"
GATE_STDERR="$(mktemp)"
trap 'rm -f "$GATE_STDOUT" "$GATE_STDERR" 2>/dev/null || true' EXIT INT TERM

"$READINESS_GATE" "$SOURCE_SHA" >"$GATE_STDOUT" 2>"$GATE_STDERR"
GATE_EXIT=$?

# -----------------------------------------------------------------------------
# A8 — Gate must PASS
# -----------------------------------------------------------------------------
if [ "$GATE_EXIT" -ne 0 ]; then
  printf '%s\n' \
    "STATUS=BLOCKED" \
    "BLOCK_REASON=READINESS_GATE_FAILED" \
    "RELEASE_PLAN_READY=false" \
    "DEPLOY_EXECUTED=false"
  # Surface the gate's BLOCK_REASON if it had one
  gate_reason="$(grep -E '^BLOCK_REASON=' "$GATE_STDOUT" 2>/dev/null | head -1 | cut -d= -f2-)"
  if [ -n "$gate_reason" ]; then
    printf '%s\n' "GATE_BLOCK_REASON=$gate_reason"
  fi
  exit 3
fi

# -----------------------------------------------------------------------------
# Field extraction helpers
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

GATE_STATUS="$(field_value STATUS "$GATE_STDOUT")"
if [ "$GATE_STATUS" != "PASS" ]; then
  block READINESS_GATE_FAILED
fi

# -----------------------------------------------------------------------------
# A9 — READY must be exactly one occurrence and exactly "true"
# -----------------------------------------------------------------------------
ready_count="$(field_count READY_FOR_PRODUCTION_DEPLOY "$GATE_STDOUT")"
GATE_READY="$(field_value READY_FOR_PRODUCTION_DEPLOY "$GATE_STDOUT")"
if [ "$ready_count" -ne 1 ]; then
  block READINESS_OUTPUT_AMBIGUOUS
fi
if [ "$GATE_READY" != "true" ]; then
  block READINESS_NOT_READY
fi

# ISOLATED_E2E must be PASS (mandatory gate)
GATE_ISOLATED_E2E="$(field_value ISOLATED_E2E "$GATE_STDOUT")"
if [ "$GATE_ISOLATED_E2E" != "PASS" ]; then
  block READINESS_NOT_READY
fi

# -----------------------------------------------------------------------------
# A10 — Identity fields must be present and unique
# -----------------------------------------------------------------------------
for key in SOURCE_SHA IMAGE_TAG IMAGE_ID MANIFEST_SHA LOCKFILE_SHA; do
  count="$(field_count "$key" "$GATE_STDOUT")"
  if [ "$count" -eq 0 ]; then
    block READINESS_OUTPUT_INCOMPLETE
  fi
  if [ "$count" -gt 1 ]; then
    block READINESS_OUTPUT_AMBIGUOUS
  fi
done

GATE_SOURCE_SHA="$(field_value SOURCE_SHA "$GATE_STDOUT")"
GATE_IMAGE_TAG="$(field_value IMAGE_TAG "$GATE_STDOUT")"
GATE_IMAGE_ID="$(field_value IMAGE_ID "$GATE_STDOUT")"
GATE_MANIFEST_SHA="$(field_value MANIFEST_SHA "$GATE_STDOUT")"
GATE_LOCKFILE_SHA="$(field_value LOCKFILE_SHA "$GATE_STDOUT")"

# -----------------------------------------------------------------------------
# A11 — Source binding
# -----------------------------------------------------------------------------
if [ "$GATE_SOURCE_SHA" != "$SOURCE_SHA" ]; then
  block SOURCE_IDENTITY_MISMATCH
fi

# -----------------------------------------------------------------------------
# A12 — IMAGE_TAG safety: reject shell metacharacters and whitespace
# -----------------------------------------------------------------------------
if [ -z "$GATE_IMAGE_TAG" ]; then
  block INVALID_IMAGE_TAG
fi
# Reject explicit forbidden characters / whitespace
if printf '%s' "$GATE_IMAGE_TAG" | grep -qE '[[:space:];&|`<>()]'; then
  block INVALID_IMAGE_TAG
fi
# Validate allowed Docker reference grammar characters
if ! printf '%s' "$GATE_IMAGE_TAG" | grep -qE '^[A-Za-z0-9][A-Za-z0-9_./:.-]*$'; then
  block INVALID_IMAGE_TAG
fi

# -----------------------------------------------------------------------------
# A13 — IMAGE_ID contract
# -----------------------------------------------------------------------------
if ! printf '%s' "$GATE_IMAGE_ID" | grep -qE '^sha256:[0-9a-f]{64}$'; then
  block INVALID_IMAGE_ID
fi

# -----------------------------------------------------------------------------
# A14 — MANIFEST_SHA / LOCKFILE_SHA contract
# -----------------------------------------------------------------------------
if ! printf '%s' "$GATE_MANIFEST_SHA" | grep -qE '^[a-f0-9]{64}$'; then
  block INVALID_MANIFEST_SHA
fi
if ! printf '%s' "$GATE_LOCKFILE_SHA" | grep -qE '^[a-f0-9]{64}$'; then
  block INVALID_LOCKFILE_SHA
fi

# -----------------------------------------------------------------------------
# A15 — Deterministic fingerprint over canonical serialization
# -----------------------------------------------------------------------------
FINGERPRINT="$(printf '%s\n%s\n%s\n%s\n%s\n' \
  "SOURCE_SHA=$GATE_SOURCE_SHA" \
  "IMAGE_TAG=$GATE_IMAGE_TAG" \
  "IMAGE_ID=$GATE_IMAGE_ID" \
  "MANIFEST_SHA=$GATE_MANIFEST_SHA" \
  "LOCKFILE_SHA=$GATE_LOCKFILE_SHA" \
  | sha256sum | awk '{print $1}')"

# -----------------------------------------------------------------------------
# A16 — Success output
# -----------------------------------------------------------------------------
printf '%s\n' \
  "STATUS=PASS" \
  "RELEASE_PLAN_VERSION=1" \
  "SOURCE_SHA=$GATE_SOURCE_SHA" \
  "IMAGE_TAG=$GATE_IMAGE_TAG" \
  "IMAGE_ID=$GATE_IMAGE_ID" \
  "MANIFEST_SHA=$GATE_MANIFEST_SHA" \
  "LOCKFILE_SHA=$GATE_LOCKFILE_SHA" \
  "RELEASE_PLAN_FINGERPRINT=$FINGERPRINT" \
  "READINESS_GATE=PASS" \
  "ISOLATED_E2E=PASS" \
  "PRODUCTION_UNCHANGED=PASS" \
  "RELEASE_PLAN_READY=true" \
  "DEPLOY_EXECUTED=false" \
  "CURRENT_HEAD=$CURRENT_HEAD"