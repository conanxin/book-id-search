# WeRead Reading Data Repair Recommendations — Dashboard Phase B

> S27R-2A + S27R-2B + S27R-2C 面板阶段正式报告
> 状态：**PASS**

---

## STATUS

**PASS**

This phase adds the browser-local React panel that exposes the
S27R-1 deterministic repair recommendation model through the
`ReadingArchiveDashboard`. The panel renders a 9-row summary,
priority-grouped recommendation list, four selector-driven special
sections (actionable / manual-review / unsupported / highest-priority),
loading and empty states — all computed in-browser from the
already-loaded `WereadReadingDataQualityAudit`. No fetch, no storage,
no AI, no API changes, no archive reducer changes, no automatic
repair.

## FRONTEND_SCOPE

- Input: current `WereadReadingDataQualityAudit` shared with the
  Audit Panel.
- Output: browser-local rendering of the deterministic
  `WereadReadingDataRepairPlan` produced by
  `buildWereadReadingDataRepairPlan(audit)`.
- No automatic repair.（`automatic = false` 强制）
- No `modifiesSourceData`.（`modifiesSourceData = false` 强制）
- No requests.（`fetchWereadAnnualReview` / `fetchWereadAiSummary` /
  `fetchWereadRelatedBooks` / `XMLHttpRequest` / `fetch` 全部 0 命中）
- No storage.（`localStorage` / `sessionStorage` / `indexedDB` 0 命中）
- No URL / history mutation.（`pushState` / `replaceState` /
  `window.location` 0 命中）
- No DOM mutation.（`dangerouslySetInnerHTML` / `innerHTML` 0 命中）
- No persistent state changes across the panel boundary.

## INTEGRATION_RESULT

- Panel position: `ReadingDataQualityAuditPanel` →
  `ReadingDataRepairRecommendationsPanel` →
  `ReadingEvolutionTimelinePanel` (Insertion order matches the
  spec: 发现 → 建议 → 时间线).
- `repairAudit` is constructed via the same `buildWereadReadingDataQualityAudit`
  call shape as the Audit Panel:
  - `archive: dashboardArchive`
  - `targetYears: archive.visibleYears`
  - `failedYears` (shared with Audit Panel)
  - `topBooksLimit: topBooks` (shared with Audit Panel)
- `loading={bootstrapLoading}` is forwarded verbatim from the
  Dashboard's existing `bootstrapLoading` value (no new state).
- `repairAudit` is a plain `const` declared alongside the rest of
  the existing `useMemo` results — no new Hook introduced.

## FRONTEND_RESULT

- New component: `apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx`
- New test: `apps/web/src/weread/ReadingDataRepairRecommendationsPanel.test.tsx`
- Dashboard integration: `apps/web/src/weread/ReadingArchiveDashboard.tsx`
  (1 line of `<ReadingDataRepairRecommendationsPanel … />` + 1 line
  of `const repairAudit = …`).
- Styles: appended to `apps/web/src/styles.css` under the
  `S27R-2C: Reading Data Repair Recommendations Panel` section.

### Panel

- Zero-hook React component (no `useState` / `useEffect` / `useMemo`
  / `useReducer` / `useRef` — source-level scan verified).
- Props: `audit: WereadReadingDataQualityAudit`, `loading: boolean`.
- Internal derivation: a single
  `buildWereadReadingDataRepairPlan(audit)` call inside the render
  function — no second plan state, no audit mutation, no
  network/storage/URL side effects.
- Renders header (title + neutral disclaimer + priority
  order note).
- Renders 9-row summary grid (建议总数 + 4 优先级 + 4 能力).
- Renders groups in deterministic `(priority, action)` order.
- Renders four special sections driven by model selectors:
  - `selectActionableRepairRecommendations` (user_retry / user_reload)
  - `selectManualReviewRepairRecommendations` (manual_review)
  - `selectUnsupportedRepairRecommendations` (unsupported_with_current_fields)
  - `selectHighestPriorityRepairRecommendations` (top of priority)
