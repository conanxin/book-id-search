# S27R — WeRead Long-term Reading Data Repair Recommendations

> 微信读书「长期档案」工作区内置**第 7 个子面板「数据修复建议」**。该面板把当前浏览器已经审计完成的「数据质量审计」结果当作一份**已知的、可对账的**数据集，按年份范围、年份闭合、年度指标、Top N 公共元数据、YearLink 相邻链接、Recurring 聚合六个审计分组中的 Issue，**确定性地**映射成**中性的修复建议**。它不新增后端 endpoint，不调用 MiniMax，不读取笔记正文，不持久化建议结果，不执行任何修复动作，不修改源数据。

---

## 1. 功能范围

- 仅在 `/weread` 中心页「长期档案」工作区内出现，作为面板组件：「数据修复建议」。
- 输入对象是当前浏览器组件内存中已经加载的「数据质量审计」结果（即 S27Q 的 `runReadingDataQualityAudit()` 输出，由当前 `ReadingArchiveView` 数据派生）。
- 建议映射由纯函数 `runReadingDataRepairRecommendations()` 在浏览器中执行，**不重新请求任何数据**（不重新调用 `/api/private/weread/annual-review`），**不调用 MiniMax**，**不调用 `/related-books`**，**不写 localStorage / sessionStorage / IndexedDB**。
- 建议结果只在当前浏览器组件内存中存在：切换 token / 卸载组件 / 关闭 tab 时立即清空；不写入 Meilisearch。
- 不读取笔记正文、笔记评论、章节标题、划线正文、AI 概要、token、私有 ID 等任何敏感字段。
- 不公开任何长期数据，不写入 Meilisearch，不修改 URL。
- **支持浏览器本地 Markdown 导出**（S27R-3，见 `WEREAD_READING_DATA_REPAIR_RECOMMENDATIONS_MARKDOWN.md`）。
- **建议不是自动修复**：所有建议都是中性的「建议由现有界面处理」/「需要人工核对」/「当前字段不足」三档之一；面板内**不存在任何执行修复动作的按钮**；不存在「一键修复」、「自动修复成功」、「修复进度」等措辞。
- **建议不评价用户本人**：所有文字保持「数据是否自洽、是否对得上、当前字段能否承载该建议」的中性口径；不出现「用户更爱阅读 / 兴趣增强 / 能力提升 / 阅读质量高 / 心理状态 / 人格 / 优秀 / 较差」等评价性语言。

---

## 2. 建议模型（`repairRecommendationModel`）

当前模型基于审计 IssueCode 字典，确定性地把每条审计 Issue 映射为一条修复建议。建议模型本身**不读取、不解析、不重新生成任何原始数据**，只接受「审计 Issue + 必要的安全位置字段」作为输入。

### 2.1 决定性

- 给定相同审计输入，**输出建议集是决定性的**：顺序、ID、`priority`、`action`、`capability`、`guidance`、分组（`actionable` / `manual-review` / `unsupported`）完全相同。
- 建议集合内部按 `(priority asc, action asc, capability asc, guidance asc, sourceIssueCode asc, positionText asc)` 字典序排序，保证跨运行稳定。
- 所有位置字段（年度、rank 等）来自审计 `Issue.position`，经 `safePosition()` 处理后再传入建议模型；**任何 title / author / catalogId / 真实 noteId 都不会进入建议模型**。

### 2.2 数量（当前实现）

| 维度 | 数量 |
|------|------|
| `IssueCode`（建议可消费的 Issue 种类） | 36 |
| `RepairAction`（建议动作） | 9 |
| `RepairCapability`（当前 UI 是否具备执行条件） | 5 |
| `RepairPriority`（建议优先级） | 4 |
| `GuidanceKey`（建议动作对应的中文指导语） | 9 |

### 2.3 三档分组

| 分组 | 含义 | 触发条件 |
|------|------|----------|
| `actionable` | 建议由当前界面处理 | 当前 UI 已经具备执行条件（如「切换 Top N 档位」「重新加载档案」等） |
| `manual-review` | 需要人工核对 | 当前 UI 不能直接处理，但人类可以在书评/笔记流程中核对 |
| `unsupported` | 当前字段不足 | 当前档案数据本身缺乏必要字段（如 per-year rank 映射），模型**不会虚构数据** |

### 2.4 已知「当前不可达」分支

- `unsupported_with_current_fields` 分支当前**永远不会**被实际触发：
  - 模型支持的「reserved recurring rank」IssueCode 共 2 个，但 S27Q 当前 audit 结果中**没有**任何 recurring per-year rank 映射字段可供核对；
  - 因此当前 Archive 数据经过 S27Q audit 之后，**永远不会**产出「reserved recurring rank」对应的 `Issue`；
  - 建议模型仍为这两个 IssueCode 保留入口与建议定义，以便未来 Archive 暴露相关字段时立刻生效；
  - 这是当前实现的**已知限制**，不是缺陷；面板的 `unsupported` 分组只展示当前确实存在但模型判断为「字段不足」的少量审计项，并在方法说明中明确列出该分支当前不可达。

### 2.5 建议字段（不包含真实隐私字段）

每条建议只包含以下字段：

| 字段 | 类型 | 含义 |
|------|------|------|
| `id` | `Recommendation ID` | 仅内部使用，**不进入 Markdown 文件** |
| `sourceIssueCode` | `IssueCode` | 该建议对应的审计 Issue 种类（仅枚举，不含真实内容） |
| `priority` | `RepairPriority` | `P0` / `P1` / `P2` / `P3` |
| `action` | `RepairAction` | 建议动作枚举 |
| `capability` | `RepairCapability` | 当前 UI 是否具备执行条件 |
| `guidance` | `GuidanceKey` | 中文指导语键（与 `action` 一一对应） |
| `positionText` | string | 安全位置描述（如 `year=2023 / rank=1`），不含 title / author / catalogId |
| `summary` | string | 中性的一句话摘要，不评价用户 |

