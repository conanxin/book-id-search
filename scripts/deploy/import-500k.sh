#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/book-id-search}"
SESSION="${BOOK_IMPORT_SESSION:-book-import-500k}"
DATA_FILE="${BOOK_IMPORT_FILE:-/data/private/books.txt}"

if [[ -z "${BOOK_IMPORT_IN_TMUX:-}" && -z "${TMUX:-}" ]]; then
  echo "[import-500k] starting detached tmux session: $SESSION"
  tmux new-session -d -s "$SESSION" "cd '$APP_DIR' && BOOK_IMPORT_IN_TMUX=1 ./scripts/deploy/import-500k.sh"
  echo "[import-500k] attach with: tmux attach -t $SESSION"
  exit 0
fi

cd "$APP_DIR"

echo "[import-500k] running 500k import inside api container"
docker compose exec -T api pnpm import:file \
  --file "$DATA_FILE" \
  --index books \
  --offset 0 \
  --limit 500000 \
  --reset-index \
  --batch-size 20000 \
  --search-raw-info false \
  --wait-timeout-ms 900000 \
  --checkpoint reports/import-checkpoint-500k-cloud.json \
  --report reports/import-500k-cloud-report.json

echo "[import-500k] verifying imported index"
docker compose exec -T api pnpm verify
