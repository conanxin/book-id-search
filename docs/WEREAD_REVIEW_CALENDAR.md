# S27I — WeRead Review Calendar

> 私有微信读书中心新增「复习日历」工作区。该功能是一个**纯前端**启发式工具，把阅读地图中的公共书目信息和当前会话主题排成未来 14 / 28 / 42 天的复习建议。

---

## 1. 功能范围

- 新增第三个工作区：「复习日历」，与「笔记与 AI」「个人阅读地图」并列，默认仍是「笔记与 AI」。
- 阅读地图数据通过现有 `GET /api/private/weread/reading-map` 端点获取（推荐 `months=36`, `topBooks=18`）。
- 用户可在 `14 / 28 / 42` 天之间切换，并控制书目推荐数量 `6 / 12 / 18`。
- 复习任务分为两类：
  - **书目复习任务**：基于公开书目字段（`catalogId`, `title`, `author`, `noteCount`, `activeMonths`, `lastNoteAt`）生成。
  - **当前会话主题任务**：从 `WereadSessionThemeOverlay.themes`（已在 S27H-2 阶段脱敏）派生，仅在浏览器会话内使用。
- 提供日历网格视图、未来 N 天优先复习队列、本次会话主题、缺少阅读日期的书目等子模块。
- **不**保存完成状态；**不**同步到系统日历；**不**接入任何第三方服务。

## 2. 使用的数据

| 来源 | 字段 | 用途 |
|------|------|------|
| `GET /api/private/weread/reading-map` | `books[].catalogId` | 书目唯一标识（公共 catalog id） |
| `GET /api/private/weread/reading-map` | `books[].title` / `author` | 卡片展示 |
| `GET /api/private/weread/reading-map` | `books[].noteCount` | 互动分数（最高 +30） |
| `GET /api/private/weread/reading-map` | `books[].activeMonths` | 持续度分数（最高 +15） |
| `GET /api/private/weread/reading-map` | `books[].lastNoteAt` | 时间分数基线 |
| `WereadSessionThemeOverlay.themes` | `id` / `label` / `source` | 会话主题任务（最多 6 项） |
| `WereadSessionThemeOverlay.catalogIds` | 公共 catalog id 集合 | 给当前会话涉及的书目加 +20 加成 |
| `WereadSessionThemeOverlay.notesUsed` | 整数 | 仅用于概览文案 |

**绝不**使用：`note.text`、`note.comment`、`summary.overview`、`summary.keyPoints`、`summary.reviewQuestions`、`summary.themes[].summary`、`summary.themes[].evidenceCount`、微信读书内部 `wereadBookId` / `noteId` / `highlightId` / `chapterTitle`、`q` 搜索词、原始 token / API key。

## 3. 时间分数（基于 `daysSinceLast = max(0, now - lastNoteAt)`）

| 区间 | 加分 |
|------|------|
| `≥ 365` 天 | +45 |
| `≥ 180` 天 | +36 |
| `≥ 90` 天 | +28 |
| `≥ 30` 天 | +18 |
| `< 30` 天 | +8 |

## 4. 互动分数

- 笔记数量：`min(noteCount, 40) / 40 × 30`（最高 +30）
- 活跃月份：`min(activeMonths, 12) / 12 × 15`（最高 +15）

## 5. 当前会话加成

- 若 `catalogId ∈ WereadSessionThemeOverlay.catalogIds`：额外 `+20` 分。

## 6. 总分与优先级

- 四舍五入到整数，夹在 `[0, 100]` 之间。
- `≥ 70` → `high`
- `45 ~ 69` → `medium`
- `< 45` → `low`

## 7. 建议日期偏移（确定性分散）

为了让同一批书目不会挤在同一天，使用 FNV-1a 32-bit 哈希对 `catalogId` 求散列：

| 优先级 | 偏移（未来 N 天） | 公式 |
|--------|-------------------|------|
| `high` | 0~2 天 | `hash % 3` |
| `medium` | 3~7 天 | `3 + hash % 5` |
| `low` | 8~20 天 | `8 + hash % 13` |

最终建议日期 = `todayUtc + offset`。若建议日期超出所选 horizon，则该任务不出现在日历视图的对应日期里，但仍可保留在底层任务列表中。

## 8. 排序规则

1. `suggestedDate` 升序；
2. 优先级 `high → medium → low`；
3. 同优先级按 `priorityScore` 降序；
4. 再以 `catalogId` 字典序稳定排序。

主题任务独立于书目排序，按 `index % 7` 在前 7 天分散（最多 6 个）。

## 9. 当前会话主题任务

- 每个主题生成一个 `kind="theme"` 的会话任务；
- `suggestedDate = todayUtc + (index % 7)`；
- 主题标签截断到 60 字符；
- 主题任务**不**绑定书目，**不**声称主题属于某本书；
- 主题任务只用于浏览器会话内的展示，不写入服务端，不进入 Meilisearch，不参与公共搜索。

## 10. horizon 14 / 28 / 42

- 用户可在 UI 中切换 14 / 28 / 42 天的展望窗口；
- 默认 28 天；
- 切换 horizon **不会**重新发起 `reading-map` 请求（数据缓存于组件内存）；
- 推荐书目数仅截取排序后的书目任务，主题任务数量不受影响。

## 11. 行为边界

- **不使用笔记正文 / 评论 / AI summary 正文 / 划线原文**。
- **不调用** `fetchWereadAiSummary`、`fetchWereadRelatedBooks`、任何 `/api/private/weread/*` 之外的端点。
- **不新增**任何 private / public API route、任何数据库表、任何服务器端复习任务。
- **不写入** `localStorage` / `sessionStorage` / `IndexedDB`；
  - 注：原 `WereadCenter` 用 `sessionStorage` 存储 token 这一既有用法与本组件无关，本组件自身不读写任何浏览器存储。
- **不同步**到 Google Calendar、ICS、邮件、Telegram 等任何外部系统。
- **不修改** Meilisearch 索引、Caddy / DNS / nginx private access_log、ICP / 公安备案页脚。
- 不修改 `package.json`、不新增第三方依赖。

## 12. 已知限制

1. 只使用阅读地图 `topBooks` 范围内的书目；超出范围的非头部书目不进入复习日历。
2. 建议日期是启发式的，并不能真正"评估复习效果"——它只基于最近活跃度、笔记密度和会话加成。
3. 当前会话主题不绑定单本书；主题复习任务不代表主题来自具体书目。
4. 复习日历不持久化：刷新后会根据最新数据重新生成。
5. 缺少 `lastNoteAt` 的书目不会生成复习日期，只在「缺少可用的最后阅读日期」区域展示。
6. 第一版不提供 ICS / Google Calendar / 完成状态持久化等扩展能力。

## 13. 后续规划（**本轮不实现**）

- S27I-2：浏览器本地 ICS 导出（前端 Blob 下载，零服务器写入）。
- S27I-3：用户主动创建 Google Calendar 事件（用户授权 + 一次性跳转，零自动化）。
- S27I-4：本地完成状态（仅 `sessionStorage`，不写入服务端）。
- S27J：年度阅读回顾（基于阅读地图的全年聚合）。