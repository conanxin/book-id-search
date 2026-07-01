import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { getBook, getRelatedBooks, getStats, searchBooks, type Book, type SearchResponse, type StatsResponse } from "./api";

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
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        flash(true);
        return;
      }
    } catch {
      /* fall through to legacy path */
    }
    // Legacy fallback for older / restricted environments
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
      flash(true);
    } catch {
      flash(false);
    }
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
// Toast: transient banner shown by CopyButton. Implemented as a small inline
// status row so we don't add a global toast manager.
// ---------------------------------------------------------------------------

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
  return (
    <article className="book-card">
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
      {book.parseStatus === "weak" ? (
        <div className="parse-hint">本条为弱解析，原始记录已保留。</div>
      ) : null}
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
          </header>

          {book.parseStatus === "weak" ? (
            <div className="parse-hint">本条为弱解析，原始记录已保留。</div>
          ) : null}
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
            <Field label="解析提示" value={book.parseWarnings?.length ? book.parseWarnings.join("，") : "无"} />
          </div>

          <section className="raw-section">
            <div className="section-title-row">
              <h2>原始记录</h2>
              <CopyButton value={book.rawInfo ?? ""} label="原始记录" variant="primary" title="复制原始记录" />
            </div>
            <pre className="raw-block">{book.rawInfo || "(无原始记录)"}</pre>
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
    <Routes>
      <Route path="/" element={<SearchPage />} />
      <Route path="/books/:id" element={<DetailPage />} />
    </Routes>
  );
}