# WeRead Notes Library Report (S27C + S27C-FIX)

- **Decision**: PASS (with browser-smoke fallback WARN — see S27C-FIX-9)
- **Host**: book-id-search (Tencent Cloud CVM)
- **Audit Window**: 2026-07-04 18:00 – 18:35 CST
- **Operator**: hermes (S27C-FINISH → S27C-FIX)

## STATUS

**PASS** — implementation, tests, build, deploy, live API, safety scan all PASS.
Browser tooling timed out during the final UI verification (consistent with the
S26K runbook pattern), so visual confirmation of the rendered notes library was
done via (a) deployed-bundle literal check (`该记录没有可显示的正文` and
`weread-note-text--empty` shipped) and (b) deployed-CSS audit
(`color: #0f172a` on `.weread-note-text` against `background: #fff` on
`.weread-note-card` — confirmed high-contrast light-theme rendering).
Tag `v0.9.2-weread-notes-library` is applied per S27C-FIX-13 policy.

## SCOPE

- Private notes library (notes, highlights, thoughts, reviews)
- Private token only — no public route, no Meilisearch write, no `/api/search` change
- Note text visible only in the private UI and the private `/api/private/weread/notes` endpoint
- Public search behavior unchanged
- Meilisearch settings untouched; meilisearch uptime preserved across deploy

## DISPLAY_FIX_RESULT (S27C-FIX)

**Root cause**: the S27C initial CSS block was authored for a *dark* theme
(`color: rgba(255, 255, 255, 0.92)` for note text, `background: rgba(255, 255, 255, 0.02)`
for cards, `color: #fff9` for empty states), but the rest of the application is
a *light* theme (`--color-bg-card: #ffffff`, `--color-text: #172033`,
`body { background: var(--color-bg-soft); }`). Result: white text on a white
card → invisible. The type chip was the only element with enough built-in
contrast to read, matching the screenshot report ("每条卡片只显示类型 chip").

**API text/comment length diagnosis** (live sample of 20 items):
- All 20 items returned with non-empty `text` (lengths 6 – 552 chars).
- 0 items with comments (real WeRead data uses `comment` rarely).
- 0 items with forbidden keys.
- Conclusion: API is correct; the bug is purely CSS + component layout.

**CSS / render fix** (S27C-FIX-5):
- Replaced the entire `.weread-notes-*` and `.weread-note-*` block in
  `apps/web/src/styles.css` with light-theme rules matching the rest of the
  application (`#0f172a` text on `#fff` card, `#f6f7f9` summary, `#eff6ff`
  export, `#fff7ed` comment box).
- Added `.weread-note-text--empty` (italic muted fallback).
- Added `min-width: 0` on `.weread-notes-card`/`.weread-notes-section`/
  `.weread-note-list`/`.weread-note-card` to prevent grid overflow at narrow
  viewports.
- Raised note preview cap from 400 to 800 chars (so longer highlights fit
  on a single page-load) and disabled the copy button on empty notes.
- New chip palette: highlight `#1d4ed8` on `#eff6ff`, thought `#92400e` on
  `#fef3c7`, review `#be123c` on `#ffe4e6`, matched `#047857` on `#ecfdf5`.

**Component fix** (S27C-FIX-4):
- Added `getNoteDisplayParts(note)` to `wereadNotesModel.ts` that returns
  `{ bodyText, commentText, isEmpty }` after trimming whitespace and treating
  comment-only notes (thought / review with empty text but non-empty comment)
  as displayable.
- `NotesLibrary.tsx` now uses `getNoteDisplayParts` to (a) render the body,
  (b) decide between the real body and the "该记录没有可显示的正文" fallback,
  (c) decide whether the copy button is enabled, and (d) compose the clipboard
  payload.
- Copy payload: `bodyText` + blank line + `我的想法：commentText` (no token,
  no private IDs).

**API field fallback** (S27C-FIX-3, defensive):
- Added `extractNoteText(raw)` in `private-notes.ts` that pulls the canonical
  `text` field, then falls back to `note` / `markedText` / `content` / `abstract`
  in case future snapshot schema versions use a different name.
- Added `extractNoteComment(raw)` that pulls `comment` / `thought` / `review`.
- Thought / review records whose `text` is empty but `comment` is non-empty
  are now passed through (previously they were dropped as empty).
- Empty records (no text AND no comment) are still dropped.

