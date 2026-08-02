# S27I-2 — WeRead 复习日历 · 浏览器本地 ICS 导出 验收报告

- **Status:** PASS
- **Tag:** `v0.14.1-weread-review-calendar-ics`
- **提交 hash:** `17affa9`
- **报告生成时间:** 2026-08-02

---

## 1. SCOPE

按 [S27I-2 Browser-local ICS Export 规范](../docs/WEREAD_REVIEW_CALENDAR_ICS.md) 实现「复习日历」工作区的 ICS 导出：

- 新增 `apps/web/src/weread/wereadReviewCalendarIcs.ts` —— ICS 纯函数模型 + 浏览器下载辅助。
- 新增 `apps/web/src/weread/wereadReviewCalendarIcs.test.ts` —— 35 项 ICS 单测（覆盖结构 / 转义 / UID / 文件名 / MIME / revoke / 隐私）。
- 修改 `apps/web/src/weread/ReviewCalendarDashboard.tsx` —— 控制区新增「导出范围」+「导出日历文件 (.ics)」+ 计数提示 + 隐私文案。
- 修改 `apps/web/src/weread/ReviewCalendarDashboard.test.ts` —— 11 项 S27I-2 wiring 断言。
- 修改 `apps/web/src/styles.css` —— `.weread-review-calendar__export*` 四个新类（export / controls / notice / status）。
- 新增 `docs/WEREAD_REVIEW_CALENDAR_ICS.md` —— 完整规范说明。
- 新增 `scripts/s27i2-browser-smoke.cjs` —— 20 项 Puppeteer 端到端 smoke（包含真实下载拦截到 `/tmp/s27i2-downloads`，校验后删除）。
- 新增 `reports/WEREAD_REVIEW_CALENDAR_ICS_REPORT.md` —— 本报告。
- 更新 `README.md` / `docs/WEREAD_CENTER.md` / `docs/WEREAD_REVIEW_CALENDAR.md` —— 链接到 S27I-2 规范。

---

## 2. ICS_RESULT

