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

type LoadState = "loading" | "ready" | "unavailable";
type PageState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; cursor: string };

function typeLabel(type: IssueResolutionSummary["resolutionType"]): string {
  if (type === "PREFERRED_CLAIM") return "采用一个可能答案";
  if (type === "INSUFFICIENT_EVIDENCE") return "证据不足";
  return "暂不形成工作结论";
}

export function IssueResolutionHistory({ token, projectId, issueId, refreshVersion }: Props) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [resolutions, setResolutions] = useState<IssueResolutionSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageState, setPageState] = useState<PageState>({ state: "idle" });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const initial = useRef<AbortController | null>(null);
  const older = useRef<AbortController | null>(null);

  async function loadInitial(signal?: AbortSignal) {
    setLoadState("loading");
    setPageState({ state: "idle" });
    try {
      const result = await listIssueResolutions(token, projectId, issueId, { limit: 20 }, signal);
      if (signal?.aborted) return;
      setResolutions(result.resolutions);
      setNextCursor(result.nextCursor);
      setLoadState("ready");
      if (selectedId && !result.resolutions.some(item => item.id === selectedId)) setSelectedId(null);
    } catch {
      if (!signal?.aborted) setLoadState("unavailable");
    }
  }

  useEffect(() => {
    initial.current?.abort();
    older.current?.abort();
    const controller = new AbortController();
    initial.current = controller;
    void loadInitial(controller.signal);
    return () => controller.abort();
  }, [token, projectId, issueId, refreshVersion]);

  async function loadOlder(cursor: string) {
    older.current?.abort();
    const controller = new AbortController();
    older.current = controller;
    setPageState({ state: "loading" });
    try {
      const result = await listIssueResolutions(
        token,
        projectId,
        issueId,
        { limit: 20, cursor },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setResolutions(previous => {
        const seen = new Set(previous.map(item => item.id));
        const merged = [...previous, ...result.resolutions.filter(item => !seen.has(item.id))];
        return merged.map(item => ({
          ...item,
          isCurrent: result.issue.currentResolutionId !== null
            && item.id === result.issue.currentResolutionId,
        }));
      });
      setNextCursor(result.nextCursor);
      setPageState({ state: "idle" });
    } catch {
      if (!controller.signal.aborted) setPageState({ state: "error", cursor });
    } finally {
      if (older.current === controller) older.current = null;
    }
  }

  return <section className="issue-resolution-history" aria-label="工作结论历史">
    <h2>工作结论历史</h2>
    {loadState === "loading" ? <p role="status">正在读取工作结论历史…</p> : null}
    {loadState === "unavailable" ? <div className="research-error" role="alert">
      工作结论历史暂时无法加载。
      <button type="button" onClick={() => void loadInitial()}>重试工作结论历史</button>
    </div> : null}
    {loadState === "ready" && resolutions.length === 0 ? <p>还没有工作结论历史。</p> : null}
    {loadState === "ready" && resolutions.length > 0 ? <ol className="issue-resolution-history-list">
      {resolutions.map(resolution => <li key={resolution.id} className="issue-resolution-card">
        <div className="issue-resolution-card-heading">
          <strong>{typeLabel(resolution.resolutionType)}</strong>
          {resolution.isCurrent ? <span className="research-issue-state">CURRENT</span> : null}
        </div>
        {resolution.preferredClaimId ? <p>可能答案：<code>{resolution.preferredClaimId}</code></p> : null}
        <p className="issue-resolution-rationale">{resolution.rationaleExcerpt ?? "未记录结论理由"}</p>
        <small>{new Date(resolution.createdAt).toLocaleString("zh-CN")}</small>
        <p>{resolution.evidenceBasisAvailable ? "证据依据当前可用" : "未指定或当前不可访问证据依据"}</p>
        <button type="button" onClick={() => setSelectedId(resolution.id)}>查看完整结论</button>
        {selectedId === resolution.id ? <IssueResolutionDetail
          token={token}
          projectId={projectId}
          issueId={issueId}
          resolutionId={resolution.id}
          onClose={() => setSelectedId(null)}
        /> : null}
      </li>)}
    </ol> : null}
    {nextCursor ? <button
      type="button"
      disabled={pageState.state === "loading"}
      onClick={() => void loadOlder(nextCursor)}
    >
      {pageState.state === "loading" ? "正在加载…" : "加载更早工作结论"}
    </button> : null}
    {pageState.state === "error" ? <div className="research-error" role="alert">
      更早的工作结论暂时无法加载。
      <button type="button" onClick={() => void loadOlder(pageState.cursor)}>重试加载更早工作结论</button>
    </div> : null}
  </section>;
}
