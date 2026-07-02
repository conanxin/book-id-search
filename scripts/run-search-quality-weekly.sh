#!/usr/bin/env bash
# ------------------------------------------------------------------
# Weekly search-quality regression wrapper (S25B).
# ------------------------------------------------------------------
# Runs scripts/search-quality-regression.ts against the live site,
# persists timestamped .log / .md / .json to logs/search-quality/,
# and prunes files older than 56 days.
#
# Why weekly (not daily):
#   - search-quality has no token cost (it doesn't call MiniMax),
#     so a daily cadence would be cheap, but weekly is plenty to
#     catch regressions and matches the S23.1 AI-quality cadence.
#   - All 17 cases run in ~3 seconds, so a daily run would be
#     negligible; we keep weekly to avoid noisy diffs from minor
#     Meilisearch ranking drift on weekends.
#
# Exit codes mirror the runner:
#   0 = all PASS
#   1 = at least one WARN, no FAIL
#   2 = at least one FAIL
#   3 = runtime error
# We pass them through verbatim so cron and ops scripts can act on
# the same code the manual run returns.
# ------------------------------------------------------------------
set -euo pipefail

APP_DIR="/opt/book-id-search"
LOG_DIR="$APP_DIR/logs/search-quality"
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

LOCK_FILE="$LOG_DIR/.search-quality-weekly.lock"
JSON_REPORT="$LOG_DIR/search-quality-$TS.json"
MD_REPORT="$LOG_DIR/search-quality-$TS.md"
LOG_FILE="$LOG_DIR/search-quality-$TS.log"

# Use flock to prevent overlapping runs (the previous run should
# finish in seconds, but we guard against flapping cron).
(
  flock -n 9 || {
    echo "ERROR: search quality weekly job is already running" >&2
    exit 3
  }

  set +e
  "$TSX" scripts/search-quality-regression.ts \
    --public-url https://books.conanxin.com \
    --json "$JSON_REPORT" \
    --markdown "$MD_REPORT" \
    > "$LOG_FILE" 2>&1
  STATUS=$?
  set -e

  # 56 days = 8 weeks retention, matching S23.1 AI-quality cron.
  find "$LOG_DIR" -type f -name 'search-quality-*' -mtime +56 -delete || true

  echo "Search quality weekly finished with exit=$STATUS"
  echo "log=$LOG_FILE"
  echo "markdown=$MD_REPORT"
  echo "json=$JSON_REPORT"

  exit "$STATUS"
) 9>"$LOCK_FILE"
