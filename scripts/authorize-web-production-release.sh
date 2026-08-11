#!/usr/bin/env bash
# S27T-4A Production Deployment Authorization Contract.
#
# Generates a machine-bound Authorization Artifact that says:
# "For SOURCE_SHA, the operator explicitly authorized a production deploy
#  against the verified Release Plan with fingerprint F."
#
# This script does NOT deploy. It does NOT call the orchestrator. It does
# NOT modify production. It only:
#   1. Calls the sibling Release Plan script (read-only, returns frozen
#      identity).
#   2. Recomputes the Plan fingerprint independently.
#   3. Validates Plan identity (status, ready, source, fingerprint).
#   4. Writes a single authorization artifact whose filename is
#      determined by the Plan Fingerprint.
#   5. Reads back the artifact to verify byte-for-byte field correctness.
#
# The artifact is consumable-once. If an artifact with the same fingerprint
# already exists, we BLOCK — an authorization is an explicit event and may
# not be silently overwritten.
#
# Usage:
#   scripts/authorize-web-production-release.sh \
#       --approve-production-deploy <SOURCE_SHA>
#
# Required input (machine-equivalent):
#   --approve-production-deploy   explicit approval flag (HARD GATE)
#   SOURCE_SHA                    40-hex git commit
#
# Block reasons (enum):
#   INVALID_ARGUMENTS
#   EXPLICIT_APPROVAL_REQUIRED
#   INVALID_SOURCE_SHA
#   RELEASE_PLAN_FAILED
#   RELEASE_PLAN_NOT_READY
#   RELEASE_PLAN_OUTPUT_INCOMPLETE
#   RELEASE_PLAN_OUTPUT_AMBIGUOUS
#   SOURCE_IDENTITY_MISMATCH
#   RELEASE_PLAN_FINGERPRINT_MISMATCH
#   AUTHORIZATION_ALREADY_EXISTS
#   AUTHORIZATION_WRITE_FAILED
#   AUTHORIZATION_VALIDATION_FAILED
#
# Forbidden (this script):
#   - Invoking sibling R3 orchestrator
#   - Invoking sibling deploy script
#   - Running container orchestration commands
#   - Evaluating or sourcing Plan output
#   - Accepting IMAGE_TAG / IMAGE_ID / MANIFEST / LOCKFILE / FINGERPRINT
#     as positional input or --flag input
#   - Modifying production
#   - Adding timestamp / random / uuid / hostname / user info to artifact

set -uo pipefail

# -----------------------------------------------------------------------------
# Output helpers
# -----------------------------------------------------------------------------
emit_kv() { printf '%s=%s\n' "$1" "$2"; }

block() {
  local reason="$1"
  emit_kv STATUS BLOCKED
  emit_kv BLOCK_REASON "$reason"
  emit_kv PRODUCTION_DEPLOY_AUTHORIZED false
  emit_kv PRODUCTION_DEPLOY_EXECUTED false
  exit 1
}

# -----------------------------------------------------------------------------
# Sibling Plan resolution
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLAN_SCRIPT="$SCRIPT_DIR/plan-web-production-release.sh"

# Hard gate: the sibling plan must exist
if [ ! -f "$PLAN_SCRIPT" ]; then
  block INVALID_ARGUMENTS
fi

# Refuse the override traps (no PLAN_SCRIPT_OVERRIDE)
# This is a static guard; we simply do not honor any override.

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------
APPROVAL_FLAG=""
SOURCE_SHA=""

# Tolerate no surrounding whitespace in flag values.
while [ $# -gt 0 ]; do
  case "$1" in
    --approve-production-deploy)
      if [ -n "$APPROVAL_FLAG" ]; then
        block INVALID_ARGUMENTS
      fi
      APPROVAL_FLAG="yes"
      shift
      ;;
    --*)
      # Any other --flag is forbidden (identity flags banned)
      block INVALID_ARGUMENTS
      ;;
    *)
      # Positional: must be SOURCE_SHA (only one allowed)
      if [ -n "$SOURCE_SHA" ]; then
        block INVALID_ARGUMENTS
      fi
      SOURCE_SHA="$1"
      shift
      ;;
  esac
