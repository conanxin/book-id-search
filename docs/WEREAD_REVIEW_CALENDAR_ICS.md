# S27I-2 — WeRead Review Calendar ICS Export

> 私有微信读书中心复习日历新增「导出日历文件 (.ics)」按钮。ICS 完全在当前浏览器内生成，不写入服务器、不调用任何外部日历服务，导入由用户自行决定。

---

## 1. 功能范围

- 在「复习日历」工作区控制区下方新增「导出范围」三选一：
  - 全部任务（默认）：书目复习任务 + 当前会话主题任务；
  - 仅书目任务；
  - 仅当前会话主题任务。
- 新增「导出日历文件 (.ics)」按钮：
  - 按钮文案：`导出日历文件 (.ics)`；
  - 当所选范围内没有可导出任务时按钮 `disabled`；
  - 显示「将导出 N 个全天日历事件。」实时计数；
  - 显示隐私提示语。
- ICS 文件名格式：`weread-review-calendar-<horizon>-<range>-YYYYMMDD.ics`。
  例：`weread-review-calendar-28-days-all-20260802.ics`。
  文件名仅含 ASCII 字符，不含书名 / 主题 / catalogId / token。
- 整个流程只在浏览器内运行：
  - 不发起任何 `fetch` / XHR；
  - 不调用 Google Calendar / Apple Calendar / Outlook API；
  - 不写入 `localStorage` / `sessionStorage` / IndexedDB；
  - 不持久化到服务器 / Meilisearch / 任何外部服务。

## 2. 浏览器下载机制

1. 用户点击按钮 → 组件调用纯函数 `buildReviewCalendarIcs`。
2. 函数返回 `{ content, events, range, filename }`。
3. 组件调用 `triggerIcsDownload({ content, filename })`：
   - 用 `new Blob([content], { type: "text/calendar;charset=utf-8" })` 创建 Blob；
   - `URL.createObjectURL(blob)` 生成临时 URL；
   - 创建 `<a>` 元素（`rel="noopener"`、`data-testid="weread-review-calendar-ics-anchor"`），挂到 `document.body`，`.click()`，再 `remove()`；
   - `setTimeout(0)` 后调用 `URL.revokeObjectURL(blobUrl)` —— 让浏览器读完 blob URL 后立刻释放。
4. 状态更新为「已生成 N 个日历事件。」成功文案不带 token。
5. 用户后续如何处理 .ics 文件由自己决定（直接打开 / 拖入 Google Calendar / 导入 Outlook）。

## 3. ICS 文件结构

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//book-id-search//WeRead Review Calendar//ZH-CN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:<kind>-<fnv1a32-hash>-<YYYYMMDD>@books.conanxin.com
DTSTAMP:<UTC timestamp>
DTSTART;VALUE=DATE:YYYYMMDD
DTEND;VALUE=DATE:次日的 YYYYMMDD
SUMMARY:<escaped text>
DESCRIPTION:<escaped description, \\n 表示换行>
TRANSP:TRANSPARENT
CATEGORIES:微信读书复习,<高/中/低 或 当前会话主题>
END:VEVENT
...
END:VCALENDAR
```

每一条事件使用 `VALUE=DATE` 全天事件，**不输出 VTIMEZONE 块**。DTEND 是 DTSTART 的下一天（RFC 5545 all-day 规则）。

## 4. 书目任务字段

```
SUMMARY:复习《公共书名》
DESCRIPTION:
  优先级：高 / 中 / 低
  建议原因：当前会话涉及这本书；距离上次阅读时间较长 …
  阅读记录：N 条
  活跃月份：N
  最后阅读：YYYY-MM-DD
  书目页面：https://books.conanxin.com/books/<catalogId>
```

- `title` / `author` 只来自阅读地图的公共字段；
- `catalogId` 只用于构造公开书目 URL（`https://books.conanxin.com/books/<catalogId>`），不进 UID；
- 不输出 `priorityScore`；
- 不输出私人笔记正文。

## 5. 主题任务字段

```
SUMMARY:复习主题：<theme label>
DESCRIPTION:
  当前浏览器会话主题。
  此主题未绑定到特定书目，刷新页面后可能不再存在。
```

