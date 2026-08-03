# S27J-2 — WeRead Annual Review Markdown Export

> 「年度回顾」工作区新增「导出年度回顾 Markdown」按钮。Markdown 完全在当前浏览器内生成，不写入服务器、不调用任何外部 AI 服务、不持久化到 localStorage / sessionStorage / IndexedDB。

---

## 1. 功能范围

- 在「年度回顾」工作区年份选择 + topBooks 控制区下方新增「导出年度回顾 Markdown」按钮。
- 文件只使用工作区当前已加载的 `WereadAnnualReviewResponse`（年份、topBooks 范围、12 个月时间轴、Q1–Q4 季度卡、年度高互动书目、概览数字）。
- 切换年份 / topBooks 或清除 token 后，已显示的「已生成 …」成功提示会立即清空，避免误导。
- 空年度（该年 `totalRecords == 0 && topBooks.length == 0`）仍可导出：Markdown 文件包含完整 12 个零值月份表、四张零值季度卡、说明区；不伪造高峰月份、top books 或成就数据。
- 文件名：`weread-annual-review-<year>-YYYYMMDD.md`，例 `weread-annual-review-2025-20260803.md`。
  - 仅 ASCII；
  - 不含书名 / 作者 / 主题 / catalogId / token / 私有 ID；
  - 长度 ≤ 80 字符；
  - MIME：`text/markdown;charset=utf-8`。
- 整个流程只在浏览器内运行：
  - 不重新调用 `/api/private/weread/annual-review`；
  - 不调用 `/api/private/weread/notes/summarize`（AI 摘要）；
  - 不调用 `/api/private/weread/related-books`；
  - 不调用 `/api/search`；
  - 不写入 `localStorage` / `sessionStorage` / IndexedDB；
  - 不持久化到服务器 / Meilisearch / 任何外部服务。

## 2. 浏览器下载机制

1. 用户点击按钮 → 组件调用纯函数 `buildAnnualReviewMarkdown({ review, exportedAt })`。
2. 函数返回 `{ content, filename, mimeType, byteLength, selectedYear, topBooksCount }`。
3. 组件调用 `triggerAnnualReviewMarkdownDownload({ content, filename })`：
   - 用 `new Blob([content], { type: "text/markdown;charset=utf-8" })` 创建 Blob；
   - `URL.createObjectURL(blob)` 生成临时 URL；
   - 创建 `<a>` 元素（`rel="noopener"`、`data-testid="weread-annual-review-markdown-anchor"`），挂到 `document.body`，`.click()`，再 `remove()`；
   - `setTimeout(0)` 后调用 `URL.revokeObjectURL(blobUrl)` —— 让浏览器读完 blob URL 后立刻释放。
4. 状态更新为「已生成 2025 年年度回顾 Markdown。」成功文案不带 token / 笔记正文 / 私有 ID。
5. 用户后续如何处理 `.md` 文件由自己决定（直接打开 / 拖入笔记软件 / 上传到私人网盘）。

## 3. Markdown 文件结构

```
# 2025 年阅读回顾

- 导出时间：YYYY-MM-DD HH:mm
- 数据来源：微信读书私有阅读记录
- 生成方式：book-id-search 浏览器本地生成
- 保存状态：未上传服务器

> 隐私说明：本文件由用户主动在浏览器中生成。导出完成后，请自行妥善保存。

## 年度概览

- 阅读记录：N
- 有效日期记录：N
- 活跃月份：N
- 最长连续活跃：N 个月
- 已匹配记录：N
- 年度书目：N
- 高峰月份：2025 年2 月
- 活跃月份平均记录：350.57

## 12 个月时间轴

| 月份 | 记录 | 划线 | 想法 | 书评 | 未分类 | 已匹配 | 书目 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2025 年1 月 | 17 | 16 | 1 | 0 | 0 | 0 | 0 |
| ... |
| 2025 年12 月 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

固定 12 行。

## 季度回顾

### Q1（1–3 月）

- 阅读记录：N
- 活跃月份：N
- 已匹配记录：N
- 涉及书目：N
- 占全年记录：N%

依次 Q1 / Q2 / Q3 / Q4。

## 年度高互动书目

### 1. 《公开书名》

- 作者：公共作者
- 出版信息：出版社，年份
- 年度记录：N
- 活跃月份：N
- 首次记录：YYYY-MM-DD
- 最后记录：YYYY-MM-DD
- 类型：划线 N / 想法 N / 书评 N / 未分类 N
- 书目页面：https://books.conanxin.com/books/<catalogId>

## 年度记录

- 全年留下 N 条阅读记录。
- 在 N 个自然月有阅读活动。
- 最长连续活跃 N 个月。
- 记录高峰出现在 2025 年2 月。
- 年度涉及 N 本已匹配书目。

## 说明

- 只有有效日期的记录进入年度统计。
- 未匹配笔记计入总量和类型，但不会出现在高互动书目中。
- 月度活跃度只描述数量，不代表阅读质量。
- 本报告未使用外部 AI。
```

### 空年度输出

```
# 2010 年阅读回顾

## 年度概览

该年度暂无有效日期的阅读记录。

## 12 个月时间轴

| 月份 | 记录 | 划线 | 想法 | 书评 | 未分类 | 已匹配 | 书目 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2010 年1 月 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| ... 12 行零值 ...

## 季度回顾

### Q1（1–3 月） / ### Q2 / ### Q3 / ### Q4

四张零值卡。

## 年度高互动书目

该年度暂无已匹配的高互动书目。

## 年度记录

本年暂无有效日期的阅读记录。

## 说明
```

## 4. 字段来源与转义

