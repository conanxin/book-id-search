import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, BookOpen, Check, ChevronLeft, ChevronRight, Copy, Loader2, Search } from "lucide-react";
import { getBook, getRelatedBooks, getStats, searchBooks, type Book, type SearchResponse, type StatsResponse } from "./api";

function Field({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="field">
      <span>{label}</span>
      <strong>{value || "—"}</strong>
    </div>
  );
}

function StatusBadge({ status }: { status: Book["parseStatus"] }) {
  const label = status === "ok" ? "正常" : status === "weak" ? "弱解析" : "失败";
  return <span className={`status-badge status-badge--${status}`}>{label}</span>;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

function BookCard({ book }: { book: Book }) {
  return (
    <Link className="book-card" to={`/books/${encodeURIComponent(book.id)}`}>
      <div className="book-card__main">
        <div className="book-title-row">
          <h2>{book.title || "未命名图书"}</h2>
          <StatusBadge status={book.parseStatus} />
        </div>
        <p>{book.author || "作者未知"}</p>
      </div>
      {book.parseStatus === "weak" ? <div className="parse-hint">本条为弱解析，原始记录已保留。</div> : null}
      <div className="book-grid">
        <Field label="出版社" value={book.publisher} />
        <Field label="年份" value={book.year} />
        <Field label="页数" value={book.pages} />
        <Field label="ISBN" value={book.isbn} />
        <Field label="SSID" value={book.ssid} />
        <Field label="DXID" value={book.dxid} />
      </div>
      <pre>{book.rawInfo}</pre>
    </Link>
  );
}

function SearchPage() {
  const [params, setParams] = useSearchParams();
  const initialQ = params.get("q") ?? "";
  const page = Math.max(Number(params.get("page") ?? "1"), 1);
  const [input, setInput] = useState(initialQ);
  const [data, setData] = useState<SearchResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [statsError, setStatsError] = useState("");

  useEffect(() => {
    getStats()
      .then(setStats)
      .catch((err: unknown) => setStatsError(err instanceof Error ? err.message : "统计信息读取失败"));
  }, []);

  useEffect(() => {
    const q = params.get("q") ?? "";
    const currentPage = Math.max(Number(params.get("page") ?? "1"), 1);
    setInput(q);
    setLoading(true);
    setError("");
    searchBooks(q, currentPage)
      .then(setData)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "搜索失败"))
      .finally(() => setLoading(false));
  }, [params]);

  const totalPages = useMemo(() => {
    if (!data) return 1;
    return Math.max(Math.ceil(data.total / data.limit), 1);
  }, [data]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setParams({ q: input.trim(), page: "1" });
  }

  function goPage(nextPage: number) {
    setParams({ q: input.trim(), page: String(Math.max(nextPage, 1)) });
  }

  return (
    <main className="page">
      <section className="search-panel">
        <div className="brand-row">
          <BookOpen size={28} />
          <h1>图书 SSID / DXID 检索</h1>
        </div>
        <form className="search-form" onSubmit={submit}>
          <Search size={22} />
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="输入书名、作者、出版社、ISBN、SSID、DXID"
            autoFocus
          />
          <button type="submit">搜索</button>
        </form>
        <div className="stats-strip">
          <Field label="records" value={stats?.numberOfDocuments?.toLocaleString()} />
          <Field label="index" value={stats?.indexName} />
          <Field label="last import" value={formatDate(stats?.lastImportReport?.finishedAt)} />
          <Field label="indexing" value={stats ? (stats.isIndexing ? "进行中" : "空闲") : statsError || "读取中"} />
        </div>
      </section>

      <section className="results">
        <div className="results__bar">
          <span>{data ? `共 ${data.total.toLocaleString()} 条` : "准备搜索"}</span>
          {loading ? (
            <span className="inline-status">
              <Loader2 className="spin" size={16} />
              加载中
            </span>
          ) : null}
        </div>

        {error ? <div className="state state--error">{error}</div> : null}
        {!loading && !error && data && data.items.length === 0 ? <div className="state">没有找到匹配图书。</div> : null}

        <div className="card-list">
          {data?.items.map((book) => (
            <BookCard key={book.id} book={book} />
          ))}
        </div>

        {data && totalPages > 1 ? (
          <div className="pager">
            <button type="button" onClick={() => goPage(page - 1)} disabled={page <= 1}>
              <ChevronLeft size={18} />
              上一页
            </button>
            <span>
              第 {page} / {totalPages} 页
            </span>
            <button type="button" onClick={() => goPage(page + 1)} disabled={page >= totalPages}>
              下一页
              <ChevronRight size={18} />
            </button>
          </div>
        ) : null}
      </section>
    </main>
  );
}

function DetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [book, setBook] = useState<Book | null>(null);
  const [related, setRelated] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setLoading(true);
    setError("");
    Promise.all([getBook(id), getRelatedBooks(id)])
      .then(([bookResult, relatedResult]) => {
        setBook(bookResult.item);
        setRelated(relatedResult.items);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "读取详情失败"))
      .finally(() => setLoading(false));
  }, [id]);

  return (
    <main className="page">
      <button className="back-button" type="button" onClick={() => navigate(-1)}>
        <ArrowLeft size={18} />
        返回
      </button>
      {loading ? (
        <div className="state">
          <Loader2 className="spin" size={18} />
          加载中
        </div>
      ) : null}
      {error ? <div className="state state--error">{error}</div> : null}
      {book ? (
        <article className="detail">
          <h1>{book.title || "未命名图书"}</h1>
          <p className="detail__author">{book.author || "作者未知"}</p>
          <div className="book-grid book-grid--detail">
            <Field label="出版社" value={book.publisher} />
            <Field label="年份" value={book.year} />
            <Field label="页数" value={book.pages} />
            <Field label="ISBN" value={book.isbn} />
            <Field label="SSID" value={book.ssid} />
            <Field label="DXID" value={book.dxid} />
            <Field label="解析状态" value={book.parseStatus} />
            <Field label="解析提示" value={book.parseWarnings.join("，")} />
          </div>
          <section>
            <div className="section-title-row">
              <h2>原始记录</h2>
              <button
                className="copy-button"
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(book.rawInfo);
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1200);
                }}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? "已复制" : "复制"}
              </button>
            </div>
            <pre className="raw-block">{book.rawInfo}</pre>
          </section>
          <section>
            <h2>相关图书</h2>
            {related.length ? (
              <div className="related-list">
                {related.map((item) => (
                  <BookCard key={item.id} book={item} />
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

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<SearchPage />} />
      <Route path="/books/:id" element={<DetailPage />} />
    </Routes>
  );
}
