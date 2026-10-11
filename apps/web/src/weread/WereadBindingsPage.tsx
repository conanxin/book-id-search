import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { getWebAuthAuthGeneration } from "../auth/session";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import { useLibraryScope } from "../library/useLibraryScope";
import {
  getWereadBinding, listWereadBindings, searchWereadBindingCatalog, updateWereadBinding,
  WereadBindingError, type WereadBindingCatalog, type WereadBindingItem,
  type WereadBindingMutation, type WereadBindingStatus,
} from "../wereadBindings";
import { isValidWereadCatalogId } from "../wereadPrivate";
import { parseWereadNotesScope } from "./wereadNotesModel";
import "../library/library.css";
import "./wereadBindings.css";

const PAGE_SIZE = 20;
const STATUS_OPTIONS: { value: WereadBindingStatus; label: string }[] = [
  { value: "all", label: "全部来源书" }, { value: "unmatched", label: "未关联" },
  { value: "matched", label: "已关联" }, { value: "manual", label: "手动设置" },
];
type BindingResult = Awaited<ReturnType<typeof listWereadBindings>>;
type CatalogResult = Awaited<ReturnType<typeof searchWereadBindingCatalog>>;
type EditorMode = "bind" | "unbind" | "restore";
type Filters = { q: string; status: WereadBindingStatus; page: number; catalogId?: string };

function isAbort(error: unknown) { return error instanceof Error && error.name === "AbortError"; }
function bindingError(error: unknown, fallback: string) {
  return error instanceof WereadBindingError && [401, 403].includes(error.status)
    ? "登录状态已变化，请重新登录后继续。" : fallback;
}
function sourceTitle(item: WereadBindingItem) { return item.title || "未命名的微信读书来源书"; }
function originLabel(origin: WereadBindingItem["origin"]) {
  return { imported: "导入匹配", manual: "手动确认", unlinked: "手动解除", none: "尚未关联" }[origin];
}
function catalogTitle(catalog: WereadBindingCatalog) { return catalog.title || "未题名目录书籍"; }

/** The route also uses RequireGoogle; the local guard protects direct rendering. */
export default function WereadBindingsPage() {
  const session = useWebAuthSession();
  const [params, setParams] = useSearchParams();
  const scope = parseWereadNotesScope(params);
  const q = (params.get("q") ?? "").trim().slice(0, 200);
  const status = STATUS_OPTIONS.find(option => option.value === params.get("status"))?.value ?? "all";
  const rawPage = Number(params.get("page") ?? 1);
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 && rawPage <= 50_001 ? rawPage : 1;
  const generation = getWebAuthAuthGeneration();
  const filters: Filters = { q, status, page, ...(scope.kind === "book" ? { catalogId: scope.catalogId } : {}) };

  function change(next: Partial<Filters>) {
    const value = { ...filters, ...next };
    const search = new URLSearchParams(params);
    if (value.q) search.set("q", value.q); else search.delete("q");
    if (value.status !== "all") search.set("status", value.status); else search.delete("status");
    if (value.page !== 1) search.set("page", String(value.page)); else search.delete("page");
    setParams(search);
  }
  function clearBookScope() {
    const search = new URLSearchParams(params);
    search.delete("catalogId"); search.delete("page");
    setParams(search);
  }

  return <main className="page weread-bindings-page">
    <header className="library-page-heading">
      <span className="library-eyebrow">让阅读记录回到对应的书</span>
      <h1>微信读书书籍关联</h1>
      <p className="library-muted">核对已导入的微信读书来源书，将划线、想法和书评关联到正确的目录书籍。手动设置会持续保留，并优先于后续导入的匹配结果。</p>
      <div className="library-actions"><Link className="library-button library-button--quiet" to="/weread">返回微信读书中心</Link>
        {scope.kind === "book" && <Link className="library-button library-button--quiet" to={`/books/${encodeURIComponent(scope.catalogId)}`}>返回书籍详情</Link>}
      </div>
    </header>
    {session.status !== "authenticated" ? <p className="library-muted" role="status">请使用 Google 登录后管理书籍关联。</p>
      : scope.kind === "invalid" ? <section className="library-panel">
        <h2>书目筛选无效</h2><p className="library-error" role="alert">链接中的书目无法识别，尚未读取来源书。请重新打开书籍，或明确清除本书筛选。</p>
        <button className="library-button" type="button" onClick={clearBookScope}>清除本书筛选，查看全部来源书</button>
      </section> : <>
        {scope.kind === "book" && <section className="weread-binding-scope" aria-label="本书关联范围">
          <p>当前仅显示关联至书目 <span>{scope.catalogId}</span> 的微信读书来源书。</p>
          <button className="library-text-button" type="button" onClick={clearBookScope}>清除本书筛选，查看全部来源书</button>
        </section>}
        <BindingsManager key={JSON.stringify([generation, filters])} generation={generation} filters={filters} onFilterChange={change} />
      </>}
  </main>;
}

