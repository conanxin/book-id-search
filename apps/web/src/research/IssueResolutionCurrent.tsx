import { useEffect, useRef, useState } from "react";
import {
  listIssueResolutions,
  type IssueResolutionSummary,
} from "./api";
import { IssueResolutionDetail } from "./IssueResolutionDetail";

type Props = {
  token: string;
  projectId: string;
  issueId: string;
  refreshVersion: number;
};

type State =
  | { state: "loading" }
  | { state: "ready"; current: IssueResolutionSummary | null }
  | { state: "unavailable" };

function typeLabel(type: IssueResolutionSummary["resolutionType"]): string {
  if (type === "PREFERRED_CLAIM") return "采用一个可能答案";
  if (type === "INSUFFICIENT_EVIDENCE") return "证据不足";
  return "暂不形成工作结论";
}

export function IssueResolutionCurrent({ token, projectId, issueId, refreshVersion }: Props) {
  const [state, setState] = useState<State>({ state: "loading" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);

  async function load(signal?: AbortSignal) {
    setState({ state: "loading" });
    try {
      const result = await listIssueResolutions(
        token,
        projectId,
        issueId,
        { limit: 1 },
        signal,
      );
      if (signal?.aborted) return;
      setState({ state: "ready", current: result.currentResolution });
      if (selectedId && result.issue.currentResolutionId !== selectedId) setSelectedId(null);
    } catch {
      if (!signal?.aborted) setState({ state: "unavailable" });
    }
  }

  useEffect(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, [token, projectId, issueId, refreshVersion]);

  return <section className="issue-resolution-current" aria-label="当前工作结论">
    <h2>当前工作结论</h2>
    {state.state === "loading" ? <p role="status">正在读取当前工作结论…</p> : null}
    {state.state === "unavailable" ? <div className="research-error" role="alert">
      当前工作结论暂时无法加载。
      <button type="button" onClick={() => void load()}>重试当前工作结论</button>
    </div> : null}
    {state.state === "ready" && state.current === null ? <p>尚未形成当前工作结论。</p> : null}
    {state.state === "ready" && state.current ? <article className="issue-resolution-card issue-resolution-card-current">
      <div className="issue-resolution-card-heading">
        <strong>{typeLabel(state.current.resolutionType)}</strong>
        <span className="research-issue-state">CURRENT</span>
      </div>
      {state.current.preferredClaimId ? <p>可能答案：<code>{state.current.preferredClaimId}</code></p> : null}
      <p className="issue-resolution-rationale">
        {state.current.rationaleExcerpt ?? "未记录结论理由"}
      </p>
      <small>{new Date(state.current.createdAt).toLocaleString("zh-CN")}</small>
      <p>{state.current.evidenceBasisAvailable ? "证据依据当前可用" : "未指定或当前不可访问证据依据"}</p>
      <button type="button" onClick={() => setSelectedId(state.current!.id)}>查看完整结论</button>
      {selectedId === state.current.id ? <IssueResolutionDetail
        token={token}
        projectId={projectId}
        issueId={issueId}
        resolutionId={selectedId}
        onClose={() => setSelectedId(null)}
      /> : null}
    </article> : null}
  </section>;
}
