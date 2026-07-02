#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/book-id-search"
LOG_DIR="$APP_DIR/logs/ai-quality"
TS="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$LOG_DIR"
cd "$APP_DIR"

export NO_PROXY="*"
export no_proxy="*"

TSX="./node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  echo "ERROR: $TSX not found or not executable. Run pnpm install manually." >&2
  exit 2
fi

JSON_REPORT="$LOG_DIR/ai-quality-$TS.json"
MD_REPORT="$LOG_DIR/ai-quality-$TS.md"
LOG_FILE="$LOG_DIR/ai-quality-$TS.log"

set +e
"$TSX" scripts/ai-quality-regression.ts \
  --public-url https://books.conanxin.com \
  --max-ai-calls 10 \
  --json "$JSON_REPORT" \
  --markdown "$MD_REPORT" \
  > "$LOG_FILE" 2>&1
STATUS=$?
set -e

find "$LOG_DIR" -type f -name 'ai-quality-*' -mtime +56 -delete || true

echo "AI quality weekly finished with exit=$STATUS"
echo "log=$LOG_FILE"
echo "markdown=$MD_REPORT"
echo "json=$JSON_REPORT"

exit "$STATUS"
