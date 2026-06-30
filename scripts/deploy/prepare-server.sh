#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/book-id-search}"
DATA_DIR="${DATA_DIR:-/data/book-id-search}"
MEILI_DATA_DIR="${MEILI_DATA_DIR:-$DATA_DIR/meili_data}"
BOOK_DATA_DIR="${BOOK_DATA_DIR:-$DATA_DIR/private-data}"

echo "[prepare] installing base packages"
sudo apt-get update
sudo apt-get install -y git curl ca-certificates tmux

if ! command -v docker >/dev/null 2>&1; then
  echo "[prepare] Docker is not installed."
  echo "[prepare] Install it with: curl -fsSL https://get.docker.com | sudo sh"
  exit 2
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "[prepare] Docker Compose plugin is not available."
  echo "[prepare] Install Docker Compose plugin, then rerun this script."
  exit 2
fi

echo "[prepare] creating directories"
sudo mkdir -p "$APP_DIR" "$MEILI_DATA_DIR" "$BOOK_DATA_DIR"
OWNER="${SUDO_USER:-$USER}"
sudo chown -R "$OWNER":"$OWNER" "$APP_DIR" "$DATA_DIR"

echo "[prepare] ready"
echo "[prepare] app dir: $APP_DIR"
echo "[prepare] meili data dir: $MEILI_DATA_DIR"
echo "[prepare] private data dir: $BOOK_DATA_DIR"
