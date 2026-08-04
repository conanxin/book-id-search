# S27O-1 — Dual-period Reading Comparison Model (Phase A Report)

## STATUS

**PASS**

This phase added a browser-local, pure-function model for comparing two
user-defined reading time windows (Period A and Period B) drawn from the
already-loaded `WereadReadingArchive`. No fetch, no storage, no AI, no
UI, no API changes.

## MODEL_RESULT

### Period normalization (`normalizeReadingPeriod`)

- Reversed range (`startYear > endYear`) → swap.
- Out-of-range years → snap to nearest available year.
- Empty available set → return the original period (caller short-circuits).
- Verified against: 2019 / 2024 → 2020 / 2023, 2022 / 2024 → 2023 / 2023
  (collapse), 2020 / 2025 with no available years → unchanged.

### Period metrics (`buildPeriodMetrics`)

- Sums `totalRecords` / `totalActiveMonths` / `matchedRecords` /
  `matchedBooks` for years strictly inside the period.
- `averageRecordsPerYear` = `totalRecords / years.length` (0 if empty).
- `averageRecordsPerActiveMonth` = `totalRecords / totalActiveMonths`
  (0 if `activeMonths = 0`).
- `longestActiveStreak` counts consecutive in-period years that carry
  data (>0 records); zero-records years break the streak.
- `peakYear` picks the year with most `totalRecords`; ties resolve to
  the earlier year. `null` when no year carries data.
- Empty period returns zero metrics, empty `years[]`, `null` peak.

### Delta calculation (`calculateMetricDelta`)

- `absolute = B - A`.
- `percentage = (B - A) / A * 100` when `A > 0`; rounded to 1 decimal.
- Direction tags:
  - `from_zero` when `A = 0, B > 0` → `percentage = null`.
  - `to_zero` when `A > 0, B = 0` → `percentage = -100`.
  - `increase` / `decrease` / `same` for the general case.
- NaN / Infinity inputs are normalized to 0 before the comparison.

### Recurring books diff (`compareRecurringBooks`)

- `continued`: books appearing in ≥ `recurringMinYears` (default 2)
  years within both periods.
- `entered`: books qualifying in B but not A.
- `left`: books qualifying in A but not B.
- Continued list merges years, computes union `yearsOnList`, picks
  `bestRank = min(A.bestRank, B.bestRank)`, `latestYear = max(...)`.
- Each list is capped at `DUAL_PERIOD_RECURRING_BOOKS_LIMIT = 12`.
- Sorting rules:
  - Continued: `yearsOnList desc → bestRank asc → latestYear desc → title`.
  - Entered / Left: by period-internal ranking.
- Only public catalog fields are exposed (`catalogId`, `title`,
  `author`, `publisher`, `publishYear`); no `note.text`, no private IDs.

### Period overlap comparison (`comparePeriodOverlap`)

- Collects adjacent-year `overlapRatio` from the archive's
  `yearLinks` whose both endpoints lie inside each period.
- `average` is the mean of all collected ratios across both periods,
  rounded to 1 decimal.
- `comparablePairs` counts all collected links (the same link counts
  once per period that contains it).
- NaN / Infinity / negative / >1 ratios are clamped before averaging.
- The label is purely descriptive ("average overlap ratio") — never
  "stable" / "changing" / "interest" / "quality".

## PERIOD_NORMALIZATION

| Case                        | Input              | Output               |
|-----------------------------|--------------------|----------------------|
| Reversed range              | A: 2025→2021       | A: 2021→2025         |
| Out-of-range snap           | 2019 / 2024 on [2020,2022,2023,2025] | 2020 / 2023 |
| Collapse to single year     | 2022 / 2024 on [2019,2020,2023] | 2023 / 2023 |
| Empty available set         | 2020 / 2025 on []  | 2020 / 2025          |
| Valid period preserved      | 2021 / 2023        | 2021 / 2023          |

## DELTA_RESULT

| A   | B   | absolute | percentage | direction  |
|----:|----:|---------:|-----------:|------------|
| 100 | 150 |       50 |         50 | increase   |
| 200 | 100 |     -100 |        -50 | decrease   |
| 150 | 150 |        0 |          0 | same       |
|   0 |  50 |       50 |       null | from_zero  |
| 100 |   0 |     -100 |       -100 | to_zero    |
|   0 |   0 |        0 |          0 | same       |
| 300 | 350 |       50 |       16.7 | increase   |

## RECURRING_RESULT

- Books in period A only → `left` (capped at 12).
- Books in period B only → `entered` (capped at 12).
- Books in both → `continued` (capped at 12, sorted by
  `yearsOnList desc → bestRank asc → latestYear desc → title`).
- Default `recurringMinYears` = 2; configurable.
- Only public fields surface in the result.

## OVERLAP_RESULT

- Empty: `average = 0`, `comparablePairs = 0`.
- Negative ratio clamped to 0 before averaging.
- Ratio > 1 clamped to 1 before averaging.
- NaN ratio treated as 0.
- Result label is `average` only — no psychological interpretation.

## PRIVACY_RESULT

- `meta.persisted` is hard-coded to `false`.
- `meta.source` is hard-coded to `"current_loaded_archive"`.
- All public types only expose: `startYear`, `endYear`, `totalRecords`,
  `totalActiveMonths`, `matchedRecords`, `matchedBooks`,
  `averageRecordsPerYear`, `averageRecordsPerActiveMonth`,
  `longestActiveStreak`, `peakYear`, `peakYearRecords`, `years[]`,
  `absolute`, `percentage`, `direction`, `entered[]`, `left[]`,
  `continued[]`, `catalogId`, `title`, `author`, `publisher`,
  `publishYear`, `yearsOnList`, `years`, `totalNoteCountWithinLists`,
  `bestRank`, `latestYear`, `latestRank`, `sourceYear`,
  `targetYear`, `sharedTopBooks`, `overlapRatio`, `average`,
  `comparablePairs`.
- No `note.text`, `note.comment`, `markedText`, `wereadBookId`,
  `noteId`, `highlightId`, `chapterTitle`.
- No `Authorization`, `token=`, `wr_skey`, `wr_vid`, `api key`.
- No `ai summary`, `themes`, `fetch`, `localStorage`, `sessionStorage`,
  `indexedDB`.
- No psychological inference words in any string literal or result
  field: `心理`, `兴趣`, `人格`, `质量`, `成长`, `退步`,
  `稳定`, `变化`, `巅峰`, `低谷`, `成熟期`, `探索期`.

## TEST_RESULT

- Targeted (`wereadDualPeriodComparison.test.ts`): **55 tests / PASS**.
- Full vitest suite: **65 files / 1892 tests / PASS**.
- TypeScript (`tsc -p apps/web/tsconfig.json --noEmit`): **PASS**.
- `apps/api/package.json` unchanged.
- `package.json` unchanged.
- All tests use synthetic `WereadReadingArchive` fixtures — no real
  user data, no network, no storage writes.

## NEXT_STEP

**S27O-2 — Dual-period Comparison Dashboard** (UI integration: wire the
panel into `ReadingArchiveDashboard`, expose controls for Period A /
Period B, render the comparison snapshot, and run browser smoke
without modifying the archive reducer / cache / retry semantics).