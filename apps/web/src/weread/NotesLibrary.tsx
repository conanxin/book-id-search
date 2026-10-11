import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Copy, Download, Filter, Library, AlertCircle, Check, RefreshCw, Search, X } from "lucide-react";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import { getWebAuthAuthGeneration, getWebAuthSnapshot } from "../auth/session";
import NotesAiSummary from "./NotesAiSummary";
import BookNotesExportButton from "./BookNotesExportButton";
import {
  fetchWereadNotes,
  fetchWereadBookNotes,
  isValidWereadCatalogId,
  type WereadAiSummaryResult,
  type WereadNoteTypeFilter,
  type WereadNotesDaysFilter,
  type WereadNotesQuery,
  type WereadNotesLibrarySummary,
  type WereadNotesSort,
  type WereadNotesSearchInfo,
  type WereadPrivateNoteItem,
} from "../wereadPrivate";
import {
  buildMarkdownExport,
  buildMarkdownExportFilename,
  formatDaysLabel,
  formatNoteDate,
  formatNoteTypeLabel,
  formatNotesSummary,
  formatSortLabel,
  getFilterLabel,
  getNoteDisplayParts,
  highlightNoteTextParts,
  normalizeNoteSearchQuery,
  truncateNotePreview,
  wereadNotesScopeKey,
  type WereadNotesScope,
} from "./wereadNotesModel";
import "./wereadBookScope.css";
import {
  EMPTY_SESSION_THEME_OVERLAY,
  buildSessionThemeOverlay,
  sessionThemeOverlayKey,
  type WereadSessionThemeOverlay,
} from "./wereadSessionThemeModel";

const TYPE_OPTIONS: WereadNoteTypeFilter[] = ["all", "highlight", "thought", "review"];
const DAYS_OPTIONS: WereadNotesDaysFilter[] = ["all", "7", "30", "90"];
const SORT_OPTIONS: WereadNotesSort[] = ["newest", "oldest"];
const LIMIT_OPTIONS = [20, 50];

type LoadState = "idle" | "loading" | "ready" | "error";

interface NotesLibraryProps {
  scope?: WereadNotesScope;
  /**
   * S27H-2: notify the parent whenever the session-theme overlay derived
   * from the currently loaded notes + the most recent AI summary
   * changes. The parent (`WereadCenter`) keeps a single overlay state
   * that is shared with the reading-map dashboard.
   *
   * The overlay only carries: theme titles (≤6), reading-direction
   * titles (≤6), public catalogIds (≤100), and `notesUsed`. No note
   * text / comment / overview / key point / question / token / private
   * ID ever crosses this boundary.
   */
  onSessionOverlayChange?: (overlay: WereadSessionThemeOverlay) => void;
}

export default function NotesLibrary({ scope = { kind: "all" }, onSessionOverlayChange }: NotesLibraryProps) {
  const session = useWebAuthSession();
  if (session.status !== "authenticated") {
    return <p className="weread-notes-empty" role="status">登录后可查看微信读书笔记。</p>;
  }
  if (scope.kind === "invalid" || (scope.kind === "book" && !isValidWereadCatalogId(scope.catalogId))) {
    return <p className="weread-private-error" role="alert">书目筛选无效。请重新打开书籍，或明确清除本书筛选后查看全部笔记。</p>;
  }
  const catalogId = scope.kind === "book" ? scope.catalogId.trim() : undefined;
  const generation = getWebAuthAuthGeneration();
  return (
    <ScopedNotesLibrary
      key={`${generation}:${wereadNotesScopeKey(scope)}`}
      catalogId={catalogId}
      authGeneration={generation}
      onSessionOverlayChange={onSessionOverlayChange}
    />
  );
}

