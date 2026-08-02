import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, BookOpen, EyeOff, Loader2, Map, RefreshCw, Shield, Sparkles, Eye } from "lucide-react";
import {
  fetchWereadReadingMap,
  type WereadReadingMapResponse,
} from "../wereadPrivate";
import {
  READING_MAP_VIEWBOX,
  RADIUS_LIMITS,
  TIMELINE_PADDING,
  TIMELINE_VIEWBOX_HEIGHT,
  annotateSessionEdges,
  annotateSessionNodes,
  applySessionFocus,
  buildReadingMapEdgeLayout,
  buildReadingMapNodeLayout,
  buildTimelineBarModel,
  formatReadingMapDateRange,
  formatReadingMapMonth,
  formatReadingMapOverview,
  getReadingMapLinkLabel,
  truncateReadingMapTitle,
  type EdgeLayout,
  type NodeLayout,
  type ReadingMapOverviewView,
  type TimelineBar,
  type TimelineBarModel,
} from "./wereadReadingMapModel";
import {
  EMPTY_SESSION_THEME_OVERLAY,
  formatSessionOverlaySummary,
  type WereadSessionThemeOverlay,
} from "./wereadSessionThemeModel";

const PRIVACY_NOTICE =
  "阅读地图仅使用笔记日期、类型和已确认的公共书目匹配关系生成，不读取或展示笔记正文，也不会调用外部 AI。";

const MONTH_OPTIONS: Array<{ value: 6 | 12 | 24 | 36; label: string }> = [
  { value: 6, label: "近 6 个月" },
  { value: 12, label: "近 12 个月" },
  { value: 24, label: "近 24 个月" },
  { value: 36, label: "近 36 个月" },
];

const TOP_BOOK_OPTIONS: Array<{ value: 6 | 12 | 18; label: string }> = [
  { value: 6, label: "前 6 本" },
  { value: 12, label: "前 12 本" },
  { value: 18, label: "前 18 本" },
];

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "—";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="weread-reading-map__overview-cell" role="group" aria-label={label}>
      <span className="weread-reading-map__overview-label">{label}</span>
      <span className="weread-reading-map__overview-value">{value}</span>
    </div>
  );
}

interface TimelineBarProps {
  bar: TimelineBar;
  index: number;
  stepX: number;
  innerWidth: number;
  innerHeight: number;
  isMax: boolean;
}

function TimelineBarSvg({ bar, index, stepX, innerWidth, innerHeight, isMax }: TimelineBarProps) {
  const x = TIMELINE_PADDING.left + stepX * index + stepX / 2;
  const barWidth = Math.max(2, stepX * 0.7);
  const fullHeight = innerHeight;
  const heightPx = (bar.heightPct / 100) * fullHeight;
  const y = TIMELINE_PADDING.top + innerHeight - heightPx;
  // Show short month label only every Nth bar to avoid overlap.
  const showLabel = innerWidth / stepX <= 12 || index % Math.ceil(12 / Math.max(1, Math.floor(innerWidth / stepX / 4))) === 0;
  const tooltip = `${formatReadingMapMonth(bar.month)} · ${bar.total} 条（${bar.highlights} 划线 / ${bar.thoughts} 想法 / ${bar.reviews} 书评 / ${bar.unknown} 未知）· 已匹配 ${bar.matched}`;
  return (
    <g>
      <rect
        x={x - barWidth / 2}
        y={y}
        width={barWidth}
        height={Math.max(1, heightPx)}
        rx={2}
        ry={2}
        className={`weread-reading-map__timeline-bar ${isMax ? "weread-reading-map__timeline-bar--peak" : ""}`}
        role="img"
        aria-label={tooltip}
      >
        <title>{tooltip}</title>
      </rect>
      {showLabel ? (
        <text
          x={x}
          y={TIMELINE_PADDING.top + innerHeight + 14}
          textAnchor="middle"
          className="weread-reading-map__timeline-label"
        >
          {bar.month.slice(5)}
        </text>
      ) : null}
    </g>
  );
}

