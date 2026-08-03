# S27K — WeRead Year-over-Year Reading Comparison

> 微信读书中心「年度回顾」工作区新增**年度对比**。该功能复用「年度回顾」已发出的 `WereadAnnualReviewResponse`，把同一份聚合数据按**基准年 / 目标年**并排展示，不新增后端 endpoint，不调用 MiniMax，不读取笔记正文，不持久化比较结果。

---

## 1. 功能范围

- 仅在「年度回顾」工作区出现，入口按钮：「开启年度对比」。
- 默认关闭；只有当 `availableYears.length >= 2` 时才可启用，否则按钮被禁用并显示提示。
- 开启后允许选择基准年份、目标年份，并支持「交换年份」「关闭对比」。
- 顶部高互动书目范围（6 / 12 / 18）沿用主年度当前档位；切换档位会同时影响基准年和目标年的对比结果。
- 复用两个 `GET /api/private/weread/annual-review` 响应（基准年 + 目标年），不新增后端 route。
- 对比结果只在当前浏览器组件内存中存在，关闭对比 / 切换 token / 卸载组件时立即清空；不写入 localStorage / sessionStorage / IndexedDB。

## 2. 复用接口

```
GET /api/private/weread/annual-review?year=<基准年>&topBooks=<6|12|18>
GET /api/private/weread/annual-review?year=<目标年>&topBooks=<6|12|18>
```

- 年度对比不调用其他 endpoint（不调用 `/notes/summarize`、`/related-books` 等）。
- 不修改 `apps/api`。
- 不重建 API。
- 不调用 MiniMax。
- 不写 Meilisearch。
- 不写 storage。

## 3. 基准年 / 目标年定义

- **目标年**：默认等于主年度回顾当前选中年份。用户在主面板切换年份时，对比的目标年自动跟随。
- **基准年**：默认 = `availableYears` 中**小于目标年**且**最大的**年份。如果没有更早年份，则退而取其他任意不同年份。
- 只允许选择 `availableYears` 中存在的年份。
- **不允许同一年**：用户操作导致基准年等于目标年时被阻止，UI 不切换；当前实现里基准年选择器自动从候选集中剔除目标年。
- 「交换年份」按钮把基准年与目标年互换。
- 「关闭对比」清空所有对比状态、缓存和正在进行的请求。

## 4. 指标与百分比算法

六个核心指标按以下规则计算：

| 指标 | 来源 | 计算 |
|------|------|------|
| 阅读记录 | `overview.totalRecords` | 目标年 − 基准年 |
| 活跃月份 | `overview.activeMonths` | 同上 |
| 已匹配记录 | `overview.matchedRecords` | 同上 |
| 年度书目 | `overview.matchedBooks` | 同上 |
| 最长连续月份 | `overview.longestStreakMonths` | 同上 |
| 活跃月份平均记录 | `overview.averageRecordsPerActiveMonth` | 同上 |

百分比规则：

- **base > 0**：`percentChange = (target − base) / base × 100`，保留最多 1 位小数。
- **base = 0 且 target > 0**：`percentChange = null`，`direction = from_zero`，UI 显示「由 0 增至 N」。
- **base > 0 且 target = 0**：`percentChange = -100`，`direction = to_zero`。
- **base = 0 且 target = 0**：`percentChange = 0`，`direction = same`。
- 不会出现 NaN / Infinity；非有限数被替换为 0。

## 5. base = 0 处理

- 任何月份的 `baseTotal` 缺失视为 0（永远填满 12 个月）。
- 任何季度的 `baseTotal` 缺失视为 0（永远填满 Q1–Q4）。
- 顶部书目缺失视为 0（连续 / 进入 / 退出榜单的归属判断基于真实的 `topBooks` 数组，不臆测）。
- 当某一年的 `topBooks` 为空时：对比仍允许，仅不参与书目排名变化。

## 6. 月度与季度对齐

