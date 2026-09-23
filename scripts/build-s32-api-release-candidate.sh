#!/usr/bin/env bash
# Build an exact-source S32 API release candidate. Never deploys.
set -euo pipefail

if [ "$#" -ne 1 ] || ! printf '%s' "$1" | grep -qE '^[0-9a-f]{40}$'; then
  echo 'STATUS=BLOCKED' >&2
  echo 'BLOCK_REASON=INVALID_SOURCE_SHA' >&2
  exit 2
fi
SOURCE_SHA="$1"
APP_DIR="${BOOK_ID_SEARCH_REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$APP_DIR"
if ! git cat-file -e "${SOURCE_SHA}^{commit}" 2>/dev/null; then
  echo 'STATUS=BLOCKED' >&2
  echo 'BLOCK_REASON=INVALID_SOURCE_SHA' >&2
  exit 2
fi
SOURCE_SHA="$(git rev-parse "${SOURCE_SHA}^{commit}")"
if ! git rev-parse --verify "origin/main^{commit}" >/dev/null 2>&1 \
  || ! git merge-base --is-ancestor "$SOURCE_SHA" origin/main; then
  echo 'STATUS=BLOCKED' >&2
  echo 'BLOCK_REASON=SOURCE_NOT_REACHABLE_FROM_ORIGIN_MAIN' >&2
  exit 2
fi
TAG="book-id-search-api:s32-${SOURCE_SHA}"
OUT_DIR="${APP_DIR}/progress/s32-api-release-candidate-${SOURCE_SHA}"
mkdir -p "$OUT_DIR"
LOCKFILE_SHA="$(git show "${SOURCE_SHA}:pnpm-lock.yaml" | sha256sum | awk '{print $1}')"

if docker ps >/dev/null 2>&1; then DOCKER_SUDO=""; else DOCKER_SUDO="sudo -n"; fi

echo "[build-s32-api-release-candidate] building ${TAG} from ${SOURCE_SHA}"
git archive "$SOURCE_SHA" | DOCKER_BUILDKIT=1 $DOCKER_SUDO docker build --no-cache --progress=plain \
  -f apps/api/Dockerfile \
  --build-arg "SOURCE_COMMIT=$SOURCE_SHA" \
  -t "$TAG" \
  - >"${OUT_DIR}/docker-build.log" 2>&1

IMAGE_ID="$($DOCKER_SUDO docker image inspect "$TAG" --format '{{.Id}}')"
OCI_REV="$($DOCKER_SUDO docker image inspect "$TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
IMAGE_BYTES="$($DOCKER_SUDO docker image inspect "$TAG" --format '{{.Size}}')"
BASE_DIGEST="$($DOCKER_SUDO docker image inspect node:22-alpine --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"
if [ "$OCI_REV" != "$SOURCE_SHA" ]; then
  echo 'STATUS=BLOCKED' >&2
  echo 'BLOCK_REASON=OCI_REVISION_MISMATCH' >&2
  exit 3
fi
if ! printf '%s' "$IMAGE_ID" | grep -qE '^sha256:[0-9a-f]{64}$'; then
  echo 'STATUS=BLOCKED' >&2
  echo 'BLOCK_REASON=INVALID_IMAGE_ID' >&2
  exit 3
fi
if ! printf '%s' "$BASE_DIGEST" | grep -qE '^node@sha256:[0-9a-f]{64}$'; then
  echo 'STATUS=BLOCKED' >&2
  echo 'BLOCK_REASON=BASE_DIGEST_UNAVAILABLE' >&2
  exit 3
fi

TAR_PATH="${OUT_DIR}/image.tar"
GZIP_PATH="${OUT_DIR}/image.tar.gz"
$DOCKER_SUDO docker image save -o "$TAR_PATH" "$TAG"
gzip -n -c "$TAR_PATH" >"$GZIP_PATH"
TAR_BYTES="$(stat -c '%s' "$TAR_PATH")"
COMPRESSED_BYTES="$(stat -c '%s' "$GZIP_PATH")"

cat >"${OUT_DIR}/candidate.json" <<JSON
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
JSON
printf '%s\n' "$TAG" >"${OUT_DIR}/image-tag.txt"
printf '%s\n' "$IMAGE_ID" >"${OUT_DIR}/image-id.txt"
printf '%s\n' "$SOURCE_SHA" >"${OUT_DIR}/git-sha.txt"
printf '%s\n' "$LOCKFILE_SHA" >"${OUT_DIR}/lockfile.sha256"

printf '%s\n' \
  'STATUS=PASS' \
  "SOURCE_SHA=${SOURCE_SHA}" \
  "IMAGE_TAG=${TAG}" \
  "IMAGE_ID=${IMAGE_ID}" \
  "OCI_REVISION=${OCI_REV}" \
  "IMAGE_BYTES=${IMAGE_BYTES}" \
  "TAR_BYTES=${TAR_BYTES}" \
  "COMPRESSED_BYTES=${COMPRESSED_BYTES}" \
  "BASE_DIGEST=${BASE_DIGEST}" \
  "CANDIDATE_JSON=${OUT_DIR}/candidate.json"
