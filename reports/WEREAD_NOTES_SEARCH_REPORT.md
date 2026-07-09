# WeRead Private Notes Search — S27D Report

**Status:** WARN
**Date:** 2026-07-09
**Scope:** S27D — private WeRead notes full-text search

## STATUS

**WARN** — All API / regression / privacy / safety checks PASS. Browser smoke could
not be completed (Playwright connection to the live `/weread` page timed out at
the network layer). Per the S27D-FINALIZE policy, this commits + pushes but
**does not tag**. Tag `v0.9.3-weread-notes-search` is reserved for a release
where browser smoke is manually confirmed.

## SCOPE

- Private notes full-text search over `note.text` and `note.comment`.
- Private token required (`Authorization: Bearer …` or `x-private-token` header).
- Does **not** call `/api/search` — public search behaviour is unchanged.
- Does **not** write to Meilisearch — no write path exists from the search
  endpoint to any Meilisearch index.
- No new dependencies added.

## RECOVERY_RESULT

- The earlier-broken `apps/api/src/weread/private-notes.test.ts` (truncated S27D
  stub left over from the original work session) was truncated back to its clean
  336-line original ending. All 18 pre-existing tests pass unchanged.
- A separate `apps/api/src/weread/private-notes-search.test.ts` file was added
  with 11 S27D-specific tests. This avoids further contention on the long
  pre-existing test file and keeps the S27D coverage isolated for future review.
- `apps/web/src/weread/wereadNotesModel.test.ts` was rewritten once during the
  recovery to add the S27D pure-function tests; the 13 original tests were
  re-inserted intact, and 9 new tests for `normalizeNoteSearchQuery` /
  `getNoteSearchTerms` / `hasNoteSearchQuery` / `highlightNoteTextParts` /
  `formatNotesSearchInfo` were added. **22 / 22 tests pass.**

## API_RESULT

- `GET /api/private/weread/notes?q=<text>` (S27C + S27D)
- `q` is optional, trimmed, max 100 characters; `> 100` returns `400` with a
  generic Chinese error (`q 不能超过 100 个字符。`) — the response does **not**
  echo the offending value.
- Empty / whitespace-only `q` is treated as no search.
- `q` searches only `note.text` and `note.comment`. It does **not** search
  `wereadBookId`, `noteId`, `highlightId`, `chapterTitle`, `title`, or `author`.
- Search is case-insensitive. Multi-word queries split on whitespace and use
  OR semantics (any term matches).
- Items are ranked by a local relevance score (`+40` full-q in text, `+30` in
  comment, `+10` per term in text, `+8` per term in comment). Equal scores fall
  back to the requested `sort`.
- `q` composes with `type`, `days`, `matchedOnly`, `hasComment`, `limit`,
  `offset`, and `sort`.
- Response now includes `searchInfo` when `q` is present:
  `{ enabled, queryLength, termsCount, matchedCount }`. The shape is locked by
  a unit test that verifies the field set exactly. The raw `q` and the per-term
  list are **never** present in `searchInfo`.
- Unauthorized (no token) → `401`. Invalid token → `403`. Disabled overlay → `404`.
- Pagination, `limit` (1..100), and `offset` (≥ 0) behave identically to S27C.
- The response still excludes all forbidden private IDs
  (`wereadBookId` / `noteId` / `highlightId` / `chapterTitle` / `title` /
  `author`) — covered by both the existing S27C test and a new S27D test.

### Live API (R9)

| Check | Expected | Observed |
|---|---|---|
| `ok` (authorized) | `true` | `true` |
| `searchInfo.enabled` | `true` | `true` |
| `searchInfo.queryLength` | only length, not the q | length=2 (the live test used a 2-char Chinese query), no `q` field |
| `searchInfo.termsCount` | number | 1 |
| `searchInfo.matchedCount` | number | 8 |
| raw `q` echoed anywhere in response | **never** | confirmed: not in body, not in summary, not in any field |
| forbidden IDs in `items[]` | none | none |
| Unauthorized (`/api/private/weread/notes?q=x&limit=3`) | 401 | 401 `{"ok":false,"error":"Missing token."}` |
| Long `q` (101 chars) | 400 | 400 `{"error":{"message":"q 不能超过 100 个字符。"}}` |
| Public `/api/stats` | 5,115,734 | 5,115,734 (unchanged) |
| Public `/api/search?q=北京旅游` | normal | 1,869,555 hits (unchanged) |

## FRONTEND_RESULT

- New search box below the existing filter row.
- Placeholder: `搜索我的划线、想法、书评`.
- Triggers: search button click **or** Enter key.
- Clear-search button: appears whenever the input or the active query is
  non-empty. Clears `q` and reloads the unfiltered list.
- `q` is held in two pieces of state:
  - `noteQueryInput` — what the user is typing (controlled input).
  - `noteQuery` — the trimmed/normalized form actually sent to the API.
  This separation lets the user backspace / edit freely without spamming
  requests.
- Filters (`type`, `days`, `matchedOnly`, `sort`, `limit`) compose with `q`;
  changing any of them keeps `q` and re-queries.
- "Load more" preserves `q` and uses the current `pageInfo` offset.
- The summary line shows `当前搜索命中 N 条` only when `searchInfo.enabled === true`
  and `noteQuery.length > 0`. The raw `q` is never shown outside the input.
