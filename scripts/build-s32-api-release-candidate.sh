#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ] || ! printf '%s' "$1" | grep -qE '^[0-9a-f]{40}$'; then
  echo "usage: build-s32-api-release-candidate.sh <SOURCE_SHA>" >&2
  exit 2
fi

SOURCE_SHA="$1"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

git cat-file -e "${SOURCE_SHA}^{commit}" 2>/dev/null || { echo "INVALID_SOURCE_SHA" >&2; exit 3; }

TAG="book-id-search-api:s32-${SOURCE_SHA}"
OUT_DIR="${ROOT}/progress/s32-api-release-candidate-${SOURCE_SHA}"
mkdir -p "$OUT_DIR"

LOCKFILE_SHA="$(git show "${SOURCE_SHA}:pnpm-lock.yaml" | sha256sum | awk '{print $1}')"

git archive "$SOURCE_SHA" | docker build \
  -f apps/api/Dockerfile \
  --build-arg "SOURCE_COMMIT=$SOURCE_SHA" \
  -t "$TAG" -

IMAGE_ID="$(docker image inspect "$TAG" --format '{{.Id}}')"
OCI_REV="$(docker image inspect "$TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
[ "$OCI_REV" = "$SOURCE_SHA" ] || { echo "OCI_REVISION_MISMATCH" >&2; exit 4; }

IMAGE_BYTES="$(docker image inspect "$TAG" --format '{{.Size}}')"
BASE_DIGEST="$(docker image inspect node:22-alpine --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"

TAR_PATH="${OUT_DIR}/image.tar"
GZIP_PATH="${OUT_DIR}/image.tar.gz"
docker save -o "$TAR_PATH" "$TAG"
gzip -n -c "$TAR_PATH" > "$GZIP_PATH"
TAR_BYTES="$(stat -c '%s' "$TAR_PATH")"
COMPRESSED_BYTES="$(stat -c '%s' "$GZIP_PATH")"

cat >"${OUT_DIR}/candidate.json" <<EOF
{
  "sourceSha": "${SOURCE_SHA}",
  "imageTag": "${TAG}",
  "imageId": "${IMAGE_ID}",
  "ociRevision": "${OCI_REV}",
  "lockfileSha256": "${LOCKFILE_SHA}",
  "baseDigest": "${BASE_DIGEST}",
  "imageBytes": ${IMAGE_BYTES},
  "tarBytes": ${TAR_BYTES},
  "compressedBytes": ${COMPRESSED_BYTES}
}
EOF

echo "SOURCE_SHA=${SOURCE_SHA}"
echo "IMAGE_TAG=${TAG}"
echo "IMAGE_ID=${IMAGE_ID}"
echo "OCI_REVISION=${OCI_REV}"
echo "CANDIDATE_JSON=${OUT_DIR}/candidate.json"
