/**
 * S27M — Reading Era Segmentation panel (browser-local, pure).
 *
 * Pure-React panel that consumes the in-memory WereadReadingArchive
 * and renders a list of reading eras with their boundaries and
 * recurring books. NEVER fetches anything; NEVER calls AI; NEVER
 * persists anything.
 *
 * Hard rules:
 *   - Recomputes from props on every render (mode / archive).
 *   - Uses stable Chinese labels from wereadReadingEraModel so no
 *     psychological / interest / preference vocabulary can leak in
 *     via ad-hoc strings.
 *   - Renders only public catalog metadata + statistical aggregates;
 *     never embeds note text / private IDs.
 *   - Catalog book links go to `/books/:catalogId` (existing public
 *     route).
 */

import { useMemo } from "react";

import {
  buildReadingEras,
  describeEraBoundary,
  READING_ERA_BOUNDARY_LABELS,
  type ReadingEra,
  type ReadingEraBoundary,
  type ReadingEraSegmentationMode,
  type WereadReadingEraResult,
} from "./wereadReadingEraModel";
import type { WereadReadingArchive } from "./wereadReadingArchiveModel";

export interface ReadingEraPanelProps {
  archive: WereadReadingArchive | null;
  mode: ReadingEraSegmentationMode;
  onModeChange: (next: ReadingEraSegmentationMode) => void;
  /** Optional override; defaults to the URL the rest of the app uses. */
  booksBasePath?: string;
}

const DEFAULT_BOOKS_BASE_PATH = "/books";
const PANEL_NOTICE =
  "阶段划分只依据相邻年份的记录数量、活跃月份和当前 Top N 榜单重合情况。" +
  "它是描述性分组，不代表阅读行为或阅读质量发生变化。";

const ALLOWED_BOUNDARY_LABELS = new Set(
  Object.values(READING_ERA_BOUNDARY_LABELS),
);

function safeDescribe(b: ReadingEraBoundary): string {
  // Defence-in-depth: each reason label must come from the allow-list
  // exported by the model. If any reason is unknown, fall back to a
  // single neutral label.
  const labels: string[] = [];
  for (const reason of b.reasons) {
    const lbl = READING_ERA_BOUNDARY_LABELS[reason];
    if (lbl) labels.push(lbl);
  }
  if (labels.length === 0) return "统计发生变化";
  return labels.join("、");
}

function formatYearRange(era: ReadingEra): string {
  if (era.years.length === 0) return "—";
  if (era.startYear === era.endYear) return `${era.startYear}年`;
  return `${era.startYear}—${era.endYear}年`;
}

function formatInteger(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n).toLocaleString("zh-CN");
}

