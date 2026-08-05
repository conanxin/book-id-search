# WeRead Long-term Reading Data Quality Audit — Model Phase A

STATUS: PASS

## AUDIT_SCOPE

- 审计对象：浏览器当前已加载的 WeRead 长期阅读档案（`ReadingArchive`）。
- 审计 target / loaded / failed years 的覆盖率与一致性。
- 审计年度聚合指标、Top N、YearLink、Recurring Books 的内部一致性。
- 审计产出 issue 集合与确定性排序。
- 不重新请求年度数据。
- 不调用 AI 模型，不写持久化层，不执行自动修复。
- 不修改 Archive model，不修改 API、reducer、cache、retry、scheduler。

## ISSUE_MODEL_RESULT

- `ReadingDataQualitySeverity = "error" | "warning" | "info"`。
- `ReadingDataQualityScope = "archive" | "coverage" | "year" | "top_book" | "year_link" | "recurring_book"`。
- `ReadingDataQualityIssue` 仅暴露安全定位字段：
  `id` / `code` / `severity` / `scope` / `year?` / `fromYear?` / `toYear?` / `itemIndex?` / `rank?` / `actual?` / `expected?`。
- Issue 不携带 `message` / `detail` / `title` / `author` / `catalogId` / raw archive / token。
- Issue `id` 确定性：
  `scope:code:year:fromYear:toYear:itemIndex:rank`，缺失段以 `"-"` 占位。
- 多字段同类异常通过稳定 `itemIndex` 避免 ID 冲突（`YEAR_METRIC_INDEX` 常量覆盖 9 个数值字段）。
- 最终排序规则：severity → scope → year → code → itemIndex → rank，全部确定性。
- IssueCode 总数 31（17 已实现 + 5 保留 + 7 YearLink + 6 Recurring，其中 2 个 Recurring 在当前 Archive 字段下标记为 NOT_APPLICABLE，详见 RECURRING_RESULT）。

## COVERAGE_RESULT

- `normalizeReadingDataQualityYears`：整数化 + 去重 + 升序排序，不修改输入。
- `auditReadingYearCoverage` 输出：
  - `targetYears` / `loadedYears` / `failedYears`
  - `unaccountedYears` / `unexpectedLoadedYears`
  - `accountedRatio = min(loadedYears ∩ targetYears) / |targetYears|`
- 检查项：
  - `target_year_unaccounted`：target 中未在 loaded/failed 中出现的年份
  - `loaded_failed_conflict`：同一年份同时出现在 loaded 与 failed
  - `duplicate_loaded_year`：loaded 内部重复
  - `empty_archive` / `partial_archive`：整体与部分缺失
- `accountedRatio` 分母为 0 时返回 1，比例上限 1，不出现 NaN/Infinity。

## YEAR_METRIC_RESULT

- 范围检查：`activeMonths ∈ [0,12]`、`streak ∈ [0,12]`、`streak ≤ activeMonths`、`peakMonth` 合法且与年度一致。
- 数值检查：`totalRecords` / `datedRecords` / `matchedRecords` / `matchedBooks` 非负且满足交叉约束。
- 非法值生成 Issue，`summary` 安全汇总按 0 处理。
- 业务不一致（如 `activeMonths=0` 但 `peakMonth` 存在）输出 warning。
- 9 个 year code 全部就位，含 `streak_months_out_of_range`。

## TOP_BOOK_RESULT

- 基础检查：`top_books_exceed_limit` / `missing_catalog` / `duplicate_catalog`。
- 启用 `bookMetadata` 时扩展：missing title / invalid rank / duplicate rank / records exceed year total / order mismatch。
- catalog/rank 在 `topBooks` 内部唯一。
- rank 与年度 `totalRecords` 一致。
- `bookMetadata` 缺失对应可选检查跳过，不写虚假 Issue。
- Issue / debug 不含 `catalogId` 或 `title`，仅含 scope/year/code/rank。

## YEAR_LINK_RESULT

- `auditReadingDataQualityYearLinks` 完整实现，7 个 code 全到位：
  `year_link_unknown_year` / `year_link_invalid_order` / `year_link_duplicate_pair` / `year_link_invalid_counts` / `year_link_ratio_out_of_range` / `year_link_ratio_mismatch` / `missing_year_link`。
- `sourceYear` 与 `targetYear` 必须属于 loaded years 且 `sourceYear < targetYear`。
- `sharedTopBooks` 必须为有限非负整数。
- `overlapRatio ∈ [0,1]`，且 `sharedTopBooks=0 ↔ overlapRatio=0`。
- 容差：与真实模型的固定舍入精度一致（≤ 0.0001）。
- `yearLinkCoverageRatio = 合法存在的期望相邻 pair / 期望相邻 pair 总数`。
  - 期望相邻 pair：取升序 loaded years 的相邻成功年份对，自然年份中断仍期望存在 link。
  - 重复 pair 仅计一次。
  - 非期望额外 pair 不计入分子。
  - 分母为 0 时返回 1。
  - 最多保留 4 位小数。
  - 不出现 NaN/Infinity。