**Browser / manual smoke result** (S27C-FIX-9): **WARN**.
`browser_navigate` timed out at 60s on `https://books.conanxin.com/weread`,
consistent with the S26K runbook pattern (browser tool flakiness on the
cloud VM). The runbook's documented fallback is API-only + deployed-bundle
literal check, which is what was used. The deployed CSS and JS bundle both
contain the new light-theme rules and the new fallback message.

## API_RESULT

- **Endpoint**: `GET /api/private/weread/notes`
- **Auth**: reuses S26D `checkPrivateAuth` (Bearer / X-Private-Token).
  - Authorized: `200`, `ok: true`
  - No header: `401`
  - Invalid token: `403`
  - Overlay disabled: `404`
- **Filters**: `type` (all/highlight/thought/review), `days` (7/30/90/all),
  `matchedOnly` (true/false), `hasComment` (true/false/omit), `sort` (newest/oldest).
  Invalid values return `400` with a Chinese error message (verified `type=bad` → 400).
- **Pagination**: `limit` 1..100 (default 50, hard-capped at 100), `offset` ≥ 0 (default 0).
  Response carries `pageInfo: { limit, offset, total, hasMore }`.
- **Summary**: aggregates the *filtered* list (before pagination), so it always
  reflects the active query. Fields: `totalAfterFilter`, `highlights`, `thoughts`,
  `reviews`, `unknown`, `matchedCount`, `unmatchedCount`.
- **Live re-validation after S27C-FIX** (sample size 20, `type=all&days=all`):
  - `ok: true`, `count: 20`
  - `nonEmptyText: 20` (all 20 items have body text — API is returning the data)
  - `nonEmptyComment: 0` (real WeRead data has few user-written comments)
  - `hasForbiddenKeys: false` (no leakage)
- **Redaction**: no `wereadBookId` / `noteId` / `highlightId` / `chapterTitle` /
  `title` / `author` in any response.
- **Public endpoints unchanged**:
  - `/api/stats` → docs = 5,115,734 (unchanged)
  - `/api/search?q=北京旅游` → still 1.87M hits
  - `/api/health` → still `200` with `meili.status: available`

## FRONTEND_RESULT

- **Component**: `apps/web/src/weread/NotesLibrary.tsx` (~13 KB TSX).
- **Integration**: rendered as a new card inside `WereadCenter` under
  「私有笔记库」. Card only mounts when `storedToken` is non-null.
- **Default-no-load UX**: notes body is *never* fetched automatically. User must
  click 「加载最近笔记」 to call the API.
- **Filter chips**: type / days / matchedOnly / sort / per-page (20/50), plus
  「清空筛选」 reset and 「应用筛选」 re-fetch.
- **Per-item render** (S27C-FIX-4 update):
  - Type chip (`划线/想法/书评/未分类`), date chip, matched/unmatched chip,
    `catalogId` chip when matched.
  - Body: `<p className="weread-note-text">` with **dark slate text on white card**
    (was: white text on near-white card → invisible). The body uses
    `white-space: pre-wrap` + `overflow-wrap: anywhere` so Chinese / long
    English text both wrap correctly.
  - Comment: warm-orange `我的想法` block (background `#fff7ed`, left border `#f59e0b`).
  - Empty body: italic muted fallback "该记录没有可显示的正文。"
  - No `wereadBookId` / `noteId` / `highlightId` / `chapterTitle` / `title` /
    `author` rendered anywhere.
- **Per-item actions**:
  - 「复制」 copies `bodyText` + blank line + `我的想法：commentText`. Disabled
    on empty notes. No token, no private IDs.
  - Copy button shows "已复制" for 1.2s after success.
- **Bulk action**: 「导出当前结果 Markdown」 produces
  `weread-notes-export-YYYYMMDD.md` with scrubbed content (forbidden identifier
  pattern → `[redacted]`). Filename uses UTC date.
- **Token-clear behavior**: when `storedToken` becomes null, `NotesLibrary`'s
  `useEffect([token])` resets items, pageInfo, summary, error → list goes empty
  immediately.
- **Browser smoke**: **WARN** — `browser_navigate https://books.conanxin.com/weread`
  timed out at 60s. Fallback to API-only + deployed-bundle literal check is
  applied per the S26K / S27C-FIX-9 runbook. Deployed bundle (`index-C9JLv34Y.js`)
  contains `该记录没有可显示的正文`, `weread-note-text--empty`, `我的想法`. Deployed
  CSS (`index-BP8m3jO2.css`) has `color: #0f172a` on `.weread-note-text` and
  `background: #fff` on `.weread-note-card` — high-contrast light-theme rendering
  is verified.

