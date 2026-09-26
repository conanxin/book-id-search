#!/usr/bin/env bash
set -euo pipefail

block(){ printf 'STATUS=BLOCKED\nBLOCK_REASON=%s\n' "$1"; exit 1; }
[ "$#" -eq 3 ] || block INVALID_ARGUMENTS
TAG="$1"; EXPECTED_CONFIG="$2"; EXPECTED_REV="$3"
printf '%s' "$EXPECTED_CONFIG" | grep -qE '^sha256:[0-9a-f]{64}$' || block EXPECTED_CONFIG_DIGEST_INVALID
printf '%s' "$EXPECTED_REV" | grep -qE '^[0-9a-f]{40}$' || block EXPECTED_REVISION_INVALID

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "${S32_IMAGE_DOCKER_CMD:-}" ]; then
  DOCKER=("$S32_IMAGE_DOCKER_CMD")
else
  DOCKER=(sudo -n docker)
fi

OBSERVED="$("${DOCKER[@]}" image inspect "$TAG" --format '{{.Id}}' 2>/dev/null)" || block IMAGE_NOT_LOCAL
REV="$("${DOCKER[@]}" image inspect "$TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null)" || block IMAGE_INSPECT_FAILED
[ "$REV" = "$EXPECTED_REV" ] || block OCI_REVISION_MISMATCH

if [ "$OBSERVED" = "$EXPECTED_CONFIG" ]; then
  printf 'STATUS=PASS\nARCHIVE_FORMAT=NOT_REQUIRED\nBACKEND_IDENTITY_MODE=CONFIG_DIGEST\nOBSERVED_IMAGE_ID=%s\nCONFIG_DIGEST=%s\nMANIFEST_DIGEST=N/A\nOCI_REVISION=%s\n' "$OBSERVED" "$EXPECTED_CONFIG" "$REV"
  exit 0
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT INT TERM
"${DOCKER[@]}" image save "$TAG" >"$TMP" || block IMAGE_SAVE_FAILED
OUT="$(python3 "$SCRIPT_DIR/verify-s32-image-archive-identity.py" "$TMP" "$EXPECTED_CONFIG" "$OBSERVED" "$EXPECTED_REV" 2>&1)" || {
  reason="$(printf '%s\n' "$OUT" | awk -F= '$1=="BLOCK_REASON"{print $2;exit}')"
  block "${reason:-IMAGE_ARCHIVE_IDENTITY_FAILED}"
}
printf '%s\n' "$OUT"
