# S27K-2 — WeRead Year Comparison Markdown Export

> 「年度对比」工作区新增「导出年度对比 Markdown」按钮。Markdown 完全在当前浏览器内生成，不写入服务器、不调用任何外部 AI 服务、不持久化到 localStorage / sessionStorage / IndexedDB。

---

## 1. 功能范围

- 在「年度对比」面板（`YearComparisonPanel`）的控制区下方新增「导出年度对比 Markdown」按钮。
- 文件只使用面板当前已经加载的 `WereadYearComparison` 结果（基准年度、目标年度、当前 Top N 范围、六项核心指标、12 个月对比、Q1–Q4 对比、连续进入/进入/未进入三个高互动书目榜变化分组、模型生成的描述性变化摘要）。
- 切换基准年度、目标年度、Top N 范围或清除 token 后，已显示的「已生成 …」成功提示会立即清空，避免误导。
- 切换基准年 / 目标年 / Top N 范围 / 关闭年度对比都会触发同一状态清除逻辑，文件内容与按钮按下时一致。
- 两年空数据仍可导出：Markdown 文件包含完整零值六项指标表、12 个月零值对比、四张零值季度卡、三个空书目变化分组；不伪造任何记录或书目。
- 文件名：`weread-year-comparison-<base>-vs-<target>-YYYYMMDD.md`，例 `weread-year-comparison-2024-vs-2025-20260803.md`。
  - 仅 ASCII；
  - 两个年份必须为合法四位数字；
  - 不含书名 / 作者 / 主题 / catalogId / token / 私有内容；
  - 长度 ≤ 80 字符；
  - MIME：`text/markdown;charset=utf-8`。
- 整个流程只在浏览器内运行：
  - 不重新调用 `/api/private/weread/annual-review`；
  - 不调用 `/api/private/weread/notes/summarize`（AI 摘要）；
  - 不调用 `/api/private/weread/related-books`；
  - 不写入 `localStorage` / `sessionStorage` / IndexedDB；
  - 不持久化到服务器 / Meilisearch / 任何外部服务。

## 2. 浏览器下载机制

1. 用户点击按钮 → 组件调用纯函数 `buildYearComparisonMarkdown({ comparison, topBooksLimit, exportedAt })`。
2. 函数返回 `{ content, filename, mimeType, byteLength, baseYear, targetYear, topBooksLimit }`。
3. 组件调用 `triggerYearComparisonMarkdownDownload({ content, filename })`：
   - 用 `new Blob([content], { type: "text/markdown;charset=utf-8" })` 创建 Blob；
   - `URL.createObjectURL(blob)` 生成临时 URL；
   - 创建 `<a>` 元素（`rel="noopener"`、`data-testid="weread-year-comparison-markdown-anchor"`），挂到 `document.body`，`.click()`，再 `remove()`；
   - `setTimeout(0)` 后调用 `URL.revokeObjectURL(blobUrl)` —— 让浏览器读完 blob URL 后立刻释放。
4. 状态更新为「已生成 2024—2025 年年度对比 Markdown。」成功文案不带 token / 笔记正文 / 私有 ID。
5. 用户后续如何处理 `.md` 文件由自己决定（直接打开 / 拖入笔记软件 / 上传到私人网盘）。

## 3. Markdown 文件结构

