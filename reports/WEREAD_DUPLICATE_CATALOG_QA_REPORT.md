# WeRead Duplicate Catalog QA Report

STATUS: PASS

## SCOPE

- Duplicate `catalogId` QA in confirmed WeRead matches only.
- No confirmed data mutation.
- No runtime API change.
- No frontend change.
- No Meilisearch write or rebuild.
- No deploy.

## DUPLICATE REVIEW RESULT

| Metric | Value |
|--------|-------|
| duplicateCatalogIdGroupsBefore | 1 |
| duplicateCatalogIdEntries | 2 |
| private review pack generated | yes |
| decision | allowed_same_work_duplicate |
| reasonCode | same_work_duplicate |
| allowlist generated | yes |
| candidateDecisionNeeded | 0 |

The single duplicate group was evaluated against the same-work criteria:

- normalized title highly consistent
- normalized author consistent
- both records point to the same `catalogId`
- both `matchConfidence` are `high`
- both `matchMethod` are `isbn` or `title_author`

Therefore the duplicate is accepted as a same-work duplicate and tracked in a private allowlist.

## AUDIT RESULT

| Metric | Value |
|--------|-------|
| confirmedEntries | 324 |
| uniqueWereadBookIds | 324 |
| uniqueCatalogIds | 323 |
| duplicateCatalogIdGroups | 1 |
| duplicateCatalogIdEntries | 2 |
| allowedDuplicateCatalogIdGroups | 1 |
| allowedDuplicateCatalogIdEntries | 2 |
| unresolvedDuplicateCatalogIdGroups | 0 |
| unresolvedDuplicateCatalogIdEntries | 0 |
| duplicateWereadBookIdGroups | 0 |
| duplicateWereadBookIdEntries | 0 |
| invalidRows | 0 |
| reviewConsistencyWarnings | 0 |
| reviewConsistencyErrors | 0 |
| audit status | PASS_WITH_ALLOWED_DUPLICATE |

## REGRESSION RESULT

| Check | Result |
|-------|--------|
| vitest | ✅ 449 tests PASS |
| weread:validate | ✅ PASS |
| verify | ✅ PASS, docs=5,115,734 |
| search:quality | ✅ 17 PASS / 0 WARN / 0 FAIL |

## PRIVACY RESULT

| Check | Result |
|-------|--------|
| No API key in tracked files | ✅ |
| No private data committed | ✅ |
| No real title/author/ID in report | ✅ |
| Private review/allowlist in gitignore | ✅ |
| Meilisearch untouched | ✅ |
| api/web untouched | ✅ |
| cron unchanged | ✅ |

## LIMITATIONS

- Only one duplicate group exists; allowlist is currently a single explicit decision.
- If future duplicate groups do not meet the same-work criteria, they will require manual review or a different `reasonCode`.

## NEXT STEP

- Continue with notes count/timeline trend work (S26L or next phase).
- Consider codifying the same-work criteria into a more general duplicate resolution rule if the pattern repeats.
