import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { removeProjectItem, ProjectApiError, type ProjectOverviewItem, type ProjectResearchItem } from "./api";
import { ProjectItemNotePanel } from "./ProjectItemNote";

type Props = {
  token: string;
  projectId: string;
  items: ProjectOverviewItem[];
  readOnly: boolean;
  focusedBindingId?: string | null;
  onItemsChanged?: () => void;
};

function publicationLabel(item: ProjectOverviewItem) {
  if (!item.publicationDate) return "日期未知";
  if (item.publicationDatePrecision === "YEAR") return item.publicationDate.slice(0, 4);
  if (item.publicationDatePrecision === "MONTH") {
    return `${item.publicationDate.slice(0, 4)}年${Number(item.publicationDate.slice(5, 7))}月`;
  }
  return new Date(`${item.publicationDate}T00:00:00Z`).toLocaleDateString("zh-CN", { timeZone: "UTC" });
}

const dateLabel = (value: string) => new Date(value).toLocaleString("zh-CN");

export function ProjectItems({ token, projectId, items, readOnly, focusedBindingId, onItemsChanged }: Props) {
  const [visibleItems, setVisibleItems] = useState(items);
  const [error, setError] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [emphasizedId, setEmphasizedId] = useState<string | null>(null);
  const [missingFocusedItem, setMissingFocusedItem] = useState(false);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const removal = useRef<AbortController | null>(null);

  useEffect(() => setVisibleItems(items), [items]);
  useEffect(() => () => removal.current?.abort(), []);
  useEffect(() => {
    if (!focusedBindingId) {
      setMissingFocusedItem(false);
      setEmphasizedId(null);
      return;
    }
    const exactItem = visibleItems.find(item => item.bindingId === focusedBindingId);
    if (!exactItem) {
      setMissingFocusedItem(true);
      setEmphasizedId(null);
      return;
    }
    setMissingFocusedItem(false);
    setEmphasizedId(focusedBindingId);
    const element = itemRefs.current.get(focusedBindingId);
    if (typeof element?.scrollIntoView === "function") element.scrollIntoView({ block: "center" });
    const timer = window.setTimeout(() => setEmphasizedId(current => current === focusedBindingId ? null : current), 5000);
    return () => window.clearTimeout(timer);
  }, [focusedBindingId, visibleItems]);

  async function remove(item: ProjectOverviewItem) {
    if (readOnly || removal.current || !window.confirm(`将《${item.title}》移出项目？书目资料会保留。`)) return;
    const request = new AbortController();
    removal.current = request;
    setRemovingId(item.bindingId);
    setError("");
    try {
      await removeProjectItem(token, projectId, item.bindingId, request.signal);
      if (!request.signal.aborted) {
        setVisibleItems(current => current.filter(value => value.bindingId !== item.bindingId));
        onItemsChanged?.();
      }
    } catch (cause) {
      if (!request.signal.aborted) setError(cause instanceof ProjectApiError ? cause.message : "移出未能确认，请刷新资料后重试。");
    } finally {
      if (!request.signal.aborted) {
        removal.current = null;
        setRemovingId(null);
      }
    }
  }

  return <section className="research-materials" aria-label="研究资料">
    <div className="research-list-heading"><h2>研究资料（{visibleItems.length}）</h2></div>
    {error ? <p className="research-error" role="alert">{error}</p> : null}
    {missingFocusedItem ? <p className="research-missing-item" role="status">这项研究资料已不在当前项目中。</p> : null}
    {visibleItems.length === 0 ? <div className="research-panel research-empty"><h3>尚无研究活动</h3><p>{readOnly ? "这个归档项目还没有研究资料。" : <>从<Link to="/">查书</Link>中选择一本书，加入这个研究项目。</>}</p></div> : null}
    <div className="research-list">{visibleItems.map(item => {
      const noteItem: ProjectResearchItem = { ...item, projectId };
      return <article
        className={`research-panel research-material ${emphasizedId === item.bindingId ? "research-material--focused" : ""}`.trim()}
        data-binding-id={item.bindingId}
        key={item.bindingId}
        ref={node => { if (node) itemRefs.current.set(item.bindingId, node); else itemRefs.current.delete(item.bindingId); }}
      >
        <h3>{item.title}</h3>
        <dl className="research-material-fields"><div><dt>出版社</dt><dd>{item.publisher || "出版社未知"}</dd></div><div><dt>出版日期</dt><dd>{publicationLabel(item)}</dd></div><div><dt>ISBN</dt><dd>{item.isbn || "ISBN 缺失"}</dd></div></dl>
        <p className="research-muted">加入于 {dateLabel(item.addedAt)} · 最近活动 {dateLabel(item.activityAt)}</p>
        {item.noteSummary ? <section className="research-note-preview" aria-label="笔记摘要">
          <strong>研究笔记 · v{item.noteSummary.currentRevisionNo}</strong>
          <p className="research-muted">更新于 {dateLabel(item.noteSummary.updatedAt)}</p>
          <p className="research-note-excerpt">{item.noteSummary.excerpt || "（当前笔记没有可预览的正文）"}</p>
        </section> : <p className="research-muted">尚未写研究笔记</p>}
        <div className="research-material-actions">
          {item.catalogBookId ? <Link to={`/books/${encodeURIComponent(item.catalogBookId)}`}>查看书目</Link> : null}
          {!readOnly ? <button type="button" className="research-text-button" disabled={!!removingId} onClick={() => void remove(item)}>{removingId === item.bindingId ? "正在移出…" : "移出项目"}</button> : null}
        </div>
        {item.noteSummary || !readOnly ? <ProjectItemNotePanel token={token} projectId={projectId} item={noteItem} readOnly={readOnly} buttonLabel={item.noteSummary ? "打开笔记" : "写笔记"} /> : null}
      </article>;
    })}</div>
  </section>;
}
