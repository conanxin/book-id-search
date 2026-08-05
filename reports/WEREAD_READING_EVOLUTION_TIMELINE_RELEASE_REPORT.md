# S27P-4B — Reading Evolution Timeline Deterministic Release Report

## 1. STATUS

PASS

Release tag: `v0.21.1-weread-reading-evolution-timeline-markdown`
Release commit: `7a28ebfb4bbf837c68fb6e3be8bac82b0fe1fc3a`
Candidate image: `book-id-search-web:7a28ebfb4bbf837c68fb6e3be8bac82b0fe1fc3a`
Candidate image ID: `sha256:03053c540ccb1d58abe03d00f21cdfbdd7beb45f5bedf2526696f0d55959d9c7`
Running image ID: `sha256:03053c540ccb1d58abe03d00f21cdfbdd7beb45f5bedf2526696f0d55959d9c7`
Identity match: yes
Rollback executed: no

## 2. RELEASE

- Version string: `v0.21.1-weread-reading-evolution-timeline-markdown`
- Scope: S27P Reading Evolution Timeline + S27P-2 Browser-local Markdown Export.
- Product code changes: none; the release is a documentation + provenance + deployment tag around the already merged S27P implementation.
- Candidate image was built once and deployed unchanged (`build-once / deploy-same-image`).
- v0.20.2 tag `v0.20.2-weread-hook-order-hotfix` remains unchanged and available for rollback.

## 3. MODEL_RESULT

- `wereadReadingEvolutionTimeline.ts` unit tests: all deterministic archive-to-timeline transformations pass.
- Adjacent-year metric differences, significance thresholds, and Top N book diff grouping (continued / entered / left) are computed in browser memory only.
- No private ID, note text, or AI summary is read by the model.
- Model does not persist state (`meta.persisted = false`).

## 4. FRONTEND_RESULT

- `ReadingEvolutionTimelinePanel.tsx` renders inside the existing Reading Archive dashboard as a new panel.
- Verified UI sections: header, completeness notice, scope line, milestones, year articles, transitions, metric differences, book diff groups (continued / entered / left).
- React error #300 count: 0 in all smoke runs.
- No horizontal overflow at 1440px desktop and 360px mobile.
- Hook order regression check: Timeline parent component and `ExportAction` component mount/unmount without hook count changes across smoke runs.
- Dashboard round-trip between archive and timeline panels preserves state and does not re-fetch `annual-review` data.

## 5. MARKDOWN_RESULT

- `ReadingEvolutionTimelineExportAction.tsx` + `wereadReadingEvolutionMarkdown.ts` generate a local Markdown file.
- Filename pattern: `weread-reading-evolution-<first>-to-<latest>-YYYYMMDD.md` (or `...-empty-YYYYMMDD.md` when no years have data).
- MIME: `text/markdown;charset=utf-8`.
- Verified Markdown sections: title, metadata, privacy/explanation blockquote, timeline overview, milestones, yearly details, adjacent-year metric differences, significance markers, Top N book diffs (continued/entered/left), method notes.
- Exported file contains no `noteId`, `wereadBookId`, `highlightId`, token, AI summary, raw JSON, or cache/request debug info.
- Export action triggers 0 extra `annual-review` requests, 0 non-private POST requests, 0 external requests.

## 6. HOOK_ORDER_REGRESSION

- Timeline parent: zero-hook change (no new stateful hooks introduced that would affect sibling panels).
- `ExportAction`: hooks stable across mount, export click, and unmount.
- Dashboard round-trip (switch to another workspace tab and back): pass; archive + timeline state preserved.
- React error #300: 0 across local candidate smoke and all production smoke runs.

## 7. REQUEST_SAFETY

Measured from S27L long-term archive smoke (failing-year retry harness, which exercises the same `annual-review` cache and retry mechanism used by the timeline panel):

