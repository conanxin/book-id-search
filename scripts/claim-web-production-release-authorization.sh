#!/usr/bin/env bash
# S27T-4C Atomic One-time Production Authorization Claim Contract.
#
# Claims a single existing Authorization Artifact for one future production
# deployment attempt. Uses POSIX hard-link creation as the atomic primitive.
#
# This script does NOT deploy. It does NOT call the orchestrator. It does
# NOT call the deploy script. It does NOT touch docker, compose, or build.
# It only:
#   1. Calls the sibling Release Plan script (read-only, returns frozen
#      identity).
#   2. Recomputes the Plan fingerprint independently.
#   3. Re-validates the Authorization artifact (file safety, mode 600,
#      12 unique fields, semantic flags, identity match against fresh
#      Plan).
#   4. Pre-checks the claim artifact path.
#   5. Creates the claim atomically via `ln --` (no --force, no overwrite).
#   6. Verifies claim identity (same device/inode, same bytes, mode 600,
#      regular file, not a symlink).
#   7. Verifies the original Authorization artifact is byte-for-byte
#      unchanged (SHA, mode, inode, size).
#
# The claim is the atomic state transition. Concurrent claim attempts are
# arbitrated by the filesystem: exactly one `ln` succeeds, the others fail
# with EEXIST and re-inspect the destination as AUTHORIZATION_ALREADY_CLAIMED.
#
# Usage:
#   scripts/claim-web-production-release-authorization.sh \
#       --claim-production-deploy <SOURCE_SHA>
#
# Required input (machine-equivalent):
#   --claim-production-deploy     explicit claim flag (HARD GATE)
#   SOURCE_SHA                    40-hex git commit
#
# Block reasons (enum):
#   INVALID_ARGUMENTS
#   EXPLICIT_CLAIM_REQUIRED
#   INVALID_SOURCE_SHA
#   RELEASE_PLAN_FAILED
#   RELEASE_PLAN_NOT_READY
#   RELEASE_PLAN_OUTPUT_INCOMPLETE
#   RELEASE_PLAN_OUTPUT_AMBIGUOUS
#   SOURCE_IDENTITY_MISMATCH
#   RELEASE_PLAN_FINGERPRINT_MISMATCH
#   AUTHORIZATION_MISSING
#   AUTHORIZATION_UNSAFE_FILE
#   AUTHORIZATION_UNSAFE_PERMISSIONS
#   AUTHORIZATION_INCOMPLETE
#   AUTHORIZATION_AMBIGUOUS
#   AUTHORIZATION_NOT_CONSUMABLE
#   AUTHORIZATION_PLAN_MISMATCH
#   AUTHORIZATION_UNSAFE_CLAIM_FILE
#   AUTHORIZATION_ALREADY_CLAIMED
#   AUTHORIZATION_CLAIM_FAILED
#   AUTHORIZATION_CLAIM_VALIDATION_FAILED
#
# Forbidden (this script):
#   - Invoking sibling orchestrator / deploy / build scripts
#   - Running container orchestration commands (docker / compose)
#   - Evaluating or sourcing Plan or Authorization output
#   - Accepting --force / -f flag on ln
#   - Accepting IMAGE_TAG / IMAGE_ID / MANIFEST / LOCKFILE / FINGERPRINT
#     as positional input or --flag input
#   - Modifying the original Authorization artifact
#   - Truncating, removing, or replacing an existing claim artifact
#   - Adding timestamp / random / uuid / hostname / user info to claim

set -uo pipefail

# -----------------------------------------------------------------------------
# Output helpers
# -----------------------------------------------------------------------------
emit_kv() { printf '%s=%s\n' "$1" "$2"; }

