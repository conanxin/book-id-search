import { useCallback, useEffect, useRef, useState } from "react";
import {
  listIssueResolutionEvidenceBases,
  replayResearchRun,
  ProjectApiError,
  type IssueResolutionEvidenceBasisSummary,
  type ResearchRunEnvironment,
  type ResearchRunExecutionContract,
  type ResearchRunProcedure,
} from "./api";
import {
  clearPendingResearchRunActionReceipt,
  getOrCreateResearchRunActionReceipt,
  loadPendingResearchRunActionReceipt,
  PendingResearchRunActionIntentConflictError,
  type PendingResearchRunActionReceipt,
} from "./research-run-action-draft";

type Props = {
  projectId: string;
  issueId: string;
  parentRunId: string;
  parentProcedure: ResearchRunProcedure;
  parentContract: ResearchRunExecutionContract;
  parentEnvironment: ResearchRunEnvironment;
  parentManifestId: string;
  pending: PendingResearchRunActionReceipt | null;
  onCommitted: () => void;
};

type EvidenceState =
  | { state: "loading" }
  | { state: "ready"; bases: IssueResolutionEvidenceBasisSummary[]; nextCursor: string | null }
  | { state: "unavailable" };
type EvidencePage = { state: "idle" | "loading" } | { state: "error"; cursor: string };
type ReplayState =
  | { state: "idle" }
  | { state: "open" }
  | { state: "submitting" }
  | { state: "created"; runId: string }
  | { state: "unconfirmed" }
  | { state: "conflict" }
  | { state: "rejected"; message: string };

const STANCE_LABELS: Record<string, string> = {
  SUPPORTS: "支持", CONTRADICTS: "反对", INCONCLUSIVE: "不确定",
};
const EVIDENCE_LIMIT = 50;

