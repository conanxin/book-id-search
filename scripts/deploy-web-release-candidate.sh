#!/usr/bin/env bash
# Deploy a previously built web release candidate image without rebuilding.
# Usage: scripts/deploy-web-release-candidate.sh <image-tag>
#    or: BOOK_ID_SEARCH_WEB_IMAGE=<tag> scripts/deploy-web-release-candidate.sh
set -euo pipefail

APP_DIR="/opt/book-id-search"
cd "$APP_DIR"

IMAGE_TAG="${1:-${BOOK_ID_SEARCH_WEB_IMAGE:-}}"
if [ -z "$IMAGE_TAG" ]; then
  echo "[deploy-web-release-candidate] ERROR: missing image tag" >&2
  echo "Usage: $0 <image-tag>" >&2
  exit 2
fi

# Detect whether docker needs sudo in this environment.
if docker ps >/dev/null 2>&1; then
  DOCKER_SUDO=""
else
  DOCKER_SUDO="sudo"
fi

if ! $DOCKER_SUDO docker inspect "$IMAGE_TAG" >/dev/null 2>&1; then
  echo "[deploy-web-release-candidate] ERROR: image not found locally: ${IMAGE_TAG}" >&2
  exit 3
fi

CANDIDATE_IMAGE_ID="$($DOCKER_SUDO docker inspect --format='{{.Id}}' "$IMAGE_TAG")"

echo "[deploy-web-release-candidate] deploying ${IMAGE_TAG} (${CANDIDATE_IMAGE_ID}) ..."

# Deploy the exact image. --no-deps avoids touching api/meilisearch.
# --no-build is the critical rule: the deploy must never implicitly rebuild.
BOOK_ID_SEARCH_WEB_IMAGE="$IMAGE_TAG" $DOCKER_SUDO docker compose up -d --no-deps --no-build web

# Wait for the container to be running and verify its image ID.
for _ in $(seq 1 30); do
  RUNNING_CONTAINER_ID="$($DOCKER_SUDO docker compose ps -q web 2>/dev/null || true)"
  if [ -n "$RUNNING_CONTAINER_ID" ]; then
    RUNNING_IMAGE_ID="$($DOCKER_SUDO docker inspect --format='{{.Image}}' "$RUNNING_CONTAINER_ID")"
    if [ "$RUNNING_IMAGE_ID" = "$CANDIDATE_IMAGE_ID" ]; then
      echo "[deploy-web-release-candidate] OK: web is running ${IMAGE_TAG}"
      echo "[deploy-web-release-candidate] candidate image ID: ${CANDIDATE_IMAGE_ID}"
      echo "[deploy-web-release-candidate] running image ID:   ${RUNNING_IMAGE_ID}"
      exit 0
    fi
  fi
  sleep 1
done

echo "[deploy-web-release-candidate] ERROR: web container image ID does not match candidate" >&2
echo "  candidate: ${CANDIDATE_IMAGE_ID}" >&2
echo "  running:   ${RUNNING_IMAGE_ID:-<unknown>}" >&2
exit 4
