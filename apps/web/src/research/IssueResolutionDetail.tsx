import { useEffect, useRef, useState } from "react";
import {
  getIssueResolution,
  ProjectApiError,
  type IssueResolutionDetailResponse,
} from "./api";
import { EvidenceCitationScope } from "./EvidenceCitationScope";

type Props = {
  projectId: string;
  issueId: string;
  resolutionId: string;
  onClose: () => void;
};

type State =
  | { state: "loading" }
  | { state: "ready"; detail: IssueResolutionDetailResponse }
  | { state: "not-available" }
  | { state: "error" };

function typeLabel(type: IssueResolutionDetailResponse["resolution"]["resolutionType"]): string {
  if (type === "PREFERRED_CLAIM") return "采用一个可能答案";
  if (type === "INSUFFICIENT_EVIDENCE") return "证据不足";
  return "暂不形成工作结论";
}

export function IssueResolutionDetail({
  projectId,
  issueId,
  resolutionId,
  onClose,
}: Props) {
  const [state, setState] = useState<State>({ state: "loading" });
  const active = useRef<AbortController | null>(null);

  async function load() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ state: "loading" });
    try {
      const detail = await getIssueResolution(projectId,
        issueId,
        resolutionId,
        controller.signal,
      );
      if (!controller.signal.aborted) setState({ state: "ready", detail });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ProjectApiError && error.status === 404) {
        setState({ state: "not-available" });
      } else {
        setState({ state: "error" });
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  useEffect(() => {
    void load();
    return () => active.current?.abort();
  }, [projectId, issueId, resolutionId]);

  return <section className="issue-resolution-detail" aria-label="完整工作结论">
    <div className="issue-resolution-detail-heading">
      <h3>完整工作结论</h3>
      <button type="button" onClick={onClose}>关闭</button>
    </div>
    {state.state === "loading" ? <p role="status">正在读取完整工作结论…</p> : null}
    {state.state === "not-available" ? <div className="research-error" role="alert">该工作结论当前不可用。</div> : null}
    {state.state === "error" ? <div className="research-error" role="alert">
      完整工作结论暂时无法加载。
      <button type="button" onClick={() => void load()}>重试完整工作结论</button>
    </div> : null}
    {state.state === "ready" ? <>
      <p><strong>{typeLabel(state.detail.resolution.resolutionType)}</strong>{state.detail.resolution.isCurrent ? " · 当前结论" : ""}</p>
      {state.detail.resolution.preferredClaimId ? <p>可能答案：<code>{state.detail.resolution.preferredClaimId}</code></p> : null}
      <small>{new Date(state.detail.resolution.createdAt).toLocaleString("zh-CN")}</small>
      <h4>结论理由</h4>
      <p className="issue-resolution-rationale">{state.detail.resolution.rationale ?? "未记录结论理由"}</p>
      <h4>证据依据</h4>
      {!state.detail.evidenceBasisAvailable || !state.detail.evidenceManifest
        ? <p>未指定证据依据，或该证据当前不可访问。</p>
        : <>
            <p>{state.detail.evidenceManifest.items.length} 条冻结证据</p>
            <code className="assessment-hash">{state.detail.evidenceManifest.manifestSha256}</code>
            <EvidenceCitationScope items={state.detail.evidenceManifest.items} />
            <ol className="assessment-detail-items">
              {state.detail.evidenceManifest.items.map(item => <li key={item.ordinal}>
                <strong>{item.role} · {item.targetType}</strong>
                <code>{item.targetId}</code>
                {item.note !== null ? <p>{item.note}</p> : null}
              </li>)}
            </ol>
          </>}
    </> : null}
  </section>;
}
