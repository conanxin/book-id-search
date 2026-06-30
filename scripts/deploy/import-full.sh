#!/usr/bin/env bash
# S16-only: full-import runner for /data/book-id-search/private-data/books.txt
# DO NOT RUN until the CVM has an independent /data disk >=100GiB (160GiB recommended).
# See reports/FULL_IMPORT_PREFLIGHT.md and reports/TENCENT_500K_CLOUD_PASS_REPORT.md
# for the preflight BLOCKED reason (estimatedFullIndex=41.75 GiB > 37.19 GiB free).
#
# Notes vs scripts/deploy/import-500k.sh:
#   * --limit removed (full file)
#   * checkpoint / report files renamed to *-full-* to avoid clobbering 500k artifacts
#   * uses tmux so a long import survives disconnect
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/book-id-search}"
SESSION="${BOOK_IMPORT_SESSION:-book-import-full}"
DATA_FILE="${BOOK_IMPORT_FILE:-/data/private/books.txt}"

if [[ -z "${BOOK_IMPORT_IN_TMUX:-}" && -z "${TMUX:-}" ]]; then
  echo "[import-full] starting detached tmux session: $SESSION"
  tmux new-session -d -s "$SESSION" "cd '$APP_DIR' && BOOK_IMPORT_IN_TMUX=1 ./scripts/deploy/import-full.sh"
  echo "[import-full] attach with: tmux attach -t $SESSION"
  exit 0
fi

cd "$APP_DIR"

echo "[import-full] running full import inside api container"
docker compose exec -T api pnpm import:file \
  --file "$DATA_FILE" \
  --index books \
  --offset 0 \
  --reset-index \
  --batch-size 20000 \
  --search-raw-info false \
  --wait-timeout-ms 900000 \
  --checkpoint reports/import-checkpoint-full.json \
  --report reports/import-full-report.json

echo "[import-full] verifying imported index"
docker compose exec -T api pnpm verify

echo "[import-full] resume example (if interrupted):"
echo "  docker compose exec -T api pnpm import:file \\"
echo "    --checkpoint reports/import-checkpoint-full.json \\"
echo "    --resume --wait-timeout-ms 900000"
