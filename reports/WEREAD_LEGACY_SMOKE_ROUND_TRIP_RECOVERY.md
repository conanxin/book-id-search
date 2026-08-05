# WEREAD Legacy Smoke Round-Trip Recovery

**STATUS: PASS**

---

## ORIGINAL_FAILURE

- **Affected suites**: S27L, S27L-2
- **Common crash point**: Tab round-trip section — second archive tab click after notes→archive sequence
  - S27L: line 815 `await page.click('[data-testid="weread-tab-archive"]')`
  - S27L-2: line 800 `await page.click('[data-testid="weread-tab-annual"]')`
- **Exit behavior**: process exit=2, crash at selector assertion
- **Error**: `Minified React error #300` (element type is invalid) — React production-mode detection of Rules of Hooks violation internal state corruption
- **Passing suites**: S27M, S27M-2, S27N, S27N-2, S27O-3

## ROOT_CAUSE

**Classification: PRODUCT_ROUND_TRIP_DEFECT**

### Location
`apps/web/src/weread/ReadingArchiveDashboard.tsx`

### Defect
Commit `8979725` (S27O-2: Add dual period comparison dashboard) introduced a
`useMemo` call that violates React's Rules of Hooks:

- **Early return** at line 148: `if (!active) { return ...; }`
- **`useMemo(availableYearsForDualPeriod)`** at line 163: called AFTER the early return

Hook order when `active=false` (early return): hooks 1–4 called, hook 5 skipped.
Hook order when `active=true` (full render): hooks 1–5 called.

When the smoke does a notes→archive round-trip:
1. Archive click → `active=true` → hooks 1–5 called (bootstrap starts)
2. Notes click → `active=false` → hooks 1–4 called (hook 5 skipped)
3. Archive click (round-trip) → `active=true` → React internal state corrupted

React detects the inconsistent hook count and throws error #300.

### Why other suites passed
S27M, S27M-2, S27N, S27N-2, S27O-3 had NO round-trip section that toggled
`active` multiple times. They clicked the archive tab only once (no
unmount-remount cycle). The Rules of Hooks violation did not manifest on the
first mount.

## FIX_RESULT

### Why not a smoke-only fix
The defect lives in the product component `ReadingArchiveDashboard`, not in
the smoke scripts. The smoke correctly exercises the round-trip interaction
pattern that exposes the bug. No modification to smoke or test helpers can
prevent the product component from corrupting React's internal hook state.

### Product fix (S27P-0B hotfix)
Moved the three derived values (`yearsAsc`, `yearsDesc`,
`availableYearsForDualPeriod`) BEFORE the `if (!active)` early return. The
`useMemo` wrapper was removed because:

1. The `availableYearsForDualPeriod` computation is a pure `.map(...)` over
   an already-memoized `yearsAsc` array.
2. The `useMemo` provided no caching benefit that wasn't already there.
3. The hook-count mismatch between the two render paths is the root cause.

### Files changed
- `apps/web/src/weread/ReadingArchiveDashboard.tsx` — 3 lines moved, 1 useMemo removed
- `apps/web/src/weread/ReadingArchiveDashboard.test.ts` — 12 new hook-order tests
- `apps/web/src/weread/WereadCenter.test.tsx` (NEW) — 10 round-trip regression tests
- `reports/WEREAD_READING_ARCHIVE_HOOK_ORDER_HOTFIX.md` (NEW) — hotfix report

### Smoke scripts — preserved unchanged
- All 7 smoke scripts (`scripts/s27l-browser-smoke.cjs` etc.) are unchanged.
- No round-trip checks were skipped, relaxed, or deleted.
- The fatal-year fixture (FAILING_YEAR=2022, retry gate, recovery) is
  preserved exactly as written.

### Component-level rerender regression
12 tests in `ReadingArchiveDashboard.test.ts` under the
`S27P-0B hook-order regression` describe block:

1. inactive first render path is intact
2. no hook call appears after the `if (!active)` early return
3. all hooks in the parent component are called before the early return
4. hook identity is identical between the early-return path and the full-render path
5. yearsAsc / yearsDesc / availableYearsForDualPeriod computed BEFORE the early return
6. availableYearsForDualPeriod declaration no longer wrapped in useMemo
7. DualPeriodComparisonPanel still receives availableYears prop
8. dual-period wiring unchanged
9. real React render: active=false renders without hook-order error
10. no mid-render `active` mutation
11. no annual-review URL string constructed in the dashboard
12. no localStorage / sessionStorage / IndexedDB usage

### Center round-trip regression
10 tests in `WereadCenter.test.tsx` (NEW):

