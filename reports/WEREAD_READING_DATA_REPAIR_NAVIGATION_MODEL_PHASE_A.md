# S27S-1 — WeRead Reading Data Repair Navigation Model (Phase A)

> 正式模型阶段报告：`S27S-1A` + `S27S-1B`
> 状态：**PASS**
> 报告时间：S27S-1C

---

## SCOPE

S27S-1 建立两层基础能力：

1. `Repair Recommendation` → `Navigation Intent` → `Navigation Target`（S27S-1A）
2. `Navigation Target` → verified existing `Navigation Surface`（S27S-1B）

本阶段**仅描述引导关系**（semantic mapping），不执行任何导航行为：

- ✗ 不自动滚动（`scrollIntoView`）
- ✗ 不 focus（`element.focus()`）
- ✗ 不 query DOM（`querySelector` / `getElementById`）
- ✗ 不修改 URL / hash / history
- ✗ 不调用 fetch / XHR / WebSocket
- ✗ 不写 storage（`localStorage` / `sessionStorage` / `IndexedDB`）
- ✗ 不执行 retry / reload
- ✗ 不执行任何 repair
- ✗ 不修改源数据
- ✗ 不依赖 React / DOM / framework globals

---

## NAVIGATION_MODEL_RESULT（S27S-1A）

| 维度 | 数量 |
|------|------|
| `ReadingDataRepairAction`（输入） | 9 |
| `ReadingDataRepairNavigationTarget`（中间） | 8 |
| `ReadingDataRepairNavigationKind`（中间） | 3 |
| Navigation Plan / Selectors / Debug Snapshot | 3 / 3 / 1 |

### Action → Target（exhaustive Record，编译期穷尽）

| Action | Target |
|---------|--------|
| `retry_failed_year` | `failed_year_controls` |
| `reload_year` | `archive_year_directory` |
| `inspect_source_data` | `data_quality_audit` |
| `review_metric_relationship` | `data_quality_audit` |
| `review_top_book_metadata` | `top_books` |
| `review_year_link` | `year_links` |
| `review_recurring_aggregation` | `recurring_books` |
| `unsupported_with_current_fields` | `repair_recommendations` |
| `no_action_required` | `none` |

### Action → Kind（exhaustive Record，编译期穷尽）

| Action | Kind |
|---------|------|
| `retry_failed_year` | `focus_existing_surface` |
| `reload_year` | `focus_existing_surface` |
| `inspect_source_data` | `focus_existing_surface` |
| `review_metric_relationship` | `focus_existing_surface` |
| `review_top_book_metadata` | `focus_existing_surface` |
| `review_year_link` | `focus_existing_surface` |
| `review_recurring_aggregation` | `focus_existing_surface` |
| `unsupported_with_current_fields` | `information_only` |
| `no_action_required` | `none` |

### Navigation Intent 字段

- 必填：`sourceIssueCode` / `action` / `capability` / `target` / `kind`
- 可选：`year` / `fromYear` / `toYear` / `itemIndex` / `rank`
- 安全 flag：`automatic=false` / `executesRepair=false` / `requestedNetwork=false` / `modifiesSourceData=false`

### Navigation Plan

- `intents`：1:1 映射，`plan.recommendations` 原序
- `summary.total / focusable / informational / none`
- `targetCounts`：8 个键永远存在（即使 count=0）
- Selectors：`selectFocusableRepairNavigationIntents` / `selectInformationalRepairNavigationIntents` / `selectRepairNavigationIntentsForTarget`
- Safe Debug Snapshot：allowlist 12 个键（`total` / `summary` / `targetCounts` / `actions` / `capabilities` / `targets` / `kinds` / `sourceIssueCodes` / `years` / `fromYears` / `toYears` / `meta`）

---

## SURFACE_AUDIT_RESULT（S27S-1B）

7 个真实 Navigation Surface 已全部确认存在，全部复用现有 UI 标识，**无需新增任何 UI marker**：

