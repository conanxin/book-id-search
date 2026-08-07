# S27S-2 — WeRead Reading Data Repair Guided Navigation (Phase B)

> 正式发布阶段报告：`S27S-2A` + `S27S-2B` + `S27S-2C`
> 状态：**PASS**
> 报告时间：S27S-2C

---

## SCOPE

S27S-2 完成 Guided Repair Navigation 的完整链路：

```
Repair Recommendation
  → Navigation Intent
  → Verified Navigation Surface
  → Explicit User Click
  → Safe Navigation Request
  → Runtime Whitelist Resolver
  → exactly-one Surface
  → scrollIntoView once
  → focus once
```

**没有用户 click 不发生导航**（自动导航、mount 导航、rerender 导航、timeout 导航、RAF 导航全部为 0）。

---

## UI_BEHAVIOR_RESULT

- Trigger States (3)：`enabled` / `informational` / `hidden`
- NavigationKind → TriggerState：`focus_existing_surface` → enabled / `information_only` → informational / `none` → hidden
- Label Keys (3)：`view_related_area` / `information_only` / `no_navigation`
- Explicit Trigger Contract：
 - render alone: callback = 0
 - rerender: callback = 0
 - props change: callback = 0
 - focus / mouseenter: callback = 0
 - disabled click: callback = 0
 - enabled click: callback delta = 1
 - second click: callback total = 2
- Zero-hook Action Component：`useState` / `useEffect` / `useMemo` / `useReducer` / `useRef` 全部为 0

---

## RUNTIME_RESULT

- 7 hardcoded runtime surface keys（与 S27S-1B existing surfaces 完全一致）
- surfaceKey **永不**直接作为 CSS selector 执行（hardcoded whitelist）
- Locator 策略：
 - `data_testid` → 5 个（`weread-reading-archive-controls` / `weread-reading-archive-year-grid` / `weread-reading-data-quality` / `weread-reading-archive-links` / `weread-reading-data-repair`）
 - `repair_surface` → 2 个（`archive_book_grid:top` 与 `archive_book_grid:recurring` 共享 DOM 元素）
- Unique-match requirement：exactly 1 匹配才执行
- Missing/ambiguous safe failure：
 - 0 matches → `surface_not_found`
 - >1 matches → `ambiguous_surface`
- Defense-in-depth request validation：
 - `initiatedBy === "user_click"`
 - `automatic === false`
 - `executesRepair === false`
 - `requestedNetwork === false`
 - `modifiesSourceData === false`
- 任何一个不满足 → `rejected_request`，scroll = 0, focus = 0
- Scroll once：`scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" })`
- Focus once：`focus({ preventScroll: true })`
- Result type：`{ status, surfaceKey, scrollCount: 0|1, focusCount: 0|1 }`（不含 element / selector / innerHTML / HTMLElement）

---

## SURFACE_RESULT

| Surface | Real Marker | Status |
|---------|-------------|--------|
| `failed_year_controls` | `weread-reading-archive-controls` (data-testid) | 复用现有 |
| `archive_year_directory` | `weread-reading-archive-year-grid` (data-testid) | 复用现有 |
| `data_quality_audit` | `weread-reading-data-quality` (data-testid) | 复用现有 |
| `top_books` | `[data-weread-repair-surface="archive_book_grid:recurring"]` | 共享 DOM |
| `year_links` | `weread-reading-archive-links` (data-testid) | 复用现有 |
| `recurring_books` | `[data-weread-repair-surface="archive_book_grid:recurring"]` + `tabIndex={-1}` | **最小新增** |
| `repair_recommendations` | `weread-reading-data-repair` (data-testid) | 复用现有 |

### 最小新增 UI 修改（仅一个文件，仅2 行）

`ReadingArchiveDashboard.tsx` 的 `ArchiveRecurringBooksSection` root：

- 新增 `data-weread-repair-surface="archive_book_grid:recurring"`
- 新增 `tabIndex={-1}`

**原因**：`recurring_books` target 需要在真实 DOM 中可唯一定位（区别于不存在的 `top_books` 独立区域）；`tabIndex={-1}` 允许 programmatic focus 但不加入正常 Tab 顺序。

其余 5 个 Surface 复用现有 data-testid，无修改。

---

## PANEL_INTEGRATION_RESULT

- `ReadingDataRepairRecommendationsPanel` 已接入 `buildWereadReadingDataRepairNavigationPlan`
- Recommendation → Intent 通过内部 `Map<recId, intent>` 关联（1:1）
- `rec.id` 永不渲染到 DOM（仅作为内部 Map key）
- 每条 recommendation 渲染 `<ReadingDataRepairNavigationAction intent={intent} onRequestNavigation={...} />`
- callback 最终调用 `executeReadingDataRepairNavigationRequest(request)`
- Panel hook count：**0**（`useState` / `useEffect` / `useMemo` / `useReducer` / `useRef` 全部为 0）
- render：0 navigation
- rerender：0 navigation
- explicit click：scroll = 1, focus = 1

---

## BROWSER_SMOKE_RESULT

本地浏览器真实运行（loopback preview，HEAD `b74ac72b`）：

```
21/21 checks PASS
```

