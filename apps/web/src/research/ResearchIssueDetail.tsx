import { CandidateClaims } from "./CandidateClaims";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getResearchIssue, ProjectApiError, type ResearchIssueDetailResponse } from "./api";

export function ResearchIssueDetail({ token, projectId, issueId }: { token: string; projectId: string; issueId: string }) {
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<ResearchIssueDetailResponse | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "unavailable">("loading");

  useEffect(() => {
    const previous = document.title;
    document.title = "研究问题 · BOOK-ID-SEARCH";
    return () => { document.title = previous; };
  }, []);
  useEffect(() => {
    if (response) document.title = `${response.issue.title} · BOOK-ID-SEARCH`;
  }, [response]);
  useEffect(() => {
    const controller = new AbortController();
    setState("loading"); setResponse(null);
    void getResearchIssue(token, projectId, issueId, controller.signal)
      .then((value) => { if (!controller.signal.aborted) { setResponse(value); setState("ready"); } })
      .catch((error) => {
        if (!controller.signal.aborted) setState(error instanceof ProjectApiError && error.status === 404 ? "missing" : "unavailable");
      });
    return () => controller.abort();
  }, [token, projectId, issueId, attempt]);

  if (state === "loading") return <p className="research-panel" role="status">正在读取研究问题…</p>;
  if (state === "missing") return <div className="research-error" role="alert">研究问题不存在，或不属于当前项目。<button onClick={() => setAttempt((value) => value + 1)}>重试研究问题</button></div>;
  if (state === "unavailable") return <div className="research-error" role="alert">研究问题暂不可用。<button onClick={() => setAttempt((value) => value + 1)}>重试研究问题</button></div>;
  if (!response) return null;
  return <article className="research-panel research-issue-detail">
    <Link className="research-back" to={`/research/projects/${response.project.id}`}>返回 {response.project.name}</Link>
    <div className="research-detail-status"><span className="research-issue-state">{response.issue.lifecycleState}</span>{response.project.readOnly ? <span className="research-read-only">已归档 · 只读</span> : null}</div>
    <h1>{response.issue.title}</h1>
    <p className="research-issue-question">{response.issue.question}</p>
    <dl className="research-dates"><div><dt>创建时间</dt><dd>{new Date(response.issue.createdAt).toLocaleString("zh-CN")}</dd></div><div><dt>更新时间</dt><dd>{new Date(response.issue.updatedAt).toLocaleString("zh-CN")}</dd></div></dl>
    <CandidateClaims token={token} project={response.project} issue={response.issue} />
    <Link to={`/research/projects/${response.project.id}`}>返回项目资料</Link>
  </article>;
}