| Target | Real Surface (data-testid) | Status |
|--------|----------------------------|--------|
| `failed_year_controls` | `weread-reading-archive-controls` | VERIFIED_EXISTING_SURFACE |
| `archive_year_directory` | `weread-reading-archive-year-grid` | VERIFIED_EXISTING_SURFACE |
| `data_quality_audit` | `weread-reading-data-quality` | VERIFIED_EXISTING_SURFACE |
| `top_books` | `archive_book_grid:top`（sub-key on `weread-reading-archive-book-grid`） | VERIFIED_EXISTING_SURFACE |
| `year_links` | `weread-reading-archive-links` | VERIFIED_EXISTING_SURFACE |
| `recurring_books` | `archive_book_grid:recurring`（sub-key on `weread-reading-archive-book-grid`） | VERIFIED_EXISTING_SURFACE |
| `repair_recommendations` | `weread-reading-data-repair` | VERIFIED_EXISTING_SURFACE |
| `none` | — | NO_SURFACE_BY_DESIGN |

### `top_books` 与 `recurring_books` 共享 Book Grid 的说明

这两个 NavigationTarget 在当前 Dashboard 中**确实共享同一个物理组件**（`ArchiveRecurringBooksSection`，标记为 `weread-reading-archive-book-grid`）。原因：

- 当前 Dashboard **没有**单独的"年度 Top N"聚合区（年度 Top N 仅在 per-year annual review 中可见）；
- `ArchiveRecurringBooksSection` 是当前唯一聚合显示 Top N 数据的区域，且标题语义包含"多年进入 Top N 高互动榜的书目"；
- `top_books` 与 `recurring_books` 是**语义不同的 intent**（年度 Top N 元数据核对 vs 多年 Recurring 聚合核对），因此 Surface Contract 使用**不同的 surfaceKey**（`archive_book_grid:top` vs `archive_book_grid:recurring`），保持 contract 唯一性；
- Contract surfaceKey 的语义标识与物理组件解耦：未来若 Dashboard 新增独立的年度 Top N 聚合区，`top_books` 的 surfaceKey 可迁移到新 data-testid 而 `recurring_books` 保持不变。

---

## SURFACE_CONTRACT_RESULT

- NavigationTarget：8 个
- `existing_surface`：7 个
- `no_surface`：1 个（`none`）
- 7 个 surfaceKey 全部唯一（编译期 + 运行期双验证）
- 无 CSS selector 依赖
- 无 URL / hash 依赖
- 无 element ID 依赖（surfaceKey 是语义标识，不是 DOM ID）
- `Record<ReadingDataRepairNavigationTarget, ReadingDataRepairNavigationSurfaceContract>` 编译期穷尽：**PASS

---

## CROSS_MODEL_RESULT

完整链路：

```
RepairAction (9)
  → NavigationTarget (8)
  → NavigationSurface (7 existing + none)
```

### 链路口径（9 条全部覆盖）

| # | Action | Target | Surface | Kind |
|---|--------|--------|---------|------|
| 1 | `retry_failed_year` | `failed_year_controls` | existing | `focus_existing_surface` |
| 2 | `reload_year` | `archive_year_directory` | existing | `focus_existing_surface` |
| 3 | `inspect_source_data` | `data_quality_audit` | existing | `focus_existing_surface` |
| 4 | `review_metric_relationship` | `data_quality_audit` | existing | `focus_existing_surface` |
| 5 | `review_top_book_metadata` | `top_books` | existing | `focus_existing_surface` |
| 6 | `review_year_link` | `year_links` | existing | `focus_existing_surface` |
| 7 | `review_recurring_aggregation` | `recurring_books` | existing | `focus_existing_surface` |
| 8 | `unsupported_with_current_fields` | `repair_recommendations` | existing | `information_only` |
| 9 | `no_action_required` | `none` | no_surface | `none` |

### 跨模型不变量（运行期 + 编译期双验证）

1. **focusable invariant**：所有 `kind=focus_existing_surface` 的 intent 都解析到 `availability=existing_surface` 的 Contract。
2. **informational invariant**：所有 `kind=information_only` 的 intent 解析到 `availability=existing_surface` 的 Contract，但 `automatic=false` 且 kind 保持 `information_only`（不会被自动 focus）。
3. **none invariant**：`no_action_required` → `target=none` → `availability=no_surface`。
4. **unsupported invariant**：`unsupported_with_current_fields` → `target=repair_recommendations` → `availability=existing_surface` → `kind=information_only`。
5. **9/9 Action 全覆盖**：链路上无缺口。

