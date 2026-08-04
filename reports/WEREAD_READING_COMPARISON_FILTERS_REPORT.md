# S27N — Long-term Reading Comparison Filters Release Report

> Status: PASS — browser-local long-term comparison filters for the
> WeRead Reading Archive workspace. Released as
> `v0.19.0-weread-comparison-filters`.

---

## STATUS: PASS

All release gates passed. No rollback required.

---

## SCOPE

- **Source**: already-loaded `WereadReadingArchive` from the parent
  dashboard. No additional fetch, no new route, no new dependency.
- **Output**: deterministic filter result recomputed on every render
  via `useMemo`. All state lives in the panel's local state.
- **Network**: zero additional annual-review / AI summary /
  related-books requests triggered by any filter control.
- **Persistence**: nothing written to `localStorage` /
  `sessionStorage` / `IndexedDB`; nothing POSTed to the server;
  no external service called; no URL writes.

---

## FILTER_MODEL_RESULT

- **Defaults**: `{ startYear: null, endYear: null, minRecords: 0,
  minActiveMonths: 0, recurringMinYears: 2, overlap: "all" }`.
- **Normalization**: invalid literal types fall back to defaults;
  reversed `startYear`/`endYear` are swapped; years not in
  `availableYears` snap to the nearest valid year.
- **Overlap classification**: `low` for `[0, 0.25)`,
  `medium` for `[0.25, 0.5)`, `high` for `[0.5, 1.0]`. NaN → 0,
  `-Infinity` → 0, `Infinity` → 1, ratios < 0 → 0, ratios > 1 → 1.
- **Exclusion reasons**: `before_start`, `after_end`,
  `records_below_min`, `active_months_below_min`. Multiple reasons
  allowed per year.
- **Year links**: require both endpoints to be included; filtered
  by overlap class.
- **Recurring books**: per-catalogId appearance counting against
  current Top N; only counts appearances in `includedYears`;
  recomputes `bestRank` / `latestYear` / `latestRank`; sorted
  by `appearanceCount` desc → `bestRank` asc → `latestYear` desc
  → `title`; capped at 12.
- **Summary**: zero total when included list is empty;
  `earliest/latest` are `null` when included list is empty.

---

## YEAR_FILTER_RESULT

- Default behavior includes all successfully loaded years.
- Range filter by `startYear`/`endYear` (auto-swapped if reversed,
  snapped if out of range).
- Threshold filters (`minRecords`, `minActiveMonths`) drive the
  `records_below_min` / `active_months_below_min` reasons.
- Excluded years are listed with their Chinese reason strings.

---

## RECURRING_RESULT

- `recurringMinYears=2/3/4` keeps books that appeared in at least
  that many of the included years' Top N.
- Default `2`.
- Recomputed metrics are deterministic given the input archive and
  the filter set.

---

## OVERLAP_RESULT

- `all`: all eligible included-year links.
- `low` / `medium` / `high`: filtered by classified ratio.
- Sorted by `sourceYear` / `targetYear` ascending.
- Normalizes ratio edges before classification.

---

## FRONTEND_RESULT

- **Controls**: select for start year / end year / min records /
  min active months / recurring min years / overlap; reset button.
- **Summary**: included/excluded counts, year range, totals,
  average.
- **Excluded years**: list with Chinese reason labels.
- **Comparison table**: year-by-year metric comparison.
- **Recurring books**: list with `/books/:catalogId` links.
- **Overlap rows**: list with shared books and overlap ratio.
- **Empty states**: archive not loaded, no included years,
  no recurring books, no overlap rows.
- **Responsive**: 3-column desktop / 1-column ≤720px; no fixed /
  sticky positioning; no horizontal page overflow.
- **Accessibility**: every control has a label.

---

## STATE_MACHINE_REGRESSION

- `retry` before = **1**, after = **2**, delta = **1** ✓.
- `stability wait` (3.5 s) on the failing year remains at the
  post-retry value (no auto-retry storm) ✓.
- Range change to a cached subset: 0 additional annual-review
  requests ✓.
- Top N change to a cached subset: 0 additional annual-review
  requests ✓.
- Filter changes (start year, end year, min records, min active
  months, recurring min years, overlap): 0 additional annual-review
  requests ✓.
- Reset: 0 additional annual-review requests ✓.
- Archive Markdown export button still present and functional ✓.
- Era Markdown export button still present and functional ✓.
- Reading era panel still renders with mode + top N controls ✓.
- Existing S27L archive smoke: PASS (38/38 + bonus).
- Existing S27L-2 archive Markdown smoke: PASS (43/43).
- Existing S27M era smoke: PASS (21/21).
- Existing S27M-2 era Markdown smoke: PASS (45/45).
- Existing S27N comparison smoke: PASS (30/30).

---

## PRIVACY_RESULT

- **Included**: archive metadata, per-year totals, boundary scores
  and allow-listed reasons (in earlier milestones), public catalog
  metadata (`catalogId`, `title`, `author`, `publisher`,
  `publishYear`), recurring book aggregations, overlap ratios, and
  public `/books/:catalogId` URLs.
- **Excluded**: `note.text`, `note.comment`, `markedText`,
  `wereadBookId`, `noteId`, `highlightId`, `chapterTitle`, AI
  summary body, themes, token, `q`, `Authorization`, API key,
  private API URL, cache/request/debug snapshots, raw archive JSON,
  raw era JSON, and any psychological / personality / interest /
  quality inference.
- **Network**: zero additional requests triggered by the panel.
- **Persistence**: zero `localStorage` / `sessionStorage` /
  `IndexedDB` writes.
- **URL**: zero URL writes.
- **No HTML strings**: no `dangerouslySetInnerHTML` / `innerHTML`
  in the new code.
- **Psychological-language scan**: zero forbidden vocabulary in the
  new source, tests, or browser DOM. The existing S27L smoke
  regression check (test 38) continues to pass.

---

## REGRESSION_RESULT

| Gate | Result |
|------|--------|
| `vitest run` (full repo) | **63 / 63 files PASS** — **1754 / 1754 tests PASS** |
| `tsc -p apps/web` | **PASS** (no errors) |
| `vite build` | **PASS** (CSS / JS chunks) |
| `verify.ts` | **5,115,734** docs ✓ |
| `search-quality-regression` | **17 PASS / 0 WARN / 0 FAIL** |
| S27L original smoke | **PASS** (38/38 + bonus) |
| S27L-2 archive Markdown smoke | **43 / 43 PASS** |
| S27M era smoke | **21 / 21 PASS** |
| S27M-2 era Markdown smoke | **45 / 45 PASS** |
| S27N comparison smoke | **30 / 30 PASS** |

---

## DEPLOY_RESULT

- **web**: rebuilt and redeployed (`docker compose up -d --no-deps
  --build web`), fresh container.
- **api**: untouched (uptime preserved).
- **Meilisearch**: untouched (uptime preserved).
- **Caddy / DNS / nginx / ICP compliance**: untouched.

---

## LIMITATIONS

- Hard cap of **20 years** (`READING_ARCHIVE_MAX_YEARS`).
- Recurring books only consider the **current Top N** (6 / 12 /
  18), not the full yearly catalog.
- Threshold options are fixed at the documented values; no custom
  numeric input.
- Filter state is component-local and resets on page reload.
- No persistence of filter presets / named filter combinations.

---

## NEXT_STEP

- **S27N-2 — Browser-local Filtered Comparison Markdown Export**:
  extend the export surface so the user can save the current
  filtered comparison snapshot to a browser-local Markdown file.