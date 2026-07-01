# S17 Frontend Search UX Optimization Report

## Status

PASS

## Background

- Live: https://books.conanxin.com/
- Current stable: v0.3.2-search-compat @ ed26eb4
- Documents: 5,115,734 (unchanged, full index live)
- Empty-query: already handled (S16D-lite) — this round layers UX polish on
  top, without touching index / API / Caddy / ports.

## Scope

Frontend-only changes. The Web SPA is rewritten for clarity, copy buttons,
highlight, recent searches, and mobile parity. No API changes. No index
changes. No container / port / network changes other than the web image
rebuild + recreate.

## Changes

### Search box (`apps/web/src/App.tsx`)

- Placeholder: `搜索书名、作者、出版社、ISBN、SSID、DXID`
- Press Enter to submit (`<form onSubmit>`)
- Clear button (`×`) appears when input is non-empty
- Empty query shows `输入关键词开始搜索` (never a red error)
- `loading` shows inline `<Loader2>` "搜索中"
- Successful search clears prior errors
- Failed search shows `搜索接口暂时不可用，请稍后重试`
- Empty q never fires a request (useEffect short-circuits — same path S16D-lite
  guarded in the API)
- URL is the source of truth: `?q=&page=` is shareable / bookmarkable
- Debounce 300 ms on input → request; Enter submits immediately (no debounce)
- localStorage `book-id-search.recent-v1`: last 5 unique queries surfaced as
  clickable chips below the search box

### Result card (`BookCard`)

- Title (h2) + status badge (正常 / 弱解析 / 解析异常) on top row
- Author line
- 6 fields in a grid: 出版社 / 年份 / 页数 / ISBN / SSID / DXID
- Copy buttons: 复制 SSID / 复制 DXID / 复制 ISBN / 复制整条
  - Click shows `已复制 <label>` then reverts after 1.2 s
  - 复制失败 shows `复制失败` (fallback path + clipboard API both covered)
  - Disabled when value is missing
- weak records show a soft hint: `本条为弱解析，原始记录已保留。`
- failed records (defensive — not present in current index) show
  `本条解析异常，请谨慎引用。`
- rawInfo intentionally NOT inline (was a giant `<pre>` taking the whole card);
  moved to detail page only

### Result bar

- `共找到 N 条结果`
- `第 X / Y 页 · 每页 20`
- `搜索中` spinner
- Empty-query friendly text

### Pagination

- `« 上一页 第 X / Y 页 下一页 »` with first/last buttons
- Disabled state preserved

### Highlight (`Highlight`)

- Splits title / author / publisher / isbn / ssid / dxid into parts around
  the query, wraps matches in `<mark class="hl">`
- Case-insensitive regex, no `dangerouslySetInnerHTML`
- Chinese passthrough (CJK has no case)
- Empty query → no highlight
- rawInfo NOT highlighted (deliberate)

### Detail page

- Title + status badge row
- Author line
- parseStatus warn/fail hints
- 4 paired rows of `Field + CopyButton`: SSID / DXID / ISBN / (rawInfo copy)
- 4 metadata Fields: 出版社 / 年份 / 页数 / 解析提示
- `原始记录` section with copy button (the entire rawInfo)
- Related books (compact book cards)
- Back button (`返回搜索结果`) keeps history; falls back to `/` if no history

### Status footer

- Always-visible compact summary: `索引 books · 5,115,734 条 · 索引空闲 · 上次导入 2026/6/30 19:35:51`
- Shown on search page only

### Accessibility

- All buttons have `aria-label` and `title`
- `<form role="search">` + named input `q`
- `aria-live="polite"` on loading / status footer
- `aria-current="page"` on pager current page
- `aria-hidden="true"` on decorative icons

### Mobile (`apps/web/src/styles.css`)

- 760 px breakpoint: search button full width, stats / book grid / detail
  grid collapse to 2 cols
- 480 px breakpoint (new): all grids collapse to 1 column, copy buttons stack
  full-width, search button full-width
- SSID / DXID use SFMono / Consolas monospace font with `overflow-wrap:
  anywhere` so they never push the layout horizontally
- No third-party UI library; ~370 lines of plain CSS

## Verify

### Build

```
docker compose build web
# Image book-id-search-web Built
# ✓ 1714 modules transformed.
# dist/index.html       0.41 kB
# dist/index-*.css      9.01 kB
# dist/index-*.js     246.13 kB
```

### Unit tests

`node ./node_modules/vitest/vitest.mjs run`

```
✓ scripts/import-books.wait-task.test.ts (5 tests) 1263ms
✓ apps/api/src/handle-search.test.ts      (6 tests)    6ms
✓ scripts/parse-line.test.ts              (8 tests)    6ms
Test Files  3 passed (3)
     Tests  19 passed (19)
```

