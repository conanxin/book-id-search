# WeRead Overlay Refresh and Smoke Report

STATUS: WARN

## SCOPE

- Refresh/smoke only; no code feature change.
- No public search behavior change.
- No Meilisearch write or index rebuild.
- No note/highlight display changes.
- Frontend browser smoke was attempted but timed out.

## SUMMARY RESULT

- `confirmedEntries` = 333
- `uniqueCatalogIds` = 332
- `apiSummaryConfirmedMatchesCount` = 332
- `apiRestartNeeded` = no
- Cache auto-refreshed to 332.

## BATCH RESULT

- `matched` = yes (title_author confirmed catalogId returned `matched=true`)
- `unmatched` = yes (dummy `00000000_000000000000` returned `matched=false`)
- `responseRedacted` = yes (no real wereadBookId, noteId, highlightId, title, author, or note text in response)
- Response includes only `noteCount`, `highlightCount`, `readingStatus`, `progress`, `matchMethod`, `matchConfidence`, `decisionSource`, and timestamps.

## FRONTEND RESULT

- Browser smoke was attempted but the page load timed out after 60 seconds.
- Frontend panel count, badge visibility, batch request observation, and clear-token behavior were not verified live.
- This is the reason for WARN status.

## REGRESSION RESULT

| Check | Result |
|-------|--------|
| `npx vitest run` | 26 files / 430 tests PASS |
| `tsc -p apps/api/tsconfig.json` | PASS |
| `tsc -p apps/web/tsconfig.json` | PASS |
| `weread:validate` | PASS |
| `verify.ts` | PASS, docs count 5,115,734 |
| `search:quality` | 17 PASS / 0 WARN / 0 FAIL |

## SAFETY

- No API key committed.
- No private data committed (`private-data` remains gitignored).
- Report contains only counts; no real titles, wereadBookId, catalogId, or note text.
- No Meilisearch write.
- `api` / `web` / `meilisearch` / `Caddy` / `cron` untouched.

## NEXT STEP

- Retry browser frontend smoke when tooling is stable.
- Continue manual review or S26I medium-confidence review queue.
- Or proceed to S27 notes-count-only overlay.
