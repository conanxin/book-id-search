# S25B — Weekly Search Quality Regression Cron

**STATUS:** PASS ✓

## Summary

S25A left `search:quality` at 17 PASS / 0 WARN / 0 FAIL. S25B wires
this regression into a weekly cron (Sunday 04:40 UTC), matching the
S23.1 AI-quality cadence and keeping the AI quality / health check
schedule intact.

| Cron | Schedule | Wrapper |
| --- | --- | --- |
| Daily health check | `30 3 * * *` | `run-health-check-cron.sh` |
| Weekly AI quality | `20 4 * * 0` | `run-ai-quality-weekly.sh` |
| Weekly search quality | `40 4 * * 0` (new) | `run-search-quality-weekly.sh` |

## CRON_RESULT

- **Weekly search quality cron installed**: yes
- **Expression**: `40 4 * * 0 /opt/book-id-search/scripts/run-search-quality-weekly.sh`
- **Daily health cron preserved**: yes (`30 3 * * *`)
- **Weekly AI quality cron preserved**: yes (`20 4 * * 0`)
- **Search quality NOT added to daily cron**: confirmed

Verified via `crontab -l`:

```
30 3 * * * /opt/book-id-search/scripts/run-health-check-cron.sh
20 4 * * 0 /opt/book-id-search/scripts/run-ai-quality-weekly.sh
40 4 * * 0 /opt/book-id-search/scripts/run-search-quality-weekly.sh
```

## MANUAL_RUN_RESULT

- **Wrapper exit code**: `0`
- **Pass / Warn / Fail**: 17 PASS / 0 WARN / 0 FAIL
- **Log path**: `/opt/book-id-search/logs/search-quality/search-quality-20260702-210747.log` (1.2 KB)
- **Markdown path**: `/opt/book-id-search/logs/search-quality/search-quality-20260702-210747.md` (8.3 KB)
- **JSON path**: `/opt/book-id-search/logs/search-quality/search-quality-20260702-210747.json` (18 KB)
- **Duration**: ~3 seconds (entire suite, end-to-end including network)

## REGRESSION_RESULT

```
[search-quality] Running 17 cases against https://books.conanxin.com
  ✓ beijing-travel-natural-language
  ✓ luxun-related-books
  ✓ isbn-spoken
  ✓ liao-buddhist-pagoda
  ✓ ssid-spoken
  ✓ dxid-spoken
  ✓ dxid-exact
  ✓ ssid-exact
  ✓ japanese-shawl-handicraft
  ✓ beijing-travel-guide
  ✓ beijing-tourism-research
  ✓ chinese-dictionary
  ✓ children-picture-book
  ✓ commercial-press-dictionary
  ✓ tourism-education-press-beijing
  ✓ obscure-query-no-crash
  ✓ empty-query

Totals: 17 PASS / 0 WARN / 0 FAIL
```

## RUNNER UPGRADES (S25B)

`scripts/search-quality-regression.ts` upgraded:

1. **New flags**: `--json <path>`, `--markdown <path>` — used by the
   weekly wrapper to direct output to timestamped files in
   `logs/search-quality/`. Default behavior (no flags) still writes
   to `logs/search-quality/search-quality-TS.md/json`.
2. **Exit codes** (per spec):
   - `0` = all PASS
   - `1` = at least one WARN, no FAIL
   - `2` = at least one FAIL
   - `3` = unhandled runtime error
3. **Exports** `parseArgs`, `bump`, `overallStatus`, `buildMarkdown`,
   `evalCase` for unit testing.

`scripts/search-quality-regression.test.ts` (new, 22 tests):

- 6 tests for `parseArgs` (defaults, --public-url, --json, --markdown,
  combined, missing-value)
- 5 tests for `bump` (PASS+WARN, PASS+FAIL, WARN+FAIL, etc.)
- 3 tests for `overallStatus` (PASS-only, PASS+WARN, FAIL trumps)
- 7 tests for `evalCase` (network error, 500, PASS, missing topId,
  intent miss as WARN, term miss as WARN, forbidden include as FAIL)
- 1 test for `buildMarkdown` (overall + per-case sections)

## WRAPPER

`scripts/run-search-quality-weekly.sh` (new, 75 lines):

- bash strict mode (`set -euo pipefail`)
- `cd /opt/book-id-search`
- `export NO_PROXY="*"; export no_proxy="*"`
- Local `./node_modules/.bin/tsx` (no pnpm / corepack from cron)
- Output: `logs/search-quality/search-quality-YYYYMMDD-HHMMSS.{log,md,json}`
- `flock` on `.search-quality-weekly.lock` to prevent overlap
- 56-day retention via `find -mtime +56 -delete`
- `chmod +x` applied
- Wrapper exit code is the runner's exit code (passthrough)

If `tsx` is missing: prints clear error, exits 2 (no install attempt).

## TESTS

- `vitest`: 288 / 288 PASS (was 266; +22 from new S25B test file)
- `verify.ts`: PASS (docs count unchanged at 5,115,734)
- `tsc -p apps/api --noEmit`: clean
- `tsc -p apps/web --noEmit`: clean
- Manual wrapper run: PASS (exit 0)

## SAFETY

- [x] no import, no reset, no key leak
- [x] Meilisearch untouched (Up 2 days, NOT restarted)
- [x] Caddy / 安全组 / 7700 exposure: untouched
- [x] MINIMAX_API_KEY never printed
- [x] api/web NOT rebuilt (only the cron wrapper, runner script,
      test, docs, and report — no app code change)
- [x] No `.env` / `meili_data` / `private-data` / `node_modules` / `dist` / `logs` in commit
- [x] `logs/` files not appearing in `git status` (verified manually)
- [x] `package.json` not touched (the `search:quality` script was
      already added in S24)
- [x] Working tree clean after commit
- [x] `crontab` confirmed: 3 book-id-search entries, 1 of them new

## FILES CHANGED

```
M scripts/search-quality-regression.ts            (CLI flags + exit codes + exports)
A scripts/search-quality-regression.test.ts       (new, 22 tests)
A scripts/run-search-quality-weekly.sh            (new, 75 lines, +x)
A docs/SEARCH_QUALITY_REGRESSION.md               (new, full S25B doc)
M README.md                                       (+search-quality doc link + 搜索质量周检 section + 17 case baseline)
A reports/SEARCH_QUALITY_WEEKLY_CRON_REPORT.md    (this file)
```

## NEXT_STEP

1. **Observe first scheduled run**: Sunday 04:40 UTC (next run after
   S25B tag is pushed). The wrapper will produce
   `logs/search-quality/search-quality-YYYYMMDD-HHMMSS.{log,md,json}`
   and exit 0 if all 17 cases pass.
2. **Optional future alerting**: if 2 consecutive weekly runs FAIL
   (or 3 consecutive WARN), add a `Telegram`/`cron` notifier that
   posts the latest `.md` summary. Not in scope for S25B.
3. **Optional future daily cadence**: the suite finishes in ~3
   seconds and has no token cost, so a daily run is feasible. The
   weekly cadence is a deliberate choice to match S23.1 and avoid
   noise from minor Meilisearch ranking drift on weekends. If
   regressions turn out to be a weekly problem, drop cadence to
   daily in a future S25C.
