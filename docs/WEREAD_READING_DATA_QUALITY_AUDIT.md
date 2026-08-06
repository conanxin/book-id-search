# S27Q-1C — WeRead Long-term Reading Data Quality Audit

> 微信读书「长期档案」工作区内置**第 6 个子面板「数据质量审计」**。该面板把当前浏览器已经加载的多年档案数据当作一份**已知的、可对账的**数据集，从年份闭合、年度字段一致性、Top N 公共元数据、YearLink 相邻链接、Recurring 聚合五个维度做静态审计，输出中性的 `pass / warn / fail` 状态。它不新增后端 endpoint，不调用 MiniMax，不读取笔记正文，不持久化审计结果。

---

## 1. 功能范围

- 仅在 `/weread` 中心页「长期档案」工作区内出现，作为面板组件：「数据质量审计」。
- 审计对象是当前浏览器组件内存中已经加载的「长期档案」多年聚合数据（即 S27L 的 `ReadingArchiveView`，由 N 份 `WereadAnnualReviewResponse` 合并而成）。
- 审计由纯函数 `runReadingDataQualityAudit()` 在浏览器中执行，**不重新请求任何数据**（不重新调用 `/api/private/weread/annual-review`），**不调用 MiniMax**，**不调用 `/related-books`**，**不写 localStorage / sessionStorage / IndexedDB**。
- 审计结果只在当前浏览器组件内存中存在：切换 token / 卸载组件 / 关闭 tab 时立即清空；不写入 Meilisearch。
- 不读取笔记正文、笔记评论、章节标题、划线正文、AI 概要、token、私有 ID 等任何敏感字段。
- 不公开任何长期数据，不写入 Meilisearch，不修改 URL。
- **支持浏览器本地 Markdown 导出**（S27Q-3B，见 `WEREAD_READING_DATA_QUALITY_AUDIT_MARKDOWN.md`）。
- **审计数据，不评价用户**：所有文字保持「数据是否自洽、是否对得上」的中性口径；不出现「用户更爱阅读 / 兴趣增强 / 能力提升 / 阅读质量高 / 心理状态 / 人格 / 优秀 / 较差」等评价性语言。

---

## 2. 审计范围

审计覆盖以下 6 个分组（按 `SCOPE_*` 枚举标识）：

| 枚举 | 含义 |
|------|------|
| `coverage` | 年份覆盖与闭合 |
| `year-metrics` | 年度数值合法性 |
| `top-n` | Top N 公共元数据、排名和重复 |
| `year-link` | 相邻年度链接 |
| `recurring` | Recurring 聚合 |
| `summary-debug` | 与 summary / debug 相关的可观察一致性 |

每个分组下输出 `error / warning / info` 三档严重级（按 `SEVERITY_*` 枚举），每条记录一个 `Issue`，含：
- `id`：`scope:sub:<sha-suffix>`（仅内部使用，不进入 Markdown 文件）
- `scope` / `code` / `severity`
- `position`：年度或 item 位置（如 `year=2023 / rank=1`）
- `actual` / `expected`：安全数值（已被 `safeValue()` 处理）
- `message`：人类可读的中文描述

---

## 3. 年份覆盖

审计当前档案数据中目标年份的闭合情况。原始字段：`targetYears` / `loadedYears` / `failedYears`。

| 字段 | 含义 |
|------|------|
| `targetYears` | 用户选择范围内，理论上应该加载的年份集合 |
| `loadedYears` | 实际成功加载的年份集合 |
| `failedYears` | 加载失败但仍纳入审计的年份集合 |
| `unaccountedYears` | 既不在 loaded 也不在 failed，但属于 target 的年份 |
| `extraYears` | 不属于 target 但被加载进来的年份 |

派生比例：
- `yearClosureRatio = |loaded| / |target|`，范围 `[0, 1]`；target 为空时返回 `null`。

出现以下情况之一即产生 Issue：
- `unaccountedYears` 非空（`error`）
- `extraYears` 非空（`info`）
- `failedYears` 非空（`warning`）
- `yearClosureRatio < 1`（`warning`）

---

## 4. 年度指标检查

针对每一份 `WereadAnnualReviewResponse.overview` 做字段合法性校验，原始字段：`overview`。

校验项：
- `year` 属于 target / loaded 集合（`info`）
- 所有计数字段（`totalRecords` / `datedRecords` / `matchedRecords` / `matchedBooks` / `peakMonthRecords` / `averageRecordsPerActiveMonth`）均为**有限且非负整数**（`error`）
- `datedRecords <= totalRecords`（`error`）
- `matchedRecords <= totalRecords`（`error`）
- `matchedBooks <= matchedRecords`（`error`）
- `activeMonths ∈ [0, 12]`（`error`）
- `longestStreakMonths ∈ [0, 12]`（`error`）
- `longestStreakMonths <= activeMonths`（`error`）
- `peakMonth` 形如 `YYYY-MM` 且合法（如提供，`error`）
- `firstNoteAt` / `lastNoteAt` 早于等于同年 12-31 且晚于等于同年 01-01（如提供，`info`）

