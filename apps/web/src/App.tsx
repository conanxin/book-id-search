import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Copy,
  Download,
  Link2,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { getBook, getRelatedBooks, getStats, searchBooks, type Book, type MatchInfo, type SearchResponse, type StatsResponse } from "./api";
import { detailMatchInfo, isExactMatch, matchBadgeLabel, matchBadgeVariant, parseStatusNarrative, explainParseWarnings } from "./match-ui";

// ---------------------------------------------------------------------------
// Storage: recent search history (last 5 unique queries)
// ---------------------------------------------------------------------------

const RECENT_KEY = "book-id-search.recent-v1";
const RECENT_LIMIT = 5;

function readRecent(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
}

function pushRecent(q: string) {
  const trimmed = q.trim();
  if (!trimmed) return;
  const prev = readRecent().filter((v) => v !== trimmed);
  const next = [trimmed, ...prev].slice(0, RECENT_LIMIT);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* localStorage may be unavailable; recent search is a nice-to-have */
  }
}

// ---------------------------------------------------------------------------
// Highlight: split a string by case-insensitive, unicode-safe needle
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function highlightParts(value: string, query: string): Array<{ text: string; hit: boolean }> {
  if (!value) return [{ text: "", hit: false }];
  const q = query.trim();
  if (!q) return [{ text: value, hit: false }];
  // Chinese has no case, so the regex is global + case-insensitive but lowercasing
  // both sides does not mangle CJK and matches English evenly.
  const re = new RegExp(`(${escapeRegExp(q)})`, "gi");
  const parts = value.split(re);
  return parts
    .filter((p) => p.length > 0)
    .map((p) => ({ text: p, hit: p.toLowerCase() === q.toLowerCase() }));
}

