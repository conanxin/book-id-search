# WeRead Center

WeRead Center 是 book-id-search 的独立微信读书私有数据入口页面。

## 访问路径

- https://books.conanxin.com/weread

## 使用方法

1. 打开 /weread 页面。
2. 输入 `WEREAD_PRIVATE_API_TOKEN`（由管理员配置）。
3. 页面加载私有统计摘要。

## 阅读趋势（S27B）

成功加载 summary 后会自动调用 `/api/private/weread/trends`，无需额外操作。展示项：

- 趋势卡片：最近 7 天 / 30 天 / 90 天新增、全部有日期记录、最近 30 天活跃天数、最近 30 天活跃书籍、已匹配书目笔记记录。
- 活跃度等级：根据最近 7 天新增量划分为「静默期 / 正常 / 活跃 / 非常活跃」。
- 类型分布：全部时间累计的划线 / 想法 / 书评 / 未知类型计数。
- 日期覆盖：有日期记录数、无日期记录数、日期覆盖率。
- 简单趋势条：最近 30 天的每日新增柱状图（仅展示日期与数量）。

## 私有笔记库（S27C）

页面新增「私有笔记库」区域，是首个允许展示真实笔记/划线正文的 UI 入口。**仅在浏览器持有 private token 时可见**。

| 能力 | 说明 |
|------|------|
| 加载按钮 | 默认不自动加载笔记正文。点击「加载最近笔记」才会向 `/api/private/weread/notes` 发起请求。 |
| 类型筛选 | 全部 / 划线 / 想法 / 书评。 |
| 时间窗口 | 全部时间 / 近 7 天 / 近 30 天 / 近 90 天（按 `createdAt`，缺失时回退 `updatedAt`）。 |
| 匹配筛选 | 全部 / 仅已匹配 book-id-search 书目。 |
| 排序 | 最新优先 / 最早优先。 |
| 每页 | 20 / 50（服务端 limit）。 |
| 加载更多 | 当前页 `hasMore=true` 时可继续翻页。 |
| 复制单条 | 复制该条 `text` + 可选 `comment`，不含 token / 私有 ID。 |
| Markdown 导出 | 导出当前已加载条目为 `weread-notes-export-YYYYMMDD.md`，无 token、无 `wereadBookId/noteId/highlightId/chapterTitle/title/author`。 |
| 隐私提示 | 顶部固定显示：以下内容来自你的微信读书私有笔记，仅当前浏览器 private token 模式可见。不会进入公开搜索或 Meilisearch。 |

清除 token 后，笔记库会立即重置为空，避免任何正文在内存中长期驻留。

## 私有笔记库全文搜索（S27D）

在原有筛选区下方新增一个独立的搜索区：

| 能力 | 说明 |
|------|------|
| 搜索框 placeholder | "搜索我的划线、想法、书评" |
| 触发 | 点击「搜索」按钮 / 输入框内按 Enter 触发。 |
| 清除搜索 | 仅清除 q，回到普通筛选模式（不清空已加载条目之外的 type/days/matchedOnly/sort 等筛选）。 |
| 高亮 | 命中片段使用 React 渲染 `<mark class="weread-note-highlight">`，不依赖 `dangerouslySetInnerHTML`，因此无论笔记正文内容是什么都不会产生 XSS。 |
| 筛选组合 | 搜索 q 与 type / days / matchedOnly / sort / limit 同时生效，加载更多也保留 q。 |
| 命中数显示 | 摘要条显示「当前搜索命中 N 条」，仅显示 matchedCount，不显示原始 q（q 只在搜索框内可见）。 |
| token 清除 | 清除 token 时同步清空 q、items、summary、searchInfo。 |

**搜索词隐私**：搜索词可能是私人主题。实现严格遵守以下约束：

