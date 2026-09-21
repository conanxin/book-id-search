import { useEffect, useRef, useState } from "react";
import {
  listEvidenceCandidates,
  previewEvidenceManifest,
  ProjectApiError,
  type CandidateClaim,
  type EvidenceCandidate,
  type EvidenceRole,
} from "./api";

type CandidateLoadState = "collapsed" | "loading" | "ready" | "unavailable";
type PreviewState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ready"; response: Awaited<ReturnType<typeof previewEvidenceManifest>> }
  | { state: "unavailable"; message: string };

type LocalEvidenceItem = {
  role: EvidenceRole;
  candidate: EvidenceCandidate;
  note: string;
};

const roleLabels: Record<EvidenceRole, string> = {
  SUPPORTING: "作为支持证据",
  CONTRADICTORY: "作为反驳证据",
  CONTEXTUAL: "作为背景证据",
};
const roleNames: Record<EvidenceRole, string> = {
  SUPPORTING: "支持",
  CONTRADICTORY: "反驳",
  CONTEXTUAL: "背景",
};

function candidateLabel(candidate: EvidenceCandidate): string {
  if (candidate.targetType === "SOURCE") return `来源记录 · ${candidate.materialTitle}`;
  if (candidate.targetType === "SOURCE_ASSET") return `来源资料 · ${candidate.materialTitle}`;
  return `项目笔记 · 第 ${candidate.revisionNo} 版`;
}

export function EvidenceEditor(props: { token: string; projectId: string; issueId: string; claim: CandidateClaim }) {
  const { token, projectId, issueId, claim } = props;
  const [load, setLoad] = useState<CandidateLoadState>("collapsed");
  const [candidates, setCandidates] = useState<EvidenceCandidate[]>([]);
  const [draft, setDraft] = useState<LocalEvidenceItem[]>([]);
  const [preview, setPreview] = useState<PreviewState>({ state: "idle" });
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => active.current?.abort(), []);

  function mutateDraft(update: (previous: LocalEvidenceItem[]) => LocalEvidenceItem[]) {
    setDraft(previous => update(previous));
    setPreview({ state: "idle" });
  }

  async function loadCandidates(retry = false) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setLoad("loading");
    try {
      const result = await listEvidenceCandidates(token, projectId, issueId, claim.id, controller.signal);
      if (controller.signal.aborted) return;
      setCandidates(result.candidates);
      setLoad("ready");
    } catch (error) {
      if (controller.signal.aborted) return;
      void error;
      setLoad("unavailable");
    }
  }

  async function runPreview() {
    if (!draft.length) return;
    setPreview({ state: "loading" });
    try {
      const response = await previewEvidenceManifest(
        token, projectId, issueId, claim.id,
        draft.map(item => ({ role: item.role, targetType: item.candidate.targetType, targetId: item.candidate.targetId, note: item.note })),
      );
      setPreview({ state: "ready", response });
    } catch (error) {
      if (error instanceof ProjectApiError) {
        setPreview({ state: "unavailable", message: error.message });
      } else {
        setPreview({ state: "unavailable", message: "证据预览暂不可用。" });
      }
    }
  }

  if (load === "collapsed") {
    return <div className="evidence-editor"><button type="button" className="evidence-toggle" onClick={() => void loadCandidates()}>构建证据集</button></div>;
  }

  return <div className="evidence-editor" aria-label={`证据集 ${claim.id}`}>
    {load === "loading" ? <p role="status">正在读取证据候选…</p> : null}
    {load === "unavailable" ? <div className="research-error" role="alert">证据候选暂不可用。<button type="button" onClick={() => void loadCandidates(true)}>重试证据候选</button></div> : null}
    {load === "ready" ? <>
      {candidates.length ? <ul className="evidence-candidates">
        {candidates.map(candidate => {
          const selected = draft.some(item => item.candidate.targetType === candidate.targetType && item.candidate.targetId === candidate.targetId);
          return <li key={`${candidate.targetType}:${candidate.targetId}`} data-testid={`candidate-${candidate.targetId}`}>
            <span>{candidateLabel(candidate)}</span>
            {selected ? <small>已选</small> : <span className="evidence-role-actions">
              {(Object.keys(roleLabels) as EvidenceRole[]).map(role => (
                <button key={role} type="button" onClick={() => mutateDraft(previous => [...previous, { role, candidate, note: "" }])}>{roleLabels[role]}</button>
              ))}
            </span>}
          </li>;
        })}
      </ul> : <p>本项目暂无可用证据候选。</p>}
      {draft.length ? <div className="evidence-draft">
        <h4>已选证据（{draft.length} 项）</h4>
        <ol>
          {draft.map((item, index) => (
            <li key={`${item.candidate.targetType}:${item.candidate.targetId}`} data-testid={`selected-${item.candidate.targetId}`}>
              <span>{candidateLabel(item.candidate)}</span>
              <label>证据角色
                <select value={item.role} onChange={e => mutateDraft(previous => previous.map((row, i) => i === index ? { ...row, role: e.target.value as EvidenceRole } : row))}>
                  {(Object.keys(roleNames) as EvidenceRole[]).map(role => <option key={role} value={role}>{roleNames[role]} · {role}</option>)}
                </select>
              </label>
              <label>证据说明
                <textarea rows={2} value={item.note} onChange={e => mutateDraft(previous => previous.map((row, i) => i === index ? { ...row, note: e.target.value } : row))} />
              </label>
              <span className="evidence-order-actions">
                <button type="button" disabled={index === 0} onClick={() => mutateDraft(previous => { const next = [...previous]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>上移</button>
                <button type="button" disabled={index === draft.length - 1} onClick={() => mutateDraft(previous => { const next = [...previous]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; return next; })}>下移</button>
                <button type="button" onClick={() => mutateDraft(previous => previous.filter((_, i) => i !== index))}>移除</button>
              </span>
            </li>
          ))}
        </ol>
        <button type="button" className="research-primary" disabled={!draft.length || preview.state === "loading"} onClick={() => void runPreview()}>预览 EvidenceManifest</button>
      </div> : null}
      {preview.state === "loading" ? <p role="status">正在生成预览…</p> : null}
      {preview.state === "ready" ? <div className="evidence-preview" role="status">
        <p>证据草稿 {preview.response.draft.items.length} 项</p>
        <p>SHA-256：<code>{preview.response.draft.manifestSha256}</code></p>
        <p>尚未提交。</p><p>将在评价该 Claim 时冻结为 EvidenceManifest。</p>
      </div> : null}
      {preview.state === "unavailable" ? <div className="research-error" role="alert">{preview.message}</div> : null}
    </> : null}
  </div>;
}
