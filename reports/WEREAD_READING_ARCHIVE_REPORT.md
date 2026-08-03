# WEREAD_READING_ARCHIVE_REPORT.md

**任务：** S27L Long-term Reading Archive Index — Finalize & Release
**日期：** 2026-08-03
**目标版本：** v0.17.0-weread-reading-archive

---

## STATUS: WARN

Browser smoke (Puppeteer + synthetic request interception) 通过 20/38 检查后崩溃于等待 tab 切回后渲染控件。按 spec F10 规则：commit + push，不打 tag，README 保持 v0.16.1-weread-year-comparison-markdown。

---

## SCOPE

- 仅复用既有 annual-review GET（GET /api/private/weread/annual-review）
- 浏览器内存长期档案聚合
- 最多加载 20 个年份
- 不新增 API、不调用 AI、不持久化、不公开分享
- 第 5 个工作区"长期档案"

---

## ALGORITHM_RESULT

| 模块 | 内容 |
|---|---|
| 年份归一化 | availableYears 去重、降序；requestedYear/2025 由父级 setRequestedAnnualReviewYear(2025) 注入用于 bootstrap |
| 档案总览 | yearsWithData / firstYear / latestYear / totalRecords 求和 / activeMonths 求和 / averageRecordsPerYear / mostActiveYear（并列取更早） |
| 活跃年 streak | 仅按自然年连续；totalRecords>0 计入 |
| 多年进入 Top N 高互动榜 | 至少进入 2 年；title/author 取最新年份公共字段，缺失向更早年份回退；不回退微信读书私有 title/author |
| 相邻年度榜单重合 | 只比较相邻有数据年份；sharedTopBooks / overlapRatio = shared/union；union=0 时=0；最多 1 位小数 |
| 部分失败处理 | 失败年份不丢弃成功年份；显示"N 年成功 M 年失败"；提供"重试失败年份"按钮 |

---

## FRONTEND_RESULT

| 模块 | 内容 |
|---|---|
| 第五个工作区 | WereadCenter.tsx 增加 archive tab + ReadingArchiveDashboard 嵌入点 |
| 懒加载 | 首次 active=true 才请求；切回再进入不重新请求（cacheRef + state.progress 持久） |
| 并发限制 | 最大 2 个并发请求（MAX_CONCURRENT_REQUESTS=2） |
| 缓存 | cacheRef: Map<string, WereadAnnualReviewResponse>，key=`${year}:${topBooks}`，仅组件生命周期内存 |
| 范围控制 | 最近 5 / 10 / 全部最多 20 年 |
| Top Books 控制 | Top 6 / 12（默认） / 18，Top N 改变只请求缺失 cache key |
| 跨年度趋势 | SVG 柱状图（totalRecords 主柱 + activeMonths/matchedBooks 辅助） |
| 年度目录 | 按新到旧年度卡片，含"查看年度回顾"跳转按钮（onOpenAnnualYear → handleOpenAnnualYear → setRequestedAnnualReviewYear + setActiveTab("annual")） |
| 多年高互动书目 | Top N 范围驱动，排序：yearsOnList → totalNoteCountWithinLists → latestYear → bestRank → catalogId |
| 相邻年度榜单重合 | 列表显示 sourceYear → targetYear，shared 数 + overlapRatio 百分比 |
| 状态保留 | 5 个工作区均保持 mounted；切换不丢失档案缓存 |

---

## TEST_RESULT

| 项 | 结果 |
|---|---|
| 60 dashboard tests | PASS（ReadingArchiveDashboard.test.ts 60/60 PASS in 15ms） |
| 56 model tests | PASS（wereadReadingArchiveModel.test.ts 56/56 PASS） |
| 全量 vitest | 55 files / 1409 tests / 14.91s 全 PASS |
| web tsc | PASS（exit 0） |
| Vite build | PASS（489.17 kB JS / 87.13 kB CSS / 291ms） |
| verify | PASS（docs=5,115,734 / 6 checks） |
| search-quality | 17 PASS / 0 WARN / 0 FAIL |

---

## BROWSER_RESULT

合成 6 个 annual-review 年份（包含正常 / 空 / 首次失败后重试成功 / 多年重复 topBooks / 相邻年份不同 overlap）。