- **月份**：固定 12 个月，按数字 `1..12` 排序；不依赖字符串排序。
- **季度**：固定 Q1 → Q4 顺序；不依赖服务端返回顺序。
- **季度 bookCount**：使用两个 `month.bookCount` 求和得出，与服务端 `quarter.bookCount` 解耦，保证对比口径一致。

## 7. 顶部高互动书目榜变化

- 仅对比两个 `topBooks` 数组；不调用 `related-books`，不引入额外推荐。
- 分类：
  - **continuing**：在基准年和目标年都出现的书目。
  - **entered**：仅出现在目标年的书目（UI 文案：「进入目标年度高互动书目榜」）。
  - **left**：仅出现在基准年的书目（UI 文案：「未进入目标年度高互动书目榜」）。
- **排名**：`rank` 从 1 开始。`rankChange = baseRank − targetRank`，正数表示排名上升（数值更小）。
- **公共元数据**：title / author / publisher / publishYear 优先使用目标年公共书目元数据，目标年缺失时回退到基准年公共元数据；不回退微信读书私有 title / author。

### 7.1 重要限制

榜单变化是当前 `topBooks` 范围（6 / 12 / 18）内的对比，不表示「开始阅读」或「停止阅读」。切换 `topBooks` 范围会影响基准年和目标年各自的排名，并因此改变对比结果。页面 UI 明确显示这一限制。

## 8. 描述性变化摘要（不读心）

摘要为**纯规则文案**，只描述数量 / 排名 / 月份变化：

- 「目标年度阅读记录比基准年度增加 N 条。」
- 「两年活跃月份数量持平。」
- 「目标年度已匹配记录为 N 条，基准年度为 M 条。」
- 「记录高峰月份从 X 月变为 Y 月。」
- 「有 N 本书连续进入两年的高互动书目榜。」
- 「有 N 本书进入目标年度高互动书目榜。」
- 「有 N 本书未进入目标年度高互动书目榜。」

**不生成**：

- 阅读兴趣变化、兴趣转移、注意力、专注力、人格特征、阅读深度、阅读质量、习惯养成等心理或质量判断。

如果某项无法比较（例如两者都为 0），则省略该项，不做猜测。

## 9. 隐私边界（与 S27H / S27I / S27J 完全一致）

- **不读取**：note 文本 / 想法 / 评论 / 章节标题 / `wereadBookId` / `noteId` / `highlightId` / `chapterTitle` / 微信读书私有 title / author。
- **不调用**：`fetchWereadAiSummary`、`fetchWereadRelatedBooks`、`/api/search`、MiniMax、任何写入接口。
- **不持久化**：localStorage / sessionStorage / IndexedDB / 服务端。token 改变 → 立即 `abort` + 清空 `state.comparison` + 清空 compare cache。
- **不公开分享**：不提供导出 / 分享 / 链接预览按钮。

## 10. 已知限制

- 只比较**两个自然年**，不支持任意日期区间。
- 只比较**有效日期**（即 `note.createdAt` 或 `updatedAt` 解析得到的日期）的阅读记录，丢弃无日期笔记。
- 顶部书目仅覆盖**已确认匹配的公共书目**；未匹配的纯微信读书私有书目不参与对比。
- 切换 `topBooks` 范围会改变对比结果；页面明确说明这一点。
- 不做主题 / 类别 / 阅读内容分析；不调用 MiniMax。
- 不做心理 / 阅读质量 / 阅读兴趣推断。
- 不写 server，不写 storage，不提供公开分享。
- 仅当 `availableYears.length >= 2` 时才能启用对比入口；否则按钮被禁用并显示「至少需要两个有记录的年份才能进行年度对比」。

## 11. 不做的事

- 不修改 `apps/api`。
- 不新增 endpoint。
- 不重建 api 容器。
- 不调用 MiniMax / Minimax。
- 不调用 related-books。
- 不写 Meilisearch。
- 不写 localStorage / sessionStorage / IndexedDB。
- 不自动导出文件。
- 不提交 `.env` / `private-data` / `apps/web/dist` / `logs` / `screenshots` / `progress`。
- 不新增依赖。
- 不修改 Caddy / DNS / nginx / ICP / 公安备案配置。