| 字段 | 来源 | 转义规则 |
|------|------|----------|
| `selectedYear` | `response.selectedYear` | 4 位年份直接嵌入标题 |
| `overview.totalRecords` / `datedRecords` / `matchedRecords` / `matchedBooks` / `activeMonths` / `longestStreakMonths` / `averageRecordsPerActiveMonth` | `response.overview` | 数字原样输出 |
| `overview.peakMonth` | `response.overview.peakMonth` | `null` → 「无记录」；非空 → `2025 年2 月` |
| `months[].total/highlights/thoughts/reviews/unknown/matched/bookCount` | `response.months[]`（按 YYYY-MM 排序补齐 12 项） | 数字原样输出 |
| `quarters[].total/activeMonths/matchedRecords/bookCount` | `response.quarters[]` | 数字原样输出；`shareOfYear` 重新计算为整数百分比 |
| `topBooks[].title` / `author` / `publisher` / `publishYear` | 公共书目元数据（来自 Meilisearch `index.getDocument`） | `escapeMarkdownInline` |
| `topBooks[].firstNoteAt` / `lastNoteAt` | ISO 时间戳 | 仅保留 YYYY-MM-DD |
| `topBooks[].noteCount` / `highlights` / `thoughts` / `reviews` / `unknown` / `activeMonths` | 计数 | 数字原样输出 |
| `topBooks[].catalogId` | 公共 catalogId | 仅出现在 `/books/<catalogId>` 链接中 |

### Markdown 转义

`escapeMarkdownInline` 处理：`\`、`*`、`_`、`` ` ``、`[`、`]`、`<`、`>`、`#`、`|`；折叠空白、剔除控制字符；换行 / 回车替换为单个空格。

`escapeMarkdownTableCell` 在 `escapeMarkdownInline` 基础上额外处理换行（保证单元格不破行）。

`escapeMarkdownBlockText` 在标题 / 列表场景中保护 `#`、`>`、`-`、`+`、`*` 不被解析为 Markdown 块结构。

### 强制不可出现在 Markdown 的内容

- 笔记正文 / 评论 / `markedText` / `content`
- 微信读书内部 ID：`wereadBookId` / `noteId` / `highlightId` / `chapterTitle`
- 微信读书原始 `title` / `author`（响应已由 API 层脱敏，模型直接复用公共字段）
- AI 摘要 `summary.overview` / `summary.keyPoints` / `summary.reviewQuestions` / `summary.themes`
- `token` / `q` / 任意 API key
- 私有 API URL
- 原始 snapshot 记录

`catalogId` 仅出现在公开书目 URL `https://books.conanxin.com/books/<catalogId>`。

## 5. 隐私边界

- **不读取笔记正文**：模型只消费 S27J `WereadAnnualReviewResponse` 中已有的字段。
- **不调用 AI / related-books**：模型纯函数；下载辅助函数零网络。
- **不持久化**：模型不写 `localStorage` / `sessionStorage` / IndexedDB；下载辅助函数只用 `Blob` + 临时 `<a>` + `URL.revokeObjectURL`。
- **不提供公开分享**：Markdown 文件不上传到服务器，没有分享链接，没有任何公开访问入口。
- **不伪造内容**：空年度输出零值结构；不输出高峰月份、`top books`、心理或性格推断。
- **不写日志**：辅助函数从不 `console.log` Markdown 内容或 token。

## 6. 测试覆盖

| 文件 | 数量 | 范围 |
|------|------|------|
| `apps/web/src/weread/wereadAnnualReviewMarkdown.test.ts` | 45 | 模型单元测试（转义 / 日期 / 季度 / top books / 空年度 / 文件名 / 校验 / 下载 / 隐私） |
| `apps/web/src/weread/AnnualReviewDashboard.test.ts` (S27J-2 段) | 11 | 组件结构 / 样式 / 隐私合同 |
| `scripts/s27j2-browser-smoke.cjs` | 27 | 浏览器端下载 / 文件名 / 内容结构 / 隐私 / 视觉布局 |

合计 ≥ 80 项断言。

## 7. 已知限制

- **只导出当前 selectedYear + 当前 topBooks 范围**。切换年份或 topBooks 必须重新点击按钮。
- **不包含 AI 年度总结**：不调用 MiniMax，不生成叙述。
- **不包含主题分析**：不调用 related-books。
- **不包含图片或图表截图**：Markdown 仅含文字 + 表格。
- **不自动更新已经导出的文件**：导出后用户自行管理。
- **暂不支持 PDF**：只生成 Markdown。

## 8. 端到端浏览器 smoke

`scripts/s27j2-browser-smoke.cjs` 用 Puppeteer + 请求拦截模拟完整流程：

- 不读取真实私有数据；
- 拦截 `/api/private/weread/annual-review` 提供 synthetic 公共字段响应；
- 验证 27 项：tab 存在、未激活前 0 请求、激活后 1 请求、导出按钮存在、点击不新增 API 请求、下载 `.md` 文件、文件名含 `selectedYear`、MIME 正确、含年度标题、含 12 个月表格、含 Q1–Q4、含公共书目标题 / 作者 / URL、不含笔记正文 / 私有 ID / token / AI 摘要、空年度可导出、`URL.revokeObjectURL` 被调用、无服务器 POST、无外部服务、S27I ICS 入口仍存在、S27H 阅读地图入口仍存在、ICP footer 仍存在、desktop 1440 无横向滚动、mobile 360 无横向滚动。

下载文件保存到 `/tmp/s27j2-downloads`，测试结束后删除；截图保存到 `reports/screenshots/s27j2-annual-review-markdown.png`（仅本地调试用，**不入库**）。