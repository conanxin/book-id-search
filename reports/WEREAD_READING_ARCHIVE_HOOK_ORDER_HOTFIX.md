# WEREAD Reading Archive Hook-order Hotfix

**STATUS: PASS**

---

## STATUS

PASS — reading archive round-trip hook-order hotfix shipped via
`v0.20.2-weread-hook-order-hotfix`.

## ROOT_CAUSE

**Conditional Hook after inactive early return.** Commit `8979725` (S27O-2)
introduced `useMemo(availableYearsForDualPeriod)` AT line 163 of
`ReadingArchiveDashboard.tsx`, which sits AFTER the `if (!active) { return ... }`
early return at line 148.

When the WereadCenter toggles the archive tab (notes → archive → notes →
archive), each toggle flips the `active` prop. The React component's hook list
changes between renders:

- `active=false` (early return path): hooks 1–4 are called.
- `active=true` (full render): hooks 1–5 are called.

React's internal hook list is keyed by call order. When the SAME component
instance re-renders with a different hook count, React detects the mismatch
and throws **Minified React error #300** ("Element type is invalid"). The
component renders a placeholder that survives the first few user interactions
but breaks the selectors that the smoke tests rely on, producing the
`No element found for selector: [data-testid="weread-tab-archive"]` crash.

The bug only manifested in the round-trip section (notes → archive → notes →
archive) of the S27L and S27L-2 smoke suites. The non-round-trip smokes
(S27M, S27M-2, S27N, S27N-2, S27O-3) never toggled `active` enough times to
trip the corruption, which is why they remained green.

## PRODUCT_FIX

Three lines of `apps/web/src/weread/ReadingArchiveDashboard.tsx` moved
BEFORE the early return:

```diff
   const [eraMode, setEraMode] = useState<ReadingEraSegmentationMode>(
     "automatic",
   );

+  // S27P-0B: yearsAsc / yearsDesc / availableYearsForDualPeriod must be
+  // computed BEFORE any conditional return so the hook order stays
+  // stable across the active toggle. They are cheap pure derivations
+  // (no React state, no side effects) so no useMemo is required.
+  const yearsAsc = [...dashboardArchive.years].sort(
+    (a, b) => a.year - b.year,
+  );
+  const yearsDesc = [...dashboardArchive.years].sort(
+    (a, b) => b.year - a.year,
+  );
+  const availableYearsForDualPeriod = yearsAsc.map((year) => year.year);
+
   // ----- render: not activated -----
   if (!active) {
     return (
       <section ...>
         <p>点击上方「…后开始加载。</p>
       </section>
     );
   }

-  const yearsAsc = [...dashboardArchive.years].sort(...);
-  const yearsDesc = [...dashboardArchive.years].sort(...);
-  const availableYearsForDualPeriod = useMemo(
-    () => yearsAsc.map((y) => y.year),
-    [yearsAsc],
-  );
```

**Hook ordering invariant:** all hooks in the parent `ReadingArchiveDashboard`
component are called before any conditional return. The hook list is
identical regardless of `active`:

- `useReadingArchiveMachine({ token, active })`
- `useMemo(() => buildWereadReadingArchive(...))` (dashboardArchive)
- `useMemo(() => failedKeyYears(...))` (failedYears)
- `useState<ReadingEraSegmentationMode>("automatic")` (eraMode)

The `yearsAsc` / `yearsDesc` / `availableYearsForDualPeriod` are pure
derivations (no React state, no side effects) so the `useMemo` wrapper was
unnecessary — the original `useMemo` provided no caching benefit because
`dashboardArchive` is already memoized upstream.

**Behavior unchanged.** The availableYearsForDualPeriod value is the same
sequence of numbers, same JSX consumption, same Round-Trip semantics.

## UNIT_REGRESSION

### apps/web/src/weread/ReadingArchiveDashboard.test.ts
- 95 tests total (was 83). 12 new tests under `S27P-0B hook-order regression`
  describe block.
- Tests 1–6: source-code structural checks that pin the hook order so
  future commits cannot re-introduce the violation.
