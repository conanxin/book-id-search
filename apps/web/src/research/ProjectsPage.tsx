import { ProjectItems } from "./ProjectItems";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, FolderOpen, Plus } from "lucide-react";
import { createProject, getProjectOverview, listProjects, type Project, type ProjectOverview } from "./api";
import { saveS32Token, useS32Token } from "./access";
import { ResearchIssuesSection, useProjectResearchIssues } from "./ResearchIssues";
import "./research.css";

export const researchEnabled = import.meta.env.VITE_S32_ENABLED === "true";
const dateLabel = (value: string) => new Date(value).toLocaleString("zh-CN");
const errorLabel = (error: unknown) => error instanceof Error && error.name !== "TypeError" ? error.message : "无法连接项目服务，请检查本地服务后重试。";

export function ProjectCard({ project }: { project: Project }) {
  return <Link className="research-card" to={`/research/projects/${project.id}`}>
    <div className="research-card-title"><FolderOpen size={19} aria-hidden="true" /><h3>{project.name}</h3></div>
    <p className="research-excerpt">{project.description || "尚未填写研究目的"}</p>
    <span className="research-muted">创建于 {dateLabel(project.createdAt)}</span>
  </Link>;
}

export function ProjectDetails({ project, summary }: { project: Project & { readOnly?: boolean }; summary?: ProjectOverview["summary"] }) {
  return <article className="research-panel research-detail">
    <div className="research-detail-status"><span className="research-eyebrow">研究项目</span>{project.readOnly ? <span className="research-read-only">已归档 · 只读</span> : null}</div>
    <h1>{project.name}</h1>
    {summary ? <dl className="research-overview-summary">
      <div><dt>资料</dt><dd>{summary.itemCount}</dd></div>
      <div><dt>笔记</dt><dd>{summary.noteCount}</dd></div>
      <div><dt>最近活动</dt><dd>{summary.lastActivityAt ? dateLabel(summary.lastActivityAt) : "尚无研究活动"}</dd></div>
    </dl> : null}
    <h2>研究目的</h2>
    <p className="research-purpose">{project.description || "尚未填写研究目的"}</p>
    <dl className="research-dates"><div><dt>创建时间</dt><dd>{dateLabel(project.createdAt)}</dd></div><div><dt>更新时间</dt><dd>{dateLabel(project.updatedAt)}</dd></div></dl>
  </article>;
}

