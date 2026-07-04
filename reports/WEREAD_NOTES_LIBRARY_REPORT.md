# WeRead Notes Library Report (S27C)

- **Decision**: WARN
- **Host**: book-id-search (Tencent Cloud CVM)
- **Audit Window**: 2026-07-04 18:00 – 18:30 CST
- **Operator**: hermes (S27C-FINISH)

## STATUS

**WARN** — implementation, tests, build, deploy, and live API validation all PASS.
Browser tooling timed out (consistent with the S26K runbook pattern); falling back
to API-only smoke is permitted per the S27C-F6 policy. Commit allowed, tag withheld.

## SCOPE

- Private notes library (notes, highlights, thoughts, reviews)
- Private token only — no public route, no Meilisearch write, no `/api/search` change
- Note text visible only in the private UI and the private `/api/private/weread/notes` endpoint
- Public search behavior unchanged
- Meilisearch settings untouched; meilisearch uptime preserved across deploy

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
- **Summary**: aggregates the *filtered* list (before pagination), so it always reflects
  the active query. Fields: `totalAfterFilter`, `highlights`, `thoughts`, `reviews`,
  `unknown`, `matchedCount`, `unmatchedCount`.
- **Live authorized sample** (`type=highlight&days=30&limit=3`): returned `ok: true`
  with at least one `type: "highlight"` item carrying `text`, `comment: null`,
  `createdAt` (ISO-8601), `matched: true`, `catalogId`, `source: "private_weread"`.
- **Redaction verified**:
  - No `wereadBookId` in any item.
  - No `noteId` / `highlightId` / `chapterTitle` / `title` / `author` in any item.
  - Unauthorized and invalid-query responses do not include any note body.
- **Public endpoints unchanged**:
  - `/api/stats` → docs count = 5,115,734 (unchanged)
  - `/api/search?q=北京旅游` → still 1.87M hits with normal ranking
  - `/api/health` → still `200` with `meili.status: available`

## FRONTEND_RESULT

- **Component**: `apps/web/src/weread/NotesLibrary.tsx` (~12 KB TSX).
- **Integration**: rendered as a new card inside `WereadCenter` under
  「私有笔记库」. Card only mounts when `storedToken` is non-null.
- **Default-no-load UX**: notes body is *never* fetched automatically. User must click
  「加载最近笔记」 to call the API.
- **Filter chips**: type / days / matchedOnly / sort / per-page (20/50), plus
  「清空筛选」 reset and 「应用筛选」 re-fetch.
- **Per-item actions**:
  - 「复制」 copies `text` (and optional `我的想法：comment`) via `navigator.clipboard`.
  - Type chip (`划线/想法/书评/未分类`), date chip, matched/unmatched chip,
    `catalogId` chip when matched.
  - No `wereadBookId` / `noteId` / `highlightId` / `chapterTitle` rendered anywhere.
- **Bulk action**: 「导出当前结果 Markdown」 produces `weread-notes-export-YYYYMMDD.md`
  with scrubbed content (forbidden identifier pattern → `[redacted]`). Filename uses
  UTC date.
- **Token-clear behavior**: when `storedToken` becomes null, `NotesLibrary`'s
  `useEffect([token])` resets items, pageInfo, summary, error → list goes empty
  immediately. Confirmed by code path in component (effect dep on `token` prop).
- **Browser smoke**: **WARN** — `browser_navigate https://books.conanxin.com/weread`
  timed out twice at 60s, consistent with the S26K browser-tool flakiness documented
  in the WeRead skill. Fallback to API-only + static-asset hash check (deployed
  bundle `index-CacvWUbm.js` contains `weread-notes-section`, `weread-note-card`,
  and `私有笔记库` literals — code is shipped).

## DATA_RESULT

- `notesCount` = 6,989 (from snapshot `weread-notes.snapshot.json`).
- Live endpoint sample for `type=highlight&days=30&limit=3` returned items whose
  `createdAt` falls inside the past 30 days window (highlights are the dominant
  type at 6,967 records; thoughts at 22; reviews 0; unknown 0).
- Confirmed matches join: 324 confirmed entries / 323 unique `catalogId`s;
  endpoint exposes `matched: true` and the matched `catalogId` only when
  the underlying WeRead book id joined to a confirmed match.
- Supported types on the endpoint: `highlight`, `thought`, `review`, `unknown`.
- `matchedOnly=true` filters to confirmed-only items.

## PRIVACY_RESULT

- **Token storage**: still `sessionStorage` only (the existing `wereadPrivate.ts`
  wrapper is reused; `fetchWereadNotes` does not write to `localStorage` or `URL`).
  Verified by unit test (`does not write to localStorage`).
- **No note text in reports**: this report contains zero note text, zero comments,
  zero real titles, zero private IDs.
