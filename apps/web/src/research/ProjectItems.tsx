import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { listProjectItems, removeProjectItem, ProjectApiError, type ProjectResearchItem } from "./api";

type Props = { token: string; projectId: string };
export function ProjectItems(props: Props) {
  return <MaterialList key={`${props.token}:${props.projectId}`} {...props} />;
}
function publicationLabel(item: ProjectResearchItem) {
  if (!item.publicationDate) return "日期未知";
  if (item.publicationDatePrecision === "YEAR") return item.publicationDate.slice(0, 4);
  if (item.publicationDatePrecision === "MONTH") {
    return `${item.publicationDate.slice(0, 4)}年${Number(item.publicationDate.slice(5, 7))}月`;
  }
  return new Date(`${item.publicationDate}T00:00:00Z`).toLocaleDateString("zh-CN", { timeZone: "UTC" });
}
function MaterialList({ token, projectId }: Props) {
  const [items, setItems] = useState<ProjectResearchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const removing = useRef(false);
  useEffect(() => {
    const request = new AbortController(); controller.current = request;
    setLoading(true); setLoaded(false); setError(""); setItems([]);
    void listProjectItems(token, projectId, request.signal).then(data => {
      if (!request.signal.aborted) { setItems(data.items); setLoaded(true); }
    }).catch(err => {
      if (!request.signal.aborted) setError(err instanceof ProjectApiError ? err.message : "无法读取研究资料，请稍后再试。");
    }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [token, projectId, reloadVersion]);
  async function remove(item: ProjectResearchItem) {
    const request = controller.current;
    if (removing.current || !request || request.signal.aborted || !window.confirm(`将《${item.title}》移出项目？书目资料会保留。`)) return;
    removing.current = true; setRemovingId(item.bindingId); setError("");
    try {
      await removeProjectItem(token, projectId, item.bindingId, request.signal);
      if (!request.signal.aborted) setItems(current => current.filter(v => v.bindingId !== item.bindingId));
    } catch (err) {
      if (!request.signal.aborted) setError(err instanceof ProjectApiError ? err.message : "移出未能确认，请刷新资料后重试。");
    } finally { removing.current = false; if (!request.signal.aborted) setRemovingId(null); }
  }
  return <section className="research-materials" aria-label="研究资料">
    <div className="research-list-heading"><h2>{loaded ? `研究资料（${items.length}）` : "研究资料"}</h2><button className="research-text-button" disabled={loading || !!removingId} onClick={() => setReloadVersion(v => v + 1)}>刷新资料</button></div>
    {loading ? <p className="research-panel" role="status">正在读取研究资料…</p> : null}
    {error ? <p className="research-error" role="alert">{error}</p> : null}
    {loaded && !loading && items.length === 0 ? <div className="research-panel research-empty"><h3>还没有研究资料</h3><p>从<Link to="/">查书</Link>中选择一本书，加入这个研究项目。</p></div> : null}
    <div className="research-list">{items.map(item => <article className="research-panel research-material" key={item.bindingId}>
      <h3>{item.title}</h3>
      <dl className="research-material-fields"><div><dt>出版社</dt><dd>{item.publisher || "出版社未知"}</dd></div><div><dt>出版日期</dt><dd>{publicationLabel(item)}</dd></div><div><dt>ISBN</dt><dd>{item.isbn || "ISBN 缺失"}</dd></div></dl>
      <p className="research-muted">加入于 {new Date(item.addedAt).toLocaleString("zh-CN")}</p>
      <div className="research-material-actions">{item.catalogBookId ? <Link to={`/books/${encodeURIComponent(item.catalogBookId)}`}>查看书目</Link> : null}<button type="button" className="research-text-button" disabled={!!removingId} onClick={() => void remove(item)}>{removingId === item.bindingId ? "正在移出…" : "移出项目"}</button></div>
    </article>)}</div>
  </section>;
}