- Each special section renders only **count + fixed disclaimer**; no
  action buttons; no real retry/reload triggers.
- Loading state: "正在根据当前审计结果整理建议……" (no false counts).
- Empty state: "当前审计结果没有需要生成的修复建议。" + fixed
  "不会自动修复" disclaimer.

### Location rendering

Each recommendation renders only safe, location-style fields:

- 来源问题中文标签 (from `ISSUE_CODE_LABEL` exhaustive map)
- Scope 中文标签 (from `SCOPE_LABEL` exhaustive map)
- `year` (if present)
- `fromYear → toYear` (if both present)
- `itemIndex + 1` (1-based, if present)
- `rank` (1-based, if present)

The following are **explicitly excluded** from the rendered HTML:

- `Recommendation ID`
- `Issue ID`
- `actual` / `expected`
- `title` / `author` / `catalogId`
- `noteId` / `wereadBookId` (private IDs)
- Raw audit object
- Free-text exception details
- `NaN` / `Infinity` / `undefined`

### Summary structure

- 4-column desktop grid (2-column at ≤1100px, 1-column at ≤720px).
- Labels: 建议总数 / 优先检查 / 建议检查 / 当前条件有限 / 信息说明
  / 可重试 / 可重新加载 / 需人工核对 / 当前字段不足.
- Values are rendered as plain numbers (no `NaN` / `Infinity`).

### Group structure

- Each group: priority pill + action label + capability label +
  guidance label + count.
- Priority pill uses a **lightweight** visual distinction
  (`--high` / `--medium` / `--low` / `--informational`) — no
  danger / warning / alert coloration.
- Group items: 来源问题 + scope pill + location meta.

### Special sections

- `actionable` — fixed disclaimer: "这些建议可通过长期档案现有的
  重试或重新加载入口处理，本面板不会代替用户执行。"
- `manual-review` — count only.
- `unsupported` — fixed disclaimer: "当前审计字段不足时，系统不会
  推测缺失结果。"
- `highest-priority` — count only.

## MAPPING_RESULT

| Layer | 元素数 | 约束 |
|-------|-------|------|
| `ReadingDataRepairPriority` | 4 | exhaustive `Record` |
| `ReadingDataRepairAction` | 9 | exhaustive `Record` |
| `ReadingDataRepairCapability` | 5 | exhaustive `Record` |
| `ReadingDataRepairGuidanceKey` | 9 | exhaustive `Record` |
| `ReadingDataQualityIssueCode` (rendered) | 36 Chinese labels | exhaustive `Record` |
| `Scope` | 6 | exhaustive `Record` |

All mappings are TypeScript compile-time exhaustive (`satisfies
Record<…>`) and re-validated at runtime by the test suite.

## SAFETY_RESULT

- `automatic = false` on every `WereadReadingDataRepairPlan` produced
  in this phase.
- `modifiesSourceData = false` on every plan.
- No action buttons in any of the four special sections.
- No retry / reload / annual-review / related-books / AI calls from
  the panel or the dashboard.
- No evaluation-language copy: source scan for
  更爱阅读 / 兴趣 / 能力 / 心理 / 人格 / 优秀 / 较差 / 用户评分 /
  阅读质量 / 自动修复 / 一键修复 / 已修复 → 0 hits.
- No DOM mutation: `dangerouslySetInnerHTML` / `innerHTML` → 0 hits.
- No storage: `localStorage` / `sessionStorage` / `indexedDB` → 0 hits.
- No network: `fetch` / `XMLHttpRequest` → 0 hits.
- No URL mutation: `pushState` / `replaceState` / `window.location`
  → 0 hits.
- No proxy/network endpoints: `MiniMax` / `minimax` / `ai-summary`
  / `related-books` → 0 hits.

## HOOK_ORDER_REGRESSION

- `ReadingDataRepairRecommendationsPanel` is **zero-hook**:
  - `useState` → 0
  - `useEffect` → 0
  - `useMemo` → 0
  - `useReducer` → 0
  - `useRef` → 0
