# WeRead Reading Data Repair Recommendations — Model Phase A

> S27R-1A + S27R-1B 模型阶段正式报告
> 状态：**PASS**

---

## STATUS

**PASS**

## MODEL_SCOPE

- 输入为当前数据质量审计结果（`WereadReadingDataQualityAudit`）。
- 输出确定性修复建议计划（`WereadReadingDataRepairPlan`）。
- 不执行任何修复（`automatic = false` 固定）。
- 不重新请求网络数据（`meta.requestedNetwork = false` 固定）。
- 不调用 AI（无 `MiniMax` / 无 `/related-books` 调用）。
- 不修改源档案（`modifiesSourceData = false` 固定）。
- 不持久化（`meta.persisted = false` 固定）。

## MAPPING_RESULT

| Layer | 元素数 | 约束 |
|-------|-------|------|
| 真实 `ReadingDataQualityIssueCode` 联合 | 36 | TypeScript `Record` 编译期穷尽 |
| `ReadingDataRepairAction` | 9 | exhaustive `Record` |
| `ReadingDataRepairCapability` | 5 | exhaustive `Record` |
| `ReadingDataRepairPriority` | 4 | enum |
| `ReadingDataRepairGuidanceKey` | 9 | exhaustive `Record` |
| `ReadingDataRepairRecommendation` 字段 | 15（固定） | exact-whitelist 验证 |

所有映射均为 TypeScript 编译期穷尽约束（`satisfies Record<…>`），运行期再被对应单元测试验证。

## ACTION_RESULT

| Action | 含义 |
|--------|------|
| `retry_failed_year` | 建议用户对当前失败的年份触发「重新获取」 |
| `reload_year` | 建议用户对当前未闭合的目标年份重新加载 |
| `inspect_source_data` | 建议用户检查源数据一致性（年份冲突 / 重复 / 非法） |
| `review_metric_relationship` | 建议用户核对年度内部数值与指标关系 |
| `review_top_book_metadata` | 建议用户核对 Top N 书目公共元数据 |
| `review_year_link` | 建议用户核对相邻年度链接比例与计数 |
| `review_recurring_aggregation` | 建议用户核对多年上榜书目聚合 |
| `unsupported_with_current_fields` | 当前字段无法独立验证（预留分支） |
| `no_action_required` | 无需采取行动（仅作信息记录） |

每条 Action 仅产出枚举值与 Recommendation 定位字段，不含任何文字说明、指令或理由。

## PLAN_RESULT

- 一条 Issue → 一条 Recommendation（一对一映射）。
- Recommendation ID 确定性：`repair:<issue.id>:<action>`，无 UUID、无时间戳。
- 排序稳定：`(priorityRank, scopeRank, yearAsc, fromYear, toYear, sourceIssueCode lex, itemIndex, rank, id)`。
- 固定字段：`automatic = false`、`modifiesSourceData = false`。
- 定位字段：`year` / `fromYear` / `toYear` / `itemIndex` / `rank`（仅当源 Issue 携带时保留）。
- 摘要字段：
  - `summary` — total + 4 优先级计数 + 4 capability 分类计数。
  - `actionCounts` — 9 个 Action 键，缺则 0。
  - `capabilityCounts` — 5 个 Capability 键，缺则 0。
  - `groups` — 按 `(priority, action)` 分桶，每个 group 自带 `count` + `recommendations` 数组（与 plan.recommendations 内容相同但引用隔离）。
  - `meta` — 固定 4 字段（`source / persisted / requestedNetwork / automaticRepair`）。

## GUIDANCE_RESULT

- `ReadingDataRepairGuidanceKey` 仅为 9 个枚举值。
- 不含自由文本 instruction / message / reason / detail。
- 中文操作说明留给后续 UI / Dashboard 阶段做穷尽映射。
- Action → GuidanceKey 映射：
  - `retry_failed_year` → `retry_failed_years`
  - `reload_year` → `reload_archive_year`
  - `inspect_source_data` → `inspect_archive_source`
  - `review_metric_relationship` → `review_year_metric_consistency`
  - `review_top_book_metadata` → `review_top_book_public_metadata`
  - `review_year_link` → `review_adjacent_year_links`
  - `review_recurring_aggregation` → `review_recurring_aggregation`
  - `unsupported_with_current_fields` → `current_fields_insufficient`
  - `no_action_required` → `no_action`

## GROUPING_RESULT

- `groupReadingDataRepairRecommendations(recommendations)` 返回 `ReadingDataRepairRecommendationGroup[]`。
- 先按 priority rank 排序（high → medium → low → informational）。
- 同 priority 内按 Action 固定顺序排序（与 `ALL_ACTIONS` 一致）。
- 同一 group 内 `priority / action / capability / guidanceKey` 必然一致。
- group 内 Recommendation 沿用 Plan 既有确定性顺序。
- group `recommendations` 数组通过 `slice()` 复制，与 `plan.recommendations` 不共享引用。
- 空输入返回 `[]`。
- 不修改输入数组。

