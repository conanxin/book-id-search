# WeRead 私人阅读地图 — 当前会话主题层 (S27H-2)

> 在不再次调用 AI、不发送笔记正文、不持久化到服务器的前提下，让『笔记与 AI』
> 工作区生成的 AI 摘要主题能够直接落到『个人阅读地图』的对应书目节点上。

## 1. 功能范围

- 当前已加载的笔记经过 AI 整理后，摘要里的"主要主题"标题和"延伸阅读方向"
  会出现在阅读地图工作区的顶部，作为一个独立的"当前会话主题层"区块。
- 当前已加载笔记中 `matched: true` 且 `catalogId` 非空的项所对应的公共书目，
  在阅读地图上自动成为"当前会话书目"。
- 用户可以一键在『完整地图 / 聚焦当前会话』两种模式之间切换：
  - 完整地图：所有节点 / 关系正常显示。
  - 聚焦当前会话：当前会话书目保持正常强调，其他书目与不相关的连线淡出，
    但仍然可见。
- 当前会话书目自动前置在高互动书目卡片中；
  同期关系列表在聚焦模式下只显示至少包含一个会话节点的关系。

## 2. 数据来源与隐私边界

| 来源字段 | 用途 | 是否离开浏览器 |
|---------|------|---------------|
| `summary.themes[].title` | 主题 chips | ❌ 不离开 |
| `summary.readingDirections[]` | 主题 chips（主题不足时补足） | ❌ 不离开 |
| 当前已加载笔记的 `matched: true` + 非空 `catalogId` | 当前会话书目 | ❌ 不离开 |
| `meta.itemsUsed` | UI 摘要行 | ❌ 不离开 |

**绝对不进入主题层或被发送到任何后端：**

- 笔记正文（`text`）
- 笔记评论（`comment`）
- AI 摘要概览（`overview`）
- AI 关键观点（`keyPoints`）
- 待复习问题（`reviewQuestions`）
- 主题卡片的描述正文 / `evidenceCount`
- 搜索词 `q`、token、原始 `wereadBookId` / `noteId` / `highlightId`
- 微信读书原始标题 / 作者（绝不进入 `ReadingMapDashboard`）

主题层完全在浏览器内拼装；后端只负责：

1. `/api/private/weread/notes` 返回当前已加载的笔记（已在 S27C 阶段实现）
2. `/api/private/weread/notes/summarize` 返回 AI 摘要（S27E）
3. `/api/private/weread/reading-map` 返回阅读地图节点与连线（S27H）

主题层**不会**调用以下任何端点：

- `/private/weread/notes/summarize`（只在用户主动点击『AI 整理』时调用一次）
- `/private/weread/related-books`（S27G 的发现功能，独立开关）
- `/private/weread/notes`（主题层复用 `NotesLibrary` 已加载的 items）

## 3. 状态共享

```
NotesAiSummary        --(onSummaryChange)-->   NotesLibrary
                                                    |
                                                    v
                                       buildSessionThemeOverlay()
                                                    |
                                            (onSessionOverlayChange)
                                                    |
                                                    v
                                              WereadCenter
                                                    |
                                            sessionThemeOverlay prop
                                                    |
                                                    v
                                          ReadingMapDashboard
```

- `NotesAiSummary` 仅在 state 切换时（idle / loading / ready / error）发出当前
  summary 摘要（themes / directions / itemsUsed），从不发送正文 / 评论 / 概览。
- `NotesLibrary` 收到 summary + 自己的 `items`，在 `useMemo` 中合成
  `WereadSessionThemeOverlay`，再通过 `onSessionOverlayChange` 上抛。
- `WereadCenter` 仅持有一个 `sessionThemeOverlay` 状态：切换 tab / 重新加载
  阅读地图都不影响它；token 清除时立即重置为空。
- `ReadingMapDashboard` 接收 overlay 后：
  - `annotateSessionNodes` / `annotateSessionEdges` 给节点 / 连线打上
    `isSession` / `isSessionRelated` 标记；
  - `applySessionFocus` 根据当前 focus 模式把非会话节点 / 连线置为 `isDimmed`。

