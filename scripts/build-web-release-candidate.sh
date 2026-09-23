#!/usr/bin/env bash
# Build a deterministic web release candidate image.
# Build-once / deploy-same-image. This script does NOT deploy.
set -euo pipefail

APP_DIR="${BOOK_ID_SEARCH_REPO_ROOT:-/opt/book-id-search}"
cd "$APP_DIR"

SOURCE_INPUT="${1:-HEAD}"
if ! printf '%s' "$SOURCE_INPUT" | grep -qE '^(HEAD|[0-9a-fA-F]{40})$'; then
  echo "[build-web-release-candidate] ERROR: source must be HEAD or 40-hex commit" >&2
  exit 2
fi
if ! git cat-file -e "${SOURCE_INPUT}^{commit}" 2>/dev/null; then
  echo "[build-web-release-candidate] ERROR: source commit does not exist" >&2
  exit 2
fi
FULL_SHA="$(git rev-parse "${SOURCE_INPUT}^{commit}")"
if ! git rev-parse --verify "origin/main^{commit}" >/dev/null 2>&1 \
  || ! git merge-base --is-ancestor "$FULL_SHA" origin/main; then
  echo "[build-web-release-candidate] ERROR: source is not reachable from origin/main" >&2
  exit 2
fi
TAG="book-id-search-web:${FULL_SHA}"
OUT_DIR="${APP_DIR}/progress/web-release-candidate-${FULL_SHA}"
mkdir -p "$OUT_DIR"

LOCKFILE_SHA="$(git show "${FULL_SHA}:pnpm-lock.yaml" | sha256sum | awk '{print $1}')"

if docker ps >/dev/null 2>&1; then
  DOCKER_SUDO=""
else
  DOCKER_SUDO="sudo -n"
fi

NODE_VERSION="$(node --version)"
PNPM_VERSION="$(git show "${FULL_SHA}:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).packageManager||"pnpm@10.33.0"))')"

echo "[build-web-release-candidate] building ${TAG} from ${FULL_SHA} ..."
git archive "$FULL_SHA" | DOCKER_BUILDKIT=1 $DOCKER_SUDO docker build --no-cache --progress=plain \
  -f apps/web/Dockerfile \
  --build-arg "SOURCE_COMMIT=$FULL_SHA" \
  --build-arg "VITE_S32_ENABLED=true" \
  -t "$TAG" \
  - >"${OUT_DIR}/docker-build.log" 2>&1

OCI_REV="$($DOCKER_SUDO docker image inspect "$TAG" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')"
if [ "$OCI_REV" != "$FULL_SHA" ]; then
  echo "[build-web-release-candidate] ERROR: OCI revision mismatch" >&2
  exit 3
fi
IMAGE_ID="$($DOCKER_SUDO docker image inspect "$TAG" --format '{{.Id}}')"
IMAGE_BYTES="$($DOCKER_SUDO docker image inspect "$TAG" --format '{{.Size}}')"
NODE_BASE_DIGEST="$($DOCKER_SUDO docker image inspect node:22-alpine --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"
NGINX_BASE_DIGEST="$($DOCKER_SUDO docker image inspect nginx:1.27-alpine --format '{{index .RepoDigests 0}}' 2>/dev/null || true)"
if ! printf '%s' "$NODE_BASE_DIGEST" | grep -qE '^node@sha256:[0-9a-f]{64}$'; then
  echo "[build-web-release-candidate] ERROR: node base digest unavailable" >&2
  exit 3
fi
if ! printf '%s' "$NGINX_BASE_DIGEST" | grep -qE '^nginx@sha256:[0-9a-f]{64}$'; then
  echo "[build-web-release-candidate] ERROR: nginx base digest unavailable" >&2
  exit 3
fi

STATIC_ROOT="/usr/share/nginx/html"
CID="$($DOCKER_SUDO docker create "$TAG")"
cleanup_cid() { $DOCKER_SUDO docker rm -f "$CID" >/dev/null 2>&1 || true; }
trap cleanup_cid EXIT
rm -rf "${OUT_DIR}/static"
mkdir -p "${OUT_DIR}/static"
$DOCKER_SUDO docker cp "${CID}:${STATIC_ROOT}/." "${OUT_DIR}/static/"
cleanup_cid
trap - EXIT

if grep -R -n -F 'VITE_S32_PRIVATE_API_TOKEN' "${OUT_DIR}/static" >/dev/null 2>&1 \
  || grep -R -n -F 'S32_PRIVATE_API_TOKEN=' "${OUT_DIR}/static" >/dev/null 2>&1; then
  echo "[build-web-release-candidate] ERROR: private S32 token mechanism leaked into static bundle" >&2
  exit 4
fi

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

TAR_PATH="${OUT_DIR}/image.tar"
GZIP_PATH="${OUT_DIR}/image.tar.gz"
$DOCKER_SUDO docker image save -o "$TAR_PATH" "$TAG"
gzip -n -c "$TAR_PATH" >"$GZIP_PATH"
TAR_BYTES="$(stat -c '%s' "$TAR_PATH")"
COMPRESSED_BYTES="$(stat -c '%s' "$GZIP_PATH")"

cat >"${OUT_DIR}/candidate.json" <<JSON
{
  "tag": "${TAG}",
  "imageId": "${IMAGE_ID}",
  "gitSha": "${FULL_SHA}",
  "ociRevision": "${OCI_REV}",
  "webS32Enabled": true,
  "nodeVersion": "${NODE_VERSION}",
  "pnpmVersion": "${PNPM_VERSION}",
  "lockfileSha256": "${LOCKFILE_SHA}",
  "staticManifestSha256": "${MANIFEST_HASH}",
  "nodeBaseDigest": "${NODE_BASE_DIGEST}",
  "nginxBaseDigest": "${NGINX_BASE_DIGEST}",
  "imageBytes": ${IMAGE_BYTES},
  "tarBytes": ${TAR_BYTES},
  "compressedBytes": ${COMPRESSED_BYTES},
  "manifestPath": "${MANIFEST}"
}
JSON

printf '%s\n' "$TAG" >"${OUT_DIR}/image-tag.txt"
printf '%s\n' "$IMAGE_ID" >"${OUT_DIR}/image-id.txt"
printf '%s\n' "$FULL_SHA" >"${OUT_DIR}/git-sha.txt"
printf '%s\n' "$LOCKFILE_SHA" >"${OUT_DIR}/lockfile.sha256"
printf '%s\n' "$MANIFEST_HASH" >"${OUT_DIR}/static-manifest.sha256"

echo "[build-web-release-candidate] OK: ${TAG}"
echo "[build-web-release-candidate] imageId: ${IMAGE_ID}"
echo "[build-web-release-candidate] imageBytes: ${IMAGE_BYTES} tarBytes: ${TAR_BYTES} compressedBytes: ${COMPRESSED_BYTES}"
echo "[build-web-release-candidate] outputs: ${OUT_DIR}"