function BindingsManager({ generation, filters, onFilterChange }: {
  generation: number; filters: Filters; onFilterChange: (next: Partial<Filters>) => void;
}) {
  const { run, current } = useLibraryScope(generation);
  const [queryDraft, setQueryDraft] = useState(filters.q);
  const [result, setResult] = useState<BindingResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<{ source: WereadBindingItem; mode: EditorMode; candidate?: WereadBindingCatalog } | null>(null);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const request = ++sequence.current;
    setLoading(true); setError(null);
    try {
      const value = await run(signal => listWereadBindings({
        q: filters.q, status: filters.status, limit: PAGE_SIZE, offset: (filters.page - 1) * PAGE_SIZE,
        ...(filters.catalogId ? { catalogId: filters.catalogId } : {}),
      }, { signal }));
      if (request === sequence.current && current()) setResult(value);
    } catch (caught) {
      if (request === sequence.current && current() && !isAbort(caught)) {
        setError(bindingError(caught, "来源书暂时无法读取，请重试。"));
      }
    } finally { if (request === sequence.current && current()) setLoading(false); }
  }, [current, run, filters.q, filters.status, filters.page, filters.catalogId]);

  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);
  function search(event: FormEvent) { event.preventDefault(); onFilterChange({ q: queryDraft.trim(), page: 1 }); }
  function open(source: WereadBindingItem, mode: EditorMode, candidate?: WereadBindingCatalog) {
    setNotice(""); setEditing({ source, mode, candidate });
  }
  function saved(item: WereadBindingItem) {
    setEditing(null);
    setResult(null);
    setNotice(item.origin === "unlinked" ? `《${sourceTitle(item)}》已解除关联。后续导入不会自动重新关联。`
      : item.origin === "manual" ? `《${sourceTitle(item)}》的关联已保存。`
        : `《${sourceTitle(item)}》已恢复使用导入匹配。`);
    void load();
  }

  const writable = result?.writable === true;
  return <section aria-label="微信读书书籍关联">
    <form className="library-filter-bar" aria-label="查找微信读书来源书" onSubmit={search}>
      <label className="library-field library-search-field" htmlFor="weread-binding-source-search">查找微信读书来源书
        <input id="weread-binding-source-search" type="search" value={queryDraft} maxLength={200} onChange={event => setQueryDraft(event.target.value)} placeholder="来源书名、作者或 ISBN" />
      </label>
      <label className="library-field" htmlFor="weread-binding-status">关联状态
        <select id="weread-binding-status" value={filters.status} onChange={event => onFilterChange({ status: event.target.value as WereadBindingStatus, page: 1 })}>
          {STATUS_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <button className="library-button library-button--primary" type="submit">查找来源书</button>
      {(filters.q || filters.status !== "all") && <button className="library-button" type="button" onClick={() => onFilterChange({ q: "", status: "all", page: 1 })}>重置其他筛选</button>}
    </form>
    {notice && <p className="library-status" role="status" aria-live="polite">{notice}</p>}
    {result && !writable && <p className="library-error" role="status">当前来源书可以查看，关联设置暂时无法保存。请稍后再试。</p>}
    {error && <div className="weread-binding-load-error"><p className="library-error" role="alert">{error}</p>
      <button className="library-button" type="button" onClick={() => void load()} disabled={loading}>重新读取来源书</button></div>}
    {loading && <p className="library-muted" role="status">正在读取微信读书来源书…</p>}
    {editing && <BindingEditor key={`${editing.source.sourceKey}:${editing.mode}:${editing.candidate?.id ?? ""}`}
      source={editing.source} mode={editing.mode} initialCandidate={editing.candidate} writable={writable}
      generation={generation} onClose={() => setEditing(null)} onSaved={saved} onReadLatest={() => void load()} />}
    {result && <>
      <p className="library-meta" role="status" aria-live="polite">当前筛选共 {result.pageInfo.total} 本来源书</p>
      {!result.items.length && !loading && <div className="library-empty">
        <p>{filters.page > 1 ? "这一页暂时没有来源书，可以返回第一页。" : filters.catalogId ? "本书当前没有关联的微信读书来源书。可清除本书筛选后查找需要关联的来源书。" : "当前筛选没有来源书。可以修改搜索词或关联状态；新的导入记录也会显示在这里。"}</p>
        {filters.page > 1 && <button className="library-button" type="button" onClick={() => onFilterChange({ page: 1 })}>返回第一页</button>}
      </div>}
      <div className="weread-binding-source-list" aria-busy={loading}>
        {result.items.map(item => <article className="library-panel weread-binding-source" key={item.sourceKey} aria-label={sourceTitle(item)}>
          <div className="library-section-heading"><div><span className="library-eyebrow">微信读书来源</span><h2>{sourceTitle(item)}</h2></div><span className="library-tag">{originLabel(item.origin)}</span></div>
          <p className="library-meta">{item.author || "作者待补充"} · {item.notesCount} 条阅读记录</p>
          <p className="library-meta">ISBN：{item.isbn || "未提供"}</p>
          <div className="weread-binding-current"><h3>当前目录关联</h3>
            {item.effectiveCatalog ? <CatalogSummary catalog={item.effectiveCatalog} />
              : <p className="library-muted">{item.origin === "unlinked" ? "已手动解除，后续导入不会自动恢复。" : "尚未关联目录书籍。"}</p>}
          </div>
          <div className="library-actions">
            {item.origin === "imported" && item.effectiveCatalog?.available && <button className="library-button library-button--primary" type="button" disabled={!writable}
              onClick={() => open(item, "bind", item.effectiveCatalog!)}>确认现有关联</button>}
            <button className="library-button" type="button" disabled={!writable} onClick={() => open(item, "bind")}>{item.effectiveCatalog ? "更换关联" : "关联目录书籍"}</button>
            {item.effectiveCatalog && <button className="library-button library-button--quiet" type="button" disabled={!writable} onClick={() => open(item, "unbind")}>解除关联</button>}
            {["manual", "unlinked"].includes(item.origin) && <button className="library-button library-button--quiet" type="button" disabled={!writable} onClick={() => open(item, "restore")}>恢复导入匹配</button>}
          </div>
        </article>)}
      </div>
      {(filters.page > 1 || result.pageInfo.hasMore) && <nav className="library-pagination" aria-label="来源书分页">
        <button className="library-button" type="button" disabled={filters.page <= 1 || loading} onClick={() => onFilterChange({ page: filters.page - 1 })}>上一页</button>
        <span>第 {filters.page} 页</span>
        <button className="library-button" type="button" disabled={!result.pageInfo.hasMore || loading} onClick={() => onFilterChange({ page: filters.page + 1 })}>下一页</button>
      </nav>}
    </>}
  </section>;
}

