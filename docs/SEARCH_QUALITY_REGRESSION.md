# Search Quality Regression

## What is it?

A pure-search smoke / regression suite that exercises the
`/api/search` endpoint against the live site, verifies query-info
fields (cleanup, intent detection, identifier routing), and checks
that top results are sensible for each case.

It does **not** call MiniMax. It only reads what the public
`/api/search` endpoint returns. The "AI quality regression"
(see `docs/AI_QUALITY_REGRESSION.md`) is a separate, more
expensive suite that actually calls MiniMax for `/api/ai/...`
endpoints; search quality is its cheap companion.

## Case count and current baseline

- **17 cases** as of v0.6.1 (`S25A — search quality WARN cleanup`).
- **Baseline**: 17 PASS / 0 WARN / 0 FAIL.

Cases include:

- `beijing-travel-natural-language` — the S24 demo query
  "查一下北京旅游的书" must clean to "北京旅游" and resolve to
  `travel_guide` intent; 查斯特菲尔德 must NOT appear in top 5.
- `luxun-related-books` — generic-noun cleanup + literature intent.
- `isbn-spoken`, `ssid-spoken`, `dxid-spoken` — natural-language
  identifier queries (S25A labeled-extraction feature) must route
  to the exact-identifier branch.
- `isbn-exact`, `ssid-exact`, `dxid-exact` — bare identifier queries.
- `liao-buddhist-pagoda` — 学术类 intent coverage.
- `beijing-travel-guide`, `beijing-tourism-research` — travel vs
  academic dominance.
- `chinese-dictionary`, `commercial-press-dictionary` — reference
  intent.
- `children-picture-book`, `tourism-education-press-beijing` —
  publisher / topic combinations.
- `japanese-shawl-handicraft` — corpus-coverage check (any of
  披肩 / 吊带 / 手工 / 编织 / 日本 should appear).
- `obscure-query-no-crash`, `empty-query` — noFiveHundred cases.

## How to run manually

Either:

```sh
pnpm search:quality
```

which calls the local `tsx` runner (does not need a network
package install — uses `./node_modules/.bin/tsx`).

Or directly:

```sh
NO_PROXY="*" no_proxy="*" \
  ./node_modules/.bin/tsx scripts/search-quality-regression.ts \
    --public-url https://books.conanxin.com \
    --json /tmp/sq.json \
    --markdown /tmp/sq.md
```

The wrapper is in `scripts/run-search-quality-weekly.sh` (used by
the cron; see below).

## Exit codes

The runner returns:

- `0` — all 17 cases PASS
- `1` — at least one WARN, no FAIL
- `2` — at least one FAIL
- `3` — unhandled runtime error (e.g. network down)

## Weekly cron

```
40 4 * * 0 /opt/book-id-search/scripts/run-search-quality-weekly.sh
```

Sunday 04:40 UTC. After the daily health check (03:30) and the
weekly AI quality check (04:20). The wrapper uses `flock` to
prevent overlap, sets `NO_PROXY="*"` for the localhost Meili
outbound, runs the local `tsx` (no pnpm/corepack from cron), and
prunes logs older than 56 days.

## Log files

- `/opt/book-id-search/logs/search-quality/search-quality-YYYYMMDD-HHMMSS.log`
  — runner stdout/stderr
- `/opt/book-id-search/logs/search-quality/search-quality-YYYYMMDD-HHMMSS.md`
  — human-readable report
- `/opt/book-id-search/logs/search-quality/search-quality-YYYYMMDD-HHMMSS.json`
  — structured per-case result with cleanup / intent / top titles / notes

`logs/` and `**/logs/` and `*.log` are all in `.gitignore` (from
S23.1). The runner also does NOT write to
`reports/SEARCH_QUALITY_LATEST.md`-style paths, so weekly runs
do not drift the Git working tree.

## When the cron FAILs

1. Check the latest `.md` in `logs/search-quality/`.
2. For deep diagnosis, the `.log` has the full runner output.
3. The `.json` has the structured per-case details.

The wrapper does **not** auto-restart Meilisearch, modify the
search index, or alter the API. Failures are observational;
response is on the operator.

## Why not in the daily health check?

- The daily health check at 03:30 (`run-health-check-cron.sh`)
  runs `/api/health` and `/api/stats` only — it is the smoke
  alarm. Search quality is a deeper regression check; it runs
  17 HTTP calls and reads ~5 MB of payload, so weekly is plenty.
- Pairing it with the weekly AI quality run (also 04:xx Sunday)
  means the operator can read both reports in the same review
  window.
- Daily cadence would be cheap (the suite finishes in ~3 seconds)
  but the diff between Sunday and Monday is rarely meaningful
  for search quality — corpus coverage and ranking patterns are
  stable on a week-by-week basis.

## Difference from AI quality regression

| Aspect | Search quality | AI quality |
| --- | --- | --- |
| Calls MiniMax | No | Yes (up to 10 calls/run) |
| Endpoints hit | `/api/search` only | `/api/ai/book-insight`, `/api/ai/search-intent` |
| Case count | 17 | 9 |
| Frequency | Weekly (Sun 04:40) | Weekly (Sun 04:20) |
| Output paths | `logs/search-quality/` | `logs/ai-quality/` |
| Wrapper | `scripts/run-search-quality-weekly.sh` | `scripts/run-ai-quality-weekly.sh` |
| Cost | ~0 (HTTP only) | 8 / 10 AI calls (~$0.05) |
