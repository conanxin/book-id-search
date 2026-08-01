# WeRead Center Layout — S27D-UI-POLISH Report

**Status:** PASS
**Date:** 2026-08-01
**Scope:** S27D-UI-POLISH — `/weread` front-end layout refactor.
**Branch:** main (HEAD = the new commit)
**Tag target:** `v0.9.3-weread-notes-search`

---

## STATUS

**PASS** — All API / regression / privacy / build / smoke checks PASS.

```
vitest                555 PASS / 0 FAIL  (was 532, +23 new structural tests)
web tsc               PASS
vite build            PASS  (40.97 kB CSS / 308.03 kB JS)
pnpm verify           PASS  (docs = 5,115,734)
search-quality        17 PASS / 0 WARN / 0 FAIL
docker compose up web PASS  (api/meilisearch NOT touched)
browser smoke         PASS  (desktop / tablet / mobile — no horizontal scroll)
```

---

## ORIGINAL LAYOUT PROBLEMS (S27D-AUDIT)

| # | Problem | Evidence |
|---|---------|----------|
| 1 | Page width capped at 920px, narrow on ≥1024 displays | `.weread-center-page { max-width: 920px }` |
| 2 | Privacy card forced equal-height with the trend card, creating a tall blank gap | `.weread-center-grid { grid-auto-rows: 1fr; height: 100% }` |
| 3 | Trend metrics stacked vertically — page scrolled far below the fold | `.weread-trend-grid { 1fr }` on mobile + single col on desktop |
| 4 | Private notes library rendered as the last grid cell — the core feature was visually subordinate to the summary cards | placed after KPI + privacy + trend |
| 5 | Search box visually separated from filters, breaking mental model | `.weread-notes-search` rendered below `.weread-notes-filter__actions` |
| 6 | Two distinct "返回搜索" anchors (one inline inside 使用说明 card, one global footer) | duplicate `返回搜索` matches |
| 7 | Stats cards over-fragmented: 3 KPI cards × 3 cards = 9 visible numbers spread across 3 separate cards, with cramped text wrap | `word-break: break-all` on `.weread-stat-card__value` |

---

## NEW LAYOUT STRUCTURE

```
<main className="weread-center-page">                max-width: 1220px, width: calc(100% - 32px)
  <header className="weread-center-hero">           centered title + subtitle
  <section className="weread-center-panel">         token form (or status row when connected)
  <section className="weread-kpi-section">          6-card KPI grid (one card per metric)
    <div className="weread-kpi-grid">               repeat(6, 1fr)
      <StatCard>书架</StatCard> <StatCard>笔记</StatCard> <StatCard>已匹配书目</StatCard>
      <StatCard>有笔记的匹配书</StatCard> <StatCard>有划线的匹配书</StatCard>
      <StatCard>已匹配笔记记录</StatCard>
    <p className="weread-kpi-meta">匹配率 X% · 每本匹配书平均笔记记录 Y · 只显示数量</p>
  </section>
  <div className="weread-center-grid" align-items:start>
    <section className="weread-center-card weread-notes-card">       2/3 — left main
      <h2>私有笔记库</h2>
      <NotesLibrary token={...}/>                                     refactored below
    </section>
    <aside className="weread-side-rail">                              1/3 — right rail
      <section className="weread-center-card weread-trend-section">
        <h2>阅读趋势</h2>
        <div className="weread-trend-block">时间窗口</div>            2-col grid
        <div className="weread-trend-block">类型分布（全部时间）</div> 2-col grid
        <div className="weread-trend-block">最近 30 天每日新增</div>    full-width bars
      </section>
      <section className="weread-privacy-card">                       compact
        <h2>隐私边界</h2>
        <p className="weread-privacy-card__summary">                  always-visible summary line
          私有内容仅在当前 private token 会话中可见。
        </p>
        <details>                                                     collapsed by default
          <summary>展开隐私说明</summary>
          <ul className="weread-privacy-card__list">…</ul>
        </details>
      </section>
    </aside>
  </div>
  <footer className="weread-center-footer">                           single global footer
    返回搜索 | 使用说明（hint）                                        NO fixed positioning
  </footer>
</main>
```

### NotesLibrary toolbar re-order (within the main notes card)

```
Row 1 — weread-notes-search-row     搜索 [input] [搜索] [清除搜索]
Row 2 — weread-notes-filter-row     类型 [▼] 时间 [▼] 匹配 [▼] 排序 [▼] 每页 [▼]
Row 3 — weread-notes-actions-row    [加载笔记] [导出 Markdown] [清空筛选]
```

The search box is now the visual primary action above the filter strip. Empty idle
state shows `输入搜索词，或点击加载笔记开始浏览。` (testid `weread-notes-empty-idle`).

---

## KEY CSS CHANGES