function CatalogSummary({ catalog }: { catalog: WereadBindingCatalog }) {
  return <div className="weread-binding-catalog-summary">
    <p className="weread-binding-book-title">{catalog.available && isValidWereadCatalogId(catalog.id)
      ? <Link to={`/books/${encodeURIComponent(catalog.id)}`}>{catalogTitle(catalog)}</Link> : catalogTitle(catalog)}</p>
    <p className="library-meta">{[catalog.author || "作者待补充", catalog.publisher, catalog.year].filter(value => value !== null && value !== "").join(" · ")}</p>
    <p className="library-meta">ISBN：{catalog.isbn || "未提供"}</p>
    {!catalog.available && <p className="library-muted">这条目录书籍目前不可用，可以更换或解除关联。</p>}
  </div>;
}

function BindingEditor({ source, mode, initialCandidate, writable, generation, onClose, onSaved, onReadLatest }: {
  source: WereadBindingItem; mode: EditorMode; initialCandidate?: WereadBindingCatalog; writable: boolean; generation: number;
  onClose: () => void; onSaved: (item: WereadBindingItem) => void; onReadLatest: () => void;
}) {
  const { run, current } = useLibraryScope(generation);
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [latest, setLatest] = useState(source);
  const [candidate, setCandidate] = useState<WereadBindingCatalog | null>(initialCandidate ?? null);
  const [busy, setBusy] = useState<"save" | "refresh" | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => { heading.current?.focus(); }, []);

  async function mutate() {
    if (busyRef.current || !writable || conflict || (mode === "bind" && !candidate)) return;
    let body: WereadBindingMutation;
    if (mode === "bind") {
      if (!candidate) return;
      body = { action: "bind", catalogId: candidate.id, expectedRevision: latest.revision };
    } else body = { action: mode, expectedRevision: latest.revision };
    busyRef.current = true; setBusy("save"); setError(null); setNotice("");
    try {
      const saved = await run(signal => updateWereadBinding(latest.sourceKey, body, { signal }));
      if (current()) onSaved(saved);
    } catch (caught) {
      if (!current() || isAbort(caught)) return;
      if (caught instanceof WereadBindingError && caught.status === 409) {
        setConflict(true); setError("关联已在其他页面更新。当前候选已保留，请先读取最新关联，再核对确认。");
      } else setError(bindingError(caught, "关联未能保存。当前选择已保留，请重试。"));
    } finally { if (current()) { busyRef.current = false; setBusy(null); } }
  }

  async function readLatest() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy("refresh"); setError(null);
    try {
      const item = await run(signal => getWereadBinding(source.sourceKey, { signal }));
      if (!current()) return;
      setLatest(item); setConflict(false); setNotice("已读取最新关联。请核对下面的当前关联与本次选择，再确认保存。");
      onReadLatest();
    } catch (caught) {
      if (current() && !isAbort(caught)) setError(bindingError(caught, "最新关联暂时无法读取，当前选择已保留。"));
    } finally { if (current()) { busyRef.current = false; setBusy(null); } }
  }

  const actionLabel = mode === "unbind" ? "确认解除" : mode === "restore" ? "确认恢复"
    : latest.effectiveCatalog && latest.effectiveCatalog.id !== candidate?.id ? "确认更换" : "确认关联";

  return <section className="library-panel weread-binding-editor" aria-labelledby={headingId} aria-busy={busy !== null}>
    <div className="library-section-heading"><div><span className="library-eyebrow">先核对，再保存</span><h2 id={headingId} ref={heading} tabIndex={-1}>核对《{sourceTitle(latest)}》的关联</h2></div>
      <button className="library-button library-button--quiet" type="button" onClick={onClose} disabled={busy !== null}>关闭关联编辑</button></div>
    <div className="weread-binding-comparison">
      <div><h3>微信读书来源</h3><p className="weread-binding-book-title">{sourceTitle(latest)}</p><p className="library-meta">{latest.author || "作者待补充"}</p><p className="library-meta">ISBN：{latest.isbn || "未提供"} · {latest.notesCount} 条记录</p></div>
      <div><h3>当前目录关联</h3>{latest.effectiveCatalog ? <CatalogSummary catalog={latest.effectiveCatalog} /> : <p className="library-muted">当前未关联目录书籍。</p>}<p className="library-meta">{originLabel(latest.origin)}</p></div>
    </div>
    {mode === "bind" && <CatalogPicker key={source.sourceKey} source={source} generation={generation} disabled={busy !== null || !writable} onSelect={setCandidate} />}
    {mode === "bind" && candidate && <div className="weread-binding-confirmation">
      <h3>准备关联的目录书籍</h3><CatalogSummary catalog={candidate} />
      <p>将微信读书来源《{sourceTitle(latest)}》关联到《{catalogTitle(candidate)}》。确认后，这本来源书的 {latest.notesCount} 条记录会归入所选目录书籍。</p>
      <p className="library-meta">请核对作者与版本。手动确认后，后续导入不会自行更换此关联。</p>
    </div>}
    {mode === "unbind" && <div className="weread-binding-confirmation">
      <h3>解除这本来源书的关联</h3><p>微信读书来源《{sourceTitle(latest)}》将不再关联到当前目录书籍。已导入的划线、想法和书评会保留，后续导入不会自动重新关联。</p><p className="library-meta">以后可以重新选择目录书籍，或恢复使用导入匹配。</p>
    </div>}
    {mode === "restore" && <div className="weread-binding-confirmation">
      <h3>恢复使用导入匹配</h3><p>将替换《{sourceTitle(latest)}》的当前手动设置，重新按导入资料中的匹配结果关联；以后的导入更新也会生效。</p>
      {latest.importedCatalogId && isValidWereadCatalogId(latest.importedCatalogId)
        ? <p><Link to={`/books/${encodeURIComponent(latest.importedCatalogId)}`}>查看导入匹配的目录书籍</Link></p>
        : <p className="library-muted">当前导入资料没有匹配结果，恢复后这本来源书将保持未关联。</p>}
    </div>}
    {notice && <p className="library-status" role="status">{notice}</p>}
    {error && <p className="library-error" role="alert">{error}</p>}
    {conflict && <button className="library-button" type="button" onClick={() => void readLatest()} disabled={busy !== null}>{busy === "refresh" ? "正在读取最新关联…" : "读取最新关联"}</button>}
    <div className="library-actions"><button className={`library-button ${mode === "unbind" ? "library-button--danger" : "library-button--primary"}`} type="button"
      disabled={!writable || busy !== null || conflict || (mode === "bind" && !candidate)} onClick={() => void mutate()}>{busy === "save" ? "正在保存关联…" : actionLabel}</button>
      <button className="library-button" type="button" disabled={busy !== null} onClick={onClose}>取消本次操作</button></div>
  </section>;
}

