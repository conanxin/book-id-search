# S27O-3 — Dual-period Comparison Markdown Export (Phase C Report)

## STATUS

**PASS**

This phase added browser-local Markdown export for the dual-period
reading comparison panel. The export consumes the already-computed
`DualPeriodComparisonResult` and produces a deterministic Markdown
file via a transient Blob + Object URL + `<a download>` click. No
fetch, no storage, no AI, no API changes, no archive reducer
changes.

## MARKDOWN_RESULT

### Structure

The exported Markdown follows a fixed layout (deterministic order):

1. `# 双时间段阅读比较` title
2. Period A / Period B / range label / Top N / exportedAt / data
   source / "浏览器本地生成" indicator
3. `> 隐私说明` and `> 解释边界` blockquotes
4. `## 时间段概览` (年份范围 / 年份数量 / 阅读记录 / 活跃月份 /
   已匹配记录 / 年度书目 / 年均记录 / 最长连续活跃年份 /
   最高记录年份)
5. `## 核心指标比较` (5 rows × 5 columns: 指标 / A / B / 差值 /
   百分比)
6. `### 差异方向说明` (only when `from_zero` / `to_zero` /
   `same` appear)
7. `## Recurring Books`
   - `### 两个时间段共同出现` (continued)
   - `### B 新出现` (entered)
   - `### A 出现但 B 未出现` (left)
   Each book renders title / author / publisher(+publishYear) /
   years / rank / public URL.
8. `## Overlap` (A / B 重合比例 + 可比较年份对)
9. `## 方法说明` (12 fixed method notes)

### Delta display

- Allowed: `+120`, `-50`, `0`, `由 0 起`, `降至 0`.
- Forbidden in source: `提升`, `退步`, `成长`, `改善`,
  `兴趣转变`, `偏好改变`, `阅读低谷`, `探索期`, `成熟期`,
  `人格`, `心理`, etc. — all banned by the model's
  `validateDualPeriodMarkdown`.

### Filename

- Normal: `weread-dual-comparison-YYYY-YYYY-vs-YYYY-YYYY-YYYYMMDD.md`
  (ASCII only, ≤ 80 chars, no book titles, no catalogIds).
- Empty: `weread-dual-comparison-empty-YYYYMMDD.md`.

### MIME

`text/markdown;charset=utf-8` (hard-coded constant
`DUAL_PERIOD_MARKDOWN_MIME`).

### Trigger

`triggerDualPeriodMarkdownDownload({ content, filename })` creates
a `Blob`, calls `URL.createObjectURL`, appends / clicks / removes a
hidden `<a download>`, then schedules `URL.revokeObjectURL` via
`setTimeout(0)`. No `dangerouslySetInnerHTML`, no `innerHTML`, no
console logging.

## PERIOD_RESULT

| Case                                | Behavior |
|-------------------------------------|----------|
| Default periods                     | A: first half of `availableYears`, B: second half |
| Reversed range (start > end)        | Auto-swap by `normalizeReadingPeriod` |
| Out-of-range years                  | Snap to nearest available year |
| Empty available set                 | Period stays at original years; panel shows empty state |
| One period empty (no matching year) | "时间段 X 当前没有成功加载年份" hint |
| Single-year period                  | "时间段 X 只有一年" hint; metrics computed normally |

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

Percentage is rounded to 1 decimal in the model. The Markdown uses
the same formatters (`formatDualPercentage`, `formatDualAbsoluteDelta`).

## RECURRING_RESULT

- `continued`: intersection of A-period and B-period recurring books.
- `entered`: B-period only.
- `left`: A-period only.
- Each rendered as `**title**` plus indented sub-lines for
  author / publisher (+ publishYear) / years / rank / public URL.
- Empty hint rendered when a card is empty.
- All fields are public catalog metadata only; never `note.text`,
  never `wereadBookId`.

## OVERLAP_RESULT

- Table: `| 时间段 | 榜单重合比例 | 可比较年份对 |`
- Ratio formatted as `XX.X%` clamped to `[0%, 100%]`.
- Pair count split between A and B by the year-size ratio.
- Empty: `> 当前时间段没有足够年份生成榜单重合。`

## PRIVACY_RESULT

### Included fields (always safe)

- `result.periodA.range`, `result.periodA.metrics`
- `result.periodB.range`, `result.periodB.metrics`
- `result.delta.*` (absolute / percentage / direction)
- `result.recurringBooks.{continued, entered, left}` (public fields only)
- `result.overlap.{average, comparablePairs}`
- `rangeLabel`, `topBooksLimit`, `exportedAt`

### Excluded fields (never included)

- `note.text` / `note.comment` / `markedText`
- `wereadBookId` / `noteId` / `highlightId` / `chapterTitle`
- `Authorization` / `wr_skey` / `wr_vid` / `api key`
- `ai summary` / `themes`
- `localStorage` / `sessionStorage` / `indexedDB` (mention is
  sanitized to "浏览器本地存储")
- Raw comparison result JSON
- AI / cache / request / debug snapshots

### Network

- The trigger function only creates a Blob, an Object URL, and a
  DOM `<a>` element. No `fetch`, `XMLHttpRequest`, or external
  request is performed.

### Storage

- No `localStorage.setItem`, `sessionStorage.setItem`, or
  `indexedDB` write is performed by the panel or the model.

### Output privacy scan (model `validateDualPeriodMarkdown`)

- 16 forbidden tokens: `note.text`, `note.comment`, `markedText`,
  `wereadBookId`, `noteId`, `highlightId`, `chapterTitle`,
  `ai summary`, `aisummary`, `themes`, `authorization:`,
  `api key`, `apikey`, `wr_skey`, `wr_vid`, `token=` — all 0 in
  valid build output.
- 19 inference tokens: `兴趣转变`, `偏好改变`, `阅读低谷`,
  `阅读高峰期`, `探索期`, `成熟期`, `专注力变化`, `心态变化`,
  `阅读质量提升`, `阅读质量下降`, `心理状态`, `人格`, `性格`,
  `情绪`, `焦虑`, `懒惰`, `提升`, `成长`, `退步` — all 0 in
  valid build output.

## REGRESSION_RESULT

- Targeted (`wereadDualPeriodMarkdown.test.ts`): **54 tests / PASS**.
- Panel test (`DualPeriodComparisonPanel.test.tsx`): **48 tests / PASS**
  (38 prior + 10 new export-related).
- Full vitest suite: **67 files / 1994 tests / PASS**.
- TypeScript (`tsc -p apps/web/tsconfig.json --noEmit`): **PASS**.
- `apps/api/package.json` unchanged.
- `package.json` unchanged.
- Archive reducer / cache / retry semantics untouched
  (verified by the full suite, which includes
  `useReadingArchiveMachine.test.ts`).
- Existing Archive / Era / Comparison-Filter Markdown exports
  preserved (covered by both targeted tests and the dedicated
  smoke script).

## NEXT_STEP

**S27O-4 — Release Closeout**

Tag the stable release as
`v0.20.1-weread-dual-period-comparison-markdown`, update README
and CHANGELOG, verify production smoke, and announce.