- 搜索只走 `/api/private/weread/notes?q=...`，**不调用 `/api/search`**，不影响公开搜索排序。
- 搜索词 **不写入 Meilisearch**。
- 搜索词 **不写入任何日志文件**（服务端 `console.log/warn/error` 不会包含 q 或正文）。
- 响应里只通过 `searchInfo.{enabled,queryLength,termsCount,matchedCount}` 暴露元数据，**绝不回显原始 q 或 terms 数组**。
- 错误响应使用通用中文文案（`q 不能超过 100 个字符。`），**不回显 q**。
- 服务端 `queryPrivateNotes` 函数对 q 不做任何持久化、缓存或回写。
- Markdown 导出当前页结果时 **不包含 q**。

## 隐私边界

| 统计 | 说明 |
|------|------|
| 书架 | 微信读书书架书籍总数 |
| 笔记 | 微信读书笔记总数 |
| 已确认匹配 | 已匹配到 book-id-search 书目数量 |
| 有笔记的已匹配书 | 已匹配且有笔记记录的书数 |
| 有划线的已匹配书 | 已匹配且有划线记录的书数 |
| 已匹配书目的笔记记录 | 已匹配书对应的笔记/划线/想法/书评记录总数 |

## 个人阅读地图（S27H）

成功加载 summary 后，顶部的「笔记与 AI / 个人阅读地图」标签切换会多出第二个选项。默认仍显示「笔记与 AI」；切换到「个人阅读地图」后才会请求 `GET /api/private/weread/reading-map`，**首次激活前不会触发请求**。

| 能力 | 说明 |
|------|------|
| 阅读历史概览 | 首条 / 最近笔记日期、活跃月份、当前 / 最长连续月份、已匹配笔记记录数。 |
| 月度阅读时间轴 | 6 / 12 / 24 / 36 月可切换。每条柱状图含总笔记数 + 划线 / 想法 / 书评 / 已匹配拆分，附带无障碍文本列表。 |
| 阅读星图 | 仅在已选 topBooks 内绘制的同期阅读关系网络。节点大小 ∝ 笔记数，连线粗细 ∝ 共同活跃月份。点击节点进入 `/books/:catalogId`。 |
| 高互动书目列表 | 仅公共目录元数据（title / author / 笔记数 / 活跃月数 / 首末笔记日期）。 |
| 同期阅读关系 | 至多 24 条「共同活跃 N 个月」配对，仅显示文字标题，不暴露内部权重。 |
| 顶部隐私声明 | 固定显示：「阅读地图仅使用笔记日期、类型和已确认的公共书目匹配关系生成，不读取或展示笔记正文，也不会调用外部 AI。」 |
| 取消与重置 | token 清除时自动 abort 进行中的请求并清空所有数据；6/12/24/36 月和 6/12/18 本切换会重新请求。 |

数据流：

1. 浏览器调用 `GET /api/private/weread/reading-map?months={6|12|24|36}&topBooks={6|12|18}`，附 `Authorization: Bearer <token>`。
2. 服务端仅读取本地 private snapshot，通过 `loadWereadOverlay` 拿到 `notesByBook` 与 `confirmedByCatalogId`。
3. 服务端调用 `index.getDocument(catalogId)` 在 Meilisearch `books` 索引直接获取公开 `title / author / publisher / year`，失败 fallback 为 `书目 ${catalogId}`。
4. 响应只携带 `overview / timeline / books / links / meta.persisted = false`，**不返回 `wereadBookId` / `noteId` / `highlightId` / `chapterTitle` / 微信读书原始 title / author / 任何笔记正文**。

详见 `docs/WEREAD_READING_MAP.md`。

## 当前会话主题层（S27H-2）

S27H-2 在「个人阅读地图」顶部追加了独立的「当前会话主题层」区块，仅复用当前浏览器会话中已经生成的 AI 摘要（主题标题 + 延伸阅读方向）与当前已加载的 matched 书目 catalogId。完整边界、UI 状态、状态共享管线见 [`docs/WEREAD_SESSION_THEME_OVERLAY.md`](./WEREAD_SESSION_THEME_OVERLAY.md)。

## 不显示的内容

- 笔记正文
- 划线正文
- 想法/书评原文
- `wereadBookId`
- `noteId` / `highlightId`
- 微信读书原始 title / author
- 章节标题 `chapterTitle`

## 隐私与数据边界