function CatalogPicker({ source, generation, disabled, onSelect }: {
  source: WereadBindingItem; generation: number; disabled: boolean; onSelect: (catalog: WereadBindingCatalog | null) => void;
}) {
  const { current } = useLibraryScope(generation);
  const inputId = useId();
  const [draft, setDraft] = useState(source.isbn || source.title || "");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<CatalogResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current += 1; abort.current?.abort(); }, []);

  function clearSearch() {
    sequence.current += 1; abort.current?.abort();
    setResult(null); setError(null); setLoading(false); onSelect(null);
  }
  async function search(nextQuery: string, page = 1) {
    const value = nextQuery.trim();
    if (!value || disabled || !current()) return;
    clearSearch();
    const controller = new AbortController(); abort.current = controller;
    const request = ++sequence.current;
    setLoading(true); setQuery(value);
    try {
      const response = await searchWereadBindingCatalog(value, page, 10, { signal: controller.signal });
      if (request === sequence.current && !controller.signal.aborted && current()) setResult(response);
    } catch (caught) {
      if (request === sequence.current && !controller.signal.aborted && current() && !isAbort(caught)) setError("目录搜索暂时不可用，请重试。");
    } finally { if (request === sequence.current && current()) setLoading(false); }
  }

  return <div className="weread-binding-picker">
    <form className="weread-binding-search" onSubmit={event => { event.preventDefault(); void search(draft); }}>
      <label className="library-field" htmlFor={inputId}>搜索目录书籍<input id={inputId} type="search" value={draft} maxLength={200} disabled={disabled}
        onChange={event => { clearSearch(); setDraft(event.target.value); }} placeholder="书名、作者或 ISBN" /></label>
      <button className="library-button" type="submit" disabled={disabled || loading || !draft.trim()}>搜索目录</button>
    </form>
    <p className="library-meta">按 ISBN 或书名搜索，选择后再核对作者和版本。</p>
    {loading && <p className="library-muted" role="status">正在查找目录书籍…</p>}
    {error && <p className="library-error" role="alert">{error}</p>}
    {result && <>
      <p className="library-meta" role="status">找到 {result.total} 条目录候选</p>
      {!result.items.length && <p className="library-empty">没有找到目录候选，可以修改书名、作者或 ISBN 后重试。</p>}
      <div className="weread-binding-candidates">{result.items.filter(item => item.available && isValidWereadCatalogId(item.id)).map(item => <article className="weread-binding-candidate" key={item.id} aria-label={`目录候选：${catalogTitle(item)}`}>
        <CatalogSummary catalog={item} /><button className="library-button" type="button" disabled={disabled} aria-label={`选择《${catalogTitle(item)}》`} onClick={() => onSelect(item)}>选择这本书</button>
      </article>)}</div>
      {result.total > result.limit && <nav className="library-pagination" aria-label="目录候选分页">
        <button className="library-button" type="button" disabled={disabled || loading || result.page <= 1} onClick={() => void search(query, result.page - 1)}>上一页</button><span>第 {result.page} 页</span>
        <button className="library-button" type="button" disabled={disabled || loading || result.page * result.limit >= result.total} onClick={() => void search(query, result.page + 1)}>下一页</button>
      </nav>}
    </>}
  </div>;
}
