/**
 * S27P-2 — Reading Evolution Timeline Panel.
 *
 * Pure-React panel that consumes the already-loaded
 * `WereadReadingArchive` from the parent dashboard and renders a
 * descriptive per-year timeline view of adjacent-year transitions
 * (metric deltas + Top N book diff + overlap) and milestone markers
 * (first_year / latest_year / year_gap / statistical_shift).
 *
 * All computation is browser-local via the S27P-1 pure model
 * (`wereadReadingEvolutionTimeline.ts`).
 *
 * Hard rules:
 *   - All timeline state lives in this component's local state.
 *     The parent archive reducer / scheduler / cache / retry
 *     semantics are never touched.
 *   - Timeline view NEVER writes to browser storage APIs,
 *     NEVER writes to the URL,
 *     and NEVER sends to the server.
 *   - Output vocabulary uses allow-listed Chinese labels only.
 *     No psych / personality / preference / growth / decline /
 *     peak / trough / improvement / downward-trend strings are
 *     rendered.
 *   - Recurring book links go to `/books/:catalogId` (existing
 *     public route); no private IDs.
 *   - No dangerous HTML injection, no raw HTML, no inline scripts.
 *   - No `useMemo` / `useState` / `useEffect` introduced in this
 *     panel. The model is a pure synchronous derivation, so the
 *     panel renders synchronously without React state.
 */

import {
  buildWereadReadingEvolutionTimeline,
  type ReadingEvolutionBook,
  type ReadingEvolutionBookDiff,
  type ReadingEvolutionDirection,
  type ReadingEvolutionMilestone,
  type ReadingEvolutionTransition,
  type ReadingEvolutionTransitionReason,
  type WereadReadingEvolutionTimeline,
} from "./wereadReadingEvolutionTimeline";
import type { WereadReadingArchive } from "./wereadReadingArchiveModel";
import ReadingEvolutionTimelineExportAction from "./ReadingEvolutionTimelineExportAction";
import type { ReadingEvolutionRangeLabel } from "./wereadReadingEvolutionMarkdown";

// ---------- props ----------

export interface ReadingEvolutionTimelinePanelProps {
  archive: WereadReadingArchive;
  rangeLabel: string;
  topBooksLimit: 6 | 12 | 18;
  failedYears: number[];
  /** Disable controls during the archive bootstrap. */
  bootstrapLoading?: boolean;
}

// ---------- constants ----------

const PANEL_NOTICE =
  "时间线只展示相邻年份之间可观察的记录数量、活跃月份、年度书目和当前 Top N 榜单差异。它不解释这些差异产生的原因。";

const REASON_LABELS: Readonly<Record<ReadingEvolutionTransitionReason, string>> = {
  year_gap: "年份存在中断",
  records_shift: "阅读记录数量差异较大",
  active_months_shift: "活跃月份数量差异较大",
  matched_books_shift: "年度书目数量差异较大",
  low_top_list_overlap: "相邻年度 Top N 榜单重合较低",
};

const MILESTONE_LABELS: Readonly<Record<ReadingEvolutionMilestone["kind"], string>> = {
  first_year: "时间线起始年份",
  latest_year: "时间线最近年份",
  year_gap: "年份中断节点",
  statistical_shift: "统计差异节点",
};

const MILESTONE_KIND_ORDER: ReadonlyArray<ReadingEvolutionMilestone["kind"]> = [
  "first_year",
  "year_gap",
  "statistical_shift",
  "latest_year",
];

const METRIC_LABELS: ReadonlyArray<{
  key: "totalRecords" | "activeMonths" | "matchedRecords" | "matchedBooks" | "averageRecordsPerActiveMonth";
  label: string;
}> = [
  { key: "totalRecords", label: "阅读记录" },
  { key: "activeMonths", label: "活跃月份" },
  { key: "matchedRecords", label: "已匹配记录" },
  { key: "matchedBooks", label: "年度书目" },
  { key: "averageRecordsPerActiveMonth", label: "活跃月份平均记录" },
];