---

## PLAN_RESULT

### Navigation Plan（S27S-1A）

- `intents`：1:1 映射（每个 Recommendation → 1 个 Intent）
- 顺序：保持 `plan.recommendations` 原序，**不重新排序**
- 不修改输入
- `summary.total / focusable / informational / none`
- `targetCounts`：8 个键永远存在
- Selectors 返回新数组，不修改 plan，无副作用

### Surface Plan（S27S-1B）

- `contracts`：每个 Intent 对应一个 Contract（克隆，不共享引用）
- `summary.total / existingSurface / noSurface / focusableSurface / informationalSurface`
- `surfaceCounts`：7 个真实 surfaceKey + `__no_surface__` 永远存在
- 不修改输入

---

## SAFETY_RESULT

固定记录：

- `automatic = false`（never auto-navigate）
- `executesRepair = false`（never repair）
- `requestedNetwork = false`（never network）
- `modifiesSourceData = false`（never mutate data）

模型**不使用**：

- DOM（`window` / `document` / `navigator` / `querySelector` / `getElementById` / `scrollIntoView` / `focus()`）
- URL / hash / history
- Storage（`localStorage` / `sessionStorage` / `IndexedDB`）
- Network（`fetch` / `XHR` / `WebSocket`）
- `retry()` / `reload()`
- React / DOM / browser globals

源码安全扫描（S27S-1A + S27S-1B 两个生产模型文件）：**实际代码命中 0**（仅存在说明性 docstring 注释）。

---

## PRIVACY_RESULT

### 允许字段

- enum 类型（Action / Target / Kind / Capability / IssueCode / Severity / Scope / Priority）
- 安全 locator：`year` / `fromYear` / `toYear` / `itemIndex` / `rank`
- 计数（actionCounts / capabilityCounts / targetCounts / surfaceCounts / summary）

### 排除字段

- Recommendation ID
- Issue ID
- `actual` / `expected`
- `title` / `author` / `catalogId`
- 笔记正文 / 笔记评论 / 章节标题 / 划线正文
- `noteId` / `wereadBookId` / `highlightId` 等私有 ID
- token / API key
- raw recommendation / raw repair plan / raw audit
- DOM selector / element ID / URL / hash
- 用户评价性语言

---

## TEST_RESULT（真实复跑）

| 阶段 | 测试 |
|------|------|
| `wereadReadingDataRepairNavigation.test.ts`（S27S-1A） | 65 / 65 PASS |
| `wereadReadingDataRepairNavigationSurfaces.test.ts`（S27S-1B） | 65 / 65 PASS |
| **targeted total** | **130 / 130 PASS** |
| **full vitest** | **82 files / 2953 tests PASS**（31.41 s） |
| **TSC** | **PASS**（`apps/web/tsconfig.json --noEmit` exit 0） |

---

## PRODUCT_BOUNDARY

本阶段**不修改**任何产品源码：

- S27R Recommendation Model：**未修改**
- S27Q Audit Model：**未修改**
- Dashboard / Repair Panel / 其他 UI：**未修改**
- 没有新增 `data-testid` / marker
- `apps/api`：0 bytes diff
- `package.json` / `pnpm-lock.yaml`：0 bytes diff
- `apps/web/Dockerfile` / `docker-compose.yml`：0 bytes diff
- `scripts/`：0 bytes diff
- 无 deploy / 无 tag / 无 README 修改

---

## KNOWN_LIMITATIONS

- Navigation Intent + Surface Contract 是**纯语义层**，不触发任何 UI 行为
- 不滚动、不 focus、不执行 retry/reload
- 没有"显式用户导航控制"按钮（这是后续 S27S-2 阶段的工作）
- `unsupported_with_current_fields` 仍是 `information_only`（不引导到真实 surface）
- `no_action_required` 没有 surface（`no_surface`）
- `top_books` 与 `recurring_books` 共享 Book Grid 物理组件，通过不同 semantic sub-key 区分（未来 Dashboard 若新增独立年度 Top N 区可独立迁移）

---

## NEXT_STEP

S27S-2A — Explicit Guided Navigation Trigger and UI Behavior Contract