export function ResearchRunReplayComposer({ projectId, issueId, parentRunId, parentProcedure, parentContract, parentEnvironment, parentManifestId, pending, onCommitted }: Props) {
  const [replayState, setReplayState] = useState<ReplayState>(pending ? { state: "unconfirmed" } : { state: "idle" });
  const [evidence, setEvidence] = useState<EvidenceState>({ state: "loading" });
  const [evidencePage, setEvidencePage] = useState<EvidencePage>({ state: "idle" });
  const [evidenceId, setEvidenceId] = useState("");
  const [pendingReceipt, setPendingReceipt] = useState<PendingResearchRunActionReceipt | null>(pending);
  const initialEvidence = useRef<AbortController | null>(null);

  // Self-restore a scope-matched pending REPLAY on mount (parent may pass null).
  useEffect(() => {
    if (pending) return;
    const stored = loadPendingResearchRunActionReceipt();
    if (stored && stored.projectId === projectId && stored.issueId === issueId && stored.runId === parentRunId && stored.action === "REPLAY") {
      setPendingReceipt(stored);
      setReplayState({ state: "unconfirmed" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, issueId, parentRunId]);
  const olderEvidence = useRef<AbortController | null>(null);

  const relevantPending = pendingReceipt !== null && pendingReceipt.runId === parentRunId && pendingReceipt.action === "REPLAY"
    ? pendingReceipt : null;

  const loadEvidence = useCallback(async (signal?: AbortSignal) => {
    setEvidence({ state: "loading" });
    setEvidencePage({ state: "idle" });
    try {
      const result = await listIssueResolutionEvidenceBases(projectId, issueId, { limit: EVIDENCE_LIMIT }, signal);
      if (signal?.aborted) return;
      const seen = new Set<string>();
      const bases = result.evidenceBases.filter(base => !seen.has(base.manifestId) && seen.add(base.manifestId));
      setEvidence({ state: "ready", bases, nextCursor: result.nextCursor });
    } catch {
      if (!signal?.aborted) setEvidence({ state: "unavailable" });
    }
  }, [projectId, issueId]);

  useEffect(() => {
    if (replayState.state === "idle") return;
    initialEvidence.current?.abort();
    olderEvidence.current?.abort();
    const controller = new AbortController();
    initialEvidence.current = controller;
    void loadEvidence(controller.signal);
    return () => controller.abort();
  }, [loadEvidence, replayState.state !== "idle"]);

  useEffect(() => {
    if (relevantPending && replayState.state === "unconfirmed") {
      const command = relevantPending.command as unknown as { evidenceManifestId: string };
      setEvidenceId(command.evidenceManifestId);
    }
  }, [relevantPending, replayState.state]);

  async function loadOlderEvidence(cursor: string) {
    olderEvidence.current?.abort();
    const controller = new AbortController();
    olderEvidence.current = controller;
    setEvidencePage({ state: "loading" });
    try {
      const result = await listIssueResolutionEvidenceBases(projectId, issueId, { limit: EVIDENCE_LIMIT, cursor }, controller.signal);
      if (controller.signal.aborted) return;
      setEvidence(previous => {
        if (previous.state !== "ready") return previous;
        const seen = new Set(previous.bases.map(base => base.manifestId));
        return { state: "ready", bases: [...previous.bases, ...result.evidenceBases.filter(base => !seen.has(base.manifestId))], nextCursor: result.nextCursor };
      });
      setEvidencePage({ state: "idle" });
    } catch {
      if (!controller.signal.aborted) setEvidencePage({ state: "error", cursor });
    } finally {
      if (olderEvidence.current === controller) olderEvidence.current = null;
    }
  }

  function discard(): void {
    clearPendingResearchRunActionReceipt();
    setPendingReceipt(null);
    setEvidenceId("");
    setReplayState({ state: "open" });
    void loadEvidence();
  }

  async function submit(receiptForRetry?: PendingResearchRunActionReceipt): Promise<void> {
    setReplayState({ state: "submitting" });
    // A retry must resend the exact persisted command (receipt.command), never
    // rebuild from mutable current form state (Task 5 review finding #1).
    const command = receiptForRetry
      ? (receiptForRetry.command as unknown as { procedure: typeof parentProcedure; executionContract: typeof parentContract; environment: typeof parentEnvironment; evidenceManifestId: string })
      : {
        procedure: parentProcedure,
        executionContract: parentContract,
        environment: parentEnvironment,
        evidenceManifestId: evidenceId,
      };
    let receipt = receiptForRetry;
    if (!receipt) {
      try {
        receipt = await getOrCreateResearchRunActionReceipt({ projectId, issueId, runId: parentRunId }, "REPLAY", command);
        setPendingReceipt(receipt);
      } catch (error) {
        if (error instanceof PendingResearchRunActionIntentConflictError) {
          setReplayState({ state: "conflict" });
          return;
        }
        setReplayState({ state: "rejected", message: "研究轮次重放输入不正确。" });
        return;
      }
    }
    try {
      const result = await replayResearchRun(projectId, issueId, parentRunId, receipt.idempotencyKey, command as never);
      clearPendingResearchRunActionReceipt();
      setPendingReceipt(null);
      setReplayState({ state: "created", runId: result.runId });
      onCommitted();
    } catch (error) {
      if (error instanceof ProjectApiError) {
        if (error.status >= 500 || error.status === 503) {
          setReplayState({ state: "unconfirmed" });
          return;
        }
        if (error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT") {
          setReplayState({ state: "conflict" });
          return;
        }
        clearPendingResearchRunActionReceipt();
        setPendingReceipt(null);
        if (error.status === 404) void loadEvidence();
        setReplayState({ state: "rejected", message: error.message || "研究轮次重放被拒绝。" });
        return;
      }
      setReplayState({ state: "unconfirmed" });
    }
  }

  function retry(): void {
    if (relevantPending) void submit(relevantPending);
  }

  if (replayState.state === "idle") return <div className="research-run-replay">
    <button type="button" onClick={() => setReplayState({ state: "open" })}>重放此研究轮次</button>
  </div>;

  const savedOptionNeeded = relevantPending !== null
    && (evidence.state !== "ready" || !evidence.bases.some(base => base.manifestId === (relevantPending.command as unknown as { evidenceManifestId: string }).evidenceManifestId));

  return <div className="research-run-replay">
    <h4>重放此研究轮次</h4>
    <p className="research-run-note">重放会以原方案创建一个新的「进行中」研究轮次记录，原轮次保持不变。这是研究记录的重放，不会自动执行任何后台任务。</p>
    <div className="research-run-replay-plan">
      <p>原目标：{parentProcedure.objective}</p>
      <p>原方法：{parentProcedure.method}</p>
      <p>步骤（{parentProcedure.steps.length} 条，将原样复制）</p>
      <p>执行模式与可复现等级将原样复制。</p>
    </div>

    {evidence.state === "loading" ? <p role="status">正在读取证据快照…</p> : null}
    {evidence.state === "unavailable" ? <div className="research-error" role="alert">
      研究轮次所需的证据快照暂不可用。
      <button type="button" onClick={() => void loadEvidence()}>重试读取证据快照</button>
    </div> : null}
    {evidence.state === "ready" && evidence.bases.length === 0 && !savedOptionNeeded ? <p className="research-run-evidence-empty">
      还没有可用的证据快照。重放需要一个当前已授权的证据快照。
    </p> : null}

    {evidence.state === "ready" && (evidence.bases.length > 0 || savedOptionNeeded) ? <>
      <label className="research-run-evidence-choice">证据快照
        <select value={evidenceId} onChange={event => setEvidenceId(event.target.value)}>
          <option value="">请选择证据快照…</option>
          {evidence.bases.map(base => <option key={base.manifestId} value={base.manifestId}>
            {base.claimStatementExcerpt} · {STANCE_LABELS[base.stance] ?? base.stance}
            {base.confidenceLevel ? ` · ${base.confidenceLevel}` : ""} · {base.itemCount} 条证据
          </option>)}
          {savedOptionNeeded && relevantPending ? <option value={(relevantPending.command as unknown as { evidenceManifestId: string }).evidenceManifestId}>
            已保存的证据快照（{(relevantPending.command as unknown as { evidenceManifestId: string }).evidenceManifestId}）
          </option> : null}
        </select>
      </label>
      {parentManifestId && evidence.bases.some(base => base.manifestId === parentManifestId) && !evidenceId ? <p className="research-run-note">可沿用原轮次的证据快照。</p> : null}
      {evidence.nextCursor ? <button type="button" className="research-run-evidence-more" disabled={evidencePage.state === "loading"} onClick={() => evidence.state === "ready" && evidence.nextCursor && void loadOlderEvidence(evidence.nextCursor)}>
        {evidencePage.state === "loading" ? "正在加载…" : "加载更多证据快照"}
      </button> : null}
      {evidencePage.state === "error" ? <div className="research-error" role="alert">
        更早的证据快照暂时无法加载。
        <button type="button" onClick={() => evidencePage.state === "error" && void loadOlderEvidence(evidencePage.cursor)}>重试加载更早证据快照</button>
      </div> : null}
    </> : null}

    {replayState.state === "created" ? <p className="research-run-success" role="status">已创建新的研究轮次：<code>{replayState.runId}</code></p> : null}
    {replayState.state === "unconfirmed" ? <div className="research-error" role="alert">
      研究轮次重放结果尚未确认。可以使用同一标识重试。
      <div className="research-run-start-actions">
        <button type="button" onClick={retry}>使用同一标识重试</button>
        <button type="button" onClick={discard}>放弃未确认提交，重新开始</button>
      </div>
    </div> : null}
    {replayState.state === "conflict" ? <div className="research-error" role="alert">
      当前提交标识与已保存的研究轮次操作不一致，需要明确放弃后才能重新提交。
      <div className="research-run-start-actions">
        <button type="button" onClick={discard}>放弃未确认提交，重新开始</button>
      </div>
    </div> : null}
    {replayState.state === "rejected" ? <div className="research-error" role="alert">{replayState.message}</div> : null}

    {replayState.state === "open" || replayState.state === "submitting" ? <div className="research-run-start-actions">
      <button type="button" className="research-primary" disabled={evidenceId === "" || evidence.state !== "ready" || replayState.state === "submitting"} onClick={() => void submit()}>
        {replayState.state === "submitting" ? "正在提交…" : "确认重放"}
      </button>
      <button type="button" onClick={() => setReplayState({ state: "idle" })}>收起</button>
    </div> : null}
  </div>;
}