function TimelineBars({ model }: { model: TimelineBarModel }) {
  const innerWidth = model.width - TIMELINE_PADDING.left - TIMELINE_PADDING.right;
  const innerHeight = TIMELINE_VIEWBOX_HEIGHT - TIMELINE_PADDING.top - TIMELINE_PADDING.bottom;
  const peak = model.maxTotal;
  return (
    <svg
      className="weread-reading-map__timeline-svg"
      viewBox={`0 0 ${model.width} ${TIMELINE_VIEWBOX_HEIGHT}`}
      width="100%"
      height="220"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="月度笔记时间轴"
    >
      <line
        x1={TIMELINE_PADDING.left}
        y1={TIMELINE_PADDING.top + innerHeight + 0.5}
        x2={TIMELINE_PADDING.left + innerWidth}
        y2={TIMELINE_PADDING.top + innerHeight + 0.5}
        className="weread-reading-map__timeline-axis"
      />
      {model.bars.map((bar, idx) => (
        <TimelineBarSvg
          key={bar.month}
          bar={bar}
          index={idx}
          stepX={model.stepX}
          innerWidth={innerWidth}
          innerHeight={innerHeight}
          isMax={peak > 0 && bar.total === peak}
        />
      ))}
    </svg>
  );
}

function NetworkGraph({
  nodes,
  edges,
  empty,
  focusMode,
}: {
  nodes: NodeLayout[];
  edges: EdgeLayout[];
  empty: boolean;
  focusMode: "full" | "session";
}) {
  if (empty) {
    return (
      <div className="weread-reading-map__empty" role="status">
        当前暂无足够的已匹配书目关系。
      </div>
    );
  }
  return (
    <svg
      className="weread-reading-map__network-svg"
      viewBox={`0 0 ${READING_MAP_VIEWBOX.network.width} ${READING_MAP_VIEWBOX.network.height}`}
      width="100%"
      height="520"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="同期阅读书目关系网络"
    >
      {edges.map((edge) => {
        const strokeWidth = Math.max(0.6, Math.min(3, Math.log2(Math.max(1, edge.sharedMonths)) + 0.6));
        const label = getReadingMapLinkLabel({
          sourceCatalogId: edge.sourceCatalogId,
          targetCatalogId: edge.targetCatalogId,
          sharedMonths: edge.sharedMonths,
          weight: edge.weight,
        });
        const edgeClass = [
          "weread-reading-map__network-edge",
          edge.isSessionRelated ? "weread-reading-map__link--session" : "",
          edge.isDimmed ? "weread-reading-map__link--dimmed" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <g key={`${edge.sourceCatalogId}-${edge.targetCatalogId}`}>
            <line
              x1={edge.x1}
              y1={edge.y1}
              x2={edge.x2}
              y2={edge.y2}
              strokeWidth={strokeWidth}
              className={edgeClass}
            />
            <text
              x={edge.midX}
              y={edge.midY - 4}
              textAnchor="middle"
              className="weread-reading-map__network-edge-label"
            >
              {label}
            </text>
          </g>
        );
      })}
      {nodes.map((node) => {
        const title = truncateReadingMapTitle(node.title, 12);
        const href = `/books/${node.catalogId}`;
        const nodeClass = [
          "weread-reading-map__network-node",
          node.isSession ? "weread-reading-map__node--session" : "",
          node.isDimmed ? "weread-reading-map__node--dimmed" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <g key={node.catalogId}>
            <a href={href} aria-label={`查看 ${title || node.catalogId}`}>
              <circle
                cx={node.x}
                cy={node.y}
                r={node.radius}
                className={nodeClass}
              >
                <title>{`${title || node.catalogId}${node.author ? " · " + node.author : ""}（${node.noteCount} 条笔记 / ${node.activeMonths} 个月）`}</title>
              </circle>
              <text
                x={node.x}
                y={node.y + node.radius + 12}
                textAnchor="middle"
                className="weread-reading-map__network-node-label"
              >
                {title}
              </text>
            </a>
          </g>
        );
      })}
    </svg>
  );
}

