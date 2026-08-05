# WEREAD Reading Evolution Timeline Dashboard — Phase B Report

**STATUS: PASS**

---

## STATUS

PASS — S27P-2 Reading Evolution Timeline Dashboard is in place.
Pure-React panel integrated into `ReadingArchiveDashboard`. No new
hooks in the parent component. Hook-order regression net preserved.

## FRONTEND_SCOPE

- **Component**: `ReadingEvolutionTimelinePanel`
- **Inputs**: `WereadReadingArchive` from the parent dashboard.
- **Outputs**: per-year timeline blocks (year nodes + transitions),
  milestone markers, public Top N preview per year, Top N book diff
  per transition.
- **No requests, no AI, no persistence**:
  - Component never invokes `fetchWereadAnnualReview` /
    `fetchWereadAiSummary` / `fetchWereadRelatedBooks`.
  - Never writes to `localStorage` / `sessionStorage` / IndexedDB.
  - Never writes to URL (`pushState` / `replaceState` / `history`).
  - Never uses `dangerouslySetInnerHTML` / `innerHTML`.
- **No new React hooks**: The panel does NOT introduce
  `useState` / `useEffect` / `useMemo` / `useReducer` / `useRef`.
  The model is a pure synchronous derivation called directly in
  the render path.

## YEAR_NODE_RESULT

| Concern | Behaviour |
|---------|-----------|
| Ordering | year ascending |
| Metrics | 阅读记录 / 已匹配记录 / 年度书目 / 活跃月份 / 活跃月份平均记录 |
| Empty peak month | not displayed (peak month is only available via model in non-evolution view) |
| Top N preview | first 6 books, with rank + title + author + `/books/:catalogId` link |
| Public fields only | title, author, catalogId, rank, publisher, publishYear |
| "另有 N 本" notice | shown when archive has more than 6 books in the year |
| Privacy | no note.text / comment / private IDs |

## TRANSITION_RESULT

### Per-transition rendering

- header: `{fromYear} → {toYear}` + significance score + 显著统计差异 /
  常规统计差异 badge
- adjacent-year overlap: ratio + 共同上榜书目数量 + 榜单并集书目数量
- reasons list (only valid enum names: year_gap / records_shift /
  active_months_shift / matched_books_shift / low_top_list_overlap)
- metrics table: 阅读记录 / 活跃月份 / 已匹配记录 / 年度书目 /
  活跃月份平均记录
  - 差值 + 百分比 + 方向 (5 direction enum)
  - `percentage=null` shown as `由 0 起` (no fake percentage)
  - `to_zero` shown as `降至 0` (percentage fixed at -100)
- book diff groups (continued / entered / left) collapsed inside
  `<details>`:
  - each group capped at 6 books
  - overflow notice "另有 N 本，完整结果将在后续本地导出中提供。"
  - empty group shows "暂无公共书目。"
  - rankDelta shown only in continued group with `+N` / `-N` / `0`

### Significance badge mapping

- score ≥ 50 OR year_gap → "显著统计差异" + solid border + light fill
- otherwise → "常规统计差异" + dashed border

### Empty-reasons fallback

When `transition.reasons.length === 0`, the panel renders the hint:
"当前过渡未达到统计差异标记阈值。"

## MILESTONE_RESULT

- always emits `first_year` (year = earliest loaded year) and
  `latest_year` (year = latest loaded year) when there is at least
  one year
- significant transitions map to `year_gap` (when reason includes
  year_gap) or `statistical_shift` (otherwise)
- sort: year asc, then kind order first_year < year_gap <
  statistical_shift < latest_year
- dedup by (year, kind) is enforced by the model; panel re-sorts
  defensively to maintain order
- displayed labels:
  - first_year → 时间线起始年份
  - latest_year → 时间线最近年份
  - year_gap → 年份中断节点
  - statistical_shift → 统计差异节点
- forbidden labels NOT used:
  - 转折点 / 成长期 / 成熟期 / 探索期 / 低谷 / 巅峰期 /
    兴趣迁移 / 能力改变

## HOOK_ORDER_REGRESSION

### Parent dashboard (ReadingArchiveDashboard)
- No new `useState` / `useEffect` / `useMemo` / `useReducer` /
  `useRef` / `useReadingArchiveMachine` introduced in the parent
  component body
- All parent hooks (useReadingArchiveMachine, useMemo for
  dashboardArchive, useMemo for failedYears, useState for eraMode,
  useState for exportStatus, useState for exportMessage, useEffect
  for export reset) are called BEFORE `if (!active)` early return
- After `if (!active)` early return: zero parent-component hooks

### Panel
- Zero React hooks in `ReadingEvolutionTimelinePanel`
- The model is called directly in the render path:
  `const timeline = buildWereadReadingEvolutionTimeline({ archive });`
- This is structurally safe — no `useMemo` dependency chain, no
  effect, no state. The model is a pure synchronous function.

### round-trip verification
- 12 hook-order regression tests in
  `ReadingArchiveDashboard.test.ts` (S27P-0B block) — all PASS