通过 20/38 检查后 Puppeteer crash at `waitForSelector('[data-testid="weread-reading-archive-range-all"]')` after 25s timeout，原因：tab 切回 archive 后 dashboard 暂处 loading 分支（无 controls testid），推测为 `handleTabChange` 重置 `requestedAnnualReviewYear=2025` + 新 mount/re-render 时 `state.availableYears=[]` → `effectiveYears=[2025]` → slice=[2025] → status=loading → `isLoading && loadedCount===0` 进入 loading 分支。

通过的 20 项：五个 workspace tabs / 默认笔记工作区 / 长期档案未激活前请求=0 / 激活后取得 availableYears / 逐年请求 / 6 年全部加载（range=all, concurrency≤2）/ overview / 跨年度趋势 / 年度目录 / recurring books / adjacent-year links / 最近 5 年 / 最近 10 年 / max=20 / Top 6 / Top 12 / Top 18 / cache 命中 / tab 切回不重复请求。

未通过：21–38（partial failure / retry / 跳转 / 退出禁词 / 横向滚动 / DOM 扫描 / 隐私说明 / ICP footer 持久存在 / Top N 口径声明 / 心理推断禁词）。

修复建议（供 S27L-2 复查）：
- `handleTabChange` 切到 archive 时不强制 setRequestedAnnualReviewYear(2025)（让 dashboard 保留 state.availableYears）；或
- dashboard 内 `isLoading && loadedCount===0` 分支保留 controls 占位符；或
- smoke 在 tab 切回后等到 archive-overview 出现再等 controls。

---

## PRIVACY_RESULT

- 不读 note.text / note.comment
- 不读 summary.overview / summary.keyPoints / summary.reviewQuestions
- 不调用 fetchWereadAiSummary / fetchWereadRelatedBooks
- 不使用 localStorage / sessionStorage / IndexedDB
- title / author / publisher / publishYear 全部走 Meilisearch getDocument 公共字段
- 不回退微信读书原始 title/author（recurringBooks 排序里 catalogId 稳定排序兜底）
- 不写入 Meilisearch
- bundle scan：empty（无 token / API key / Bearer）
- runtime log scan（30 min）：empty（无 Authorization/Bearer/wereadBookId/noteId/highlightId/private-data/annual-review response）

---

## REGRESSION_RESULT

| 项 | 结果 |
|---|---|
| vitest | 1409 PASS / 0 FAIL |
| web tsc | PASS |
| Vite build | 489.17 kB JS / 87.13 kB CSS |
| verify docs | 5,115,734 |
| search-quality | 17 PASS / 0 WARN / 0 FAIL |
| apps/api | 无变化 |
| package.json | 无变化 |

---

## DEPLOY_RESULT

- web rebuilt：book-id-search-web-1 Up 6 minutes（docker compose up -d --no-deps --build web 已跑）
- api untouched：book-id-search-api-1 Up 9 小时
- Meilisearch untouched：book-id-search-meilisearch-1 Up 4 周
- Caddy / DNS / nginx / ICP / 公安备案：未修改

---

## LIMITATIONS

- 最多加载 20 个年份
- recurring books / adjacent-year overlap 受当前 Top N 范围影响（Top 6/12/18 会改变结果）
- 不统计完整跨年唯一书目数（matchedBooks 不跨年相加）
- 不做主题、类别、心理或阅读质量分析
- 不提供"开始/停止阅读"判断
- 暂不支持长期档案 Markdown 导出
- browser smoke 因 tab 切回时序问题未达 38/38 PASS

---

## NEXT_STEP

- S27L-2 browser-local long-term archive Markdown export（先修 tab-round-trip 后再 ship）
- S27M reading-era segmentation

---

## GIT_RESULT

- commit：pending（在本报告完成后）
- push：pending
- tag v0.17.0-weread-reading-archive：NOT PUSHED（按 WARN 规则）
- README 稳定 tag 保持：v0.16.1-weread-year-comparison-markdown

---

报告不得包含：真实年度统计 / 真实书目清单 / 真实 catalogId 关系 / 笔记正文 / token / private IDs。