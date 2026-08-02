# S27J — WeRead Annual Review Report

> 报告时间：2026-08-03 07:43 GMT+8  
> HEAD： `0f954ea` → `Add private WeRead annual review`  
> 目标版本：`v0.15.0-weread-annual-review`

---

## STATUS: PASS

---

## SCOPE

- 单年私有阅读聚合：`GET /api/private/weread/annual-review?year=<YYYY>&topBooks=<6|12|18>`
- 数据来源仅限 `note.createdAt` / `note.updatedAt`（UTC 年月）、note type（highlights / thoughts / reviews / unknown）、以及 `weread-matches.confirmed.json` 中的 `wereadBookId → public catalogId` 映射
- 公共书目元数据（title / author / publisher / year）通过 Meilisearch `index.getDocument` 直读，**不调用 `/api/search`**
- 不读取笔记正文 / 评论 / `markedText` / `content`
- 不调用 MiniMax / 不调用 related-books
- 不持久化、不提供公开分享链接、不写 Meilisearch
- 年度 top books **只按 `selectedYear` 精确聚合**，跨年记录自动排除

---

## API_RESULT

- **端点**：`GET /api/private/weread/annual-review`
  - 鉴权：no token → 401 `Missing token.`，wrong token → 403 `Invalid token.`，private overlay disabled → 404
  - 参数：`year`（四位整数，[2000, currentYear+1]，缺省时取最新有数据年份）+ `topBooks`（6/12/18，缺省 12）
  - 限流：20 GETs / 60s / peer（与 reading-map 同源设计）
  - 错误响应不带私有记录 / catalogId 列表 / 文件路径 / Meili 原始错误
- **selected year**：缺省时调用 `resolveAnnualReviewYear` 取 `availableYears[0]`，完全无数据时使用当前 UTC 年（HTTP 200 + 12 个零值月份）
- **available years**：从全部有效笔记日期提取，去重降序；不含每年的私有记录数
- **12-month aggregation**：固定返回 `YYYY-01` ~ `YYYY-12`；缺记录月份补零；`bookCount` 仅统计已匹配 catalogId
- **annual streak**：仅在该年的 12 个月内计算最长连续活跃月份，**不跨年连接**
- **peak month**：`total` 最大月份；并列时取更早月份；全年零值时 `null`
- **annual top books**：仅 `selectedYear` 内部聚合；多个 `wereadBookId` 映射同一 `catalogId` 时合并；不按正文去重；排序 `noteCount → activeMonths → lastNoteAt → catalogId`；截断至 `topBooks`
- **公共元数据 hydration**：`index.getDocument` 直读；失败时回退 `书目 ${catalogId}`，author / publisher / publishYear 均为 null；**绝不使用微信读书原始 title/author**
- **quarter 统计**：Q1=1–3月 / Q2=4–6月 / Q3=7–9月 / Q4=10–12月；`bookCount` 是该季度 distinct matched catalogId 精确计数
- **auth / redaction**：auth 失败统一走 private auth helper；状态码 401/403/404/400/500/502；错误体不含 token / catalogId / 原始书籍信息
- **live counts-only smoke**：7 个 curl 验证全部 PASS（no token=401、bad token=403、year=1999=400、year=abcd=400、topBooks=10=400、year=2010=200+12零值月份、正向 200）

---

## FRONTEND_RESULT

- **第四工作区**：「年度回顾」与「笔记与 AI」「个人阅读地图」「复习日历」并列；默认仍是「笔记与 AI」；切换通过 `hidden` 切换，四个面板均保持 mounted
- **lazy load**：仅当 `active=true` 时首次请求；`lastRequestTokenRef` 防重；切回再进入不重发；token 变化 abort + 清空
- **年份选择器**：渲染 `availableYears`，切换重新请求
- **topBooks**：6/12/18 三档 radio，切换重新请求
- **6 张概览卡**：全年阅读记录 / 活跃月份 / 已匹配记录 / 年度书目 / 高峰月份 / 每月平均
- **12 个月时间轴**：手绘 SVG 柱状图（含可堆叠类型色块）；可访问文本列表同步呈现
- **Q1–Q4 季度卡**：记录数 / 活跃月份 / 匹配书目 / 匹配记录 / 占全年比例 + 月度活跃度分类
- **descriptive activity classes**：高活跃 / 稳定 / 轻量 / 无记录（基于数量 = `avg × 1.5` / `avg × 0.5` 阈值）；UI 顶部固定免责声明「以下为基于记录数量的描述性分类，不代表阅读质量或个人状态。」
- **年度高互动书目**：书名 / 作者 / 出版社+年份（如有） / 年度记录数 / 活跃月份 / 类型分布 / 首末日期 / 「查看书目」→ `/books/<catalogId>`
- **年度记录卡**：6 张纯统计描述性卡片（全年记录数 / 活跃月份 / 最长连续月份 / 高峰月份 / 年度匹配书目 / 最高互动书目），末尾固定「仅基于阅读记录数量与日期统计；不代表阅读偏好、人格特征或专注力。」
- **空年份状态**：选中年份没有数据时仍显示 12 个月零值时间轴 + 「该年度暂无有效日期的阅读记录。」
- **responsive browser smoke**：desktop 1440 / mobile 360 横向无溢出；6 个概览列 → 3 → 2、book 3 列 → 2 → 1、quarter 4 列 → 2 → 1

