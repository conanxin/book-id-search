# S27K — Year-over-Year Reading Comparison Report

> 微信读书中心「年度回顾」工作区新增**年度对比**。该功能复用两份 `WereadAnnualReviewResponse`（基准年 + 目标年），不新增后端 endpoint、不调用 MiniMax、不读取笔记正文、不持久化对比结果。

---

## STATUS

**PASS**

- vitest：1227 PASS / 0 FAIL（52 个测试文件）。
- web tsc：`tsc -p apps/web/tsconfig.json --noEmit` PASS。
- Vite build：PASS。
- verify docs：`numberOfDocuments = 5,115,734` PASS。
- search-quality：17 PASS / 0 WARN / 0 FAIL。
- web rebuilt：`book-id-search-web` container recreated。
- api / Meilisearch / Caddy / DNS / nginx / ICP 未触碰。
- 浏览器 smoke（`scripts/s27k-browser-smoke.cjs`）：30/30 PASS（synthetic fixtures，annual-review=5 / ai-summary=0 / related-books=0 / external-requests=0 / md-downloads=0）。

---

## SCOPE

- 在「年度回顾」工作区新增「开启年度对比」入口，默认关闭。
- 入口仅在 `availableYears.length >= 2` 时启用，否则 disabled 并显示「至少需要两个有记录的年份才能进行年度对比」。
- 开启后允许选择基准年份 / 目标年份、支持「交换年份」「关闭对比」、沿用主年度当前的 `topBooks` 范围（6 / 12 / 18）。
- 复用两份 `GET /api/private/weread/annual-review?year=<YYYY>&topBooks=<6|12|18>` 响应，不新增后端 route。
- 浏览器内存缓存：dashboard 生命周期内，同一 `(year, topBooks)` 不重复请求。
- 切换 token / 卸载 / 关闭对比：立即 abort + 清空缓存 + 清空对比结果。
- 不修改 `apps/api`，不调用 MiniMax，不调用 related-books，不写 Meilisearch，不写 storage，不自动导出文件。

---

## ALGORITHM_RESULT

**delta / percentage / zero baseline / monthly / quarter / books**

- delta：`target − base`，纯整数。
- percentage：
  - `base > 0` → `(target - base) / base × 100`，最多保留 1 位小数。
  - `base = 0 && target > 0` → `percentChange = null`，`direction = from_zero`，UI 显示「由 0 增至 N」。
  - `base > 0 && target = 0` → `percentChange = -100`，`direction = to_zero`。
  - `base = 0 && target = 0` → `percentChange = 0`，`direction = same`。
  - NaN / Infinity 一律替换为 0。
- monthly：固定 12 个月，按数字 `1..12` 排序；缺失月份按 0 处理。
- quarter：固定 Q1 → Q4；`bookCount` 由 `month.bookCount` 求和（与服务端 `quarter.bookCount` 解耦，保证对比口径一致）。
- books：只比较两个 `topBooks` 数组，分类 continuing / entered / left；公共元数据优先用目标年，回退基准年；不回退微信读书私有 title / author；`rankChange = baseRank − targetRank`（正数 = 排名上升）。

---

## FRONTEND_RESULT

- 入口：`weread-year-comparison-toggle` 按钮，默认显示「开启年度对比」，开启后变为「关闭年度对比」。
- 年份控件：`weread-year-comparison-base-year` / `weread-year-comparison-target-year`；目标年默认 = 主年度当前年份，基准年默认 = `availableYears` 中**小于目标年**的最大年份。
- 缓存：`compareCacheRef`（Map，`${year}:${topBooks}` → response），仅在当前组件生命周期内有效；同一 key 不重复并发请求。
- 指标卡：六张指标卡（阅读记录 / 活跃月份 / 已匹配记录 / 年度书目 / 最长连续月份 / 活跃月份平均记录），显示基准年值 / 目标年值 / 绝对变化 / 百分比。
- 时间轴：12 个月双柱 SVG（基准年 #4a5366，目标年 #2b6cb0），提供文本 a11y 列表。
- 季度：Q1–Q4 四张卡（两年记录数 / 差值 / 活跃月份 / 书目数量）。
- 书目组：连续上榜 / 进入目标年度榜单 / 未进入目标年度榜单 三组。
- 响应式：desktop 1440 metrics 6 列 + quarters 4 列 + books 3 列；tablet 1200 / 640 断点降级；mobile 360 无横向滚动。