- `ReadingArchiveDashboard` parent body (via `sliceParentBody`):
  - `useMemo` → 2
  - `useState` → 1
  - `useEffect` → 0
  - `useReducer` → 0
  - `useRef` → 0
- `ReadingArchiveExportAction` (existing sub-component) is **not**
  counted toward the parent body and was unchanged by this phase.
- `active` round-trip:
  - `active=false` early return path: hooks are stable, no error.
  - `active=true` → render path: hooks are identical in identity.
  - `active=false → true → false → true`: 0 occurrences of React
    error #300.
- No new hooks are introduced by the repair panel integration.
- The add of the panel does **not** change the position of any
  existing hook (the new JSX is rendered after the existing
  `useMemo` / `useState` calls, before the early-return guard).

## STATE_MACHINE_RESULT

- `archive` reducer: unchanged.
- `cache` invalidation: unchanged.
- `retry` logic: unchanged.
- `reload` logic: unchanged.
- `annual-review` fetcher count: 0 new calls.
- `AI summary` fetcher count: 0 new calls.
- `related-books` fetcher count: 0 new calls.
- `fetch` / `XMLHttpRequest` count: 0 new calls.
- `localStorage` / `sessionStorage` / `indexedDB` write count: 0.
- `pushState` / `replaceState` count: 0.
- `window.location` write count: 0.

## PRIVACY_RESULT

The panel renders only the following safe fields:

- 来源问题中文标签 (from exhaustive `ISSUE_CODE_LABEL` map)
- Scope 中文标签 (from exhaustive `SCOPE_LABEL` map)
- `year` (when defined)
- `fromYear → toYear` (when both defined)
- `itemIndex + 1` (1-based, when defined)
- `rank` (when defined)

The panel DOES NOT render:

- `Recommendation ID`
- `Issue ID`
- `actual` / `expected`
- `title` / `author` / `catalogId`
- `noteId` / `wereadBookId` (private IDs)
- Raw audit object
- `Note` / `notes` / `cache` / `request` / `requestId` / `debug`
- `NaN` / `Infinity` / `undefined`
- Any free-text exception detail

Input `audit` is never mutated by the panel (verified by the
"input audit is not mutated by render" test).

## STYLE_RESULT

- New CSS section appended to `apps/web/src/styles.css` under the
  `S27R-2C: Reading Data Repair Recommendations Panel` marker.
- New classes:
  - `.weread-reading-data-repair` (root)
  - `.weread-reading-data-repair__header` / `__title` / `__intro` /
    `__priority-note` / `__notice`
  - `.weread-reading-data-repair__summary` / `__summary-row` /
    `__summary-label` / `__summary-value`
  - `.weread-reading-data-repair__groups` / `__group` /
    `__group-header` / `__priority` /
    `__priority--high` / `__priority--medium` /
    `__priority--low` / `__priority--informational`
  - `.weread-reading-data-repair__action` / `__capability` /
    `__guidance` / `__count`
  - `.weread-reading-data-repair__items` / `__item` / `__item-issue` /
    `__item-scope` / `__item-location`
  - `.weread-reading-data-repair__recommendations` / `__recommendation`
    / `__recommendation-meta` (aliased to the existing `__items` /
    `__item` styles for visual consistency)
  - `.weread-reading-data-repair__section` (aliased)
  - `.weread-reading-data-repair__actionable` / `__manual-review` /
    `__unsupported` / `__highest`
  - `.weread-reading-data-repair__special-title` / `__special-note` /
    `__special-count`
  - `.weread-reading-data-repair__empty` / `__loading` /
    `__limitation`
- Layout principles:
  - **No** `position: fixed` / `position: sticky` introduced.
  - Desktop summary: 4-column grid.
  - Tablet (≤1100px): 2-column grid.
  - Mobile (≤720px): 1-column grid; group header stacks vertically.
  - Group count moves to the start of the row on mobile.
  - No horizontal overflow at any breakpoint.
  - Year / location meta wraps with `word-break: break-word`.