done

# -----------------------------------------------------------------------------
# A5. Explicit approval HARD gate
# -----------------------------------------------------------------------------
if [ "$APPROVAL_FLAG" != "yes" ]; then
  block EXPLICIT_APPROVAL_REQUIRED
fi

# -----------------------------------------------------------------------------
# A4. Source SHA validation
# -----------------------------------------------------------------------------
if [ -z "$SOURCE_SHA" ]; then
  block INVALID_ARGUMENTS
fi

# 40 hex chars only
if ! printf '%s' "$SOURCE_SHA" | grep -qE '^[0-9a-f]{40}$'; then
  block INVALID_SOURCE_SHA
fi

# -----------------------------------------------------------------------------
# A7. Plan invocation (mktemp capture, no shell-side re-parsing of output)
# -----------------------------------------------------------------------------
PLAN_STDOUT="$(mktemp)"
PLAN_STDERR="$(mktemp)"
PLAN_EXIT=0
"$PLAN_SCRIPT" "$SOURCE_SHA" > "$PLAN_STDOUT" 2> "$PLAN_STDERR"
PLAN_EXIT=$?

if [ "$PLAN_EXIT" -ne 0 ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block RELEASE_PLAN_FAILED
fi

# -----------------------------------------------------------------------------
# A8. Plan output parsing (grep-only, no shell-side re-parsing)
# -----------------------------------------------------------------------------
parse_kv() {
  # Reads $1 key from $PLAN_STDOUT, returns the value.
  # Multi-line output: a key with multiple matches is AMBIGUOUS.
  local key="$1"
  local matches
  matches="$(grep -E "^${key}=" "$PLAN_STDOUT" | wc -l | tr -d '[:space:]')"
  if [ "${matches:-0}" -eq 0 ]; then
    return 1
  fi
  if [ "${matches:-0}" -gt 1 ]; then
    echo "AMBIGUOUS:$matches" >&2
    return 2
  fi
  grep -E "^${key}=" "$PLAN_STDOUT" | head -1 | sed -e "s/^${key}=//"
}

# A8.1 Required fields
REQUIRED_KEYS=(
  STATUS
  RELEASE_PLAN_VERSION
  SOURCE_SHA
  IMAGE_TAG
  IMAGE_ID
  MANIFEST_SHA
  LOCKFILE_SHA
  RELEASE_PLAN_FINGERPRINT
  READINESS_GATE
  ISOLATED_E2E
  PRODUCTION_UNCHANGED
  RELEASE_PLAN_READY
  DEPLOY_EXECUTED
)

declare -A PLAN_KV
for key in "${REQUIRED_KEYS[@]}"; do
  val=""
  rc=0
  val="$(parse_kv "$key")" || rc=$?
  if [ $rc -eq 1 ]; then
    rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
    block RELEASE_PLAN_OUTPUT_INCOMPLETE
  fi
  if [ $rc -eq 2 ]; then
    rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
    block RELEASE_PLAN_OUTPUT_AMBIGUOUS
  fi
  PLAN_KV[$key]="$val"
done

# A8.2 Plan MUST be READY
if [ "${PLAN_KV[STATUS]}" != "PASS" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block RELEASE_PLAN_NOT_READY
fi
if [ "${PLAN_KV[RELEASE_PLAN_VERSION]}" != "1" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block RELEASE_PLAN_NOT_READY
fi
if [ "${PLAN_KV[RELEASE_PLAN_READY]}" != "true" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block RELEASE_PLAN_NOT_READY
fi
if [ "${PLAN_KV[READINESS_GATE]}" != "PASS" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block RELEASE_PLAN_NOT_READY
fi
if [ "${PLAN_KV[ISOLATED_E2E]}" != "PASS" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block RELEASE_PLAN_NOT_READY
fi
if [ "${PLAN_KV[PRODUCTION_UNCHANGED]}" != "PASS" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block RELEASE_PLAN_NOT_READY
fi
if [ "${PLAN_KV[DEPLOY_EXECUTED]}" != "false" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block RELEASE_PLAN_NOT_READY
fi

# -----------------------------------------------------------------------------
# A10. Source binding
# -----------------------------------------------------------------------------
if [ "${PLAN_KV[SOURCE_SHA]}" != "$SOURCE_SHA" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block SOURCE_IDENTITY_MISMATCH
fi

# Validate that the resolved SOURCE_SHA is a canonical commit in this repo.
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
RESOLVED_SHA="$(git -C "$REPO_ROOT" rev-parse "${SOURCE_SHA}^{commit}" 2>/dev/null || true)"
if [ -z "$RESOLVED_SHA" ] || [ "$RESOLVED_SHA" != "$SOURCE_SHA" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block INVALID_SOURCE_SHA
fi

# -----------------------------------------------------------------------------
# A9. Fingerprint independent recomputation
# -----------------------------------------------------------------------------
COMPUTED_FP="$(printf '%s\n%s\n%s\n%s\n%s\n' \
  "SOURCE_SHA=${PLAN_KV[SOURCE_SHA]}" \
  "IMAGE_TAG=${PLAN_KV[IMAGE_TAG]}" \
  "IMAGE_ID=${PLAN_KV[IMAGE_ID]}" \
  "MANIFEST_SHA=${PLAN_KV[MANIFEST_SHA]}" \
  "LOCKFILE_SHA=${PLAN_KV[LOCKFILE_SHA]}" \
  | sha256sum | awk '{print $1}')"

if [ "$COMPUTED_FP" != "${PLAN_KV[RELEASE_PLAN_FINGERPRINT]}" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block RELEASE_PLAN_FINGERPRINT_MISMATCH
fi

# -----------------------------------------------------------------------------
# A11. Authorization Artifact construction
# -----------------------------------------------------------------------------
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
PROGRESS_DIR="${AUTHORIZATION_OUTPUT_DIR:-$REPO_ROOT/progress}"

# Sanity: PROGRESS_DIR must be inside the repo's progress/ OR explicitly
# overridden.
if [ ! -d "$PROGRESS_DIR" ]; then
  mkdir -p "$PROGRESS_DIR" 2>/dev/null || {
    rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
    block AUTHORIZATION_WRITE_FAILED
  }
fi

ARTIFACT_PATH="$PROGRESS_DIR/web-release-authorization-${COMPUTED_FP}.env"

# -----------------------------------------------------------------------------
# A13. Existing Authorization → BLOCK
# -----------------------------------------------------------------------------
if [ -f "$ARTIFACT_PATH" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_ALREADY_EXISTS
fi

# -----------------------------------------------------------------------------
# A12. Atomic write (umask 077, mode 0600, temp file → mv)
# -----------------------------------------------------------------------------
TMP_ARTIFACT="$(mktemp "$PROGRESS_DIR/.web-release-authorization.XXXXXX")" || {
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_WRITE_FAILED
}

umask 077

cat > "$TMP_ARTIFACT" <<EOF
AUTHORIZATION_VERSION=1
AUTHORIZED_ACTION=production-deploy
SOURCE_SHA=${PLAN_KV[SOURCE_SHA]}
RELEASE_PLAN_FINGERPRINT=${PLAN_KV[RELEASE_PLAN_FINGERPRINT]}
IMAGE_TAG=${PLAN_KV[IMAGE_TAG]}
IMAGE_ID=${PLAN_KV[IMAGE_ID]}
MANIFEST_SHA=${PLAN_KV[MANIFEST_SHA]}
LOCKFILE_SHA=${PLAN_KV[LOCKFILE_SHA]}
EXPLICIT_APPROVAL=true
CONSUMABLE_ONCE=true
PRODUCTION_DEPLOY_AUTHORIZED=true
PRODUCTION_DEPLOY_EXECUTED=false
EOF

chmod 0600 "$TMP_ARTIFACT"

# fsync best-effort
if command -v sync >/dev/null 2>&1; then
  sync 2>/dev/null || true
fi

mv "$TMP_ARTIFACT" "$ARTIFACT_PATH" || {
  rm -f "$TMP_ARTIFACT"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_WRITE_FAILED
}

# -----------------------------------------------------------------------------
# A14. Read back validation
# -----------------------------------------------------------------------------
REQUIRED_ARTIFACT_KEYS=(
  AUTHORIZATION_VERSION
  AUTHORIZED_ACTION
  SOURCE_SHA
  RELEASE_PLAN_FINGERPRINT
  IMAGE_TAG
  IMAGE_ID
  MANIFEST_SHA
  LOCKFILE_SHA
  EXPLICIT_APPROVAL
  CONSUMABLE_ONCE
  PRODUCTION_DEPLOY_AUTHORIZED
  PRODUCTION_DEPLOY_EXECUTED
)

for key in "${REQUIRED_ARTIFACT_KEYS[@]}"; do
  if ! grep -qE "^${key}=" "$ARTIFACT_PATH"; then
    rm -f "$ARTIFACT_PATH"
    rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
    block AUTHORIZATION_VALIDATION_FAILED
  fi
done

# Confirm artifact fingerprint equals Plan fingerprint
ARTIFACT_FP="$(grep -E '^RELEASE_PLAN_FINGERPRINT=' "$ARTIFACT_PATH" | head -1 | sed 's/^RELEASE_PLAN_FINGERPRINT=//')"
if [ "$ARTIFACT_FP" != "$COMPUTED_FP" ]; then
  rm -f "$ARTIFACT_PATH"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_VALIDATION_FAILED
fi

# Confirm artifact source equals Plan source
ARTIFACT_SRC="$(grep -E '^SOURCE_SHA=' "$ARTIFACT_PATH" | head -1 | sed 's/^SOURCE_SHA=//')"
if [ "$ARTIFACT_SRC" != "${PLAN_KV[SOURCE_SHA]}" ]; then
  rm -f "$ARTIFACT_PATH"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_VALIDATION_FAILED
fi

# Confirm artifact image-id matches Plan image-id
ARTIFACT_IID="$(grep -E '^IMAGE_ID=' "$ARTIFACT_PATH" | head -1 | sed 's/^IMAGE_ID=//')"
if [ "$ARTIFACT_IID" != "${PLAN_KV[IMAGE_ID]}" ]; then
  rm -f "$ARTIFACT_PATH"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_VALIDATION_FAILED
fi

# Confirm artifact image-tag matches Plan image-tag
ARTIFACT_TAG="$(grep -E '^IMAGE_TAG=' "$ARTIFACT_PATH" | head -1 | sed 's/^IMAGE_TAG=//')"
if [ "$ARTIFACT_TAG" != "${PLAN_KV[IMAGE_TAG]}" ]; then
  rm -f "$ARTIFACT_PATH"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_VALIDATION_FAILED
fi

# Deterministic filename
ACTUAL_FILENAME="$(basename "$ARTIFACT_PATH")"
EXPECTED_FILENAME="web-release-authorization-${COMPUTED_FP}.env"
if [ "$ACTUAL_FILENAME" != "$EXPECTED_FILENAME" ]; then
  rm -f "$ARTIFACT_PATH"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_VALIDATION_FAILED
fi

# -----------------------------------------------------------------------------
# A15. Success output
# -----------------------------------------------------------------------------
emit_kv STATUS PASS
emit_kv SOURCE_SHA "${PLAN_KV[SOURCE_SHA]}"
emit_kv RELEASE_PLAN_FINGERPRINT "${PLAN_KV[RELEASE_PLAN_FINGERPRINT]}"
emit_kv IMAGE_TAG "${PLAN_KV[IMAGE_TAG]}"
emit_kv IMAGE_ID "${PLAN_KV[IMAGE_ID]}"
emit_kv AUTHORIZATION_VERSION 1
emit_kv AUTHORIZED_ACTION production-deploy
emit_kv EXPLICIT_APPROVAL true
emit_kv CONSUMABLE_ONCE true
emit_kv PRODUCTION_DEPLOY_AUTHORIZED true
emit_kv PRODUCTION_DEPLOY_EXECUTED false
emit_kv AUTHORIZATION_ARTIFACT "$ARTIFACT_PATH"

# Cleanup temp plan captures
rm -f "$PLAN_STDOUT" "$PLAN_STDERR"

exit 0
