import { useEffect, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getWebAuthAuthGeneration } from "../auth/session";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import { isLibraryAbort, libraryErrorMessage, listLibrary, type LibraryFilter, type LibraryResult, type LibrarySearchMatch } from "./api";
import { libraryDate } from "./BookWorkspace";
import "./library.css";

const filters: { value: LibraryFilter; label: string }[] = [
  { value: "all", label: "全部书籍" },
  { value: "introduction", label: "有介绍" },
  { value: "notes", label: "有笔记" },
  { value: "resources", label: "有电子版本" },
];

export function LibraryPage() {
  const session = useWebAuthSession();
  const generation = getWebAuthAuthGeneration();
  return <main className="page library-page">
    <header className="library-page-heading">
      <span className="library-eyebrow">把发现留在身边</span>
      <h1>我的书籍</h1>
      <p className="library-muted">收藏的书、补充的介绍、写下的笔记，以及找到的电子版本，都从这里继续。</p>
    </header>
    {session.status === "authenticated" ? <LibraryCollection key={generation} />
      : <section className="library-panel" aria-label="登录后查看我的书籍">
        <p className="library-muted" role="status">{["idle", "loading", "signing_in"].includes(session.status)
          ? "正在读取登录状态…" : "请使用 Google 登录，查看你的书籍和阅读记录。"}</p>
      </section>}
  </main>;
}

