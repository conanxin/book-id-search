# S27L — WeRead Long-term Reading Archive

> 微信读书中心新增**第 5 个工作区「长期档案」**。该功能复用「年度回顾」已发出的 `WereadAnnualReviewResponse`，把多份年度聚合数据按时间维度合并成一个**多年阅读档案索引**。它不新增后端 endpoint，不调用 MiniMax，不读取笔记正文，不持久化档案结果。

---

## 1. 功能范围

- 仅在 `/weread` 中心页出现，作为第 5 个工作区 tab：「长期档案」。
- 入口位于「年度回顾」之后；用户首次点击该 tab 才会真正发起请求（懒加载）。
- 复用 N 个 `GET /api/private/weread/annual-review` 响应（N = 当前年份范围选项对应的年份数；最多 20 年），不新增后端 route。
- 档案结果只在当前浏览器组件内存中存在，切换 token / 卸载组件 / 关闭 tab 时立即清空；不写入 localStorage / sessionStorage / IndexedDB。
- 不读取笔记正文、笔记评论、章节标题、划线正文、AI 概要、token、私有 ID 等任何敏感字段。
- 不调用外部 AI（不调用 MiniMax / 不调用 `/related-books`）。
- 不公开任何长期数据，不写入 Meilisearch。
- **暂不支持长期档案导出**（保留 S27L-2 作为后续工作）。

## 2. 年份范围与切片

| 选项 | 实际加载年份数 | 备注 |
|------|---------------|------|
| `最近 5 年` | 5 | `availableYears` 中最新 5 年 |
| `最近 10 年` | 10 | `availableYears` 中最新 10 年 |
| `全部（最多 20 年）` | 最多 20 | 任何 `availableYears` 长度都截断到 20 |

- 切片算法在 `pickArchiveYearSlice()` 内实现：先 `normalizeArchiveYears()`（去重 / 校验 2000–9999 区间 / 降序排序），再按选项 count 截断。
- `READING_ARCHIVE_MAX_YEARS = 20` 是硬上限，无论用户选哪个 range 都不会超过。
- 年份全部来自服务端 `WereadAnnualReviewResponse.availableYears`，前端不臆造任何年份。

## 3. 前端内存 cache 与并发

- 每次切换 `topBooks` 档位（6 / 12 / 18）会按 `${year}:${topBooks}` 生成 cache key。
- 切换年份范围时只清理**已不在新切片中**的 cache 条目，新切片内已成功加载的年份不会重复请求。
- 切回「长期档案」tab 不会重新触发请求（依赖 `initialFetchIssuedRef` + cache hit）。
- **最大并发数 = 2**（`MAX_CONCURRENT_REQUESTS`）。剩余年份在 in-flight 槽位释放后由调度器继续补齐。
- token 变化会立即 `AbortController.abort()` 全部 in-flight 请求并清空 cache。
- 组件 unmount 时同样会 abort 全部 in-flight 请求并清理 inflight ref。

## 4. 顶部高互动书目档位（Top N）

- 三个档位：`6` / `12` / `18`，与年度回顾 / 年度对比保持一致。
- 默认 `12`。
- 切换档位只重新请求那些**尚未缓存该档位**的年份。
- **「多年进入榜单书目」「相邻年度榜单重合」等所有聚合指标都基于当前 Top N 范围**——这是文档化的口径边界，UI 上有显式 Top N 范围声明。
- matchedBooks（年度回顾中的「已匹配书目数」）不作为长期档案唯一书目数；多年唯一书目数需要在更大的范围内才能给出，本期暂不提供。

## 5. 档案总览

| 字段 | 计算口径 |
|------|---------|
| `yearsWithData` | `totalRecords > 0` 的年份数 |
| `firstYear` / `latestYear` | `yearsWithData` 中最早 / 最新年份 |
| `totalRecords` | 跨年份 `totalRecords` 之和 |
| `totalActiveMonths` | 跨年份 `activeMonths` 之和 |
| `averageRecordsPerYear` | `totalRecords / yearsWithData` |
| `mostActiveYear` | `totalRecords` 最大者；并列时取更早年份 |
| `longestActiveYearStreak` | 年份号严格 +1 的连续段最大长度（跳过 `totalRecords = 0` 的年份） |
| `recurringTopBooks` | 至少 2 年进入当前 Top N 榜单的书目数 |

