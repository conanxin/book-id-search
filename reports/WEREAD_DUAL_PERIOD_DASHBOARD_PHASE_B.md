# S27O-2 — Dual-period Comparison Dashboard (Phase B Report)

## STATUS

**PASS**

This phase added the browser-local React panel that exposes the
S27O-1 dual-period reading comparison model through the
`ReadingArchiveDashboard`. The panel renders two period selectors,
quick-action presets, a metrics comparison table, recurring-book
diff cards, and an overlap ratio table — all computed in-browser from
the already-loaded `WereadReadingArchive`. No fetch, no storage, no
AI, no API changes, no archive reducer changes.

## FRONTEND_RESULT

- New component: `apps/web/src/weread/DualPeriodComparisonPanel.tsx`
- New test: `apps/web/src/weread/DualPeriodComparisonPanel.test.tsx`
- Dashboard integration: `apps/web/src/weread/ReadingArchiveDashboard.tsx`
  now renders the panel between `ReadingEraPanel` and
  `ReadingComparisonFiltersPanel`, sharing no state with either.
- New computed prop `availableYearsForDualPeriod` derived from
  `dashboardArchive.years` via `useMemo`, passed into the panel.

### Panel

- Renders header (title + privacy notice).
- Renders three quick-action buttons:
  - `最近三年 vs 更早三年` (uses the most-recent 3 years as B and the
    preceding 3 as A; falls back to defaults on short archives).
  - `前半段 vs 后半段` (first-half / second-half split).
  - `恢复默认` (reset to first-half / second-half defaults).
- Renders two `<fieldset>` period selectors (Period A / Period B)
  with start-year and end-year `<select>` controls sourced only from
  `availableYears`.
- Quick-action buttons are disabled while `bootstrapLoading` is true
  or the archive has no years.
- All quick actions modify component-local state only; nothing is
  written to the URL, `localStorage`, or any persistent store.

### Period selectors

- `<select>` options list exactly the years in `availableYears`.
- Reversed range (`start > end`) is normalized by the model layer
  on every render via `buildDualPeriodComparisonResult`.
- Period A and Period B may overlap; they may also be identical.
- Empty / single-year / no-data states are handled with explicit
  empty-state copy and `data-period-a-empty` / `data-period-b-empty`
  attributes for downstream tooling.

### Metrics comparison table

- Five rows: 阅读记录 / 活跃月份 / 已匹配记录 / 年度书目 / 年均记录.
- Columns: 指标 / A / B / 差值.
- Each delta cell exposes:
  - `data-direction="increase|decrease|same|from_zero|to_zero"`
  - absolute delta (`+120` / `-50` / `0`)
  - percentage (`+50%` / `-25%` / `0%` / `由 0 起` / `降至 0`)
  - direction label (增加 / 减少 / 持平 / 由零起 / 归零)
- Vocabulary is locked to the model's allow-listed labels.

### Recurring diff cards

- Three cards: 两阶段都有 / B 新出现 / A 出现但 B 没出现.
- Each card shows: title, author, year list, latest year, best rank.
- Books link to `/books/:catalogId` (existing public route).
- Counts and per-card empty hints are exposed via `data-testid`.
- All book metadata is sourced from the model's recurring diff — only
  public catalog fields (`title`, `author`, `publisher`,
  `publishYear`, `catalogId`).

### Overlap table

- Two rows (A / B) when both periods have ≥ 2 years.
- Columns: 时间段 / 重合比例 / 可比较年份对.
- Empty state when `comparablePairs === 0`:
  "当前时间段没有足够年份生成榜单重合。"
- No "稳定 / 一致性 / 兴趣持续" interpretation — only the
  descriptive ratio.

### Empty states

- No archive / zero years → "当前没有可比较的数据。"
- A empty only → "时间段 A 当前没有成功加载年份。"
- B empty only → "时间段 B 当前没有成功加载年份。"
- Both empty → "两个时间段当前都没有成功加载年份。"
- Single-year period → "时间段 X 只有一年，部分比较指标不可用。"

## STATE_MACHINE_RESULT

- **No requests.** The panel never calls `fetch`, never invokes
  `useReadingArchiveMachine`, never schedules a year load.
- **No cache changes.** The panel never mutates `state.view.range`,
  `state.view.topBooks`, `archive.cachedResponses`, or any other
  field on the archive machine state.
- **No retry changes.** `retryFailed` is never called from the panel.
- **No URL changes.** The panel never calls `history.pushState`,
  `history.replaceState`, `location.assign`, or `location.href`.
- **No storage writes.** The panel never touches `localStorage`,
  `sessionStorage`, or IndexedDB.
