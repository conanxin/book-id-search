#!/usr/bin/env bash
# S27T-5E-R6C Static Identity Verifier.
#
# Consumes a real MULTI_FILE_MANIFEST (path<TAB>size<TAB>sha256 per line; one row
# per file extracted from /usr/share/nginx/html/) and a Web container CID, then
# verifies that every manifest entry exists inside the container as a regular
# file whose size and sha256 match the manifest exactly.
#
# Contract:
#   - manifest schema is canonical MULTI_FILE_MANIFEST only
#   - paths in manifest are RELATIVE to /usr/share/nginx/html/
#   - rejects empty manifest, malformed line, duplicate path, absolute host path,
#     .. path traversal, non-hex SHA, non-decimal size, missing container file,
#     size mismatch, sha256 mismatch, non-regular container file
#   - all entries pass => exit 0 + STATUS=PASS on stdout
#   - any entry fails => nonzero + reason on stderr
#
# CLI:
#   scripts/verify-static-identity.sh --manifest <path> --web-cid <cid>
#
# Output (success):
#   STATUS=PASS
#   ENTRIES=<N>
#   MANIFEST_SHA=<64hex>
#
# Output (failure):
#   STATUS=FAIL
#   REASON=<ENUM>
#   ... details on stderr
#
# Exit code: 0 only on STATUS=PASS; nonzero otherwise.
set -euo pipefail

# ---- args ----
MANIFEST=""
WEB_CID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --manifest) MANIFEST="${2:-}"; shift 2 ;;
    --web-cid)  WEB_CID="${2:-}"; shift 2 ;;
    --verify-static-identity)
      # Legacy CLI form (Executor primary path); treat as manifest=CID
      # ONLY when followed by exactly one positional CID. Use --manifest/--web-cid
      # for explicit form.
      if [ -n "${2:-}" ] && [ "${3:-}" = "" ]; then
        WEB_CID="${2:-}"
        shift 2
      else
        echo "STATUS=BLOCKED" >&2
        echo "BLOCK_REASON=INVALID_ARGUMENTS" >&2
        echo "verify-static-identity.sh requires --manifest <path> --web-cid <cid>" >&2
        exit 2
      fi
      ;;
    *) echo "STATUS=BLOCKED" >&2; echo "BLOCK_REASON=INVALID_ARGUMENTS" >&2; exit 2 ;;
  esac
done

# When invoked via legacy form (--verify-static-identity <cid>) without --manifest,
# reject: the legacy form is not enough information for a multi-file verifier.
if [ -z "$MANIFEST" ]; then
  echo "STATUS=BLOCKED" >&2
  echo "BLOCK_REASON=MANIFEST_REQUIRED" >&2
  echo "verify-static-identity.sh requires --manifest <path> --web-cid <cid>" >&2
  exit 2
fi
if [ -z "$WEB_CID" ]; then
  echo "STATUS=BLOCKED" >&2
  echo "BLOCK_REASON=WEB_CID_REQUIRED" >&2
  echo "verify-static-identity.sh requires --manifest <path> --web-cid <cid>" >&2
  exit 2
fi

# ---- manifest validation ----
if [ ! -f "$MANIFEST" ]; then
  echo "STATUS=BLOCKED" >&2
  echo "BLOCK_REASON=MANIFEST_MISSING: $MANIFEST" >&2
  exit 2
fi

# Refuse symlinks for the manifest itself.
if [ -L "$MANIFEST" ]; then
  echo "STATUS=BLOCKED" >&2
  echo "BLOCK_REASON=MANIFEST_UNSAFE_FILE" >&2
  exit 2
fi

LINES="$(wc -l < "$MANIFEST" | tr -d ' ')"
if [ "${LINES:-0}" -lt 1 ]; then
  echo "STATUS=FAIL" >&2
  echo "REASON=MANIFEST_EMPTY" >&2
  exit 1
fi

# Build lookup state.
declare -A SEEN_PATH
declare -a ENTRIES_PATH
declare -a ENTRIES_SIZE
declare -a ENTRIES_SHA