```
# 2024—2025 年阅读对比

- 基准年度：2024
- 目标年度：2025
- 高互动书目范围：Top 12
- 导出时间：YYYY-MM-DD HH:mm
- 数据来源：微信读书私有年度聚合数据
- 生成方式：book-id-search 浏览器本地生成
- 保存状态：未上传服务器

> 隐私说明：本文件由用户主动在浏览器中生成。文件包含公共书目信息和个人阅读统计，请自行妥善保管。

> 解释边界：以下结果只描述阅读记录数量和公共书目榜单变化，不代表阅读质量、兴趣、心理状态或开始/停止阅读。

## 核心指标

| 指标 | 2024 | 2025 | 变化 | 百分比 |
|---|---:|---:|---:|---:|
| 阅读记录 | 100 | 150 | +50 | +50.0% |
| 活跃月份 | 8 | 10 | +2 | +25.0% |
| 已匹配记录 | 80 | 110 | +30 | +37.5% |
| 年度书目 | 5 | 6 | +1 | +20.0% |
| 最长连续月份 | 4 | 6 | +2 | +50.0% |
| 活跃月份平均记录 | 12.5 | 15 | +2.5 | +20.0% |

百分比列规则：
- `from_zero`（基准为 0、目标 > 0） → `由 0 开始`
- `to_zero`（基准 > 0、目标 = 0） → `-100%`
- `same`（两者相等） → `0%`
- 正常变化 → `+N%` / `−N%`
- 不允许出现 `NaN` / `Infinity` / `null`。

## 12 个月对比

| 月份 | 2024记录 | 2025记录 | 差值 | 2024书目 | 2025书目 |
|---|---:|---:|---:|---:|---:|
| 1月 | 10 | 12 | +2 | 3 | 3 |
| 2月 | 8 | 10 | +2 | 2 | 3 |
| … 12 行 |

固定 12 行（1 月～12 月），按月份升序。

## 季度对比

### Q1

- 2024 阅读记录：30
- 2025 阅读记录：36
- 变化：+6
- 2024 活跃月份：3
- 2025 活跃月份：3
- 2024 书目：5
- 2025 书目：6

依次 Q1 / Q2 / Q3 / Q4。

## 连续进入两年高互动书目榜

### 1. 《公共书名》

- 作者：公共作者
- 2024 排名：第 2
- 2025 排名：第 1
- 排名变化：上升 1 位
- 2024 阅读记录：N
- 2025 阅读记录：N
- 书目页面：https://books.conanxin.com/books/<catalogId>

## 进入目标年度高互动书目榜

> 本分组只表示书目进入当前 Top N 榜单，不表示该书首次开始阅读。

### 1. 《新进书名》

- 作者：公共作者
- 2024 排名：—
- 2025 排名：第 N
- 排名变化：—
- 2024 阅读记录：0
- 2025 阅读记录：N
- 书目页面：https://books.conanxin.com/books/<catalogId>

## 未进入目标年度高互动书目榜

> 本分组只表示书目未进入当前 Top N 榜单，不表示已经停止阅读。

### 1. 《未进书名》

- 作者：公共作者
- 2024 排名：第 N
- 2025 排名：—
- 排名变化：—
- 2024 阅读记录：N
- 2025 阅读记录：0
- 书目页面：https://books.conanxin.com/books/<catalogId>

## 描述性变化摘要

- 目标年度阅读记录比基准年度增加 50 条。
- 目标年度活跃月份为 10 个，基准年度为 8 个。
- 目标年度已匹配记录为 110 条，基准年度为 80 条。
- 目标年度已匹配书目为 6 本，基准年度为 5 本。
- 记录高峰月份从 4月 变为 7月。
- 有 1 本书连续进入两年的高互动书目榜。
- 有 1 本书进入目标年度高互动书目榜。
- 有 1 本书未进入目标年度高互动书目榜。

仅输出当前模型生成的规则摘要；不补充心理推断、兴趣转移、阅读偏好变化等额外叙述。

## 说明

- 比较范围为两个自然年。
- 只有有效日期记录进入年度统计。
- 高互动书目变化受当前 Top N 范围影响。
- 榜单进入或离开不表示开始或停止阅读。
- 本报告未使用外部 AI。
- 本报告未分析阅读主题、阅读质量或个人特征。
```

### 空数据（两年均无）输出

