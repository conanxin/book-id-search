/**
 * S27L — ReadingArchiveDashboard
 *
 * The fifth workspace tab under /weread. Aggregates multiple annual
 * review responses (fetched on demand, never persisted) into a
 * long-term archive index. The dashboard never reads note text,
 * comment, wereadBookId, AI summaries, or any private id; it only
 * re-uses the public-catalog fields exposed by the existing
 * `annual-review` GET endpoint.
 *
 * Concurrency model:
 *   - At most 2 annual-review requests can be in-flight at once.
 *   - Responses are cached in-memory keyed by `${year}:${topBooks}`
 *     so re-entering the tab does not refetch already-loaded years.
 *   - Token changes abort all in-flight requests and clear the cache.
 *
 * Privacy contract: see `wereadReadingArchiveModel.ts` for the
 * exhaustive list of forbidden fields. The model always emits
 * `meta.persisted: false` and `meta.source: "annual-review-cache"`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  Archive,
  Calendar,
  CalendarRange,
  ChevronRight,
  EyeOff,
  Library,
  Loader2,
  RefreshCw,
} from "lucide-react";
import {
  fetchWereadAnnualReview,
  type WereadAnnualReviewResponse,
  type WereadAnnualReviewTopBooksOption,
} from "../wereadPrivate";
import {
  DEFAULT_READING_ARCHIVE_RANGE,
  DEFAULT_READING_ARCHIVE_RECURRING_LIMIT,
  DEFAULT_READING_ARCHIVE_TOP_BOOKS,
  READING_ARCHIVE_MAX_YEARS,
  READING_ARCHIVE_RANGE_OPTIONS,
  READING_ARCHIVE_TOP_BOOKS_OPTIONS,
  buildWereadReadingArchive,
  formatArchiveOverview,
  formatArchiveOverlap,
  formatArchiveYearRange,
  getArchiveOverlapScopeNote,
  getArchivePrivacyDisclaimer,
  getArchiveRecurringScopeNote,
  getArchiveTopNScopeNotice,
  hasReadingArchiveData,
  pickArchiveYearSlice,
  type ReadingArchiveRangeValue,
  type WereadReadingArchive,
} from "./wereadReadingArchiveModel";

// ---------- props ----------

export interface ReadingArchiveDashboardProps {
  token: string;
  active: boolean;
  /**
   * The year to request on mount / re-activation. If null, the
   * dashboard schedules fetches for all availableYears.
   */
  requestedYear: number | null;
  /**
   * Invoked when the user clicks "查看年度回顾" on a year card. The
   * parent should switch the active workspace to `annual` and pass
   * `year` to `<AnnualReviewDashboard requestedYear={year} />`.
   */
  onOpenAnnualYear: (year: number) => void;
}

// ---------- types ----------

interface LoadOutcome {
  status: "ok" | "error";
  response?: WereadAnnualReviewResponse;
  error?: string;
}

interface YearProgress {
  status: "pending" | "loading" | "ok" | "error";
  response: WereadAnnualReviewResponse | null;
  error: string | null;
}

interface DashboardState {
  range: ReadingArchiveRangeValue;
  topBooks: WereadAnnualReviewTopBooksOption;
  status: "idle" | "loading" | "ok" | "error";
  error: string | null;
  /** availableYears (descending) as reported by the first annual-review response. */
  availableYears: number[];
  /** Year rows the dashboard is currently loading. */
  progress: Record<number, YearProgress>;
  /** Years that the user requested but the server failed to return. */
  failedYears: number[];
}

const INITIAL_STATE: DashboardState = {
  range: DEFAULT_READING_ARCHIVE_RANGE,
  topBooks: DEFAULT_READING_ARCHIVE_TOP_BOOKS,
  status: "idle",
  error: null,
  availableYears: [],
  progress: {},
  failedYears: [],
};

const MAX_CONCURRENT_REQUESTS = 2;

// ---------- helpers ----------

function cacheKey(year: number, topBooks: WereadAnnualReviewTopBooksOption): string {
  return `${year}:${topBooks}`;
}

function describeYear(year: number): string {
  return `${year} 年`;
}

// ---------- component ----------

