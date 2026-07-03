# WeRead Confirmed Match QA Audit Report

STATUS: BLOCKED

## SCOPE

- Confirmed match QA only; no data mutation.
- No runtime API change.
- No frontend change.
- No deploy.
- No Meilisearch write.

## CONFIRMED AUDIT RESULT

| Metric | Value |
|--------|-------|
| confirmedEntries | 333 |
| uniqueWereadBookIds | 333 |
| uniqueCatalogIds | 332 |
| duplicateCatalogIdGroups | 1 |
| duplicateCatalogIdEntries | 2 |
| duplicateWereadBookIdGroups | 0 |
| duplicateWereadBookIdEntries | 0 |
| invalidRows | 9 |
| warnings | 1 |
| reviewConsistencyWarnings | 0 |
| reviewConsistencyErrors | 0 |

## DISTRIBUTION RESULT

| Type | Distribution |
|------|--------------|
| matchMethod | title_author: 282, isbn: 51 |
| matchConfidence | high: 333 |
| decisionSource | auto_high_confidence: 333 |

## DUPLICATE RESULT

- 1 duplicate catalogId group, 2 entries.
- No action taken in this round.
- Next step: manual duplicate review (S26I-FIX) or accept if both WeRead records refer to the same catalog edition.

## INVALID ROWS RESULT

- 9 confirmed rows have invalid catalogId format and/or empty dxid.
- These entries use a `line_<number>` catalogId format and an empty dxid, which does not match the expected `ssid_dxid` catalogId format.
- This blocks the audit and must be resolved before the confirmed match set can be considered fully valid.
- Recommended S26I-FIX: either update the matching pipeline to exclude non-`ssid_dxid` catalogIds, or extend the system catalogId validation to accept `line_<number>` records.

## REGRESSION RESULT

| Check | Result |
|-------|--------|
| `npx vitest run` | 27 files / 438 tests PASS |
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
- `api` / `web` / `meilisearch` / `Caddy` / `cron` untouched.

## NEXT STEP

- S26I-FIX: resolve invalid rows (9) and review duplicate catalogId group (1) before proceeding.
- Or continue to S26J notes-count-only overlay if these invalid rows are accepted as a known edge case.