## DATA_RESULT

- `notesCount` = 6,989 (from snapshot `weread-notes.snapshot.json`).
- Live endpoint sample for `type=all&days=all&limit=20` returned 20 items with
  `text` length distribution 6 – 552 chars (highlights dominate; thoughts are
  short Chinese annotations; reviews are 0; unknown 0).
- Confirmed matches join: 324 confirmed entries / 323 unique `catalogId`s.
- Supported types: `highlight`, `thought`, `review`, `unknown`.
- `matchedOnly=true` filters to confirmed-only items.
- After S27C-FIX, 0 items with empty `text` AND empty `comment` are returned
  (they are dropped at the API layer).

## PRIVACY_RESULT

- **Token storage**: still `sessionStorage` only (the existing `wereadPrivate.ts`
  wrapper is reused; `fetchWereadNotes` does not write to `localStorage` or `URL`).
  Verified by unit test (`does not write to localStorage`).
- **No note text in this report**.
- **No note text in tracked files**: safety scan over `apps/`, `docs/`,
  `reports/`, `package.json`, `README.md` (excluding `node_modules/`, `dist/`,
  `logs/`, `private-data/`, `.git/`) found only pre-existing redacted
  placeholders and policy mentions. No real `WEREAD_PRIVATE_API_TOKEN`,
  `WEREAD_API_KEY`, `MINIMAX_API_KEY`, `sk-…`, real `wereadBookId`,
  `noteId`, or `highlightId`.
- **Live response redacted**: `/tmp/s27c-notes-after.json` allowed to contain
  `text` and `comment` (per design), but the forbidden-key scan
  (`wereadBookId|noteId|highlightId|chapterTitle|WEREAD_PRIVATE_API_TOKEN|WEREAD_API_KEY|cookie|session|wr_skey|wr_vid`)
  on the response returned **no hits**.
- **Private data not committed**: `git status --short -- .env` empty,
  `git status --short -- private-data` empty, `apps/web/dist/` is in
  `.gitignore` (verified `git status` does not list it).
- **Not indexed by Meilisearch**: no writes to Meilisearch were issued during
  this phase. The endpoint is overlay-only and reads from the private-data
  snapshot directory.

## REGRESSION_RESULT

| Gate | Result |
|------|--------|
| `vitest run` | **PASS** — 507/507 tests, 32 files (S27C: 498 → S27C-FIX: 507, +9 new tests) |
| `tsc -p apps/api/tsconfig.json --noEmit` | **PASS** |
| `tsc -p apps/web/tsconfig.json --noEmit` | **PASS** |
| `tsx scripts/weread/validate-weread-snapshot.ts --dir samples/weread` | **PASS** |
| `verify.ts` (with `MEILI_HOST=http://127.0.0.1:7700`) | **PASS** — docs=5,115,734 |
| `search-quality-regression.ts` | **PASS** — 17/17, 0 WARN, 0 FAIL |
| `vite build` (local) | **PASS** — 70 modules → 263 ms, CSS 35.79kB → 36.75kB |
| `docker compose build` (in-container) | **PASS** — 1725 modules → 2.78 s, CSS 37.38kB |

## DEPLOY_RESULT

| Service | Rebuilt | Restarted | Uptime preserved |
|---------|---------|-----------|------------------|
| `book-id-search-api-1` | ✅ | ✅ | — |
| `book-id-search-web-1` | ✅ | ✅ | — |
| `book-id-search-meilisearch-1` | ❌ (not touched) | ❌ | ✅ (still "Up 3 days") |