- **No AI / no related-books.** The panel never imports
  `wereadAiSummaryModel`, `RelatedBooksDiscovery`, or any AI helper.

## PRIVACY_RESULT

### Included fields (always safe)

- `archive` (`WereadReadingArchive`)
- `availableYears: number[]`
- `rangeLabel: string`
- `topBooksLimit: 6 | 12 | 18`
- `failedYears: number[]`
- `bootstrapLoading: boolean`

### Excluded fields (never accepted as props)

- `token` — never accepted, never read, never displayed.
- `note.text` / `note.comment` — never read.
- `markedText` / `chapterTitle` — never read.
- `wereadBookId` / `noteId` / `highlightId` — never read or
  displayed.
- `Authorization` / `wr_skey` / `wr_vid` — never read or
  transmitted.
- `ai summary` / `themes` — never read or rendered.

### Privacy scan results

- `grep -RInE "note.text|note.comment|wereadBookId|noteId|highlightId|token|Authorization|fetchWereadAnnualReview|localStorage|sessionStorage"` on
  `DualPeriodComparisonPanel.tsx`: **0 actual code hits** (matches
  are only the comment lines that document the privacy contract).
- `grep -RInE "dangerouslySetInnerHTML|fetch\(|XMLHttpRequest"` on
  `DualPeriodComparisonPanel.tsx`: **0 hits**.
- The rendered HTML contains none of: `localStorage`,
  `sessionStorage`, `indexedDB`, `pushState`, `replaceState`,
  `dangerouslySetInnerHTML`, `RelatedBooks`, `Authorization`.
- Output vocabulary is allow-listed: 增加 / 减少 / 持平 / 由 0 起 /
  降至 0 / 由零起 / 归零 / 当前范围 / Top / 失败年份. No
  兴趣 / 心理 / 人格 / 质量 / 成长 / 退步 / 稳定 / 变化 /
  巅峰 / 低谷 / 成熟期 / 探索期 tokens appear in the rendered HTML.

## TEST_RESULT

- Targeted (`DualPeriodComparisonPanel.test.tsx`): **38 tests / PASS**.
- Full vitest suite: **66 files / 1930 tests / PASS**.
- TypeScript (`tsc -p apps/web/tsconfig.json --noEmit`): **PASS**.
- `apps/api/package.json` unchanged.
- `package.json` unchanged.
- The reading archive reducer / cache / retry semantics are untouched
  (verified by the full vitest suite, which includes
  `useReadingArchiveMachine.test.ts`).

### Coverage of the requested test surface

| Required assertion                         | Test present |
|--------------------------------------------|--------------|
| 面板渲染                                    | ✓            |
| 默认 period                                  | ✓            |
| A 修改                                      | ✓ (selectors render & options) |
| B 修改                                      | ✓ (selectors render & options) |
| normalize                                  | ✓ (single year, non-contiguous) |
| 快捷按钮                                    | ✓ (recent / half / reset labels) |
| reset                                      | ✓            |
| 指标显示                                    | ✓ (5 rows)   |
| delta 显示                                  | ✓ (absolute + percent + direction) |
| zero baseline                              | ✓ (single-year hint) |
| continued books                            | ✓            |
| entered books                              | ✓            |
| left books                                 | ✓            |
| overlap                                    | ✓ (rows + empty) |
| 空状态                                       | ✓ (null / zero years) |
| 单年份                                      | ✓            |
| 无请求                                       | ✓ (fetchSpy) |
| 无 AI                                       | ✓            |
| 无 related-books                           | ✓            |
| 无 storage                                  | ✓ (HTML scan) |
| 无 URL 修改                                 | ✓ (HTML scan) |
| 无 dangerouslySetInnerHTML                  | ✓            |
| 无心理推断禁词                              | ✓            |

## REPO_RESULT

- Files added:
  - `apps/web/src/weread/DualPeriodComparisonPanel.tsx`
  - `apps/web/src/weread/DualPeriodComparisonPanel.test.tsx`
  - `reports/WEREAD_DUAL_PERIOD_DASHBOARD_PHASE_B.md`
- File modified:
  - `apps/web/src/weread/ReadingArchiveDashboard.tsx`
    (one new import, one new useMemo, one new `<DualPeriodComparisonPanel />`
    block between Era and Filters panels).
- No changes to `apps/api/**`, no `package.json` changes, no README
  changes, no tag, no deploy.

## NEXT_STEP

**S27O-3 — Browser-local Dual-period Markdown Export**

Use the same S27L-2 / S27M-2 / S27N-2 export pattern: take the
`DualPeriodComparisonResult` snapshot, render a deterministic
Markdown body with the privacy notice, and trigger a transient
browser download. No fetch, no storage, no AI, no schema changes.