- 10 round-trip regression tests in `WereadCenter.test.tsx` —
  all PASS
- 59 panel render tests in `ReadingEvolutionTimelinePanel.test.tsx`
  — all PASS
- React `console.error` spy: zero `Rendered fewer hooks` /
  `Rendered more hooks` / `Invalid hook call` /
  `Minified React error #300` / `Minified React error #310` calls

## PRIVACY_RESULT

### Allowed fields (panel props + rendered output)

Props:
- `archive: WereadReadingArchive` (already privacy-safe model)
- `rangeLabel: string` (Chinese locale label, no data)
- `topBooksLimit: 6 | 12 | 18`
- `failedYears: number[]` (year numbers only)
- `bootstrapLoading: boolean`

Rendered HTML fields:
- year numbers, public catalogId, public title, public author,
  public publisher, public publishYear, rank, metric counts,
  metric deltas, percentage, reason enum, kind enum, significance
  score, summary counters, privacy notice, partial-failure notice

### Excluded fields (verified by grep)

```
forbidden-token scan of ReadingEvolutionTimelinePanel.tsx:
  note.text         → 0 hits outside comment block
  note.comment      → 0 hits outside comment block
  markedText        → 0 hits outside comment block
  wereadBookId      → 0 hits outside comment block
  noteId            → 0 hits outside comment block
  highlightId       → 0 hits outside comment block
  chapterTitle      → 0 hits outside comment block
  Authorization     → 0 hits outside comment block
  token=            → 0 hits outside comment block
  fetchWereadAnnualReview   → 0 hits
  fetchWereadAiSummary       → 0 hits
  fetchWereadRelatedBooks    → 0 hits
  localStorage      → 0 hits outside comment block
  sessionStorage    → 0 hits outside comment block
  indexedDB         → 0 hits outside comment block
  pushState         → 0 hits
  replaceState      → 0 hits
  history.push      → 0 hits
  dangerouslySetInnerHTML → 0 hits outside comment block
  innerHTML         → 0 hits outside comment block
```

### Inference-language scan (verified by grep)

```
forbidden-word scan:
  心理 / 人格 / 兴趣转变 / 偏好改变 / 成长 / 退步 / 改善 /
  提升 / 阅读低谷 / 阅读巅峰 / 成熟期 / 探索期 / 转折点 /
  稳定性 / 能力变化 / 阅读质量
  → 0 hits outside comment block
```

## TEST_RESULT

### Targeted gate
```
wereadReadingEvolutionTimeline.test.ts  → 72 / 72 PASS
ReadingEvolutionTimelinePanel.test.tsx  → 59 / 59 PASS
ReadingArchiveDashboard.test.ts         → 95 / 95 PASS
WereadCenter.test.tsx                   → 10 / 10 PASS
total                                    → 236 / 236 PASS
```

### Full vitest
- 2147 tests PASS across 70 files.

### tsc
- `apps/web/tsconfig.json --noEmit` clean.

### Vite build
- `dist/assets/index-CzTPjMP3.js` (612.99 kB / gzip 168.28 kB)
- `dist/assets/index-BkqqXPtP.css` (104.05 kB / gzip 14.79 kB)
- Build completed in 470 ms.

## PRODUCT_BOUNDARY

- `apps/api/`: NO CHANGES (verified via `git diff -- apps/api package.json`).
- `package.json`: NO CHANGES.
- `wereadReadingEvolutionTimeline.ts`: NO CHANGES (algorithm,
  thresholds, type semantics untouched).
- Archive reducer / scheduler / cache / retry: NO CHANGES.
- `fetchWereadAnnualReview` / `fetchWereadAiSummary` /
  `fetchWereadRelatedBooks`: NOT called from the panel.
- `localStorage` / `sessionStorage` / IndexedDB: NOT touched.
- URL: NOT touched.
- `dangerouslySetInnerHTML` / `innerHTML`: NOT used.
- Deployment: NO.
- Tag: NO.
- README: NO changes.

## KNOWN_LIMITATIONS

- Max 20 years inherited from the archive model.
- Top N book diff is bounded by current `archive.meta.topBooksLimit`
  (6 / 12 / 18). Switching Top N produces a different diff.
- Significance thresholds (2x / 1.5x / 5 / 20 / 0.2) are
  deterministic heuristics inherited from S27P-1.
- Panel shows first 6 books per diff group + "另有 N 本" overflow
  notice. Full lists will be in S27P-3 Markdown export.
- The panel does NOT explain why metrics differ.
- No topic / category / era / sentiment analysis.
- No manually editable milestones.
- No custom reason thresholds.
- Mobile breakpoint at 720px stacks summary / stats / diff-stats
  to single column. The metrics table itself stays horizontally
  scrollable inside its own container.

## NEXT_STEP

`S27P-3 Browser-local Reading Evolution Timeline Markdown Export` —
produce a Markdown export that consumes the timeline model and
emits the full diff / milestone / metric content into a single
downloadable document. UNBLOCKED upon completion of this phase.
