import { useEffect, useRef, useState } from "react";
import {
  getAssessment,
  ProjectApiError,
  type AssessmentDetailResponse,
} from "./api";

type Props = {
  token: string;
  projectId: string;
  issueId: string;
  claimId: string;
  assessmentId: string;
  onClose: () => void;
  onRefreshHistory: () => void;
};

type State =
  | { state: "loading" }
  | { state: "ready"; detail: AssessmentDetailResponse }
  | { state: "not-available" }
  | { state: "error" };

export function AssessmentDetail({
  token,
  projectId,
  issueId,
  claimId,
  assessmentId,
  onClose,
  onRefreshHistory,
}: Props) {
  const [state, setState] = useState<State>({ state: "loading" });
  const active = useRef<AbortController | null>(null);

  async function load() {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setState({ state: "loading" });
    try {
      const detail = await getAssessment(
        token,
        projectId,
        issueId,
        claimId,
        assessmentId,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setState({ state: "ready", detail });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ProjectApiError && error.status === 404 && error.code === "ASSESSMENT_NOT_FOUND") {
        setState({ state: "not-available" });
        onRefreshHistory();
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
  }, [token, projectId, issueId, claimId, assessmentId]);

  return <section className="assessment-detail" aria-label="完整评价">
    <div className="assessment-detail-heading">
      <h4>完整评价</h4>
      <button type="button" onClick={onClose}>关闭</button>
    </div>
    {state.state === "loading" ? <p role="status">正在读取完整评价…</p> : null}
    {state.state === "not-available" ? <div className="research-error" role="alert">该评价当前不可用。</div> : null}
    {state.state === "error" ? <div className="research-error" role="alert">
      完整评价暂时无法加载。
      <button type="button" onClick={() => void load()}>重试完整评价</button>
    </div> : null}
    {state.state === "ready" ? <>
      <p><strong>{state.detail.assessment.stance}</strong>{state.detail.assessment.confidenceLevel ? ` · ${state.detail.assessment.confidenceLevel}` : ""}</p>
      <small>{new Date(state.detail.assessment.createdAt).toLocaleString("zh-CN")}</small>
      <h5>判断理由</h5>
      {state.detail.assessment.reasoning === null
        ? <p>未记录判断理由</p>
        : <p className="assessment-reasoning">{state.detail.assessment.reasoning}</p>}
      <h5>冻结证据</h5>
      <p>SHA-256</p>
      <code className="assessment-hash">{state.detail.evidenceManifest.manifestSha256}</code>
      <ol className="assessment-detail-items">
        {state.detail.evidenceManifest.items.map(item => (
          <li key={item.ordinal}>
            <strong>{item.role} · {item.targetType}</strong>
            <code>{item.targetId}</code>
            {item.note !== null ? <p>{item.note}</p> : null}
          </li>
        ))}
      </ol>
    </> : null}
  </section>;
}