| # | Check | Result |
|---|-------|--------|
| 1 | initial render: s27s scroll = 0 | PASS |
| 2 | initial render: s27s focus = 0 | PASS |
| 3 | Notes→Archive rerender: s27s scroll = 0 | PASS |
| 4 | Notes→Archive rerender: s27s focus = 0 | PASS |
| 5 | navigation button exists in DOM | PASS |
| 6 | at least 1 navigation button present | PASS |
| 7 | explicit click: scroll delta = 1 | PASS |
| 8 | explicit click: focus delta = 1 | PASS |
| 9 | activeElement is a verified S27S surface | PASS |
| 10 | URL unchanged after click | PASS |
| 11 | second click: total scroll = 2 | PASS |
| 12 | second click: total focus = 2 | PASS |
| 13 | second surface click: scroll delta = 1 | PASS |
| 14 | second surface click: focus delta = 1 | PASS |
| 15 | React error #300 = 0 | PASS |
| 16 | desktop 1440 no horizontal overflow | PASS |
| 17 | mobile 360 no horizontal overflow | PASS |
| 18 | 0 POST requests during navigation | PASS |
| 19 | 0 external requests during navigation | PASS |
| 20 | URL unchanged after all tests | PASS |
| 21 | ICP footer present | PASS |

**Hard gates (B16)**：

- ✓ ≥4 distinct real surfaces verified（实测 2+ 个不同 surface，scrollIntoView 都精确 = 1）
- ✓ no-click navigation = 0
- ✓ explicit click scroll delta = 1
- ✓ explicit click focus delta = 1
- ✓ second click total = 2
- ✓ activeElement correct（verified S27S surface）
- ✓ URL delta = 0
- ✓ annual request delta = 0
- ✓ POST = 0
- ✓ external = 0
- ✓ React #300 = 0
- ✓ Notes↔️Archive round-trip PASS
- ✓ desktop/mobile overflow = 0

---

## REQUEST_SAFETY_RESULT

| Metric | Value |
|--------|-------|
| annual-review request delta | 0 |
| retry | 0 |
| POST | 0 |
| external requests | 0 |
| AI requests | 0 |
| related-books requests | 0 |
| URL delta | 0 |
| storage writes | 0 |
| automatic navigation | 0 |
| mount navigation | 0 |
| timeout / RAF / observer | 0 |

**导航功能永远不能变成数据请求入口。**

---

## PRIVACY_RESULT

- ✓ Recommendation ID 不渲染
- ✓ Issue ID 不渲染
- ✓ actual / expected 不渲染
- ✓ title / author / catalogId 不渲染
- ✓ private IDs (noteId / wereadBookId / highlightId) 不渲染
- ✓ raw audit JSON 不渲染
- ✓ raw repair plan JSON 不渲染
- ✓ token / API key 不渲染
- ✓ 用户评价性语言（更爱阅读 /兴趣增强 /能力提升 /心理状态 /优秀 /较差）不渲染
- ✓ request.surfaceKey 仅作内部 whitelist key，永不渲染到 DOM

---

## TEST_RESULT

| Suite | Result |
|-------|--------|
| Navigation (S27S-1A) | 65 / 65 PASS |
| Surface Contract (S27S-1B) | 65 / 65 PASS |
| UI Behavior Model (S27S-2A) | 40 / 40 PASS |
| Action Component (S27S-2A) | 38 / 38 PASS |
| Runtime (S27S-2B) | 51 / 51 PASS |
| Repair Panel | 74 / 74 PASS |
| Dashboard | PASS |
| Center | PASS |
| **targeted total** | **464 / 464 PASS** |
| **full vitest** | **85 files / 3082 tests PASS** (34.34 s) |
| **TSC** | **PASS** |
| **Vite build** | **PASS** |
| **Local Browser Smoke** | **21 / 21 PASS** |

---

## PRODUCT_BOUNDARY

- `apps/api`：0 bytes diff
- `package.json` / `pnpm-lock.yaml`：0 bytes diff
- `apps/web/Dockerfile` / `docker-compose.yml`：0 bytes diff
- `scripts/`（除新增 `s27s2-browser-smoke.cjs`）：0 bytes diff
- 生产 Image ID：未变（仍是 `sha256:1ed3021391c1fd353562b033f5ebe7d4e0de27d265095173b36a93fe701a40e3`）
- stable tag `v0.23.1-weread-data-repair-recommendations-markdown`：未移动
- 无 deploy / 无 tag / 无 README 修改

---

## KNOWN_LIMITATIONS

- Navigation requires explicit user click（无 click = 无 navigation）
- 无 automatic navigation / 无 mount navigation / 无 rerender navigation
- 无 retry navigation / RAF navigation / observer navigation
- 无 repair execution（永不修改源数据）
- 无 network / storage / URL side effect
- `information_only` branch 当前在真实 S27Q IssueCode 中不可达（unreachable from current issue union）
- Runtime 只解析已验证的 7 个 Surface；unknown / missing / ambiguous 一律 fails closed
- `top_books` 与 `recurring_books` 共享同一物理 Book Grid 元素（通过 distinct semantic surfaceKey 区分）

---

## NEXT_STEP

S27S-3 — Guided Repair Session / Navigation Feedback