function ScopedNotesLibrary({ catalogId, authGeneration, onSessionOverlayChange }: {
  catalogId?: string;
  authGeneration: number;
  onSessionOverlayChange?: NotesLibraryProps["onSessionOverlayChange"];
}) {
  const [filterType, setFilterType] = useState<WereadNoteTypeFilter>("all");
  const [filterDays, setFilterDays] = useState<WereadNotesDaysFilter>("all");
  const [filterMatched, setFilterMatched] = useState<boolean>(false);
  const [filterSort, setFilterSort] = useState<WereadNotesSort>("newest");
  const [filterLimit, setFilterLimit] = useState<number>(20);

  // S27D: raw input vs normalized active query. Raw input preserves what the
  // user is typing; active query is the trimmed/non-empty form sent to the API.
  const [noteQueryInput, setNoteQueryInput] = useState<string>("");
  const [noteQuery, setNoteQuery] = useState<string>("");

  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  const [items, setItems] = useState<WereadPrivateNoteItem[]>([]);
  const [pageInfo, setPageInfo] = useState<{ limit: number; offset: number; total: number; hasMore: boolean } | null>(null);
  const [summary, setSummary] = useState<WereadNotesLibrarySummary | null>(null);
  const [searchInfo, setSearchInfo] = useState<WereadNotesSearchInfo | null>(null);

  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const copyTimerRef = useRef<number | null>(null);
  const [loadedQuery, setLoadedQuery] = useState<WereadNotesQuery | null>(null);

  // S27H-2: session-theme overlay state. The latest AI summary result
  // (themes + reading directions) plus the currently loaded items
  // (matched catalogIds) are all we need to build the overlay. We
  // never lift the raw items array up to WereadCenter or into the
  // reading-map dashboard.
  const [aiSummary, setAiSummary] = useState<{
    summary: WereadAiSummaryResult;
    itemsUsed: number;
  } | null>(null);
  const lastOverlayKeyRef = useRef<string>(sessionThemeOverlayKey(EMPTY_SESSION_THEME_OVERLAY));

  const overlay: WereadSessionThemeOverlay = useMemo(
    () =>
      buildSessionThemeOverlay({
        summary: aiSummary?.summary ?? null,
        items,
        notesUsed: aiSummary?.itemsUsed,
      }),
    [aiSummary, items]
  );

  // Notify the parent only when the overlay's structural key actually
  // changes — avoids a setState loop when items ref churn but content
  // is observationally identical.
  useEffect(() => {
    if (!onSessionOverlayChange) return;
    const key = sessionThemeOverlayKey(overlay);
    if (key === lastOverlayKeyRef.current) return;
    lastOverlayKeyRef.current = key;
    onSessionOverlayChange(overlay);
  }, [overlay, onSessionOverlayChange]);

  const handleSummaryChange = useCallback(
    (next: { summary: WereadAiSummaryResult | null; itemsUsed: number | null }) => {
      if (!next.summary || next.itemsUsed === null) {
        setAiSummary(null);
        return;
      }
      setAiSummary({ summary: next.summary, itemsUsed: next.itemsUsed });
    },
    []
  );

  const currentQuery: WereadNotesQuery = useMemo(
    () => ({
      type: filterType, days: filterDays, matchedOnly: catalogId ? true : filterMatched,
      sort: filterSort, limit: filterLimit, offset: 0,
      q: noteQuery.length > 0 ? noteQuery : undefined,
      ...(catalogId ? { catalogId } : {}),
    }),
    [filterType, filterDays, filterMatched, filterSort, filterLimit, noteQuery, catalogId]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
      abortRef.current?.abort();
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  // This subtree is keyed by book and auth generation. Direct book navigation
  // loads its first page; an unrestricted library still requires a manual click.
  // The preceding lifecycle effect aborts the first attempt during StrictMode
  // replay before this effect starts its replacement request.
  useEffect(() => {
    if (catalogId) void load(true);
  }, [catalogId, authGeneration]);

  function isCurrentSession() {
    return mountedRef.current && getWebAuthSnapshot().status === "authenticated"
      && getWebAuthAuthGeneration() === authGeneration;
  }

  // A new scope/session remounts this component. A filter/search change clears
  // the current batch too, so pagination and export can never reuse older rows.
  function clearResults() {
    requestIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setItems([]);
    setPageInfo(null);
    setSummary(null);
    setSearchInfo(null);
    setLoadedQuery(null);
    setAiSummary(null);
    setCopyState("idle");
    setState("idle");
    setError(null);
  }

  function changeFilters(change: () => void) {
    clearResults();
    change();
  }

  async function load(reset: boolean, query: WereadNotesQuery = currentQuery) {
    if (!isCurrentSession()) return;
    if (reset) clearResults();
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const myId = ++requestIdRef.current;
    setAiSummary(null);
    setState("loading");
    setError(null);
    try {
      const offset = reset ? 0 : (pageInfo?.offset ?? 0) + (pageInfo?.limit ?? 0);
      const { catalogId: _catalogId, matchedOnly: _matchedOnly, ...bookQuery } = query;
      const resp = catalogId
        ? await fetchWereadBookNotes(catalogId, { ...bookQuery, offset }, { signal: controller.signal })
        : await fetchWereadNotes({ ...query, offset }, { signal: controller.signal });
      if (controller.signal.aborted || myId !== requestIdRef.current || !isCurrentSession()) return;
      if (!resp.ok) {
        setState("error");
        setError("笔记暂时无法加载，请稍后重试。");
        return;
      }
      setItems((prev) => (reset ? resp.items : [...prev, ...resp.items]));
      setLoadedQuery({ ...query, offset: 0 });
      setPageInfo(resp.pageInfo);
      setSummary(resp.summary);
      setSearchInfo(resp.searchInfo ?? null);
      setState("ready");
    } catch (err) {
      if (controller.signal.aborted || myId !== requestIdRef.current || !isCurrentSession()) return;
      setState("error");
      const msg = err instanceof Error ? err.message : "加载失败";
      if (/401|403|unauthorized|认证失败|登录已失效|登录安全校验/i.test(msg)) {
        setError("登录已失效，请重新登录。");
      } else if (/disabled|not enabled|未启用/i.test(msg)) {
        setError("微信读书数据暂不可用。");
      } else {
        setError("笔记暂时无法加载，请稍后重试。");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }

  function handleLoad() {
    void load(true);
  }

  function handleLoadMore() {
    void load(false);
  }

  function handleClearFilters() {
    clearResults();
    setFilterType("all");
    setFilterDays("all");
    setFilterMatched(false);
    setFilterSort("newest");
    setFilterLimit(20);
  }

  // S27D: search handlers — input state stays separate from the active query
  // so that hitting Enter or the search button commits the normalized form.
  function handleSearch() {
    const normalized = normalizeNoteSearchQuery(noteQueryInput);
    setNoteQuery(normalized);
    void load(true, { ...currentQuery, q: normalized || undefined });
  }

  function handleClearSearch() {
    setNoteQueryInput("");
    setNoteQuery("");
    void load(true, { ...currentQuery, q: undefined });
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSearch();
    }
  }

  async function handleCopy(item: WereadPrivateNoteItem) {
    const parts = getNoteDisplayParts(item);
    if (parts.isEmpty) {
      setError("该记录没有可复制的正文");
      return;
    }
    const lines: string[] = [];
    if (parts.bodyText) lines.push(parts.bodyText);
    if (parts.commentText) lines.push(`我的想法：${parts.commentText}`);
    const payload = lines.join("\n\n");
    try {
      await navigator.clipboard?.writeText(payload);
      if (!isCurrentSession()) return;
      setCopyState("copied");
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => setCopyState("idle"), 1200);
    } catch {
      if (!isCurrentSession()) return;
      setError("复制失败：浏览器未授权剪贴板访问");
    }
  }

  function handleExport() {
    if (items.length === 0 || !loadedQuery || state === "loading" || !isCurrentSession()) return;
    let md: string;
    let filename: string;
    try {
      md = buildMarkdownExport(items, {
        query: loadedQuery,
        privacyNotice: "本文件由当前浏览器的安全登录会话导出，不包含微信读书内部 ID。",
      });
      filename = buildMarkdownExportFilename(loadedQuery);
    } catch {
      setError("当前笔记无法导出，请重新加载后重试。");
      setState("error");
      return;
    }
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const summaryView = formatNotesSummary(summary);
  const isEmptyIdle = state === "idle" && items.length === 0;

  return (
    <div className="weread-notes-section">
      <div className="weread-note-privacy-warning">
        <AlertCircle size={14} aria-hidden="true" />
        <span>
          以下内容来自你的微信读书私有笔记，仅当前浏览器的安全登录会话可见。不会进入公开搜索或 Meilisearch。
        </span>
      </div>

      {/* Row 1: search — visual primary action */}
      <div className="weread-notes-search-row" data-testid="weread-notes-search-row">
        <label className="weread-notes-search__label" htmlFor="weread-notes-search-input">
          <Search size={12} aria-hidden="true" />
          搜索
        </label>
        <input
          id="weread-notes-search-input"
          type="search"
          className="weread-notes-search-input"
          placeholder="搜索我的划线、想法、书评"
          maxLength={100}
          value={noteQueryInput}
          onChange={(e) => setNoteQueryInput(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          aria-label="搜索笔记"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          type="button"
          onClick={handleSearch}
          className="weread-notes-search__primary"
          disabled={state === "loading" || noteQueryInput.trim().length === 0}
          title="按搜索词重新加载"
          data-testid="weread-notes-search-button"
        >
          <Search size={14} aria-hidden="true" />
          搜索
        </button>
        {(noteQuery.length > 0 || noteQueryInput.length > 0) ? (
          <button
            type="button"
            onClick={handleClearSearch}
            className="weread-notes-search-clear"
            disabled={state === "loading"}
            title="清除搜索，回到普通筛选模式"
          >
            <X size={14} aria-hidden="true" />
            清除搜索
          </button>
        ) : null}
      </div>

      {/* Row 2: filters */}
      <div className="weread-notes-filter-row">
        <div className="weread-notes-filter__group">
          <label className="weread-notes-filter__label">
            <Filter size={12} aria-hidden="true" /> 类型
          </label>
          <select
            value={filterType}
            onChange={(e) => changeFilters(() => setFilterType(e.target.value as WereadNoteTypeFilter))}
            aria-label="笔记类型"
          >
            {TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {getFilterLabel(opt)}
              </option>
            ))}
          </select>
        </div>
        <div className="weread-notes-filter__group">
          <label className="weread-notes-filter__label">时间</label>
          <select
            value={filterDays}
            onChange={(e) => changeFilters(() => setFilterDays(e.target.value as WereadNotesDaysFilter))}
            aria-label="时间范围"
          >
            {DAYS_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {formatDaysLabel(opt)}
              </option>
            ))}
          </select>
        </div>
        <div className="weread-notes-filter__group">
          <label className="weread-notes-filter__label">匹配</label>
          <select
            value={catalogId || filterMatched ? "matched" : "all"}
            onChange={(e) => changeFilters(() => setFilterMatched(e.target.value === "matched"))}
            disabled={Boolean(catalogId)}
            aria-label="匹配筛选"
          >
            <option value="all">全部</option>
            <option value="matched">仅已匹配 book-id-search</option>
          </select>
        </div>
        <div className="weread-notes-filter__group">
          <label className="weread-notes-filter__label">排序</label>
          <select
            value={filterSort}
            onChange={(e) => changeFilters(() => setFilterSort(e.target.value as WereadNotesSort))}
            aria-label="排序"
          >
            {SORT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {formatSortLabel(opt)}
              </option>
            ))}
          </select>
        </div>
        <div className="weread-notes-filter__group">
          <label className="weread-notes-filter__label">每页</label>
          <select
            value={String(filterLimit)}
            onChange={(e) => changeFilters(() => setFilterLimit(Number(e.target.value)))}
            aria-label="每页数量"
          >
            {LIMIT_OPTIONS.map((opt) => (
              <option key={opt} value={String(opt)}>
                {opt}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Row 3: actions */}
      <div className="weread-notes-actions-row">
        {state === "ready" || state === "error" ? (
          <button type="button" onClick={handleLoad} title="按当前筛选重新加载">
            <RefreshCw size={14} aria-hidden="true" />
            加载笔记
          </button>
        ) : (
          <button type="button" onClick={handleLoad} disabled={state === "loading"} title="加载最近一批笔记">
            <Library size={14} aria-hidden="true" />
            {state === "loading" ? "加载中…" : "加载笔记"}
          </button>
        )}
        <button
          type="button"
          onClick={handleExport}
          className="weread-notes-actions-row__export"
          disabled={items.length === 0 || state === "loading"}
          title="导出当前结果 Markdown"
        >
          <Download size={14} aria-hidden="true" />
          导出 Markdown
        </button>
        <button
          type="button"
          onClick={handleClearFilters}
          className="weread-notes-actions-row__secondary"
          title="重置其他筛选（不影响本书范围和搜索词）"
        >
          {catalogId ? "重置其他筛选" : "清空筛选"}
        </button>
      </div>

      {state === "error" && error ? (
        <div className="weread-private-error" role="alert">
          <AlertCircle size={14} /> {error}
        </div>
      ) : null}

      {isEmptyIdle ? (
        <div className="weread-notes-empty weread-notes-empty--idle" data-testid="weread-notes-empty-idle">
          输入搜索词，或点击加载笔记开始浏览。
        </div>
      ) : null}

      {state === "ready" && summary ? (
        <div className="weread-notes-summary" aria-live="polite">
          <span>当前筛选 <strong>{summaryView.total}</strong> 条</span>
          {searchInfo && searchInfo.enabled && noteQuery.length > 0 ? (
            <span className="weread-notes-search-summary" data-testid="weread-search-summary">
              当前搜索命中 <strong>{searchInfo.matchedCount}</strong> 条
            </span>
          ) : null}
          <span>划线 {summaryView.highlights}</span>
          <span>想法 {summaryView.thoughts}</span>
          <span>书评 {summaryView.reviews}</span>
          <span>未分类 {summaryView.unknown}</span>
          <span className="weread-notes-summary__matched">已匹配 {summaryView.matched}</span>
          <span>未匹配 {summaryView.unmatched}</span>
        </div>
      ) : null}

      {state === "ready" && items.length === 0 && !isEmptyIdle ? (
        <div className="weread-notes-empty">当前筛选下没有可显示的笔记。</div>
      ) : null}

      {items.length > 0 ? (
        <ul className="weread-note-list">
          {items.map((item, idx) => {
            const parts = getNoteDisplayParts(item);
            const bodyForTitle = parts.bodyText || parts.commentText || "";
            const showBody = !parts.isEmpty && parts.bodyText.length > 0;
            const matchedCatalogId = item.matched && isValidWereadCatalogId(item.catalogId)
              ? item.catalogId!.trim()
              : null;
            return (
              <li key={`${item.createdAt ?? "n"}-${idx}`} className="weread-note-card">
                <div className="weread-note-meta">
                  <span className={`weread-note-chip weread-note-chip--${item.type}`}>{formatNoteTypeLabel(item.type)}</span>
                  <span className="weread-note-date">{formatNoteDate(item.createdAt ?? item.updatedAt)}</span>
                  {matchedCatalogId ? (
                    <span className="weread-note-chip weread-note-chip--matched" title="已匹配到 book-id-search 公开目录">
                      已匹配书目
                    </span>
                  ) : (
                    <span className="weread-note-chip weread-note-chip--unmatched">未匹配书目</span>
                  )}
                  <button
                    type="button"
                    className="weread-note-copy"
                    onClick={() => handleCopy(item)}
                    title="复制本条正文"
                    disabled={parts.isEmpty}
                  >
                    {copyState === "copied" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                    <span>{copyState === "copied" ? "已复制" : "复制"}</span>
                  </button>
                </div>
                {showBody ? (
                  <p
                    className="weread-note-text"
                    title={bodyForTitle.length > 200 ? bodyForTitle : undefined}
                  >
                    {highlightNoteTextParts(truncateNotePreview(parts.bodyText, 800), noteQuery).map((part, i) =>
                      part.matched ? (
                        <mark
                          key={`t-${i}`}
                          className="weread-note-highlight"
                          data-testid="weread-note-highlight"
                        >
                          {part.text}
                        </mark>
                      ) : (
                        <span key={`t-${i}`}>{part.text}</span>
                      )
                    )}
                  </p>
                ) : (
                  <p className="weread-note-text weread-note-text--empty">
                    该记录没有可显示的正文。
                  </p>
                )}
                {parts.commentText ? (
                  <div className="weread-note-comment">
                    <span className="weread-note-comment__label">我的想法</span>
                    <p>
                      {highlightNoteTextParts(parts.commentText, noteQuery).map((part, i) =>
                        part.matched ? (
                          <mark
                            key={`c-${i}`}
                            className="weread-note-highlight"
                            data-testid="weread-note-highlight"
                          >
                            {part.text}
                          </mark>
                        ) : (
                          <span key={`c-${i}`}>{part.text}</span>
                        )
                      )}
                    </p>
                  </div>
                ) : null}
                {/* S27F: per-book Markdown export — only on matched cards. */}
                {matchedCatalogId ? (
                  <div className="weread-note-book-actions">
                    <Link to={`/books/${encodeURIComponent(matchedCatalogId)}`}>查看书籍详情</Link>
                    <BookNotesExportButton
                      catalogId={matchedCatalogId}
                      label="导出本书全部笔记"
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {state === "ready" && pageInfo?.hasMore ? (
        <div className="weread-notes-loadmore">
          <button type="button" onClick={handleLoadMore}>
            加载更多
          </button>
        </div>
      ) : null}

      {/* S27E: Private WeRead AI notes summarisation.
          The panel only renders when at least one note has been loaded.
          NotesAiSummary itself owns the privacy notice, the manual trigger,
          the abort/clear behaviour, and the responsive layout. */}
      {state === "ready" && items.length > 0 ? (
        <NotesAiSummary items={items} onSummaryChange={handleSummaryChange} />
      ) : null}
    </div>
  );
}
