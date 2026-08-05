# S27P-3 Reading Evolution Timeline Markdown Export — Phase C Report

## STATUS

**PASS**

S27P-3 (Browser-local Reading Evolution Timeline Markdown Export) has completed local validation, security scanning, and regression. The feature remains strictly browser-local: it consumes the existing `WereadReadingEvolutionTimeline` pure model, generates a deterministic Markdown document, and triggers a download without any network request, storage write, or URL change.

## MARKDOWN_SCOPE

Exported Markdown includes:

- Document title and generation metadata (range label, Top N limit, loaded year count, failed year count, export timestamp).
- Timeline overview: first/last year, total records, active months, matched records, matched books, transition/milestone/gap counts.
- Milestones: first year, latest year, year gaps, statistical shifts (descriptive only, no causal inference).
- Per-year nodes: year metrics, Top N public catalog books, and links to `/books/:catalogId`.
- Adjacent-year transitions: metric deltas, significance score, overlap ratio, continued/entered/left book lists.
- Method note explaining that the output is a statistical summary and does not explain causes.

Excluded from Markdown:

- Note text, note comments, private book IDs, note IDs, highlight IDs, chapter titles.
- Token, Authorization headers, raw JSON snapshots, cache/request debug info.
- AI summaries, themes, and any psychological / personality / growth / decline language.

## STRUCTURE_RESULT

| Section | Result |
|--------|--------|
| Title (`# 年度统计演变时间线`) | PASS |
| Metadata | PASS |
| Timeline overview | PASS |
| Milestones (`## 时间线标记`) | PASS |
| Year nodes (`## 年度节点`) | PASS |
| Top N books per year | PASS |
| Transitions (`## 相邻年度过渡`) | PASS |
| Metric differences | PASS |
| Significance labels | PASS |
| Overlap ratio | PASS |
| Continued / entered / left books | PASS |
| Method note (`## 方法说明`) | PASS |

## PARTIAL_EMPTY_SINGLE_RESULT

Handled by unit tests and Markdown model branches:

- **Empty archive**: emits an empty-archive section, no year/transitions.
- **Single loaded year**: emits single-year footnote, no transition section.
- **Partial failures**: failed years are listed in metadata and a footnote; the timeline still renders for successfully loaded years.

Local smoke uses a normal multi-year fixture; partial/empty/single paths are covered by `wereadReadingEvolutionMarkdown.test.ts`.

## DOWNLOAD_RESULT

| Item | Result |
|------|--------|
| Filename prefix | `weread-reading-evolution` |
| Filename date suffix | `YYYYMMDD.md` |
| MIME type | `text/markdown; charset=utf-8` |
| Download trigger | `Blob` + object URL + anchor `download` attribute |
| File cleanup after smoke | `/tmp/s27p3-downloads` removed |

## HOOK_ORDER_REGRESSION

| Check | Result |
|-------|--------|
| Parent `ReadingEvolutionTimelinePanel` remains zero-hook | PASS |
| Export child owns its own `useState` + `useEffect` hooks | PASS |
| Hook order stable across renders (no conditional hooks) | PASS |
| Active round-trip (archive tab open → data load → export) | PASS |
| React error #300 | 0 |

## STATE_MACHINE_REGRESSION

| Check | Result |
|-------|--------|
| Archive reducer / scheduler / cache / retry untouched | PASS |
| Export triggers 0 extra annual-review requests | PASS |
| Pre-export request count stable | PASS |
| 0 non-private POST requests during export | PASS |
| 0 external requests during export | PASS |

## PRIVACY_RESULT

| Check | Result |
|-------|--------|
| No `noteId` / `wereadBookId` / `highlightId` / `chapterTitle` in export | PASS |
| No `Authorization` / `token=` in export | PASS |
| No AI summary / themes in export | PASS |
| No raw JSON structure in export | PASS |
| No cache/request debug info in export | PASS |
| No inference forbidden words in export | PASS |
| No `localStorage` / `sessionStorage` / `IndexedDB` writes | PASS |
| No `pushState` / `replaceState` | PASS |
| Network: only interceptable synthetic private API calls during smoke | PASS |

## TEST_RESULT

| Suite | Result |
|-------|--------|
| Targeted Vitest (Timeline + Markdown + Panel + ExportAction) | 220 passed / 0 failed |
| Full Vitest | 2236 passed / 0 failed |
| `tsc -p apps/web/tsconfig.json --noEmit` | PASS (0 errors) |
| Vite build | PASS |
| `scripts/verify.ts` | PASS (17 checks, docs=5,115,734) |
| `scripts/search-quality-regression.ts` | 17 PASS / 0 WARN / 0 FAIL |
| Local browser smoke (`scripts/s27p3-browser-smoke.cjs`) | 47/47 PASS |

## PRODUCT_BOUNDARY

The following boundaries were respected:

- `apps/api` unchanged.
- No `package.json` changes.
- No new dependencies.
- Timeline model algorithms, thresholds, and enum semantics unchanged.
- `archive` reducer, scheduler, cache, and retry unchanged.
- `fetchWereadAnnualReview` not called from export path.
- No AI or related-books invocation.
- No `localStorage` / `sessionStorage` / `IndexedDB` writes in production code.
- No URL changes.
- Markdown is downloaded, not uploaded.
- No raw archive/timeline JSON output.
- No `innerHTML` / `dangerouslySetInnerHTML`.
- No new hooks added to `ReadingArchiveDashboard` or `ReadingEvolutionTimelinePanel` parent.

## KNOWN_LIMITATIONS

- The export child uses `useEffect` to reset status on key change rather than a parent-provided `key` prop. This was evaluated and retained because tests pass and the reset key is derived deterministically from panel inputs.
- Smoke script uses synthetic annual-review fixtures and must run against a local Vite preview with `VITE_API_BASE_URL` pointing to `127.0.0.1` so requests are intercepted rather than treated as external.

## NEXT_STEP

**S27P-4 — Reading Evolution Timeline Release Closeout**

- Final deploy tag decision (no deploy / no tag requested for this commit).
- Archive Phase C report alongside prior phase reports.
- Optional README / changelog update if required by release policy.
