# S27L-2 — WeRead Reading Archive Markdown Export

> 「长期档案」工作区新增「导出长期阅读档案 Markdown」按钮。Markdown 完全在当前浏览器内生成，不写入服务器、不调用任何外部 AI 服务、不持久化到 localStorage / sessionStorage / IndexedDB。

---

## 1. 功能范围

- 在「长期档案」工作区控制区下方新增「导出长期档案 Markdown」按钮。
- 文件只使用工作区当前已加载的 `WereadReadingArchive`（档案总览、跨年度趋势、年度档案目录、多年 Top N 书目、相邻年度榜单重合）。
- 切换年份范围 / Top N / archive 数据 / 失败年份 / token 后，已显示的「已生成…」成功提示会立即清空，避免误导。
- 部分失败（部分年份 `failed`）仍可导出，文件包含完整性提示与失败年份列表。
- 空档案（bootstrap 已完成但无任何成功加载年份）仍可导出：Markdown 文件只包含元数据、隐私说明、空档案提示和说明区，不伪造趋势 / 书目 / 榜单重合。
- 单一年份：导出该年度档案，recurring books 与相邻年度重合为空并附说明。
- 文件名：`weread-reading-archive-<first>-to-<latest>-YYYYMMDD.md`，例如 `weread-reading-archive-2021-to-2025-20260804.md`；空档案 fallback：`weread-reading-archive-empty-YYYYMMDD.md`。
  - 仅 ASCII；
  - 不含书名 / 作者 / catalogId / token / 私有 ID；
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

1. 用户点击按钮 → 组件调用纯函数 `buildReadingArchiveMarkdown({ archive, rangeLabel, topBooksLimit, failedYears, exportedAt })`。
2. 函数返回 `{ content, filename, mimeType, byteLength, rangeLabel, topBooksLimit, yearCount, failedYearCount }`。
3. 组件调用 `triggerReadingArchiveMarkdownDownload({ content, filename })`：
   - 用 `new Blob([content], { type: "text/markdown;charset=utf-8" })` 创建 Blob；
   - `URL.createObjectURL(blob)` 生成临时 URL；
   - 创建 `<a>` 元素（`rel="noopener"`、`data-testid="weread-reading-archive-markdown-anchor"`），挂到 `document.body`，`.click()`，再 `remove()`；
   - `setTimeout(0)` 后调用 `URL.revokeObjectURL(blobUrl)` —— 让浏览器读完 blob URL 后立刻释放。
4. 状态更新为「已生成长期阅读档案 Markdown。」成功文案不带 token / 笔记正文 / 私有 ID。
5. 用户后续如何处理 `.md` 文件由自己决定（直接打开 / 拖入笔记软件 / 上传到私人网盘）。

## 3. Markdown 文件结构

```
# 长期阅读档案

- 档案年份：YYYY—YYYY / 暂无年份
- 当前范围：最近 5 年 / 最近 10 年 / 全部
- 高互动书目口径：各年度 Top 12
- 请求年份：N 个
- 成功加载年份：N 个
- 暂时失败年份：N 个
- 导出时间：YYYY-MM-DD HH:mm
- 数据来源：微信读书私有年度聚合数据
- 生成方式：book-id-search 浏览器本地生成
- 保存状态：未上传服务器

> 隐私说明：本文件由用户主动在当前浏览器中生成…
> 口径说明：多年书目和年度榜单重合只基于当前各年度 Top N 榜单…
> 完整性提示：本次有 N 个年份暂时加载失败…   (only when failedYears > 0)
> 数据完整性：所有目标年份均已成功加载。       (only when failedYears == 0)

## 档案总览
- 有记录年份：N
- 最早年份：YYYY / —
- 最近年份：YYYY / —
- 阅读记录合计：N
- 活跃月份合计：N
- 年均记录：N.x
- 最高记录年份：YYYY（N 条）/ —
- 最长连续活跃年份：N 年
- 多年进入 Top N 榜单的书目：N 本

## 跨年度趋势
| 年份 | 阅读记录 | 有效日期记录 | 已匹配记录 | 年度书目 | 活跃月份 | 最长连续月份 | 高峰月份 | 月均记录 |
|---:|---:|---:|---:|---:|---:|---:|---|---:|
| 2021 | ... | ... | ... | ... | ... | ... | 2021-06 | 8.0 |
| ... |

## 年度档案目录
### 2025 年
- 阅读记录：N
- 有效日期记录：N
- 已匹配记录：N
- 年度书目：N
- 活跃月份：N
- 最长连续活跃：N 个月
- 高峰月份：YYYY 年 M 月 / —
- 高峰月份记录：N
- 活跃月份平均记录：N.x
- 查看方式：微信读书中心 → 年度回顾 → 选择 2025 年

### 2024 年
...

## 多年进入 Top 12 高互动榜的书目
> 本节只统计各年度当前 Top 12 榜单中重复出现的公共书目，不代表全部阅读记录或长期偏好。
### 1. 《公共书目 A》
- 作者：公共作者
- 出版信息：出版社 X，2020
- 进入榜单年份：2022、2024、2025
- 进入榜单次数：3 年
- 最佳排名：第 1
- 最新上榜年份：2025
- 最新年份排名：第 2
- 榜单内年度记录合计：N
- 书目页面：https://books.conanxin.com/books/<catalogId>

## 相邻年度榜单重合
> 榜单重合只表示相邻年份 Top N 公共书目列表的交集，不代表阅读兴趣稳定、变化或阅读质量。
| 相邻年份 | 共同上榜书目 | 榜单重合率 |
|---|---:|---:|
| 2024 → 2025 | N | N% |

## 数据完整性
- 暂时失败年份数量：N
- 暂时失败年份：YYYY、YYYY

## 说明
- 只使用当前浏览器已经加载的年度回顾结果。
- 本次导出不会重新请求年度 API。
- 阅读记录合计可以跨自然年求和。
- 各年度 Top N 书目受范围限制，跨年求和可能重复计数。
- 多年书目和榜单重合受当前 Top N 范围影响。
- 本报告未读取笔记正文。
- 本报告未调用外部 AI。
- 本报告未上传或保存到服务器。
- 本报告不分析阅读主题、兴趣、心理或阅读质量。
```