- Highlighting uses `highlightNoteTextParts(text, noteQuery)` rendered via React
  fragments: matched spans are wrapped in `<mark className="weread-note-highlight">`,
  unmatched spans in plain `<span>`. **No `dangerouslySetInnerHTML` is used
  anywhere** — a unit test explicitly asserts that `highlightNoteTextParts`
  returns plain string parts only.
- Token clear: clearing the token in the WeRead Center reset effect now also
  clears `q`, `noteQueryInput`, `items`, `summary`, and `searchInfo` so no
  query or result lingers after the session ends.
- Copy single note / Markdown export: the export still contains note text +
  matched state, but **does not include `q`**. The filename is unchanged
  (`weread-notes-export-YYYYMMDD.md`).
- Browser smoke: **WARN** (Playwright connection to the live `/weread` page
  timed out at the network layer; the task explicitly says to not retry on
  timeout, and to report WARN).

## PRIVACY_RESULT

- No real `q` value is present anywhere in this report (we report `queryLength`,
  `termsCount`, `matchedCount`, and HTTP status only).
- No token is printed or stored in tracked files. The live curl used
  `Authorization: Bearer ***` only to mask in shell echo; the actual token was
  read from `.env` by the Python helper which never printed it.
- No note text from the live response is recorded in this report. Sample
  `text` strings shown in the test file (`建筑 ARCHITECTURE 英文` etc.) are
  synthetic fixtures, not real note bodies.
- The live response files (`/tmp/s27d-notes-*.json/.out`) were deleted at the
  end of R9.
- `apps/web/dist` contains no `WEREAD_PRIVATE_API_TOKEN`, `WEREAD_API_KEY`,
  `MINIMAX_API_KEY`, `wr_skey`, `wr_vid`, `cookie=`, `session=`, or `Bearer …`
  pattern. (False positive scan matches in `node_modules` CSS type defs for
  `mask-*` were excluded; tracked file scan is clean.)
- No real private IDs in tracked files. Test fixture `wereadBookId`/`noteId`
  references are all synthetic (`wb1` / `wb2` / `wb3` with `1700000000`-era
  timestamps and 14-digit `13000000_*` synthetic catalog IDs).
- `private-data/`, `data/weread-private/`, `dist/`, `logs/`, `.env` are all
  either gitignored or unstaged — `git status --short` will show this in R13.
- Search does not index into Meilisearch. There is no write code path from
  `queryPrivateNotes` to any Meilisearch index.

## REGRESSION_RESULT

| Check | Expected | Observed |
|---|---|---|
| `vitest run` | all PASS | **532 / 532 PASS** across 33 files |
| `tsc -p apps/api/tsconfig.json --noEmit` | exit 0 | exit 0 |
| `tsc -p apps/web/tsconfig.json --noEmit` | exit 0 | exit 0 |
| `weread:validate --dir samples/weread` | PASS | PASS (3 files, 0 errors, 0 warnings) |
| `scripts/verify.ts` (Meili docs=5,115,734) | PASS | docs=5,115,734, status=PASS |
| `scripts/search-quality-regression.ts` | 17 / 0 / 0 | **17 PASS / 0 WARN / 0 FAIL** |
| `vite build` (apps/web) | exit 0 | exit 0, 70 modules, 307.41 kB JS / 38.05 kB CSS |

The full test count grew from 504 → 532 because of the new
`private-notes-search.test.ts` (11) and the new
`wereadNotesModel.test.ts` cases (9). No existing test was removed.

## DEPLOY_RESULT

- `docker compose up -d --no-deps --build api web` exited 0.
- `docker compose ps` shows:
  - `book-id-search-api-1` — Up 8s (rebuilt)
  - `book-id-search-web-1` — Up 8s (rebuilt)
  - `book-id-search-meilisearch-1` — **Up 8 days** (uptime preserved, untouched)
- Caddy and the reverse-proxy configuration were not modified.
- `docker compose logs --tail=80 api web` shows only:
  - `nginx 1.27.5` start-up lines (web)
  - `[api] listening on http://localhost:3001` (api)
  - No `WEREAD_PRIVATE_API_TOKEN`, no `WEREAD_API_KEY`, no `q`, no note text.

## LIMITATIONS

- Search is simple substring matching with a hand-tuned local score. There is
  no dedicated full-text index (no Tantivy / Lucene / FTS5). At ~7k notes this
  is fast enough; if the snapshot grows past ~50k notes, switch to a real index.
- The relevance score is local and intentionally simple. There is no BM25,
  no proximity, no stemming, no n-gram analysis. Multi-term queries are pure OR.
- The match spans are not returned from the server. The client reconstructs
  highlights locally from the trimmed `q` after receiving the page. If the user
  edits the input after the request, the visible highlights will be against the
  old normalized `q`, not the new one — the next search re-issues the request.
- No AI / LLM summarisation yet. That is S27E.
- The 100-character cap is enforced by the route layer; the UI also caps the
  `<input maxLength>` to 100, but the cap is round-trippable.
- No full-text index means there is no fuzzy / typo-tolerant matching, no
  synonym expansion, no language detection.

## NEXT_STEP

- **If browser smoke is later manually confirmed PASS:** create the
  `v0.9.3-weread-notes-search` tag and push it. No additional code change
  expected — the only blocker is end-to-end browser verification.
- **S27E:** AI note summarisation (LLM-generated digest of a date / type
  / search-filtered subset of notes, still private-token only, no
  Meilisearch write, no public exposure).
- **S27F:** Markdown export by book (per-catalogId, joined with
  `weread-matches.confirmed.json` so the export can carry a friendly
  `title` from the public catalog and link back to `/book/:catalogId`).