- 主题只来自已被 S27H-2 脱敏过的 `WereadSessionThemeOverlay.themes`；
- 不推断主题与某本书的关联；
- 不附加 AI 摘要全文 / `overview` / `keyPoints` / `reviewQuestions` / `evidenceCount`。

## 6. UID 设计

- 格式：`<kind>-<fnv1a32(kind|id|dtstart) hex>-<YYYYMMDD>@books.conanxin.com`
- 同一组任务在同一日期生成稳定 UID；
- 不同任务（或同任务但 `dtstart` 不同）生成不同 UID；
- UID 永不包含：
  - 微信读书私有 ID（`wereadBookId` / `noteId` / `highlightId` / `chapterTitle`）；
  - 搜索关键字 `q`；
  - private token；
  - 真实书目 `title` / `author`（只用于 SUMMARY，已被 RFC 5545 转义）；
  - 完整 `catalogId`（被 fnv1a32 哈希后再 hex 编码）。

## 7. 导出范围与排除

| 选项 | 含义 |
|------|------|
| 全部任务 | 同时包含「已排期」的书目复习任务和当前会话主题任务 |
| 仅书目任务 | 只包含「已排期」的书目复习任务 |
| 仅当前会话主题 | 只包含当前浏览器会话的主题任务 |

**永不导出**：
- `unscheduledBooks`（缺少 `lastNoteAt` 的书目）；
- 超出当前 `horizon` 的任务；
- 被推荐数量（`recommendCount`）过滤掉的书目任务；
- 任何不在排期状态的事件。

## 8. 隐私边界

- **不新增**任何 API 路由；
- **不调用**任何外部日历服务（Google Calendar / Apple Calendar / Outlook）；
- **不保存**到服务器 / Meilisearch / 任何持久化层；
- **不写入** localStorage / sessionStorage / IndexedDB；
- **不读取** token / `q` / 微信读书私有 ID / 笔记正文 / 评论 / 摘要正文；
- ICS 中**不含**：
  - 笔记正文（`note.text`）；
  - 笔记评论（`note.comment`）；
  - 摘要概览 / 关键点 / 复习问题（`summary.overview` / `keyPoints` / `reviewQuestions`）；
  - 私有 ID（`noteId` / `highlightId` / `wereadBookId` / `chapterTitle`）；
  - 搜索关键字（`q`）；
  - 微信读书原始 title / author（仅展示公共字段）；
  - private token / API key；
  - 任何 private API URL。

## 9. 用户导入后的边界

当用户把 .ics 文件导入 Google Calendar / Apple Calendar / Outlook 后：
- 事件内容由相应日历服务保存；
- 服务方可能自动同步到该用户其他已登录设备；
- 服务方可能有自身的隐私政策；
- 服务方可能在用户删除本项目后再保留旧事件；
- **本项目对导入后的数据无控制权**，用户需自行阅读服务方的隐私政策。

## 10. 已知限制

1. **不处理完成状态**：导入到外部日历后不会回写完成情况。
2. **不更新已经导入的旧事件**：用户重新导出后必须手动删除旧事件。
3. **重复导入可能产生重复事件**：用户需自行去重或删除旧事件。
4. **不自动删除外部日历事件**：用户清空 token / 卸载本项目都不会同步到外部日历。
5. **刷新浏览器后主题任务消失**：主题任务只在当前浏览器会话存在，不会持久化。
6. **缺少 `lastNoteAt` 的书目不进入 ICS**：这些书目只展示在「缺少可用的最后阅读日期」区域。

## 11. 隐私 + 安全扫描要点

| 项 | 检查 |
|----|------|
| `apps/api` 无变更 | ✅ |
| 无新 API | ✅ |
| 无外部日历请求 | ✅ |
| 无 token / API key | ✅ |
| 无真实书名 / 主题 / 笔记正文进入报告 | ✅ |
| 无 localStorage / sessionStorage 写入 | ✅ |
| `package.json` 无变化 | ✅ |
| `dist/` / `screenshots/` / `progress/` 不提交 | ✅ |

## 12. 后续规划（**本轮不实现**）

- S27I-3：用户主动创建 Google Calendar 事件（用户授权 + 一次性跳转，零自动化）。
- S27I-4：本地完成状态（仅 `sessionStorage`，不写入服务端）。
- S27J：年度阅读回顾（基于阅读地图的全年聚合）。