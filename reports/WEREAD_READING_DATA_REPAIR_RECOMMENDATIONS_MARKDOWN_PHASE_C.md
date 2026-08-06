# WeRead Reading Data Repair Recommendations — Markdown Phase C

> S27R-3A + S27R-3B 集成阶段正式报告
> 状态：**PASS**

---

## STATUS

**PASS**

This phase lands the browser-local Markdown export of the
S27R deterministic repair plan. The new `ReadingDataRepairExportAction`
child component owns the export lifecycle (idle / success / error)
inside its own React boundary, while the parent
`ReadingDataRepairRecommendationsPanel` remains **zero-hook**. The
child receives the same `plan` object that the parent renders
from, and uses `JSON.stringify(buildReadingDataRepairDebugSnapshot(plan))`
as a privacy-safe reset key on the React `key` prop so any change
to the plan forces a fresh remount, clearing any prior
`success` state.

A new Markdown model layer (`wereadReadingDataRepairMarkdown.ts`)
owns the document shape, filename, MIME, and the Blob-based
browser-local download helper.

A headless Chromium browser smoke script (`scripts/s27r3-browser-smoke.cjs`)
verifies the entire end-to-end export flow against a local
vite preview server with all private endpoints intercepted.

## FRONTEND_RESULT

### New component