## TEST_RESULT

### Targeted

- `wereadReadingDataRepairRecommendations.test.ts` — 104 / 104 PASS
  (model layer, unchanged from S27R-1).
- `ReadingDataRepairRecommendationsPanel.test.tsx` —
  **65 / 65 PASS** (the 8 new style-structure tests 58–65 added
  in S27R-2C verify root/summary/group/loading/empty classes,
  absence of `<button>` / inline `style`, priority modifier classes,
  the mobile breakpoint, and the absence of `position: fixed` /
  `position: sticky` in the panel's CSS slice).
- `ReadingArchiveDashboard.test.ts` — 121 / 121 PASS (the S27R-2B
  integration tests):
  - Panel exists.
  - Order: Audit → Repair → Evolution.
  - Repair Audit object is `WereadReadingDataQualityAudit`.
  - Same `targetYears` / `failedYears` / `topBooksLimit` as Audit Panel.
  - `loading` forwarded.
  - Inactive shell does NOT render repair data.
  - Inactive → active → inactive → active cycle: 0 React error #300.
  - Dashboard does NOT add a new Hook at the root component.
  - `repairAudit` is a plain `const`, not wrapped in any Hook.
  - Audit Panel / Timeline Panel / Era / Dual / Comparison /
    YearDirectory directories still present.
- `WereadCenter.test.tsx` — 10 / 10 PASS (no regression).

### Full regression

- `npx vitest run` — **78 test files, 2699 / 2699 tests PASS**.
- No hook warnings.
- No unexpected console errors.

### TSC

- `tsc -p apps/web/tsconfig.json --noEmit` — **PASS** (exit 0).

### Vite build

- `vite build` (with proxy env un-set) — **PASS**.
- Output: `dist/index.html`, `dist/assets/index-*.css`,
  `dist/assets/index-*.js`.
- `dist/` is `.gitignore`d and is not committed.

## PRODUCT_BOUNDARY

- API: unchanged.
- `package.json` / `pnpm-lock.yaml`: unchanged.
- No deploy.
- No tag.
- No README update.
- No new environment variable.
- No new dependency.
- No new public route.
- No new script under `scripts/`.

## CHANGED_FILES

```
M apps/web/src/styles.css
M apps/web/src/weread/ReadingArchiveDashboard.tsx
M apps/web/src/weread/ReadingArchiveDashboard.test.ts
? apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx
? apps/web/src/weread/ReadingDataRepairRecommendationsPanel.test.tsx
? reports/WEREAD_READING_DATA_REPAIR_RECOMMENDATIONS_DASHBOARD_PHASE_B.md
```

Boundary diff (`:! apps/api package.json pnpm-lock.yaml
apps/web/Dockerfile docker-compose.yml`) — **0 bytes**.

## KNOWN_LIMITATIONS

- The panel **only renders suggestions**; it does not execute any
  retry / reload / write / network call.
- The `unsupported_with_current_fields` branch is **not reachable**
  from the current S27Q `IssueCode` union; the section is rendered
  for forward-compatibility and is always 0 in live data.
- The Panel has no source-server write capability.
- The Panel does not provide free-text repair instructions.
- The UI does not provide retry / reload buttons; users use the
  existing long-archive dashboard controls to act on
  `user_retry` / `user_reload` recommendations.
- The Panel does not yet export the plan to Markdown (see
  NEXT_STEP).

## NEXT_STEP

**S27R-3 — Browser-local Repair Plan Markdown Export**

Goals:

- Reuse the existing S27Q-style Markdown export scaffold
  (browser-local; no upload).
- Include only the same safe fields already rendered in the Panel.
- Embed the same "no automatic repair" disclaimer.
- Skip the `unsupported_with_current_fields` branch when no
  suggestions of that type exist (still reachable from the
  selector when a S27R future uses it).
- Add a single export button next to the panel header.
- Verify: no network / no storage / no URL mutation / no
  innerHTML / no ID leakage / no evaluation language.