- Token 只保存在浏览器 `sessionStorage` 中。
- 关闭浏览器或清除 token 后不再访问私有数据。
- 页面不调用 `/api/search`，不影响搜索排序。
- 不写入 Meilisearch 索引。
- 默认公开访问者看不到任何私人数据。

## 根据主题发现相关书（S27G）

AI 摘要成功显示后，会在同一区域下方出现一个虚框入口「根据当前主题发现相关书」：

| 能力 | 说明 |
|------|------|
| 触发 | 用户主动点击「发现相关书」，不自动请求。 |
| 种子来源 | 仅取 AI 摘要中的 `themes[].title`；不足 2 个时追加 `readingDirections[]`；不使用 `overview`、`keyPoints`、`reviewQuestions`、笔记正文、搜索词 `q`。 |
| 排除项 | 当前已加载的、已匹配 book-id-search 书目的 `catalogId` 自动排除，避免推荐正在读的书。 |
| 请求 | `POST /api/private/weread/related-books`（私有 token）。 |
| 路由 | **不进入公开 `/api/search`，不写入 Meilisearch，不调用 MiniMax，不写任何日志**。 |
| 响应 | 仅公开目录元数据（`catalogId` / `title` / `author` / `publisher` / `publishYear` / `isbn` / `matchedSeedIds`），不含 seed.text 或私有 ID。 |
| 操作 | 「重新发现」重新发请求；「清除结果」清空当前结果。 |
| 错误处理 | `401` / `403`（鉴权失败）、`413`（请求体过大）、`429`（限流或并发）、`502`（上游暂不可用）等通用中文反馈；错误响应不回显 seed 文本或 token。 |
| 初始化 | summary、token、已加载笔记列表任意一项变化都会清空旧结果，避免显示过期的推荐。 |
| 取消 | token 改变或组件卸载时 `AbortController` 取消未完成的请求。 |
| 隐私提示 | 顶部固定显示：仅将 AI 摘要中的主题词发送到本站私有检索接口；不会再次发送笔记正文给 MiniMax，也不会进入公开搜索日志。 |

详见 `docs/WEREAD_RELATED_BOOKS.md`。

## 与主搜索的关系

- WeRead Center 是独立页面，只读取私有 overlay API。
- 主搜索页仍通过搜索卡片的 WeRead badge 展示 counts-only 统计。
- 两者共享同一个 token 和 sessionStorage 存储。

## 如何关闭

- 点击“清除 token”按钮。
- 或关闭浏览器会话。

## 复习日历（S27I）

`WereadCenter` 自 S27I 起提供第三个工作区「复习日历」，与「笔记与 AI」「个人阅读地图」并列。它复用 `fetchWereadReadingMap` 与 `WereadSessionThemeOverlay` 派生确定性复习建议。详见 `docs/WEREAD_REVIEW_CALENDAR.md`。该工作区不在服务端持久化、不调用 AI、不修改任何既有端点。

S27I-2 新增「导出日历文件 (.ics)」按钮，纯浏览器生成。详见 `docs/WEREAD_REVIEW_CALENDAR_ICS.md`：
- 三种导出范围：全部任务 / 仅书目任务 / 仅当前会话主题。
- 全天事件（`VALUE=DATE`），不输出 VTIMEZONE。
- 文件名 `weread-review-calendar-<horizon>-<range>-YYYYMMDD.ics`，仅 ASCII。
- 不新增任何 API、不调用 Google / Apple / Outlook、不写入 localStorage / sessionStorage / IndexedDB / 服务器。

### 复习日历 ICS 导出（S27I-2）

S27I-2 新增「导出日历文件 (.ics)」按钮，纯浏览器生成。详见 `docs/WEREAD_REVIEW_CALENDAR_ICS.md`：
- 三种导出范围：全部任务 / 仅书目任务 / 仅当前会话主题。
- 全天事件（`VALUE=DATE`），不输出 VTIMEZONE。
- 文件名 `weread-review-calendar-<horizon>-<range>-YYYYMMDD.ics`，仅 ASCII。
- 不新增任何 API、不调用 Google / Apple / Outlook、不写入 localStorage / sessionStorage / IndexedDB / 服务器。