function BookCard({ book, isSession }: { book: import("../wereadPrivate").WereadReadingMapBook; isSession: boolean }) {
  const cardClass = [
    "weread-reading-map__book-card",
    isSession ? "weread-reading-map__node--session" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <a className={cardClass} href={`/books/${book.catalogId}`}>
      <span className="weread-reading-map__book-card-title">{truncateReadingMapTitle(book.title, 32) || `书目 ${book.catalogId}`}</span>
      <span className="weread-reading-map__book-card-meta">
        {book.author ? book.author : "—"}
        <span className="weread-reading-map__book-card-sep">·</span>
        {book.noteCount} 条笔记
        <span className="weread-reading-map__book-card-sep">·</span>
        {book.activeMonths} 个月活跃
      </span>
      <span className="weread-reading-map__book-card-dates">
        {formatDate(book.firstNoteAt)} → {formatDate(book.lastNoteAt)}
      </span>
    </a>
  );
}

function SessionThemeOverlay({
  overlay,
  focusMode,
  onToggleFocus,
  onClearFocus,
}: {
  overlay: WereadSessionThemeOverlay;
  focusMode: "full" | "session";
  onToggleFocus: () => void;
  onClearFocus: () => void;
}) {
  if (!overlay) return null;

  // State 1: no AI summary yet — show the hint, no chips, no toggle.
  if (!overlay.enabled) {
    return (
      <section
        className="weread-session-theme weread-session-theme--empty"
        data-testid="weread-session-theme-empty"
        aria-label="当前会话主题层"
      >
        <header className="weread-session-theme__header">
          <h3 className="weread-session-theme__title">
            <Sparkles size={14} aria-hidden="true" /> 当前会话主题层
          </h3>
          <p className="weread-session-theme__summary">
            在『笔记与 AI』中生成摘要后，可在这里聚焦当前会话。
          </p>
        </header>
      </section>
    );
  }

  const hasCatalogIds = overlay.catalogIds.length > 0;

  return (
    <section
      className="weread-session-theme"
      data-testid="weread-session-theme"
      aria-label="当前会话主题层"
    >
      <header className="weread-session-theme__header">
        <h3 className="weread-session-theme__title">
          <Sparkles size={14} aria-hidden="true" /> 当前会话主题层
        </h3>
        <p className="weread-session-theme__summary" data-testid="weread-session-theme-summary">
          {formatSessionOverlaySummary(overlay)}
        </p>
        <p className="weread-session-theme__notice">
          主题层只来自当前浏览器会话中已经生成的 AI 摘要，不会再次调用 MiniMax，也不会保存到服务器。
        </p>
      </header>

      {overlay.themes.length > 0 ? (
        <ul className="weread-session-theme__chips" data-testid="weread-session-theme-chips">
          {overlay.themes.map((t) => (
            <li
              key={t.id}
              className={`weread-session-theme__chip weread-session-theme__chip--${t.source}`}
              data-testid="weread-session-theme-chip"
              data-theme-source={t.source}
            >
              <span className="weread-session-theme__chip-label">{t.label}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {!hasCatalogIds ? (
        <p
          className="weread-session-theme__hint"
          data-testid="weread-session-theme-empty-books"
        >
          当前已加载笔记没有可映射到阅读地图的公共书目。
        </p>
      ) : (
        <div className="weread-session-theme__actions" data-testid="weread-session-theme-actions">
          <button
            type="button"
            className={`weread-session-theme__primary ${focusMode === "session" ? "weread-session-theme__primary--active" : ""}`}
            onClick={onToggleFocus}
            aria-pressed={focusMode === "session"}
            data-testid="weread-session-theme-focus-toggle"
          >
            <Eye size={14} aria-hidden="true" />
            {focusMode === "session" ? "退出聚焦当前会话" : "聚焦当前会话"}
          </button>
          {focusMode === "session" ? (
            <button
              type="button"
              className="weread-session-theme__secondary"
              onClick={onClearFocus}
              data-testid="weread-session-theme-clear-focus"
            >
              清除聚焦
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

export interface ReadingMapDashboardProps {
  token: string;
  /** Called when the user clears the token so the parent can also clear its state. */
  onAbort?: () => void;
  /**
   * S27H-2: a safe, lifted session-theme overlay derived from the notes
   * workspace. Carries only theme titles / directions / public catalogIds
   * / notesUsed. The dashboard uses it to draw the focus ring without
   * ever seeing note text, comment, overview, key points, token, or
   * private IDs.
   */
  sessionThemeOverlay?: WereadSessionThemeOverlay;
}

export default function ReadingMapDashboard({
  token,
  onAbort,
  sessionThemeOverlay,
}: ReadingMapDashboardProps) {
  const [months, setMonths] = useState<6 | 12 | 24 | 36>(24);
  const [topBooks, setTopBooks] = useState<6 | 12 | 18>(12);
  const [response, setResponse] = useState<WereadReadingMapResponse | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ok" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState<"full" | "session">("full");
  const abortRef = useRef<AbortController | null>(null);

  const load = (m: 6 | 12 | 24 | 36, t: 6 | 12 | 18) => {
    // Cancel any in-flight request before starting a new one.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setStatus("loading");
    setError(null);
    fetchWereadReadingMap(token, { months: m, topBooks: t, signal: controller.signal })
      .then((resp) => {
        setResponse(resp);
        setStatus("ok");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "阅读地图加载失败";
        setStatus("error");
        setError(msg);
        setResponse(null);
      });
  };

  // First-time load — only when this component becomes active.
  useEffect(() => {
    if (!token) {
      setResponse(null);
      setStatus("idle");
      return;
    }
    load(months, topBooks);
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Token cleared → abort in-flight + clear local state.
  useEffect(() => {
    if (!token) {
      abortRef.current?.abort();
      setResponse(null);
      setStatus("idle");
      setError(null);
      setFocusMode("full");
      onAbort?.();
    }
  }, [token, onAbort]);

  const overview: ReadingMapOverviewView = useMemo(
    () => formatReadingMapOverview(response?.overview ?? null),
    [response]
  );

  const timelineModel = useMemo(
    () => buildTimelineBarModel(response?.timeline ?? [], months),
    [response, months]
  );

  const rawNodes = useMemo(
    () => buildReadingMapNodeLayout({ books: response?.books ?? [] }),
    [response]
  );

  const rawEdges = useMemo(
    () => buildReadingMapEdgeLayout({ links: response?.links ?? [], nodes: rawNodes }),
    [response, rawNodes]
  );

  const overlay: WereadSessionThemeOverlay = sessionThemeOverlay ?? EMPTY_SESSION_THEME_OVERLAY;
  const nodes = useMemo(
    () => applySessionFocus(annotateSessionNodes(rawNodes, overlay), focusMode, overlay),
    [rawNodes, overlay, focusMode]
  );
  const edges = useMemo(
    () => applySessionFocus(annotateSessionEdges(rawEdges, overlay), focusMode, overlay),
    [rawEdges, overlay, focusMode]
  );

  const sessionBookIds = useMemo(() => new Set(overlay.catalogIds), [overlay.catalogIds]);

  const emptyNetwork = rawNodes.length === 0;

  return (
    <section className="weread-reading-map" data-testid="weread-reading-map" aria-label="个人阅读地图">
      <header className="weread-reading-map__header">
        <h2 className="weread-reading-map__title">
          <Map size={18} aria-hidden="true" /> 个人阅读地图
        </h2>
        <div className="weread-reading-map__controls" role="group" aria-label="阅读地图范围与书目数量">
          <label className="weread-reading-map__control-label" htmlFor="weread-reading-map-months">
            时间范围
          </label>
          <select
            id="weread-reading-map-months"
            className="weread-reading-map__select"
            value={months}
            onChange={(e) => {
              const v = Number(e.target.value) as 6 | 12 | 24 | 36;
              setMonths(v);
              load(v, topBooks);
            }}
            disabled={status === "loading"}
          >
            {MONTH_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <label className="weread-reading-map__control-label" htmlFor="weread-reading-map-topbooks">
            书目数量
          </label>
          <select
            id="weread-reading-map-topbooks"
            className="weread-reading-map__select"
            value={topBooks}
            onChange={(e) => {
              const v = Number(e.target.value) as 6 | 12 | 18;
              setTopBooks(v);
              load(months, v);
            }}
            disabled={status === "loading"}
          >
            {TOP_BOOK_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="weread-reading-map__refresh"
            onClick={() => load(months, topBooks)}
            disabled={status === "loading"}
            aria-label="重新加载阅读地图"
          >
            {status === "loading" ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />} 刷新
          </button>
        </div>
      </header>

      <div className="weread-reading-map__notice" role="note">
        <Shield size={14} aria-hidden="true" />
        <span>{PRIVACY_NOTICE}</span>
      </div>

      <SessionThemeOverlay
        overlay={overlay}
        focusMode={focusMode}
        onToggleFocus={() =>
          setFocusMode((prev) => (prev === "session" ? "full" : "session"))
        }
        onClearFocus={() => setFocusMode("full")}
      />

      {status === "error" ? (
        <div className="weread-reading-map__error" role="alert">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{error ?? "阅读地图加载失败，请稍后再试。"}</span>
          <button type="button" onClick={() => load(months, topBooks)}>
            <RefreshCw size={12} /> 重试
          </button>
        </div>
      ) : null}

      {status === "loading" && !response ? (
        <div className="weread-reading-map__loading" role="status">
          <Loader2 size={14} className="spin" /> 阅读地图加载中…
        </div>
      ) : null}

      {response ? (
        <>
          <section className="weread-reading-map__overview" aria-label="阅读历史概览">
            <StatBlock label="首条笔记日期" value={formatDate(response.overview.firstNoteAt)} />
            <StatBlock label="最近笔记日期" value={formatDate(response.overview.lastNoteAt)} />
            <StatBlock label="活跃月份" value={overview.activeMonths} />
            <StatBlock label="当前连续" value={`${overview.currentStreakMonths} 个月`} />
            <StatBlock label="最长连续" value={`${overview.longestStreakMonths} 个月`} />
            <StatBlock label="已匹配笔记记录" value={overview.matchedNoteRecordsCount} />
          </section>

          <section className="weread-reading-map__timeline" aria-label="月度阅读时间轴">
            <header className="weread-reading-map__timeline-header">
              <h3>
                <Sparkles size={14} aria-hidden="true" /> 月度阅读时间轴
              </h3>
              <span className="weread-reading-map__timeline-range">
                {formatReadingMapDateRange(
                  response.timeline[0]?.month
                    ? `${response.timeline[0].month}-01T00:00:00.000Z`
                    : null,
                  response.timeline[response.timeline.length - 1]?.month
                    ? `${response.timeline[response.timeline.length - 1].month}-28T00:00:00.000Z`
                    : null
                )}
              </span>
            </header>
            {timelineModel.hasAnyActivity ? (
              <TimelineBars model={timelineModel} />
            ) : (
              <div className="weread-reading-map__empty" role="status">
                当前选择范围内暂无月度笔记记录。
              </div>
            )}
            <ol className="weread-reading-map__timeline-list" aria-label="按月份汇总（无障碍后备）">
              {timelineModel.bars.map((bar) => (
                <li key={bar.month}>
                  <span className="weread-reading-map__timeline-list-month">{formatReadingMapMonth(bar.month)}</span>
                  <span className="weread-reading-map__timeline-list-total">{bar.total}</span>
                  <span className="weread-reading-map__timeline-list-meta">
                    划线 {bar.highlights} · 想法 {bar.thoughts} · 书评 {bar.reviews} · 已匹配 {bar.matched}
                  </span>
                </li>
              ))}
            </ol>
          </section>

          <div className="weread-reading-map__network-block">
            <section className="weread-reading-map__network" aria-label="阅读星图">
              <header className="weread-reading-map__network-header">
                <h3>
                  <BookOpen size={14} aria-hidden="true" /> 阅读星图
                </h3>
                <span className="weread-reading-map__network-meta">
                  节点大小 ∝ 笔记数；连线 = 同期活跃月份
                </span>
              </header>
              <NetworkGraph nodes={nodes} edges={edges} empty={emptyNetwork} focusMode={focusMode} />
              <p className="weread-reading-map__network-legend">
                节点半径区间 {RADIUS_LIMITS.MIN}–{RADIUS_LIMITS.MAX}px · 点击节点进入书目页
              </p>
            </section>

            <section className="weread-reading-map__book-grid" aria-label="高互动书目">
              <header className="weread-reading-map__book-grid-header">
                <h3>
                  <BookOpen size={14} aria-hidden="true" /> 高互动书目
                </h3>
                <span className="weread-reading-map__book-grid-meta">
                  {response.books.length} / {response.meta.topBooksRequested}
                </span>
              </header>
              {response.books.length === 0 ? (
                <div className="weread-reading-map__empty">暂无已匹配的公共书目。</div>
              ) : (
                <div className="weread-reading-map__book-grid-list">
                  {response.books.map((book) => (
                    <BookCard
                      key={book.catalogId}
                      book={book}
                      isSession={sessionBookIds.has(book.catalogId)}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>

          <section className="weread-reading-map__links" aria-label="同期阅读关系">
            <header className="weread-reading-map__links-header">
              <h3>同期阅读关系</h3>
              <span className="weread-reading-map__links-meta">
                {focusMode === "session" ? `${edges.length} / ${response.links.length} 条` : `${response.links.length} 条`}
              </span>
            </header>
            {response.links.length === 0 ? (
              <div className="weread-reading-map__empty">当前选择范围内暂无同期活跃的书目关系。</div>
            ) : edges.length === 0 ? (
              <div className="weread-reading-map__empty">当前会话书目之间暂无同期活跃关系。</div>
            ) : (
              <ul className="weread-reading-map__links-list">
                {edges.map((link) => {
                  const linkRow = response.links.find(
                    (l) => l.sourceCatalogId === link.sourceCatalogId && l.targetCatalogId === link.targetCatalogId
                  );
                  if (!linkRow) return null;
                  const source = response.books.find((b) => b.catalogId === link.sourceCatalogId);
                  const target = response.books.find((b) => b.catalogId === link.targetCatalogId);
                  return (
                    <li
                      key={`${link.sourceCatalogId}-${link.targetCatalogId}`}
                      className={link.isDimmed ? "weread-reading-map__link--dimmed" : link.isSessionRelated ? "weread-reading-map__link--session" : undefined}
                    >
                      <span className="weread-reading-map__links-pair">
                        <a href={`/books/${link.sourceCatalogId}`}>
                          {truncateReadingMapTitle(source?.title ?? link.sourceCatalogId, 22)}
                        </a>
                        <span className="weread-reading-map__links-arrow">↔</span>
                        <a href={`/books/${link.targetCatalogId}`}>
                          {truncateReadingMapTitle(target?.title ?? link.targetCatalogId, 22)}
                        </a>
                      </span>
                      <span className="weread-reading-map__links-strength">
                        {getReadingMapLinkLabel(linkRow)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <p className="weread-reading-map__privacy-footnote">
            <EyeOff size={12} aria-hidden="true" />
            所有展示仅基于笔记日期 / 类型 / 已确认书目映射。不显示笔记正文，不返回微信读书内部 ID。
          </p>
        </>
      ) : null}
    </section>
  );
}