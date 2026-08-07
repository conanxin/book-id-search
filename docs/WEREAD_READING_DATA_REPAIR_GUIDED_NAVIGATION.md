# S27S — WeRead Guided Reading Data Repair Navigation

> 微信读书「数据修复建议」面板新增**引导式导航（Guided Navigation）** 能力。该能力把 S27R 产出的「修复建议」从「静态只读建议」扩展为「由用户在浏览器内显式触发的、安全中性的页面内导航」。它**不是自动修复**：所有滚动、聚焦、视图切换都只能由用户点击 NavigationAction 触发；运行期白名单只允许命中当前 `WereadCenter` 中已存在的 7 个视图区域 + 1 个 `no_surface`（用于显式拒绝不存在的目标）；导航完成后只产出与「页面跳转」本身相关的中性 Feedback；不持久化任何会话，不写入任何存储，不修改 URL，不发起任何额外请求。

---

## 1. 功能范围

- 仅在 `/weread` 中心页「长期档案」工作区「数据修复建议」面板中出现。
- 输入对象是当前浏览器组件内存中已加载的「数据修复建议」（即 S27R 的 `runReadingDataRepairRecommendations()` 输出）。
- 引导式导航由浏览器内的纯函数 `runReadingDataRepairGuidedNavigation()` 执行，**不重新请求任何数据**（不重新调用 `/api/private/weread/annual-review` 或 `/related-books`），**不调用 MiniMax**，**不调用任何后端 endpoint**，**不写 localStorage / sessionStorage / IndexedDB**。
- 导航会话（Guided Session）只存在于当前浏览器组件内存中：卸载组件 / 关闭 tab / plan 语义改变时立即清空；不写入 Meilisearch，不写入任何持久层。
- 不读取笔记正文、笔记评论、章节标题、划线正文、AI 概要、token、私有 ID 等任何敏感字段。
- 不公开任何长期数据，不修改 URL，不发起任何网络请求。
- **引导式导航不是自动修复**：所有视图切换只能由用户对 `NavigationAction` 的真实点击触发；不存在任何自动滚动 / 自动聚焦 / 自动跳转；不存在「一键修复」、「自动修复成功」、「修复进度」等措辞。
- **引导式导航不评价用户本人**：所有 Feedback 保持「本次跳转是否完成」的中性口径；不出现「用户更爱阅读 / 兴趣增强 / 能力提升 / 阅读质量高 / 心理状态 / 人格 / 优秀 / 较差」等评价性语言。

---

## 2. Navigation Model（导航意图模型）

当前导航模型把 S27R 的 `RepairAction` 确定性地映射为 `NavigationIntent`，由 `runReadingDataRepairNavigationModel()` 在浏览器内纯函数执行。

### 2.1 决定性

- 给定相同「修复建议 + plan semantic」输入，**输出 NavigationIntent 集合是决定性的**：顺序、ID、`action`、`target`、`kind` 完全相同。
- 内部按 `(action asc, target asc, kind asc, sourceRepairAction asc, sourceRecommendationId asc)` 字典序排序，保证跨运行稳定。
- 所有位置字段（年度、rank 等）来自 S27R `Recommendation.position`，经 `safePosition()` 处理后再传入导航模型；**任何 title / author / catalogId / 真实 noteId / Recommendation ID / Issue ID 都不会进入导航模型**。

### 2.2 数量（当前实现）

| 维度 | 数量 |
|------|------|
| `NavigationTarget`（允许命中的视图区域） | 8（7 个真实已存在 surface + 1 个 `no_surface`） |
| `NavigationKind`（导航动作种类） | 3（`scroll` / `focus` / `noop`） |
| `RepairAction` 覆盖度 | 9（全部 S27R 动作；每个动作至少映射 1 个 Intent） |
| `RepairRecommendation → NavigationIntent` | 确定性的 1-N 映射，N ≥ 1 |

### 2.3 三种导航动作

| Kind | 含义 | 触发条件 |
|------|------|----------|
| `scroll` | 滚动到指定 surface 区域 | Action 命中对应 target 且 surface 真实存在 |
| `focus` | 聚焦到指定 surface 内首个交互元素 | Action 命中对应 target 且 surface 真实存在且包含 focusable 元素 |
| `noop` | 不执行任何 DOM 操作 | target = `no_surface`（用于显式拒绝不存在的目标） |

### 2.4 Action → Target 决定性映射