export function ProjectWorkspace({ token, projectId }: { token: string; projectId?: string }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [projects, setProjects] = useState<Project[]>([]);
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState("");
  const [creating, setCreating] = useState(false);
  const submission = useRef<AbortController | null>(null);
  const researchIssues = useProjectResearchIssues(token, projectId ?? "");
  useEffect(() => () => { submission.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(""); setOverview(null); setProjects([]);
    const load = projectId ? getProjectOverview(token, projectId, controller.signal).then((data) => { if (!controller.signal.aborted) setOverview(data); })
      : listProjects(token, controller.signal).then((data) => { if (!controller.signal.aborted) setProjects(data.projects); });
    void load.catch((err) => { if (!controller.signal.aborted) setError(errorLabel(err)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, projectId, attempt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submission.current) return;
    if (!name.trim() || [...name.trim()].length > 120 || [...description.trim()].length > 2000) {
      setFormError("请输入 1–120 个字符的项目名称，研究目的最多 2000 个字符。"); return;
    }
    const controller = new AbortController();
    submission.current = controller;
    setCreating(true); setFormError("");
    try {
      const result = await createProject(token, { name: name.trim(), description: description.trim() || null }, controller.signal);
      if (!controller.signal.aborted) navigate(`/research/projects/${result.project.id}`);
    } catch (err) {
      if (!controller.signal.aborted) setFormError(`${errorLabel(err)} 未自动重试；若结果不确定，请先刷新列表确认。`);
    } finally {
      if (!controller.signal.aborted) { setCreating(false); submission.current = null; }
    }
  }

  if (projectId) {
    const issuesProject = researchIssues.result.state === "ready" ? researchIssues.result.response.project : null;
    return <>
      {overview && !loading && !error ? <ProjectDetails project={overview.project} summary={overview.summary} /> : issuesProject ? <article className="research-panel research-detail"><div className="research-detail-status"><span className="research-eyebrow">研究项目</span>{issuesProject.readOnly ? <span className="research-read-only">已归档 · 只读</span> : null}</div><h1>{issuesProject.name}</h1></article> : null}
      <ResearchIssuesSection token={token} projectId={projectId} result={researchIssues.result} retry={researchIssues.retry} />
      <section className="research-materials" aria-labelledby="research-materials-heading">
        <h2 id="research-materials-heading">研究资料</h2>
        {loading ? <p role="status" className="research-panel">正在读取研究资料…</p> : null}
        {error ? <div role="alert" className="research-error">研究资料暂不可用。<button onClick={() => setAttempt((n) => n + 1)}>重试研究资料</button></div> : null}
        {overview && !loading && !error ? <ProjectItems token={token} projectId={overview.project.id} items={overview.items} readOnly={overview.project.readOnly} focusedBindingId={searchParams.get("item")} onItemsChanged={() => setAttempt(n => n + 1)} /> : null}
      </section>
    </>;
  }
  return <div className="research-grid">
    <section className="research-panel">
      <h2><Plus size={18} aria-hidden="true" />新建项目</h2>
      <p className="research-muted">从一个想研究的问题开始。</p>
      <form onSubmit={submit} className="research-form">
        <label htmlFor="project-name">项目名称 <span aria-hidden="true">*</span></label>
        <input id="project-name" value={name} onChange={(e) => setName(e.target.value)} required disabled={creating} placeholder="例如：北京古道研究" aria-describedby="project-name-help" />
        <small id="project-name-help" className="research-muted">最多 120 个字符</small>
        <label htmlFor="project-description">研究目的 <span className="research-muted">（选填）</span></label>
        <textarea id="project-description" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} disabled={creating} placeholder="你想了解什么？准备从哪些线索开始？" aria-describedby="project-description-help" />
        <small id="project-description-help" className="research-muted">{[...description.trim()].length} / 2000</small>
        {formError ? <p className="research-error" role="alert">{formError}</p> : null}
        <button className="research-primary" type="submit" disabled={creating}>{creating ? "正在创建…" : "创建项目"}</button>
      </form>
    </section>
    <section aria-labelledby="project-list-heading">
      <div className="research-list-heading"><h2 id="project-list-heading">我的项目</h2><button className="research-text-button" disabled={loading} onClick={() => setAttempt((n) => n + 1)}>刷新列表</button></div>
      {loading ? <p className="research-panel" role="status">正在读取项目…</p> : error ? <div className="research-error" role="alert">{error}<button onClick={() => setAttempt((n) => n + 1)}>重试读取</button></div> : projects.length ? <div className="research-list">{projects.map((item) => <ProjectCard key={item.id} project={item} />)}</div> : <div className="research-panel research-empty"><FolderOpen size={30} aria-hidden="true" /><h3>还没有研究项目</h3><p>创建第一个项目，记录你的研究目的。</p></div>}
    </section>
  </div>;
}

export default function ProjectsPage() {
  const { projectId } = useParams();
  const token = useS32Token();
  const [input, setInput] = useState("");
  useEffect(() => {
    const previousTitle = document.title;
    document.title = projectId ? "项目详情 · BOOK-ID-SEARCH" : "我的研究项目 · BOOK-ID-SEARCH";
    return () => { document.title = previousTitle; };
  }, [projectId]);
  return <main className="page research-page">
    <nav className="research-nav" aria-label="研究导航"><Link to="/">查书</Link><Link to="/weread">微信读书</Link><Link to="/research/projects" aria-current={projectId ? undefined : "page"}>我的研究项目</Link></nav>
    {projectId ? <Link className="research-back" to="/research/projects"><ArrowLeft size={16} />返回项目列表</Link> : <header className="research-header"><div className="brand-row"><FolderOpen size={28} /><h1>我的研究项目</h1></div><p>为想深入了解的主题，留下一处起点。</p></header>}
    {!researchEnabled ? <p className="research-panel" role="status">研究项目功能尚未开启。</p> : <>
      <section className="research-access" aria-label="研究项目访问">
        {token ? <><span>研究项目访问凭据已设置</span><button className="research-text-button" onClick={() => { saveS32Token(null); setInput(""); }}>清除访问凭据</button></> : <form onSubmit={(event) => { event.preventDefault(); saveS32Token(input); setInput(""); }}>
          <label htmlFor="research-token">研究项目访问凭据</label><input id="research-token" type="password" autoComplete="off" value={input} onChange={(e) => setInput(e.target.value)} required placeholder="输入独立的 S32 访问凭据" /><button className="research-primary" disabled={!input.trim()}>进入研究项目</button>
          <small className="research-muted">凭据仅在当前浏览器会话中使用，与微信读书独立。</small>
        </form>}
      </section>
      {token ? <ProjectWorkspace key={`${token}:${projectId ?? "list"}`} token={token} projectId={projectId} /> : null}
    </>}
  </main>;
}