- `apps/web/src/weread/ReadingDataRepairExportAction.tsx`
  - Props: `{ plan, loading }`.
  - Local state: `useState<"idle" | "success" | "error">` +
    `useState<string>` for the message.
  - `useEffect` resets the status on mount (driven by the
    parent's React `key`).
  - Both `useState` calls are placed **before** any conditional
    return so the hook list is stable.
  - `handleExport` calls `buildReadingDataRepairMarkdown` →
    `triggerReadingDataRepairMarkdownDownload` inside a
    try/catch. The catch path swallows the exception
    (`void err`) and sets a fixed neutral message — the error
    object is never embedded in the UI.
  - Renders exactly **one** `<button>` (the export trigger);
    no retry / reload / auto-repair buttons.

### New model

- `apps/web/src/weread/wereadReadingDataRepairMarkdown.ts`
  - Exhaustive `satisfies Record<...>` mappings for
    Priority (4) / Action (9) / Capability (5) /
    Guidance (9) / Scope (6) / IssueCode (36).
  - Sanitisers: `escapeReadingDataRepairMarkdownInline` and
    `escapeReadingDataRepairMarkdownTableCell` for safe
    Markdown rendering.
  - Deterministic builder: `buildReadingDataRepairMarkdown({ plan, exportedAt })`.
  - Filename: `weread-reading-data-repair-plan-YYYYMMDD.md`
    (ASCII, ≤80 chars).
  - MIME: `text/markdown;charset=utf-8`.
  - Browser download helper:
    `triggerReadingDataRepairMarkdownDownload(result, deps?)`
    — Blob + `URL.createObjectURL` + temp `<a>` + `click` +
    `remove` + `setTimeout(0)` → `URL.revokeObjectURL`.
  - Validator: `validateReadingDataRepairMarkdown(content)`
    flags Recommendation IDs / Issue IDs / note private IDs /
    book metadata / auth tokens / raw JSON / automatic-repair
    claims / user-evaluation language.

### Panel integration

- `apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx`
  - Adds a privacy-safe reset key:
    `const repairExportResetKey = JSON.stringify(buildReadingDataRepairDebugSnapshot(plan))`.
  - Embeds `<ReadingDataRepairExportAction key={repairExportResetKey} plan={plan} loading={loading} />`
    **between** the summary and the groups section.
  - **Zero Hook**: 0 `useState`, 0 `useEffect`, 0 `useMemo`,
    0 `useReducer`, 0 `useRef` (source-level scan verified).
  - Plan is still a plain `const` from
    `buildWereadReadingDataRepairPlan(audit)`; reset key is
    a plain `const`. Neither is wrapped in a Hook.

### Styles

- `apps/web/src/styles.css` (appended):
  - `.weread-reading-data-repair__export`
  - `.weread-reading-data-repair__export-actions`
  - `.weread-reading-data-repair__export-button` (with
    `:hover` / `:disabled`)
  - `.weread-reading-data-repair__export-summary`
  - `.weread-reading-data-repair__export-notice`
  - `.weread-reading-data-repair__export-status` /
    `--success` / `--error`
  - `@media (max-width: 720px)` collapses the actions row
    to a stacked column with a full-width button.

### Tests

- `apps/web/src/weread/ReadingDataRepairExportAction.test.tsx`
  — **45 / 45 PASS**.
  - Covers: button presence, loading-disabled / ready-enabled,
    per-plan-type rendering (normal / empty / no_action /
    unsupported), privacy contract, source-code safety
    (no fetch / no XHR / no storage / no URL / no innerHTML /
    no retry / no reload / no annual-review / no AI / no
    related-books / no POST / no console.log / no alert /
    no third-party Markdown lib), hook-order safety,
    module-level spy coverage on the Markdown helper.
- `apps/web/src/weread/ReadingDataRepairRecommendationsPanel.test.tsx`
  — **74 / 74 PASS** (the original 65 + 9 new structural
  tests for the export child + reset key + zero-hook
  invariant).
- `apps/web/src/weread/wereadReadingDataRepairMarkdown.test.ts`
  — **70 / 70 PASS** (from S27R-3A).

## EXPORT_ACTION_RESULT

- Child component: `ReadingDataRepairExportAction` (default
  export, single-file, zero dependencies beyond React +
  lucide-react icon + the Markdown model).
- Parent zero-hook: source scan + test #69 + test #70 confirm
  the parent body has no `useState` / `useEffect` / `useMemo`
  / `useReducer` / `useRef`. Plan + reset key remain plain
  `const`s.
- Reset behaviour: when the plan changes (any of summary,
  priorities, action/capability counts, group shape),
  `buildReadingDataRepairDebugSnapshot` returns a new
  object, `JSON.stringify` produces a new string, the React
  `key` changes, and the child is **remounted**, clearing any
  prior `success` status. The audit field changes flow through
  because the parent rebuilds the plan with the new audit and
  the debug snapshot captures the resulting summary.
- Loading / empty: button is `disabled` while `loading=true`;
  enabled for both ready + empty-plan states (the empty plan
  still produces a valid export with full metadata + safety +
  methodology sections).

## MARKDOWN_RESULT

- Structure: H1 title / ## 元数据 / ## 安全说明 /
  ## 建议总览 / ## 建议明细 / ## 可由现有界面处理 /
  ## 需要人工核对 / ## 当前字段不足 / ## 方法说明.
- Mappings: 4 Priority / 9 Action / 5 Capability / 9 Guidance
  / 6 Scope / 36 IssueCode — exhaustive `satisfies Record<…>`.
- Groups: deterministic, in `plan.groups` order.
- Privacy: only safe fields rendered (Chinese labels + year /
  fromYear→toYear / itemIndex 1-based / rank); never Recommendation
  ID / Issue ID / actual / expected / title / author /
  catalogId / noteId / wereadBookId / highlightId / raw audit /
  raw plan JSON / NaN / Infinity.
- Filename / MIME: `weread-reading-data-repair-plan-YYYYMMDD.md`,
  `text/markdown;charset=utf-8`, ASCII-only, ≤80 chars.
- Browser download: Blob + createObjectURL + temp anchor +
  click + remove + setTimeout(0) revokeObjectURL.

## HOOK_ORDER_REGRESSION

- `ReadingDataRepairExportAction` introduces its own hooks
  (`useState` × 2 + `useEffect` × 1), all **before** any
  conditional return. Hook identity is stable across
  `loading` toggles.
- `ReadingDataRepairRecommendationsPanel` (parent) remains
  zero-hook: 0 `useState`, 0 `useEffect`, 0 `useMemo`,
  0 `useReducer`, 0 `useRef`.
- `ReadingArchiveDashboard` parent body unchanged:
  2 `useMemo` / 1 `useState` / 0 `useEffect`.
- `active` round-trip false→true→false→true: 0 React error #300.

## STATE_MACHINE_REGRESSION

- `archive` reducer: unchanged.
- `cache` invalidation: unchanged.
- `retry` logic: unchanged.
- `reload` logic: unchanged.
- `annual-review` fetcher delta during the export click: 0.
- `AI summary` / `related-books` fetcher delta: 0.
- `fetch` / `XMLHttpRequest` count: 0.
- `localStorage` / `sessionStorage` / `indexedDB` write: 0.
- `pushState` / `replaceState` count: 0.
- `window.location` write: 0.

## PRIVACY_RESULT

The export produces a deterministic Markdown body that
contains only:

- 来源问题中文标签 (from exhaustive `ISSUE_CODE_LABELS` map)
- Scope 中文标签 (from exhaustive `SCOPE_LABELS` map)
- `year` (when defined)
- `fromYear → toYear` (when both defined)
- `itemIndex + 1` (1-based, when defined)
- `rank` (when defined)
- The 9-row summary table + 安全说明 + 方法说明
- The fixed export metadata (date / generation method /
  save state)

The export never includes:

- `Recommendation ID`
- `Issue ID`
- `actual` / `expected`
- `title` / `author` / `catalogId`
- `noteId` / `wereadBookId` / `highlightId` (private IDs)
- Raw audit object
- Raw repair plan JSON (`"recommendations":` /
  `"actionCounts":` / `"capabilityCounts":` / `"summary":`)
- `Authorization` / `Bearer` / `api_key` tokens
- `NaN` / `Infinity` / `undefined`
- Free-text exception details
- Any user-evaluation language (no scoring / rating /
  behavioural judgement / "更爱阅读" / "兴趣" / "能力" / "心理"
  / "优秀" / "较差")

The error path swallows the exception (`void err`) and
substitutes a fixed neutral message — no exception text /
stack ever reaches the UI.

## TEST_RESULT

### Targeted

- `wereadReadingDataRepairRecommendations.test.ts` — 104 / 104 PASS
- `wereadReadingDataRepairMarkdown.test.ts` — 70 / 70 PASS
- `ReadingDataRepairRecommendationsPanel.test.tsx` — 74 / 74 PASS
- `ReadingDataRepairExportAction.test.tsx` — 45 / 45 PASS
- `ReadingArchiveDashboard.test.ts` — 121 / 121 PASS
- `WereadCenter.test.tsx` — 10 / 10 PASS

**Total: 6 test files / 424 / 424 tests PASS.**

### TSC

- `tsc -p apps/web/tsconfig.json --noEmit` — **PASS** (exit 0).

### Vite build

- `vite build` (with proxy env un-set) — **PASS**.
- Output: `dist/index.html`, `dist/assets/index-*.css`,
  `dist/assets/index-*.js`. `dist/` is `.gitignore`d.

### Local browser smoke

- `node scripts/s27r3-browser-smoke.cjs` — **ALL 45 CHECKS PASS**.
  - Verifies the entire export flow end-to-end against a
    headless Chromium previewing the production build.
  - Synthesises 5 years of annual-review data (year 2023
    fails on first request and recovers on retry).
  - Validates: title / metadata / summary / groups / guidance
    / actionable / manual-review / unsupported / methodology
    sections; .md filename pattern; MIME type; absence of
    Recommendation IDs / Issue IDs / actual / expected /
    title / author / catalogId / note IDs / token / raw JSON
    / user-evaluation language / NaN / Infinity.
  - Request safety gate: bootstrap 1 call → export 0 delta →
    retry +1 → re-export 0 delta → 3.5 s stability wait
    (still 0 delta).
  - URL.revokeObjectURL observed.
  - 0 POST / 0 external requests / React error #300 = 0.
  - ICP footer present / desktop 1440 + mobile 360 no
    horizontal overflow.
  - Notes → Archive workspace round-trip confirmed.

## PRODUCT_BOUNDARY

- API: unchanged.
- `package.json` / `pnpm-lock.yaml`: unchanged.
- `Dockerfile` / `docker-compose.yml`: unchanged.
- No deploy.
- No tag.
- No README update.
- No new environment variable.
- No new dependency.
- No new public route.
- Production is **still** `v0.22.1-weread-data-quality-audit-markdown`
  (no new production release at this phase — that is
  reserved for S27R-3C).

## CHANGED_FILES

```
?? apps/web/src/weread/wereadReadingDataRepairMarkdown.ts
?? apps/web/src/weread/wereadReadingDataRepairMarkdown.test.ts
?? apps/web/src/weread/ReadingDataRepairExportAction.tsx
?? apps/web/src/weread/ReadingDataRepairExportAction.test.tsx
M  apps/web/src/weread/ReadingDataRepairRecommendationsPanel.tsx
M  apps/web/src/weread/ReadingDataRepairRecommendationsPanel.test.tsx
M  apps/web/src/styles.css
?? scripts/s27r3-browser-smoke.cjs
?? reports/WEREAD_READING_DATA_REPAIR_RECOMMENDATIONS_MARKDOWN_PHASE_C.md
```

Boundary diff (apps/api / package.json / pnpm-lock.yaml /
apps/web/Dockerfile / docker-compose.yml) — **0 bytes**.

## KNOWN_LIMITATIONS

- The export is a single file only; multi-plan / multi-year
  archives are not yet supported (out of scope for this phase).
- The repair plan does not yet include the model's
  `unsupported_with_current_fields` branch in live data
  (the audit IssueCode union doesn't currently emit it). The
  export handles `unsupported > 0` and `unsupported = 0` cases
  correctly, including the informational fallback copy.
- The export does not include a per-recommendation "reason"
  field — only the deterministic priority / action /
  capability / guidance label + safe location fields. Adding
  reason text would re-introduce the privacy contract risk
  and is intentionally omitted.
- The Markdown export is triggered only via the in-app button.
  There is no scheduled / automatic export.

## NEXT_STEP

**S27R-3C — Full Regression, Deterministic Production Release
and Documentation**

Goals:

- Run the full vitest suite (78 test files).
- Re-run the S27R-3A + S27R-3B targeted suites.
- Run all six other browser smoke scripts to confirm sibling
  Markdown entry points remain green.
- Update README + CHANGELOG with the S27R feature.
- Create the `v0.23.0-weread-reading-data-repair-markdown`
  production tag.
- Deploy the production container.
- Verify the production endpoint serves the new feature.