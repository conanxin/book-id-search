# S27P — WeRead Reading Evolution Timeline

> 在「长期档案」工作区新增**「年度统计演变时间线」面板**（S27P）。它复用当前已加载的 `WereadReadingArchive` 年度聚合数据，在浏览器本地按相邻年份顺序计算描述性统计差异，不新增后端 endpoint，不调用 AI，不读取笔记正文，不持久化结果。

---

## 1. 功能范围

- 入口位于 `/weread`「长期档案」工作区内部，作为 archive 子面板之一；首次渲染时自动复用 archive cache，**不额外请求** `annual-review`。
- 完全基于 `WereadReadingArchive` 已成功加载的年份切片；任何年份失败或缺失时，面板仅对连续成功年份计算，并在顶部显示完整性提示。
- 复用当前 archive 的 **Top N 口径（6 / 12 / 18，默认 12）** 与 **年份范围（最近 5 年 / 最近 10 年 / 全部最多 20 年）**；切换 range 或 Top N 后自动随 archive 重算。
- 不新增后端 route、不调用 MiniMax / `/api/ai`、不调用 `/related-books`。
- 不读取 `note.text` / `note.comment` / `chapterTitle` / AI summary / token / `wereadBookId` / `noteId` / `highlightId` 等任何敏感字段。
- 结果仅存在于组件内存；切换 token / 卸载组件 / 关闭 tab 立即清空；不写入 `localStorage` / `sessionStorage` / IndexedDB / 服务器。
- **支持浏览器本地 Markdown 导出**（S27P-2，见 `WEREAD_READING_EVOLUTION_TIMELINE_MARKDOWN.md`）。

## 2. 计算口径

| 输出 | 说明 |
|------|------|
| 时间线范围 | 当前 archive 年份切片中 `totalRecords > 0` 的连续成功年份；按年份升序排列。 |
| 年度概览 | 每个年份复用 `WereadAnnualReview` 的 `overview`：记录数、活跃月份、类型分布、高峰月份等。 |
| 里程碑 | 首次出现记录的年份、记录数最高年份、连续活跃年份段起点等描述性节点。 |
| 相邻年度指标差异 | 对相邻两个成功年份计算六项核心指标的差值：记录数、活跃月份、高互动书目数、上榜书目重叠数、平均每月记录数、高峰月份记录数。 |
| 显著统计差异标记 | 当相邻年份差值超过预设阈值（基于绝对变化量与相对变化比例）时，标记为「显著增加 / 显著减少」；阈值为纯数值边界，不做心理 / 兴趣解释。 |
| Top N 书目差异 | 按相邻年份的 Top N 榜单做集合差分：连续出现、新进入、离开。 |
| 连续出现 | 在相邻两个年份的 Top N 榜单中同时出现的书目。 |
| 新进入 | 出现在目标年份但不在上一年份 Top N 榜单中的书目。 |
| 离开 | 出现在上一年份但不在目标年份 Top N 榜单中的书目。 |

- 所有指标差异**仅描述数字变化**，不推断阅读兴趣、心理状态、阅读质量或能力变化。
- 相邻年份比较**严格按时间顺序相邻**，不做任意两年全连接。
- 若某年份 `topBooks` 为空，则该年份的差异项输出为「无数据」占位，不伪造任何书目或统计。

## 3. 隐私与数据边界

- 仅使用 `WereadAnnualReviewResponse` 中的公开描述性统计与已确认的公共书目 `catalogId`。
- 不展示真实笔记正文、划线原文、想法、书评原文。
- 不展示 `wereadBookId`、`noteId`、`highlightId`、token、AI 摘要、summary overview。
- 不调用 `/api/search`、不影响公开搜索排序。
- 不写入任何日志或持久化存储。
- UI 顶部固定显示隐私与解释边界声明：「以下时间线仅基于本地已加载的年度统计，不读取笔记正文，不推断阅读偏好或阅读质量。」

## 4. 失败与边界情况

- 若 archive 尚未加载任何年份（例如全部失败），面板显示空状态提示，不崩溃。
- 若只有 1 个成功年份，仅展示年度概览与里程碑，不渲染相邻差异（因无相邻年份）。
- 部分年份失败时，差异计算自动跳过失败年份，对连续成功年份段分别计算，并在顶部提示「以下统计未包含失败年份」。

## 5. 已知限制

- 最多依赖 archive 的 20 年硬上限，因此时间线最多 20 个年份节点。
- 仅比较相邻年份，不提供更长时间跨度的累计分析。
- 不输出主题 / 题材 / 兴趣方向分析。
- 不做心理 / 人格 / 阅读质量判断。
- 不展示任何真实书目清单或真实 `catalogId` 关系（开发测试全部使用合成数据）。

---

**相关文件：**

- 模型：`apps/web/src/weread/wereadReadingEvolutionTimeline.ts`
- 面板：`apps/web/src/weread/ReadingEvolutionTimelinePanel.tsx`
- 导出动作：`apps/web/src/weread/ReadingEvolutionTimelineExportAction.tsx`
- Markdown 生成：`apps/web/src/weread/wereadReadingEvolutionMarkdown.ts`
- 测试：`apps/web/src/weread/wereadReadingEvolutionTimeline.test.ts` / `apps/web/src/weread/ReadingEvolutionTimelinePanel.test.tsx` / `apps/web/src/weread/ReadingEvolutionTimelineExportAction.test.tsx` / `apps/web/src/weread/wereadReadingEvolutionMarkdown.test.ts`