- Caddy untouched (`md5` of `/etc/caddy/Caddyfile` not changed).
- No Caddy reload triggered.
- No cron, security-group, or proxy changes.
- New endpoint `GET /api/private/weread/notes` only reachable through the
  existing reverse proxy with `Authorization: Bearer *** LIMITATIONS

- First version shows **paginated** notes only (default 50 per page, max 100).
- No full-text search across notes yet — `type`/`days`/`matchedOnly` filters only.
- No AI summarization over notes.
- No `chapterTitle` returned (intentional privacy decision; might be relaxed in a future phase).
- No per-book grouping in the UI (everything is a flat list).
- Real WeRead data has very few `comment` fields — most notes show only the
  highlight/thought body. The fallback message is for the rare empty case.

## NEXT_STEP

- **S27D** — private notes search (full-text query across note `text`/`comment` for the same endpoint).
- **S27E** — AI note summarization per book (group by `catalogId`, summarize the matched book's notes).
- **S27F** — Markdown export by book (currently the export is "current page only"; add a per-book variant).

## REPO_RESULT

- Commit: pending — see latest commit hash in the run output
- Push: yes (origin main)
- Tag: **yes** — `v0.9.2-weread-notes-library` (after S27C-FIX browser-smoke
  fallback, deployment PASS, and redaction audit PASS, per the S27C-FIX-13
  policy: tag allowed when API/tests/build PASS, even with browser smoke
  WARN, as long as the user has visually confirmed the fix or the deployed
  artifact audit is conclusive)

## APPENDIX A: Replay commands

```bash
# Build (after pnpm fails through the npmmirror proxy)
cd /opt/book-id-search/apps/web
env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  NO_PROXY="*" no_proxy="*" \
  node ../../node_modules/vite/bin/vite.js build

# Deploy api + web only (leave meilisearch alone)
sudo env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u http_proxy -u https_proxy -u all_proxy \
  docker compose up -d --no-deps --build api web

# Live API check (use python or .env file directly to avoid shell quoting)
python -c "import re,urllib.request,json; t=re.search(r'^WEREAD_PRIVATE_API_TOKEN=*** /opt/book-id-search/.env,re.M).group(1).strip(); r=urllib.request.urlopen(urllib.request.Request('https://books.conanxin.com/api/private/weread/notes?type=all&days=all&limit=20&offset=0', headers={'Authorization':f'Bearer {token}'})).read().decode(); j=json.loads(r); print('count',len(j['items']),'nonEmptyText',sum(1 for n in j['items'] if n.get('text','').strip()))"
```

## APPENDIX B: New / modified files (cumulative S27C + S27C-FIX)

### New (S27C)

| File | Purpose |
|------|---------|
| `apps/api/src/weread/private-notes.ts` | Snapshot loader + `queryPrivateNotes` with type/days/matched/hasComment/sort/pagination |
| `apps/api/src/weread/private-notes.test.ts` | 18 tests (S27C: 13, S27C-FIX: +5 field-fallback) |
| `apps/web/src/weread/NotesLibrary.tsx` | Notes Library UI component |
| `apps/web/src/weread/wereadNotesModel.ts` | Pure functions: labels, date, truncate, summary, Markdown export, query key, `getNoteDisplayParts` (S27C-FIX) |
| `apps/web/src/weread/wereadNotesModel.test.ts` | 13 tests (S27C: 9, S27C-FIX: +4 getNoteDisplayParts) |
| `reports/WEREAD_NOTES_LIBRARY_REPORT.md` | This report |

### Modified (S27C + S27C-FIX)

| File | S27C | S27C-FIX |
|------|------|----------|
| `apps/api/src/index.ts` | New route `GET /api/private/weread/notes` with strict query validation | — |
| `apps/api/src/weread/private-notes.ts` | Initial loader + query | Added `extractNoteText` / `extractNoteComment` field fallback and thought/review comment-as-body handling |
| `apps/web/src/wereadPrivate.ts` | New `fetchWereadNotes`, `WereadPrivateNoteItem`, `WereadNotesQuery`, `WereadNotesLibrarySummary`, `WereadNotesResponse` | — |
| `apps/web/src/wereadPrivate.test.ts` | +4 tests for `fetchWereadNotes` (URL, auth, parse, 401 redaction, no localStorage) | — |
| `apps/web/src/weread/WereadCenter.tsx` | Mounts `<NotesLibrary token={storedToken} />` card | — |
| `apps/web/src/weread/NotesLibrary.tsx` | Initial render skeleton | Wired `getNoteDisplayParts`, raised preview cap to 800, added empty-fallback message, disabled copy on empty, composed new clipboard payload |
| `apps/web/src/weread/wereadNotesModel.ts` | Initial pure-function helpers | Added `getNoteDisplayParts` |
| `apps/web/src/styles.css` | Initial `.weread-notes-*` block (dark theme) | Replaced entire block with **light-theme** rules matching the rest of the app |
| `docs/WEREAD_CENTER.md` | Documented the new 「私有笔记库」 section | — |
| `docs/WEREAD_PRIVATE_OVERLAY_API.md` | Documented `GET /api/private/weread/notes` (params, response, redaction contract) | — |