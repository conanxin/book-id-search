# S27I — WeRead Review Calendar — Final Report

## STATUS: **PASS**

## SCOPE

- 在 `/weread` 私有中心新增第三个工作区「复习日历」，与「笔记与 AI」「个人阅读地图」并列。
- 复用现有 `fetchWereadReadingMap` 端点（`months=36`, `topBooks=18`）和 `WereadSessionThemeOverlay`。
- 派生确定性复习建议：书目复习 + 当前会话主题任务。
- horizon 14 / 28（默认） / 42 天，推荐书目数 6 / 12（默认） / 18。
- 不调用 AI，不写服务器，不同步外部日历，不保存完成状态。
- 目标版本：`v0.14.0-weread-review-calendar`。

## ALGORITHM_RESULT

- 新增 `apps/web/src/weread/wereadReviewCalendarModel.ts`。
- 时间分数：≥365 / ≥180 / ≥90 / ≥30 / <30 天分别 +45 / +36 / +28 / +18 / +8。
- 互动分数：`min(noteCount, 40) / 40 × 30` + `min(activeMonths, 12) / 12 × 15`。
- 当前会话加成：`catalogId ∈ WereadSessionThemeOverlay.catalogIds` 时 +20。
- 总分夹在 `[0, 100]`，优先级阈值 70 / 45。
- 建议日期偏移用 FNV-1a 32-bit 哈希分散：`high` 0~2 / `medium` 3~7 / `low` 8~20 天。
- 主题任务：最多 6 项，按 `index % 7` 在前 7 天分散，label 截断到 60 字符。
- 缺少 `lastNoteAt` 的书目进入 `unscheduledBooks`，不伪造日期。
- 模型测试 49/49 通过。

## FRONTEND_RESULT

- 新增 `apps/web/src/weread/ReviewCalendarDashboard.tsx`。
- `WereadCenter` 改造：增加 `weread-tab-review` 和 `weread-panel-review`，三个工作区用 `hidden` 属性并行 mounted，切换不丢失状态。
- `ReviewCalendarDashboard` 仅在 `active === true` 时拉取阅读地图；切换 tab 不重发请求；token 清除时清空本地状态。
- 组件结构 / 行为测试 27/27 通过。
- CSS 浅色主题，桌面 1440 / 平板 / 手机 360 三档断点。
- 隐私说明 + 不持久化说明两条固定文案始终可见。

## PRIVACY_RESULT

- 数据来源仅限 `reading-map` 公共字段 + 已脱敏的 `WereadSessionThemeOverlay`。
- 不读取 `note.text` / `note.comment` / `summary.overview` / `summary.keyPoints` / `summary.reviewQuestions` / 主题 summary 正文 / `evidenceCount` / `q` 搜索词 / 微信读书私有 ID / token / API key。
- 模型 JSON 输出经断言无 `NaN` / `Infinity` / `<script>` / `<div>` / 私有 ID。
- 不调用 `fetchWereadAiSummary`、`fetchWereadRelatedBooks`、任何新增 API。
- 不写入 `localStorage` / `sessionStorage` / `IndexedDB`（仅源码顶部注释提及，无实际读写）。
- Puppeteer 浏览器 smoke 拦截真实私有端点，使用合成 fixture；DOM 内（排除披露容器外）不出现 `FORBIDDEN_*` 文本、`smoke-token-12345`、`wereadBookId` / `noteId` / `highlightId`。
- 截图保存于本地 `reports/screenshots/`（**未提交**）。

## REGRESSION_RESULT

- 全量 vitest：946 / 946 通过。
- `tsc -p apps/web/tsconfig.json --noEmit`：PASS。
- `vite build`：PASS（dist 382 kB / gzip 115 kB）。
- `scripts/verify.ts`：`docs=5,115,734`。
- `scripts/search-quality-regression.ts`：**17 PASS / 0 WARN / 0 FAIL**。
- `package.json` 无新依赖。
- API 文件 (`apps/api/`) 无任何改动。

## DEPLOY_RESULT

- 仅 `web` 容器重建：`book-id-search-web-1` fresh Up。
- `book-id-search-api-1` uptime 保持 ≈2 小时，未重启。
- `book-id-search-meilisearch-1` uptime 保持 4 周，未重启。
- Caddy / DNS / nginx private access_log / ICP / 公安备案页脚均未触碰。
- Puppeteer 浏览器 smoke：27/27 PASS。
- web 容器日志无 token / 真实书目清单 / 真实主题 / 笔记正文泄漏。

## REPO_RESULT

- 改动文件清单：
  - `apps/web/src/weread/ReviewCalendarDashboard.tsx`（新增）
  - `apps/web/src/weread/ReviewCalendarDashboard.test.ts`（新增）
  - `apps/web/src/weread/wereadReviewCalendarModel.ts`（新增）
  - `apps/web/src/weread/wereadReviewCalendarModel.test.ts`（新增）
  - `apps/web/src/weread/WereadCenter.tsx`（修改：增加第三工作区）
  - `apps/web/src/styles.css`（修改：新增 S27I 样式块）
  - `docs/WEREAD_REVIEW_CALENDAR.md`（新增）
  - `docs/WEREAD_CENTER.md` / `WEREAD_READING_MAP.md` / `WEREAD_SESSION_THEME_OVERLAY.md`（追加说明段）
  - `scripts/s27i-browser-smoke.cjs`（新增）
  - `reports/WEREAD_REVIEW_CALENDAR_REPORT.md`（新增）
  - `README.md`（更新稳定 tag 为 v0.14.0-weread-review-calendar）
- 暂未提交文件：pre-existing 修改的 `reports/WEREAD_SESSION_THEME_OVERLAY_REPORT.md`（不在本轮 scope 内）；`progress/`、`reports/screenshots/`（本地调试目录，不提交）。

## LIMITATIONS

1. 仅使用 `topBooks=18` 范围内的书目；阅读地图范围外的书目不进入复习日历。
2. 建议日期是启发式，不能真正评估复习效果。
3. 当前会话主题不绑定单本书；主题任务不代表主题属于具体书目。
4. 不持久化；刷新后重新生成。
5. 缺少 `lastNoteAt` 的书目不会生成复习日期，仅展示在「缺少可用的最后阅读日期」区域。
6. 第一版不提供 ICS / Google Calendar / 完成状态持久化 / 自动化提醒。

## NEXT_STEP

- **S27I-2**：浏览器本地 ICS 导出（前端 Blob 下载，零服务器写入）。
- **S27J**：年度阅读回顾（基于阅读地图全年聚合）。
- 后续可视用户反馈再规划 S27I-3 / S27I-4（Google Calendar 主动创建 / 本地完成状态）。