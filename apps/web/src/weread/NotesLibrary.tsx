import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Filter, Library, Loader2, AlertCircle, Check, RefreshCw, Search, X } from "lucide-react";
import {
  fetchWereadNotes,
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
  formatNotesSearchInfo,
  formatNotesSummary,
  formatSortLabel,
  getFilterLabel,
  getNoteDisplayParts,
  highlightNoteTextParts,
  normalizeNoteSearchQuery,
  notesQueryKey,
  truncateNotePreview,
} from "./wereadNotesModel";

const TYPE_OPTIONS: WereadNoteTypeFilter[] = ["all", "highlight", "thought", "review"];
const DAYS_OPTIONS: WereadNotesDaysFilter[] = ["all", "7", "30", "90"];
const SORT_OPTIONS: WereadNotesSort[] = ["newest", "oldest"];
const LIMIT_OPTIONS = [20, 50];

type LoadState = "idle" | "loading" | "ready" | "error";

interface NotesLibraryProps {
  token: string;
}

export default function NotesLibrary({ token }: NotesLibraryProps) {
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

  const currentQuery: WereadNotesQuery = useMemo(
    () => ({ type: filterType, days: filterDays, matchedOnly: filterMatched, sort: filterSort, limit: filterLimit, offset: 0, q: noteQuery.length > 0 ? noteQuery : undefined }),
    [filterType, filterDays, filterMatched, filterSort, filterLimit, noteQuery]
  );

  const queryKey = notesQueryKey(currentQuery);

  useEffect(() => {
    // Reset state when token changes (also clears q + items per privacy contract).
    setItems([]);
    setPageInfo(null);
    setSummary(null);
    setSearchInfo(null);
    setState("idle");
    setError(null);
    setNoteQuery("");
    setNoteQueryInput("");
  }, [token]);

  async function load(reset: boolean) {
    const myId = ++requestIdRef.current;
    setState("loading");
    setError(null);
    try {
      const offset = reset ? 0 : (pageInfo?.offset ?? 0) + (pageInfo?.limit ?? 0);
      const resp = await fetchWereadNotes(token, { ...currentQuery, offset });
      if (myId !== requestIdRef.current) return;
      if (!resp.ok) {
        setState("error");
        setError("私有 API 返回异常");
        return;
      }
      setItems((prev) => (reset ? resp.items : [...prev, ...resp.items]));
      setPageInfo(resp.pageInfo);
      setSummary(resp.summary);
      setSearchInfo(resp.searchInfo ?? null);
      setState("ready");
    } catch (err) {
      if (myId !== requestIdRef.current) return;
      setState("error");
      const msg = err instanceof Error ? err.message : "加载失败";
      if (/401|403|unauthorized|invalid token|missing token|认证失败|已过期|token 无效/i.test(msg)) {
        setError("Token 无效或已过期");
      } else if (/disabled|not enabled|未启用/i.test(msg)) {
        setError("私有 API 未启用");
      } else {
        setError(msg);
      }
    }
  }

  function handleLoad() {
    void load(true);
  }

  function handleLoadMore() {
    void load(false);
  }

  function handleClearFilters() {
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
    // items reset happens inside load() because we pass offset=0 when reset=true
    setPageInfo(null);
    void load(true);
  }

  function handleClearSearch() {
    setNoteQueryInput("");
    setNoteQuery("");
    setSearchInfo(null);
    setPageInfo(null);
    void load(true);
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
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1200);
    } catch {
      setError("复制失败：浏览器未授权剪贴板访问");
    }
  }

  function handleExport() {
    if (items.length === 0) return;
    const md = buildMarkdownExport(items, {
      query: currentQuery,
      privacyNotice: "本文件由当前浏览器的私有 token 会话导出，不包含微信读书内部 ID。",
    });
    const filename = buildMarkdownExportFilename(currentQuery);
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
    <div className="weread-notes-section" data-query-key={queryKey}>
      <div className="weread-note-privacy-warning">
        <AlertCircle size={14} aria-hidden="true" />
        <span>
          以下内容来自你的微信读书私有笔记，仅当前浏览器 private token 模式可见。不会进入公开搜索或 Meilisearch。
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
            onChange={(e) => setFilterType(e.target.value as WereadNoteTypeFilter)}
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
            onChange={(e) => setFilterDays(e.target.value as WereadNotesDaysFilter)}
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
            value={filterMatched ? "matched" : "all"}
            onChange={(e) => setFilterMatched(e.target.value === "matched")}
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
            onChange={(e) => setFilterSort(e.target.value as WereadNotesSort)}
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
            onChange={(e) => setFilterLimit(Number(e.target.value))}
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
          disabled={items.length === 0}
          title="导出当前结果 Markdown"
        >
          <Download size={14} aria-hidden="true" />
          导出 Markdown
        </button>
        <button
          type="button"
          onClick={handleClearFilters}
          className="weread-notes-actions-row__secondary"
          title="重置筛选器（不影响搜索词）"
        >
          清空筛选
        </button>
      </div>

      {state === "error" && error ? (
        <div className="weread-private-error">
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
          <span>未匹配 {summaryView.unknown}</span>
          <span className="weread-notes-summary__matched">已匹配 {summaryView.matched}</span>
          <span>未匹配 {summaryView.unmatched}</span>
        </div>
      ) : null}

      {state === "ready" && items.length === 0 && !isEmptyIdle ? (
        <div className="weread-notes-empty">当前筛选下没有可显示的笔记。</div>
      ) : null}

      {state === "ready" && items.length > 0 ? (
        <ul className="weread-note-list">
          {items.map((item, idx) => {
            const parts = getNoteDisplayParts(item);
            const bodyForTitle = parts.bodyText || parts.commentText || "";
            const showBody = !parts.isEmpty && parts.bodyText.length > 0;
            return (
              <li key={`${item.createdAt ?? "n"}-${idx}`} className="weread-note-card">
                <div className="weread-note-meta">
                  <span className={`weread-note-chip weread-note-chip--${item.type}`}>{formatNoteTypeLabel(item.type)}</span>
                  <span className="weread-note-date">{formatNoteDate(item.createdAt ?? item.updatedAt)}</span>
                  {item.matched && item.catalogId ? (
                    <span className="weread-note-chip weread-note-chip--matched" title="已匹配到 book-id-search 公开目录">
                      已匹配书目 · {item.catalogId}
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
    </div>
  );
}