---

## PRIVACY_RESULT

- **included fields**：catalogId / title / author / publisher / publishYear / 数量字段 / 日期字符串 / 公开月份 / 公开季度 / overview 计数。
- **excluded fields**：note.text / note.comment / noteId / highlightId / chapterTitle / wereadBookId / 微信读书原始 title / author / AI summary / 主题 / token / API key。
- **requests**：仅 `GET /api/private/weread/annual-review`；不调用 `/notes/summarize` / `/related-books` / `/api/search`；不调用 MiniMax；不调用任何 POST / PUT / PATCH / DELETE。
- **no AI**：所有数据来自 `WereadAnnualReviewResponse` 的纯函数派生，无 MiniMax / AI 请求。
- **no persistence**：不写入 `localStorage` / `sessionStorage` / IndexedDB；切换 token 立即 abort + 清空；卸载组件 abort 所有请求；关闭对比清空状态与缓存。
- **cleanup**：token 改变 / 卸载 / 关闭对比时，`AbortController.abort()` 触发；缓存与状态清零。

---

## REGRESSION_RESULT

| 检查 | 结果 |
|------|------|
| `npx vitest run` | **1227 PASS / 0 FAIL**（52 文件，含 30 个 S27K model 测试 + 20 个 S27K panel 测试 + 41 个 dashboard 测试 + 1136 个旧测试） |
| `tsc -p apps/web/tsconfig.json --noEmit` | **PASS** |
| Vite build | **PASS**（dist 451 KB JS / 86 KB CSS） |
| `tsx scripts/verify.ts` | **PASS**（docs = 5,115,734） |
| `tsx scripts/search-quality-regression.ts` | **17 PASS / 0 WARN / 0 FAIL** |
| `node scripts/s27k-browser-smoke.cjs` | **30/30 PASS**（annual-review=5, ai-summary=0, related-books=0, md-downloads=0, external=0） |

- `apps/api` 文件无任何改动（`git diff --stat apps/api` 为空）。
- `package.json` 无变化。
- `apps/web/dist` / `reports/screenshots` / `progress` 未提交。

---

## DEPLOY_RESULT

- ✅ `book-id-search-web` 已重建（`docker compose up -d --no-deps --build web`）。
- ✅ `book-id-search-api` 未触碰（仍为 Running，原容器）。
- ✅ `book-id-search-meilisearch` 未触碰（仍为 Running，原容器）。
- ✅ Caddy / DNS / nginx / ICP / 公安备案配置未触碰。

---

## LIMITATIONS

- 只比较**两个自然年**，不支持任意日期区间。
- 只比较**有效日期**（即 `note.createdAt` 或 `updatedAt` 解析得到的日期）的阅读记录；无日期笔记不计入。
- 顶部书目仅覆盖**已确认匹配的公共书目**；纯微信读书私有书目不参与对比。
- 切换 `topBooks` 范围（6 / 12 / 18）会改变对比结果；页面明确说明这一点。
- 不做主题 / 类别 / 阅读内容分析；不调用 MiniMax。
- 不做心理 / 阅读质量 / 阅读兴趣推断。
- 仅当 `availableYears.length >= 2` 时才能启用对比入口。
- 不写 server，不写 storage，不提供公开分享。

---

## NEXT_STEP

- **S27K-2**：browser-local comparison Markdown export（在浏览器内生成两份对比的 Markdown 文件，纯本地）。
- **S27L**：long-term reading archive index（多年滚动聚合）。