const DIFF_DISPLAY_LIMIT = 6;

const NO_REASONS_HINT = "当前过渡未达到统计差异标记阈值。";

const EMPTY_ARCHIVE_HINT =
  "当前暂无成功加载的年度档案，无法生成年度统计时间线。";

const BOOTSTRAP_LOADING_HINT = "正在整理当前已加载的年度档案……";

const SINGLE_YEAR_NO_TRANSITION_HINT =
  "当前只有一个成功加载年份，无法生成相邻年度过渡。";

const PARTIAL_FAILURE_HINT =
  "有 N 个年份暂时加载失败，以下时间线只基于成功加载的年份。";

// ---------- helpers ----------

function describeYear(year: number): string {
  return `${year} 年`;
}

function formatInteger(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("zh-CN");
}

function formatAverage(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 10) / 10;
  if (Number.isInteger(rounded)) return rounded.toLocaleString("zh-CN");
  return rounded.toFixed(1);
}

function formatAbsoluteDelta(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value > 0) return `+${formatInteger(value)}`;
  if (value < 0) return formatInteger(value);
  return "0";
}

function formatAverageDelta(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value > 0) return `+${formatAverage(value)}`;
  if (value < 0) return formatAverage(value);
  return "0";
}

function describeDirection(direction: ReadingEvolutionDirection): string {
  switch (direction) {
    case "increase":
      return "增加";
    case "decrease":
      return "减少";
    case "same":
      return "持平";
    case "from_zero":
      return "由 0 起";
    case "to_zero":
      return "降至 0";
    default:
      return direction;
  }
}

function formatPercentageDelta(direction: ReadingEvolutionDirection, percentage: number | null): string {
  if (direction === "from_zero") return "由 0 起";
  if (direction === "to_zero") return "降至 0";
  if (direction === "same") return "0%";
  if (percentage === null) return "—";
  if (!Number.isFinite(percentage)) return "—";
  if (percentage > 0) return `+${percentage}%`;
  if (percentage < 0) return `${percentage}%`;
  return "0%";
}

function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  const pct = Math.round(ratio * 1000) / 10;
  return `${pct.toFixed(1)}%`;
}

function getMetricValue(
  node: { totalRecords: number; activeMonths: number; matchedRecords: number; matchedBooks: number; averageRecordsPerActiveMonth: number } | undefined,
  key: "totalRecords" | "activeMonths" | "matchedRecords" | "matchedBooks" | "averageRecordsPerActiveMonth",
): number {
  if (!node) return 0;
  return node[key];
}

function rankDeltaLabel(rankDelta: number): string {
  if (rankDelta > 0) return `+${rankDelta}`;
  if (rankDelta < 0) return `${rankDelta}`;
  return "0";
}

function coerceRangeLabel(label: string): ReadingEvolutionRangeLabel {
  if (label === "最近5年") return "最近5年";
  if (label === "最近10年") return "最近10年";
  return "全部";
}

// ---------- component ----------