```css
/* Page width — within spec range 1180–1240 */
.weread-center-page {
  max-width: 1220px;
  width: calc(100% - 32px);
  margin: 0 auto;
  padding: 24px 16px 48px;
}

/* Main grid — 8/4 with align-items:start (FIX for equal-height bug) */
.weread-center-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}

/* Cards explicitly opt out of any height stretch */
.weread-center-card,
.weread-notes-card {
  height: auto;
  align-self: start;
}

/* KPI grid — 6 desktop, 3 tablet, 2 mobile */
.weread-kpi-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); }
@media (max-width: 1100px) { .weread-kpi-grid { grid-template-columns: repeat(3, …); } }
@media (max-width: 720px)  { .weread-kpi-grid { grid-template-columns: repeat(2, …); } }

/* Trend metric blocks — 2-col grid */
.weread-trend-grid--2col { grid-template-columns: repeat(2, minmax(0, 1fr)); }

/* Privacy card — compact, collapsible */
.weread-privacy-card { … }                                  /* not a grid cell */
.weread-privacy-card__details summary::before { content:"▸"; }

/* Single global footer */
.weread-center-footer { display: flex; justify-content: space-between; }
```

Specifically removed per spec:

- `height: 100%` / `min-height: 100%` on `.weread-center-card`
- `align-self: stretch` on `.weread-center-card`
- `grid-auto-rows: 1fr` on `.weread-center-grid`
- `.weread-privacy-card { grid-column: span 2 }` (was forcing 2/3 width + equal height)

These are all asserted by `apps/web/src/weread/wereadCenterLayout.test.ts`.

---

## RESPONSIVE RESULTS

Captured by `/tmp/weread-smoke.mjs` (puppeteer, headless). The token used for the
dashboard pass was the locally-configured `WEREAD_PRIVATE_API_TOKEN` from `.env`
— redacted in this report; no token value is embedded.

| Viewport | Page width | KPI cols | Main grid cols | Side cards (trend / privacy heights) | Horizontal scroll |
|---|---|---|---|---|---|
| 1440 × 900 | 1220 | 6 | 2 (778 / 389) | 859 / 121 | false |
| 1024 × 768 | 992  | 3 | 2 (627 / 313) | 859 / 121 | false |
| 800  × 1024 | 768  | 3 | 2 (~480 / ~240) | 895 / 141 | false |
| 480  × 800  | 460  | 2 | 1 | 1281 / 121 | false |
| 360  × 800  | 340  | 2 | 1 | 1281 / 121 | false |

Confirmed live in `weread-dashboard-*.png` screenshots under `reports/screenshots/`.

Notes:
- KPI grid `grid-template-columns` measured at runtime:
  - 1440 → `188px × 6` (6-col)
  - 1024 → `312px × 3` (3-col)
  - 480  → `214px × 2` (2-col)
  - 360  → `154px × 2` (2-col)
- `align-items: start` on `.weread-center-grid` is the key reason the privacy
  card stops at 121 px instead of stretching to match the 859 px trend card.
- Single column on mobile, no overflow.

---

## REGRESSION

| Check | Result | Notes |
|---|---|---|
| `npx vitest run` | ✅ 555 PASS / 0 FAIL | 532 pre-existing + 23 new in `wereadCenterLayout.test.ts` |
| `apps/web tsc --noEmit` | ✅ PASS | |
| `vite build` | ✅ PASS | 40.97 kB CSS, 308.03 kB JS |
| `pnpm verify` | ✅ PASS | `numberOfDocuments: 5115734` |
| `search-quality-regression` | ✅ 17 PASS / 0 WARN / 0 FAIL | |
| Docker build web only | ✅ PASS | api + meilisearch NOT rebuilt/restarted |

### New structural test coverage (`wereadCenterLayout.test.ts`, 23 cases)

- WereadCenter contains `NotesLibrary`
- All five required privacy phrases present
- Uses `<details>` / `<summary>` for the privacy block
- Exposes the 7 required data-testids (`weread-center-page`, `weread-kpi-grid`,
  `weread-center-grid`, `weread-notes-card`, `weread-side-rail`,
  `weread-privacy-card`, `weread-center-footer`)
- Exactly one `返回搜索` link (was 2 before)
- KPI uses `KPI_LABELS` for all 6 metrics
- No `dangerouslySetInnerHTML` anywhere
- NotesLibrary has three rows in order: search → filters → actions
- Search button has dedicated testid `weread-notes-search-button`
- Empty idle hint text + testid present
- Enter key still triggers search (`handleSearchKeyDown`)
- Load-more keeps `q` and filters (`fetchWereadNotes(token, { ...currentQuery, offset })`)
- Token change clears `q` and items (existing `useEffect [token]`)
- Page width regex: `max-width: 1220px` + `width: calc(100% - 32px)`
- Main grid contains `align-items: start`
- No `height: 100%` / `min-height: 100%` / `grid-auto-rows: 1fr` on weread grids
- KPI grid is `repeat(6, …)` on desktop, `repeat(3, …)` on tablet, `repeat(2, …)` on mobile
- Trend metric blocks use `repeat(2, …)` grid
- Main grid is `minmax(0, 2fr) minmax(0, 1fr)` (8/4 ratio)