```
# 2024—2025 年阅读对比

（标题、meta、隐私说明、解释边界均保留）

## 核心指标

| 指标 | 2024 | 2025 | 变化 | 百分比 |
|---|---:|---:|---:|---:|
| 阅读记录 | 0 | 0 | 0 | 0% |
| … 六项指标全部 0 …

## 12 个月对比

12 行全部为 `0`。

## 季度对比

四张零值卡。

## 连续进入两年高互动书目榜

无连续进入两年高互动书目榜的书目。

## 进入目标年度高互动书目榜

> 本分组只表示书目进入当前 Top N 榜单，不表示该书首次开始阅读。

无新进入目标年度高互动书目榜的书目。

## 未进入目标年度高互动书目榜

> 本分组只表示书目未进入当前 Top N 榜单，不表示已经停止阅读。

无未进入目标年度高互动书目榜的书目。

## 描述性变化摘要

当前对比未生成新的描述性摘要。
```

### 单边空数据

- 基准年无数据、目标年有数据：`from_zero` 语义；`entered` 分组可正常输出；不声称是「新读书目」。
- 基准年有数据、目标年无数据：`to_zero` 语义；`left` 分组可正常输出；不声称「停止阅读」。

## 4. 字段来源与转义

| 字段 | 来源 | 转义规则 |
|------|------|----------|
| `comparison.baseYear` / `comparison.targetYear` | 当前对比基准 / 目标年 | 4 位年份直接嵌入标题与 meta |
| `comparison.topBooksRange` | 当前 Top N 范围 | 仅在 meta 中显示 `Top 6/12/18` |
| `comparison.metrics[]` | S27K 模型计算结果 | 数字原样输出；百分比按 from_zero / to_zero / 正常 规则 |
| `comparison.months[]` | S27K 模型计算结果（12 个月） | 数字原样输出；固定 12 行 |
| `comparison.quarters[]` | S27K 模型计算结果（Q1–Q4） | 数字原样输出 |
| `comparison.continuingBooks[]` | `target.title` / `target.author` 优先，回退 `base.title` / `base.author` | `escapeComparisonMarkdownInline` |
| `comparison.enteredBooks[]` | 仅 target 字段 | `escapeComparisonMarkdownInline` |
| `comparison.leftBooks[]` | 仅 base 字段 | `escapeComparisonMarkdownInline` |
| `comparison.summaries[]` | S27K 模型规则摘要 | `escapeComparisonMarkdownInline` |
| `book.catalogId` | 公共 catalogId | 仅出现在 `/books/<catalogId>` 链接中 |

### Markdown 转义

`escapeComparisonMarkdownInline` 处理：`\`、`*`、`_`、`` ` ``、`[`、`]`、`<`、`>`、`#`、`|`；折叠空白、剔除控制字符；换行 / 回车替换为单个空格。

`escapeComparisonMarkdownTableCell` 在 `escapeComparisonMarkdownInline` 基础上额外处理换行（保证单元格不破行）和 HTML 元字符。

`formatPercentCell` 在指标百分比列使用 from_zero / to_zero / same / 正常四种规则：
- `from_zero` → `由 0 开始`
- `to_zero` → `-100%`
- `same` → `0%`
- 正常 → `+N%` / `−N%`（整数无小数；一位小数）

`formatRankChangeLabel`：
- 正值 → `上升 N 位`
- 负值 → `下降 N 位`
- 0 → `持平`
- null → `—`

### 强制不可出现在 Markdown 的内容

- 笔记正文 / 评论 / `markedText` / `content`
- 微信读书内部 ID：`wereadBookId` / `noteId` / `highlightId` / `chapterTitle`
- 微信读书原始 `title` / `author`（响应已由 API 层脱敏，模型直接复用公共字段）
- AI 摘要 `summary.overview` / `summary.keyPoints` / `summary.reviewQuestions` / `summary.themes`
- `token` / `q` / 任意 API key
- 私有 API URL
- 原始 snapshot 记录
- 心理推断词：懒惰 / 焦虑感 / 专注力 / 人格特征 / 性格 / 阅读能力 / 情绪化 / 焦虑型 / 心理问题 / 心理分析

`catalogId` 仅出现在公开书目 URL `https://books.conanxin.com/books/<catalogId>`。

