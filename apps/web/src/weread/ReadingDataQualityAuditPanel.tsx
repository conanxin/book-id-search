/**
 * S27Q-2 — Reading Data Quality Audit Panel (Dashboard, zero-hook).
 *
 * Renders an audit panel summarising the coverage, consistency,
 * and integrity of the currently loaded WeRead long-term archive.
 *
 * Hard constraints (re-checked by tests):
 *   - Zero hook calls (no useMemo / useState / useEffect / useReducer
 *     / useRef). The pure audit function is invoked directly so the
 *     panel is a thin presentational layer over the model.
 *   - No network, no AI, no related-books, no annual-review fetch,
 *     no storage, no URL mutation, no dangerouslySetInnerHTML.
 *   - Issue labels are mapped exhaustively via
 *     `satisfies Record<ReadingDataQualityIssueCode, string>`; any
 *     drift between the model union and the label table is a
 *     compile-time error.
 *   - Scope labels are mapped exhaustively via
 *     `satisfies Record<ReadingDataQualityScope, string>`.
 *   - The panel never displays Issue IDs, catalogId, title, author,
 *     raw archive, raw JSON, or any private identifier. Only the
 *     structural fields surfaced by the audit are rendered.
 *   - Status wording is neutral. Pass / warn / fail describe data
 *     coverage and consistency only; no user-evaluation language.
 */

import {
  buildWereadReadingDataQualityAudit,
  type ReadingDataQualityIssue,
  type ReadingDataQualityIssueCode,
  type ReadingDataQualityScope,
  type ReadingDataQualityStatus,
} from "./wereadReadingDataQualityAudit";
import type { WereadReadingArchive } from "./wereadReadingArchiveModel";
import ReadingDataQualityAuditExportAction from "./ReadingDataQualityAuditExportAction";

// ---------- props ----------

export interface ReadingDataQualityAuditPanelProps {
  archive: WereadReadingArchive;
  targetYears: number[];
  failedYears: number[];
  topBooksLimit: 6 | 12 | 18;
  bootstrapLoading: boolean;
  rangeLabel: string;
}

// ---------- exhaustive label tables ----------

const ISSUE_LABELS = {
  empty_archive: "当前没有成功加载的年度档案",
  partial_archive: "部分目标年份暂时加载失败",
  target_year_unaccounted: "目标年份尚未闭合",
  loaded_failed_conflict: "同一年同时出现在成功和失败集合",
  duplicate_loaded_year: "成功加载年份存在重复",
  invalid_year: "年份值不合法",
  non_finite_metric: "年度指标不是有限数值",
  negative_metric: "年度指标为负数",
  dated_records_exceed_total: "有效日期记录超过阅读记录",
  matched_records_exceed_total: "已匹配记录超过阅读记录",
  matched_books_exceed_matched_records: "年度书目数量超过已匹配记录",
  active_months_out_of_range: "活跃月份超出允许范围",
  streak_months_out_of_range: "连续活跃月份超出允许范围",
  streak_exceeds_active_months: "连续活跃月份超过活跃月份",
  peak_month_year_mismatch: "高峰月份与年度不一致",
  top_books_exceed_limit: "Top N 数量超过允许上限",
  top_book_missing_catalog: "Top N 缺少公共 catalog 标识",
  top_book_duplicate_catalog: "Top N 同一 catalog 重复出现",
  top_book_missing_title: "Top N 缺少公共书名",
  top_book_invalid_rank: "Top N 排名值不合法",
  top_book_duplicate_rank: "Top N 同一排名重复出现",
  top_book_records_exceed_year_total: "Top N 记录超过年度阅读记录",
  top_book_order_mismatch: "Top N 排序与预期不一致",
  year_link_unknown_year: "相邻年度链接包含未知年份",
  year_link_invalid_order: "相邻年度链接顺序不合法",
  year_link_duplicate_pair: "相邻年度链接存在重复 pair",
  year_link_invalid_counts: "相邻年度共同上榜数量不合法",
  year_link_ratio_out_of_range: "相邻年度重合率超出 [0,1]",
  year_link_ratio_mismatch: "相邻年度重合率与共同上榜数量不一致",
  missing_year_link: "缺少应存在的相邻年度链接",
  recurring_duplicate_catalog: "多年重复书目存在重复 catalog",
  recurring_appearance_count_mismatch: "多年重复书目出现年份数与列表不一致",
  recurring_unknown_year: "多年重复书目包含未加载年份",
  recurring_duplicate_year: "多年重复书目年份列表存在重复",
  recurring_invalid_rank: "多年重复书目排名值不合法",
  recurring_latest_year_mismatch: "多年重复书目最新年份不在年份列表内",
} satisfies Record<ReadingDataQualityIssueCode, string>;

