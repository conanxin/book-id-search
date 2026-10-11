import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { getWebAuthAuthGeneration } from "../auth/session";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import {
  fetchWereadBookNotes, isValidWereadCatalogId, WereadPrivateError,
  type WereadNoteTypeFilter, type WereadNotesPageInfo, type WereadPrivateNoteItem,
} from "../wereadPrivate";
import { formatNoteDate, formatNoteTypeLabel, getFilterLabel, getNoteDisplayParts } from "../weread/wereadNotesModel";
import { useLibraryScope } from "./useLibraryScope";
import "./library.css";
import "./book-weread.css";

const PAGE_SIZE = 20;
const TYPES: WereadNoteTypeFilter[] = ["all", "highlight", "thought", "review"];

/** A new book or Google session must never inherit the previous list. */
export function BookWereadNotes({ bookId }: { bookId: string }) {
  const session = useWebAuthSession();
  if (session.status !== "authenticated") return null;
  if (!isValidWereadCatalogId(bookId)) return <section className="library-panel book-weread-panel" aria-labelledby="book-weread-notes-heading">
    <h2 id="book-weread-notes-heading">微信读书记录</h2>
    <p className="library-empty">本条书目暂不支持微信读书记录关联。</p>
    <div className="library-actions"><Link className="library-button" to="/weread">打开微信读书中心</Link></div>
  </section>;
  const generation = getWebAuthAuthGeneration();
  const catalogId = bookId.trim();
  return <BookWereadPanel key={JSON.stringify([catalogId, generation])} bookId={catalogId} generation={generation} />;
}

function BookWereadPanel({ bookId, generation }: { bookId: string; generation: number }) {
  const [type, setType] = useState<WereadNoteTypeFilter>("all");
  return <section className="library-panel book-weread-panel" aria-labelledby="book-weread-notes-heading">
    <div className="library-section-heading">
      <div><span className="library-eyebrow">接着上次的阅读</span><h2 id="book-weread-notes-heading">微信读书记录</h2></div>
      <div className="library-actions">
        <Link className="library-button library-button--quiet" to={`/weread?catalogId=${encodeURIComponent(bookId)}`}>在微信读书中心查看本书记录</Link>
        <Link className="library-button library-button--quiet" to={`/weread/bindings?catalogId=${encodeURIComponent(bookId)}`}>管理本书关联</Link>
      </div>
    </div>
    <p className="library-muted">这里汇集已导入并确认关联到本书的划线、想法和书评。</p>
    <div className="book-weread-toolbar">
      <label className="library-field" htmlFor="book-weread-type">记录类型
        <select id="book-weread-type" value={type} onChange={event => setType(event.target.value as WereadNoteTypeFilter)}>
          {TYPES.map(value => <option key={value} value={value}>{getFilterLabel(value)}</option>)}
        </select>
      </label>
      <span className="library-meta">全部时间 · 最新优先</span>
    </div>
    <BookWereadRecords key={type} bookId={bookId} generation={generation} type={type} />
  </section>;
}

function BookWereadRecords({ bookId, generation, type }: { bookId: string; generation: number; type: WereadNoteTypeFilter }) {
  const { run, current } = useLibraryScope(generation);
  const [items, setItems] = useState<WereadPrivateNoteItem[]>([]);
  const [pageInfo, setPageInfo] = useState<WereadNotesPageInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const busy = useRef(false);

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    const request = ++sequence.current;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const response = await run(signal => fetchWereadBookNotes(bookId, {
        type, days: "all", sort: "newest", limit: PAGE_SIZE, offset,
      }, { signal }));
      if (request !== sequence.current || !current()) return;
      setItems(previous => append ? [...previous, ...response.items] : response.items);
      setPageInfo(response.pageInfo);
    } catch (e) {
      if (request !== sequence.current || !current() || (e instanceof Error && e.name === "AbortError")) return;
      setError(e instanceof WereadPrivateError && [401, 403].includes(e.status)
        ? "登录状态已变化，请重新登录后查看本书记录。"
        : "未能读取本书的微信读书记录，请重试。");
    } finally {
      if (request === sequence.current && current()) {
        busy.current = false;
        setLoading(false);
      }
    }
  }, [bookId, type, run, current]);

  useEffect(() => {
    void loadPage(0, false);
    return () => { sequence.current += 1; };
  }, [loadPage]);

  function loadNext() {
    if (busy.current) return;
    void loadPage(pageInfo ? pageInfo.offset + pageInfo.limit : 0, pageInfo !== null);
  }

  return <div className="book-weread-records" aria-busy={loading}>
    {pageInfo && <p className="book-weread-count library-meta" role="status" aria-live="polite">已显示 {items.length} 条 / 当前筛选共 {pageInfo.total} 条</p>}
    {items.length > 0 && <ol className="book-weread-list">
      {items.map((item, index) => <li key={index}><ImportedNote item={item} /></li>)}
    </ol>}
    {loading && <p className="library-muted book-weread-loading" role="status">{pageInfo ? "正在加载更多记录…" : "正在读取本书的微信读书记录…"}</p>}
    {error && <div className="book-weread-error">
      <p className="library-error" role="alert">{error}</p>
      <button className="library-button" type="button" onClick={loadNext} disabled={loading}>重试读取记录</button>
    </div>}
    {!loading && !error && pageInfo && items.length === 0 && <p className="library-empty">{type === "all"
      ? "本书暂无已关联的微信读书记录。已导入且确认关联到本书的记录会显示在这里。"
      : "本书暂无此类微信读书记录，可以切换到全部记录查看。"}</p>}
    {!error && pageInfo?.hasMore && <div className="library-actions">
      <button className="library-button" type="button" onClick={loadNext} disabled={loading}>加载更多</button>
    </div>}
  </div>;
}

function ImportedNote({ item }: { item: WereadPrivateNoteItem }) {
  const parts = getNoteDisplayParts(item);
  const timestamp = item.createdAt ?? item.updatedAt;
  const date = formatNoteDate(timestamp);
  return <article className="book-weread-note">
    <div className="library-note-heading">
      <h3>{formatNoteTypeLabel(item.type)}</h3>
      <span className="library-tag">微信读书 · 已导入</span>
    </div>
    <p className="library-meta">{timestamp && date !== "—" ? <time dateTime={timestamp}>{date}</time> : "日期未知"}</p>
    {parts.bodyText && <div className="library-prose">{parts.bodyText}</div>}
    {parts.commentText && <div className="book-weread-comment">
      <h4>我的想法</h4><div className="library-prose">{parts.commentText}</div>
    </div>}
    {parts.isEmpty && <p className="library-muted">该记录没有可显示的正文。</p>}
  </article>;
}