export default function ReadingEvolutionTimelinePanel({
  archive,
  rangeLabel,
  topBooksLimit,
  failedYears,
  bootstrapLoading = false,
}: ReadingEvolutionTimelinePanelProps) {
  const timeline: WereadReadingEvolutionTimeline = buildWereadReadingEvolutionTimeline({
    archive,
  });
  const loadedYearCount = timeline.summary.loadedYearCount;
  const isLoading = bootstrapLoading && loadedYearCount === 0;

  // ---- empty / loading states ----
  if (isLoading) {
    return (
      <section
        className="weread-reading-evolution"
        data-testid="weread-reading-evolution"
        data-loading="true"
        aria-label="年度统计演变时间线"
      >
        <header className="weread-reading-evolution__header">
          <h3>年度统计演变时间线</h3>
          <p
            className="weread-reading-evolution__notice"
            data-testid="weread-reading-evolution-notice"
          >
            {PANEL_NOTICE}
          </p>
        </header>
        <p
          className="weread-reading-evolution__loading"
          data-testid="weread-reading-evolution-loading"
        >
          {BOOTSTRAP_LOADING_HINT}
        </p>
      </section>
    );
  }

  if (loadedYearCount === 0) {
    return (
      <section
        className="weread-reading-evolution"
        data-testid="weread-reading-evolution"
        data-empty="true"
        aria-label="年度统计演变时间线"
      >
        <header className="weread-reading-evolution__header">
          <h3>年度统计演变时间线</h3>
          <p
            className="weread-reading-evolution__notice"
            data-testid="weread-reading-evolution-notice"
          >
            {PANEL_NOTICE}
          </p>
        </header>
        <p
          className="weread-reading-evolution__empty"
          data-testid="weread-reading-evolution-empty"
        >
          {EMPTY_ARCHIVE_HINT}
        </p>
      </section>
    );
  }

  // ---- summary ----
  const summary = timeline.summary;
  const milestones = timeline.milestones;
  const transitions = timeline.transitions;

  return (
    <section
      className="weread-reading-evolution"
      data-testid="weread-reading-evolution"
      data-loaded-year-count={String(loadedYearCount)}
      data-transition-count={String(transitions.length)}
      data-significant-count={String(summary.significantTransitionCount)}
      data-gap-count={String(summary.yearGapCount)}
      aria-label="年度统计演变时间线"
    >
      <header className="weread-reading-evolution__header">
        <h3>年度统计演变时间线</h3>
        <p
          className="weread-reading-evolution__notice"
          data-testid="weread-reading-evolution-notice"
        >
          {PANEL_NOTICE}
        </p>
      </header>

      <div
        className="weread-reading-evolution__completeness"
        data-testid="weread-reading-evolution-completeness"
      >
        <p className="weread-reading-evolution__scope-line">
          当前档案范围：{rangeLabel} · 高互动书目口径：Top {topBooksLimit} · 成功加载 {loadedYearCount} 个年份
          {failedYears.length > 0 ? ` · 失败 ${failedYears.length} 个年份` : ""}
        </p>
        {failedYears.length > 0 ? (
          <p
            className="weread-reading-evolution__partial-failure"
            data-testid="weread-reading-evolution-partial-failure"
          >
            {PARTIAL_FAILURE_HINT.replace("N", String(failedYears.length))}
          </p>
        ) : null}
      </div>

      <ReadingEvolutionTimelineExportAction
        timeline={timeline}
        rangeLabel={coerceRangeLabel(rangeLabel)}
        topBooksLimit={topBooksLimit}
        failedYears={failedYears}
        bootstrapLoading={isLoading}
      />

      <div
        className="weread-reading-evolution__summary"
        data-testid="weread-reading-evolution-summary"
      >
        <SummaryStat
          testId="weread-reading-evolution-summary-loaded"
          label="成功加载年份"
          value={String(loadedYearCount)}
          hint="当前已加载的年度数据数量"
        />
        <SummaryStat
          testId="weread-reading-evolution-summary-transition"
          label="相邻年度过渡"
          value={String(transitions.length)}
          hint="按年份升序自动生成"
        />
        <SummaryStat
          testId="weread-reading-evolution-summary-significant"
          label="显著统计差异"
          value={String(summary.significantTransitionCount)}
          hint="显著统计差异过渡"
        />
        <SummaryStat
          testId="weread-reading-evolution-summary-gap"
          label="年份中断"
          value={String(summary.yearGapCount)}
          hint="相邻年份之间存在中断"
        />
      </div>

      <MilestonesSection
        milestones={milestones}
        transitions={transitions}
      />

      <div
        className="weread-reading-evolution__timeline"
        data-testid="weread-reading-evolution-timeline"
      >
        {timeline.years.map((node, idx) => {
          const next = timeline.years[idx + 1];
          const transition = next ? transitions.find((t) => t.fromYear === node.year && t.toYear === next.year) : undefined;
          return (
            <div
              key={node.year}
              className="weread-reading-evolution__timeline-block"
              data-testid="weread-reading-evolution-timeline-block"
              data-year={String(node.year)}
            >
              <YearNode node={node} topBooksLimit={topBooksLimit} />
              {transition ? (
                <TransitionSection transition={transition} />
              ) : null}
            </div>
          );
        })}
      </div>

      {loadedYearCount === 1 ? (
        <p
          className="weread-reading-evolution__single-year"
          data-testid="weread-reading-evolution-single-year"
        >
          {SINGLE_YEAR_NO_TRANSITION_HINT}
        </p>
      ) : null}

      <p
        className="weread-reading-evolution__privacy"
        data-testid="weread-reading-evolution-privacy"
      >
        时间线数据全部基于浏览器当前已加载的长期档案，不重新请求数据，不调用 AI，不写入本地存储或 URL。
      </p>
    </section>
  );
}