const SCOPE_LABELS = {
  archive: "长期档案",
  coverage: "年份覆盖",
  year: "年度指标",
  top_book: "年度 Top N",
  year_link: "相邻年度链接",
  recurring_book: "多年重复书目聚合",
} satisfies Record<ReadingDataQualityScope, string>;

const STATUS_LABELS: Record<ReadingDataQualityStatus, string> = {
  pass: "数据审计通过",
  warn: "数据部分需注意",
  fail: "存在数据一致性错误",
};

const SEVERITY_LABELS: Record<"error" | "warning" | "info", string> = {
  error: "错误",
  warning: "警告",
  info: "信息",
};

const SEVERITY_ORDER: ReadonlyArray<"error" | "warning" | "info"> = [
  "error",
  "warning",
  "info",
];

const RATIO_DESCRIPTIONS = {
  accounted: "已加载或已标记失败的目标年份 / 目标年份",
  dated: "有效日期记录 / 阅读记录",
  matched: "已匹配记录 / 阅读记录",
  metadata:
    "同时具有公共标识和公共名称的 Top N 项 / Top N 总项",
  yearLink: "合法期望相邻 pair / 期望相邻 pair",
} as const;

const NOT_APPLICABLE_NOTE =
  "当前多年重复书目数据没有逐年度排名映射，因此无法独立重算最佳排名或核对最近年份对应排名。审计模型不会为缺失字段推测结果。";

// ---------- helpers (pure) ----------