- 9 个 S27R `RepairAction` → 8 个 `NavigationTarget` 是决定性映射。
- 每个 Action 至少存在 1 个 Intent；带多 Surface 的 Action 会被映射为多个 Intent，每个 Intent 对应一个 verified surface。
- 任何不被允许的 Action / target 组合在编译期通过 TypeScript 类型系统排除，运行期不可达。

### 2.5 已知「当前不可达」分支

- `NavigationTarget.no_surface` 当前**永远**不会由 `RepairAction` 直接映射而来：所有 S27R Action 都至少存在 1 个已验证的 surface。
- `no_surface` 只在以下场景被使用：
  - 用户对当前 Action 点击触发 NavigationAction，但运行期发现该 surface 在当前页面中尚未挂载（如 plan 加载未完成）；
  - 运行期白名单校验拒绝；
  - 用户多次重复点击同一 Action 后页面已被卸载 / 切换 token。
- 上述场景会让当前 Intent 的实际执行落入 `noop`，并产出 `surface_unavailable` Feedback。
- 这是当前实现的**已知限制**，不是缺陷。

---

## 3. Surface Contract（视图区域契约）

引导式导航只允许命中当前 `WereadCenter` 中**真实已存在**的视图区域；任何对不存在区域、任意 CSS selector、或基于 DOM 推断的命中尝试在运行期一律被拒绝。

### 3.1 数量（当前实现）

| 维度 | 数量 |
|------|------|
| 已存在 verified surface | 7（来自 `WereadCenter` 工作区 + 子面板） |
| `no_surface` | 1（用于显式拒绝不存在的目标） |
| 合计 | 8 |

### 3.2 已存在 verified surface（按所在工作区归类）

| Surface 名称 | 所在工作区 | 主要内容 |
|--------------|------------|----------|
| `archive-overview-panel` | 长期档案 | 档案总览 |
| `archive-timeline-panel` | 长期档案 | 年度统计演变时间线 |
| `archive-audit-panel` | 长期档案 | 数据质量审计 |
| `archive-repair-recommendations-panel` | 长期档案 | 数据修复建议 |
| `annual-review-panel` | 长期档案 | 年度回顾 |
| `trends-panel` | 私有统计 | 阅读趋势 |
| `notes-panel` | 私有统计 | 私有笔记库 |

### 3.3 运行期硬编码白名单

- 引导式导航的运行期白名单是**编译期常量**：仅包含 §3.2 中的 7 个真实已存在 surface ID + `no_surface`。
- 任何不在白名单中的 `NavigationTarget` 在运行期被白名单校验拒绝：
  - 不执行任何 DOM 操作；
  - 产出 `surface_ambiguous` 或 `surface_unavailable` Feedback；
  - 不抛出运行期异常；
  - 不写入任何错误日志到生产可观测系统。
- 白名单不依赖 DOM 查询、不依赖 selector、不依赖 CSS class 名。

### 3.4 拒绝策略（fail closed）

引导式导航对所有不确定场景一律采用 **fail closed** 策略：

| 场景 | 行为 |
|------|------|
| 命中 surface 不在白名单 | 拒绝 → `surface_ambiguous` |
| 命中 surface 在白名单但当前页面未挂载 | 拒绝 → `surface_unavailable` |
| 同时存在多个同名 surface | 拒绝 → `surface_ambiguous` |
| Action → Target 映射不存在 | 拒绝 → `request_rejected` |
| 目标 surface 内无 focusable 元素 | 拒绝 → `surface_unavailable` |
| 目标 surface 已被卸载 | 拒绝 → `surface_unavailable` |

---

## 4. Explicit Trigger（显式触发）

引导式导航**只**响应用户对 `NavigationAction` 的真实点击。

### 4.1 唯一触发源

- 用户对「数据修复建议」面板中 `NavigationAction` 按钮的真实点击（pointerdown → pointerup → click）。
- 键盘 Enter / Space 在 `NavigationAction` 获得焦点时按下，等同于真实点击。

### 4.2 禁止的触发源

| 触发源 | 行为 |
|--------|------|
| 组件挂载 / 卸载 | 不触发 |
| 组件 rerender | 不触发 |
| `useEffect` / `useLayoutEffect` | 不触发 |
| 数据加载完成 / plan 改变 | 不触发 |
| hover / focus | 不触发 |
| 定时器 / `setTimeout` / `requestAnimationFrame` | 不触发 |
| 任何 `repairAction.click()` 自动调用 | 不触发 |

### 4.3 一次性保证