`months[]` 校验：
- `month` 形如 `YYYY-MM` 且合法（`error`）
- 12 个月齐全（`error`）
- `total = highlights + thoughts + reviews + unknown`（`error`）
- `bookCount ≤ matched ≤ total`（`error`）
- 所有计数字段有限且非负（`error`）

---

## 5. Top N 检查

针对每一年 `topBooks[]` 做公共元数据、排名和重复校验。

校验项：
- `topBooks.length ≤ topBooksRequested`（`info`）
- 所有 book 都有非空 `catalogId`，且属于公开 catalog（`error`）
- 所有 book 都有非空 `title`（`error`）
- `catalogId` 在该年内唯一（`error`）
- `rank` 在 `[1, topBooksRequested]` 区间内且在该年内唯一（`error`）
- `noteCount` / `highlights` / `thoughts` / `reviews` / `unknown` 均为有限且非负整数（`error`）
- `rank` 排序与 `noteCount` 降序一致（`info`）
- 当 `topBooksReturned < topBooksRequested` 时产生 `info`

派生比例：
- `topNPublicMetadataRatio = (公开元数据齐全的 book 数) / (全部 book 数)`

---

## 6. YearLink 检查

校验 `yearLinks[]`：相邻成功年份之间 Top N 重合情况。

校验项：
- `sourceYear < targetYear`（`error`）
- `sourceYear` / `targetYear` 都属于 loaded years（`error`）
- `pair (source, target)` 唯一（`error`）
- `commonCount ≤ min(leftCount, rightCount)`（`error`）
- `unionCount ≥ max(leftCount, rightCount)`（`error`）
- `ratio ∈ [0, 1]`（`error`）
- `ratio` 与 `commonCount / unionCount` 一致（在 1e-6 容忍内，`error`）

派生比例：
- `adjacentYearLinkCoverageRatio = (有 yearLink 的相邻 pair 数) / (loaded 年份应有的相邻 pair 数)`

---

## 7. Recurring 检查

校验 `recurringBooks[]`：在多个年份同时出现的书目聚合。

校验项：
- `catalogId` 唯一（`error`）
- `title` 非空（`error`）
- `years` 数组内年份唯一且都属于 loaded years（`error`）
- `yearsOnList` 等于 `years.length`（`error`）
- `latestYear ∈ years`（`error`）
- `rank` 为正整数（`error`）

---

## 8. NOT_APPLICABLE 限制

**当前数据没有逐年度 rank 映射**，因此审计**不能独立**：
- 重算 `bestRank`（需要每年内该书的具体 rank，recurring 行不带此字段）
- 核对 `latestYear` 对应的具体 `latestRank`

模型**不虚构数据**。这两项会以 `NOT_APPLICABLE` 出现在 Markdown 文件的「当前模型限制」块中，不会作为 Issue 触发。

---

## 9. 五项覆盖比例

审计结果会输出五个互不重叠的比例，全部基于**当前已加载数据**：

| 比例 | 含义 | 范围 |
|------|------|------|
| `yearClosureRatio` | 加载年份 / 目标年份 | `[0, 1]`，target 空时为 `null` |
| `datedRecordsRatio` | 有日期记录 / 全部记录 | `[0, 1]` |
| `matchedRecordsRatio` | 已匹配记录 / 全部记录 | `[0, 1]` |
| `topNPublicMetadataRatio` | 公共元数据齐全的 Top N book 数 / 全部 Top N book 数 | `[0, 1]` |
| `adjacentYearLinkCoverageRatio` | 有 YearLink 的相邻 pair / 全部相邻 pair | `[0, 1]` |

这些比例衡量的是**数据覆盖和可核对程度**，**不是**用户阅读兴趣、能力或质量评分。

---

## 10. 整体状态

| 条件 | 状态 |
|------|------|
| 任意 `error` 存在 | `fail` |
| 任意 `warning` 存在（无 error） | `warn` |
| 仅 `info` 或无 Issue | `pass` |

`pass / warn / fail` 是**数据自洽性**标签，**不评价用户**。

---

## 11. 隐私边界

- 不输出 title / author / catalogId 到 Issue 的 `actual` / `expected` 字段（由 `redactForbidden()` 替换为 `[已过滤]`）。
- 不读取笔记正文、笔记评论、章节标题、划线正文、AI 概要、token、私有 ID 等任何敏感字段。
- 不读取网络、storage 或 URL。
- 不输出 raw archive / audit JSON 原文。
- 不调用 AI、不评价阅读兴趣、能力或心理特征。
- 输出文件（详见 S27Q-3B Markdown 文档）只保留中性字段：年份、scope、Issue 中文标签、item position、rank、actual / expected 安全数值、比例和计数。