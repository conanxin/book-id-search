# S27H — Personal Reading Map Report

STATUS: PASS

## Scope

* New private API endpoint `GET /api/private/weread/reading-map` returning aggregate-only data (no note text, no comment, no WeRead-internal IDs, no raw WeRead title/author).
* New "个人阅读地图" workspace tab inside `/weread`, with monthly notes timeline, top-books grid, contemporaneous-reading network, and historical overview cards.
* No new third-party dependencies. Pure CSS + inline SVG for all visualisation. No charting library added.
* Meilisearch uptime preserved — only API + web containers rebuilt.

## API_RESULT

| Check | Outcome |
|-------|---------|
| New module `apps/api/src/weread/private-reading-map.ts` compiles clean | PASS |
| 30+ pure-function tests (36 actually) | PASS — 36/36 |
| `apps/api/src/index.ts` typecheck | PASS |
| Live smoke `GET /api/private/weread/reading-map?months=24&topBooks=12` with valid token | PASS — 200, 9 overview keys, 24-month timeline, 12 top books, 3 contemporaneous links, `persisted=false`, `source=private_snapshot+public_catalog` |
| Live smoke with no token | PASS — 401 |
| Live smoke with wrong token | PASS — 403 |
| Live smoke with `months=7` | PASS — 400, message `months 必须是 6 / 12 / 24 / 36 之一。` |
| Live smoke with `topBooks=20` | PASS — 400, message `topBooks 必须在 6 到 18 之间。` |
| Public `/api/health` | PASS — `{"ok":true,"meili":{"status":"available"},"index":"books"}` |
| Public `/api/stats` | PASS — `numberOfDocuments: 5,115,734` |
| Public `/api/search?q=luxun` | PASS — 200, returns hits |
| Forbidden-key scan over live response body | PASS — no `wereadBookId / noteId / highlightId / chapterTitle / text / comment` substrings |
| Private title-field scan | PASS — no `wereadTitle / wereadAuthor / rawTitle / rawAuthor` substrings |

## FRONTEND_RESULT

| Check | Outcome |
|-------|---------|
| `apps/web/src/wereadPrivate.ts` adds `fetchWereadReadingMap(token, options)` | PASS — 7 client tests cover defaults, params, auth header, abort, error mapping, response shape, no-log |
| New module `apps/web/src/weread/wereadReadingMapModel.ts` exports deterministic helpers | PASS — 34 model tests |
| New component `apps/web/src/weread/ReadingMapDashboard.tsx` | PASS — renders overview, timeline SVG, network SVG, book grid, links list |
| `WereadCenter` adds the "笔记与 AI / 个人阅读地图" tab switcher with both panels kept mounted (hidden via `hidden` attribute) | PASS — 1 initial fetch only on activation |
| Top of dashboard displays fixed privacy notice | PASS |
| Range switch 6/12/24/36 re-fetches | PASS |
| `topBooks` switch 6/12/18 re-fetches | PASS |
| Token clear aborts in-flight request and resets dashboard state | PASS |
| CSS additions in `apps/web/src/styles.css` cover tabs, dashboard, overview, timeline, network, book grid, links, empty, error | PASS |
| Vite production build | PASS — 84 modules, no warnings about source code |

## PRIVACY_RESULT

| Boundary | Outcome |
|----------|---------|
| No note text / comment returned by API | PASS — response shape has no `text` / `comment` / `markedText` field |
| No WeRead-internal IDs returned (`wereadBookId` / `noteId` / `highlightId` / `chapterTitle`) | PASS — verified over live response |
| No raw WeRead title / author | PASS — public title / author are read from Meilisearch `books` only; failure fallback is `书目 ${catalogId}` with empty ancillary fields |
| No call to `/api/search` | PASS — endpoint uses `index.getDocument(catalogId)` directly |
| No MiniMax / external AI call | PASS — dashboard has zero AI invocation |
| No write to Meilisearch (settings / index / documents) | PASS — Meilisearch uptime unchanged (still 4 weeks at time of report) |
| No persistence of reading-map data | PASS — `meta.persisted = false`; nothing written to disk, database, localStorage, or sessionStorage |
| API does not log request body / response body / token / seed text | PASS — log scan found only the boot message |
| Web access log contains `/api/private/weread/reading-map` | PASS (negative) — no entries (nginx private access_log is off as per spec) |
| No new dependencies | PASS — `package.json` unchanged |
| `.env` / `private-data` / `apps/web/dist` untouched | PASS — git status confirms |
| No Caddy / DNS / nginx private access_log / ICP / 公安备案 changes | PASS — not modified |