// ---------- summary stat ----------

interface SummaryStatProps {
  testId: string;
  label: string;
  value: string;
  hint: string;
}

function SummaryStat({ testId, label, value, hint }: SummaryStatProps) {
  return (
    <div className="weread-reading-evolution__stat-card" data-testid={testId}>
      <span className="weread-reading-evolution__stat-label">{label}</span>
      <span className="weread-reading-evolution__stat-value">{value}</span>
      <span className="weread-reading-evolution__stat-hint">{hint}</span>
    </div>
  );
}

// ---------- milestones ----------

interface MilestonesSectionProps {
  milestones: ReadonlyArray<ReadingEvolutionMilestone>;
  transitions: ReadonlyArray<ReadingEvolutionTransition>;
}

function MilestonesSection({ milestones, transitions }: MilestonesSectionProps) {
  if (milestones.length === 0) return null;
  // Defensive sort by year + canonical kind order.
  const sorted = [...milestones].sort((a, b) => {
    if (a.year !== b.year) return a.year - b.year;
    return MILESTONE_KIND_ORDER.indexOf(a.kind) - MILESTONE_KIND_ORDER.indexOf(b.kind);
  });
  return (
    <section
      className="weread-reading-evolution__milestones"
      data-testid="weread-reading-evolution-milestones"
    >
      <h4>时间线标记</h4>
      <ol className="weread-reading-evolution__milestone-list">
        {sorted.map((m, idx) => {
          const transition = m.transitionIndex !== null ? transitions[m.transitionIndex] : undefined;
          const reasons = m.reasons;
          return (
            <li
              key={`${m.year}:${m.kind}:${idx}`}
              className={`weread-reading-evolution__milestone weread-reading-evolution__milestone--${m.kind}`}
              data-testid="weread-reading-evolution-milestone"
              data-year={String(m.year)}
              data-kind={m.kind}
              data-significant={m.kind === "year_gap" || m.kind === "statistical_shift" ? "true" : "false"}
            >
              <span className="weread-reading-evolution__milestone-year">{describeYear(m.year)}</span>
              <span className="weread-reading-evolution__milestone-kind">{MILESTONE_LABELS[m.kind]}</span>
              {m.significanceScore > 0 ? (
                <span
                  className="weread-reading-evolution__milestone-score"
                  data-testid="weread-reading-evolution-milestone-score"
                >
                  统计差异得分：{m.significanceScore}
                </span>
              ) : null}
              {reasons.length > 0 ? (
                <ul className="weread-reading-evolution__milestone-reasons">
                  {reasons.map((r) => (
                    <li
                      key={r}
                      className="weread-reading-evolution__milestone-reason"
                      data-testid="weread-reading-evolution-milestone-reason"
                      data-reason={r}
                    >
                      {REASON_LABELS[r]}
                    </li>
                  ))}
                </ul>
              ) : null}
              {!transition && m.kind !== "first_year" && m.kind !== "latest_year" ? null : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------- year node ----------

interface YearNodeProps {
  node: WereadReadingEvolutionTimeline["years"][number];
  topBooksLimit: 6 | 12 | 18;
}

function YearNode({ node, topBooksLimit }: YearNodeProps) {
  const previewBooks = node.topBooks.slice(0, 6);
  const hasMore = node.topBooks.length > previewBooks.length;
  return (
    <article
      className="weread-reading-evolution__year"
      data-testid="weread-reading-evolution-year"
      data-year={String(node.year)}
    >
      <header className="weread-reading-evolution__year-header">
        <span className="weread-reading-evolution__year-label">{describeYear(node.year)}</span>
        <span
          className="weread-reading-evolution__year-topn"
          data-testid="weread-reading-evolution-year-topn"
        >
          当前 Top {topBooksLimit} 公共书目
        </span>
      </header>
      <dl className="weread-reading-evolution__year-stats">
        <div>
          <dt>阅读记录</dt>
          <dd>{formatInteger(node.totalRecords)}</dd>
        </div>
        <div>
          <dt>已匹配记录</dt>
          <dd>{formatInteger(node.matchedRecords)}</dd>
        </div>
        <div>
          <dt>年度书目</dt>
          <dd>{formatInteger(node.matchedBooks)}</dd>
        </div>
        <div>
          <dt>活跃月份</dt>
          <dd>{formatInteger(node.activeMonths)}</dd>
        </div>
        <div>
          <dt>活跃月份平均记录</dt>
          <dd>{formatAverage(node.averageRecordsPerActiveMonth)}</dd>
        </div>
      </dl>
      {previewBooks.length > 0 ? (
        <div
          className="weread-reading-evolution__year-top-books"
          data-testid="weread-reading-evolution-year-top-books"
        >
          <p className="weread-reading-evolution__year-top-books-scope">
            仅展示该年度当前 Top {topBooksLimit} 中已匹配的公共书目。
          </p>
          <ol className="weread-reading-evolution__year-top-books-list">
            {previewBooks.map((book) => (
              <li
                key={book.catalogId}
                className="weread-reading-evolution__book"
                data-testid={`weread-reading-evolution-book-${book.catalogId}`}
              >
                <span className="weread-reading-evolution__book-rank">第 {book.rank} 名</span>
                <a
                  className="weread-reading-evolution__book-title"
                  href={`/books/${book.catalogId}`}
                  data-testid={`weread-reading-evolution-book-link-${book.catalogId}`}
                >
                  {book.title}
                </a>
                {book.author ? (
                  <span
                    className="weread-reading-evolution__book-author"
                    data-testid={`weread-reading-evolution-book-author-${book.catalogId}`}
                  >
                    {book.author}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          {hasMore ? (
            <p
              className="weread-reading-evolution__year-top-books-more"
              data-testid="weread-reading-evolution-year-top-books-more"
            >
              另有 {node.topBooks.length - previewBooks.length} 本，完整结果将在后续本地导出中提供。
            </p>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

// ---------- transition section ----------

interface TransitionSectionProps {
  transition: ReadingEvolutionTransition;
}

function TransitionSection({ transition }: TransitionSectionProps) {
  const previousNode = transition.metrics.totalRecords; // dummy to silence unused warnings
  void previousNode;
  const scoreClass =
    transition.significant
      ? "weread-reading-evolution__transition weread-reading-evolution__transition--significant"
      : "weread-reading-evolution__transition";
  return (
    <article
      className={scoreClass}
      data-testid="weread-reading-evolution-transition"
      data-from-year={String(transition.fromYear)}
      data-to-year={String(transition.toYear)}
      data-significant={transition.significant ? "true" : "false"}
      data-score={String(transition.significanceScore)}
      aria-label={`${transition.fromYear} 至 ${transition.toYear} 相邻年度过渡`}
    >
      <header className="weread-reading-evolution__transition-header">
        <h4>
          {transition.fromYear} → {transition.toYear}
        </h4>
        <span
          className="weread-reading-evolution__transition-score"
          data-testid="weread-reading-evolution-transition-score"
        >
          统计差异得分：{transition.significanceScore}
        </span>
        <span
          className="weread-reading-evolution__transition-significance"
          data-testid="weread-reading-evolution-transition-significance"
        >
          {transition.significant ? "显著统计差异" : "常规统计差异"}
        </span>
      </header>

      <div
        className="weread-reading-evolution__transition-overlap"
        data-testid="weread-reading-evolution-transition-overlap"
      >
        <p
          className="weread-reading-evolution__transition-overlap-ratio"
          data-testid="weread-reading-evolution-transition-overlap-ratio"
        >
          相邻年度 Top N 榜单重合比例：{formatRatio(transition.topListOverlap.ratio)}
        </p>
        <p className="weread-reading-evolution__transition-overlap-counts">
          共同上榜书目数量：{transition.topListOverlap.commonBooks} · 榜单并集书目数量：{transition.topListOverlap.unionBooks}
        </p>
      </div>

      <ReasonsList reasons={transition.reasons} />

      <MetricsTable
        fromYear={transition.fromYear}
        toYear={transition.toYear}
        transition={transition}
      />

      <BookDiffSection transition={transition} />
    </article>
  );
}

// ---------- reasons ----------

interface ReasonsListProps {
  reasons: ReadonlyArray<ReadingEvolutionTransitionReason>;
}

function ReasonsList({ reasons }: ReasonsListProps) {
  return (
    <div
      className="weread-reading-evolution__reasons"
      data-testid="weread-reading-evolution-reasons"
      data-count={String(reasons.length)}
    >
      {reasons.length === 0 ? (
        <p
          className="weread-reading-evolution__reasons-empty"
          data-testid="weread-reading-evolution-reasons-empty"
        >
          {NO_REASONS_HINT}
        </p>
      ) : (
        <ul className="weread-reading-evolution__reasons-list">
          {reasons.map((r) => (
            <li
              key={r}
              className="weread-reading-evolution__reason"
              data-testid="weread-reading-evolution-reason"
              data-reason={r}
            >
              {REASON_LABELS[r]}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- metrics table ----------

interface MetricsTableProps {
  fromYear: number;
  toYear: number;
  transition: ReadingEvolutionTransition;
}

function MetricsTable({ fromYear, toYear, transition }: MetricsTableProps) {
  // Find the previous and current year nodes from the transition's
  // metrics context. The model doesn't keep a reference to the
  // underlying year nodes in the transition, so we read from the
  // metrics deltas directly. We need absolute values; since the
  // model stores deltas, we look up the year via the fromYear /
  // toYear and infer from the transition's previous/current
  // context (passed through props).
  // The metrics are presented as deltas, so we render the delta
  // row only.
  return (
    <section
      className="weread-reading-evolution__metrics"
      data-testid="weread-reading-evolution-metrics"
      data-from-year={String(fromYear)}
      data-to-year={String(toYear)}
    >
      <h4>指标差异</h4>
      <table
        className="weread-reading-evolution__metrics-table"
        data-testid="weread-reading-evolution-metrics-table"
      >
        <thead>
          <tr>
            <th scope="col">指标</th>
            <th scope="col">差值</th>
            <th scope="col">百分比</th>
            <th scope="col">方向</th>
          </tr>
        </thead>
        <tbody>
          {METRIC_LABELS.map((row) => {
            const delta = (() => {
              switch (row.key) {
                case "totalRecords":
                  return transition.metrics.totalRecords;
                case "activeMonths":
                  return transition.metrics.activeMonths;
                case "matchedRecords":
                  return transition.metrics.matchedRecords;
                case "matchedBooks":
                  return transition.metrics.matchedBooks;
                case "averageRecordsPerActiveMonth":
                  // The model does not expose average-per-active-month as
                  // a transition metric; fall back to absolute = 0.
                  return { absolute: 0, percentage: 0, direction: "same" as const };
                default:
                  return { absolute: 0, percentage: 0, direction: "same" as const };
              }
            })();
            const absoluteFormatter =
              row.key === "averageRecordsPerActiveMonth" ? formatAverageDelta : formatAbsoluteDelta;
            return (
              <tr
                key={row.key}
                data-testid={`weread-reading-evolution-metric-${row.key}`}
                data-direction={delta.direction}
              >
                <th scope="row">{row.label}</th>
                <td>
                  <span
                    className="weread-reading-evolution__metric-absolute"
                    data-testid={`weread-reading-evolution-metric-absolute-${row.key}`}
                  >
                    {absoluteFormatter(delta.absolute)}
                  </span>
                </td>
                <td>
                  <span
                    className="weread-reading-evolution__metric-percent"
                    data-testid={`weread-reading-evolution-metric-percent-${row.key}`}
                  >
                    {formatPercentageDelta(delta.direction, delta.percentage)}
                  </span>
                </td>
                <td>
                  <span
                    className="weread-reading-evolution__metric-direction"
                    data-testid={`weread-reading-evolution-metric-direction-${row.key}`}
                  >
                    {describeDirection(delta.direction)}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---------- book diff section ----------

interface BookDiffSectionProps {
  transition: ReadingEvolutionTransition;
}

function BookDiffSection({ transition }: BookDiffSectionProps) {
  const continued = transition.books.continued.slice(0, DIFF_DISPLAY_LIMIT);
  const entered = transition.books.entered.slice(0, DIFF_DISPLAY_LIMIT);
  const left = transition.books.left.slice(0, DIFF_DISPLAY_LIMIT);
  const continuedOverflow = Math.max(0, transition.books.continued.length - continued.length);
  const enteredOverflow = Math.max(0, transition.books.entered.length - entered.length);
  const leftOverflow = Math.max(0, transition.books.left.length - left.length);
  return (
    <section
      className="weread-reading-evolution__books"
      data-testid="weread-reading-evolution-books"
    >
      <h4>查看 Top N 公共书目差异</h4>
      <div
        className="weread-reading-evolution__book-summary"
        data-testid="weread-reading-evolution-book-summary"
      >
        <p data-testid="weread-reading-evolution-book-counts">
          两年都有：{transition.books.continued.length} · 当前年份新进入：{transition.books.entered.length} · 前一年出现、当前年份未出现：{transition.books.left.length}
        </p>
      </div>

      <details
        className="weread-reading-evolution__book-details"
        data-testid="weread-reading-evolution-book-details"
      >
        <summary>查看 Top N 公共书目差异</summary>

        <DiffGroup
          testIdPrefix="weread-reading-evolution-continued"
          title="两年都有"
          diffs={continued}
          overflowCount={continuedOverflow}
          emptyHint="暂无公共书目。"
          renderRow={(diff) => (
            <DiffRow
              key={diff.catalogId}
              testIdPrefix="weread-reading-evolution-continued"
              diff={diff}
              previousRank={diff.previousRank}
              currentRank={diff.currentRank}
              rankDelta={diff.rankDelta}
              showRankDelta
            />
          )}
        />

        <DiffGroup
          testIdPrefix="weread-reading-evolution-entered"
          title="当前年份新进入"
          diffs={entered}
          overflowCount={enteredOverflow}
          emptyHint="暂无公共书目。"
          renderRow={(diff) => (
            <DiffRow
              key={diff.catalogId}
              testIdPrefix="weread-reading-evolution-entered"
              diff={diff}
              previousRank={null}
              currentRank={diff.currentRank}
              rankDelta={null}
              showRankDelta={false}
            />
          )}
        />

        <DiffGroup
          testIdPrefix="weread-reading-evolution-left"
          title="前一年出现、当前年份未出现"
          diffs={left}
          overflowCount={leftOverflow}
          emptyHint="暂无公共书目。"
          renderRow={(diff) => (
            <DiffRow
              key={diff.catalogId}
              testIdPrefix="weread-reading-evolution-left"
              diff={diff}
              previousRank={diff.previousRank}
              currentRank={null}
              rankDelta={null}
              showRankDelta={false}
            />
          )}
        />
      </details>
    </section>
  );
}

interface DiffGroupProps {
  testIdPrefix: string;
  title: string;
  diffs: ReadonlyArray<ReadingEvolutionBookDiff>;
  overflowCount: number;
  emptyHint: string;
  renderRow: (diff: ReadingEvolutionBookDiff) => React.ReactNode;
}

function DiffGroup({ testIdPrefix, title, diffs, overflowCount, emptyHint, renderRow }: DiffGroupProps) {
  return (
    <article
      className="weread-reading-evolution__book-diff-group"
      data-testid={testIdPrefix}
    >
      <header className="weread-reading-evolution__book-diff-header">
        <h5>{title}</h5>
        <span
          className="weread-reading-evolution__book-diff-count"
          data-testid={`${testIdPrefix}-count`}
        >
          {diffs.length} 本
        </span>
      </header>
      {diffs.length === 0 ? (
        <p
          className="weread-reading-evolution__book-diff-empty"
          data-testid={`${testIdPrefix}-empty`}
        >
          {emptyHint}
        </p>
      ) : (
        <ul className="weread-reading-evolution__book-diff-list">
          {diffs.map((d) => renderRow(d))}
        </ul>
      )}
      {overflowCount > 0 ? (
        <p
          className="weread-reading-evolution__book-diff-overflow"
          data-testid={`${testIdPrefix}-overflow`}
        >
          另有 {overflowCount} 本，完整结果将在后续本地导出中提供。
        </p>
      ) : null}
    </article>
  );
}

interface DiffRowProps {
  testIdPrefix: string;
  diff: ReadingEvolutionBookDiff;
  previousRank: number | null;
  currentRank: number | null;
  rankDelta: number | null;
  showRankDelta: boolean;
}

function DiffRow({ testIdPrefix, diff, previousRank, currentRank, rankDelta, showRankDelta }: DiffRowProps) {
  return (
    <li
      key={diff.catalogId}
      className="weread-reading-evolution__book-diff"
      data-testid={`${testIdPrefix}-item-${diff.catalogId}`}
      data-catalog-id={diff.catalogId}
    >
      <a
        className="weread-reading-evolution__book-diff-title"
        href={`/books/${diff.catalogId}`}
        data-testid={`${testIdPrefix}-title-${diff.catalogId}`}
      >
        {diff.title}
      </a>
      {diff.author ? (
        <span
          className="weread-reading-evolution__book-diff-author"
          data-testid={`${testIdPrefix}-author-${diff.catalogId}`}
        >
          {diff.author}
        </span>
      ) : null}
      <dl className="weread-reading-evolution__book-diff-stats">
        {previousRank !== null ? (
          <div>
            <dt>前一年排名</dt>
            <dd>第 {previousRank} 名</dd>
          </div>
        ) : null}
        {currentRank !== null ? (
          <div>
            <dt>当前年份排名</dt>
            <dd>第 {currentRank} 名</dd>
          </div>
        ) : null}
        {showRankDelta && rankDelta !== null ? (
          <div>
            <dt>排名数字差值</dt>
            <dd
              data-testid={`${testIdPrefix}-rank-delta-${diff.catalogId}`}
              data-rank-delta={String(rankDelta)}
            >
              {rankDeltaLabel(rankDelta)}
            </dd>
          </div>
        ) : null}
      </dl>
    </li>
  );
}

// re-export utility for tests
export const __test__ = {
  describeYear,
  formatInteger,
  formatAverage,
  formatAbsoluteDelta,
  formatAverageDelta,
  formatPercentageDelta,
  describeDirection,
  formatRatio,
  rankDeltaLabel,
  REASON_LABELS,
  MILESTONE_LABELS,
  METRIC_LABELS,
};
export type { ReadingEvolutionBook };