---

## DEPLOYMENT

```
$ sudo docker compose up -d --no-deps --build web
...
Image book-id-search-web Built
Container book-id-search-meilisearch-1 Running
Container book-id-search-api-1 Running
Container book-id-search-web-1 Recreate
Container book-id-search-web-1 Recreated
Container book-id-search-web-1 Starting
Container book-id-search-web-1 Started
```

- `api` and `meilisearch` containers were NOT touched (verify + search-quality
  run against the same `127.0.0.1:3001` / `127.0.0.1:7700` they had before).
- Caddy reverse-proxy and DNS were NOT modified.
- The deployed JS bundle contains all required `data-testid` strings:
  ```
  weread-center-footer, weread-center-grid, weread-center-page,
  weread-kpi-grid, weread-notes-card, weread-notes-empty-idle,
  weread-notes-search-button, weread-notes-search-row,
  weread-privacy-card, weread-side-rail
  ```
- The deployed CSS bundle contains all new class names (verified by curl).

---

## BROWSER / MANUAL SMOKE

Captured by puppeteer at 5 breakpoints × 2 states (form + dashboard) =
10 PNG screenshots in `reports/screenshots/`.

| Screenshot | Width | State |
|---|---|---|
| `weread-form-desktop-1440.png` | 1440 | no-token form |
| `weread-form-tablet-1024.png`  | 1024 | no-token form |
| `weread-form-tablet-800.png`   | 800  | no-token form |
| `weread-form-mobile-480.png`   | 480  | no-token form |
| `weread-form-mobile-360.png`   | 360  | no-token form |
| `weread-dashboard-desktop-1440.png` | 1440 | token connected, dashboard |
| `weread-dashboard-tablet-1024.png`  | 1024 | token connected, dashboard |
| `weread-dashboard-tablet-800.png`   | 800  | token connected, dashboard |
| `weread-dashboard-mobile-480.png`   | 480  | token connected, dashboard |
| `weread-dashboard-mobile-360.png`   | 360  | token connected, dashboard |

Manual reading of the desktop-1440 dashboard capture:

- Page container spans the full 1220 px content width, centered within the
  1440 viewport.
- Six KPI cards in one row: 书架 (1,586) / 笔记 (6,989) / 已匹配书目 (323) /
  有笔记的匹配书 (37) / 有划线的匹配书 (34) / 已匹配笔记记录 (281), with a
  caption below showing match rate and average notes per book.
- Below the KPIs, two side-by-side panels: notes library on the left (~2/3
  width), reading trend on the right (~1/3 width).
- Trend panel contains 2-column grids for time windows (7/30/90/allTime) and
  type breakdown (划线 / 想法 / 书评 / 未知). 30-day bars span full width.
- Privacy disclosure is collapsed in the right rail, showing only the summary
  line by default; "展开隐私说明" expands the 5-item list.
- Single global footer at the bottom with one `返回搜索` link and a usage hint.
- No horizontal scroll at any of the 5 tested widths.

---

## FILES CHANGED

```
apps/web/src/weread/WereadCenter.tsx                 +121 / -53
apps/web/src/weread/NotesLibrary.tsx                 +83 / -59
apps/web/src/styles.css                              +217 / -141
apps/web/src/weread/wereadCenterLayout.test.ts       +217  (new)
reports/WEREAD_CENTER_LAYOUT_REPORT.md               this file (new)
reports/screenshots/weread-form-*.png                5 PNG (new)
reports/screenshots/weread-dashboard-*.png           5 PNG (new)
```

`apps/api`, Meilisearch, Caddy, nginx, DNS, `.env`, `private-data/`, `dist/`,
`logs/` — unchanged.

---

## PRIVACY RESULT

| Item | State |
|---|---|
| Token never logged in browser/network layer | ✅ unchanged |
| `Authorization: Bearer …` header preserved | ✅ unchanged |
| No `wereadBookId` / `noteId` / `highlightId` / note text in build | ✅ verified by `WEREAD_FORBIDDEN_WORDS` test still passing |
| `localStorage` never written | ✅ verified by `wereadPrivate.test.ts` |
| No token in shipped JS bundle | ✅ grep `WEREAD_PRIVATE_API_TOKEN` / `secret-token` etc. → 0 hits |
| No token / search term / note text in this report | ✅ |
| No screenshots committed (kept under `reports/screenshots/` only) | ✅ not staged |