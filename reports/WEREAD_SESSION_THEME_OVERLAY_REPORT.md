# S27H-2 — WeRead 个人阅读地图 · 当前会话主题层 验收报告

- **Status:** PASS
- **Tag 目标:** `v0.13.1-weread-session-theme-overlay`
- **提交 hash:** 待 `git commit` 后填入
- **报告生成时间:** 2026-08-02

---

## SCOPE

将 S27E 已经生成的 AI 摘要（主题标题 + 延伸阅读方向）和当前已加载笔记中
`matched: true` 且 `catalogId` 非空的公共书目，组合成"当前会话主题层"，仅
作为前端状态叠加到 S27H 个人阅读地图上。

不修改后端；不重建 API；不调用 MiniMax；不调用 related-books 接口；不修改
Meilisearch / nginx / Caddy / DNS / ICP / 公安备案；不写 localStorage 或
sessionStorage；不向 ReadingMapDashboard 传入 note text/comment、summary
overview/keyPoints/questions、token / q / wereadBookId / noteId / highlightId
/ title / author。

---

## FRONTEND_RESULT

### 新增 / 修改文件

| 文件 | 角色 |
|------|------|
| `apps/web/src/weread/wereadSessionThemeModel.ts` | 纯函数模型（103 行，11 个 helper） |
| `apps/web/src/weread/wereadSessionThemeModel.test.ts` | 25 项单元测试 |
| `apps/web/src/weread/NotesAiSummary.tsx` | 暴露 `onSummaryChange` 回调（仅 themes/directions/itemsUsed） |
| `apps/web/src/weread/NotesLibrary.tsx` | 合成 `WereadSessionThemeOverlay`，通过 `onSessionOverlayChange` 上抛 |
| `apps/web/src/weread/WereadCenter.tsx` | 持有 `sessionThemeOverlay` 状态（key-dedupe），传给两个工作区 |
| `apps/web/src/weread/ReadingMapDashboard.tsx` | 渲染主题层 UI + 焦点模式 SVG + 主题筛选 links |
| `apps/web/src/weread/wereadReadingMapModel.ts` | 新增 `annotateSessionNodes` / `annotateSessionEdges` / `applySessionFocus` |
| `apps/web/src/weread/wereadReadingMapModel.test.ts` | 追加 7 项集成测试 |
| `apps/web/src/styles.css` | `.weread-session-theme*` + session/dimmed 样式 |
| `docs/WEREAD_SESSION_THEME_OVERLAY.md` | 完整文档 |
| `docs/WEREAD_READING_MAP.md` | 追加 S27H-2 说明 |
| `docs/WEREAD_CENTER.md` | 追加 S27H-2 工作区段 |
| `README.md` | 追加 S27H-2 章节 |
| `scripts/s27h2-browser-smoke.cjs` | 21 项 Puppeteer 浏览器烟雾测试 |

### 状态共享管线

```
NotesAiSummary  --(onSummaryChange: {summary, itemsUsed} | null)-->  NotesLibrary
                                                                      |
                                                     buildSessionThemeOverlay()
                                                                      |
                                            (onSessionOverlayChange, key-dedupe)
                                                                      v
                                                                 WereadCenter
                                                                      |
                                                  sessionThemeOverlay prop
                                                                      v
                                                                ReadingMapDashboard
```

### 主题层 UI 三态

1. **无 AI 摘要**: 显示 "在『笔记与 AI』中生成摘要后，可在这里聚焦当前会话。"
2. **有主题但 matched catalogIds 为空**: 显示主题 chips + "当前已加载笔记没有可映射到阅读地图的公共书目。"
3. **有主题 + 至少 1 个 matched catalogId**: 显示主题 chips + 摘要数字 + "聚焦当前会话" 开关。

### 焦点模式

- 非会话节点：`opacity: 0.32`
- 会话节点：`stroke: #1d4ed8` + 蓝色 drop-shadow halo
- 会话相关 links：`stroke: #2563eb`
- 非会话 links：`opacity: 0.18`
- 高互动书目卡：会话书目前置；其他书目保留
- 同期关系列表：在 session 模式下只显示至少包含一个会话节点的关系

### 测试

| 套件 | 文件 | 数量 | 结果 |
|------|------|------|------|
| 单元 | `wereadSessionThemeModel.test.ts` | 25 | PASS |
| 单元 + 集成 | `wereadReadingMapModel.test.ts` | 41（含 7 项 S27H-2 追加） | PASS |
| 全量 | `npx vitest run` | 870 | PASS |
| 类型 | `tsc -p apps/web/tsconfig.json --noEmit` | - | PASS |
| 构建 | `vite build` | - | PASS (62.35 KB CSS / 362.09 KB JS) |
| 浏览器烟雾 | `scripts/s27h2-browser-smoke.cjs` | 22（含 1 项 bonus 隐私检查） | PASS |

---

## PRIVACY_RESULT

### 数据流边界

