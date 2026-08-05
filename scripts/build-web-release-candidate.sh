#!/usr/bin/env bash
# Build a deterministic web release candidate image.
# S27P-4A: build-once / deploy-same-image. This script does NOT deploy.
set -euo pipefail

APP_DIR="/opt/book-id-search"
cd "$APP_DIR"

if [ -n "$(git status --short)" ]; then
  if [ "${BUILD_CANDIDATE_ALLOW_DIRTY:-}" = "1" ]; then
    echo "[build-web-release-candidate] WARNING: working tree is dirty; continuing because BUILD_CANDIDATE_ALLOW_DIRTY=1"
  else
    echo "[build-web-release-candidate] ERROR: working tree is not clean" >&2
    exit 2
  fi
fi

FULL_SHA="$(git rev-parse HEAD)"
TAG="book-id-search-web:${FULL_SHA}"
OUT_DIR="${APP_DIR}/progress/web-release-candidate-${FULL_SHA}"
mkdir -p "$OUT_DIR"

LOCKFILE_SHA_BEFORE="$(sha256sum pnpm-lock.yaml | awk '{print $1}')"

# Detect whether docker needs sudo in this environment.
if docker ps >/dev/null 2>&1; then
  DOCKER_SUDO=""
else
  DOCKER_SUDO="sudo"
fi

NODE_VERSION="$(node --version)"
# The repository pins the packageManager field; use it as the authoritative pnpm version.
PNPM_VERSION="$(node -p 'require("./package.json").packageManager || "pnpm@10.33.0"')"

echo "[build-web-release-candidate] building ${TAG} ..."
DOCKER_BUILDKIT=1 $DOCKER_SUDO docker build --no-cache --progress=plain \
  -f apps/web/Dockerfile \
  -t "$TAG" \
  . >"${OUT_DIR}/docker-build.log" 2>&1

LOCKFILE_SHA_AFTER="$(sha256sum pnpm-lock.yaml | awk '{print $1}')"
if [ "$LOCKFILE_SHA_BEFORE" != "$LOCKFILE_SHA_AFTER" ]; then
  echo "[build-web-release-candidate] ERROR: pnpm-lock.yaml changed during build" >&2
  exit 3
fi

if [ "${BUILD_CANDIDATE_ALLOW_DIRTY:-}" = "1" ]; then
  if [ -n "$(git diff -- pnpm-lock.yaml package.json apps/web/src apps/api)" ]; then
    echo "[build-web-release-candidate] ERROR: protected paths changed during build" >&2
    exit 4
  fi
  echo "[build-web-release-candidate] dirty-mode: protected paths unchanged"
else
  if [ -n "$(git status --short)" ]; then
    echo "[build-web-release-candidate] ERROR: working tree changed during build" >&2
    exit 4
  fi
fi

# Extract the static artifact manifest from the candidate image.
STATIC_ROOT="/usr/share/nginx/html"
CID="$("$DOCKER_SUDO" docker create "$TAG")"
mkdir -p "${OUT_DIR}/static"
$DOCKER_SUDO docker cp "${CID}:${STATIC_ROOT}/." "${OUT_DIR}/static/"
$DOCKER_SUDO docker rm "$CID"

cd "${OUT_DIR}/static"
find . -type f -printf '%P\t%s\n' | sort >"${OUT_DIR}/static-files.txt"
cd "$APP_DIR"

MANIFEST="${OUT_DIR}/static-manifest.tsv"
: >"$MANIFEST"
while IFS=$'\t' read -r FILE SIZE; do
  HASH="$(sha256sum "${OUT_DIR}/static/${FILE}" | awk '{print $1}')"
  printf '%s\t%s\t%s\n' "$FILE" "$SIZE" "$HASH" >>"$MANIFEST"
done < "${OUT_DIR}/static-files.txt"

MANIFEST_HASH="$(sha256sum "$MANIFEST" | awk '{print $1}')"
IMAGE_ID="$("$DOCKER_SUDO" docker images --no-trunc --format '{{.ID}}' "$TAG" | head -n1)"

# Record provenance metadata.
cat >"${OUT_DIR}/candidate.json" <<EOF
{
  "tag": "${TAG}",
  "imageId": "${IMAGE_ID}",
  "gitSha": "${FULL_SHA}",
  "nodeVersion": "${NODE_VERSION}",
  "pnpmVersion": "${PNPM_VERSION}",
  "lockfileSha256": "${LOCKFILE_SHA_BEFORE}",
  "staticManifestSha256": "${MANIFEST_HASH}",
  "manifestPath": "${MANIFEST}"
}
EOF

echo "$TAG" >"${OUT_DIR}/image-tag.txt"
echo "$IMAGE_ID" >"${OUT_DIR}/image-id.txt"
echo "$FULL_SHA" >"${OUT_DIR}/git-sha.txt"
echo "$LOCKFILE_SHA_BEFORE" >"${OUT_DIR}/lockfile.sha256"
echo "$MANIFEST_HASH" >"${OUT_DIR}/static-manifest.sha256"

echo "[build-web-release-candidate] OK: ${TAG}"
echo "[build-web-release-candidate] imageId: ${IMAGE_ID}"
echo "[build-web-release-candidate] manifest: ${MANIFEST} (${MANIFEST_HASH})"
echo "[build-web-release-candidate] lockfile: ${LOCKFILE_SHA_BEFORE}"
echo "[build-web-release-candidate] outputs: ${OUT_DIR}"
