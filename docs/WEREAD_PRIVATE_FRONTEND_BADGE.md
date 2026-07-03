# WeRead 私有模式前端徽章

本文档描述前端「微信读书私有模式」入口与 WeRead 状态徽章。

## 启用方式

1. 打开前端页面。
2. 在页面顶部找到「微信读书私有模式」输入框。
3. 输入管理员提供的 private token，点击「连接」。
4. Token 只保存在当前浏览器 `sessionStorage` 中，关闭标签页或清除 token 后即失效。

## 界面表现

- 连接成功后，顶部显示：
  - 微信读书私有模式已启用
  - 书架 {booksCount}
  - 笔记 {notesCount}
  - 已确认匹配 {confirmedMatchesCount}
- 搜索结果中，已匹配的书卡显示绿色「微信读书 · {阅读状态}」徽章。
- 点击进入书籍详情页，会显示更完整的 WeRead 徽章：
  - 阅读状态
  - 进度（如果有）
  - 笔记数量（如果有）
  - 划线数量（如果有）
  - 匹配置信度和匹配方法
- 未匹配或 token 无效时不显示任何徽章。

## 隐私保证

- Token 只保存在 `sessionStorage`，不会写入 `localStorage`、源码、Git、URL、console 或日志。
- 不显示真实 `wereadBookId`。
- 不显示笔记正文或划线正文。
- 不显示用户真实书架列表。
- 公开访问者看不到任何微信读书信息，也不会触发私有 API 请求。

## 性能

- 前端优先使用 `POST /api/private/weread/status/batch`；一次请求最多查询 100 个 catalogId。
- 当前搜索页每页 20 条，因此一页只需要一次 batch 请求。
- 如果 batch endpoint 不可用（例如旧部署），前端会自动 fallback 到单条 `GET /api/private/weread/status`。
- 前端仍然保留内存缓存（最多 200 条），避免重复请求。

## 限制

- 已确认匹配数目前仍为 51，所以只有 51 本书可以显示 WeRead badge。
- 未确认匹配的书不会显示 badge。
- badge 不展示书名、作者、笔记正文、划线正文或任何 WeRead 私有 ID。

## 不影响公开搜索

- 未输入 token 时，搜索、排序、结果数量与响应均不变。
- 私有 API 失败不会阻塞公开搜索结果的渲染。
