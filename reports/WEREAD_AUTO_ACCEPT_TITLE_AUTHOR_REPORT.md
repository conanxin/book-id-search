# WeRead Title-Author Auto-Confirm Report

STATUS: PASS

## SCOPE

- Strictly auto-confirm `title_author` high-confidence matches in the private review queue.
- No runtime API change.
- No frontend change.
- No Meilisearch write or index rebuild.
- No container redeploy.

## AUTO ACCEPT RESULT

- `scanned` = 1586
- `autoAccepted` = 282
- `alreadyAccepted` = 51
- `skippedNonPending` = 494
- `skippedNonTitleAuthor` = 519
- `skippedNotHigh` = 0
- `skippedTitleMismatch` = 142
- `skippedAuthorMismatch` = 10
- `skippedAmbiguous` = 88
- `skippedNoCandidate` = 0
- `dryRun` completed with same counts before applying changes.

## CONFIRMED RESULT

- `confirmedBefore` = 51 (all ISBN high)
- `confirmedAfter` = 333 file entries (282 new title_author + 51 existing ISBN)
- `confirmedUniqueCatalogIds` = 332 (1 catalogId collision across two separate WeRead books)
- `increasedBy` = 282
- `pendingAfter` = 759
- `needs_manual_search` = 494 (unchanged)
- `progressPercent` = 21%
- `apiSummaryConfirmedMatchesCount` = 332 (reflects unique catalogIds; no API restart)

## VALIDATION RESULT

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
- `api` / `web` / `meilisearch` services untouched.
- `cron` unchanged.

## NEXT STEP

- S26H: refresh private overlay summary / optional frontend smoke to confirm badge count now reflects 332 unique matches.
- Continue manual review for remaining 759 pending + 494 needs_manual_search items if desired.