block() {
  local reason="$1"
  emit_kv STATUS BLOCKED
  emit_kv BLOCK_REASON "$reason"
  emit_kv AUTHORIZATION_CLAIMED false
  emit_kv PRODUCTION_DEPLOY_EXECUTED false
  emit_kv PRODUCTION_DEPLOY_STARTED false
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

# -----------------------------------------------------------------------------
# Argument parsing
# -----------------------------------------------------------------------------
CLAIM_FLAG=""
SOURCE_SHA=""

while [ $# -gt 0 ]; do
  case "$1" in
    --claim-production-deploy)
      if [ -n "$CLAIM_FLAG" ]; then
        block INVALID_ARGUMENTS
      fi
      CLAIM_FLAG="yes"
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
# C4. Explicit claim HARD gate
# -----------------------------------------------------------------------------
if [ "$CLAIM_FLAG" != "yes" ]; then
  block EXPLICIT_CLAIM_REQUIRED
fi

# -----------------------------------------------------------------------------
# Source SHA validation (40 hex chars)
# -----------------------------------------------------------------------------
if [ -z "$SOURCE_SHA" ]; then
  block INVALID_ARGUMENTS
fi

if ! printf '%s' "$SOURCE_SHA" | grep -qE '^[0-9a-f]{40}$'; then
  block INVALID_SOURCE_SHA
fi

# -----------------------------------------------------------------------------
# C6. Plan invocation (mktemp capture, no shell-side re-parsing of output)
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
# C7. Plan output parsing (grep-only, no shell-side re-parsing)
# -----------------------------------------------------------------------------
parse_kv() {
  local key="$1"
  local matches
  matches="$(grep -E "^${key}=" "$PLAN_STDOUT" | wc -l | tr -d '[:space:]')"
  if [ "${matches:-0}" -eq 0 ]; then
    return 1
  fi
  if [ "${matches:-0}" -gt 1 ]; then
    return 2
  fi
  grep -E "^${key}=" "$PLAN_STDOUT" | head -1 | sed -e "s/^${key}=//"
}

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

# Plan MUST be READY
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

# Source binding
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
# C7. Fingerprint independent recomputation
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
# C8. Authorization + Claim artifact path derivation
# -----------------------------------------------------------------------------
PROGRESS_DIR="$REPO_ROOT/progress"
AUTHORIZATION_ARTIFACT="$PROGRESS_DIR/web-release-authorization-${COMPUTED_FP}.env"
CLAIM_ARTIFACT="$PROGRESS_DIR/web-release-authorization-claim-${COMPUTED_FP}.env"

# -----------------------------------------------------------------------------
# C14. Capture original authorization invariant BEFORE claim attempt
# (sha256, mode, device:inode, size)
# -----------------------------------------------------------------------------
if [ ! -e "$AUTHORIZATION_ARTIFACT" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_MISSING
fi

ORIG_AUTH_SHA="$(sha256sum "$AUTHORIZATION_ARTIFACT" | awk '{print $1}')"
ORIG_AUTH_MODE="$(stat -c '%a' "$AUTHORIZATION_ARTIFACT" 2>/dev/null || echo "")"
ORIG_AUTH_INODE="$(stat -c '%d:%i' "$AUTHORIZATION_ARTIFACT" 2>/dev/null || echo "")"
ORIG_AUTH_SIZE="$(stat -c '%s' "$AUTHORIZATION_ARTIFACT" 2>/dev/null || echo 0)"

# -----------------------------------------------------------------------------
# C9. Authorization safety re-validation (no implicit trust of 4B)
# -----------------------------------------------------------------------------
# File safety (regular, not symlink)
if [ -L "$AUTHORIZATION_ARTIFACT" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_UNSAFE_FILE
fi
if [ ! -f "$AUTHORIZATION_ARTIFACT" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_UNSAFE_FILE
fi

# Permission contract (must be 600)
if [ "$ORIG_AUTH_MODE" != "600" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_UNSAFE_PERMISSIONS
fi

# Parse 12 mandatory fields, each exactly once (pure-text grep, no eval)
AUTH_MANDATORY_KEYS=(
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

for key in "${AUTH_MANDATORY_KEYS[@]}"; do
  count="$(grep -cE "^${key}=" "$AUTHORIZATION_ARTIFACT" 2>/dev/null | head -1)"
  count="$(printf '%s' "${count:-0}" | tr -d '[:space:]')"
  if [ "${count:-0}" -eq 0 ]; then
    rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
    block AUTHORIZATION_INCOMPLETE
  fi
  if [ "${count:-0}" -gt 1 ]; then
    rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
    block AUTHORIZATION_AMBIGUOUS
  fi
done

# Semantic flags
read_kv() {
  local key="$1"
  grep -E "^${key}=" "$AUTHORIZATION_ARTIFACT" | head -1 | sed -e "s/^${key}=//"
}

if [ "$(read_kv AUTHORIZATION_VERSION)" != "1" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_NOT_CONSUMABLE
fi
if [ "$(read_kv AUTHORIZED_ACTION)" != "production-deploy" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_NOT_CONSUMABLE
fi
if [ "$(read_kv EXPLICIT_APPROVAL)" != "true" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_NOT_CONSUMABLE
fi
if [ "$(read_kv CONSUMABLE_ONCE)" != "true" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_NOT_CONSUMABLE
fi
if [ "$(read_kv PRODUCTION_DEPLOY_AUTHORIZED)" != "true" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_NOT_CONSUMABLE
fi
if [ "$(read_kv PRODUCTION_DEPLOY_EXECUTED)" != "false" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_ALREADY_CONSUMED
fi

# Identity binding to fresh Plan (every identity field must match)
if [ "$(read_kv SOURCE_SHA)" != "$SOURCE_SHA" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_PLAN_MISMATCH
fi
if [ "$(read_kv RELEASE_PLAN_FINGERPRINT)" != "$COMPUTED_FP" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_PLAN_MISMATCH
fi
if [ "$(read_kv IMAGE_TAG)" != "${PLAN_KV[IMAGE_TAG]}" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_PLAN_MISMATCH
fi
if [ "$(read_kv IMAGE_ID)" != "${PLAN_KV[IMAGE_ID]}" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_PLAN_MISMATCH
fi
if [ "$(read_kv MANIFEST_SHA)" != "${PLAN_KV[MANIFEST_SHA]}" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_PLAN_MISMATCH
fi
if [ "$(read_kv LOCKFILE_SHA)" != "${PLAN_KV[LOCKFILE_SHA]}" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_PLAN_MISMATCH
fi

# -----------------------------------------------------------------------------
# C10. Already-claimed precheck
#
# Not a substitute for atomicity. The atomic primitive is `ln` below.
# This precheck lets us emit the more specific AUTHORIZATION_ALREADY_CLAIMED
# block reason when we observe an existing regular claim, and lets us catch
# attacker-planted unsafe claim files before we attempt ln.
# -----------------------------------------------------------------------------
if [ -L "$CLAIM_ARTIFACT" ]; then
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_UNSAFE_CLAIM_FILE
fi
if [ -e "$CLAIM_ARTIFACT" ]; then
  # Exists as a regular file (or other non-symlink entry). Could be an
  # existing claim from a previous successful run, or attacker-planted.
  if [ ! -f "$CLAIM_ARTIFACT" ]; then
    rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
    block AUTHORIZATION_UNSAFE_CLAIM_FILE
  fi
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_ALREADY_CLAIMED
fi

# -----------------------------------------------------------------------------
# C11. Atomic hard-link claim
#
# `ln -- src dst` is the atomic primitive:
#   - No --force / -f flag (overwrite forbidden).
#   - If destination exists, ln fails with EEXIST.
#   - On success, dst is a new directory entry that references the same
#     inode as src (same device, same inode number).
#   - The original artifact is not modified.
# -----------------------------------------------------------------------------
mkdir -p "$PROGRESS_DIR" 2>/dev/null || {
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_CLAIM_FAILED
}

ln -- "$AUTHORIZATION_ARTIFACT" "$CLAIM_ARTIFACT" 2>/dev/null
LN_EXIT=$?

if [ "$LN_EXIT" -ne 0 ]; then
  # ln failed. Re-inspect destination to distinguish legitimate concurrent
  # winner from unsafe state.
  if [ -L "$CLAIM_ARTIFACT" ]; then
    rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
    block AUTHORIZATION_UNSAFE_CLAIM_FILE
  fi
  if [ -f "$CLAIM_ARTIFACT" ]; then
    rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
    block AUTHORIZATION_ALREADY_CLAIMED
  fi
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_CLAIM_FAILED
fi

# -----------------------------------------------------------------------------
# C12. Claim identity verification (same device:inode as original)
# -----------------------------------------------------------------------------
CLAIM_DEV_INODE="$(stat -c '%d:%i' "$CLAIM_ARTIFACT" 2>/dev/null || echo "")"
if [ "$CLAIM_DEV_INODE" != "$ORIG_AUTH_INODE" ]; then
  rm -f "$CLAIM_ARTIFACT"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_CLAIM_VALIDATION_FAILED
fi

# -----------------------------------------------------------------------------
# C13. Claim byte identity (sha256 identical) + mode/regular/symlink checks
# -----------------------------------------------------------------------------
if [ -L "$CLAIM_ARTIFACT" ]; then
  rm -f "$CLAIM_ARTIFACT"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_CLAIM_VALIDATION_FAILED
fi
if [ ! -f "$CLAIM_ARTIFACT" ]; then
  rm -f "$CLAIM_ARTIFACT"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_CLAIM_VALIDATION_FAILED
fi
CLAIM_MODE="$(stat -c '%a' "$CLAIM_ARTIFACT" 2>/dev/null || echo "")"
if [ "$CLAIM_MODE" != "600" ]; then
  rm -f "$CLAIM_ARTIFACT"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_CLAIM_VALIDATION_FAILED
fi
CLAIM_SHA="$(sha256sum "$CLAIM_ARTIFACT" | awk '{print $1}')"
if [ "$CLAIM_SHA" != "$ORIG_AUTH_SHA" ]; then
  rm -f "$CLAIM_ARTIFACT"
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_CLAIM_VALIDATION_FAILED
fi

# -----------------------------------------------------------------------------
# C14. Original authorization invariance (sha/mode/inode/size unchanged)
# -----------------------------------------------------------------------------
NOW_AUTH_SHA="$(sha256sum "$AUTHORIZATION_ARTIFACT" | awk '{print $1}')"
NOW_AUTH_MODE="$(stat -c '%a' "$AUTHORIZATION_ARTIFACT" 2>/dev/null || echo "")"
NOW_AUTH_INODE="$(stat -c '%d:%i' "$AUTHORIZATION_ARTIFACT" 2>/dev/null || echo "")"
NOW_AUTH_SIZE="$(stat -c '%s' "$AUTHORIZATION_ARTIFACT" 2>/dev/null || echo 0)"

if [ "$NOW_AUTH_SHA"   != "$ORIG_AUTH_SHA"   \
  ] || [ "$NOW_AUTH_MODE"  != "$ORIG_AUTH_MODE"  \
  ] || [ "$NOW_AUTH_INODE" != "$ORIG_AUTH_INODE" \
  ] || [ "$NOW_AUTH_SIZE"  != "$ORIG_AUTH_SIZE" ]; then
  # Original authorization mutated by claim — this must NEVER happen.
  # Defensive cleanup of the just-created claim to leave no garbage.
  rm -f "$CLAIM_ARTIFACT" 2>/dev/null || true
  rm -f "$PLAN_STDOUT" "$PLAN_STDERR"
  block AUTHORIZATION_CLAIM_VALIDATION_FAILED
fi

# -----------------------------------------------------------------------------
# C15. Success output
# -----------------------------------------------------------------------------
emit_kv STATUS PASS
emit_kv SOURCE_SHA "$SOURCE_SHA"
emit_kv RELEASE_PLAN_FINGERPRINT "$COMPUTED_FP"
emit_kv IMAGE_TAG "${PLAN_KV[IMAGE_TAG]}"
emit_kv IMAGE_ID "${PLAN_KV[IMAGE_ID]}"
emit_kv AUTHORIZED_ACTION production-deploy
emit_kv AUTHORIZATION_ARTIFACT "$AUTHORIZATION_ARTIFACT"
emit_kv AUTHORIZATION_CLAIM_ARTIFACT "$CLAIM_ARTIFACT"
emit_kv AUTHORIZATION_CLAIMED true
emit_kv AUTHORIZATION_REUSABLE false
emit_kv CONSUMABLE_ONCE true
emit_kv PRODUCTION_DEPLOY_AUTHORIZED true
emit_kv PRODUCTION_DEPLOY_EXECUTED false
emit_kv PRODUCTION_DEPLOY_STARTED false

# Cleanup temp plan captures
rm -f "$PLAN_STDOUT" "$PLAN_STDERR"

exit 0