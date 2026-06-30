#!/usr/bin/env bash
set -euo pipefail

PUBLIC_URL="${PUBLIC_URL:-${BOOK_SEARCH_PUBLIC_URL:-}}"
API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-5173}"
VERIFY_QUERY="${VERIFY_QUERY:-13000000}"

if [[ -n "$PUBLIC_URL" ]]; then
  BASE_URL="${PUBLIC_URL%/}"
  API_BASE="${BASE_URL}/api"
  WEB_URL="$BASE_URL"
else
  API_BASE="http://127.0.0.1:${API_PORT}/api"
  WEB_URL="http://127.0.0.1:${WEB_PORT}"
fi

echo "[verify-remote] API base: $API_BASE"
echo "[verify-remote] Web URL: $WEB_URL"

curl -fsS "$API_BASE/health" >/tmp/book-id-search-health.json
curl -fsS "$API_BASE/stats" >/tmp/book-id-search-stats.json
curl -fsS "$API_BASE/search?q=$VERIFY_QUERY&limit=5" >/tmp/book-id-search-search.json
curl -fsS -o /dev/null "$WEB_URL"

echo "[verify-remote] health:"
cat /tmp/book-id-search-health.json
echo
echo "[verify-remote] stats:"
cat /tmp/book-id-search-stats.json
echo
echo "[verify-remote] search:"
cat /tmp/book-id-search-search.json
echo
echo "[verify-remote] PASS"