- 每次用户点击只产生一次导航尝试。
- 多次连续点击同一 `NavigationAction`：除首次外的点击进入静默拒绝（`request_rejected`），不重复滚动，不重复聚焦。

---

## 5. Runtime Safety（运行期安全）

引导式导航的运行期严格执行以下安全约束。

### 5.1 exactly-one Surface

- 每次导航尝试只能命中**恰好一个** surface。
- 同时存在多个候选 surface 时，运行期拒绝并产出 `surface_ambiguous`。

### 5.2 scroll once / focus once

- 每次成功的导航执行：
  - **滚动**：调用 1 次 `element.scrollIntoView({ behavior: 'smooth', block: 'start' })`。
  - **聚焦**：调用 1 次 `element.focus({ preventScroll: true })`。
- 多次重复调用被防抖拒绝。

### 5.3 缺失 surface fail closed

- surface 在白名单内但当前页面未挂载时，不创建 surface、不显示 fallback、不降级到其他 surface。
- 直接产出 `surface_unavailable` Feedback。

### 5.4 歧义 surface fail closed

- 同时存在多个同名 surface 时，不随机选择、不取第一个、不取最后一个。
- 直接产出 `surface_ambiguous` Feedback。

### 5.5 拒绝请求 fail closed

- Action → Target 映射不存在时，不执行任何操作。
- 直接产出 `request_rejected` Feedback。

---

## 6. Feedback（导航反馈）

引导式导航完成后，只产出与「本次页面跳转本身」相关的中性 Feedback。

### 6.1 Feedback Status（4 种状态）

| Status | 含义 | 触发场景 |
|--------|------|----------|
| `navigation_complete` | 导航成功 | scroll / focus 执行成功 |
| `surface_unavailable` | surface 在白名单内但当前未挂载 | plan 加载未完成 / surface 已被卸载 |
| `surface_ambiguous` | 同时存在多个同名 surface | 跨工作区同名 / 重复挂载 |
| `request_rejected` | 请求被运行期拒绝 | Action → Target 映射不存在 / 多次重复点击 |

### 6.2 Feedback Kind（3 种）

| Kind | 含义 | 适用 Status |
|------|------|-------------|
| `success` | 跳转完成 | `navigation_complete` |
| `warning` | 跳转未完成但环境正常 | `surface_unavailable` / `surface_ambiguous` |
| `error` | 请求被显式拒绝 | `request_rejected` |

### 6.3 Feedback 渲染规则

- 渲染位置：`WereadCenter` 的中性 Feedback 区域（与 S27L 现有的 feedback 共用）。
- `aria-live="polite"`，对屏幕阅读器友好。
- 文案严格中性：
  - 不出现「修复完成 / 数据已修复 / 修复成功」；
  - 不出现「您可以继续阅读 / 您已掌握 / 您已完成」；
  - 不出现「评价 / 评分 / 表现」；
  - 不出现「问题 / 错误」（使用「请求被拒绝」中性表述）。
- Feedback 在用户点击 NavigationAction 后 800 ms 内出现；超过 1500 ms 自动消失（不阻塞 UI）。

### 6.4 Feedback ≠ 修复结果

- `feedback.kind === "success"` **仅代表本次 NAVIGATION COMPLETE**，**不代表数据已被修复**。
- 数据修复建议的实际效果由用户在目标 surface 内的人工操作决定，与本次导航无关。
- 用户应基于 S27R 面板内的修复建议文本 + 目标 surface 内的人工操作结果来判断数据修复状态，**不应**基于 Feedback 文案判断。

---

## 7. Ephemeral Session（短暂会话）

引导式导航的会话状态只存在于当前浏览器组件内存中。

### 7.1 会话字段（确定性的内存计数）

| 字段 | 类型 | 含义 |
|------|------|------|
| `attempts` | `number` | 本会话内 NavigationAction 点击尝试总数（含失败） |
| `successful` | `number` | 本会话内 navigation_complete 总数 |
| `unavailable` | `number` | 本会话内 surface_unavailable 总数 |
| `ambiguous` | `number` | 本会话内 surface_ambiguous 总数 |
| `rejected` | `number` | 本会话内 request_rejected 总数 |

### 7.2 会话重置条件

| 条件 | 重置时机 |
|------|----------|
| plan 语义改变（S27R 重新加载） | 立即重置 |
| 当前组件 unmount | 立即重置 |
| tab 切换 / token 切换 / 关闭 tab | 立即重置 |

