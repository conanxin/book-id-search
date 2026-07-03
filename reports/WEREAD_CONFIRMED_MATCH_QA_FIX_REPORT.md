# WeRead Confirmed Match QA Fix Report

STATUS: WARN

## SCOPE

- Repair invalid confirmed rows only.
- No runtime API change.
- No frontend change.
- No deploy.
- No Meilisearch write.

## REPAIR RESULT

| Metric | Value |
|--------|-------|
| invalidRowsBefore | 9 |
| repaired | 9 |
| invalidRowsAfter | 0 |
| confirmedBefore | 333 |
| confirmedAfter | 324 |
| setPending | 2 |
| setNeedsManualSearch | 7 |

## AUDIT RESULT

| Metric | Value |
|--------|-------|
| confirmedEntries | 324 |
| uniqueWereadBookIds | 324 |
| uniqueCatalogIds | 323 |
| duplicateCatalogIdGroups | 1 |
| duplicateCatalogIdEntries | 2 |
| duplicateWereadBookIdGroups | 0 |
| duplicateWereadBookIdEntries | 0 |
| invalidRows | 0 |
| reviewConsistencyWarnings | 0 |
| reviewConsistencyErrors | 0 |
| status | WARN |

## DISTRIBUTION RESULT

| Type | Distribution |
|------|--------------|
| matchMethod | title_author: 273, isbn: 51 |
| matchConfidence | high: 324 |
| decisionSource | auto_high_confidence: 324 |

## DUPLICATE RESULT

- 1 duplicate catalogId group remains (2 entries).
- Not auto-fixed in this round.
- API summary shows `confirmedMatchesCount=323` (unique catalogIds), consistent with the file audit.
- Next step: manual duplicate review if desired, or accept as a known duplicate if both WeRead records map to the same catalog edition.

## REGRESSION RESULT

| Check | Result |
|-------|--------|
| `npx vitest run` | 28 files / 444 tests PASS |
| `tsc -p apps/api/tsconfig.json` | PASS |
| `tsc -p apps/web/tsconfig.json` | PASS |
| `weread:validate` | PASS |
| `verify.ts` | PASS, docs count 5,115,734 |
| `search:quality` | 17 PASS / 0 WARN / 0 FAIL |

## SAFETY

- No API key committed.
- No private data committed (`private-data` remains gitignored).
- Report contains only counts and validation categories; no real titles, wereadBookId, catalogId, or note text.
- No Meilisearch write.
- `api` / `web` / `meilisearch` / `Caddy` / `cron` untouched (api cache auto-refreshed; no restart).

## NEXT STEP

- Resolve remaining duplicate catalogId group manually if desired (S26I-FIX-2), or accept as known WARN.
- Continue to S26J notes-count-only overlay.
