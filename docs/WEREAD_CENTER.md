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