## REGRESSION_RESULT

| Check | Outcome |
|-------|---------|
| Full `npx vitest run` (42 test files, 838 tests) | PASS — 838 passed / 0 failed |
| `tsc -p apps/api/tsconfig.json --noEmit` | PASS — no errors |
| `tsc -p apps/web/tsconfig.json --noEmit` | PASS — no errors |
| `tsx scripts/weread/validate-weread-snapshot.ts --dir samples/weread` | PASS — STATUS=PASS |
| `MEILI_HOST=http://127.0.0.1:7700 tsx scripts/verify.ts` | PASS — numberOfDocuments=5,115,734, STATUS=PASS |
| `NO_PROXY="*" tsx scripts/search-quality-regression.ts` | PASS — 17 PASS / 0 WARN / 0 FAIL |
| `apps/web` Vite build | PASS — built in 236 ms, no warnings about source |
| Browser smoke (puppeteer + synthetic request interception) | PASS — 20/20 (tab switcher rendered, default panel visible, switch-on-demand fetch, range re-fetch, overview/timeline/network/book-grid/links rendered, node → `/books/:catalogId`, no forbidden text outside disclosure, notes workspace preserved on tab switch, dashboard cleared on token clear, ICP footer still present, no horizontal overflow at 1440 or 360) |

## DEPLOY_RESULT

| Check | Outcome |
|-------|---------|
| `sudo docker compose up -d --no-deps --build api web` | PASS — api-1 + web-1 fresh Up; meilisearch-1 uptime 4 weeks preserved |
| `sudo docker compose logs --tail=120 api web` | PASS — api shows only boot message; web shows only `/weread` SPA GETs and `/api/health`/`/api/stats`/`/api/search` from curl, no private reading-map log line (private access_log disabled per spec) |
| Live counts-only smoke test | PASS — see API_RESULT rows |
| Public endpoints still healthy | PASS — health=available, docs=5,115,734, search returns hits |

## REPO_RESULT

* Modified (tracked): `README.md`, `apps/api/src/index.ts`, `apps/web/src/styles.css`, `apps/web/src/weread/WereadCenter.tsx`, `apps/web/src/wereadPrivate.test.ts`, `apps/web/src/wereadPrivate.ts`, `docs/WEREAD_CENTER.md`, `docs/WEREAD_PRIVATE_OVERLAY_API.md`.
* New (tracked): `apps/api/src/weread/private-reading-map.ts`, `apps/api/src/weread/private-reading-map.test.ts`, `apps/web/src/weread/ReadingMapDashboard.tsx`, `apps/web/src/weread/wereadReadingMapModel.ts`, `apps/web/src/weread/wereadReadingMapModel.test.ts`, `docs/WEREAD_READING_MAP.md`, `scripts/s27h-browser-smoke.cjs`, this report.
* Untracked-but-not-committed (per spec): `progress/`, `reports/screenshots/` (pre-existing scaffolding from earlier sessions, not part of this delivery).
* `package.json` unchanged.
* `apps/web/dist/` ignored by `.gitignore`.
* No commits made yet at the time of this report — see NEXT_STEP for the actual tag push.

## LIMITATIONS

* Only matched books (i.e. books with a confirmed WeRead → public catalogId mapping) appear in the top-books grid and the contemporaneous-reading network. Unmatched notes contribute only to timeline counts and the high-level `notesCount`.
* Contemporaneous-reading edges describe calendar overlap only, not semantic similarity. They carry no embeddings / topic signal.
* 24-edge cap on the network — for very active histories, weaker edges are silently dropped.
* The dashboard never re-requests the public metadata for books that fail Meili lookup (the response falls back to `书目 ${catalogId}`). If a user wants to refresh that fallback they need to clear and re-enter their token.
* The privacy notice string is fixed (no i18n). It is rendered in Chinese to match the rest of `/weread`.

## NEXT_STEP

* S27H-2: session theme overlay — extend the dashboard to surface the user's currently-loaded AI summary themes alongside the reading map (no new AI call, only read from the already-loaded `summarizePrivateNotes` response stored in component state).
* 公安备案页脚 continues to be held per user choice until further notice.

---

End of S27H report.