- **No note text in tracked files**: safety scan over `apps/`, `docs/`,
  `reports/`, `package.json`, `README.md` (excluding `node_modules/`, `dist/`,
  `logs/`, `private-data/`, `.git/`) found only:
  - Pre-existing redacted placeholders (`sk-abc...6789`, `Bearer my-token` in
    test fixtures that *verify* redaction works).
  - Pre-existing synthetic test fixtures (`wb1`/`wb2`, `x`/`y` in
    `private-overlay.test.ts`).
  - Policy mentions of the *names* of the forbidden keys (e.g.,
    "response excludes `wereadBookId`") which are documentation, not data.
- **Live response redacted**: `/tmp/s27c-notes.json` allowed to contain `text`
  and `comment` (per design), but the forbidden-key scan
  (`wereadBookId|noteId|highlightId|chapterTitle|WEREAD_PRIVATE_API_TOKEN|WEREAD_API_KEY|cookie|session|wr_skey|wr_vid`)
  on the response returned **no hits**.
- **Private data not committed**: `git status --short -- .env` empty,
  `git status --short -- private-data` empty, `apps/web/dist/` is in `.gitignore`
  (verified `git status` does not list it).
- **Not indexed by Meilisearch**: no writes to Meilisearch were issued during
  this phase. The endpoint is overlay-only and reads from the private-data
  snapshot directory.

## REGRESSION_RESULT

| Gate | Result |
|------|--------|
| `vitest run` | **PASS** — 498/498 tests, 32 files |
| `tsc -p apps/api/tsconfig.json --noEmit` | **PASS** |
| `tsc -p apps/web/tsconfig.json --noEmit` | **PASS** |
| `tsx scripts/weread/validate-weread-snapshot.ts --dir samples/weread` | **PASS** |
| `verify.ts` (with `MEILI_HOST=http://127.0.0.1:7700`) | **PASS** — docs=5,115,734 |
| `search-quality-regression.ts` | **PASS** — 17/17, 0 WARN, 0 FAIL |
| `vite build` (via `node node_modules/vite/bin/vite.js build` from `apps/web`) | **PASS** — 70 modules → 322 ms |
| `docker compose build` (in-container `vite build`) | **PASS** — 1725 modules → 2.80 s |

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
  existing reverse proxy with `Authorization: Bearer <token>`.

## LIMITATIONS

- First version shows **paginated** notes only (default 50 per page, max 100).
- No full-text search across notes yet — `type`/`days`/`matchedOnly` filters only.
- No AI summarization over notes.
- No `chapterTitle` returned (intentional privacy decision; might be relaxed in a future phase).
- No per-book grouping in the UI (everything is a flat list).
- `thought` and `review` types appear rarely in real data (22 thoughts, 0 reviews in current snapshot).

## NEXT_STEP

- **S27D** — private notes search (full-text query across note `text`/`comment` for the same endpoint).
- **S27E** — AI note summarization per book (group by `catalogId`, summarize the matched book's notes).
- **S27F** — Markdown export by book (currently the export is "current page only"; add a per-book variant).

## REPO_RESULT

- Commit: pending (status WARN ⇒ commit allowed, no tag per S27C-F10 policy)
- Tag: not applied (browser smoke incomplete)

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

# Live API check
TOKEN="$(grep '^WEREAD_PRIVATE_API_TOKEN=' /opt/book-id-search/.env | tail -1 | cut -d= -f2-)"
curl --noproxy "*" -s -H "Authorization: Bearer *** "https://books.conanxin.com/api/private/weread/notes?type=highlight&days=30&limit=3"
```

## APPENDIX B: New / modified files

### New

| File | Purpose |
|------|---------|
| `apps/api/src/weread/private-notes.ts` | Snapshot loader + `queryPrivateNotes` with type/days/matched/hasComment/sort/pagination |
| `apps/api/src/weread/private-notes.test.ts` | 13 tests covering filters, pagination, redaction, default-deny on invalid enums |
| `apps/web/src/weread/NotesLibrary.tsx` | Notes Library UI component |
| `apps/web/src/weread/wereadNotesModel.ts` | Pure functions: labels, date, truncate, summary, Markdown export, query key |
| `apps/web/src/weread/wereadNotesModel.test.ts` | 9 tests |
| `reports/WEREAD_NOTES_LIBRARY_REPORT.md` | This report |

### Modified

| File | Purpose |
|------|---------|
| `apps/api/src/index.ts` | New route `GET /api/private/weread/notes` with strict query validation |
| `apps/web/src/wereadPrivate.ts` | New `fetchWereadNotes`, `WereadPrivateNoteItem`, `WereadNotesQuery`, `WereadNotesLibrarySummary`, `WereadNotesResponse` |
| `apps/web/src/wereadPrivate.test.ts` | +4 tests for `fetchWereadNotes` (URL, auth, parse, 401 redaction, no localStorage) |
| `apps/web/src/weread/WereadCenter.tsx` | Mounts `<NotesLibrary token={storedToken} />` card |
| `apps/web/src/styles.css` | `.weread-notes-*` block (card, filter, list, chips, loadmore, mobile breakpoints) |
| `docs/WEREAD_CENTER.md` | Documented the new 「私有笔记库」 section |
| `docs/WEREAD_PRIVATE_OVERLAY_API.md` | Documented `GET /api/private/weread/notes` (params, response, redaction contract) |