# WeRead Related-Book Discovery (S27G)

`/weread` 用户在完成 AI 笔记整理之后，可以基于 AI 摘要里的主题词，触发一次"根据主题发现相关公开书目"的检索。本文档描述这条功能、它的隐私边界、实现要点和排除规则的来源。

## 功能范围

- 仅在 `/weread` 私有 token 模式下有效。
- 用户必须先完成 AI 笔记整理（`NotesAiSummary` 处于成功状态），相关书入口才会出现。
- 用户点击「发现相关书」按钮，前端才会发起请求；不自动触发、不预加载。
- 候选书来自 book-id-search 公开目录，**不是** 微信读书私有书目。

## 主题来源

种子主题词只取自：

1. `summary.themes[].title` —— 按顺序最多取 6 个；
2. 若主题不足 2 个，再从 `summary.readingDirections[]` 末尾补足；
3. **不会** 包含 `summary.overview` 全文、`summary.keyPoints`、`summary.reviewQuestions`；
4. **不会** 包含已加载笔记的原文 / 评论；
5. **不会** 包含搜索词（`q`）。

每个种子在客户端先经过：

- 去除 NUL / C0 控制字符；
- 修剪首尾空白；
- 合并内部空白；
- 单条长度裁剪到 ≤ 80 字符；
- 合计字符数裁剪到 ≤ 320；
- 1～6 条；
- 按清洗后的文本去重，保留第一条的 `seed.id`。

最终排除规则：本地当前已加载的、带非空 `catalogId` 的笔记，最多 100 个，作为 `excludeCatalogIds`，每个匹配公开目录格式 `^[0-9]+_[0-9]{12}$$`。

## 请求 / 响应

```
POST /api/private/weread/related-books
Authorization: Bearer <WEREAD_PRIVATE_API_TOKEN>
Content-Type: application/json
```

```json
{
  "seeds": [
    { "id": "theme-0", "text": "决策" },
    { "id": "theme-1", "text": "反馈循环" }
  ],
  "excludeCatalogIds": ["13000000_000000000001"],
  "limit": 12
}
```

响应：

```json
{
  "ok": true,
  "items": [
    {
      "catalogId": "13000000_000000000002",
      "title": "合成书名",
      "author": "公开作者",
      "publisher": "公开出版社",
      "publishYear": 2024,
      "isbn": "9787000000002",
      "matchedSeedIds": ["theme-0"]
    }
  ],
  "meta": {
    "seedsUsed": 2,
    "candidatesConsidered": 16,
    "returned": 6,
    "excluded": 4,
    "persisted": false,
    "source": "meilisearch"
  }
}
```

错误码：`401`（缺 token）/`403`（错 token）/`404`（功能关闭）/`400`（seed 越界 / catalogId 不合法）/`413`（请求体 > 32 KiB）/`429`（限流或并发）/ `500`（内部异常）/ `502`（Meili 上游暂不可用）。错误信息绝不回显 seed 文本。

## 隐私边界

| 不发送 / 不持久化的内容 | 解释 |
|------------------------|------|
| 原始笔记 `text` / `comment` | 仅取 AI 摘要里清洗后的主题词 |
| `summary.overview` / `summary.keyPoints` / `summary.reviewQuestions` 全文 | 仅取 `themes[].title` 与 `readingDirections[]` |
| `q`（笔记搜索词） | 只在 S27D 私有笔记搜索里使用，本接口不出现 |
| `wereadBookId` / `noteId` / `highlightId` / `chapterTitle` | 既不在请求体里、也不在响应里 |
| 私有 `title` / `author` | 微信读书书名 / 作者从不出现在这一路流中 |
| 原查询词 / 原始 Meili score | 响应里没有 `_rankingScore` / `_rankingScoreDetails` / `_matchesPosition` |
| 完整 Meili 文档 | 响应只映射 `id`、`title`、`author`、`publisher`、`year`、`isbn` 公开字段 |
| MiniMax 调用 | 完全不调用 |
| 任何 `localStorage` / `sessionStorage` / `IndexedDB` 写入 | UI 只把结果存在 React 组件状态；token 本身的保存方式保持 S27C 不变 |

## 公开搜索与日志

- 本接口不经过 `/api/search`，不调用站点的公开 `/api/search` HTTP endpoint；它直接复用现有 Meili `client.index<BookDocument>("books").search(...)`。
- Caddy / nginx 反代的 access_log 只看得到 `POST /api/private/weread/related-books`，**看不到 seed.text**。请求体不会被任何 logger 写出。
- 出口 nginx 的 `books.conanxin.com /api/private/*` private access log 在 S27E 阶段已关闭，本接口不会新增 private access log。
- 服务端代码不修改 `/api/search` handler、不新增 Meilisearch index、不调整 Meilisearch settings、不重启 Meilisearch。

## 检索实现（Reciprocal Rank Fusion）

每个种子调用：

```ts
client.index("books").search(seed.text, { limit: 20 });
```

随后服务端对每条候选计算 `score += 1 / (60 + rank)`，并把命中种子的 `seed.id` 累加进 `matchedSeedIds`。最终排名按：

1. RRF 总分降序
2. 命中种子的不同 id 数降序
3. 首次出现的最佳 rank 升序
4. `catalogId` 字典序升序（稳定 tie-break）

去除的项目：

- `excludeCatalogIds` 列表里的所有 catalogId
- `catalogId` 为空的命中
- 标题为空且 `author` / `publisher` / `isbn` 全部缺失的命中
- 同一 `catalogId` 仅保留第一次出现（按 catalogId 去重，不按 title 去重）

## 结果是探索性推荐

返回的内容**不是**经过人工编辑的"主题书单"。它的作用是从公开书目库里给出与种子词统计相关的若干候选，最终选择权在用户手里。私有 token 模式下不会自动把结果加入任何公开书架、写回任何数据库、或对外分享。

## 不持久化

- 不写 Meilisearch，不调用 MiniMax；
- 不写 `localStorage` / `sessionStorage` / `IndexedDB`；
- 不写文件、不写日志、不写 query string；
- 不在 URL 里携带 token / seed / catalogId。

UI 在切换 AI summary、切换搜索词、切换 token 时会自动清理旧结果；`AbortController` 在 token 改变 / 组件卸载时取消未完成的请求。

## 如何关闭 / 调试

- 关闭私有 token 后入口消失；
- 关闭 `WEREAD_OVERLAY_ENABLED` 后接口返回 `404`，前端入口也会随 token 自动失效。
