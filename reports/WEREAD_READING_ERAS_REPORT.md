# S27M — Reading Era Segmentation Release Report

> Status: PASS — browser-local reading-era segmentation for the
> WeRead Reading Archive workspace. Released as
> `v0.18.0-weread-reading-eras`.

---

## STATUS: PASS

All release gates passed. No rollback required.

---

## SCOPE

- **Source**: current in-memory `WereadReadingArchive` (already
  loaded by the existing archive state machine). No additional
  fetch, no new route.
- **Generation**: pure-function `buildReadingEras(archive, mode)`
  runs in the browser on every render.
- **Network**: zero new annual-review / AI summary / related-books
  requests triggered by the panel.
- **Persistence**: nothing written to `localStorage` /
  `sessionStorage` / IndexedDB; nothing POSTed to the server.

---

## ALGORITHM_RESULT

- **Boundaries**: four deterministic reasons
  (`year_gap` / `activity_shift` / `active_month_shift` /
  `top_list_shift`); each fires only when its explicit gate is
  satisfied.
  - `year_gap` when `targetYear - baseYear > 1` (always).
  - `activity_shift` when ratio ≥ 2 **and** abs diff ≥ 20.
  - `active_month_shift` when abs diff ≥ 5.
  - `top_list_shift` when `overlapRatio < 0.2` and both Top N non-empty.
- **Scoring**: weights `year_gap=100`, `activity_shift=35`,
  `active_month_shift=25`, `top_list_shift=25`. Sum across reasons
  is exposed per boundary.
- **Modes**:
  - `automatic` (default): keeps `year_gap` always; keeps other
    boundaries when total score ≥ 50.
  - `gaps_only`: keeps only `year_gap` boundaries.
- **Single-year segment merge**: `year_gap`-era single-year segments
  preserved; others merge to the lower-score side; tie → merge
  backward (with prev era).
- **Era statistics**:
  - `totalRecords`, `totalActiveMonths`: summed per year.
  - `averageRecordsPerYear`: total / years.length.
  - `peakYear`: max totalRecords; tie → earlier year.
  - `recurringBooks`: catalogIds appearing in ≥ 2 era-year Top N
    lists; capped at 6; titles / authors reused from archive-level
    recurring list when present, else stub record.

---

## FRONTEND_RESULT

- **Panel**: `ReadingEraPanel` rendered between ArchiveTimeline
  section and ArchiveYearDirectory section of the long-term archive
  dashboard.
- **Controls**: two radio buttons — 自动阶段 / 仅按年份中断分段.
  No fetches on toggle.
- **Era cards**: each card shows year range, year count, total
  records, total active months, average records per year, peak
  year + records.
- **Boundaries**: rendered between cards with allow-listed Chinese
  labels only (`年份存在中断`, `阅读记录数量变化较大`,
  `活跃月份数量变化较大`, `相邻年度 Top N 榜单重合较低`).
- **Recurring books**: catalogId links to `/books/:catalogId`
  (public route).
- **Responsive**: CSS grid `auto-fit minmax(280px, 1fr)` on
  desktop, single column at ≤ 540px.
- **Browser smoke**: 21/21 PASS (Puppeteer against the deployed
  web).

---

## STATE_MACHINE_REGRESSION

- `retry` before = **1**, after = **2**, delta = **1** ✓.
- `stability wait` (3.5 s) = **2** ✓ (no auto-retry storm).
- Range change: no extra annual-review requests ✓.
- Top N change: no extra annual-review requests ✓.
- Mode switch: no extra annual-review requests ✓.
- Existing S27L archive smoke: 38/38 + bonus PASS ✓.
- Existing S27L-2 archive Markdown smoke: 43/43 PASS ✓.

---

## PRIVACY_RESULT

- **Included**: archive metadata + year-level totals (records /
  active months / peak month / matched counts) + topBooks
  catalogId+title+author + cross-year aggregations (recurring
  books, adjacent-year overlap, era recurring books).
- **Excluded**: `note.text`, `note.comment`, `markedText`,
  `wereadBookId`, `noteId`, `highlightId`, `chapterTitle`,
  `summary.{overview,keyPoints,reviewQuestions}`, `themes`,
  private token / `wr_skey` / `wr_vid` / cookie / session.
- **Network**: 0 new requests on mount / mode switch / range
  change / Top N change / retry.
- **Persistence**: 0 writes (`localStorage` / `sessionStorage` /
  IndexedDB / server).
- **Psychological-language scan**: 0 hits in
  `apps/web/src/weread/ReadingEraPanel.tsx` /
  `ReadingEraPanel.test.tsx` /
  `wereadReadingEraModel.ts` /
  `wereadReadingEraModel.test.ts` /
  `ReadingArchiveDashboard.tsx`. The S27L smoke
  "no psychological-inference vocabulary" check now passes
  alongside the new panel.
- **No HTML strings**: no `dangerouslySetInnerHTML` / `innerHTML`
  in the new code.

---

## REGRESSION_RESULT

| Gate | Result |
|------|--------|
| `vitest run` (full repo) | **1603 / 1603 PASS** (60 files) |
| `tsc -p apps/web` | **PASS** (no errors) |
| `vite build` | **PASS** (90.37 kB CSS / 513.97 kB JS) |
| `verify.ts` | **5,115,734** docs ✓ |
| `search-quality-regression` | **17 / 0 / 0** (PASS / WARN / FAIL) |
| S27L original smoke | **38 / 38 + bonus PASS** |
| S27L-2 archive Markdown smoke | **43 / 43 PASS** |
| S27M era smoke | **21 / 21 PASS** |

---

## DEPLOY_RESULT

- **web**: rebuilt and redeployed (`docker compose up -d --no-deps
  --build web`), fresh container.
- **api**: untouched (35 h uptime preserved).
- **Meilisearch**: untouched (4 weeks uptime preserved).
- **Caddy / DNS / nginx / ICP compliance**: untouched.

---

## LIMITATIONS

- Hard cap of **20 years** (`READING_ARCHIVE_MAX_YEARS`).
- Era recurring books only consider the **current Top N** (6 /
  12 / 18), not the full yearly catalog.
- Boundary thresholds are heuristic, not derived from book titles,
  authors, or themes.
- No user-customisable boundary thresholds.
- The phase segmentation only describes "统计发生变化"; it does
  **not** explain why the user changed.

---

## NEXT_STEP

- **S27M-2 — Browser-local Reading Era Markdown Export**: extend the
  existing reading-archive Markdown export to include an optional
  "阅读阶段" section that embeds the era segmentation result.