export default function ReadingArchiveDashboard({
  token,
  active,
  onOpenAnnualYear,
  requestedYear,
}: ReadingArchiveDashboardProps) {
  const [state, setState] = useState<DashboardState>(INITIAL_STATE);
  const cacheRef = useRef<Map<string, WereadAnnualReviewResponse>>(new Map());
  const inflightRef = useRef<Map<string, AbortController>>(new Map());
  const initialFetchIssuedRef = useRef<boolean>(false);
  const lastTokenRef = useRef<string>("");

  // ----- token reset -----
  useEffect(() => {
    if (!token) {
      // Abort every in-flight request and drop everything in memory.
      for (const ctrl of inflightRef.current.values()) {
        try {
          ctrl.abort();
        } catch {
          /* noop */
        }
      }
      inflightRef.current.clear();
      cacheRef.current.clear();
      initialFetchIssuedRef.current = false;
      lastTokenRef.current = "";
      setState(INITIAL_STATE);
      return;
    }
    if (lastTokenRef.current !== token) {
      // New token — wipe everything and start over.
      for (const ctrl of inflightRef.current.values()) {
        try {
          ctrl.abort();
        } catch {
          /* noop */
        }
      }
      inflightRef.current.clear();
      cacheRef.current.clear();
      initialFetchIssuedRef.current = false;
      lastTokenRef.current = token;
      setState(INITIAL_STATE);
    }
  }, [token]);

  // ----- unmount cleanup -----
  useEffect(() => {
    return () => {
      for (const ctrl of inflightRef.current.values()) {
        try {
          ctrl.abort();
        } catch {
          /* noop */
        }
      }
      inflightRef.current.clear();
    };
  }, []);

  // ----- bootstrap on activation -----
  // Step 1: fire a default annual-review request so we can learn the
  // `availableYears` array. Step 2: once we know the available years,
  // schedule per-year fetches inside the bounded-concurrency queue.
  //
  // We optimistically mark the bootstrap year as "pending" BEFORE firing
  // the request so that the year-slice effect (which also runs on mount)
  // sees it as already-scheduled and skips double-scheduling it.
  useEffect(() => {
    if (!token) return;
    if (!active) return;
    if (initialFetchIssuedRef.current) return;
    initialFetchIssuedRef.current = true;
    // Pre-mark the bootstrap year as pending so year-slice effect does
    // not schedule a duplicate fetch for the same year.  Use requestedYear
    // (2025) as the key so the year-slice effect skips scheduling that year.
    setState((prev) => ({
      ...prev,
      progress: { ...prev.progress, [requestedYear ?? NaN]: { status: "pending", response: null, error: null } },
    }));
    fetchOneYear({
      token,
      year: undefined,
      topBooks: state.topBooks,
    })
      .then((outcome) => {
        if (outcome.status === "ok" && outcome.response) {
          const resp = outcome.response;
          setState((prev) => {
            const progress = { ...prev.progress };
            // Remove the requestedYear placeholder.
            delete progress[requestedYear ?? NaN];
            return {
              ...prev,
              availableYears: resp.availableYears,
              progress: {
                ...progress,
                [resp.selectedYear]: {
                  status: "ok",
                  response: resp,
                  error: null,
                },
              },
            };
          });
          // Seed the cache so we don't re-fetch the bootstrap year.
          cacheRef.current.set(cacheKey(resp.selectedYear, state.topBooks), resp);
          // Schedule the remaining years.
          scheduleYearFetches();
        } else {
          setState((prev) => {
            const progress = { ...prev.progress };
            delete progress[requestedYear ?? NaN];
            return { ...prev, progress, status: "error", error: outcome.error ?? "长期档案暂不可用，请稍后重试。" };
          });
        }
      })
      .catch(() => {
        setState((prev) => {
          const progress = { ...prev.progress };
          delete progress[requestedYear ?? NaN];
          return { ...prev, progress, status: "error", error: "长期档案暂不可用，请稍后重试。" };
        });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, token]);

  // When the year slice changes (range / topBooks) we drop the cache
  // entries that no longer apply and re-schedule.
  const yearSliceRef = useRef<number[]>([]);
  useEffect(() => {
    if (!token) return;
    if (!active) return;
    // If availableYears is not yet populated, use requestedYear (if set)
    // to bootstrap the slice. This handles the remount case where
    // requestedYear was set by the parent but availableYears hasn't
    // been populated yet from the initial bootstrap fetch.
    const effectiveYears = state.availableYears.length > 0
      ? state.availableYears
      : (requestedYear != null ? [requestedYear] : []);
    if (effectiveYears.length === 0) return;
    const slice = pickArchiveYearSlice({
      availableYears: effectiveYears,
      range: state.range,
    });
    const sliceChanged =
      slice.length !== yearSliceRef.current.length ||
      slice.some((y, i) => yearSliceRef.current[i] !== y);
    if (!sliceChanged) return;
    yearSliceRef.current = slice;
    // Drop cache entries for years we no longer need.
    const sliceSet = new Set(slice);
    for (const key of Array.from(cacheRef.current.keys())) {
      const match = /^(\d+):/.exec(key);
      if (!match) continue;
      const year = Number(match[1]);
      if (!sliceSet.has(year)) cacheRef.current.delete(key);
    }
    // Reset progress for the new slice — keep successful responses
    // for years still in the slice so we don't refetch them.
    setState((prev) => {
      const nextProgress: Record<number, YearProgress> = {};
      for (const y of slice) {
        const key = cacheKey(y, prev.topBooks);
        const cached = cacheRef.current.get(key);
        if (cached) {
          nextProgress[y] = { status: "ok", response: cached, error: null };
          continue;
        }
        nextProgress[y] = { status: "pending", response: null, error: null };
      }
      // Only set status to "loading" if at least one year in the
      // new slice is not in the cache. If everything is cached,
      // the dashboard is effectively "ok" immediately and the
      // controls / year cards should render without a loading flash.
      const allCached = slice.every((y) => cacheRef.current.has(cacheKey(y, prev.topBooks)));
      return {
        ...prev,
        progress: nextProgress,
        failedYears: [],
        status: slice.length === 0 ? "idle" : (allCached ? "ok" : "loading"),
        error: null,
      };
    });
    scheduleYearFetches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, token, state.range, state.topBooks, state.availableYears, requestedYear]);

  // ----- bounded-concurrency scheduler -----
  const scheduleYearFetchesRef = useRef<() => void>(() => {});
  const scheduleYearFetches = useCallback(() => {
    scheduleYearFetchesRef.current();
  }, []);

  scheduleYearFetchesRef.current = () => {
    if (!token) return;
    const slice = yearSliceRef.current;
    if (slice.length === 0) return;
    const queue = slice.filter((y) => {
      const key = cacheKey(y, state.topBooks);
      if (cacheRef.current.has(key)) return false;
      if (inflightRef.current.has(key)) return false;
      const progress = state.progress[y];
      if (progress && progress.status === "ok") return false;
      return true;
    });
    for (const year of queue) {
      if (inflightRef.current.size >= MAX_CONCURRENT_REQUESTS) break;
      const key = cacheKey(year, state.topBooks);
      const controller = new AbortController();
      inflightRef.current.set(key, controller);
      setState((prev) => ({
        ...prev,
        progress: {
          ...prev.progress,
          [year]: { status: "loading", response: null, error: null },
        },
      }));
      fetchOneYear({
        token,
        year,
        topBooks: state.topBooks,
        signal: controller.signal,
      })
        .then((outcome) => {
          inflightRef.current.delete(key);
          if (outcome.status === "ok" && outcome.response) {
            cacheRef.current.set(key, outcome.response);
            setState((prev) => {
              const failedYears = prev.failedYears.filter((y) => y !== year);
              // Compute the new loaded/failed counts for the current slice.
              const slice = yearSliceRef.current;
              const response = outcome.response as WereadAnnualReviewResponse;
              const nextProgress: Record<number, YearProgress> = {
                ...prev.progress,
                [year]: { status: "ok", response, error: null },
              };
              const loadedCount = Object.values(nextProgress).filter((p) => p.response).length;
              const failedCount = failedYears.length;
              const requestedCount = slice.length;
              const allDone = requestedCount > 0 && loadedCount + failedCount >= requestedCount;
              return {
                ...prev,
                progress: nextProgress,
                failedYears,
                // Promote to "ok" once every requested year is either
                // loaded or has failed — this prevents the dashboard
                // from getting stuck in the loading state when the
                // scheduler finishes without any further slice change.
                status: allDone ? "ok" : (prev.status === "loading" ? "loading" : prev.status),
              };
            });
          } else {
            setState((prev) => ({
              ...prev,
              progress: {
                ...prev.progress,
                [year]: { status: "error", response: null, error: outcome.error ?? "加载失败" },
              },
              failedYears: prev.failedYears.includes(year) ? prev.failedYears : [...prev.failedYears, year],
            }));
          }
          // Try to schedule more once a slot frees up.
          scheduleYearFetches();
        })
        .catch(() => {
          inflightRef.current.delete(key);
          setState((prev) => ({
            ...prev,
            progress: {
              ...prev.progress,
              [year]: { status: "error", response: null, error: "加载失败" },
            },
            failedYears: prev.failedYears.includes(year)
              ? prev.failedYears
              : [...prev.failedYears, year],
          }));
          scheduleYearFetches();
        });
    }
  };

  // ----- retry failed years -----
  const retryFailed = useCallback(() => {
    if (!token) return;
    if (state.failedYears.length === 0) return;
    // Drop failed-year markers so the scheduler picks them up again.
    setState((prev) => ({
      ...prev,
      failedYears: [],
      status: "loading",
      error: null,
    }));
    for (const year of state.failedYears) {
      const key = cacheKey(year, state.topBooks);
      const controller = new AbortController();
      inflightRef.current.set(key, controller);
      setState((prev) => ({
        ...prev,
        progress: {
          ...prev.progress,
          [year]: { status: "loading", response: null, error: null },
        },
      }));
      fetchOneYear({
        token,
        year,
        topBooks: state.topBooks,
        signal: controller.signal,
      })
        .then((outcome) => {
          inflightRef.current.delete(key);
          if (outcome.status === "ok" && outcome.response) {
            cacheRef.current.set(key, outcome.response);
            setState((prev) => ({
              ...prev,
              progress: {
                ...prev.progress,
                [year]: { status: "ok", response: outcome.response!, error: null },
              },
            }));
          } else {
            setState((prev) => ({
              ...prev,
              progress: {
                ...prev.progress,
                [year]: { status: "error", response: null, error: outcome.error ?? "加载失败" },
              },
              failedYears: prev.failedYears.includes(year)
                ? prev.failedYears
                : [...prev.failedYears, year],
            }));
          }
          scheduleYearFetches();
        })
        .catch(() => {
          inflightRef.current.delete(key);
          setState((prev) => ({
            ...prev,
            progress: {
              ...prev.progress,
              [year]: { status: "error", response: null, error: "加载失败" },
            },
            failedYears: prev.failedYears.includes(year)
              ? prev.failedYears
              : [...prev.failedYears, year],
          }));
          scheduleYearFetches();
        });
    }
  }, [token, state.failedYears, state.topBooks, scheduleYearFetches]);

  // ----- selectors -----
  const responses = useMemo<WereadAnnualReviewResponse[]>(() => {
    return Object.values(state.progress)
      .map((p) => p.response)
      .filter((r): r is WereadAnnualReviewResponse => Boolean(r));
  }, [state.progress]);

  const archive: WereadReadingArchive = useMemo(() => {
    const slice = yearSliceRef.current.length;
    return buildWereadReadingArchive({
      responses,
      requestedYears: slice,
      topBooksLimit: state.topBooks,
      recurringLimit: DEFAULT_READING_ARCHIVE_RECURRING_LIMIT,
    });
  }, [responses, state.topBooks]);

  const loadedCount = responses.length;
  const failedCount = state.failedYears.length;
  const requestedCount = yearSliceRef.current.length;
  const isLoading =
    state.status === "loading" ||
    (active &&
      requestedCount > 0 &&
      loadedCount + failedCount < requestedCount &&
      Object.values(state.progress).some((p) => p.status === "loading" || p.status === "pending"));

  const dataAvailable = hasReadingArchiveData(archive);

  // ----- render: not activated -----
  if (!active) {
    return (
      <section
        className="weread-reading-archive weread-reading-archive--empty"
        data-testid="weread-reading-archive"
        aria-label="长期档案"
      >
        <p className="weread-reading-archive__empty-hint">点击上方「长期档案」工作区后开始加载。</p>
      </section>
    );
  }

  // ----- render: initial fetch failed and we have no data -----
  if (state.status === "error" && loadedCount === 0) {
    return (
      <section
        className="weread-reading-archive weread-reading-archive--error"
        data-testid="weread-reading-archive"
        data-status="error"
        aria-label="长期档案"
      >
        <header className="weread-reading-archive__header">
          <h2>
            <Archive size={16} aria-hidden="true" /> 长期档案
          </h2>
          <p className="weread-reading-archive__notice weread-reading-archive__notice--error" role="alert">
            <AlertCircle size={14} aria-hidden="true" /> 长期档案暂不可用，请稍后重试。
          </p>
        </header>
        <button
          type="button"
          className="weread-reading-archive__retry"
          onClick={() => {
            initialFetchIssuedRef.current = false;
            setState((prev) => ({ ...prev, status: "idle", error: null }));
          }}
          data-testid="weread-reading-archive-retry"
        >
          <RefreshCw size={14} aria-hidden="true" /> 重新加载
        </button>
      </section>
    );
  }

  // ----- render: loading (no data yet) -----
  if (isLoading && loadedCount === 0) {
    return (
      <section
        className="weread-reading-archive"
        data-testid="weread-reading-archive"
        data-status="loading"
        aria-label="长期档案"
      >
        <header className="weread-reading-archive__header">
          <h2>
            <Archive size={16} aria-hidden="true" /> 长期档案
          </h2>
          <p className="weread-reading-archive__notice" data-testid="weread-reading-archive-notice">
            <EyeOff size={14} aria-hidden="true" /> {getArchivePrivacyDisclaimer()}
          </p>
        </header>
        <p className="weread-reading-archive__loading" data-testid="weread-reading-archive-loading">
          <Loader2 size={14} className="spin" aria-hidden="true" /> 正在整理长期档案…
        </p>
      </section>
    );
  }

  // ----- render: full layout -----
  const yearsAsc = [...archive.years].sort((a, b) => a.year - b.year);
  const yearsDesc = [...archive.years].sort((a, b) => b.year - a.year);
  const slice = yearSliceRef.current;

  return (
    <section
      className="weread-reading-archive"
      data-testid="weread-reading-archive"
      data-status={dataAvailable ? "ok" : "empty"}
      data-range={state.range}
      data-top-books={String(state.topBooks)}
      aria-label="长期档案"
    >
      <header className="weread-reading-archive__header">
        <h2>
          <Archive size={16} aria-hidden="true" /> 长期档案
        </h2>
        <p
          className="weread-reading-archive__notice"
          data-testid="weread-reading-archive-notice"
        >
          <EyeOff size={14} aria-hidden="true" /> {getArchivePrivacyDisclaimer()}
        </p>
      </header>

      <div className="weread-reading-archive__controls" data-testid="weread-reading-archive-controls">
        <fieldset className="weread-reading-archive__control">
          <legend className="weread-reading-archive__control-label">年份范围</legend>
          {READING_ARCHIVE_RANGE_OPTIONS.map((opt) => (
            <label key={opt.value}>
              <input
                type="radio"
                name="weread-reading-archive-range"
                value={opt.value}
                checked={state.range === opt.value}
                onChange={() =>
                  setState((prev) => ({
                    ...prev,
                    range: opt.value,
                    status: prev.availableYears.length > 0 ? "loading" : prev.status,
                  }))
                }
                data-testid={`weread-reading-archive-range-${opt.value}`}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="weread-reading-archive__control">
          <legend className="weread-reading-archive__control-label">高互动书目</legend>
          {READING_ARCHIVE_TOP_BOOKS_OPTIONS.map((opt) => (
            <label key={opt}>
              <input
                type="radio"
                name="weread-reading-archive-top-books"
                value={opt}
                checked={state.topBooks === opt}
                onChange={() =>
                  setState((prev) => ({
                    ...prev,
                    topBooks: opt,
                    status: prev.availableYears.length > 0 ? "loading" : prev.status,
                  }))
                }
                data-testid={`weread-reading-archive-top-books-${opt}`}
              />
              <span>{opt}</span>
            </label>
          ))}
        </fieldset>
        <p className="weread-reading-archive__scope" data-testid="weread-reading-archive-scope">
          {getArchiveTopNScopeNotice()}
        </p>
      </div>

      <div className="weread-reading-archive__progress" data-testid="weread-reading-archive-progress">
        <Loader2 size={14} className={isLoading ? "spin" : ""} aria-hidden="true" />
        <span>
          正在整理长期档案：已加载 {loadedCount} / {requestedCount} 个年份
          {failedCount > 0 ? `（${failedCount} 个年份暂时失败）` : ""}
        </span>
        {failedCount > 0 ? (
          <button
            type="button"
            className="weread-reading-archive__retry-link"
            onClick={retryFailed}
            data-testid="weread-reading-archive-retry-failed"
          >
            <RefreshCw size={12} aria-hidden="true" /> 重试失败年份
          </button>
        ) : null}
      </div>

      {!dataAvailable ? (
        <p
          className="weread-reading-archive__empty"
          data-testid="weread-reading-archive-empty"
        >
          暂无长期档案数据。
        </p>
      ) : (
        <>
          <ArchiveOverviewSection archive={archive} />

          <ArchiveTimelineSection years={yearsAsc} />

          <ArchiveYearDirectory
            years={yearsDesc}
            onOpenAnnualYear={onOpenAnnualYear}
          />

          <ArchiveRecurringBooksSection archive={archive} />

          <ArchiveYearLinksSection archive={archive} />
        </>
      )}

      {failedCount > 0 ? (
        <p className="weread-reading-archive__error" data-testid="weread-reading-archive-error">
          <AlertCircle size={14} aria-hidden="true" />
          有 {failedCount} 个年份暂时加载失败，已成功年份仍可查看。
        </p>
      ) : null}

      <p className="weread-reading-archive__meta" data-testid="weread-reading-archive-meta">
        请求年份数 {archive.meta.requestedYears} · 加载年份数 {archive.meta.loadedYears} · 上限 {READING_ARCHIVE_MAX_YEARS} 年 · 不持久化
      </p>
    </section>
  );
}

// ---------- fetch helper ----------

async function fetchOneYear(args: {
  token: string;
  year: number | undefined;
  topBooks: WereadAnnualReviewTopBooksOption;
  signal?: AbortSignal;
}): Promise<LoadOutcome> {
  try {
    const resp = await fetchWereadAnnualReview(args.token, {
      year: args.year,
      topBooks: args.topBooks,
      signal: args.signal,
    });
    return { status: "ok", response: resp };
  } catch (err: unknown) {
    if (args.signal?.aborted) {
      return { status: "error", error: "已取消" };
    }
    const msg = err instanceof Error ? err.message : "加载失败";
    return { status: "error", error: msg };
  }
}

// ---------- overview ----------

interface ArchiveOverviewSectionProps {
  archive: WereadReadingArchive;
}

function ArchiveOverviewSection({ archive }: ArchiveOverviewSectionProps) {
  const o = archive.overview;
  return (
    <section className="weread-reading-archive__overview" data-testid="weread-reading-archive-overview">
      <h3>
        <Library size={14} aria-hidden="true" /> 档案总览
      </h3>
      <p className="weread-reading-archive__overview-summary" data-testid="weread-reading-archive-overview-summary">
        {formatArchiveOverview(archive)}
      </p>
      <div className="weread-reading-archive__overview-grid">
        <ArchiveStat
          label="有记录年份"
          value={o.yearsWithData > 0 ? String(o.yearsWithData) : "—"}
          hint="有阅读记录的年份数"
        />
        <ArchiveStat
          label="最早年份"
          value={o.firstYear !== null ? describeYear(o.firstYear) : "—"}
          hint="最早一份记录的年份"
        />
        <ArchiveStat
          label="最近年份"
          value={o.latestYear !== null ? describeYear(o.latestYear) : "—"}
          hint="最新一份记录的年份"
        />
        <ArchiveStat
          label="年份范围"
          value={formatArchiveYearRange({ firstYear: o.firstYear, latestYear: o.latestYear })}
          hint="最早与最新年份跨度"
        />
        <ArchiveStat
          label="阅读记录合计"
          value={o.totalRecords > 0 ? o.totalRecords.toLocaleString("zh-CN") : "0"}
          hint="跨年份的阅读记录总数"
        />
        <ArchiveStat
          label="活跃月份合计"
          value={o.totalActiveMonths > 0 ? o.totalActiveMonths.toLocaleString("zh-CN") : "0"}
          hint="各年度活跃月份数之和"
        />
        <ArchiveStat
          label="年均记录"
          value={
            o.averageRecordsPerYear > 0
              ? Math.round(o.averageRecordsPerYear).toLocaleString("zh-CN")
              : "—"
          }
          hint="阅读记录合计 / 有记录年份数"
        />
        <ArchiveStat
          label="最高记录年份"
          value={o.mostActiveYear !== null ? describeYear(o.mostActiveYear) : "—"}
          hint={
            o.mostActiveYearRecords > 0
              ? `该年 ${o.mostActiveYearRecords.toLocaleString("zh-CN")} 条记录`
              : "暂无数据"
          }
        />
        <ArchiveStat
          label="最长连续活跃年份"
          value={o.longestActiveYearStreak > 0 ? `${o.longestActiveYearStreak} 年` : "—"}
          hint="按自然年份连续计数"
        />
        <ArchiveStat
          label="多年进入榜单书目"
          value={o.recurringTopBooks > 0 ? `${o.recurringTopBooks} 本` : "0"}
          hint={`基于当前 Top ${archive.meta.topBooksLimit} 范围`}
        />
      </div>
    </section>
  );
}

interface ArchiveStatProps {
  label: string;
  value: string;
  hint?: string;
}

function ArchiveStat({ label, value, hint }: ArchiveStatProps) {
  return (
    <div className="weread-reading-archive__stat-card">
      <span className="weread-reading-archive__stat-label">{label}</span>
      <span className="weread-reading-archive__stat-value">{value}</span>
      {hint ? <span className="weread-reading-archive__stat-hint">{hint}</span> : null}
    </div>
  );
}

// ---------- timeline ----------

interface ArchiveTimelineSectionProps {
  years: ReadonlyArray<import("./wereadReadingArchiveModel").ReadingArchiveYear>;
}

function ArchiveTimelineSection({ years }: ArchiveTimelineSectionProps) {
  if (years.length === 0) return null;
  const maxTotal = years.reduce((acc, y) => Math.max(acc, y.totalRecords), 0);
  const maxActive = years.reduce((acc, y) => Math.max(acc, y.activeMonths), 0);
  return (
    <section className="weread-reading-archive__timeline" data-testid="weread-reading-archive-timeline">
      <h3>
        <CalendarRange size={14} aria-hidden="true" /> 跨年度趋势
      </h3>
      <ul className="weread-reading-archive__bars" aria-label="年度阅读记录趋势">
        {years.map((y) => {
          const totalH = maxTotal > 0 ? Math.max(2, Math.round((y.totalRecords / maxTotal) * 100)) : 0;
          const activeH = maxActive > 0 ? Math.max(2, Math.round((y.activeMonths / Math.max(1, maxActive)) * 100)) : 0;
          return (
            <li
              key={y.year}
              className="weread-reading-archive__bar"
              tabIndex={0}
              aria-label={`${y.year} 年阅读记录 ${y.totalRecords} 条，活跃月份 ${y.activeMonths} 个`}
            >
              <div className="weread-reading-archive__bar-track" aria-hidden="true">
                <div
                  className="weread-reading-archive__bar-fill weread-reading-archive__bar-fill--total"
                  style={{ height: `${totalH}%` }}
                />
                <div
                  className="weread-reading-archive__bar-fill weread-reading-archive__bar-fill--active"
                  style={{ height: `${activeH}%` }}
                />
              </div>
              <span className="weread-reading-archive__bar-label">{y.year}</span>
              <span className="weread-reading-archive__bar-value">
                {y.totalRecords.toLocaleString("zh-CN")}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="weread-reading-archive__timeline-key" aria-hidden="true">
        深色 = 阅读记录 · 浅色 = 活跃月份
      </p>
    </section>
  );
}

// ---------- year directory ----------

interface ArchiveYearDirectoryProps {
  years: ReadonlyArray<import("./wereadReadingArchiveModel").ReadingArchiveYear>;
  onOpenAnnualYear: (year: number) => void;
}

function ArchiveYearDirectory({ years, onOpenAnnualYear }: ArchiveYearDirectoryProps) {
  if (years.length === 0) return null;
  return (
    <section className="weread-reading-archive__year-grid" data-testid="weread-reading-archive-year-grid">
      <h3>
        <Calendar size={14} aria-hidden="true" /> 年度档案目录
      </h3>
      <div className="weread-reading-archive__year-grid-list">
        {years.map((y) => (
          <article
            key={y.year}
            className="weread-reading-archive__year-card"
            data-testid={`weread-reading-archive-year-${y.year}`}
          >
            <header className="weread-reading-archive__year-card-header">
              <span className="weread-reading-archive__year-card-year">{describeYear(y.year)}</span>
            </header>
            <dl className="weread-reading-archive__year-card-stats">
              <div>
                <dt>阅读记录</dt>
                <dd>{y.totalRecords.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>活跃月份</dt>
                <dd>{y.activeMonths.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>最长连续月份</dt>
                <dd>{y.longestStreakMonths.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>已匹配记录</dt>
                <dd>{y.matchedRecords.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>年度书目</dt>
                <dd>{y.topBookCount.toLocaleString("zh-CN")}</dd>
              </div>
              <div>
                <dt>高峰月份</dt>
                <dd>{y.peakMonth ? y.peakMonth : "—"}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="weread-reading-archive__year-card-action"
              onClick={() => onOpenAnnualYear(y.year)}
              data-testid={`weread-reading-archive-open-${y.year}`}
              aria-label={`查看 ${y.year} 年年度回顾`}
            >
              查看年度回顾 <ChevronRight size={12} aria-hidden="true" />
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---------- recurring books ----------

interface ArchiveRecurringBooksSectionProps {
  archive: WereadReadingArchive;
}

function ArchiveRecurringBooksSection({ archive }: ArchiveRecurringBooksSectionProps) {
  if (archive.recurringBooks.length === 0) return null;
  return (
    <section className="weread-reading-archive__book-grid" data-testid="weread-reading-archive-book-grid">
      <h3>多年进入 Top {archive.meta.topBooksLimit} 高互动榜的书目</h3>
      <p className="weread-reading-archive__scope" data-testid="weread-reading-archive-recurring-scope">
        {getArchiveRecurringScopeNote()}
      </p>
      <div className="weread-reading-archive__book-grid-list">
        {archive.recurringBooks.map((book) => (
          <article
            key={book.catalogId}
            className="weread-reading-archive__book-card"
            data-testid={`weread-reading-archive-book-${book.catalogId}`}
          >
            <header className="weread-reading-archive__book-card-header">
              <a
                className="weread-reading-archive__book-card-title"
                href={`/books/${book.catalogId}`}
                data-testid={`weread-reading-archive-book-link-${book.catalogId}`}
              >
                {book.title}
              </a>
              {book.author ? (
                <span className="weread-reading-archive__book-card-author">{book.author}</span>
              ) : null}
            </header>
            <dl className="weread-reading-archive__book-card-stats">
              <div>
                <dt>出现年份数</dt>
                <dd>{book.yearsOnList} 年</dd>
              </div>
              <div>
                <dt>年份列表</dt>
                <dd>{book.years.map((y) => y).join(" / ")}</dd>
              </div>
              <div>
                <dt>最佳排名</dt>
                <dd>第 {book.bestRank} 名</dd>
              </div>
              <div>
                <dt>最新年份排名</dt>
                <dd>{book.latestYear} 年第 {book.latestRank} 名</dd>
              </div>
              <div>
                <dt>榜单内年度记录合计</dt>
                <dd>{book.totalNoteCountWithinLists.toLocaleString("zh-CN")}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

// ---------- adjacent-year overlap ----------

interface ArchiveYearLinksSectionProps {
  archive: WereadReadingArchive;
}

function ArchiveYearLinksSection({ archive }: ArchiveYearLinksSectionProps) {
  if (archive.yearLinks.length === 0) return null;
  return (
    <section className="weread-reading-archive__links" data-testid="weread-reading-archive-links">
      <h3>相邻年度榜单重合</h3>
      <p className="weread-reading-archive__scope" data-testid="weread-reading-archive-overlap-scope">
        {getArchiveOverlapScopeNote()}
      </p>
      <ul className="weread-reading-archive__links-list">
        {archive.yearLinks.map((link) => (
          <li
            key={`${link.sourceYear}-${link.targetYear}`}
            className="weread-reading-archive__link"
            data-testid={`weread-reading-archive-link-${link.sourceYear}-${link.targetYear}`}
          >
            <span className="weread-reading-archive__link-range">
              {link.sourceYear} → {link.targetYear}
            </span>
            <span className="weread-reading-archive__link-shared">
              共同上榜 {link.sharedTopBooks} 本
            </span>
            <span className="weread-reading-archive__link-ratio">
              Top {archive.meta.topBooksLimit} 榜单重合率 {formatArchiveOverlap(link.overlapRatio)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
