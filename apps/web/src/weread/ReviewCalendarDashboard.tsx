/**
 * S27I — ReviewCalendarDashboard
 *
 * Pure front-end review calendar for the private WeRead centre.
 *
 * Privacy contract (mirrors S27H / S27H-2):
 *   - Reads only the public fields returned by `/api/private/weread/
 *     reading-map` (catalogId, title, author, noteCount, activeMonths,
 *     lastNoteAt, etc.).
 *   - Receives a sanitised session-theme overlay. NEVER receives the
 *     full AI summary, the raw notes, the token, or any private id.
 *   - Never calls fetchWereadAiSummary or fetchWereadRelatedBooks.
 *   - Never persists state to localStorage / sessionStorage / IndexedDB
 *     / server / external calendar.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CalendarClock, ChevronRight, Loader2, MapPin, RefreshCw, Sparkles } from "lucide-react";
import {
  fetchWereadReadingMap,
  type WereadReadingMapResponse,
} from "../wereadPrivate";
import {
  EMPTY_SESSION_THEME_OVERLAY,
  type WereadSessionThemeOverlay,
} from "./wereadSessionThemeModel";
import {
  REVIEW_DEFAULT_HORIZON,
  REVIEW_DEFAULT_RECOMMEND,
  REVIEW_HORIZON_OPTIONS,
  REVIEW_RECOMMEND_OPTIONS,
  type ReadingReviewBookTask,
  type ReadingReviewCalendar,
  type ReadingReviewDay,
  type ReadingReviewPriority,
  type ReadingReviewTask,
  type ReadingReviewThemeTask,
  type ReviewHorizonDays,
  type ReviewRecommendCount,
  buildReadingReviewCalendar,
  formatReviewCalendarSummary,
  formatReviewDate,
  formatReviewPriorityLabel,
  formatReviewReason,
  hasReviewCalendarData,
} from "./wereadReviewCalendarModel";

const NOW_INJECTION = () => new Date();

export interface ReviewCalendarDashboardProps {
  token: string;
  active: boolean;
  sessionThemeOverlay: WereadSessionThemeOverlay;
}

interface DashboardState {
  response: WereadReadingMapResponse | null;
  status: "idle" | "loading" | "ok" | "error";
  error: string | null;
  horizon: ReviewHorizonDays;
  recommend: ReviewRecommendCount;
}

const INITIAL_STATE: DashboardState = {
  response: null,
  status: "idle",
  error: null,
  horizon: REVIEW_DEFAULT_HORIZON,
  recommend: REVIEW_DEFAULT_RECOMMEND,
};

const PRIORITY_LABEL: Record<ReadingReviewPriority, string> = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级",
};

const PRIORITY_RANK: Record<ReadingReviewPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

function formatShortDate(iso: string): string {
  return iso.slice(5);
}

function isToday(iso: string, now: Date): boolean {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return iso === `${y}-${m}-${d}`;
}

function rankTask(task: ReadingReviewTask): number {
  if (task.kind === "book") return PRIORITY_RANK[task.priority];
  return -1;
}

export default function ReviewCalendarDashboard({
  token,
  active,
  sessionThemeOverlay,
}: ReviewCalendarDashboardProps) {
  const [state, setState] = useState<DashboardState>(INITIAL_STATE);
  const abortRef = useRef<AbortController | null>(null);
  const lastRequestTokenRef = useRef<string>("");

  const overlay: WereadSessionThemeOverlay = sessionThemeOverlay ?? EMPTY_SESSION_THEME_OVERLAY;

  // Reset on token change.
  useEffect(() => {
    if (!token) {
      abortRef.current?.abort();
      lastRequestTokenRef.current = "";
      setState(INITIAL_STATE);
      return;
    }
    lastRequestTokenRef.current = "";
    setState((prev) => ({ ...prev, response: null, status: "idle", error: null }));
  }, [token]);

  // Load once per token, only after the tab is activated.
  useEffect(() => {
    if (!token) return;
    if (!active) return;
    if (state.response || state.status === "loading") return;
    if (lastRequestTokenRef.current === token) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastRequestTokenRef.current = token;
    setState((prev) => ({ ...prev, status: "loading", error: null }));
    fetchWereadReadingMap(token, {
      months: 36,
      topBooks: 18,
      signal: controller.signal,
    })
      .then((resp) => {
        setState((prev) => ({ ...prev, response: resp, status: "ok" }));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "阅读地图加载失败";
        setState((prev) => ({ ...prev, status: "error", error: msg, response: null }));
      });
  }, [active, token, state.response, state.status]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const calendar: ReadingReviewCalendar | null = useMemo(() => {
    if (!state.response) return null;
    return buildReadingReviewCalendar({
      response: state.response,
      overlay,
      now: NOW_INJECTION(),
      horizonDays: state.horizon,
      recommendCount: state.recommend,
    });
  }, [state.response, state.horizon, state.recommend, overlay]);

  const today = useMemo(() => new Date(), []);
  const summary = calendar ? formatReviewCalendarSummary(calendar) : "";

  const handleRetry = useCallback(() => {
    if (!token) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    lastRequestTokenRef.current = "";
    setState((prev) => ({ ...prev, status: "loading", error: null }));
    fetchWereadReadingMap(token, {
      months: 36,
      topBooks: 18,
      signal: controller.signal,
    })
      .then((resp) => {
        setState((prev) => ({ ...prev, response: resp, status: "ok" }));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "阅读地图加载失败";
        setState((prev) => ({ ...prev, status: "error", error: msg, response: null }));
      });
  }, [token]);

  // ------------------------------------------------------------------
  // Render: not yet activated → empty
  // ------------------------------------------------------------------
  if (!active) {
    return (
      <section
        className="weread-review-calendar weread-review-calendar--empty"
        data-testid="weread-review-calendar"
        aria-label="复习日历"
      >
        <p className="weread-review-calendar__empty-hint">点击上方"复习日历"工作区后开始加载。</p>
      </section>
    );
  }

  // ------------------------------------------------------------------
  // Render: loading
  // ------------------------------------------------------------------
  if (state.status === "loading" && !state.response) {
    return (
      <section
        className="weread-review-calendar"
        data-testid="weread-review-calendar"
        data-status="loading"
        aria-label="复习日历"
      >
        <header className="weread-review-calendar__header">
          <h2>
            <CalendarClock size={16} aria-hidden="true" /> 复习日历
          </h2>
        </header>
        <p className="weread-review-calendar__loading">
          <Loader2 size={14} className="spin" aria-hidden="true" /> 正在生成复习日历…
        </p>
      </section>
    );
  }

  // ------------------------------------------------------------------
  // Render: error
  // ------------------------------------------------------------------
  if (state.status === "error" && !state.response) {
    return (
      <section
        className="weread-review-calendar weread-review-calendar--error"
        data-testid="weread-review-calendar"
        data-status="error"
        aria-label="复习日历"
      >
        <header className="weread-review-calendar__header">
          <h2>
            <CalendarClock size={16} aria-hidden="true" /> 复习日历
          </h2>
        </header>
        <p className="weread-review-calendar__notice weread-review-calendar__notice--error">
          <AlertCircle size={14} aria-hidden="true" /> 复习日历加载失败，请稍后重试。
        </p>
        <button
          type="button"
          className="weread-review-calendar__retry"
          onClick={handleRetry}
          data-testid="weread-review-calendar-retry"
        >
          <RefreshCw size={14} aria-hidden="true" /> 重新加载
        </button>
      </section>
    );
  }

  const cal = calendar;

  // ------------------------------------------------------------------
  // Render: loaded (possibly empty)
  // ------------------------------------------------------------------
  return (
    <section
      className="weread-review-calendar"
      data-testid="weread-review-calendar"
      data-status={state.status}
      aria-label="复习日历"
    >
      <header className="weread-review-calendar__header">
        <h2>
          <CalendarClock size={16} aria-hidden="true" /> 复习日历
        </h2>
        <p className="weread-review-calendar__notice" data-testid="weread-review-calendar-notice">
          <Sparkles size={14} aria-hidden="true" />
          复习日历仅使用阅读日期、笔记数量、公共书目元数据和当前会话主题生成。不会读取笔记正文，不会调用外部 AI，也不会同步到系统日历。
        </p>
        <p className="weread-review-calendar__persistence" data-testid="weread-review-calendar-persistence">
          当前版本提供建议日程，不保存完成状态；刷新页面后会根据最新数据重新生成。
        </p>
      </header>

      <div className="weread-review-calendar__controls" data-testid="weread-review-calendar-controls">
        <fieldset className="weread-review-calendar__control">
          <legend>展望天数</legend>
          {REVIEW_HORIZON_OPTIONS.map((h) => (
            <label key={h}>
              <input
                type="radio"
                name="weread-review-horizon"
                value={h}
                checked={state.horizon === h}
                onChange={() => setState((prev) => ({ ...prev, horizon: h }))}
                data-testid={`weread-review-horizon-${h}`}
              />
              <span>{h} 天</span>
            </label>
          ))}
        </fieldset>
        <fieldset className="weread-review-calendar__control">
          <legend>推荐书目数</legend>
          {REVIEW_RECOMMEND_OPTIONS.map((r) => (
            <label key={r}>
              <input
                type="radio"
                name="weread-review-recommend"
                value={r}
                checked={state.recommend === r}
                onChange={() => setState((prev) => ({ ...prev, recommend: r }))}
                data-testid={`weread-review-recommend-${r}`}
              />
              <span>{r}</span>
            </label>
          ))}
        </fieldset>
      </div>

      {cal ? (
        <>
          <div className="weread-review-calendar__overview" data-testid="weread-review-calendar-overview">
            <OverviewCard label="今日建议" value={countForToday(cal.days, today)} hint={todayLabel(today)} />
            <OverviewCard label="未来 7 天" value={countNextDays(cal.days, today, 7)} hint="含今日" />
            <OverviewCard label="书目复习任务" value={cal.meta.bookTasks} hint={`共考虑 ${cal.meta.booksConsidered} 本`} />
            <OverviewCard label="当前会话主题" value={cal.meta.themeTasks} hint={overlay.enabled ? "已应用主题层" : "暂无主题"} />
            <OverviewCard label="高优先级任务" value={countHighPriority(cal.tasks)} hint="high" />
            <OverviewCard label="缺少日期的书目" value={cal.unscheduledBooks.length} hint="将显示在下方" />
          </div>

          <h3 className="weread-review-calendar__section-title">
            <CalendarClock size={14} aria-hidden="true" /> 未来 {cal.horizonDays} 天日历
          </h3>
          <p className="weread-review-calendar__summary">{summary}</p>

          {cal.tasks.length === 0 ? (
            <p className="weread-review-calendar__empty">
              {overlay.enabled
                ? "当前暂无可用于生成书目复习计划的已匹配记录；以下为本会话主题任务。"
                : "当前暂无可用于生成书目复习计划的已匹配记录。生成 AI 摘要后，可将当前会话主题加入复习日历。"}
            </p>
          ) : (
            <ul
              className="weread-review-calendar__grid"
              data-testid="weread-review-calendar-grid"
            >
              {cal.days.map((day) => (
                <DayCell key={day.date} day={day} today={today} />
              ))}
            </ul>
          )}

          {cal.meta.bookTasks > 0 ? (
            <>
              <h3 className="weread-review-calendar__section-title">
                <MapPin size={14} aria-hidden="true" /> 优先复习队列
              </h3>
              <ul
                className="weread-review-calendar__queue"
                data-testid="weread-review-calendar-queue"
              >
                {cal.tasks
                  .filter((t): t is ReadingReviewBookTask => t.kind === "book")
                  .map((task) => (
                    <li
                      key={task.id}
                      className={`weread-review-book-card weread-review-book-card--${task.priority}`}
                      data-priority={task.priority}
                    >
                      <div className="weread-review-book-card__title">
                        <a
                          href={`/books/${task.catalogId}`}
                          className="weread-review-book-card__link"
                          data-testid="weread-review-book-link"
                        >
                          {task.title}
                          <ChevronRight size={12} aria-hidden="true" />
                        </a>
                        {task.author ? (
                          <span className="weread-review-book-card__author">{task.author}</span>
                        ) : null}
                      </div>
                      <div className="weread-review-book-card__meta">
                        <span className={`weread-review-book-card__pill weread-review-book-card__pill--${task.priority}`}>
                          {PRIORITY_LABEL[task.priority]} · {formatReviewPriorityLabel(task.priority)}
                        </span>
                        <span>建议日期 {formatReviewDate(task.suggestedDate)}</span>
                        <span>笔记 {task.noteCount}</span>
                        <span>活跃月份 {task.activeMonths}</span>
                        <span>最后阅读 {formatReviewDate(task.lastNoteAt)}</span>
                      </div>
                      <ul className="weread-review-book-card__reasons">
                        {task.reasonCodes.map((code) => (
                          <li key={code} className="weread-review-book-card__reason">
                            {formatReviewReason(code)}
                          </li>
                        ))}
                      </ul>
                      <div className="weread-review-book-card__actions">
                        <a
                          href={`/books/${task.catalogId}`}
                          className="weread-review-book-card__cta"
                          data-testid="weread-review-book-cta"
                        >
                          查看书目
                          <ChevronRight size={12} aria-hidden="true" />
                        </a>
                        {task.sessionRelevant ? (
                          <span
                            className="weread-review-book-card__pill weread-review-book-card__pill--session"
                            data-testid="weread-review-book-session"
                          >
                            当前会话涉及
                          </span>
                        ) : null}
                      </div>
                    </li>
                  ))}
              </ul>
            </>
          ) : null}

          {overlay.enabled && cal.meta.themeTasks > 0 ? (
            <>
              <h3 className="weread-review-calendar__section-title">
                <Sparkles size={14} aria-hidden="true" /> 本次会话主题
              </h3>
              <p className="weread-review-calendar__theme-hint">
                主题任务只用于当前浏览器会话，不代表主题与某本书存在确定关系。
              </p>
              <ul
                className="weread-review-calendar__themes"
                data-testid="weread-review-calendar-themes"
              >
                {cal.tasks
                  .filter((t): t is ReadingReviewThemeTask => t.kind === "theme")
                  .map((task) => (
                    <li
                      key={task.id}
                      className={`weread-review-theme-chip weread-review-theme-chip--${task.source}`}
                    >
                      <span className="weread-review-theme-chip__label">{task.label}</span>
                      <span className="weread-review-theme-chip__date">建议 {formatReviewDate(task.suggestedDate)}</span>
                    </li>
                  ))}
              </ul>
            </>
          ) : null}

          {overlay.enabled && cal.meta.themeTasks === 0 ? (
            <p className="weread-review-calendar__theme-empty">
              生成 AI 摘要后，可将当前会话主题加入复习日历。
            </p>
          ) : null}

          {cal.unscheduledBooks.length > 0 ? (
            <>
              <h3 className="weread-review-calendar__section-title">缺少可用的最后阅读日期</h3>
              <p className="weread-review-calendar__unscheduled-hint">
                以下书目在阅读地图中没有可用的最后阅读日期，无法生成复习建议。
              </p>
              <ul
                className="weread-review-calendar__unscheduled"
                data-testid="weread-review-calendar-unscheduled"
              >
                {cal.unscheduledBooks.map((b) => (
                  <li key={b.catalogId} className="weread-review-calendar__unscheduled-item">
                    <span className="weread-review-calendar__unscheduled-title">{b.title}</span>
                    <a
                      href={`/books/${b.catalogId}`}
                      className="weread-review-calendar__unscheduled-link"
                    >
                      查看书目
                      <ChevronRight size={12} aria-hidden="true" />
                    </a>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        <p className="weread-review-calendar__empty">尚未生成复习日历。</p>
      )}
    </section>
  );
}

// ---------- subcomponents ----------

function OverviewCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <div className="weread-review-calendar__overview-card">
      <span className="weread-review-calendar__overview-label">{label}</span>
      <span className="weread-review-calendar__overview-value">{value}</span>
      {hint ? <span className="weread-review-calendar__overview-hint">{hint}</span> : null}
    </div>
  );
}

function DayCell({ day, today }: { day: ReadingReviewDay; today: Date }) {
  const sorted = [...day.tasks].sort((a, b) => {
    const ra = rankTask(a);
    const rb = rankTask(b);
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const head = sorted.slice(0, 3);
  const more = sorted.length - head.length;
  const isTodayCell = isToday(day.date, today);
  return (
    <li
      className={`weread-review-day ${isTodayCell ? "weread-review-day--today" : ""}`}
      data-date={day.date}
      data-count={day.tasks.length}
    >
      <div className="weread-review-day__date">
        {formatShortDate(day.date)}
        {isTodayCell ? <span className="weread-review-day__today-pill">今日</span> : null}
      </div>
      <div className="weread-review-day__count">{day.tasks.length} 项</div>
      <ul className="weread-review-day__tasks">
        {head.map((task) => (
          <DayTaskRow key={task.id} task={task} />
        ))}
        {more > 0 ? (
          <li className="weread-review-task weread-review-task--more">另有 {more} 项</li>
        ) : null}
      </ul>
    </li>
  );
}

function DayTaskRow({ task }: { task: ReadingReviewTask }) {
  if (task.kind === "theme") {
    return (
      <li className="weread-review-task weread-review-task--theme" data-kind="theme">
        <span className="weread-review-task__label">{task.label}</span>
        <span className="weread-review-task__source">{task.source === "theme" ? "主题" : "方向"}</span>
      </li>
    );
  }
  return (
    <li
      className={`weread-review-task weread-review-task--book weread-review-task--${task.priority}`}
      data-kind="book"
      data-priority={task.priority}
    >
      <a href={`/books/${task.catalogId}`} className="weread-review-task__label">
        {task.title}
      </a>
      <span className="weread-review-task__priority">{formatReviewPriorityLabel(task.priority)}</span>
    </li>
  );
}

// ---------- summary helpers ----------

function countForToday(days: ReadonlyArray<ReadingReviewDay>, today: Date): number {
  const target = isTodayString(days, today);
  if (!target) return 0;
  return target.tasks.length;
}

function isTodayString(days: ReadonlyArray<ReadingReviewDay>, today: Date): ReadingReviewDay | null {
  for (const d of days) {
    if (isToday(d.date, today)) return d;
  }
  return null;
}

function countNextDays(
  days: ReadonlyArray<ReadingReviewDay>,
  today: Date,
  span: number
): number {
  const y = today.getUTCFullYear();
  const m = String(today.getUTCMonth() + 1).padStart(2, "0");
  const d = String(today.getUTCDate()).padStart(2, "0");
  const startKey = `${y}-${m}-${d}`;
  const startIdx = days.findIndex((day) => day.date === startKey);
  if (startIdx < 0) return 0;
  let total = 0;
  for (let i = 0; i < span; i += 1) {
    const idx = startIdx + i;
    if (idx >= days.length) break;
    total += days[idx].tasks.length;
  }
  return total;
}

function countHighPriority(tasks: ReadonlyArray<ReadingReviewTask>): number {
  return tasks.filter(
    (task): task is ReadingReviewBookTask => task.kind === "book" && task.priority === "high"
  ).length;
}

function todayLabel(today: Date): string {
  return `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-${String(today.getUTCDate()).padStart(2, "0")}`;
}

// silence unused
void hasReviewCalendarData;