function LibraryCollection() {
  const [params, setParams] = useSearchParams();
  const query = (params.get("q") ?? "").slice(0, 200);
  const rawPage = Number(params.get("page") ?? "1");
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const filter = filters.find(value => value.value === params.get("filter"))?.value ?? "all";
  const key = JSON.stringify([query, page, filter]);
  const [draftQuery, setDraftQuery] = useState(query);
  const [loaded, setLoaded] = useState<{ key: string; result: LibraryResult } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const generation = getWebAuthAuthGeneration();
  useEffect(() => { setDraftQuery(query); }, [query]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoaded(null); setError(null);
    void listLibrary({ page, limit: 24, q: query, filter }, controller.signal).then(result => {
      if (active && !controller.signal.aborted && generation === getWebAuthAuthGeneration()) setLoaded({ key, result });
    }).catch(e => {
      if (active && !controller.signal.aborted && generation === getWebAuthAuthGeneration() && !isLibraryAbort(e)) {
        setError({ key, message: libraryErrorMessage(e) });
      }
    });
    return () => { active = false; controller.abort(); };
  }, [filter, generation, key, page, query, retry]);

  function change(next: { q?: string; filter?: LibraryFilter; page?: number }) {
    const value = { q: query, filter, page, ...next };
    const search = new URLSearchParams();
    if (value.q) search.set("q", value.q);
    if (value.filter !== "all") search.set("filter", value.filter);
    if (value.page !== 1) search.set("page", String(value.page));
    setParams(search);
  }
  function search(event: FormEvent) { event.preventDefault(); change({ q: draftQuery.trim(), page: 1 }); }

  const result = loaded?.key === key ? loaded.result : null;
  const currentError = error?.key === key ? error.message : null;
  const hasFilter = !!query || filter !== "all";
  const pages = result ? Math.max(1, Math.ceil(result.total / result.limit)) : 1;

  return <>
    <form className="library-filter-bar" aria-label="查找我的书籍" onSubmit={search}>
      <label className="library-field library-search-field" htmlFor="library-search">在我的书籍中查找
        <input id="library-search" type="search" value={draftQuery} maxLength={200} onChange={event => setDraftQuery(event.target.value)} placeholder="书名、作者、介绍或我的笔记关键词" />
      </label>
      <label className="library-field" htmlFor="library-filter">内容筛选
        <select id="library-filter" value={filter} onChange={event => change({ filter: event.target.value as LibraryFilter, page: 1 })}>
          {filters.map(value => <option key={value.value} value={value.value}>{value.label}</option>)}
        </select>
      </label>
      <button className="library-button library-button--primary" type="submit">查找</button>
      {hasFilter && <button className="library-button library-button--quiet" type="button" onClick={() => { setDraftQuery(""); change({ q: "", filter: "all", page: 1 }); }}>清除筛选</button>}
    </form>
    {!result && !currentError && <section className="library-panel" role="status" aria-live="polite"><p className="library-muted">正在读取我的书籍…</p></section>}
    {currentError && <section className="library-panel"><p className="library-error" role="alert">{currentError}</p><button className="library-button" onClick={() => setRetry(value => value + 1)}>重新读取书籍</button></section>}
    {result && <>
      <div className="library-list-summary"><p className="library-muted" role="status" aria-live="polite">{hasFilter ? "当前筛选" : "已保存"} · {result.total} 本书</p><Link className="library-text-link" to="/">继续搜书 →</Link></div>
      {!result.items.length ? <section className="library-panel library-collection-empty">
        <h2>{page > 1 ? "这一页暂时没有书籍" : hasFilter ? "没有找到符合条件的书" : "从一本想继续读的书开始"}</h2>
        <p className="library-muted">{page > 1 ? "书籍列表可能已经更新，可以返回第一页继续查看。" : hasFilter ? "试试更短的关键词，或清除内容筛选。" : "搜到一本书后加入我的书籍，或者保存介绍、笔记和电子版链接，它就会出现在这里。"}</p>
        {page > 1 ? <button className="library-button" onClick={() => change({ page: 1 })}>返回第一页</button>
          : hasFilter ? <button className="library-button" onClick={() => { setDraftQuery(""); change({ q: "", filter: "all", page: 1 }); }}>查看全部书籍</button>
            : <Link className="library-button library-button--primary" to="/">去搜一本书</Link>}
      </section> : <div className="library-grid">
        {result.items.map(item => <article className="library-book-card" key={item.bookId}>
          <div className="library-book-card-heading"><span className="library-book-mark" aria-hidden="true">书</span>
            <div><h2><Link to={`/books/${encodeURIComponent(item.bookId)}`}>{item.title || "未题名书目"}</Link></h2>
              <p className="library-meta">{[item.author, item.publisher, item.year].filter(value => value !== null && value !== "").join(" · ") || "书目信息待补充"}</p></div>
          </div>
          {query.trim() && item.searchMatch ? <SearchMatch bookId={item.bookId} match={item.searchMatch} />
            : <p className={`library-book-excerpt${item.introductionExcerpt ? "" : " library-muted"}`}>{item.introductionExcerpt || "尚未补充介绍，可以从一个阅读线索开始。"}</p>}
          <div className="library-book-tags">
            {item.introductionExcerpt && <span className="library-tag">有介绍</span>}
            <span className="library-tag">{item.noteCount} 篇笔记</span><span className="library-tag">{item.resourceCount} 个电子版本</span>
          </div>
          <p className="library-meta library-book-updated">最近整理 <time dateTime={item.updatedAt}>{libraryDate(item.updatedAt)}</time></p>
        </article>)}
      </div>}
      {result.total > result.limit && <nav className="library-pagination" aria-label="我的书籍分页">
        <button className="library-button" disabled={page <= 1} onClick={() => change({ page: page - 1 })}>上一页</button>
        <span>第 {page} / {pages} 页</span>
        <button className="library-button" disabled={page >= pages} onClick={() => change({ page: page + 1 })}>下一页</button>
      </nav>}
    </>}
  </>;
}

function SearchMatch({ bookId, match }: { bookId: string; match: LibrarySearchMatch }) {
  const hash = match.kind === "note" ? `book-note-${encodeURIComponent(match.noteId)}` : "library-introduction-heading";
  return <div className="library-search-match">
    <div className="library-search-match-heading">
      <span className="library-tag">{match.kind === "note" ? "笔记命中" : "介绍命中"}</span>
      {match.kind === "note" && <strong>{match.noteTitle || "未命名笔记"}</strong>}
    </div>
    <p className="library-search-match-excerpt">{match.excerpt}</p>
    <Link className="library-text-link" to={`/books/${encodeURIComponent(bookId)}#${hash}`}>{match.kind === "note" ? "查看这篇笔记" : "查看介绍"}</Link>
  </div>;
}
