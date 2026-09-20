import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  createResearchIssue,
  listResearchIssues,
  ProjectApiError,
  type ResearchIssueListResponse,
} from "./api";
import {
  clearPendingResearchIssueReceipt,
  getOrCreateResearchIssueReceipt,
  normalizeResearchIssueDraft,
} from "./research-issue-draft";

export type ResearchIssuesLoad =
  | { state: "loading"; response: null; error: "" }
  | { state: "ready"; response: ResearchIssueListResponse; error: "" }
  | { state: "unavailable"; response: null; error: string };

export function useProjectResearchIssues(token: string, projectId: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<ResearchIssuesLoad>({ state: "loading", response: null, error: "" });
  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    setResult({ state: "loading", response: null, error: "" });
    void listResearchIssues(token, projectId, controller.signal)
      .then((response) => { if (!controller.signal.aborted) setResult({ state: "ready", response, error: "" }); })
      .catch(() => { if (!controller.signal.aborted) setResult({ state: "unavailable", response: null, error: "研究问题暂不可用。" }); });
    return () => controller.abort();
  }, [token, projectId, attempt]);
  return { result, retry: () => setAttempt((value) => value + 1) };
}

type CreateState = "idle" | "submitting" | "unconfirmed" | "rejected" | "idempotency-conflict";

export function ResearchIssuesSection({ token, projectId, result, retry }: {
  token: string;
  projectId: string;
  result: ResearchIssuesLoad;
  retry: () => void;
}) {
  const navigate = useNavigate();
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<CreateState>("idle");
  const [message, setMessage] = useState("");
  const activeRequest = useRef<AbortController | null>(null);
  useEffect(() => () => activeRequest.current?.abort(), []);

  async function submit(forceNew = false) {
    if (activeRequest.current) return;
    let normalized;
    try {
      normalized = normalizeResearchIssueDraft({ title, question });
    } catch (error) {
      setState("rejected");
      setMessage(error instanceof Error ? error.message : "研究问题输入不正确。");
      return;
    }
    const controller = new AbortController();
    activeRequest.current = controller;
    setState("submitting");
    setMessage("");
    try {
      const receipt = await getOrCreateResearchIssueReceipt(projectId, normalized, forceNew);
      const response = await createResearchIssue(token, projectId, receipt.idempotencyKey, normalized, controller.signal);
      if (controller.signal.aborted) return;
      clearPendingResearchIssueReceipt();
      navigate(`/research/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(response.issue.id)}`);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ProjectApiError && error.code === "IDEMPOTENCY_CONFLICT") {
        setState("idempotency-conflict");
        setMessage("创建请求标识与当前研究问题内容不一致。");
      } else if (error instanceof ProjectApiError && (error.code === "PROJECT_READ_ONLY" || [400, 404].includes(error.status))) {
        clearPendingResearchIssueReceipt();
        setState("rejected");
        setMessage(error.message);
      } else {
        setState("unconfirmed");
        setMessage("创建结果尚未确认。使用同一标识重试不会有意创建重复问题。");
      }
    } finally {
      if (!controller.signal.aborted) activeRequest.current = null;
    }
  }

  const submitForm = (event: FormEvent) => { event.preventDefault(); void submit(false); };
  return <section className="research-issues" aria-labelledby="research-issues-heading">
    <div className="research-list-heading">
      <h2 id="research-issues-heading">研究问题</h2>
      {result.state === "ready" && !result.response.project.readOnly && !showForm ? <button className="research-primary" onClick={() => setShowForm(true)}>新建研究问题</button> : null}
    </div>
    {result.state === "loading" ? <p className="research-panel" role="status">正在读取研究问题…</p> : null}
    {result.state === "unavailable" ? <div className="research-error" role="alert">{result.error}<button onClick={retry}>重试研究问题</button></div> : null}
    {result.state === "ready" ? <>
      {result.response.issues.length ? <div className="research-issue-list">{result.response.issues.map((issue) => <Link className="research-card research-issue-card" key={issue.id} to={`/research/projects/${projectId}/issues/${issue.id}`}>
        <span className={`research-issue-state research-issue-state--${issue.lifecycleState.toLowerCase()}`}>{issue.lifecycleState}</span>
        <h3>{issue.title}</h3>
        <p>{issue.questionExcerpt}</p>
        <small className="research-muted">更新于 {new Date(issue.updatedAt).toLocaleString("zh-CN")}</small>
      </Link>)}</div> : <div className="research-panel research-empty"><h3>还没有研究问题</h3><p>创建一个明确的问题，作为后续研究的起点。</p></div>}
      {showForm && !result.response.project.readOnly ? <form className="research-panel research-issue-form" onSubmit={submitForm}>
        <h3>新建研究问题</h3>
        <label htmlFor="issue-title">问题标题</label>
        <input id="issue-title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={state === "submitting"} />
        <label htmlFor="issue-question">研究问题</label>
        <textarea id="issue-question" rows={6} value={question} onChange={(event) => setQuestion(event.target.value)} disabled={state === "submitting"} />
        {message ? <p className={state === "unconfirmed" || state === "idempotency-conflict" ? "research-issue-notice" : "research-error"} role="alert">{message}</p> : null}
        <div className="research-issue-actions">
          <button type="button" onClick={() => { setShowForm(false); setState("idle"); setMessage(""); }} disabled={state === "submitting"}>取消</button>
          {state === "unconfirmed" ? <button type="button" className="research-primary" onClick={() => void submit(false)}>使用同一标识重试</button> : null}
          {state === "idempotency-conflict" ? <button type="button" className="research-primary" onClick={() => void submit(true)}>作为新的研究问题重新提交</button> : null}
          {state !== "unconfirmed" && state !== "idempotency-conflict" ? <button className="research-primary" type="submit" disabled={state === "submitting"}>{state === "submitting" ? "正在创建…" : "创建研究问题"}</button> : null}
        </div>
      </form> : null}
    </> : null}
  </section>;
}