---

## PRIVACY_RESULT

- **包含的安全字段**：`overview.*`、`months[].{total,highlights,thoughts,reviews,unknown,matched,bookCount}`、`quarters[].{total,activeMonths,matchedRecords,bookCount}`、`topBooks[].{catalogId,title,author,publisher,publishYear,noteCount,highlights,thoughts,reviews,unknown,activeMonths,firstNoteAt,lastNoteAt}`、`availableYears`、`meta.{persisted:false,source:"private_snapshot+public_catalog"}`
- **排除字段**：`note.text` / `note.comment` / `markedText` / `content`、`wereadBookId` / `noteId` / `highlightId` / `chapterTitle`、微信读书原始 `title` / `author`、`rawTitle` / `rawAuthor`、原始 snapshot 记录、Meili 排名细节、文件路径、`mtime`、内部映射表
- **no AI**：端点不调用 MiniMax；前端 dashboard 不调用 `fetchWereadAiSummary` 或 `fetchWereadRelatedBooks`；不接收 session theme overlay
- **no persistence**：`meta.persisted` 恒为 `false`；不写数据库 / 本地存储 / IndexedDB / 服务器
- **no public search / Meilisearch writes**：不调用 `/api/search`，不写入新索引、不修改 settings、不发起 meili.search
- **cleanup**：临时文件 `/tmp/s27j-*.json` 全部清除；nginx private access_log 关闭（沿用 S27H/S27I 配置）；API/Web 日志零 `annual-review` 行 / 零 token / 零 note text
- **bundle 安全扫描**：web dist 中无 `WEREAD_PRIVATE_API_TOKEN` 字面值、无第三方 API key 字面值

---

## REGRESSION_RESULT

- **vitest**：1121 tests / 49 files PASS（含新增 63 API + 27 model + 8 fetcher + 30 dashboard = 128 个 S27J 测试；既有 993 个测试零回归）
- **API tsc**：`apps/api/tsconfig.json --noEmit` PASS
- **web tsc**：`apps/web/tsconfig.json --noEmit` PASS
- **snapshot validate**：`tsx scripts/weread/validate-weread-snapshot.ts --dir samples/weread` → STATUS=PASS
- **verify**：`MEILI_HOST=http://127.0.0.1:7700 tsx scripts/verify.ts` → `numberOfDocuments = 5,115,734`
- **search-quality**：17 PASS / 0 WARN / 0 FAIL（`NO_PROXY="*" tsx scripts/search-quality-regression.ts`）
- **build**：`vite build` → `dist/index.html 0.41 kB · index-*.css 77.76 kB · index-*.js 412.83 kB · built in 246ms`
- **package.json**：无新增依赖
- **既有 S27H/S27I/S27I-2 测试零回归**

---

## DEPLOY_RESULT

- **API/Web rebuilt**：`docker compose up -d --no-deps --build api web` → fresh `Up`
- **Meilisearch untouched**：仍为 `Up 4 weeks`（4 周未重启）
- **Caddy / DNS / nginx / 合规未修改**：未触碰 `web` 容器的 `default.conf`（`access_log off;` 沿用 S27H 配置）；未触碰公安备案页脚本轮

---

## LIMITATIONS

- 只有 `createdAt` / `updatedAt` 有效的记录才进入年度聚合；缺日期的记录被丢弃且不出现在 `availableYears` 中
- 只有 confirmed matched public catalogId 进入年度 top books；未匹配笔记仍计入 `total` / 类型，但不出现在 `topBooks[]`
- 月度活跃度分类（高活跃 / 稳定 / 轻量 / 无记录）只是数量描述；不做主题分析、不做心理推断
- 暂不支持年度 Markdown / PDF 导出（当前版本只在浏览器内展示）
- 暂不支持跨任意日期范围的对比（仅按完整自然年聚合）
- `firstNoteAt` / `lastNoteAt` 时间戳为 ISO 字符串（已脱敏到分钟精度，源自原始 `createdAt` / `updatedAt`）；这些是聚合日期而非笔记正文

---

## NEXT_STEP

- **S27J-2**：浏览器本地年度回顾 Markdown 导出（与 S27I-2 / S27F 一致的纯浏览器生成，不调用 API、不写服务器）
- **S27K**：年度对比（按用户选择的两个年份并排展示 overview / months / quarters / top books 的差异）

---

报告路径：`/opt/book-id-search/reports/WEREAD_ANNUAL_REVIEW_REPORT.md`