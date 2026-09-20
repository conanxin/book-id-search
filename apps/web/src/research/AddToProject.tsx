import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useS32Token } from "./access";
import { addCatalogBookToProject, listProjects, ProjectApiError, type Project, type ProjectResearchItem, type ResearchMembership } from "./api";
import { researchEnabled } from "./ProjectsPage";
import type { MembershipLoadState } from "./SearchMemberships";

type Props = {
  bookId: string;
  bookTitle: string;
  onAdded?: (item: ProjectResearchItem) => void;
  memberships?: ResearchMembership[];
  membershipState?: MembershipLoadState;
  onMembershipInvalidated?: () => void;
};
export function AddToProject(props: Props) {
  const token = useS32Token();
  if (!researchEnabled) return null;
  // A changed credential/book owns a fresh panel; stale responses cannot mark it as added.
  return <ProjectSelector key={`${token ?? ""}:${props.bookId}`} {...props} token={token} />;
}
function ProjectSelector({ bookId, bookTitle, onAdded, memberships, membershipState, onMembershipInvalidated, token }: Props & { token: string | null }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [added, setAdded] = useState("");
  const [allActiveAlreadyAdded, setAllActiveAlreadyAdded] = useState(false);
  const [awaitingMembershipRefresh, setAwaitingMembershipRefresh] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const submitting = useRef(false);
  useEffect(() => () => { controller.current?.abort(); }, []);
  function close() { controller.current?.abort(); controller.current = null; setOpen(false); }
  async function show() {
    if (open) { if (!pending) close(); return; }
    setOpen(true); setError(""); setProjects([]); setAllActiveAlreadyAdded(false);
    if (!token) return;
    const request = new AbortController(); controller.current = request; setLoading(true);
    try {
      const data = await listProjects(token, request.signal);
      if (!request.signal.aborted) {
        const activeProjects = data.projects.filter(p => p.lifecycleState === "ACTIVE");
        const activeMembershipProjectIds = new Set((memberships ?? [])
          .filter(item => item.projectLifecycleState === "ACTIVE")
          .map(item => item.projectId));
        const candidates = activeProjects.filter(project => !activeMembershipProjectIds.has(project.id));
        setProjects(candidates);
        setAllActiveAlreadyAdded(activeProjects.length > 0 && candidates.length === 0);
      }
    } catch (err) {
      if (!request.signal.aborted) setError(err instanceof ProjectApiError ? err.message : "无法读取项目，请稍后再试。");
    } finally { if (!request.signal.aborted) setLoading(false); }
  }
  async function add(project: Project) {
    const request = controller.current;
    if (!token || !request || request.signal.aborted || submitting.current) return;
    submitting.current = true; setPending(true); setError(""); setAdded("");
    try {
      const result = await addCatalogBookToProject(token, project.id, bookId, request.signal);
      if (!request.signal.aborted) {
        setPending(false);
        setAdded(project.name);
        setAwaitingMembershipRefresh(true);
        close();
        onAdded?.(result.item);
        onMembershipInvalidated?.();
      }
    } catch (err) {
      if (!request.signal.aborted) setError(err instanceof ProjectApiError ? err.message : "加入未能确认，请稍后重试。");
    } finally { submitting.current = false; if (!request.signal.aborted) setPending(false); }
  }
  return <div className="research-add">
    <button type="button" className="toolbar-button" aria-expanded={open} disabled={pending && open} onClick={() => void show()}>加入研究</button>
    {added ? <span role="status" className="research-add-success">{awaitingMembershipRefresh && membershipState === "unavailable" ? "已加入项目；研究状态暂未能重新确认。" : `已加入「${added}」`}</span> : null}
    {open ? <section className="research-add-panel" aria-label={`将《${bookTitle}》加入研究项目`}>
      {!token ? <p>先进入<Link to="/research/projects">我的研究项目</Link>设置访问凭据。</p> : <>
        <strong>选择一个研究项目</strong>
        {loading ? <p role="status">正在读取项目…</p> : null}
        {error ? <p role="alert" className="research-error">{error}</p> : null}
        {!loading && !error && allActiveAlreadyAdded ? <p>已加入全部现有研究项目</p> : null}
        {!loading && !error && projects.length === 0 && !allActiveAlreadyAdded ? <p>暂无研究项目 <Link to="/research/projects">先创建项目</Link></p> : null}
        {!loading ? projects.map(project => <button type="button" className="research-project-choice" key={project.id} disabled={pending} onClick={() => void add(project)}>{project.name}</button>) : null}
        {pending ? <p role="status">正在加入…</p> : null}
      </>}
      <button type="button" className="research-text-button" onClick={close} disabled={pending}>关闭</button>
    </section> : null}
  </div>;
}
