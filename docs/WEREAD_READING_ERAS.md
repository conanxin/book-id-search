# S27M — WeRead Reading Era Segmentation

> 「长期档案」工作区新增「阅读阶段」面板。阶段划分完全基于当前已加载的 `WereadReadingArchive` 数据，浏览器本地计算，不调用任何外部 AI 服务，不读取笔记正文，不持久化。

---

## 1. 功能范围

- 在「长期档案」工作区控制区下方、「阅读阶段」标题之后渲染一个面板。
- 数据来源：`WereadReadingArchive.years` + `WereadReadingArchive.yearLinks` + `WereadReadingArchive.recurringBooks`。
- 面板仅消费已加载的档案。**不发起任何额外请求**，不调用 AI 摘要，不调用 related-books。
- 不写入 `localStorage` / `sessionStorage` / IndexedDB；不上传服务器；不索引到 Meilisearch。

## 2. 阶段划分算法

阶段边界由纯函数 `buildReadingEras(archive, mode)` 计算，仅比较相邻年份。

### 2.1 四类边界原因

| 原因 | 触发条件 | 权重 |
|------|----------|-----:|
| `year_gap` | `targetYear - baseYear > 1`（档案中存在缺失年份） | 100 |
| `activity_shift` | `max/total ≥ 2×` **且** `abs(diff) ≥ 20` | 35 |
| `active_month_shift` | `abs(diff) ≥ 5` | 25 |
| `top_list_shift` | 相邻年份 `overlapRatio < 0.2`，且双方 Top N 均非空 | 25 |

`activity_shift` 同时要求「相对倍数 ≥ 2」**和**「绝对差 ≥ 20」，避免被 1 条记录差异错误分段。

### 2.2 模式

| 模式 | 含义 | 保留的边界 |
|------|------|-----------|
| `automatic`（默认） | 自动阶段 | `year_gap` 永远保留；其他原因总分 ≥ 50 时保留 |
| `gaps_only` | 仅按年份中断分段 | 仅保留 `year_gap` |

### 2.3 单年份段合并

- 由 `year_gap` 产生的单年份段 **保留**（档案中存在真实年份中断）。
- 其他原因产生的单年份段：合并到边界分数较低的一侧；并列时合并到**前一段**。

### 2.4 阶段统计口径

| 指标 | 计算方式 |
|------|----------|
| `totalRecords` | 阶段内年度求和 |
| `totalActiveMonths` | 阶段内年度求和 |
| `averageRecordsPerYear` | `totalRecords / years.length` |
| `peakYear` | 记录最多年份；并列取**更早**年份 |
| `recurringBooks` | 在该阶段至少 2 个年份 Top N 出现的公共书目（最多 6 本，仍用当前 Top N 口径） |

## 3. 边界原因文案（白名单）

边界文案只允许使用以下四个固定中文标签，由模型模块导出：

- `年份存在中断`
- `阅读记录数量变化较大`
- `活跃月份数量变化较大`
- `相邻年度 Top N 榜单重合较低`

任何心理、兴趣、人格、阅读质量判断（"兴趣转变" / "偏好改变" / "质量提升或下降" / "专注力变化" / "成熟期" / "探索期" / "低谷" / "巅峰" 等）都不会出现在界面中。

## 4. 已知限制

- 最多 20 年（`READING_ARCHIVE_MAX_YEARS`）。
- recurring books 受当前 Top N 口径（6 / 12 / 18）影响。
- 阈值是启发式规则，不是基于主题或书籍类别。
- 不基于书名 / 作者做语义分段。
- 不支持用户自定义边界。

## 5. 隐私保证

- 面板 DOM 不包含 `note.text` / `note.comment` / `markedText` / `wereadBookId` / `noteId` / `highlightId` / `chapterTitle`。
- 不调用 `fetchWereadAnnualReview`、`fetchWereadAiSummary`、`fetchWereadRelatedBooks`。
- 不写 `localStorage` / `sessionStorage` / IndexedDB。
- 不使用 `dangerouslySetInnerHTML`。

## 6. 书目链接

阶段内显示的 recurring books 提供 `/books/:catalogId` 链接到公开书目页。仅包含 catalogId，不包含 token 或私人 ID。

## 7. 阅读阶段 Markdown 导出（S27M-2）

S27M-2 在「阅读阶段」面板增加**导出阅读阶段 Markdown** 按钮，纯浏览器本地生成：

- 使用当前已计算的 `WereadReadingEraResult`、范围、Top N 和失败年份。
- 文件名 `weread-reading-eras-<mode>-<first>-to-<latest>-YYYYMMDD.md`；空档案为 `...-empty-YYYYMMDD.md`。
- MIME `text/markdown;charset=utf-8`。
- 文件包含：标题元数据、阶段总览、阶段详情、阶段边界、recurring books、方法说明、隐私与解释边界。
- 不重新请求 annual-review、不调用 AI、不调用 related-books、不写 storage、不上传服务器。
- 不输出原始 archive/era JSON；不包含心理 / 兴趣 / 人格 / 阅读质量推断。

详见 `docs/WEREAD_READING_ERAS_MARKDOWN.md`。

## 8. 长期比较筛选（S27N）

S27N 在「阅读阶段」面板之后、年度档案目录之前，新增「长期比较筛选」面板。筛选作用于当前已加载档案：

- 六类筛选：起始年份 / 结束年份 / 最低阅读记录 / 最低活跃月份 / Recurring 最低上榜年份 / 榜单重合范围。
- 默认纳入全部成功加载年份，恢复默认按钮一键清空。
- 被排除年份及原因（中文）：早于起始年份 / 晚于结束年份 / 低于最低阅读记录 / 低于最低活跃月份。
- 输出：纳入/排除计数、年份范围、合计、年均记录；年度指标比较表；筛选范围内 Recurring Books；相邻年度榜单重合（按当前 overlap filter）。
- 不重新请求 annual-review、不调用 AI、不调用 related-books、不写 storage、不写入 URL、不修改 archive reducer / cache / retry 语义。
- 不输出心理 / 兴趣 / 人格 / 质量推断。

详见 `docs/WEREAD_READING_COMPARISON_FILTERS.md`。

## 9. 筛选比较 Markdown 导出（S27N-2）

S27N-2 在「长期比较筛选」面板增加**导出筛选比较 Markdown** 按钮，纯浏览器本地生成：

- 使用当前已计算的 `ReadingComparisonResult`、范围、Top N、失败年份。
- 文件名 `weread-reading-comparison-<first>-to-<latest>-YYYYMMDD.md`（空档案为 `...-empty-YYYYMMDD.md`）。
- MIME `text/markdown;charset=utf-8`。
- 文件包含：标题元数据、当前筛选条件、比较总览、纳入年份指标、被排除年份及原因、筛选范围内 Recurring Books、相邻年度榜单重合、方法说明。
- 不重新请求 annual-review、不调用 AI、不调用 related-books、不写 storage、不写入 URL、不上传服务器。
- 不输出原始 archive/result JSON；不包含心理 / 人格 / 个人特征 / 兴趣 / 阅读质量推断。

详见 `docs/WEREAD_READING_COMPARISON_MARKDOWN.md`。