### 7.3 不持久化

- 会话字段**不写入** localStorage / sessionStorage / IndexedDB。
- 会话字段**不上传**到任何后端 endpoint。
- 会话字段**不进入** Meilisearch 索引。
- 会话字段**不进入** 任何 Markdown 导出。
- 会话字段**不进入** 任何 Telemetry / Analytics 事件。

---

## 8. Privacy（隐私保护）

引导式导航运行期严格遵守以下隐私约束。

### 8.1 不暴露的字段

| 字段 | 来源 |
|------|------|
| Recommendation ID | S27R |
| Issue ID | S27Q |
| `surfaceKey` | 内部 |
| `locator` | 内部 |
| 原始 request / result | 内部 |
| `actual` / `expected` | S27R |
| `title` / `author` / `catalogId` | 来源数据 |
| 真实 note ID | 来源数据 |
| token / API key | 来源数据 |

### 8.2 DOM 检查

- 引导式导航不向 DOM 注入任何 Recommendation ID / Issue ID / 真实 note ID / token。
- 引导式导航的 Feedback 文案不包含任何上述字段。
- 引导式导航的会话语义不暴露任何上述字段。

### 8.3 不记录的真实数据

本功能**绝不**记录用户的真实 Issue ID、真实年份、真实书目、真实笔记 ID。所有示例 / 测试 / 文档中的具体年份、书目均为合成数据。

---

## 9. Side-effect Boundary（副作用边界）

引导式导航运行期严格遵守以下副作用约束。

| 行为 | 是否允许 |
|------|----------|
| 发起新的网络请求 | ❌（navigation / feedback request delta = 0） |
| 写 localStorage / sessionStorage / IndexedDB | ❌ |
| 写 Meilisearch | ❌ |
| 修改 URL | ❌（URL mutation from S27S = 0） |
| 自动重试 / 重新加载 | ❌ |
| 上报 telemetry / analytics | ❌ |
| 自动滚动 / 自动聚焦 | ❌（只能由用户点击触发） |
| 自动修复 / 数据修改 | ❌（不调用任何修复 endpoint） |

---

## 10. Hook & React 安全性

| 组件 | hooks | 说明 |
|------|-------|------|
| `ReadingDataRepairRecommendationsPanel` | 0 | S27R 已固化的 0 hooks 不变 |
| `ReadingDataRepairNavigationFeedback` | 0 | 新组件，纯 props 渲染 |
| `ReadingDataRepairGuidedSessionController` | 1 useState / 0 useEffect | 仅持有会话语义状态 |
| `ReadingDataRepairNavigationAction` | 0 | 纯函数按钮组件 |

- 不存在任何 `useEffect` 自动触发导航。
- 不存在任何 `useLayoutEffect` 修改 DOM。
- React error #300 = 0。

---

## 11. 已知限制

- 引导式导航仅命中当前 `WereadCenter` 已挂载的 7 个视图区域；不命中任何其他子页面 / 其他路由 / 其他面板。
- 引导式导航在 plan 加载未完成时点击 NavigationAction 会落入 `surface_unavailable`；这是 fail closed 行为，不是缺陷。
- 引导式导航的会话不跨页面、不跨 tab、不跨 reload 保留。
- 引导式导航不修改 URL；不发起 `/related-books` / MiniMax / 其他后端 endpoint。
- 引导式导航不读取笔记正文 / 笔记评论 / 章节标题 / 划线正文 / AI 概要。
- 引导式导航的 Feedback 只描述本次跳转状态，不描述数据修复结果。
- 引导式导航的 S27S-2 / S27S-3 浏览器本地 smoke 受脚本 `waitForUrl` 仅支持 `http://` 的限制，目前只能在本地 vite preview 中运行；该限制是脚本层限制，不影响产品功能正确性。

---

## 12. 相关文档

- 数据修复建议模型：`docs/WEREAD_READING_DATA_REPAIR_RECOMMENDATIONS.md`
- 数据修复建议 Markdown 导出：`docs/WEREAD_READING_DATA_REPAIR_RECOMMENDATIONS_MARKDOWN.md`
- 长期档案：`docs/WEREAD_READING_ARCHIVE.md`
- 数据质量审计：`docs/WEREAD_READING_DATA_QUALITY_AUDIT.md`
- S27S 最终发布报告：`reports/WEREAD_READING_DATA_REPAIR_GUIDED_NAVIGATION_RELEASE_REPORT.md`