# WeRead Long-term Reading Data Quality Audit — Dashboard Phase B

STATUS: PASS

## FRONTEND_SCOPE

- 仅展示当前浏览器已加载的长期档案（`WereadReadingArchive`）。
- 面板 props：`archive` / `targetYears` / `failedYears` / `topBooksLimit` / `bootstrapLoading`。
- `targetYears` 直接来自 `archive.visibleYears`（机器状态机的目标集合），并非仅来自 loaded years，确保能发现 unaccounted years。
- 不发起网络请求；不调用 AI；不写入 localStorage / sessionStorage / IndexedDB。
- 不修改 URL；不使用 `dangerouslySetInnerHTML` 或 `innerHTML`。
- 不持久化审计结果；不自动修复异常。

## STATUS_RESULT

- `pass`：中性文案 `数据审计通过`。
- `warn`：中性文案 `数据部分需注意`。
- `fail`：中性文案 `存在数据一致性错误`。
- CSS modifier `--pass` / `--warn` / `--fail` 三套颜色。
- Issue 计数显示为 error / warning / info 三类，与模型 `summary.issueCounts` 完全一致。
- 状态推导严格来自模型 `deriveStatus`：error → fail；warning → warn；其他 → pass。
- 不使用“危险”“低质量”“不合格”等用户评价性词汇。

## COVERAGE_RESULT

- 年份集合：目标 / 加载 / 失败 / 未闭合 / 额外加载。
- 年份闭合比例 = 已加载或失败的目标年份 / 目标年份，分母为 0 时返回 100%（模型返回 1）。
- 未闭合年份明确解释为“既未成功加载，也未被标记为暂时失败的目标年份”。
- 额外加载年份明确解释为“已加载但不属于当前目标范围的年份，仅计入审计摘要，不自动判错”。
- 不展示请求错误、`requestId`、cache key 或网络层细节。

## RATIO_RESULT

- 五项比例：
  - 年份闭合比例
  - 有效日期记录占比
  - 已匹配记录占比
  - Top N 公共元数据完整比例
  - 相邻年度链接覆盖比例
- 每项配口径说明 + 中文标签 + 百分比。
- 比例固定说明：`这些比例用于描述数据覆盖和可核对程度，不评价阅读行为。`
- 分母为 0 时 UI 显示 100%（模型返回 1），但保留口径说明，不出现 NaN/Infinity。
- 五项比例均为数据覆盖指标，不是用户评分。

## ISSUE_RESULT

- `ISSUE_LABELS` 通过 `satisfies Record<ReadingDataQualityIssueCode, string>` 穷尽映射模型当前联合类型，编译期保证无漂移。
- `SCOPE_LABELS` 通过 `satisfies Record<ReadingDataQualityScope, string>` 穷尽映射。
- 严重级别分三组：错误 / 警告 / 信息；每组为空时显示“当前没有此级别的问题”。
- Issue 卡片只暴露安全数值字段（year / fromYear / toYear / itemIndex + 1 / rank / actual / expected），`null`/`undefined` 省略。
- 不显示 Issue ID、title、author、catalogId、原始 JSON、cache/request 信息。
- `actual` / `expected` 仅渲染安全数值或模型暴露的字符串。

## NOT_APPLICABLE

- 当前 Archive 不暴露多年重复书目的逐年度 rank 映射。
- 因此 `recurring_best_rank_mismatch` / `recurring_latest_rank_mismatch` 在模型当前联合类型下不产生 Issue。
- 面板底部固定说明：`当前多年重复书目数据没有逐年度排名映射，因此无法独立重算最佳排名或核对最近年份对应排名。审计模型不会为缺失字段推测结果。`
- 不显示内部 IssueCode 名称。

## HOOK_ORDER_REGRESSION

- Audit Panel：零 Hook（无 useMemo / useState / useEffect / useReducer / useRef / useLayoutEffect / useInsertionEffect）。
- Dashboard：插入前后未新增任何 Hook；插入位置在 `if (!active) return` 之后但**没有引入新的 Hook 调用**。
- `active` 切换（inactive → active → inactive → active）下 Hook 身份稳定。
- React error #300 / "Rendered fewer/more hooks" 真实渲染（`renderToStaticMarkup`）0 命中。
- 既有 Hook-order 回归测试套件继续 PASS。

## STATE_MACHINE_RESULT

- `useReadingArchiveMachine` Hook / reducer / controller / fetch 实现未改动。
- 面板 props 直接读取：`dashboardArchive` / `archive.visibleYears` / `failedYears` / `topBooks` / `bootstrapLoading`。
- 未新增 `fetchWereadAnnualReview` 调用，未触发额外并发。
- 未引入新 Hook / ref / state；面板为纯渲染层。
- Range 切换后 `archive.visibleYears` 自动更新，面板随之重算。
- Top N 切换后面板随 `topBooksLimit` 自动重算。
- Retry 失败年份后面板随 `failedYears` 自动重算。

## PRIVACY_RESULT

- 面板 props 仅包含聚合安全字段（archive / 目标 / 失败 / Top N / loading）。
- Issue 卡片仅渲染 `year` / `fromYear` / `toYear` / `itemIndex` / `rank` / `actual` / `expected` 七个安全定位字段。
- 安全扫描结果：
  - `note.text` / `note.comment` / `markedText` / `wereadBookId` / `noteId` / `highlightId` / `chapterTitle` / `Authorization` / `token=` / `fetchWereadAnnualReview` / `fetchWereadAiSummary` / `fetchWereadRelatedBooks` / `localStorage` / `sessionStorage` / `indexedDB` / `pushState` / `replaceState` / `dangerouslySetInnerHTML` / `innerHTML`：0 实际代码命中（仅文档注释内提及）。
  - `更爱阅读|兴趣增强|兴趣减弱|能力提升|能力下降|阅读质量|心理状态|人格|成长|退步|低谷|巅峰|用户评分|优秀|较差`：0 命中。

## TEST_RESULT

| 项目 | 结果 |
|------|------|
| Panel vitest | 72 / 72 PASS（新增，含行为 + 结构 + 隐私 + 钩子顺序） |
| S27Q-1 Audit Model | 105 / 105 PASS（维持） |
| Dashboard test | 107 / 107 PASS（含 S27Q-2 集成 12 项） |
| WereadCenter test | 10 / 10 PASS |
| full vitest | 2425 / 2425 PASS（74 files，30.02s） |
| web tsc | exit 0（无任何输出） |
| web vite build | success（dist/index.html + dist/assets/） |
| React error #300 | 0 |
| Hook-order warning | 0 |

## PRODUCT_BOUNDARY

- `apps/api` / `package.json` / `pnpm-lock.yaml` / `apps/web/Dockerfile` / `docker-compose.yml` diff 全部为空。
- 禁止提交路径（`progress` / `apps/web/dist` / `reports/screenshots` / `private-data` / `.env` / `logs`）均未在工作树出现。
- 不部署、不打 tag、不更新 README。

## KNOWN_LIMITATIONS

- 仅审计当前浏览器已加载的档案。
- 失败年份（failedYears）的内容无法审计。
- 不与源服务器重新对账，不审计原始笔记。
- 不自动修复异常，仅暴露 issue。
- Recurring Books 当前 Archive 未暴露逐年度 rank，因此最佳排名 / 最近年份排名核对不可独立重算（标记为 NOT_APPLICABLE）。
- 所有比例是覆盖与一致性指标，不评价用户行为。

## NEXT_STEP

S27Q-3 — Browser-local Data Quality Audit Markdown Export