## 年度回顾（S27J）

`WereadCenter` 自 S27J 起提供第四个工作区「年度回顾」，与「笔记与 AI」「个人阅读地图」「复习日历」并列。它通过新增的 `GET /api/private/weread/annual-review?year=<YYYY>&topBooks=<6|12|18>` 端点，按选中年份聚合概览、12 个月时间轴、类型分布、Q1–Q4 季度卡、年度高互动书目与年度记录卡。详见 `docs/WEREAD_ANNUAL_REVIEW.md`。

关键约束：

- 只统计有 `createdAt` / `updatedAt` 且日期落在 `selectedYear` 的笔记。
- 年度 top books 仅按 `selectedYear` 聚合：跨年记录自动排除。
- `month.bookCount` / `quarter.bookCount` 仅反映 confirmed matched public catalogId。
- 公共元数据通过 Meilisearch `index.getDocument` 直读；端点不调用 `/api/search`。
- 不调用 MiniMax、不写入 Meilisearch、不持久化、不提供公开分享链接。
- 月度活跃度分类（高活跃 / 稳定 / 轻量 / 无记录）只基于数量，UI 顶部固定免责声明。
- 年度记录卡只展示数量 / 月份 / 类型 / 书目 / 峰值月份等描述性统计，不做心理推断。

### 年度回顾 Markdown 导出（S27J-2）

S27J-2 新增「导出年度回顾 Markdown」按钮，纯浏览器生成。详见 `docs/WEREAD_ANNUAL_REVIEW_MARKDOWN.md`：

- 文件名 `weread-annual-review-<year>-YYYYMMDD.md`，仅 ASCII，长度 ≤ 80。
- MIME `text/markdown;charset=utf-8`。
- 文档结构：标题 + 4 条 meta + 隐私引用块 + 年度概览 + 12 个月时间轴 + 季度回顾 + 年度高互动书目 + 年度记录 + 说明。
- 空年度保留完整 12 行零值表 + 四张零值季度卡 + 说明区，不伪造任何字段。
- 不重新调用 annual-review API、不调用 AI、不写 localStorage / sessionStorage / IndexedDB / 服务器。

### 年度对比（S27K）

S27K 在「年度回顾」工作区新增「开启年度对比」入口。详见 `docs/WEREAD_YEAR_COMPARISON.md`：

- 复用两份 `GET /api/private/weread/annual-review` 响应（基准年 + 目标年），不新增 endpoint。
- 仅当 `availableYears.length >= 2` 时入口可用，否则 disabled。
- 浏览器内缓存（dashboard 生命周期内）防止重复请求。
- 输出：六张核心指标同比卡 / 12 个月双柱 / Q1–Q4 对比 / 顶部书目连续 / 进入 / 未上榜 / 描述性摘要。
- 描述性摘要只描述数量 / 排名 / 月份变化；不做心理 / 质量 / 兴趣推断。
- 不调用 MiniMax、不调用 related-books、不写 localStorage / sessionStorage / IndexedDB / 服务器。
- 切换 token / 卸载组件 / 关闭对比时立即清空所有对比状态与缓存。

### 年度对比 Markdown 导出（S27K-2）

S27K-2 在「年度对比」面板新增「导出年度对比 Markdown」按钮，纯浏览器生成。详见 `docs/WEREAD_YEAR_COMPARISON_MARKDOWN.md`：

- 仅使用面板当前已加载的 `WereadYearComparison`。
- 不重新请求 annual-review API、不调用 AI、不调用 related-books、不写 localStorage / sessionStorage / IndexedDB / 服务器。
- 文件名：`weread-year-comparison-<base>-vs-<target>-YYYYMMDD.md`，纯 ASCII，≤ 80 字符；MIME：`text/markdown;charset=utf-8`。
- 切换基准年 / 目标年 / Top N 范围 / 关闭对比时，已显示的成功状态立即清空。
- 两年空数据也允许导出，输出零值结构；不输出心理 / 兴趣 / 性格推断。