## 5. 隐私边界

- **不读取笔记正文**：模型只消费 S27K `WereadYearComparison` 中已有的字段。
- **不调用 AI / related-books**：模型纯函数；下载辅助函数零网络。
- **不持久化**：模型不写 `localStorage` / `sessionStorage` / IndexedDB；下载辅助函数只用 `Blob` + 临时 `<a>` + `URL.revokeObjectURL`。
- **不提供公开分享**：Markdown 文件不上传到服务器，没有分享链接，没有任何公开访问入口。
- **不伪造内容**：空年度输出零值结构；不输出高峰月份、`top books`、心理或性格推断。
- **不写日志**：辅助函数从不 `console.log` Markdown 内容或 token。
- **不修改主选择**：导出按钮不会改变基准年 / 目标年 / Top N；不调用 `fetchWereadAnnualReview` / `fetchWereadAiSummary` / `fetchWereadRelatedBooks`。
- **状态清除**：基准年 / 目标年 / Top N / 关闭对比 任意一项变化时，已显示的成功 / 失败状态都会立即清空，避免误导。

## 6. 测试覆盖

| 文件 | 数量 | 范围 |
|------|------|------|
| `apps/web/src/weread/wereadYearComparisonMarkdown.test.ts` | 57 | 模型单元测试（转义 / 日期 / 指标 / 12 个月 / 季度 / 三个书目变化分组 / 排名变化 / 单边空 / 双边空 / 文件名 / 校验 / 下载 / 隐私 / 心理推断） |
| `apps/web/src/weread/YearComparisonPanel.test.ts` (S27K-2 段) | 9 | 组件结构 / 样式 / 隐私合同 / 按钮 disabled / 不调用 fetch / 状态清除 / 不 alert |
| `scripts/s27k2-browser-smoke.cjs` | 30 | 浏览器端下载 / 文件名 / 内容结构 / 隐私 / 视觉布局 |

合计 ≥ 95 项断言。

## 7. 已知限制

- **只导出当前基准年 / 目标年 + 当前 Top N 范围**。切换年份或 Top N 必须重新点击按钮。
- **只比较两个自然年**。不支持多年滚动对比。
- **不包含 AI 年度总结**：不调用 MiniMax，不生成叙述。
- **不包含主题分析**：不调用 related-books。
- **不包含图片或图表截图**：Markdown 仅含文字 + 表格。
- **不自动更新已经导出的文件**：导出后用户自行管理。
- **暂不支持 PDF**：只生成 Markdown。
- **不包含心理学、兴趣、专注力、性格推断**。

## 8. 端到端浏览器 smoke

`scripts/s27k2-browser-smoke.cjs` 用 Puppeteer + 请求拦截模拟完整流程：

- 不读取真实私有数据；
- 拦截 `/api/private/weread/annual-review` 提供 synthetic 公共字段响应；
- 验证 30 项：tab 存在、年度对比默认关闭、开启后对比正常、导出按钮存在、不点击时无下载、点击不新增 annual-review 请求、下载 `.md` 文件、MIME 正确、文件名含基准/目标年份、文件含年度对比标题、文件含六项指标、文件含 12 月表格、文件含 Q1～Q4、文件含 continuing/entered/left、文件含 synthetic 公共 title/author、文件含公开书目 URL、文件不含 synthetic 禁止的笔记正文/评论、文件不含私有 IDs、文件不含 token/q、文件不含 AI summary/theme、base=0 不含 Infinity/NaN、空数据对比可导出、`URL.revokeObjectURL` 被调用、无服务器 POST、无外部服务请求、年度回顾 Markdown 导出仍存在、S27I ICS 导出仍存在、ICP footer 仍存在、desktop-1440 无横向滚动、mobile-360 无横向滚动。

下载文件保存到 `/tmp/s27k2-downloads`，测试结束后删除；截图保存到 `reports/screenshots/s27k2-year-comparison-markdown.png`（仅本地调试用，**不入库**）。