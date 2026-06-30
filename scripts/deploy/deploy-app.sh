#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/book-id-search}"
REPO_URL="${BOOK_REPO_URL:-https://github.com/conanxin/book-id-search.git}"
MEILI_DATA_DIR="${MEILI_DATA_DIR:-/data/book-id-search/meili_data}"
BOOK_DATA_DIR="${BOOK_DATA_DIR:-/data/book-id-search/private-data}"
MEILI_INDEX="${MEILI_INDEX:-books}"
API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-5173}"
MEILI_PORT_BIND="${MEILI_PORT_BIND:-127.0.0.1:7700}"

if [[ -z "${MEILI_MASTER_KEY:-}" ]]; then
  echo "[deploy] MEILI_MASTER_KEY is required. Example:"
  echo "[deploy] export MEILI_MASTER_KEY='replace-with-a-long-random-secret'"
  exit 2
fi

mkdir -p "$APP_DIR" "$MEILI_DATA_DIR" "$BOOK_DATA_DIR"

if [[ -d "$APP_DIR/.git" ]]; then
  echo "[deploy] pulling existing repo"
  git -C "$APP_DIR" pull --ff-only
else
  echo "[deploy] cloning repo"
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
mkdir -p reports

cat > .env <<EOF
MEILI_HOST=http://127.0.0.1:7700
MEILI_MASTER_KEY=$MEILI_MASTER_KEY
MEILI_INDEX=$MEILI_INDEX
MEILI_DATA_DIR=$MEILI_DATA_DIR
MEILI_ENV=production
MEILI_PORT_BIND=$MEILI_PORT_BIND
BOOK_DATA_DIR=$BOOK_DATA_DIR
API_PORT=$API_PORT
WEB_PORT=$WEB_PORT
VITE_API_BASE_URL=/api
EOF

echo "[deploy] starting Docker Compose services"
docker compose up -d --build
docker compose ps

echo "[deploy] app ready"
echo "[deploy] web: http://127.0.0.1:$WEB_PORT"
echo "[deploy] api: http://127.0.0.1:$API_PORT/api/health"
echo "[deploy] meili bind: $MEILI_PORT_BIND"