1. initial workspace is notes
2. the five workspace tabs cover notes / map / review / annual / archive
3. the archive tab click sets archiveActivated, which feeds ReadingArchiveDashboard's `active` prop
4. the ReadingArchiveDashboard has no hook call after the `if (!active)` early return
5. availableYearsForDualPeriod is declared BEFORE the early return
6. the round-trip path (notes → archive → notes → archive) is structurally reachable
7. the dashboard supports a real workspace toggle without throwing hook errors
8. availableYearsForDualPeriod is a pure computation (no useMemo)
9. the dashboard does NOT mutate active mid-render
10. the dashboard never writes to localStorage / sessionStorage / IndexedDB

## SMOKE_RESULT

### seven individual suites (post-deploy)
| Suite   | Result            |
|---------|-------------------|
| S27L    | exit=0, 38/38+bonus |
| S27L-2  | exit=0, 43/43     |
| S27M    | exit=0, 21/21     |
| S27M-2  | exit=0, 45/45     |
| S27N    | exit=0, 30/30     |
| S27N-2  | exit=0, 52/52     |
| S27O-3  | exit=0, 32/32     |

### sequential run 1 (post-deploy)
14/7 = 7 suites, all exit=0.

### sequential run 2 (post-deploy)
14/7 = 7 suites, all exit=0.

No browser / page / context crashes. No `Minified React error #300`. No
skipped round-trip checks. No leftover temp downloads in `/tmp`.

## REQUEST_SAFETY

| Suite   | before-retry | after-retry | delta | stability wait | explicit action after wait |
|---------|--------------|-------------|-------|----------------|---------------------------|
| S27M    | 1            | 2           | 1     | 3              | Top N 12→18 (cache miss on all years including failing-year) |
| S27M-2  | 1            | 2           | 1     | 3              | Top N 12→18 (cache miss on all years including failing-year) |
| S27N    | 1            | 2           | 1     | 2              | Top N 18→12 (cached subset — 0 new fetches) |
| S27N-2  | 1            | 2           | 1     | 3              | Top N 12→18 (cache miss on all years including failing-year) |

The 1→2 retry safety contract is unchanged. Stability wait does not grow
across runs.

### Per-suite stability-wait value clarification

The `stabilityAfter3.5s` reading is printed at the END of each smoke run,
AFTER all subsequent checks have executed. It is NOT the request count
immediately after the 3.5s wait — it is the request count after the wait
PLUS any subsequent explicit user actions that triggered network requests.

- **S27M / S27M-2 / S27N-2 — stabilityAfter3.5s=3**:
  After the 3.5s stability wait the smoke clicks the Top N dropdown from
  12 to 18. Top N is an independent cache dimension in
  `wereadReadingArchiveState.ts` (line 458: `TOP_BOOKS_CHANGED` keeps old
  Top N entries and adds the new one). Switching from 12 to 18 triggers a
  cache miss on every year, including the previously-cached failing-year.
  Each year gets exactly one fresh request, so `yearRequestCounts[FAILING_YEAR]`
  rises from 2 to 3.

- **S27N — stabilityAfter3.5s=2**:
  After the 3.5s stability wait the smoke clicks the Top N dropdown from
  18 back to 12. The 12-entry is already cached from the initial bootstrap
  (the smoke starts with `recent5` range and default Top N=12), so the
  cache hits and `yearRequestCounts[FAILING_YEAR]` stays at 2.

### No automatic retry

The 1→2 increment at the `retry-failed` click is the EXPLICIT user
action, not auto-retry. The 3.5s stability wait before any subsequent
Top N action proves there is NO auto-retry mechanism — if there were,
the failing-year count would climb during the 3.5s wait, not stay at 2.

The 3-suite value 3 is therefore:
- Explicit: Top N dropdown click (`weread-reading-archive-top-books-18`).
- Expected: 1 (initial) + 1 (retry click) + 1 (Top N switch) = 3.
- Not a stability-wait violation: stability-wait itself held at 2.
- Not auto-retry: 3.5s wait shows no growth.
- Deterministic across sequential runs: confirmed in run 1 + run 2.

## PRODUCT_BOUNDARY

- Product source changed: `ReadingArchiveDashboard.tsx` (3-line hook-order fix)
- API unchanged: apps/api not modified
- Docker: web container rebuilt and redeployed (bundle `index-DCzoq7-k.js`)
- Old bundle: `index-B54KwYcC.js`
- api/meilisearch unchanged
- Git: hotfix commit + tag `v0.20.2-weread-hook-order-hotfix`

## DOCUMENTATION_CORRECTION

No "奇数 (six years)" example exists in the S27O reports. The dual-period
default split example uses 6 years (`[2020..2025]`) which is an even count —
no correction needed.

## NEXT_STEP

`S27P-1 Reading Evolution Timeline Model` — UNBLOCKED. The hook-order
regression net guaranteed by the 12 new structural tests in
`ReadingArchiveDashboard.test.ts` and the 10 round-trip tests in
`WereadCenter.test.tsx` means any future commit that re-introduces a
post-conditional hook will be caught by `vitest run` before it reaches the
deployed bundle.
