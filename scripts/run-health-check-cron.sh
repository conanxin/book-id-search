#!/usr/bin/env bash
# Daily production health monitoring cron wrapper.
#
# Runs the FULL production checker (scripts/production-health-check.ts) with
# plain Node type stripping — no pnpm/corepack bootstrap from cron, no
# node_modules dependency (the checker imports Node built-ins only).
#
# Exit codes (propagated from the checker):
#   0 = PASS   1 = WARN   2 = FAIL   4 = wrapper/environment fatal
#
# Reports go to logs/health-check/ (gitignored) so scheduled runs never turn
# the production worktree dirty:
#   - latest.json / latest.md                (latest full report)
#   - health-check-YYYYMMDD-HHMMSS.log       (dated stdout/stderr, kept 14 days)

set -uo pipefail

REPO_ROOT="/opt/book-id-search"
LOG_DIR="$REPO_ROOT/logs/health-check"
TS="$(date +%Y%m%d-%H%M%S)"

cd "$REPO_ROOT" || exit 4
mkdir -p "$LOG_DIR" || exit 4

# The checker probes localhost and the public IP directly; bypass any inherited
# HTTP proxy chain.
export NO_PROXY="*"
export no_proxy="*"

CHECKER="$REPO_ROOT/scripts/production-health-check.ts"
if [ ! -f "$CHECKER" ]; then
  echo "[health-check-cron] FATAL: checker not found at $CHECKER" \
    >> "$LOG_DIR/health-check-$TS.log" 2>&1
  exit 4
fi

# Do NOT use `set -e` + bare invocation + `STATUS=$?`: errexit would kill the
# wrapper before WARN(1)/FAIL(2) results could be fully logged and old logs
# cleaned. Capture the status explicitly instead.
if node --experimental-strip-types "$CHECKER" \
  --public-url https://books.conanxin.com \
  --expected-docs 5115734 \
  --server-ip 118.195.129.137 \
  --json "$LOG_DIR/latest.json" \
  --markdown "$LOG_DIR/latest.md" \
  >> "$LOG_DIR/health-check-$TS.log" 2>&1; then
  STATUS=0
else
  STATUS=$?
fi

# Keep the last 14 days of dated logs only (never touch latest.*).
find "$LOG_DIR" -type f -name 'health-check-*.log' -mtime +14 -delete || true

exit "$STATUS"