ENTRY=0
while IFS=$'\t' read -r FILE SIZE HASH; do
  ENTRY=$((ENTRY+1))
  # Column count must be exactly 3
  if [ -z "${SIZE:-}" ] || [ -z "${HASH:-}" ]; then
    echo "STATUS=FAIL" >&2
    echo "REASON=MANIFEST_MALFORMED_LINE: line $ENTRY: expected 3 tab-separated columns" >&2
    exit 1
  fi
  # Reject absolute host paths
  case "$FILE" in
    /*|~*)
      echo "STATUS=FAIL" >&2
      echo "REASON=MANIFEST_ABSOLUTE_PATH: line $ENTRY: $FILE" >&2
      exit 1
      ;;
  esac
  # Reject path traversal
  case "$FILE" in
    *..*)
      echo "STATUS=FAIL" >&2
      echo "REASON=MANIFEST_PATH_TRAVERSAL: line $ENTRY: $FILE" >&2
      exit 1
      ;;
  esac
  # Reject empty path
  if [ -z "$FILE" ]; then
    echo "STATUS=FAIL" >&2
    echo "REASON=MANIFEST_EMPTY_PATH: line $ENTRY" >&2
    exit 1
  fi
  # Validate size is decimal
  if ! printf '%s' "$SIZE" | grep -qE '^[0-9]+$'; then
    echo "STATUS=FAIL" >&2
    echo "REASON=MANIFEST_INVALID_SIZE: line $ENTRY: $SIZE" >&2
    exit 1
  fi
  # Validate sha is 64 lowercase hex
  if ! printf '%s' "$HASH" | grep -qE '^[0-9a-f]{64}$'; then
    echo "STATUS=FAIL" >&2
    echo "REASON=MANIFEST_INVALID_SHA: line $ENTRY: $HASH" >&2
    exit 1
  fi
  # Duplicate path
  if [ -n "${SEEN_PATH[$FILE]+set}" ]; then
    echo "STATUS=FAIL" >&2
    echo "REASON=MANIFEST_DUPLICATE_PATH: line $ENTRY: $FILE" >&2
    exit 1
  fi
  SEEN_PATH[$FILE]=1
  ENTRIES_PATH+=("$FILE")
  ENTRIES_SIZE+=("$SIZE")
  ENTRIES_SHA+=("$HASH")
done < "$MANIFEST"

MANIFEST_SHA_LOCAL="$(sha256sum -- "$MANIFEST" | awk '{print $1}')"

# ---- docker exec sanity ----
if ! command -v docker >/dev/null 2>&1; then
  echo "STATUS=FAIL" >&2
  echo "REASON=DOCKER_UNAVAILABLE" >&2
  exit 1
fi

if ! sudo -n docker inspect "$WEB_CID" >/dev/null 2>&1; then
  echo "STATUS=FAIL" >&2
  echo "REASON=WEB_CID_INVALID: $WEB_CID" >&2
  exit 1
fi

# ---- per-entry verification ----
for i in "${!ENTRIES_PATH[@]}"; do
  FILE="${ENTRIES_PATH[$i]}"
  EXPECTED_SIZE="${ENTRIES_SIZE[$i]}"
  EXPECTED_SHA="${ENTRIES_SHA[$i]}"

  # Compose container absolute path. Reject any path containing newline first.
  if [[ "$FILE" == *$'\n'* ]]; then
    echo "STATUS=FAIL" >&2
    echo "REASON=MANIFEST_PATH_NEWLINE: $FILE" >&2
    exit 1
  fi

  CONTAINER_PATH="/usr/share/nginx/html/${FILE}"

  # 1) file must exist (and be a regular file)
  if ! sudo -n docker exec "$WEB_CID" test -f "$CONTAINER_PATH" 2>/dev/null; then
    echo "STATUS=FAIL" >&2
    echo "REASON=CONTAINER_FILE_MISSING: $CONTAINER_PATH" >&2
    exit 1
  fi

  # 2) size must match exactly
  ACTUAL_SIZE="$(sudo -n docker exec "$WEB_CID" stat -c '%s' "$CONTAINER_PATH" 2>/dev/null | tr -d '[:space:]' || echo "")"
  if [ -z "$ACTUAL_SIZE" ] || ! printf '%s' "$ACTUAL_SIZE" | grep -qE '^[0-9]+$'; then
    echo "STATUS=FAIL" >&2
    echo "REASON=CONTAINER_SIZE_UNREADABLE: $CONTAINER_PATH" >&2
    exit 1
  fi
  if [ "$ACTUAL_SIZE" != "$EXPECTED_SIZE" ]; then
    echo "STATUS=FAIL" >&2
    echo "REASON=SIZE_MISMATCH: $CONTAINER_PATH expected=$EXPECTED_SIZE actual=$ACTUAL_SIZE" >&2
    exit 1
  fi

  # 3) sha256 must match exactly (read bytes via docker exec + stdin)
  ACTUAL_SHA="$(sudo -n docker exec -i "$WEB_CID" sha256sum < "$CONTAINER_PATH" 2>/dev/null | awk '{print $1}' || echo "")"
  # Above uses docker exec -i with stdin redirection from host file; cleaner alternative:
  ACTUAL_SHA="$(sudo -n docker exec "$WEB_CID" sha256sum "$CONTAINER_PATH" 2>/dev/null | awk '{print $1}' || echo "")"
  if [ -z "$ACTUAL_SHA" ] || ! printf '%s' "$ACTUAL_SHA" | grep -qE '^[0-9a-f]{64}$'; then
    echo "STATUS=FAIL" >&2
    echo "REASON=CONTAINER_SHA_UNREADABLE: $CONTAINER_PATH" >&2
    exit 1
  fi
  if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
    echo "STATUS=FAIL" >&2
    echo "REASON=SHA_MISMATCH: $CONTAINER_PATH expected=$EXPECTED_SHA actual=$ACTUAL_SHA" >&2
    exit 1
  fi
done

# ---- pass ----
printf 'STATUS=PASS\nENTRIES=%s\nMANIFEST_SHA=%s\n' "$ENTRY" "$MANIFEST_SHA_LOCAL"
exit 0