| 来源 | 字段 | 离开浏览器？ |
|------|------|--------------|
| AI 摘要 | `themes[].title` | ❌ 仅主题层 chips |
| AI 摘要 | `readingDirections[]` | ❌ 仅主题层 chips（主题不足时补足） |
| 笔记 | `matched: true` + `catalogId` | ❌ 仅用于 SVG / 卡片高亮 |
| AI 摘要 | `meta.itemsUsed` | ❌ 仅 UI 摘要数字 |

### 绝对不进入主题层或 ReadingMapDashboard

- 笔记正文 / 评论
- AI 摘要 overview / keyPoints / reviewQuestions
- 主题卡片的描述 / evidenceCount
- token / q / wereadBookId / noteId / highlightId / chapterTitle
- 微信读书原始 title / author

### 验证手段

1. `wereadSessionThemeModel.test.ts` 中 4 项断言：note text / comment /
   overview / keyPoints / questions / token / q / wereadBookId / noteId /
   highlightId / createdAt / updatedAt 都不出现在 overlay JSON 中。
2. `grep -nE` 检查 `ReadingMapDashboard.tsx` 源码，不引用
   `note.text`、`note.comment`、`summary.overview`、`summary.keyPoints`、
   `summary.reviewQuestions`、`fetchWereadAiSummary`、`fetchWereadRelatedBooks`。
3. `s27h2-browser-smoke.cjs` 第 22 项：DOM 全树（排除披露容器）不出现
   `FORBIDDEN_NOTE_TEXT`、`FORBIDDEN_NOTE_COMMENT`、`FORBIDDEN_OVERVIEW`、
   `FORBIDDEN_KEYPOINT`、`FORBIDDEN_QUESTION`、`FORBIDDEN_THEME_BODY`、
   `smoke-token-12345`、`wereadBookId`、`noteId`、`highlightId`。
4. Bundle 内无 `sk-*` API key / smoke token / 私有 ID。
5. Web 服务日志无 note text / comment / token / private IDs 出现。

---

## REGRESSION_RESULT

- **API:** 未触碰，容器仍运行 S27H 版本。
- **Meilisearch:** 仍在 4 周前启动的旧容器上运行，未重启。
- **Web:** 已重新构建并启动（fresh Up 12 秒），日志干净，无新增 reading-map endpoint。
- **主搜索:** search-quality 17 PASS / 0 WARN / 0 FAIL。
- **verify:** docs=5,115,734，所有字段 SSID / DXID / ISBN / 书名 / 作者 / 出版社 PASS。
- **其他 wecenter 工作区:** 笔记、趋势、相关书搜索（`s27h-browser-smoke.cjs`）
  全部 PASS。

---

## DEPLOY_RESULT

| 服务 | 操作 | 状态 |
|------|------|------|
| `web` | `docker compose up -d --no-deps --build web` | Recreated / Up 12 seconds |
| `api` | 未触碰 | Up 33 minutes（上一版本） |
| `meilisearch` | 未触碰 | Up 4 weeks |

---

## LIMITATIONS

- 主题层只覆盖**当前已加载**的笔记，需要点击"加载更多"才会包含后续页。
- 未匹配到公共目录的笔记不会出现在任何节点上。
- 主题 chip 只是文本提示：不会把任意主题推断到某个具体书目，节点边框 / 高亮
  只来自 `matched: true` 的 catalogId。
- 刷新浏览器后主题层消失，需要重新生成 AI 摘要。
- 主题层不能清除原始 AI 摘要；用户仍可在『笔记与 AI』面板点『清除摘要』。

---

## NEXT_STEP

**S27I — Reading Review Calendar**（按计划推进阅读复习日程面板，复用已有的
matched 公共目录与 AI 摘要主题作为复习主题种子；继续遵守笔记正文 / 评论 /
token / 私有 ID 不离开浏览器的边界）。

---

## REPO_RESULT

- 修改文件清单（commit 时使用）:
  ```
  apps/web/src/styles.css
  apps/web/src/weread/NotesAiSummary.tsx
  apps/web/src/weread/NotesLibrary.tsx
  apps/web/src/weread/ReadingMapDashboard.tsx
  apps/web/src/weread/WereadCenter.tsx
  apps/web/src/weread/wereadReadingMapModel.ts
  apps/web/src/weread/wereadReadingMapModel.test.ts
  apps/web/src/weread/wereadSessionThemeModel.ts
  apps/web/src/weread/wereadSessionThemeModel.test.ts
  docs/WEREAD_CENTER.md
  docs/WEREAD_READING_MAP.md
  docs/WEREAD_SESSION_THEME_OVERLAY.md
  README.md
  scripts/s27h2-browser-smoke.cjs
  reports/WEREAD_SESSION_THEME_OVERLAY_REPORT.md
  ```
- `package.json` 无变化（未引入新依赖）。
- `.env` / `private-data` / `apps/web/dist` / `progress` / `reports/screenshots`
  不会被 commit。
- 目标 tag：`v0.13.1-weread-session-theme-overlay`。

---

_报告由 S27H-2 subagent 自动生成于 2026-08-02。_