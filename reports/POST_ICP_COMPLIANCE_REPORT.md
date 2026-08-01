# POST-ICP-COMPLIANCE — Public ICP Record Footer

**Status:** PASS
**Date:** 2026-08-01
**Scope:** Add the real ICP record number to every page of the public site via a single shared SiteFooter.
**Branch:** main
**Tag target:** `v0.9.4-icp-compliance`
**Prior HEAD:** `ec2dbda` (S27D-UI-POLISH) — unchanged on `main`

---

## STATUS

**PASS** — All checks green. Browser smoke captured for home and `/weread` at
desktop (1440) and mobile (360); no horizontal scroll; ICP record link opens
MIIT record site in a new tab with `noopener noreferrer`; the page-level
`<footer>` in `WereadCenter.tsx` was retired so a single global `SiteFooter`
now owns the navigation.

```
vitest                577 PASS / 0 FAIL  (was 555, +22 new in SiteFooter.test.ts)
web tsc               PASS
vite build            PASS  (42.37 kB CSS / 309.23 kB JS)
pnpm verify           PASS  (docs = 5,115,734)
search-quality        17 PASS / 0 WARN / 0 FAIL
docker compose up web PASS  (api / meilisearch uptime NOT reset)
```

---

## ICP_RESULT

| Item | Value |
|---|---|
| ICP number configured | `京ICP备2026029682号` |
| ICP URL | `https://beian.miit.gov.cn/` |
| Public security record | **NOT filed** — `publicSecurityNumber = ""`; police block not rendered |
| Footer implementation | New global `SiteFooter` mounted at `App.tsx` root, shared by every route |
| Pages covered | `/` (home / search), `/weread`, `/books/:id` — all inherit the footer |
| MIIT link | Yes — `target="_blank"` `rel="noopener noreferrer"` |
| Browser smoke | 4 captures in `reports/screenshots/icp-*.png` (home + weread × desktop-1440 + mobile-360) |
| Manual smoke | Pending human verification (browser test IDs verified automatically) |

> Interpretation note: the task spec wrote the ICP number with surrounding
> angle brackets as visual decoration (`<京ICP备2026029682号>`). The validation
> regex `[<>]|填写|ICP备案号` is consistent with that reading. The literal
> ICP value committed to source is `京ICP备2026029682号` (no angle brackets).
> If the real filing differs, change one line in
> `apps/web/src/siteCompliance.ts` and rebuild.

---

## REGRESSION_RESULT

| Check | Result | Notes |
|---|---|---|
| `npx vitest run` | ✅ 577 PASS / 0 FAIL | 555 pre-existing + 22 new in `SiteFooter.test.ts` |
| `apps/web tsc --noEmit` | ✅ PASS | |
| `vite build` | ✅ PASS | 42.37 kB CSS, 309.23 kB JS |
| `pnpm verify` | ✅ PASS | `numberOfDocuments: 5115734` |
| `search-quality-regression` | ✅ 17 PASS / 0 WARN / 0 FAIL | |
| Docker build web only | ✅ PASS | api + meilisearch NOT rebuilt / restarted |

### New structural test coverage (`SiteFooter.test.ts`, 22 cases)

- `icpNumber` set and non-empty
- `icpNumber` does not contain `<>` / `填写` / `ICP备案号` placeholders
- `icpNumber` matches `^[^\s]+?ICP备\d+号(-\d+)?$` (Chinese ICP format)
- `icpUrl` is exactly `https://beian.miit.gov.cn/`
- `publicSecurityNumber` is empty (must NOT be fabricated)
- `publicSecurityUrl` is empty when publicSecurityNumber is empty
- No identity-document words in config file
- SiteFooter renders the ICP record link via `SITE_COMPLIANCE.*`
- ICP `<a>` has `target="_blank"` and `rel="noopener noreferrer"`
- Police record block is wrapped in `{hasPoliceRecord ? (...) : null}` so it
  renders ONLY when `publicSecurityNumber` is non-empty
- SiteFooter renders the "返回搜索" navigation link with testid
- SiteFooter does NOT use `dangerously…` (no unescaped HTML injection)
- SiteFooter exposes testids for footer, records
- SiteFooter does NOT contain identity-material words
- `App.tsx` imports `SiteFooter`
- `App.tsx` renders `<SiteFooter />` inside the same JSX root as `<Routes>`
  (every route inherits the footer)
- Exactly one `<a>...返回搜索...</a>` link across the entire `apps/web/src`
- `App.tsx` separately uses `返回搜索结果` (results heading, NOT a link)
- `.site-footer` block exists in CSS
- Footer has no `position: fixed` / `position: sticky`
- Footer inner width matches the S27D-UI-POLISH contract
  (`max-width: 1220px; width: calc(100% - 32px)`)
- Footer wraps on mobile (`@media (max-width: 720px) flex-direction: column`)

Additionally the existing `wereadCenterLayout.test.ts` was updated:
- The previous "renders exactly one 返回搜索 link" test was retired (the
  `WereadCenter.tsx` source no longer carries one — the global `SiteFooter`
  is the sole provider).
- Replaced with: "does not render its own 返回搜索 — the global SiteFooter
  owns it" (asserts zero occurrences in the file).

---

## DEPLOY_RESULT

