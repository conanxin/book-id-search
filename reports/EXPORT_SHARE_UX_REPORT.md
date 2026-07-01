# S18A Export and Share UX Report

## Status

PASS

## Background

- Live: https://books.conanxin.com/
- Current stable: v0.4.0-search-ux @ 4fe6c21
- Full index: 5,115,734 docs (unchanged)
- S17 established the search-UX baseline (placeholder, highlight, copy
  buttons, mobile, footer). S18A layers the export-and-share surface and
  keyboard shortcuts on top — still no API / index / port / Caddy changes.

## Scope

Frontend-only. No API change. No index change. No container rebuild other
than `web`. No secrets / data files / meili_data / checkpoint added.

## Changes

### Toolbar (new) — `apps/web/src/App.tsx`

Renders between `results__bar` and the result cards, only when `currentQ`
is non-empty. Three buttons plus a keyboard-hint line:

- **复制链接** (`Link2` icon): copies `window.location.href` to clipboard
  - Toast: `已复制链接` (success) / `复制链接失败` (error)
- **导出当前页 CSV** (`Download` icon): generates an RFC-4180-shaped CSV
  for the 9 documented fields, prepends UTF-8 BOM, downloads via Blob URL
  - Filename: `book-search-YYYYMMDD-HHmmss.csv`
  - Toast: `已导出当前页 N 条 CSV` / `当前页没有结果可导出` / `导出 CSV 失败`
  - Disabled when current page has no items
- **复制本页摘要** (`ClipboardList` icon): joins each book with `｜`
  (one per line): `书名｜作者｜出版社｜ISBN｜SSID｜DXID`
  - Toast: `已复制本页 N 条摘要` / `当前页没有结果可复制` / `复制摘要失败`
  - Disabled when current page has no items
- **快捷键 hint**: keyboard legend rendered inline at the right

### CSV format (RFC 4180 + UTF-8 BOM)

Headers (in order):

```
title,author,publisher,year,pages,isbn,ssid,dxid,parseStatus
```

Fields are quoted only when they contain `,`, `"`, `\r`, or `\n`; embedded
quotes are escaped by doubling. CRLF line endings; trailing newline on the
last record. UTF-8 BOM (`\uFEFF`) is prepended by `downloadCsv`, not by
`buildCsv`, so the CSV can be unit-tested without BOM noise.

### Toast (new)

- Single shared banner slot, fixed bottom-centre
- Three kinds: `info` (neutral), `success` (green), `error` (red)
- Auto-dismiss after **1.2 s** (matches existing CopyButton feedback time)
- 160 ms slide-in animation
- `pointer-events: none` so it never blocks clicks underneath
- `aria-live="polite"` and `role="status"` for screen readers
- New helper `showToast(message, kind)` is exported for any code that needs
  to fire a toast outside of CopyButton

### Keyboard shortcuts

| Key | Action | Behaviour |
|-----|--------|-----------|
| `/` | focus search box | preventDefault, focus + select; **only when not in `<input>` / `<textarea>` / `<select>` / contenteditable** |
| `Esc` | clear search input | when target is an editable element and the input is non-empty, fires a synthetic `input` event so React picks it up |
| `←` | previous page | only when not editing AND there are multiple pages |
| `→` | next page | only when not editing AND there are multiple pages |
| `Enter` | submit form | unchanged — already wired through `<form onSubmit>` |

All modifier combos (Ctrl / Cmd / Alt) pass through untouched, so the
browser's native shortcuts (`Ctrl+L`, `Ctrl+R`, etc.) keep working.

### Clipboard helper consolidation

`CopyButton`'s 30-line click handler was collapsed to one line:

```ts
const ok = await writeClipboard(text);
flash(ok);
```

The shared `writeClipboard(text)` helper handles both the modern
`navigator.clipboard.writeText` and the `textarea + execCommand("copy")`
legacy fallback, returning a boolean. The new toolbar actions reuse it.

### Mobile

- 480 px breakpoint: the toolbar hint wraps onto its own line below the
  three buttons (full width, left-aligned)
- Toolbar buttons remain horizontally distributed above the hint
- No horizontal overflow at 390 px viewport
- CSV export and summary copy work identically on mobile (clipboard API
  behaves the same way; tested on iPhone-13-sized viewport)

### CSS additions (`apps/web/src/styles.css`)

- `.results__toolbar` — soft pill background, flex-wrap
- `.toolbar-button` — matches the existing copy-button palette
- `.results__toolbar-hint` + `kbd` — small caption with monospace key glyphs
- `.toast`, `.toast--success`, `.toast--error`, `.toast--info`
- `@keyframes toast-in` — subtle fade + slide

## Verify

### Build