- Archive 当前不暴露 `unionBooks`，对应检查跳过；模型不虚构字段。

## RECURRING_RESULT

已实现：

- `recurring_duplicate_catalog`：catalog 在 `recurringBooks` 内唯一。
- `recurring_appearance_count_mismatch`：`yearsOnList` 与 `years.length` 一致。
- `recurring_unknown_year`：`years` 中年份不属于 loaded years。
- `recurring_duplicate_year`：`years` 内部年份重复。
- `recurring_invalid_rank`：`bestRank` / `latestRank` 非正整数。
- `recurring_latest_year_mismatch`：`latestYear` 不属于 `years`。

NOT_APPLICABLE_WITH_CURRENT_ARCHIVE_FIELDS：

- `recurring_best_rank_mismatch`
- `recurring_latest_rank_mismatch`

原因：当前 `ReadingArchiveRecurringBook` 公开字段仅 `years` / `yearsOnList` / `bestRank` / `latestYear` / `latestRank`，未暴露逐年度 appearance rank 映射，因此无法独立重算 `bestRank` 或核对 `latestYear` 对应 rank。模型不虚构逐年 rank，亦不修改 Archive 类型。当前主构建函数不产生这两个 code。

## SUMMARY_RESULT

- `safeSumYears`：仅累加 `Number.isFinite && >= 0`，非法按 0 处理。
- 四项比例：
  - `datedRecordRatio = datedRecords / totalRecords`，分母 0 返回 1。
  - `matchedRecordRatio = matchedRecords / totalRecords`，分母 0 返回 1。
  - `publicTopBookMetadataRatio = topBooks with publicMetadata / topBooks.length`，分母 0 返回 1。
  - `yearLinkCoverageRatio`：见 YEAR_LINK_RESULT。
- 比例统一裁剪到 [0,1]，最多 4 位小数，无 NaN/Infinity。
- `issueCounts` 与 `issues` 长度一致。
- 状态推导：任意 `error` → `fail`；无 error 且存在 `warning` → `warn`；否则 `pass`。
- 这些比例是数据覆盖与一致性指标，不是用户评分。

## DEBUG_RESULT

- 允许字段：
  - `status`
  - `issueCounts`（by severity）
  - `issues[]`：仅 `id` / `code` / `severity` / `scope` / `year` / `fromYear` / `toYear`
  - `coverage`：`targetYears` / `loadedYears` / `failedYears` / `unaccountedYears` / `unexpectedLoadedYears`
  - `ratios`：`accountedRatio` / `datedRecordRatio` / `matchedRecordRatio` / `publicTopBookMetadataRatio` / `yearLinkCoverageRatio`
  - `persisted` / `requestedNetwork`
- 排除字段：`itemIndex` / `rank` / `actual` / `expected` / `totalRecords` 等明细数值 / `catalogId` / `title` / `author` / raw archive / cache 或 request key / token / private IDs。
- `JSON.stringify` 安全：所有数值有限，无循环引用。

## PRIVACY_RESULT

扫描 `apps/web/src/weread/wereadReadingDataQualityAudit.ts`：

- 笔记正文 / 评论 / 标注：0 命中
- `wereadBookId` / `noteId` / `highlightId` / `chapterTitle`：0 命中
- `Authorization` / `token=` / `fetch(` / `XMLHttpRequest`：0 命中
- `localStorage` / `sessionStorage` / `indexedDB`：0 命中
- `window.` / `document.` / `dangerouslySetInnerHTML` / `innerHTML`：0 命中
- 评价性文案（更爱阅读 / 兴趣 / 能力 / 阅读质量 / 心理状态 / 人格 / 成长 / 退步 / 低谷 / 巅峰）：0 命中

Issue / debug 仅暴露结构化安全字段，不携带用户身份或笔记内容。

## TEST_RESULT

| 项目 | 结果 |
|------|------|
| targeted vitest | 105 / 105 PASS（1 file, 447ms） |
| full vitest | 2341 / 2341 PASS（73 files, 27.80s） |
| web tsc | exit 0（无任何输出） |
| 边界文件 diff | apps/api / package.json / pnpm-lock.yaml / apps/web/Dockerfile / docker-compose.yml 全部为空 |

测试期间无跳过、无 console error、无 React Hook warning。

## KNOWN_LIMITATIONS

- 仅审计当前浏览器已加载的档案，不重新请求数据。
- 失败年份（failedYears）的内容无法审计。
- 仅基于当前 `ReadingArchive*` 类型公开字段；Archive 字段定义变化需重新评审。
- 不与源服务器重新对账，不审计原始笔记内容。
- 不自动修复异常，仅暴露 issue。
- Recurring Books 当前 Archive 未暴露逐年度 rank，因此 `best_rank_mismatch` / `latest_rank_mismatch` 标记为 NOT_APPLICABLE。
- 不评价用户行为，所有比例是覆盖与一致性指标。

## NEXT_STEP

S27Q-2 — Long-term Reading Data Quality Audit Dashboard