function isFiniteRatio(value: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function formatRatio(value: number): string {
  if (!isFiniteRatio(value)) return "—";
  if (value >= 0.9999) return "100%";
  const pct = Math.round(value * 1000) / 10;
  return `${pct.toFixed(1)}%`;
}

function describeStatus(status: ReadingDataQualityStatus): string {
  return STATUS_LABELS[status] ?? status;
}

function describeSeverity(severity: "error" | "warning" | "info"): string {
  return SEVERITY_LABELS[severity];
}

function describeScope(scope: ReadingDataQualityScope): string {
  return SCOPE_LABELS[scope] ?? scope;
}

function describeYear(year: number): string {
  return `${year} 年`;
}

function joinYearList(values: readonly number[], emptyPlaceholder: string): string {
  if (values.length === 0) return emptyPlaceholder;
  return values.map((y) => `${y}`).join("、");
}

function isLocationProvided<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

function formatYearRange(fromYear: number, toYear: number): string {
  return `${fromYear} → ${toYear}`;
}

// ---------- component ----------

export default function ReadingDataQualityAuditPanel({
  archive,
  targetYears,
  failedYears,
  topBooksLimit,
  bootstrapLoading,
  rangeLabel,
}: ReadingDataQualityAuditPanelProps) {
  // Pure model call — no hooks. Re-runs on every render with stable
  // deterministic output.
  const audit = buildWereadReadingDataQualityAudit({
    archive,
    targetYears,
    failedYears,
    topBooksLimit,
  });

  const status = audit.status;
  const summary = audit.summary;
  const coverage = audit.coverage;
  const issues = audit.issues;
  const statusLabel = describeStatus(status);

  const isEmptyTarget = coverage.targetYears.length === 0 && archive.years.length === 0;
  const isLoadingShell =
    bootstrapLoading && archive.years.length === 0;

  // Group issues by severity in a fixed order.
  const issuesBySeverity: Record<"error" | "warning" | "info", ReadingDataQualityIssue[]> = {
    error: [],
    warning: [],
    info: [],
  };
  for (const issue of issues) {
    issuesBySeverity[issue.severity].push(issue);
  }

  const accountedRatio = summary.accountedRatio;
  const datedRatio = summary.datedRecordRatio;
  const matchedRatio = summary.matchedRecordRatio;
  const metadataRatio = summary.publicTopBookMetadataRatio;
  const yearLinkRatio = summary.yearLinkCoverageRatio;

  const hasNoIssues = issues.length === 0;

  return (
    <section
      className="weread-reading-data-quality"
      data-testid="weread-reading-data-quality"
      data-status={status}
      data-target-years={coverage.targetYears.length}
      data-loaded-years={coverage.loadedYears.length}
      data-failed-years={coverage.failedYears.length}
      aria-label="长期档案数据质量审计"
    >
      <header className="weread-reading-data-quality__header">
        <h3>长期档案数据质量审计</h3>
        <p
          className="weread-reading-data-quality__notice"
          data-testid="weread-reading-data-quality-notice"
        >
          审计只检查当前已加载档案的数据覆盖、数值合法性和字段一致性，不评价阅读行为，也不会自动修改数据。
        </p>
      </header>

      {isLoadingShell ? (
        <p
          className="weread-reading-data-quality__loading"
          data-testid="weread-reading-data-quality-loading"
        >
          正在整理当前已加载的年度档案……
        </p>
      ) : null}

      {isEmptyTarget ? (
        <p
          className="weread-reading-data-quality__empty"
          data-testid="weread-reading-data-quality-empty"
        >
          当前没有需要审计的目标年份或年度档案。
        </p>
      ) : null}

      {!isLoadingShell && !isEmptyTarget ? (
        <>
          <div
            className={`weread-reading-data-quality__status weread-reading-data-quality__status--${status}`}
            data-testid="weread-reading-data-quality-status"
            data-status={status}
            aria-label={`审计状态：${statusLabel}`}
          >
            <span className="weread-reading-data-quality__status-label">审计状态</span>
            <span className="weread-reading-data-quality__status-value">{statusLabel}</span>
          </div>

          <dl
            className="weread-reading-data-quality__summary"
            data-testid="weread-reading-data-quality-summary"
          >
            <div className="weread-reading-data-quality__summary-cell">
              <dt>当前目标年份</dt>
              <dd data-testid="weread-reading-data-quality-target-count">
                {formatNumber(summary.targetYearCount)}
              </dd>
            </div>
            <div className="weread-reading-data-quality__summary-cell">
              <dt>成功加载年份</dt>
              <dd data-testid="weread-reading-data-quality-loaded-count">
                {formatNumber(summary.loadedYearCount)}
              </dd>
            </div>
            <div className="weread-reading-data-quality__summary-cell">
              <dt>暂时失败年份</dt>
              <dd data-testid="weread-reading-data-quality-failed-count">
                {formatNumber(summary.failedYearCount)}
              </dd>
            </div>
            <div className="weread-reading-data-quality__summary-cell">
              <dt>未闭合年份</dt>
              <dd data-testid="weread-reading-data-quality-unaccounted-count">
                {formatNumber(summary.unaccountedYearCount)}
              </dd>
            </div>
            <div className="weread-reading-data-quality__summary-cell">
              <dt>当前 Top N 口径</dt>
              <dd data-testid="weread-reading-data-quality-top-books">
                Top {topBooksLimit}
              </dd>
            </div>
            <div className="weread-reading-data-quality__summary-cell">
              <dt>审计状态</dt>
              <dd data-testid="weread-reading-data-quality-status-text">
                {statusLabel}
              </dd>
            </div>
            <div className="weread-reading-data-quality__summary-cell">
              <dt>错误</dt>
              <dd data-testid="weread-reading-data-quality-error-count">
                {formatNumber(summary.errorCount)}
              </dd>
            </div>
            <div className="weread-reading-data-quality__summary-cell">
              <dt>警告</dt>
              <dd data-testid="weread-reading-data-quality-warning-count">
                {formatNumber(summary.warningCount)}
              </dd>
            </div>
            <div className="weread-reading-data-quality__summary-cell">
              <dt>信息</dt>
              <dd data-testid="weread-reading-data-quality-info-count">
                {formatNumber(summary.infoCount)}
              </dd>
            </div>
          </dl>

          <section
            className="weread-reading-data-quality__coverage"
            data-testid="weread-reading-data-quality-coverage"
            aria-label="年份覆盖"
          >
            <h4>年份覆盖</h4>
            <dl className="weread-reading-data-quality__coverage-stats">
              <div>
                <dt>目标年份数量</dt>
                <dd data-testid="weread-reading-data-quality-target-count-stat">
                  {formatNumber(summary.targetYearCount)}
                </dd>
              </div>
              <div>
                <dt>成功加载年份数量</dt>
                <dd data-testid="weread-reading-data-quality-loaded-count-stat">
                  {formatNumber(summary.loadedYearCount)}
                </dd>
              </div>
              <div>
                <dt>暂时失败年份数量</dt>
                <dd data-testid="weread-reading-data-quality-failed-count-stat">
                  {formatNumber(summary.failedYearCount)}
                </dd>
              </div>
              <div>
                <dt>未闭合年份数量</dt>
                <dd data-testid="weread-reading-data-quality-unaccounted-count-stat">
                  {formatNumber(summary.unaccountedYearCount)}
                </dd>
              </div>
              <div>
                <dt>额外加载年份数量</dt>
                <dd data-testid="weread-reading-data-quality-unexpected-loaded-count">
                  {formatNumber(coverage.unexpectedLoadedYears.length)}
                </dd>
              </div>
              <div>
                <dt>年份闭合比例</dt>
                <dd data-testid="weread-reading-data-quality-accounted-ratio">
                  {formatRatio(accountedRatio)}
                </dd>
              </div>
            </dl>

            <section
              className="weread-reading-data-quality__year-list"
              data-testid="weread-reading-data-quality-loaded-years"
              aria-label="成功加载年份"
            >
              <h5>成功加载年份</h5>
              <p data-testid="weread-reading-data-quality-loaded-years-list">
                {joinYearList(coverage.loadedYears, "—")}
              </p>
            </section>

            <section
              className="weread-reading-data-quality__year-list"
              data-testid="weread-reading-data-quality-failed-years"
              aria-label="暂时失败年份"
            >
              <h5>暂时失败年份</h5>
              <p data-testid="weread-reading-data-quality-failed-years-list">
                {joinYearList(coverage.failedYears, "—")}
              </p>
            </section>

            <section
              className="weread-reading-data-quality__year-list"
              data-testid="weread-reading-data-quality-unaccounted-years"
              aria-label="未闭合年份"
            >
              <h5>未闭合年份</h5>
              <p
                className="weread-reading-data-quality__year-list-hint"
                data-testid="weread-reading-data-quality-unaccounted-years-hint"
              >
                既未成功加载，也未被标记为暂时失败的目标年份。
              </p>
              <p data-testid="weread-reading-data-quality-unaccounted-years-list">
                {joinYearList(coverage.unaccountedYears, "—")}
              </p>
            </section>

            <section
              className="weread-reading-data-quality__year-list"
              data-testid="weread-reading-data-quality-unexpected-loaded-years"
              aria-label="额外加载年份"
            >
              <h5>额外加载年份</h5>
              <p
                className="weread-reading-data-quality__year-list-hint"
                data-testid="weread-reading-data-quality-unexpected-loaded-years-hint"
              >
                已加载但不属于当前目标范围的年份，仅计入审计摘要，不自动判错。
              </p>
              <p data-testid="weread-reading-data-quality-unexpected-loaded-years-list">
                {joinYearList(coverage.unexpectedLoadedYears, "—")}
              </p>
            </section>
          </section>

          <section
            className="weread-reading-data-quality__ratios"
            data-testid="weread-reading-data-quality-ratios"
            aria-label="数据覆盖指标"
          >
            <h4>数据覆盖指标</h4>
            <p
              className="weread-reading-data-quality__ratio-note"
              data-testid="weread-reading-data-quality-ratio-note"
            >
              这些比例用于描述数据覆盖和可核对程度，不评价阅读行为。
            </p>
            <ul className="weread-reading-data-quality__ratio-grid">
              <li
                className="weread-reading-data-quality__ratio"
                data-testid="weread-reading-data-quality-ratio-accounted"
              >
                <span className="weread-reading-data-quality__ratio-label">年份闭合比例</span>
                <span className="weread-reading-data-quality__ratio-value">
                  {formatRatio(accountedRatio)}
                </span>
                <span className="weread-reading-data-quality__ratio-desc">
                  {RATIO_DESCRIPTIONS.accounted}
                </span>
              </li>
              <li
                className="weread-reading-data-quality__ratio"
                data-testid="weread-reading-data-quality-ratio-dated"
              >
                <span className="weread-reading-data-quality__ratio-label">有效日期记录占比</span>
                <span className="weread-reading-data-quality__ratio-value">
                  {formatRatio(datedRatio)}
                </span>
                <span className="weread-reading-data-quality__ratio-desc">
                  {RATIO_DESCRIPTIONS.dated}
                </span>
              </li>
              <li
                className="weread-reading-data-quality__ratio"
                data-testid="weread-reading-data-quality-ratio-matched"
              >
                <span className="weread-reading-data-quality__ratio-label">已匹配记录占比</span>
                <span className="weread-reading-data-quality__ratio-value">
                  {formatRatio(matchedRatio)}
                </span>
                <span className="weread-reading-data-quality__ratio-desc">
                  {RATIO_DESCRIPTIONS.matched}
                </span>
              </li>
              <li
                className="weread-reading-data-quality__ratio"
                data-testid="weread-reading-data-quality-ratio-metadata"
              >
                <span className="weread-reading-data-quality__ratio-label">Top N 公共元数据完整比例</span>
                <span className="weread-reading-data-quality__ratio-value">
                  {formatRatio(metadataRatio)}
                </span>
                <span className="weread-reading-data-quality__ratio-desc">
                  {RATIO_DESCRIPTIONS.metadata}
                </span>
              </li>
              <li
                className="weread-reading-data-quality__ratio"
                data-testid="weread-reading-data-quality-ratio-year-link"
              >
                <span className="weread-reading-data-quality__ratio-label">相邻年度链接覆盖比例</span>
                <span className="weread-reading-data-quality__ratio-value">
                  {formatRatio(yearLinkRatio)}
                </span>
                <span className="weread-reading-data-quality__ratio-desc">
                  {RATIO_DESCRIPTIONS.yearLink}
                </span>
              </li>
            </ul>
          </section>

          <section
            className="weread-reading-data-quality__issues"
            data-testid="weread-reading-data-quality-issues"
            aria-label="审计问题"
          >
            <h4>审计问题</h4>
            {hasNoIssues ? (
              <p
                className="weread-reading-data-quality__issues-pass"
                data-testid="weread-reading-data-quality-issues-pass"
              >
                当前已加载档案未发现数据一致性错误或警告。
              </p>
            ) : null}
            {SEVERITY_ORDER.map((severity) => {
              const list = issuesBySeverity[severity];
              const groupKey = severity;
              return (
                <section
                  key={groupKey}
                  className={`weread-reading-data-quality__issue-group weread-reading-data-quality__issue-group--${severity}`}
                  data-testid={`weread-reading-data-quality-issue-group-${severity}`}
                  data-severity={severity}
                  aria-label={`${describeSeverity(severity)}级别问题`}
                >
                  <h5>{describeSeverity(severity)}</h5>
                  {list.length === 0 ? (
                    <p
                      className="weread-reading-data-quality__empty"
                      data-testid={`weread-reading-data-quality-issue-group-${severity}-empty`}
                    >
                      当前没有此级别的问题。
                    </p>
                  ) : (
                    <ul className="weread-reading-data-quality__issue-list">
                      {list.map((issue) => (
                        <IssueCard
                          key={issue.id}
                          issue={issue}
                          severity={severity}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              );
            })}
          </section>
        </>
      ) : null}

      <ReadingDataQualityAuditExportAction
        audit={audit}
        rangeLabel={rangeLabel}
        topBooksLimit={topBooksLimit}
        bootstrapLoading={bootstrapLoading}
      />

      <p
        className="weread-reading-data-quality__limitation"
        data-testid="weread-reading-data-quality-limitation"
      >
        {NOT_APPLICABLE_NOTE}
      </p>
    </section>
  );
}

// ---------- internal: issue card ----------

interface IssueCardProps {
  issue: ReadingDataQualityIssue;
  severity: "error" | "warning" | "info";
}

function IssueCard({ issue, severity }: IssueCardProps) {
  const code = issue.code;
  const label = ISSUE_LABELS[code] ?? code;
  const scope = describeScope(issue.scope);
  const { year, fromYear, toYear, itemIndex, rank, actual, expected } = issue;
  const hasYear = isLocationProvided(year);
  const hasFromYear = isLocationProvided(fromYear);
  const hasToYear = isLocationProvided(toYear);
  const hasItemIndex = isLocationProvided(itemIndex);
  const hasRank = isLocationProvided(rank);
  const hasActual = isLocationProvided(actual);
  const hasExpected = isLocationProvided(expected);

  // The audit never produces both `year` and a pair, but the model
  // exposes all three slots. We render whichever subset is present.
  const showYearPair = hasFromYear && hasToYear && !hasYear;

  return (
    <article
      className={`weread-reading-data-quality__issue weread-reading-data-quality__issue--${severity}`}
      data-severity={severity}
      data-code={code}
      data-testid={`weread-reading-data-quality-issue-${code}`}
    >
      <div className="weread-reading-data-quality__issue-head">
        <span className="weread-reading-data-quality__issue-label">{label}</span>
        <span className="weread-reading-data-quality__issue-scope">{scope}</span>
      </div>
      <dl className="weread-reading-data-quality__issue-meta">
        {hasYear ? (
          <div>
            <dt>年份</dt>
            <dd>{describeYear(year)}</dd>
          </div>
        ) : null}
        {showYearPair ? (
          <div>
            <dt>年份范围</dt>
            <dd>{formatYearRange(fromYear, toYear)}</dd>
          </div>
        ) : null}
        {hasFromYear && hasToYear && hasYear ? (
          <div>
            <dt>年份范围</dt>
            <dd>{formatYearRange(fromYear, toYear)}</dd>
          </div>
        ) : null}
        {hasItemIndex ? (
          <div>
            <dt>项目位置</dt>
            <dd>第 {itemIndex + 1} 项</dd>
          </div>
        ) : null}
        {hasRank ? (
          <div>
            <dt>排名值</dt>
            <dd>{formatNumber(rank)}</dd>
          </div>
        ) : null}
        {hasActual ? (
          <div>
            <dt>实际值</dt>
            <dd>
              {typeof actual === "number"
                ? formatNumber(actual)
                : String(actual)}
            </dd>
          </div>
        ) : null}
        {hasExpected ? (
          <div>
            <dt>期望值</dt>
            <dd>
              {typeof expected === "number"
                ? formatNumber(expected)
                : String(expected)}
            </dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}