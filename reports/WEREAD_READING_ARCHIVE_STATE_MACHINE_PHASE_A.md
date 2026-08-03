# S27L-STATE-MACHINE-REBUILD Phase A — Reading Archive State Machine

STATUS: PASS

SCOPE
- Pure client-side state machine for the ReadingArchiveDashboard
  archive / bootstrap / cache / failure / retry concerns.
- No React, no DOM, no fetch, no AbortController, no token persistence.
- No production component integration (ReadingArchiveDashboard,
  WereadCenter, browser smoke, apps/api untouched).
- No deployment, no release tag.

INVARIANTS IMPLEMENTED

| Invariant | Mechanism |
|---|---|
| Bootstrap source is the real response | `BOOTSTRAP_SUCCEEDED` requires finite integer `selectedYear`; `availableYears` is normalized (dedupe, descending); `selectedYear` must appear in `availableYears` (else set to `null`); NaN keys never enter `cache`/`progress`. |
| No `requestedAnnualReviewYear` concept | The state machine has no field by that name; only `bootstrap.selectedYear` (derived from the response) and `view.{range,topBooks}`. |
| Cache retention across range switches | `RANGE_CHANGED` mutates only `view.range`; `cache` and `requests` are preserved. Round-trip `recent5 → all → recent5` keeps every cached key. |
| Top N key isolation | `TOP_BOOKS_CHANGED` mutates only `view.topBooks`; old Top N cache keys are kept; switching back re-hits cache. |
| Failure persistence within slice | `selectArchiveFailedKeys` returns errors only for currently-visible keys, but the underlying `requests[k]` record persists across range switches. |
| Explicit retry required | `selectArchiveRequestsToStart` skips `error` keys; `YEAR_RETRY_REQUESTED` flips `error` (and stale `pending`) back to `idle`. |
| Stale-response handling | Each action that touches `bootstrap` or a per-key `request` checks `requestId` against the current one and is ignored on mismatch. |
| Max concurrency 2 | `MAX_ARCHIVE_CONCURRENCY = 2`; `selectArchiveRequestsToStart` caps the queue. |
| Stable order | The queue is sorted by ascending year so the user gets the oldest visible year first. |
| `TOKEN_RESET` invalidates in-flight | `epoch` increments; `bootstrap/cache/requests` wiped; `view` reset to defaults; any subsequent stale success/failure (matching the old requestId) is silently ignored. |

ACTIONS (10)

`TOKEN_RESET`, `BOOTSTRAP_STARTED`, `BOOTSTRAP_SUCCEEDED`,
`BOOTSTRAP_FAILED`, `RANGE_CHANGED`, `TOP_BOOKS_CHANGED`,
`YEAR_REQUEST_STARTED`, `YEAR_REQUEST_SUCCEEDED`,
`YEAR_REQUEST_FAILED`, `YEAR_RETRY_REQUESTED`.

SELECTORS (8)

`selectArchiveVisibleYears`, `selectArchiveRequiredKeys`,
`selectArchiveCachedResponses`, `selectArchiveFailedKeys`,
`selectArchiveRequestsToStart`, `selectArchiveLoadedKeys`,
`hasArchiveBootstrapData`, `archiveMachineDebugSnapshot`.

SCHEDULER

`selectArchiveRequestsToStart(state, maxConcurrency=2)` returns
the next batch of cache keys to fetch. It picks keys with status
`idle` (or no record at all) in stable ascending-year order,
skipping `cached` / `pending` / `success` / `error`.

The caller (Phase B React adapter) is responsible for:
- generating fresh `requestId`s,
- wiring the actual fetch,
- mapping responses to actions,
- feeding the result back through `reduceReadingArchiveState`.

STALE-RESPONSE HANDLING

Every transition that touches per-request state is gated on the
incoming `requestId` matching the current one. This covers:

- bootstrap success/failure after `TOKEN_RESET`
- per-key success/failure after the key has been retried with a
  new `requestId`
- per-key success/failure issued in the wrong order

Out-of-order arrival patterns (A pending → B success → A failure)
are correctly absorbed: A's old requestId is rejected.

OUTPUT SAFETY

`archiveMachineDebugSnapshot` exposes keys + counts + bootstrap
summary only. The reducer's exhaustive `default` branch enforces
type-level coverage. State JSON output is `JSON.stringify`-safe:
no `NaN` / `Infinity`, no token, no `catalogId`, no note text, no
comment, no wereadBookId, no AI summary.

TEST_RESULT

- Targeted (new file `apps/web/src/weread/wereadReadingArchiveState.test.ts`):
  **48 / 48 passed**
  (46 race / invariant / scheduler / output-safety scenarios + 2
  extra `TOKEN_RESET` integration tests + 3 type-guard assertions).
- Full vitest: **1457 / 1457 passed** (1409 baseline + 48 new).
- Web `tsc --noEmit`: PASS.

INTEGRATION_BOUNDARY

```
git diff -- apps/web/src/weread/ReadingArchiveDashboard.tsx \
              apps/web/src/weread/WereadCenter.tsx \
              scripts/s27l-browser-smoke.cjs
(empty)
```

- ReadingArchiveDashboard.tsx: unchanged
- WereadCenter.tsx: unchanged
- browser smoke: unchanged
- apps/api: no diff
- package.json: no diff
- no deployment
- no tag
- no README edit

PRIVACY_RESULT

- state machine has no `token` field and never reads `token`
- no `requestedAnnualReviewYear` field
- no `note text` / `comment` field
- no `wereadBookId` / `catalogId` / private identifier field
- cache values are typed as opaque `WereadAnnualReviewResponse`;
  reducer never reads fields beyond `selectedYear` /
  `availableYears` of bootstrap response
- synthetic test fixtures use empty `topBooks` arrays and `null`
  timestamps; no real annual-review data is referenced

REPO_RESULT

- Branch: `s27l-state-machine-rebuild` (created from `71108eb`)
- New files:
  - `apps/web/src/weread/wereadReadingArchiveState.ts`
  - `apps/web/src/weread/wereadReadingArchiveState.test.ts`
  - `reports/WEREAD_READING_ARCHIVE_STATE_MACHINE_PHASE_A.md` (this file)
- main / master: untouched
- HEAD on branch: `71108eb` (no commits yet)
- working tree: 2 untracked + 0 modified

NEXT_STEP

S27L-STATE-MACHINE-REBUILD Phase B — React adapter integration:
- `ReadingArchiveDashboard.tsx` becomes a thin presenter that
  holds the machine state via `useReducer`.
- `useEffect`s become a single scheduler loop that dispatches
  actions based on selectors.
- `token` / `fetchOneYear` / abort logic stays in the component,
  not in the machine.
- 38/38 smoke gate only attempted after Phase B reaches an
  internal unit-test PASS.