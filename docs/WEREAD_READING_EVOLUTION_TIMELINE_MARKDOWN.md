# S27P-2 — WeRead Reading Evolution Timeline Markdown Export

> 「年度统计演变时间线」面板新增**「导出年度统计演变时间线 Markdown」按钮**（S27P-2）。它完全在浏览器本地生成文件，使用当前已加载的 `WereadReadingEvolutionTimelineResult`，不重新请求 `annual-review`、不调用 AI、不写入任何存储、不上传服务器。

---

## 1. 触发与文件名

- 触发：用户点击「年度统计演变时间线」面板内的「导出时间线 Markdown」按钮。
- 文件名：`weread-reading-evolution-<first>-to-<latest>-YYYYMMDD.md`（纯 ASCII，长度 ≤ 80）。
  - 例如 `weread-reading-evolution-2021-to-2024-20260805.md`。
- 若当前无成功年份，文件名使用 `weread-reading-evolution-empty-YYYYMMDD.md`。
- MIME：`text/markdown;charset=utf-8`。

## 2. 文档结构

导出的 Markdown 包含以下区块，全部使用描述性统计语言：

1. **标题**：`# 年度统计演变时间线`。
2. **Metadata**：生成日期、范围年份、Top N 口径、 completeness 提示（是否包含失败年份）。
3. **隐私 / 解释边界 blockquote**：明确说明数据只来自本地已加载的年度统计，不读取笔记正文，不推断阅读偏好 / 阅读质量 / 心理特征。
4. **时间线概览**：成功年份数、总记录数、最活跃年份、连续活跃段长度等。
5. **里程碑**：首次有记录年份、记录数最高年份、连续活跃起点。
6. **年度详情**：每一年独立的概览小节（记录数、活跃月份、类型分布、高峰月份）。
7. **相邻年度指标差异**：相邻年份的六项指标差值表格，显著差异用 `**` 粗体标记为「显著增加」或「显著减少」。
8. **Top N 书目差异**：
   - 连续出现（在相邻两年 Top N 榜单中均出现）
   - 新进入（出现在目标年但不在上一年）
   - 离开（出现在上一年但不在目标年）
9. **方法说明**：口径边界、数据来源、限制说明。

- 文件中不包含任何真实笔记正文、划线、想法、书评、AI 摘要、token、私有 ID 或完整原始 JSON。
- 不展示真实 `catalogId` 关系；书目仅使用公开元数据（title / author / publisher / publishYear）。

## 3. 行为约束

- 点击导出按钮前后：
  - `annualReview` 请求计数不增加。
  - 不触发 `POST` / `PUT` / `PATCH` / `DELETE` 请求。
  - 不触发任何外部请求（MiniMax / CDN）。
  - `URL.revokeObjectURL` 在下载触发后调用，避免临时 blob 泄漏。
- 切换 range / Top N / 失败年份重试后，已生成的文件内容不会自动更新；用户需重新点击导出。
- 切换 token 或卸载组件时，导出生成的内存状态立即清空。

## 4. 隐私边界

- 不输出 `noteId`、`wereadBookId`、`highlightId`、`chapterTitle`、token、Authorization 头。
- 不输出 AI 摘要 / 主题 / 阅读方向 / 心理推断词汇。
- 不输出 raw archive / timeline JSON 结构或调试信息。
- 不写入 `localStorage` / `sessionStorage` / IndexedDB / 服务器。

---

**相关文件：**

- Markdown 生成：`apps/web/src/weread/wereadReadingEvolutionMarkdown.ts`
- 导出动作：`apps/web/src/weread/ReadingEvolutionTimelineExportAction.tsx`
- 面板：`apps/web/src/weread/ReadingEvolutionTimelinePanel.tsx`
- 测试：`apps/web/src/weread/wereadReadingEvolutionMarkdown.test.ts` / `apps/web/src/weread/ReadingEvolutionTimelineExportAction.test.tsx`