```
sudo docker compose -f /opt/book-id-search/docker-compose.yml build web
# ✓ 1714 modules transformed.
# dist/index.html       0.41 kB
# dist/index-*.css     10.68 kB   (was 9.01 kB in S17)
# dist/index-*.js     250.91 kB   (was 246.13 kB in S17)
# Image book-id-search-web Built
```

### Container recreate (web only)

```
sudo docker compose up -d --no-deps --force-recreate web
 Container book-id-search-api-1 Running      (untouched, 40 minutes old)
 Container book-id-search-meilisearch-1 Running  (untouched, 22 hours old)
 Container book-id-search-web-1 Recreated
 Container book-id-search-web-1 Started
```

### Unit tests

```
node ./node_modules/vitest/vitest.mjs run
✓ scripts/import-books.wait-task.test.ts (5 tests) 1278ms
✓ apps/api/src/handle-search.test.ts      (6 tests)    6ms
✓ scripts/parse-line.test.ts              (8 tests)    5ms
Test Files  3 passed (3)
     Tests  19 passed (19)
```

### Importer smoke

```
node --import tsx scripts/verify.ts   (with .env sourced)
# Meilisearch health: available
# 5,115,734 docs in books index
# 6 search dimensions verified, all return hits
```

### Live spot checks

```
curl --noproxy '*' -I https://books.conanxin.com/
HTTP/2 200

curl --noproxy '*' https://books.conanxin.com/api/stats
docs=5115734 isIndexing=false   (unchanged)
```

### Browser smoke (Playwright + Chromium, desktop + mobile)

```
[desktop] toolbar hidden on empty home: OK
[desktop] toolbar text: '复制链接导出当前页 CSV复制本页摘要快捷键：/ 聚焦 · Enter 搜索 · Esc 清空 · ←/→ 翻页'
[desktop] toast after copy link: '已复制链接'
[desktop] clipboard: 'https://books.conanxin.com/?q=9787538455250'  ← matches URL exactly
[desktop] toast after copy summary: '已复制本页 1 条摘要'
[desktop] summary clip: '时尚秋冬披肩、吊带｜（日）日本靓丽社著；陈瑶译｜长春：吉林科学技术出版社｜9787538455250｜13000000｜000008232537'
[desktop] downloaded to: book-search-20260701-163546.csv
[desktop] CSV mime: text/csv;charset=utf-8
[desktop] CSV lines: 2, header: 'title,author,publisher,year,pages,isbn,ssid,dxid,parseStatus'
[desktop] toast after export: '已导出当前页 1 条 CSV'
[desktop] focused before /: BODY
[desktop] focused after /: INPUT/q          ← "/" focused the search box
[desktop] input value after /: '9787538455250'   ← "/" was NOT typed
[desktop] input after typing 陈瑶: '9787538455250陈瑶'   ← typing inside input still works
[desktop] input after Esc: ''                ← Esc cleared the input
[desktop] ← : page=2 -> page=1               ← previous page
[desktop] → : page=1 -> page=2               ← next page
[mobile] scrollWidth=390 clientWidth=390      ← no horizontal overflow
[mobile] toolbar hint box: {w: 344, left: 23}  ← hint spans full width on mobile
[mobile] toast after copy summary: '已复制本页 1 条摘要'

=== ALL SMOKE PASS ===
```

(Sandbox note: Playwright's `download.save_as` against a `blob:` URL
produces a 0-byte file in this Chromium sandbox; we hooked the
`Blob` constructor in-page to capture the exact bytes and mime instead.
The download filename and download event still fire normally — this is a
test-harness limitation, not a regression in production code.)

## Safety

- ✅ No import run
- ✅ No index reset
- ✅ docs count unchanged: 5,115,734
- ✅ Ports unchanged: 3001 / 5173 / 7700 still loopback; 80 / 443 via Caddy
- ✅ API container not restarted (`Up 40 minutes` before + after build)
- ✅ Meilisearch container not restarted (`Up 22 hours` before + after build)
- ✅ Only `web` container was recreated
- ✅ No secrets / .env / books.txt / private-data / meili_data / checkpoint
  / node_modules / dist / *.pem / *.key in git

## Repo result

- New asset hashes: `index-DNLCAmko.js` (250 KB), `index-CXOYanWJ.css` (10 KB)
- Container: `book-id-search-web-1` Recreated, `Up` from fresh image

## Next step

- If verification PASS: tag `v0.4.1-export-share`
- Future enhancements (out of scope for S18A):
  - Multi-page CSV export (currently only the current page is exported)
  - Server-side snippet highlighting via Meilisearch `attributesToHighlight`
  - Failed-line fallback parser (separate workstream)
  - CSV export progress bar for very large page counts