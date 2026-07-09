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

## 与主搜索的关系

- WeRead Center 是独立页面，只读取私有 overlay API。
- 主搜索页仍通过搜索卡片的 WeRead badge 展示 counts-only 统计。
- 两者共享同一个 token 和 sessionStorage 存储。

## 如何关闭

- 点击“清除 token”按钮。
- 或关闭浏览器会话。