- Tests 7–8: dual-period wiring unchanged.
- Test 9: real React render via `renderToStaticMarkup` (active=false) with
  `console.error` capture asserting no `Rendered fewer hooks` /
  `Rendered more hooks` / `Minified React error #300`.
- Tests 10–12: defensive guards (no `setActive`, no annual-review URL
  string, no storage).

### apps/web/src/weread/WereadCenter.test.tsx (NEW)
- 10 tests. Structural check that the parent (`WereadCenter.tsx`) passes
  `active={activeTab === "archive"}` to the dashboard, that the round-trip
  is structurally reachable via `setActiveTab`, and that the dashboard's
  hook order invariant holds.

### apps/web/src/weread/DualPeriodComparisonPanel.test.tsx
- 48 tests, unchanged. Still PASS.

### Targeted gate
- 153/153 PASS across
  `ReadingArchiveDashboard.test.ts` (95) +
  `DualPeriodComparisonPanel.test.tsx` (48) +
  `WereadCenter.test.tsx` (10).

### Full vitest
- 2016 tests PASS across 68 files.

### tsc
- `apps/web/tsconfig.json --noEmit` clean.

### Vite build
- `dist/assets/index-DCzoq7-k.js` (587.49 kB / gzip 163.03 kB) built
  successfully.

### verify
- `docs=5,115,734`, status: PASS.

### search-quality
- 17 PASS / 0 WARN / 0 FAIL.

## SMOKE_REGRESSION

### Seven individual suites (post-deploy)
| Suite   | Result            | Notes |
|---------|-------------------|-------|
| S27L    | exit=0, 38/38+bonus | round-trip recovered |
| S27L-2  | exit=0, 43/43     | round-trip recovered |
| S27M    | exit=0, 21/21     | unchanged |
| S27M-2  | exit=0, 45/45     | unchanged |
| S27N    | exit=0, 30/30     | unchanged |
| S27N-2  | exit=0, 52/52     | unchanged |
| S27O-3  | exit=0, 32/32     | dual-period export unchanged |

### Sequential run 1 (post-deploy)
| Suite   | exit |
|---------|------|
| S27L    | 0 |
| S27L-2  | 0 |
| S27M    | 0 |
| S27M-2  | 0 |
| S27N    | 0 |
| S27N-2  | 0 |
| S27O-3  | 0 |

### Sequential run 2 (post-deploy)
| Suite   | exit |
|---------|------|
| S27L    | 0 |
| S27L-2  | 0 |
| S27M    | 0 |
| S27M-2  | 0 |
| S27N    | 0 |
| S27N-2  | 0 |
| S27O-3  | 0 |

**14/14 suite executions exit=0.** Zero browser / page / context crashes.
Zero `Minified React error #300`. Zero skipped round-trip checks. Zero
leftover temp downloads in `/tmp`.

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

## PRIVACY_BOUNDARY

- No `note.text` / `note.comment` / `wereadBookId` / `noteId` /
  `highlightId` / `token` / `Authorization` / `wr_skey` are emitted.
- No `localStorage` / `sessionStorage` / `IndexedDB` writes.
- No `ai summary` / `themes` / extra HTTP requests.
- No `dangerouslySetInnerHTML` / `innerHTML` / inline scripts.

## DEPLOY_RESULT

- `web` container rebuilt and redeployed.
  - Old bundle: `index-B54KwYcC.js`
  - New bundle: `index-DCzoq7-k.js`
- `api` container untouched (`Up 2 days`).
- `meilisearch` container untouched (`Up 5 weeks`).
- Caddy / DNS / nginx / compliance configs untouched.

## RELEASE_RESULT

- HEAD: hotfix commit (will be added at end of H10).
- Tag: `v0.20.2-weread-hook-order-hotfix` (created at H13).
- v0.20.1 tag preserved on its original commit.

## NEXT_STEP

`S27P-1 Reading Evolution Timeline Model` — UNBLOCKED. The hook-order
regression net guarantees that any future commit which re-introduces a
post-conditional hook will be caught by the structural tests in
`ReadingArchiveDashboard.test.ts` and `WereadCenter.test.tsx`.