- **BEGIN/END 结构：** `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//book-id-search//WeRead Review Calendar//ZH-CN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n...END:VCALENDAR\r\n`。
- **行结尾：** 全部 CRLF。无裸 LF；regex `(?<!\r)\n` 在所有生成的 ICS 文档上命中 0 次。
- **VEVENT 数量：** 等于当前排期任务数（书目 + 主题），三种范围（all / book / theme）切换时数量正确。
- **UID：** `<kind>-<fnv1a32(kind|id|dtstart) hex>-<YYYYMMDD>@books.conanxin.com`。同输入 → 同 UID；不同任务或不同 `dtstart` → 不同 UID。永不嵌入 raw catalogId / token / `noteId` / `highlightId` / `chapterTitle` / `q`。
- **DTSTART / DTEND：** 均为 `DTSTART;VALUE=DATE:YYYYMMDD` / `DTEND;VALUE=DATE:YYYYMMDD+1`（RFC 5545 全天规则）。不输出 VTIMEZONE。
- **SUMMARY：** 书目 `复习《公共书名》`；主题 `复习主题：<label>`。经过 RFC 5545 转义（`\` `;` `,` `\n`）。
- **DESCRIPTION：** 多行字段，使用 `\n`（literal escape）表示换行。书目任务包含「优先级 / 建议原因 / 阅读记录 / 活跃月份 / 最后阅读 / 书目页面」；主题任务包含「当前浏览器会话主题 / 此主题未绑定到特定书目，刷新页面后可能不再存在」。
- **TRANSP / CATEGORIES：** `TRANSP:TRANSPARENT`；`CATEGORIES:微信读书复习,<高/中/低 或 当前会话主题>`。
- **行折叠：** `foldIcsLine` 按 RFC 5545 §3.1 在 75 字节边界折行，续行以单空格开头。
- **MIME：** `text/calendar;charset=utf-8`。
- **文件名：** `weread-review-calendar-<horizon-label>-<range-tag>-YYYYMMDD.ics`，仅 ASCII 字符。永不包含书名 / 主题 / catalogId / token。
- **校验函数：** `validateReviewCalendarIcs` 检查 BEGIN/END、CRLF、PRODID/VERSION 一致性、VEVENT open/close 配对。
- **浏览器下载：** `triggerIcsDownload` 用 `Blob + URL.createObjectURL` 触发下载，并通过 `setTimeout(0)` 在下一个 tick 调用 `URL.revokeObjectURL`。

### 单测覆盖（35 项）

| 类别 | 覆盖项 |
|------|--------|
| escapeIcsText | 反斜杠 / 分号 / 逗号 / CRLF / null / Markdown 注入 |
| foldIcsLine | 短行不动 / 长行折行 / 反折叠一致 |
| formatIcsDate / formatIcsTimestamp | UTC / `YYYY-MM-DD` 输入 / 错误输入 → 空 |
| addIcsUtcDays | 正向 / 负向 |
| buildReviewTaskUid | 稳定 / 不同任务不同 / 不含 catalogId / token / 私有 ID |
| buildReviewBookTaskEvent | CRLF / VALUE=DATE / DTEND = DTSTART + 1 / 优先级 / 分类 |
| buildReviewThemeTaskEvent | 主题 SUMMARY / DESCRIPTION / 不含 `/books/` |
| buildReviewCalendarIcs | 顶层头 / CRLF / VEVENT 计数 / 三种范围 / 公开书目 URL / 空拒 / 范围空拒 / 不导出 unscheduled / 不含 forbidden |
| buildReviewCalendarIcsFilename | 安全 ASCII / 范围 + horizon / 不含 catalogId / 主题 |
| validateReviewCalendarIcs | 通过 / 缺 BEGIN/END / LF-only |
| triggerIcsDownload | MIME 正确 / 下载触发 / Blob URL revoke |
| 隐私边界 | 不读 localStorage / sessionStorage |
| buildBookReviewDescription | 全部 6 行字段 |

---

## 3. FRONTEND_RESULT

- 控制区下方新增「导出范围」字段集（三个 radio：全部任务 / 仅书目任务 / 仅当前会话主题）。
- 新增「导出日历文件 (.ics)」按钮：
  - 文案：`导出日历文件 (.ics)`；
  - `disabled={exportableCount === 0}` —— 无任务时按钮禁用；
  - `data-testid="weread-review-calendar-export-button"`；
  - 点击调用 `buildReviewCalendarIcs` + `triggerIcsDownload`。
- 「将导出 N 个全天日历事件。」提示实时更新。
- 隐私提示：`ICS 文件只在当前浏览器中生成，不会上传到服务器。导入 Google、Apple 或 Outlook 日历后，事件内容将由相应日历服务保存。`
- 成功状态：「已生成 N 个日历事件。」（不弹 alert）。
- 失败状态：内联红字（`.weread-review-calendar__export-status--error`）。
- horizon / recommend / theme overlay 变化时自动重新计算导出计数，并清空已展示的旧成功状态。
- 新增 CSS：
  - `.weread-review-calendar__export` 虚线边框 + 浅灰底；
  - `.weread-review-calendar__export-controls` flex-wrap，自然换行；
  - `.weread-review-calendar__export-button` / `:disabled`；
  - `.weread-review-calendar__export-notice` / `_status` / `_status--error`；
  - 不使用 `position: fixed / sticky`。
- mobile-360 / desktop-1440 均无横向滚动（browser smoke 验证）。

### 端到端 browser smoke（20 项）

1. ✓ export button exists after review tab activation
2. ✓ default export range is all
3. ✓ default range notice mentions the right event count
4. ✓ book-only range count drops
5. ✓ theme-only range count is positive after AI summary
6. ✓ clicking export triggers a .ics download
7. ✓ downloaded file is non-empty and reasonable size
8. ✓ file contains BEGIN:VCALENDAR … END:VCALENDAR
9. ✓ VEVENT count matches calendar task count
10. ✓ book event summaries use 复习《》 wrapper
11. ✓ theme event summaries use 复习主题： wrapper
12. ✓ all events use DTSTART;VALUE=DATE
13. ✓ ICS contains no forbidden note text / token / private IDs
14. ✓ no server POST was issued during the export
15. ✓ no external calendar service contacted
16. ✓ URL.revokeObjectURL is wired (model uses setTimeout(0))
17. ✓ ICP footer still present
18. ✓ desktop 1440 has no horizontal overflow
19. ✓ mobile 360 has no horizontal overflow
20. ✓ S27F/S27G/S27H/S27I notes workspace still functional

下载文件保存到 `/tmp/s27i2-downloads`，测试结束后 `fs.rmSync(..., { recursive: true, force: true })` 清理。

---

## 4. PRIVACY_RESULT

| 项 | 结果 |
|----|------|
| `apps/api` 无变更 | ✅ `git diff --stat package.json apps/api/` 0 行 |
| 无新 API | ✅ 没有新增 `fetch(\`/api/...\`)` 调用 |
| 无外部日历请求 | ✅ `Browser.setDownloadBehavior` 拦截下载 + `request` 拦截器追踪；0 个外部请求 |
| 无 token / API key | ✅ smoke 校验 ICS 反折叠后不含 `smoke-token-12345` |
| 无真实书名 / 主题 / 笔记正文进入 ICS | ✅ 模型层 + 组件层双重校验 |
| 无 localStorage / sessionStorage / IndexedDB 写入 | ✅ 测试用 spy 包裹后调用 `triggerIcsDownload`，所有计数为 0 |
| `package.json` 无变化 | ✅ `git diff package.json` 0 行 |
| `dist/` / `screenshots/` / `progress/` 不提交 | ✅ `.gitignore` 既有规则覆盖 |
| 无 third-party 依赖新增 | ✅ 全部使用浏览器原生 API + 既有 `lucide-react` 图标 |
| 端到端无服务器 POST | ✅ 拦截器统计 `serverPosts.length === 0`（已排除 `/notes/summarize` session-warming POST） |

### ICS 隐私白名单

✅ 允许写入：
- 书目公开字段（`title` / `author` / `catalogId` → 公开书目 URL）；
- 优先级标签、建议原因、笔记数量、活跃月份、最后阅读日期；
- 主题标签（来自 S27H-2 已脱敏 overlay）；
- 文件名范围标签 + 日期戳。

❌ 禁止写入：
- `note.text` / `note.comment` / `noteId` / `highlightId` / `wereadBookId` / `chapterTitle`；
- `summary.overview` / `keyPoints` / `reviewQuestions` / `themes[].summary` / `evidenceCount`；
- `q` 搜索关键字；
- 微信读书原始 `title` / `author`（只展示阅读地图返回的公共字段）；
- private token / API key；
- 任何 private API URL；
- raw catalogId（UID 用 fnv1a32 哈希）。

---

## 5. REGRESSION_RESULT

| 步骤 | 结果 |
|------|------|
| `npx vitest run` | ✅ **993 / 993** tests passed（46 test files）|
| `tsc -p apps/web/tsconfig.json --noEmit` | ✅ no errors |
| `vite build` (apps/web) | ✅ built in 246ms（70.04 kB CSS / 390.93 kB JS）|
| `scripts/verify.ts` | ✅ status: PASS, `numberOfDocuments: 5,115,734` |
| `scripts/search-quality-regression.ts` | ✅ **17 PASS / 0 WARN / 0 FAIL** |
| `package.json` 变更 | 0 |
| `apps/api/` 变更 | 0 |
| `apps/web/src/api/` | 不存在（前端不直接调 api 模块） |

---

## 6. DEPLOY_RESULT

```
NAME                           IMAGE                          COMMAND                  SERVICE       CREATED         STATUS          PORTS
book-id-search-api-1           book-id-search-api             "docker-entrypoint.s…"   api           3 hours ago     Up 3 hours      127.0.0.1:3001->3001/tcp
book-id-search-meilisearch-1   getmeili/meilisearch:v1.48.3   "tini -- /bin/sh -c …"   meilisearch   4 weeks ago     Up 4 weeks      127.0.0.1:7700->7700/tcp
book-id-search-web-1           book-id-search-web             "/docker-entrypoint.…"   web           14 seconds ago  Up 14 seconds   127.0.0.1:5173->80/tcp
```

- ✅ web fresh Up（重新构建 + 重启）；
- ✅ api uptime 3 hours（不重置）；
- ✅ Meilisearch uptime 4 weeks（不重置）；
- ✅ nginx private access_log 仍关闭；
- ✅ 日志扫描无 token / `q=` / `noteId` / `chapterTitle` / `wereadBookId` / 关系 / 主题 / 笔记内容泄漏；
- ✅ `docker compose logs --tail=100 web` 仅有标准 nginx 启动日志。

只部署 web —— 通过 `docker compose up -d --no-deps --build web`。未触碰：
- Meilisearch / Caddy / DNS / nginx private access_log；
- ICP / 公安备案页脚；
- api 容器 / 镜像。

---

## 7. LIMITATIONS

按规范 §10 已知限制复述（**本轮不实现**任何对应功能）：

1. 不处理完成状态。
2. 不更新已经导入的旧事件。
3. 重复导入可能产生重复事件 —— 由用户自行去重。
4. 不自动删除外部日历事件。
5. 主题任务只在当前浏览器会话存在；刷新后消失。
6. 缺少 `lastNoteAt` 的书目不进入 ICS，只展示在「缺少可用的最后阅读日期」区域。

外部服务导入后的隐私边界由服务方决定，本项目无控制权。

---

## 8. NEXT_STEP

**S27J · Annual Reading Review（年度阅读回顾）**

- 基于阅读地图的全年聚合视图：12 月时间轴 + 全年回顾卡片。
- 数据源与 S27I 同源（`/api/private/weread/reading-map`）。
- 复用 `WereadSessionThemeOverlay` 提供「年度主题」概览。
- 不引入新的存储 / API；保持 70 / 0 / 0 / 5,115,734 的隐私 + 安全边界。

---

## 9. 验证 Checklist

- [x] 实现与原始计划一致（非 A' 代替 A）；
- [x] 代码语法检查通过 (`tsc -p apps/web/tsconfig.json --noEmit`)；
- [x] 功能测试运行通过（993 / 993 vitest PASS）；
- [x] 服务启动验证（web fresh Up / api uptime 不重置 / Meilisearch uptime 不重置）；
- [x] Browser smoke 20/20 PASS（含真实下载拦截）；
- [x] 文档更新对应代码变更（README + WEREAD_CENTER + WEREAD_REVIEW_CALENDAR + 新 WEREAD_REVIEW_CALENDAR_ICS）。