```
$ sudo docker compose up -d --no-deps --build web
...
Container book-id-search-meilisearch-1 Running
Container book-id-search-api-1 Running
Container book-id-search-web-1 Recreate
Container book-id-search-web-1 Recreated
Container book-id-search-web-1 Started

$ sudo docker compose ps
book-id-search-api-1           Up 3 weeks      (untouched)
book-id-search-meilisearch-1   Up 4 weeks      (untouched)
book-id-search-web-1           Up 13 seconds   (rebuilt)
```

- `api` and `meilisearch` uptime was NOT reset.
- Caddy / DNS / nginx `private access_log` were NOT modified.
- Web container rebuilt with the new `dist/` (CSS+JS hash bumped).

### Online bundle verification

```
asset      = /assets/index-CZf-ttDo.js
home_http  = 200
weread_http= 200
bundle_size= 305 626 bytes

grep "京ICP备2026029682号"      bundle.js → 1 hit  ✅
grep "https://beian.miit.gov.cn/" bundle.js → 1 hit ✅
grep "site-footer" testids     bundle.js → all 5 present ✅

GET /api/health     200  {"ok":true,"meili":{"status":"available"},"index":"books"}
GET /api/stats      200  numberOfDocuments=5115734
GET /api/search?q=北京旅游 200  total=1869555
```

---

## BROWSER / MANUAL SMOKE

Captured by puppeteer at 2 viewports × 2 pages = 4 full-page PNGs in
`reports/screenshots/icp-{home,weread}-{desktop-1440,mobile-360}.png`.

| Page / viewport | Footer dims | ICP dims | ICP attrs | Horizontal scroll |
|---|---|---|---|---|
| home / desktop-1440 | 1440 × 59 @ y=685 | 148 × 18 @ y=706 | href=MIIT, target=_blank, rel=noopener noreferrer | false |
| home / mobile-360   | 360 × 115 @ y=987 | 148 × 18 @ y=1040 | href=MIIT, target=_blank, rel=noopener noreferrer | false |
| weread / desktop-1440 | 1440 × 59 @ y=1539 | 148 × 18 @ y=1560 | href=MIIT, target=_blank, rel=noopener noreferrer | false |
| weread / mobile-360 | 360 × 115 @ y=2818 | 148 × 18 @ y=2871 | href=MIIT, target=_blank, rel=noopener noreferrer | false |

- `police` element: `null` on all four pages (block correctly suppressed
  because `publicSecurityNumber` is empty).
- `返回搜索` link: present on every page, points to `/`.
- ICP link: opens MIIT in a new tab; safe `noopener noreferrer`.

### Pending human verification

The automated smoke covers layout, attributes, and reachability. The task
spec asks for visual confirmation of:
- clicking the ICP record opens the MIIT site (anchor attrs verified; click
  itself requires human browser interaction)
- `/weread` private token + notes search still works end-to-end (no code
  paths touched; structural tests cover the toolbar contract)

These can be confirmed manually at `https://books.conanxin.com/weread`.

---

## PRIVACY_RESULT

| Item | State |
|---|---|
| No identity documents (身份证 / 户口本 / 备案申请截图) | ✅ |
| No phone numbers (188 / 156 / etc.) | ✅ (only false positives in `@types/node` timestamps; nothing committed) |
| No home address | ✅ |
| No ICP application order number | ✅ |
| No private token / private-data committed | ✅ (`apps/api`, `private-data/`, `data/weread-private/` not touched) |
| No `apps/web/dist` committed | ✅ (only rebuilt inside the container) |
| No `reports/screenshots/` committed | ✅ (kept local) |
| No new dependencies | ✅ (`git diff -- package.json` is empty) |
| Public ICP number only (publicly required by MIIT) | ✅ |
| Public security record is empty (NOT fabricated) | ✅ |

---

## FILES CHANGED

```
apps/web/src/siteCompliance.ts                 +23   (new)
apps/web/src/components/SiteFooter.tsx         +57   (new)
apps/web/src/components/SiteFooter.test.ts     +187  (new)
apps/web/src/styles.css                        +75   (footer block appended)
apps/web/src/App.tsx                           +3 / -1   (import + render SiteFooter)
apps/web/src/weread/WereadCenter.tsx           +1 / -10  (page-level footer retired)
apps/web/src/weread/wereadCenterLayout.test.ts +5 / -2   (one assertion updated)
reports/POST_ICP_COMPLIANCE_REPORT.md          this file (new)
reports/screenshots/icp-*.png                  4 PNG (new, local-only)
```

Untouched: `apps/api/`, `meilisearch`, `Caddyfile`, `docker-compose.yml`,
`apps/web/nginx.conf`, `apps/web/Dockerfile`, `.env`, `private-data/`,
`data/weread-private/`, `apps/web/dist/`, `reports/screenshots/` (in commit
boundary — kept local).

---

## HUMAN_ACTION_REQUIRED

- 公网安备（公安部互联网信息服务备案）应在 ICP 备案完成后尽快办理；
  取得备案号前页面不得展示或虚构任何公安备案记录（当前 `publicSecurityNumber = ""`，
  公安备案区块已被条件渲染完全抑制）。
- 如实际 ICP 备案号与本报告不一致，请修改
  `apps/web/src/siteCompliance.ts` 唯一一行 `icpNumber`，重新构建并部署 web。
- 浏览器人工验收（点击 ICP 链接跳转工信部、私有 token 流程未受影响）请在
  `https://books.conanxin.com/` 与 `https://books.conanxin.com/weread` 上手动确认。

---

## NEXT_STEP

- 公安联网备案 (Public security network record)
- S27E private AI notes summarisation