function formatAverage(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const v = Math.round(n * 100) / 100;
  return v.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

function bookHref(catalogId: string, basePath: string): string {
  return `${basePath}/${encodeURIComponent(catalogId)}`;
}

export default function ReadingEraPanel({
  archive,
  mode,
  onModeChange,
  booksBasePath = DEFAULT_BOOKS_BASE_PATH,
}: ReadingEraPanelProps) {
  const result: WereadReadingEraResult = useMemo(() => {
    if (!archive) {
      return {
        eras: [],
        boundaries: [],
        meta: { yearsUsed: 0, erasReturned: 0, mode, persisted: false },
      };
    }
    return buildReadingEras(archive, mode);
  }, [archive, mode]);

  const hasYears =
    archive !== null &&
    Array.isArray(archive.years) &&
    archive.years.length > 0;

  return (
    <section
      className="weread-reading-era"
      data-testid="weread-reading-era"
      aria-label="阅读阶段"
    >
      <header className="weread-reading-era__notice" data-testid="weread-reading-era-notice">
        <h3>阅读阶段</h3>
        <p className="weread-reading-era__notice-body">{PANEL_NOTICE}</p>
      </header>

      <div
        className="weread-reading-era__controls"
        data-testid="weread-reading-era-controls"
        role="group"
        aria-label="阶段划分模式"
      >
        <label className="weread-reading-era__mode">
          <input
            type="radio"
            name="weread-reading-era-mode"
            value="automatic"
            checked={mode === "automatic"}
            onChange={() => onModeChange("automatic")}
            data-testid="weread-reading-era-mode-automatic"
          />
          <span>自动阶段</span>
        </label>
        <label className="weread-reading-era__mode">
          <input
            type="radio"
            name="weread-reading-era-mode"
            value="gaps_only"
            checked={mode === "gaps_only"}
            onChange={() => onModeChange("gaps_only")}
            data-testid="weread-reading-era-mode-gaps-only"
          />
          <span>仅按年份中断分段</span>
        </label>
      </div>

      {!hasYears ? (
        <p
          className="weread-reading-era__empty"
          data-testid="weread-reading-era-empty"
        >
          暂无长期档案年份，无法划分阅读阶段。
        </p>
      ) : result.eras.length === 0 ? (
        <p
          className="weread-reading-era__empty"
          data-testid="weread-reading-era-empty"
        >
          当前范围内只有 {result.meta.yearsUsed} 个年份，无可划分的阶段。
        </p>
      ) : (
        <ol
          className="weread-reading-era__timeline"
          data-testid="weread-reading-era-timeline"
          data-era-count={result.eras.length}
          data-mode={mode}
        >
          {result.eras.map((era, idx) => (
            <li
              key={era.id}
              className="weread-reading-era__card"
              data-testid={`weread-reading-era-card-${era.startYear}`}
            >
              <header className="weread-reading-era__card-header">
                <span className="weread-reading-era__card-title">
                  {formatYearRange(era)}
                </span>
                <span className="weread-reading-era__card-count">
                  包含 {era.years.length} 个年份
                </span>
              </header>

              <dl className="weread-reading-era__metrics">
                <div>
                  <dt>阅读记录合计</dt>
                  <dd data-testid={`weread-reading-era-total-records-${era.startYear}`}>
                    {formatInteger(era.totalRecords)}
                  </dd>
                </div>
                <div>
                  <dt>活跃月份合计</dt>
                  <dd data-testid={`weread-reading-era-total-months-${era.startYear}`}>
                    {formatInteger(era.totalActiveMonths)}
                  </dd>
                </div>
                <div>
                  <dt>年均记录</dt>
                  <dd data-testid={`weread-reading-era-avg-${era.startYear}`}>
                    {formatAverage(era.averageRecordsPerYear)}
                  </dd>
                </div>
                <div>
                  <dt>高峰年份</dt>
                  <dd data-testid={`weread-reading-era-peak-${era.startYear}`}>
                    {era.peakYear === null
                      ? "—"
                      : `${era.peakYear}年（${formatInteger(era.peakYearRecords)} 条）`}
                  </dd>
                </div>
              </dl>

              {era.boundaryBefore ? (
                <p
                  className="weread-reading-era__boundary"
                  data-testid={`weread-reading-era-boundary-${era.startYear}`}
                  data-reasons={era.boundaryBefore.reasons.join(",")}
                >
                  阶段边界：{safeDescribe(era.boundaryBefore)}
                </p>
              ) : idx === 0 ? (
                <p
                  className="weread-reading-era__boundary"
                  data-testid={`weread-reading-era-boundary-${era.startYear}`}
                >
                  阶段起点：当前档案最早年份
                </p>
              ) : null}

              {era.recurringBooks.length > 0 ? (
                <div className="weread-reading-era__books">
                  <h4>阶段内多次进入 Top N 的书目</h4>
                  <ul data-testid={`weread-reading-era-books-${era.startYear}`}>
                    {era.recurringBooks.map((b) => (
                      <li
                        key={b.catalogId}
                        className="weread-reading-era__book"
                        data-testid={`weread-reading-era-book-${era.startYear}-${b.catalogId}`}
                      >
                        <a
                          href={bookHref(b.catalogId, booksBasePath)}
                          data-testid={`weread-reading-era-book-link-${era.startYear}-${b.catalogId}`}
                        >
                          {b.title && b.title.trim().length > 0
                            ? b.title
                            : `书目 ${b.catalogId}`}
                        </a>
                        <span className="weread-reading-era__book-meta">
                          出现 {b.yearsOnList} 次（{b.years.join("、")}）
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}