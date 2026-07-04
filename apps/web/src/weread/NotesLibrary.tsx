import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Filter, Library, Loader2, AlertCircle, Check, RefreshCw } from "lucide-react";
import {
  fetchWereadNotes,
  type WereadNoteTypeFilter,
  type WereadNotesDaysFilter,
  type WereadNotesQuery,
  type WereadNotesLibrarySummary,
  type WereadNotesSort,
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

  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState<string | null>(null);

  const [items, setItems] = useState<WereadPrivateNoteItem[]>([]);
  const [pageInfo, setPageInfo] = useState<{ limit: number; offset: number; total: number; hasMore: boolean } | null>(null);
  const [summary, setSummary] = useState<WereadNotesLibrarySummary | null>(null);

  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const requestIdRef = useRef(0);

  const currentQuery: WereadNotesQuery = useMemo(
    () => ({ type: filterType, days: filterDays, matchedOnly: filterMatched, sort: filterSort, limit: filterLimit, offset: 0 }),
    [filterType, filterDays, filterMatched, filterSort, filterLimit]
  );

  const queryKey = notesQueryKey(currentQuery);

  useEffect(() => {
    // Reset state when token changes
    setItems([]);
    setPageInfo(null);
    setSummary(null);
    setState("idle");
    setError(null);
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

  async function handleCopy(item: WereadPrivateNoteItem) {
    const lines = [item.text];
    if (item.comment) lines.push(`我的想法：${item.comment}`);
    const payload = lines.join("\n");
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

  return (
    <div className="weread-notes-section" data-query-key={queryKey}>
      <div className="weread-note-privacy-warning">
        <AlertCircle size={14} aria-hidden="true" />
        <span>
          以下内容来自你的微信读书私有笔记，仅当前浏览器 private token 模式可见。不会进入公开搜索或 Meilisearch。
        </span>
      </div>

      <div className="weread-notes-filter">
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
        <div className="weread-notes-filter__actions">
          {state === "ready" || state === "error" ? (
            <button type="button" onClick={handleLoad} title="按当前筛选重新加载">
              <RefreshCw size={14} aria-hidden="true" />
              应用筛选
            </button>
          ) : (
            <button type="button" onClick={handleLoad} disabled={state === "loading"} title="加载最近一批笔记">
              <Library size={14} aria-hidden="true" />
              {state === "loading" ? "加载中…" : "加载最近笔记"}
            </button>
          )}
          <button type="button" onClick={handleClearFilters} className="weread-notes-filter__secondary">
            清空筛选
          </button>
        </div>
      </div>

      {state === "error" && error ? (
        <div className="weread-private-error">
          <AlertCircle size={14} /> {error}
        </div>
      ) : null}

      {state === "ready" && summary ? (
        <div className="weread-notes-summary" aria-live="polite">
          <span>当前筛选 <strong>{summaryView.total}</strong> 条</span>
          <span>划线 {summaryView.highlights}</span>
          <span>想法 {summaryView.thoughts}</span>
          <span>书评 {summaryView.reviews}</span>
          <span>未匹配 {summaryView.unknown}</span>
          <span className="weread-notes-summary__matched">已匹配 {summaryView.matched}</span>
          <span>未匹配 {summaryView.unmatched}</span>
          <button type="button" onClick={handleExport} className="weread-notes-export" disabled={items.length === 0}>
            <Download size={14} aria-hidden="true" />
            导出当前结果 Markdown
          </button>
        </div>
      ) : null}

      {state === "ready" && items.length === 0 ? (
        <div className="weread-notes-empty">当前筛选下没有可显示的笔记。</div>
      ) : null}

      {state === "ready" && items.length > 0 ? (
        <ul className="weread-note-list">
          {items.map((item, idx) => (
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
                >
                  {copyState === "copied" ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                  <span>{copyState === "copied" ? "已复制" : "复制"}</span>
                </button>
              </div>
              <p className="weread-note-text" title={item.text.length > 200 ? item.text : undefined}>
                {truncateNotePreview(item.text, 400)}
              </p>
              {item.comment && item.comment.trim().length > 0 ? (
                <div className="weread-note-comment">
                  <span className="weread-note-comment__label">我的想法</span>
                  <p>{item.comment}</p>
                </div>
              ) : null}
            </li>
          ))}
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