## SELECTOR_RESULT

| Selector | 返回内容 | 行为 |
|----------|---------|------|
| `selectHighestPriorityRepairRecommendations` | 当前实际存在的最高优先级全部建议 | 仅过滤，不触发 |
| `selectActionableRepairRecommendations` | 仅 `user_retry` / `user_reload` | 仅过滤，不触发 |
| `selectManualReviewRepairRecommendations` | 仅 `manual_review` | 仅过滤，不触发 |
| `selectUnsupportedRepairRecommendations` | 仅 `unsupported` | 仅过滤，不触发 |

所有 Selector：
- 返回新数组（不共享引用）。
- 不修改 plan。
- 保持确定性顺序。
- 不会执行对应动作（设计层面不持有执行权）。

## REACHABILITY_RESULT

`unsupported_with_current_fields`：

**标记：`MODEL_SUPPORTED_BUT_NOT_REACHABLE_WITH_CURRENT_ISSUE_UNION`**

原因：
- 当前 S27Q `ReadingDataQualityIssueCode` 联合类型未暴露 `recurring_best_rank_mismatch` 与 `recurring_latest_rank_mismatch` 两个 reserved code。
- Archive 数据模型不暴露逐年度 rank 映射（`bestRank` / `latestRank` 字段在 recurring 聚合中暂未提供）。
- 因此在当前真实审计下，没有任何 IssueCode 能映射到 `unsupported_with_current_fields`。

处理原则：
- 不修改 S27Q IssueCode 联合（边界约束）。
- 不伪造 reserved Issue 实例。
- 保留 Action / Capability / GuidanceKey / Selector / Group 完整链路，供未来字段扩展直接启用。
- 当未来 S27Q 联合类型扩展、或 Archive 数据结构新增逐年度 rank 映射时，本模型无需任何代码修改即可触发 `unsupported_with_current_fields` 分支。

## DEBUG_RESULT

允许（仅含可序列化计数 / 枚举 / 定位）：
- `count / priorityCounts / actionCounts / capabilityCounts`
- `groupCount / groups[{priority, action, capability, guidanceKey, count}]`
- `actions / guidanceKeys / codes / scopes / priorities / capabilities`
- `years / fromYears / toYears`
- `meta`

排除：
- Recommendation ID
- Issue ID
- `itemIndex` / `rank`
- `actual` / `expected`
- `title` / `author` / `catalogId`
- raw audit
- `token` / 私有 IDs

序列化保证：`JSON.stringify(snap)` 不含 `NaN` / `Infinity` / `undefined`。

## PRIVACY_RESULT

- 无笔记正文 / 评论 / 划线 / 章节标题。
- 无私有 IDs（`noteId` / `wereadBookId` / `highlightId`）。
- 无 token / API key。
- 无网络调用（`fetch` mock 计数 = 0）。
- 无 storage 写入（`localStorage.setItem` 计数 = 0）。
- 无 DOM 副作用。
- 无用户评价性结论（JSON 中不含「兴趣 / 能力 / 阅读质量 / 心理 / 人格 / 优秀 / 较差 / 用户评分」）。
- 无自动修复（`automatic = false` 强制）。

## TEST_RESULT

- **targeted**：`104 / 104 PASS`（`apps/web/src/weread/wereadReadingDataRepairRecommendations.test.ts`）
- **full vitest**：`77 files / 2620 / 2620 PASS`
- **tsc**：PASS（exit 0）
- **apps/api / package.json / pnpm-lock.yaml**：无变化

测试覆盖：36 个真实 IssueCode 穷尽映射、Action / Capability / Priority / GuidanceKey 派生、Recommendation 字段白名单、确定性 ID 与排序、summary / actionCounts / capabilityCounts / groups、Selector 行为（最高 / 可操作 / 手动审核 / 不支持）、Debug Snapshot 排除断言、生产模型无网络 / 无 storage / 无 DOM 副作用、无评价性语言、JSON 无 NaN / Infinity、输入 audit 不可变、完整构建确定性。

## KNOWN_LIMITATIONS

- 只生成修复建议，不执行任何动作。
- 不重新请求数据（不调用 `annual-review`）。
- 无源服务器写入能力。
- reserved `unsupported_with_current_fields` 分支当前不可从真实审计触发（见 REACHABILITY_RESULT）。
- 不提供自由文本修复说明。
- 不评价用户本人、阅读兴趣、能力或心理状态。
- UI / Dashboard 与 Markdown 导出尚未实现。
- 不修改 S27Q 审计模型。

## NEXT_STEP

S27R-2 — Reading Data Repair Recommendations Dashboard