---

## 3. 面板（`ReadingDataRepairRecommendationsPanel`）

### 3.1 入口

- 仅在 `/weread` 中心页「长期档案」工作区内出现，位于「数据质量审计」面板之后。
- 用户首次点击「数据修复建议」tab/区域才会渲染面板；切换 tab 走 React `key` remount，不在面板内部新增任何 state。
- 面板在「数据质量审计」尚未生成结果时显示「等待审计结果」中性提示；审计结果为空时显示「当前没有可修复建议」中性提示。

### 3.2 渲染分区（自上而下）

1. **总览**：建议总数、按 `actionable` / `manual-review` / `unsupported` 三档分组的计数；不评价用户、不出现「问题严重」「紧急修复」等措辞。
2. **建议分组列表**：
   - `actionable` 分组
   - `manual-review` 分组
   - `unsupported` 分组
3. **优先级最高的建议**（`P0` → `P3` 顺序）：仅展示枚举级别的指导语，不展开真实 Issue 内容。

### 3.3 按钮

- 面板内**不存在任何执行修复动作的按钮**：
  - 不存在「一键修复」按钮；
  - 不存在「自动修复」按钮；
  - 不存在「应用建议」按钮；
  - 不存在「同步到服务器」按钮；
- 面板底部**仅有一个**「导出修复建议 Markdown」按钮，点击后调用 S27R-3 Markdown 导出子组件（见 `WEREAD_READING_DATA_REPAIR_RECOMMENDATIONS_MARKDOWN.md`）。

### 3.4 状态

| 状态 | 触发条件 | 行为 |
|------|----------|------|
| `loading` | 审计结果尚未生成 | 显示中性等待文案，导出按钮禁用 |
| `empty` | 审计结果存在但建议集为空 | 显示「当前没有可修复建议」中性文案，导出按钮可用（导出空建议集） |
| `pass` | 建议集非空 | 渲染建议分组 + 导出按钮可用 |
| `error` | 建议模型内部错误（极少见） | 显示中性错误文案，导出按钮禁用，不向服务端报告 |

---

## 4. 安全边界

- `automatic = false`：不执行任何修复动作。
- `modifiesSourceData = false`：不修改源数据、不重新请求数据、不调用 AI。
- `runsAutoRetry = false`：不触发自动 retry；`exportRequestDelta = 0`。
- `hasExecutionButton = false`：面板内不存在任何执行修复动作的按钮。
- `hasNetworkSideEffect = false`：不发起任何网络请求（不计 export 的 0 请求边界）。
- `hasStorageSideEffect = false`：不写 localStorage / sessionStorage / IndexedDB / cookie。
- `hasUrlSideEffect = false`：不修改 URL / history / pushState / replaceState。
- `hasServerUpload = false`：不上传任何数据。
- `usesSafePositionOnly = true`：位置字段仅含 `year` / `rank` / `rankPair` / `scope`，经 `safePosition()` 处理。

---

## 5. 隐私边界

- 不输出 title / author / catalogId / 笔记正文 / 笔记评论 / 章节标题 / 划线正文 / AI 概要 / token / 私有 ID。
- 不输出 `Recommendation ID` 到 Markdown 文件（仅内部引用）。
- 不输出 `Issue ID` 到 Markdown 文件。
- 不输出 `actual` / `expected` 原始字段到 Markdown 文件（仅保留中性安全数值）。
- 不输出 raw audit / raw repair plan 到 Markdown 文件。
- 不评价用户本人，不输出「兴趣 / 能力 / 心理 / 阅读质量 / 人格 / 优秀 / 较差 / 用户评分」等评价性语言。

---

## 6. 已知限制

- 建议范围仅限当前浏览器已加载档案 + 当前审计结果。
- 未加载的年份、失败的年份、unaccounted 的年份**不会**产出建议。
- 不与源服务器重新对账，不会调用任何后端 endpoint。
- 不自动修复任何 Issue。
- 不读取原始笔记正文 / 评论 / 划线。
- 当前档案不暴露 recurring per-year rank 映射 → `unsupported_with_current_fields` 分支当前不可达。
- Markdown 文件不会自动更新，需要用户主动点击导出按钮。
- 不支持 PDF、不支持公开分享（不上传到任何第三方服务）。

---

## 7. 测试覆盖

- 70 个单元测试覆盖 `wereadReadingDataRepairRecommendations.ts` 的所有纯函数（决定性、隐私、排序、actionable/manual-review/unsupported 分组、guidance）。
- 50 个单元测试覆盖 `wereadReadingDataRepairMarkdown.ts`（隐私正则、文件结构、filename、MIME、redact 边界、FORBIDDEN_PATTERNS 防御）。
- 15 个组件测试覆盖 `ReadingDataRepairExportAction.tsx` 的渲染、状态机、reset key、按钮可用性、URL.revokeObjectURL。
- 12 个 Panel 测试覆盖 `ReadingDataRepairRecommendationsPanel.tsx` 的零 hook 约束、分组渲染、empty 状态、loading 状态。
- 45 项浏览器端到端断言（`scripts/s27r3-browser-smoke.cjs`）覆盖真实下载、文件名、内容结构、隐私不泄露、React #300=0、桌面 / 移动端无横向溢出。
- 上述测试在 S27R-3A、S27R-3B、S27R-3C-0、S27R-3C-1A、S27R-3C-1B、S27R-3C-1C 期间均通过。