## 4. 隐私 / 边界合约

- Markdown 文件**绝不包含**以下字段：
  - 笔记正文（`note.text`）
  - 笔记评论（`note.comment`）
  - 高亮 / 想法 / 评论 ID（`noteId` / `highlightId` / `wereadBookId`）
  - 章节标题（`chapterTitle`）
  - 标记文本（`markedText`）
  - AI 摘要正文、要点、提问（`summary.body` / `summary.overview` / `summary.keyPoints` / `summary.reviewQuestions`）
  - 会话主题（`session_theme` / `themes.*`）
  - 微信读书原始 title / author
  - 私有 token / API key / `Authorization: Bearer …` / `q=` 搜索串
  - 请求 / 缓存 / 调试状态（`cacheRef` / `inflightRef` / `scheduleYearFetches` / `requestId` / `debugSnapshot`）
- 允许出现的字段仅限：
  - 公共书目 ID（`catalogId`，仅在 `/books/<catalogId>` 路径内）
  - 公共 title / author / publisher / publishYear
  - 阅读记录数 / 已匹配记录数 / 活跃月份数 / 最长连续月份数 / 高峰月份 / 月均记录
  - Top N 排名 / 进入榜单年份 / 榜单重合率
  - 档案年份范围 / 导出时间戳

`validateReadingArchiveMarkdown(content)` 提供自动化扫描作为最后一道防线：一旦 Markdown 中出现上述任一敏感字段，浏览器 smoke 立即失败。

## 5. 范围与口径

| 范围 | 含义 |
|---|---|
| 最近 5 年 | 当前年份起回溯 5 个自然年（含当前年） |
| 最近 10 年 | 当前年份起回溯 10 个自然年 |
| 全部 | 上限 20 个年份 |

| Top N | 含义 |
|---|---|
| Top 6 | 各年度 `/api/private/weread/annual-review?topBooks=6` 口径 |
| Top 12 | 各年度 `/api/private/weread/annual-review?topBooks=12` 口径 |
| Top 18 | 各年度 `/api/private/weread/annual-review?topBooks=18` 口径 |

**重要口径限制：**
- 跨年唯一书目数：**不能**直接由各年度 Top N 求和得出（同一本书可能在多年榜单都出现），Markdown 仅按当前 Top N 范围统计。
- 相邻年度榜单重合：仅基于当前年份范围 / Top N 口径下的相邻年份对，不反映更长远的稳定 / 变化趋势。
- 月均记录数最多保留 1 位小数。
- 阅读记录合计可跨自然年求和。

## 6. 部分失败 / 空档案 / 单一年份

| 场景 | 处理 |
|---|---|
| 全部成功（failedYears == 0） | 顶部包含 `数据完整性：所有目标年份均已成功加载。` |
| 部分失败（failedYears.length > 0） | 顶部包含 `完整性提示：本次有 N 个年份暂时加载失败…`；`## 数据完整性` 节列出 `暂时失败年份：YYYY、YYYY`（按升序） |
| 空档案（archive.years.length == 0） | 档案总览、跨年度趋势、年度目录、多年 Top N、相邻年度重合全部替换为「当前暂无…」说明；不伪造任何数字 |
| 单一年份 | 输出该年度档案；recurring books 节保留「暂无跨多个年份重复进入榜单的书目」；相邻年度重合保留「不足以生成相邻年份榜单重合」 |

## 7. 已知限制

- 最多 20 个年份（受当前 model 的 `READING_ARCHIVE_MAX_YEARS` 限制）。
- 跨年唯一书目数没有准确口径（不输出伪统计）。
- 不包含笔记正文、章节标题、主题分类、心理 / 阅读质量分析。
- 不生成 PDF / 图片 / 图表。
- 不支持自动公开分享、不支持自动更新。
- 文件名仅 ASCII；非 ASCII 字段时间戳仅在文件内容里出现。
- 不修改 Reading Archive 状态机和请求调度语义（导出按钮只读当前 archive，不会触发任何 fetch）。

## 8. 与 S27L 状态机的边界

- 导出状态（成功 / 失败 / 消息）保存在组件局部 `useState`，**不进入** reducer。
- `resetKey = rangeLabel | topBooksLimit | loadedYears | firstYear | latestYear | failedYears`，任一变化即清空导出状态。
- 点击导出**不调用** `fetchWereadAnnualReview` / `fetchWereadAiSummary` / `fetchWereadRelatedBooks`。
- 点击导出**不改变** range / Top N / cache / retry 状态。
- 不使用 `dangerouslySetInnerHTML`。
- 不使用 `alert` / `confirm` / `prompt`。