## 6. 多年进入榜单书目（recurring books）

- 算法：遍历所有 `WereadAnnualReviewResponse.topBooks`，收集在**至少 2 个不同年份**出现的 `catalogId`，按以下规则排序：
  1. `yearsOnList` 降序
  2. `totalNoteCountWithinLists` 降序
  3. `latestYear` 降序
  4. `bestRank` 升序
  5. `catalogId` 字典序升序
- 默认 limit = 12，可在 `buildRecurringArchiveBooks({ limit })` 覆盖。
- **仅代表多年进入当前 Top N 榜单**——不等于「多年一直阅读」或「多年喜欢阅读」。不推断阅读偏好、阅读质量、专注力或心理特征。

## 7. 相邻年度榜单重合

- 算法：只对**相邻两个年份**做 `topBooks` 集合的 `交集 / 并集`。
- `sharedTopBooks` = 共同上榜书目数
- `overlapRatio` = `交集 / 并集`（并集为空时为 0）
- **不**对任意两年做全连接表（那样会让表格过大且无信息量）。
- **仅描述 Top N 榜单重合度**，不代表阅读兴趣的稳定或改变，也不代表阅读质量。

## 8. 年度目录

- 每一个成功加载的年份一张卡片：阅读记录数、活跃月份数、最长连续月份、已匹配记录、年度书目数、高峰月份。
- 每张卡片有「查看年度回顾」按钮 → 调用 `onOpenAnnualYear(year)` → 父组件切换到「年度回顾」工作区并把 `requestedYear` 透传给 `<AnnualReviewDashboard requestedYear={year} />`。
- `requestedYear` 被应用后父组件会通过 0ms `setTimeout` 清除，避免 `useEffect` 反复触发。

## 9. 部分年份失败处理

- 某一年 `annual-review` 请求失败时，dashboard 会：
  1. 把该年的 `YearProgress` 标记为 `error`，并把年份加入 `failedYears`。
  2. 其他成功年份继续展示。
  3. 顶部出现「重试失败年份」按钮；点击后仅重发失败年份（不会重新请求成功的）。
- 单个年份失败**不会**丢掉整张档案。
- 网络层使用 `AbortController`，所以失败重试不会和成功响应混淆。

## 10. 隐私边界

- 不读取以下任何字段：`note.text` / `note.comment` / `chapterTitle` / `summary.overview` / `summary.keyPoints` / `summary.reviewQuestions` / `wereadBookId` / `noteId` / `highlightId` / token。
- 不调用 `fetchWereadAiSummary()`。
- 不调用 `fetchWereadRelatedBooks()`。
- 不调用除 `/api/private/weread/annual-review` 以外的任何 endpoint。
- 不使用 `localStorage` / `sessionStorage` / `IndexedDB`。
- 不使用 `dangerouslySetInnerHTML`。
- `meta.persisted` 永远为 `false`，`meta.source` 永远为 `"annual-review-cache"`，确保调用方无法把档案写入任何持久化层。
- UI 上有显式隐私声明 + Top N 范围声明 + 「不推断阅读偏好 / 阅读质量 / 心理特征」声明。

## 11. 已知边界 / 限制

- 最多 20 年（前端硬上限，未来服务端若放开可继续扩展）。
- 多年唯一书目数（跨年合并去重）暂不提供；目前只提供「多年进入当前 Top N 榜单」口径。
- 不提供主题 / 题材 / 阅读方向 / 兴趣漂移分析。
- 不做心理 / 阅读质量判断。
- 不导出 Markdown / PDF / ICS（留作 S27L-2）。
- 不展示任何真实书目清单 / 真实 catalogId 关系（开发时全部使用合成数据）。

---

**相关文件：**

- 模型：`apps/web/src/weread/wereadReadingArchiveModel.ts`
- 组件：`apps/web/src/weread/ReadingArchiveDashboard.tsx`
- 测试：`apps/web/src/weread/wereadReadingArchiveModel.test.ts`（56 项） + `apps/web/src/weread/ReadingArchiveDashboard.test.ts`（60 项）
- 报告：`reports/WEREAD_READING_ARCHIVE_REPORT.md`