function Highlight({ value, query }: { value: string; query: string }) {
  const parts = highlightParts(value, query);
  if (parts.length === 1 && !parts[0].hit) return <>{parts[0].text}</>;
  return (
    <>
      {parts.map((part, idx) =>
        part.hit ? (
          <mark key={idx} className="hl">
            {part.text}
          </mark>
        ) : (
          <span key={idx}>{part.text}</span>
        )
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// CopyButton: writes to clipboard with graceful fallback + toast
// ---------------------------------------------------------------------------

function CopyButton({
  value,
  label,
  title,
  variant = "default",
}: {
  value: string;
  label: string;
  title?: string;
  variant?: "default" | "primary";
}) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const flash = (ok: boolean) => {
    if (ok) {
      setCopied(true);
      setFailed(false);
    } else {
      setCopied(false);
      setFailed(true);
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      setFailed(false);
    }, 1200);
  };

  const onClick = async () => {
    const text = value ?? "";
    if (!text) {
      flash(false);
      return;
    }
    const ok = await writeClipboard(text);
    flash(ok);
  };

  const icon = failed ? <AlertCircle size={14} /> : copied ? <Check size={14} /> : <Copy size={14} />;
  const text = failed ? "复制失败" : copied ? `已复制 ${label}` : `复制 ${label}`;

  return (
    <button
      type="button"
      className={`copy-button copy-button--${variant} ${copied ? "is-copied" : ""} ${failed ? "is-failed" : ""}`}
      onClick={onClick}
      title={title ?? `复制${label}`}
      aria-label={title ?? `复制${label}`}
      disabled={!value}
    >
      {icon}
      {text}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Shared clipboard helper (used by both CopyButton and toolbar actions)
// ---------------------------------------------------------------------------

async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "absolute";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Toast: transient banner. Keeps a single string + a timer; renders into
// `.toast` near the top of the page. Auto-dismiss after 1.2 s.
// ---------------------------------------------------------------------------

type ToastKind = "info" | "success" | "error";
let toastTimer: number | null = null;
let toastListener: ((msg: string, kind: ToastKind) => void) | null = null;

export function showToast(message: string, kind: ToastKind = "info") {
  if (toastListener) toastListener(message, kind);
}

function showToastInternal(message: string, kind: ToastKind, setter: (v: { message: string; kind: ToastKind } | null) => void) {
  setter({ message, kind });
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    setter(null);
    toastTimer = null;
  }, 1200);
}

function Toast() {
  const [state, setState] = useState<{ message: string; kind: ToastKind } | null>(null);
  useEffect(() => {
    toastListener = (msg, kind) => showToastInternal(msg, kind, setState);
    return () => {
      toastListener = null;
    };
  }, []);
  if (!state) return null;
  return (
    <div className={`toast toast--${state.kind}`} role="status" aria-live="polite">
      {state.message}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV helpers (RFC 4180-ish). Excel-friendly UTF-8 BOM is prepended by the
// download path, not here, so unit tests can assert on raw content.
// ---------------------------------------------------------------------------

const CSV_HEADERS = [
  "title",
  "author",
  "publisher",
  "year",
  "pages",
  "isbn",
  "ssid",
  "dxid",
  "parseStatus",
] as const;

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Quote if it contains comma, quote, CR, or LF. Escape quotes by doubling.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(books: Book[]): string {
  const lines = [CSV_HEADERS.join(",")];
  for (const b of books) {
    lines.push(
      [
        csvField(b.title),
        csvField(b.author),
        csvField(b.publisher),
        csvField(b.year),
        csvField(b.pages),
        csvField(b.isbn),
        csvField(b.ssid),
        csvField(b.dxid),
        csvField(b.parseStatus),
      ].join(",")
    );
  }
  // Trailing newline keeps Excel happy and matches RFC 4180 last-record
  // newline (recommended but not required).
  return lines.join("\r\n") + "\r\n";
}

function downloadCsv(books: Book[], q: string): boolean {
  if (!books.length) return false;
  const body = "\uFEFF" + buildCsv(books); // BOM for Excel + UTF-8
  const blob = new Blob([body], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const stamp = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const filename = `book-search-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.csv`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the blob URL on the next tick — the browser has had a chance to
  // pick up the click by then.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

function buildPageSummary(books: Book[]): string {
  const parts = books.map((b) =>
    [b.title || "(未命名)", b.author || "(未知)", b.publisher || "(未知)", b.isbn || "(缺失)", b.ssid, b.dxid].join("｜")
  );
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Field: small label/value pair. `highlight` opts into query highlighting for
// the value (used for title / author / publisher / isbn / ssid / dxid).
// ---------------------------------------------------------------------------

function Field({
  label,
  value,
  highlight,
  query,
  mono,
  fallback,
}: {
  label: string;
  value: string | number | null | undefined;
  highlight?: boolean;
  query?: string;
  mono?: boolean;
  fallback?: string;
}) {
  const display = value === null || value === undefined || value === "" ? fallback ?? "—" : String(value);
  const isMissing = value === null || value === undefined || value === "";
  return (
    <div className={`field ${mono ? "field--mono" : ""} ${isMissing && fallback ? "field--missing" : ""}`}>
      <span>{label}</span>
      <strong>
        {highlight && query ? <Highlight value={display} query={query} /> : display}
      </strong>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge: ok / weak / failed pill
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: Book["parseStatus"] }) {
  const label = status === "ok" ? "正常" : status === "weak" ? "弱解析" : "解析异常";
  return (
    <span className={`status-badge status-badge--${status}`} aria-label={`解析状态 ${label}`}>
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// MatchBadge: explains WHY this result is here.
// Renders the trust badge derived from match.label + an emphasis strip
// for exact matches. Quiet when match is missing or unknown.
// ---------------------------------------------------------------------------

function MatchBadge({ match }: { match: Book["match"] }) {
  if (!match || match.type === "unknown") {
    // Unknown matches are not surfaced as badges — they would be noise.
    return null;
  }
  const variant = matchBadgeVariant(match);
  const labelText = matchBadgeLabel(match);
  if (!labelText) return null;
  return (
    <span
      className={`match-badge match-badge--${variant}`}
      title={`命中原因：${labelText}`}
      aria-label={`命中原因：${labelText}`}
    >
      {isExactMatch(match) ? <span className="match-badge__dot" aria-hidden="true" /> : null}
      {labelText}
    </span>
  );
}

// ---------------------------------------------------------------------------
// TrustHint: parseStatus narrative — Chinese rendering of ok / weak / failed
// plus the human-readable parse warnings. Pure CSS classes drive the look.
// ---------------------------------------------------------------------------

function TrustHint({ book }: { book: Book }) {
  const narrative = parseStatusNarrative(book);
  const kind = book.parseStatus;
  return (
    <div className={`trust-hint trust-hint--${kind}`}>
      <span className="trust-hint__label">记录状态：</span>
      <span className="trust-hint__detail">{narrative}</span>
      {kind === "weak" && book.parseWarnings?.length ? (
        <div className="trust-hint__warnings" aria-label="弱解析原因">
          {explainParseWarnings(book.parseWarnings)}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExactMatchStrip: prominent banner for exact_* matches. Says why this row
// is at the top of the list. Hidden for partial / mixed / unknown hits.
// ---------------------------------------------------------------------------

function ExactMatchStrip({ book }: { book: Book }) {
  if (!isExactMatch(book.match)) return null;
  return (
    <div className="exact-match-strip" role="status" aria-live="polite">
      <span className="exact-match-strip__chip">精确匹配</span>
      <span className="exact-match-strip__detail">{matchBadgeLabel(book.match)}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Date formatter
// ---------------------------------------------------------------------------

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

// ---------------------------------------------------------------------------
// Build a plain-text copy of the entire record (used by BookCard "整条复制")
// ---------------------------------------------------------------------------

function fullRecordText(book: Book): string {
  const lines = [
    `书名: ${book.title || "(未命名)"}`,
    `作者: ${book.author || "(未知)"}`,
    `出版社: ${book.publisher || "(未知)"}`,
    `年份: ${book.year ?? "(未知)"}`,
    `页数: ${book.pages ?? "(未知)"}`,
    `ISBN: ${book.isbn || "(缺失)"}`,
    `SSID: ${book.ssid}`,
    `DXID: ${book.dxid}`,
    `解析状态: ${book.parseStatus}`,
  ];
  if (book.parseWarnings?.length) lines.push(`解析提示: ${book.parseWarnings.join("，")}`);
  if (book.rawInfo) lines.push("", "—— 原始记录 ——", book.rawInfo);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// BookCard: one result row. Click navigates to /books/:id, but the copy
// buttons stop propagation so they don't accidentally trigger navigation.
// ---------------------------------------------------------------------------

function BookCard({ book, query }: { book: Book; query: string }) {
  const exact = isExactMatch(book.match);
  return (
    <article className={`book-card ${exact ? "book-card--exact" : ""}`.trim()}>
      <ExactMatchStrip book={book} />
      <Link className="book-card__hit" to={`/books/${encodeURIComponent(book.id)}`} aria-label={`查看 ${book.title || "未命名图书"} 详情`}>
        <div className="book-card__main">
          <div className="book-title-row">
            <h2>
              {query ? <Highlight value={book.title || "未命名图书"} query={query} /> : book.title || "未命名图书"}
            </h2>
            <StatusBadge status={book.parseStatus} />
          </div>
          <p>
            {query ? <Highlight value={book.author || "作者未知"} query={query} /> : book.author || "作者未知"}
          </p>
          <div className="book-card__badges">
            <MatchBadge match={book.match} />
          </div>
        </div>
        <div className="book-grid">
          <Field label="出版社" value={book.publisher} highlight query={query} />
          <Field label="年份" value={book.year} />
          <Field label="页数" value={book.pages} />
          <Field label="ISBN" value={book.isbn} highlight query={query} mono fallback="缺失" />
          <Field label="SSID" value={book.ssid} highlight query={query} mono />
          <Field label="DXID" value={book.dxid} highlight query={query} mono />
        </div>
      </Link>
      <TrustHint book={book} />
      {book.parseStatus === "failed" ? (
        <div className="parse-hint parse-hint--failed">本条解析异常，请谨慎引用。</div>
      ) : null}
      <div className="book-card__actions" onClick={(event) => event.stopPropagation()}>
        <CopyButton value={book.ssid} label="SSID" title={`复制 SSID ${book.ssid}`} />
        <CopyButton value={book.dxid} label="DXID" title={`复制 DXID ${book.dxid}`} />
        <CopyButton value={book.isbn} label="ISBN" title="复制 ISBN" />
        <CopyButton value={fullRecordText(book)} label="整条" variant="primary" title="复制整条书目信息" />
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// SearchPage
// ---------------------------------------------------------------------------

const PAGE_SIZE = 20;

function SearchPage() {
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") ?? "";
  const urlPage = Math.max(Number(params.get("page") ?? "1"), 1);

  const [input, setInput] = useState(urlQ);
  const [debouncedQ, setDebouncedQ] = useState(urlQ);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [statsError, setStatsError] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // currentQ = the query that the latest request was fired with. Used by
  // results__bar so it always renders against the query that produced `data`,
  // not whatever is in the input field at the moment.
  const currentQ = useMemo(() => debouncedQ.trim(), [debouncedQ]);

  // Stats: fetch once on mount.
  useEffect(() => {
    let cancelled = false;
    getStats()
      .then((s) => {
        if (!cancelled) setStats(s);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStatsError(err instanceof Error ? err.message : "统计信息读取失败");
      });
    setRecent(readRecent());
    return () => {
      cancelled = true;
    };
  }, []);

  // Debounce input -> debouncedQ (300ms). URL stays in sync only on submit /
  // page change so we don't shove half-typed queries into the address bar.
  useEffect(() => {
    if (input === urlQ) {
      setDebouncedQ(input);
      return;
    }
    const t = window.setTimeout(() => setDebouncedQ(input), 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  // Trigger search whenever the debounced query or page changes.
  useEffect(() => {
    const page = Math.max(Number(params.get("page") ?? "1"), 1);
    setInput(debouncedQ);
    if (debouncedQ.trim() === "") {
      setLoading(false);
      setError("");
      setData({ total: 0, page, limit, items: [] });
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    searchBooks(debouncedQ, page, limit)
      .then((result) => {
        if (cancelled) return;
        setData(result);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "搜索接口暂时不可用，请稍后重试");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, params, limit]);

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(Math.ceil(data.total / data.limit), 1);
  }, [data]);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const trimmed = input.trim();
      if (!trimmed) return;
      pushRecent(trimmed);
      setRecent(readRecent());
      setParams({ q: trimmed, page: "1" });
    },
    [input, setParams]
  );

  const goPage = (nextPage: number) => {
    setParams({ q: input.trim(), page: String(Math.max(nextPage, 1)) });
  };

  const clearInput = () => {
    setInput("");
    setParams({ q: "", page: "1" });
  };

  const useRecent = (q: string) => {
    setInput(q);
    pushRecent(q);
    setRecent(readRecent());
    setParams({ q, page: "1" });
  };

  // ------------------------------------------------------------------
  // Toolbar actions: copy current URL, export current page CSV, copy
  // current page summary. Toast on success or failure.
  // ------------------------------------------------------------------
  const items = data?.items ?? [];

  const copySearchUrl = useCallback(async () => {
    const href = window.location.href;
    const ok = await writeClipboard(href);
    if (ok) showToast("已复制链接", "success");
    else showToast("复制链接失败", "error");
  }, []);

  const exportCurrentCsv = useCallback(() => {
    if (!items.length) {
      showToast("当前页没有结果可导出", "info");
      return;
    }
    const ok = downloadCsv(items, currentQ);
    if (ok) showToast(`已导出当前页 ${items.length} 条 CSV`, "success");
    else showToast("导出 CSV 失败", "error");
  }, [items, currentQ]);

  const copyPageSummary = useCallback(async () => {
    if (!items.length) {
      showToast("当前页没有结果可复制", "info");
      return;
    }
    const text = buildPageSummary(items);
    const ok = await writeClipboard(text);
    if (ok) showToast(`已复制本页 ${items.length} 条摘要`, "success");
    else showToast("复制摘要失败", "error");
  }, [items]);

  // ------------------------------------------------------------------
  // Keyboard shortcuts: / focus search, Esc clear, ←/→ page nav.
  // Skip when the user is typing in an input/textarea/contenteditable
  // so we don't fight their edits.
  // ------------------------------------------------------------------
  useEffect(() => {
    const isEditableTarget = (el: EventTarget | null): boolean => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      return false;
    };
    const handler = (event: KeyboardEvent) => {
      // Allow modifier-combos (Ctrl/Cmd/Alt) to pass through — let the browser
      // handle Ctrl+L (focus address bar), Ctrl+R (reload), etc.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const editable = isEditableTarget(event.target);
      // "/" focuses the search box. Don't intercept when typing.
      if (event.key === "/" && !editable) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      // Esc clears the search box only when focused (avoid swallowing Escape
      // from fullscreen, modals, etc.). Also handles "blank then Esc leaves
      // the input" gracefully.
      if (event.key === "Escape") {
        if (editable) {
          if (input.length > 0) {
            // Clear the input — works regardless of which editable element.
            const target = event.target as HTMLInputElement | HTMLTextAreaElement;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
              target.value = "";
              target.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
        }
        return;
      }
      // ← / → only when NOT typing — these are page navigation.
      if (!editable && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        if (!data || totalPages <= 1) return;
        event.preventDefault();
        if (event.key === "ArrowLeft" && urlPage > 1) goPage(urlPage - 1);
        if (event.key === "ArrowRight" && urlPage < totalPages) goPage(urlPage + 1);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, urlPage, totalPages, input]);

  const hasResults = items.length > 0;

  return (
    <main className="page">
      <section className="search-panel">
        <div className="brand-row">
          <BookOpen size={28} />
          <h1>图书 SSID / DXID 检索</h1>
        </div>
        <form className="search-form" onSubmit={submit} role="search">
          <Search size={22} aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="搜索书名、作者、出版社、ISBN、SSID、DXID"
            autoFocus
            aria-label="搜索关键词"
            name="q"
          />
          {input ? (
            <button
              type="button"
              className="search-form__clear"
              onClick={clearInput}
              aria-label="清空搜索"
              title="清空搜索"
            >
              <X size={16} />
            </button>
          ) : null}
          <button type="submit" aria-label="开始搜索">
            搜索
          </button>
        </form>

        {recent.length ? (
          <div className="recent-row">
            <span className="recent-row__label">最近搜索</span>
            <div className="recent-row__list">
              {recent.map((q) => (
                <button key={q} type="button" className="recent-chip" onClick={() => useRecent(q)}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className="stats-strip">
          <Field label="records" value={stats?.numberOfDocuments?.toLocaleString()} />
          <Field label="index" value={stats?.indexName} mono />
          <Field label="indexing" value={stats ? (stats.isIndexing ? "进行中" : "空闲") : statsError || "读取中"} />
          <Field label="last import" value={formatDate(stats?.lastImportReport?.finishedAt)} />
        </div>
      </section>

      <section className="results">
        <div className="results__bar">
          <span className="results__count">
            {data && currentQ
              ? `共找到 ${data.total.toLocaleString()} 条结果`
              : input.trim() === ""
              ? "输入关键词开始搜索"
              : "准备搜索"}
          </span>
          <div className="results__bar-right">
            {loading ? (
              <span className="inline-status" aria-live="polite">
                <Loader2 className="spin" size={16} />
                搜索中
              </span>
            ) : null}
            {data && totalPages > 1 ? (
              <span className="results__page-meta">
                第 {urlPage} / {totalPages} 页 · 每页 {data.limit}
              </span>
            ) : null}
          </div>
        </div>

        {currentQ ? (
          <div className="results__toolbar" role="toolbar" aria-label="搜索结果操作">
            <button
              type="button"
              className="toolbar-button"
              onClick={copySearchUrl}
              title="复制当前搜索链接"
              aria-label="复制当前搜索链接"
            >
              <Link2 size={14} />
              复制链接
            </button>
            <button
              type="button"
              className="toolbar-button"
              onClick={exportCurrentCsv}
              disabled={!hasResults}
              title={hasResults ? `导出当前页 ${items.length} 条 CSV` : "当前页没有结果"}
              aria-label="导出当前页 CSV"
            >
              <Download size={14} />
              导出当前页 CSV
            </button>
            <button
              type="button"
              className="toolbar-button"
              onClick={copyPageSummary}
              disabled={!hasResults}
              title={hasResults ? `复制当前页 ${items.length} 条摘要` : "当前页没有结果"}
              aria-label="复制当前页摘要"
            >
              <ClipboardList size={14} />
              复制本页摘要
            </button>
            <span className="results__toolbar-hint">
              快捷键：<kbd>/</kbd> 聚焦 · <kbd>Enter</kbd> 搜索 · <kbd>Esc</kbd> 清空 · <kbd>←</kbd>/<kbd>→</kbd> 翻页
            </span>
          </div>
        ) : null}

        {error ? <div className="state state--error" role="alert">{error}</div> : null}

        {!loading && !error && data && currentQ && data.items.length === 0 ? (
          <div className="state">没有找到匹配“{currentQ}”的图书。</div>
        ) : null}

        <div className="card-list">
          {data?.items.map((book) => (
            <BookCard key={book.id} book={book} query={currentQ} />
          ))}
        </div>

        {data && totalPages > 1 ? (
          <nav className="pager" aria-label="分页">
            <button type="button" onClick={() => goPage(1)} disabled={urlPage <= 1} aria-label="首页">
              «
            </button>
            <button type="button" onClick={() => goPage(urlPage - 1)} disabled={urlPage <= 1} aria-label="上一页">
              <ChevronLeft size={18} />
              上一页
            </button>
            <span className="pager__current" aria-current="page">
              第 {urlPage} / {totalPages} 页
            </span>
            <button type="button" onClick={() => goPage(urlPage + 1)} disabled={urlPage >= totalPages} aria-label="下一页">
              下一页
              <ChevronRight size={18} />
            </button>
            <button
              type="button"
              onClick={() => goPage(totalPages)}
              disabled={urlPage >= totalPages}
              aria-label="末页"
            >
              »
            </button>
          </nav>
        ) : null}

        <div className="status-footer" aria-live="polite">
          {stats ? (
            <span>
              索引 {stats.indexName} · {stats.numberOfDocuments.toLocaleString()} 条 ·{" "}
              {stats.isIndexing ? "正在索引" : "索引空闲"}
              {stats.lastImportReport?.finishedAt
                ? ` · 上次导入 ${formatDate(stats.lastImportReport.finishedAt)}`
                : ""}
            </span>
          ) : statsError ? (
            <span className="status-footer__error">索引状态读取失败：{statsError}</span>
          ) : (
            <span>索引状态读取中…</span>
          )}
        </div>
      </section>
    </main>
  );
}

// ---------------------------------------------------------------------------
// DetailPage
// ---------------------------------------------------------------------------

function DetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [book, setBook] = useState<Book | null>(null);
  const [related, setRelated] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    Promise.all([getBook(id), getRelatedBooks(id)])
      .then(([bookResult, relatedResult]) => {
        if (cancelled) return;
        setBook(bookResult.item);
        setRelated(relatedResult.items);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "读取详情失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const back = () => {
    // Prefer going back if history has a search entry; otherwise navigate to
    // the search root so we never strand the user on a 404-ish page.
    if (window.history.length > 1) navigate(-1);
    else navigate("/");
  };

  return (
    <main className="page">
      <button className="back-button" type="button" onClick={back} aria-label="返回上一页">
        <ArrowLeft size={18} />
        返回搜索结果
      </button>

      {loading ? (
        <div className="state" role="status" aria-live="polite">
          <Loader2 className="spin" size={18} />
          正在加载详情
        </div>
      ) : null}

      {error ? <div className="state state--error" role="alert">{error}</div> : null}

      {book ? (
        <article className="detail">
          <header>
            <div className="detail__title-row">
              <h1>{book.title || "未命名图书"}</h1>
              <StatusBadge status={book.parseStatus} />
            </div>
            <p className="detail__author">{book.author || "作者未知"}</p>
            <div className="detail__badges">
              <MatchBadge match={book.match ?? detailMatchInfo(book)} />
            </div>
          </header>

          <TrustHint book={book} />
          {book.parseStatus === "failed" ? (
            <div className="parse-hint parse-hint--failed">本条解析异常，请谨慎引用。</div>
          ) : null}

          <div className="detail-grid">
            <div className="detail-grid__field">
              <Field label="SSID" value={book.ssid} mono />
              <CopyButton value={book.ssid} label="SSID" title="复制 SSID" />
            </div>
            <div className="detail-grid__field">
              <Field label="DXID" value={book.dxid} mono />
              <CopyButton value={book.dxid} label="DXID" title="复制 DXID" />
            </div>
            <div className="detail-grid__field">
              <Field label="ISBN" value={book.isbn} mono fallback="缺失" />
              <CopyButton value={book.isbn} label="ISBN" title="复制 ISBN" />
            </div>
            <Field label="出版社" value={book.publisher} />
            <Field label="年份" value={book.year} />
            <Field label="页数" value={book.pages} />
            <Field label="解析提示" value={book.parseWarnings?.length ? explainParseWarnings(book.parseWarnings) : "无"} />
          </div>

          <section className="raw-section">
            <div className="section-title-row">
              <h2 className="raw-info-title">原始 TXT 记录（用于核对）</h2>
              <CopyButton value={book.rawInfo ?? ""} label="原始记录" variant="primary" title="复制原始记录" />
            </div>
            {book.rawInfo ? (
              <>
                <p className="raw-info-note">这是一行原始 TXT 记录，可用于核对解析字段。</p>
                <pre className="raw-block">{book.rawInfo}</pre>
              </>
            ) : (
              <p className="raw-info-note raw-info-note--empty">当前索引未保存原始记录。</p>
            )}
          </section>

          <section>
            <h2>相关图书</h2>
            {related.length ? (
              <div className="related-list">
                {related.map((item) => (
                  <BookCard key={item.id} book={item} query="" />
                ))}
              </div>
            ) : (
              <div className="state">暂无相关图书。</div>
            )}
          </section>
        </article>
      ) : null}
    </main>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<SearchPage />} />
        <Route path="/books/:id" element={<DetailPage />} />
      </Routes>
      <Toast />
    </>
  );
}