## 4. UI 状态

| 状态 | 触发条件 | 显示内容 |
|------|---------|---------|
| 1 | 没有 AI 摘要 | "在『笔记与 AI』中生成摘要后，可在这里聚焦当前会话。" |
| 2 | 有主题但 matched catalogIds 为空 | 主题 chips + "当前已加载笔记没有可映射到阅读地图的公共书目。" |
| 3 | 有主题 + 至少一个 matched catalogId | 主题 chips + 数量摘要 + "聚焦当前会话" 开关 |

默认 `focusMode = "full"`，完整地图正常显示。

## 5. 隐私文案

主题层顶部始终展示：

> 主题层只来自当前浏览器会话中已经生成的 AI 摘要，不会再次调用 MiniMax，
> 也不会保存到服务器。

## 6. 持久化

- 不写 `localStorage` / `sessionStorage`（token 仍按 S27D 规则写
  `sessionStorage` 中的 `book-id-search:weread-private-token`，与本次主题层无关）。
- 不进入服务器日志（前端 fetch 没有新增端点）。
- 不进入任何 React DevTools / React Query 缓存的持久化层。
- 切换工作区（笔记 / 地图）不重置；token 清除时立即清空。

## 7. 已知限制

- 主题层只覆盖**当前已加载**的笔记：用户点过『加载更多』才包含后面的页。
- 未匹配到公共目录的笔记不会出现在任何节点上。
- 主题 chip 只是文本提示：不会把任意主题推断到某个具体书目，地图的节点
  边框 / 高亮只来自 `matched: true` 的 catalogId。
- 刷新浏览器后主题层消失，需要重新生成 AI 摘要。
- 主题层不能清除原始 AI 摘要；用户仍可在『笔记与 AI』面板点『清除摘要』。

## 8. 测试

- `apps/web/src/weread/wereadSessionThemeModel.test.ts` — 25 项单测，
  覆盖主题规则、catalogIds 提取、隐私边界（不泄漏 note text/comment、
  overview/keyPoints/questions/token/q/private IDs）、稳定 ID 与序列化。
- `apps/web/src/weread/wereadReadingMapModel.test.ts` 末尾追加 7 项集成测，
  覆盖节点 / 边的 session 标记、聚焦模式 dim 行为、禁用 overlay 的 no-op。
- `scripts/s27h2-browser-smoke.cjs` — 21 项 Puppeteer 浏览器烟雾测试，
  使用 synthetic request interception，不访问真实 AI / private data。

## 9. 相关文件

| 文件 | 角色 |
|------|------|
| `apps/web/src/weread/wereadSessionThemeModel.ts` | 纯函数模型 |
| `apps/web/src/weread/wereadSessionThemeModel.test.ts` | 单元测试 |
| `apps/web/src/weread/NotesAiSummary.tsx` | 暴露 `onSummaryChange` 回调 |
| `apps/web/src/weread/NotesLibrary.tsx` | 合成 overlay 并上抛 |
| `apps/web/src/weread/WereadCenter.tsx` | 持有 overlay 状态 |
| `apps/web/src/weread/ReadingMapDashboard.tsx` | 渲染主题层 + SVG 焦点 |
| `apps/web/src/weread/wereadReadingMapModel.ts` | 新增 annotate / apply helpers |
| `apps/web/src/styles.css` | `.weread-session-theme*` + session/dimmed 样式 |
| `scripts/s27h2-browser-smoke.cjs` | 浏览器烟雾测试 |
| `reports/WEREAD_SESSION_THEME_OVERLAY_REPORT.md` | 验收报告 |
## 复习日历（S27I）使用

`WereadSessionThemeOverlay` 的 `themes` 与 `catalogIds` 同样作为「复习日历」工作区的输入：
- `themes` → 派生会话主题复习任务（最多 6 项）；
- `catalogIds` → 给对应书目增加 +20 优先级加成。

`reviewCalendarDashboard` 不会读取 `overview` / `keyPoints` / `reviewQuestions` / 主题 summary 正文。详见 `docs/WEREAD_REVIEW_CALENDAR.md`。