- Failing-year requests before retry: 1
- Failing-year requests after retry: 2
- Retry delta: 1
- Stability wait (3.5 s after retry): 2
- No request storm, no auto-retry, no extra cache fetches when switching range or Top N.
- Timeline panel itself reuses archive cache; no additional `annual-review` requests are issued when the timeline is shown or when the Markdown export is triggered.

## 8. PRIVACY_RESULT

- Timeline computation uses only `WereadAnnualReviewResponse` descriptive statistics and confirmed public `catalogId` metadata.
- No note text, comment, chapter title, highlight text, AI summary, token, `wereadBookId`, `noteId`, or `highlightId` is read or rendered.
- No `localStorage` / `sessionStorage` / `IndexedDB` / server write occurs.
- Markdown export does not include real book titles, private IDs, or catalog relationships beyond public title/author/publisher/year.
- UI displays fixed privacy and scope disclaimers.

## 9. REGRESSION_RESULT

| Check | Result |
|-------|--------|
| vitest | 2236 / 2236 PASS (72 files) |
| tsc (apps/web) | PASS (no emit) |
| host vite build | PASS; candidate bundle `index-DUh-n4Eh.js` / `index-CoQPhCit.css` |
| verify | docs = 5,115,734, Meili available, no indexing |
| search-quality | 17 PASS / 0 WARN / 0 FAIL |
| Local S27P-3 smoke | 47 / 47 PASS |
| Production S27L smoke | 38 + BONUS PASS / 0 FAIL |
| Production S27L-2 smoke | 43 / 43 PASS |
| Production S27M smoke | 21 / 21 PASS |
| Production S27M-2 smoke | 45 / 45 PASS |
| Production S27N smoke | 30 / 30 PASS |
| Production S27N-2 smoke | 52 / 52 PASS |
| Production S27O-3 smoke | 32 / 32 PASS |
| Production S27P-3 smoke | 47 / 47 PASS |
| Critical second smoke (S27L, S27L-2, S27O-3, S27P-3) | 4 / 4 PASS |

## 10. DEPLOY_RESULT

- Candidate image built once: `book-id-search-web:7a28ebfb4bbf837c68fb6e3be8bac82b0fe1fc3a` (`sha256:03053c...`).
- Deploy performed with `--no-build` using the same candidate image.
- Running web container image ID matches candidate image ID: yes.
- Live production HTML references `index-DUh-n4Eh.js` / `index-CoQPhCit.css`; both SHA-256 match the candidate manifest.
- Live bundle is not the v0.20.2 bundle (`index-DCzoq7-k.js` / `index-CwoiBo41.css`).
- API container uptime: unchanged (~2 days).
- Meilisearch container uptime: unchanged (~5 weeks).
- Caddy / DNS / nginx / compliance configuration untouched.
- Note: the first `deploy-web-release-candidate.sh` invocation failed because the script uses `sudo` internally, which dropped the `BOOK_ID_SEARCH_WEB_IMAGE` environment variable and resolved the compose image to the default `book-id-search/web:dev`. The release was completed by redeploying with `sudo -E BOOK_ID_SEARCH_WEB_IMAGE=<candidate> docker compose up -d --no-deps --no-build web`, which preserved the variable and produced the correct image identity match. The candidate image itself was never rebuilt.

## 11. LIMITATIONS

- Maximum 20 years, inherited from the long-term archive hard cap.
- Only adjacent-year differences are computed; no arbitrary multi-year aggregation or trend regression.
- Significance markers are based on fixed numerical thresholds, not statistical hypothesis testing.
- No theme / interest / reading-quality inference; UI explicitly states this.
- Empty or partially-failed archive years are skipped in adjacent comparisons.
- No new backend endpoint; timeline is entirely a frontend view over existing `annual-review` cache.

## 12. NEXT_STEP

S27Q — Long-term Reading Data Quality Audit.

Planned focus:

- Review annual-review fixture coverage for edge years (empty year, single-year archive, all-failed years).
- Audit archive cache invalidation under token change and component unmount.
- Evaluate whether deterministic Top N book diff thresholds need per-range calibration.
- Prepare release report archive and clean up temporary smoke download directories.