(`pnpm test` could not bootstrap `pnpm@10.33.0` via corepack in this sandbox;
the canonical build path is `docker compose build web`, which uses the same
toolchain inside the container. The test suite was invoked through the
locally-installed vitest 4.1.9 to obtain the same coverage.)

### Importer smoke

`node --import tsx scripts/verify.ts` with `.env` env vars:

- Meilisearch health: available
- 5,115,734 docs in books index
- 6 search dimensions verified, all return hits:
  - SSID / DXID / ISBN / 书名 / 作者 / 出版社 — each ≥ 5 hits on a known seed

(`pnpm verify` cannot run on the host because the bootstrap pnpm 10.33.0 is
unreachable. The script is invoked directly with `node --import tsx`.)

### Live URL

```
curl --noproxy '*' -I https://books.conanxin.com/
HTTP/2 200
content-type: text/html
```

```
curl --noproxy '*' https://books.conanxin.com/api/health
{"ok":true,"meili":{"status":"available"},"index":"books"}
```

```
curl --noproxy '*' https://books.conanxin.com/api/stats
{"index":"books","numberOfDocuments":5115734,"isIndexing":false,...}
```

Live search samples (HTTPS via Caddy):

| q | total | sample |
|---|---|---|
| `9787538455250` | 1 | 时尚秋冬披肩、吊带 / 长春：吉林科学技术出版社 / 2011 |
| `时尚秋冬披肩` | 2,955 | first hit same as above |
| `陈瑶译` | 181,393 | author hits |
| `吉林科学技术出版社` | 68,402 | publisher hits |
| `q=` (empty) | 0 | S16D-lite compact payload still returned |

### Browser smoke (Playwright + Chromium, both desktop + mobile)

Verified end-to-end against the live SPA:

```
[desktop] title: 图书 SSID / DXID 检索
[desktop] h1: 图书 SSID / DXID 检索
[desktop] placeholder: 搜索书名、作者、出版社、ISBN、SSID、DXID
[desktop] empty bar: 输入关键词开始搜索
[desktop] isbn cards: 1
[desktop] highlight marks: 1
[desktop] copy buttons per page: 4
[desktop] bar: 共找到 1 条结果
[desktop] title cards: 20, bar: 共找到 2,955 条结果
[desktop] pager: «上一页第 1 / 148 页下一页»
[desktop] explicit empty bar: 输入关键词开始搜索
[desktop detail] h1: 时尚秋冬披肩、吊带
[desktop detail] copy buttons: 44   (4 detail + 4 × 10 related)
[desktop] footer: 索引 books · 5,115,734 条 · 索引空闲 · 上次导入 2026/6/30 19:35:51
[mobile] empty scrollWidth=390 clientWidth=390   (no overflow)
[mobile] cards: 20, scrollWidth=390 clientWidth=390
[mobile] stats-strip cols: 370px     (single column at 390px viewport)
[mobile] book-grid cols: 332px      (single column at 390px viewport)
[mobile detail] scrollWidth=390 clientWidth=390   (no overflow)

=== ALL SMOKE PASS ===
```

(Headless Chromium launch flags `--no-sandbox --no-proxy-server` because
sing-box SOCKS proxy on 127.0.0.1:7897/7898 in this sandbox does not
cooperate with Chromium's TLS; smoke runs over direct egress.)

## Safety

- ✅ No import run
- ✅ No index reset
- ✅ documents count: 5,115,734 unchanged
- ✅ Ports unchanged (3001 / 5173 / 7700 still loopback; 80 / 443 still
  Caddy-fronted)
- ✅ API not restarted (verified — API container `Up 21 minutes` throughout
  the build/recreate)
- ✅ Meilisearch not restarted (verified — `Up 19 hours` throughout)
- ✅ Only `web` container was recreated
- ✅ No secrets / .env / books.txt / private-data / meili_data / node_modules
  / dist / checkpoint / *.pem / *.key in git

## Repo result

- Branch: `main`
- Build artefact: `book-id-search-web` image rebuilt at 2026-07-01 16:08 UTC
- Container: `book-id-search-web-1` recreated, `Up` from fresh image
- New asset hashes: `index-C59eZZSN.js` (246 KB), `index-Bqz4gF0B.css` (9 KB)

## Next step

- If verification PASS: tag `v0.4.0-search-ux`
- Future enhancements (out of scope for S17):
  - failed-line fallback parser (separate workstream)
  - server-side highlighting via Meilisearch `attributesToHighlight`
  - CSV export of search results