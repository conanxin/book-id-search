import { useEffect, useState } from "react";
import {
  cancelResearchRun,
  completeResearchRun,
  failResearchRun,
  ProjectApiError,
  type ResearchRunStatus,
} from "./api";
import {
  clearPendingResearchRunActionReceipt,
  loadPendingResearchRunActionReceipt,
  getOrCreateResearchRunActionReceipt,
  parseResearchRunCompleteOutput,
  PendingResearchRunActionIntentConflictError,
  type PendingResearchRunActionReceipt,
} from "./research-run-action-draft";

type Props = {
  projectId: string;
  issueId: string;
  runId: string;
  runStatus?: ResearchRunStatus;
  pending: PendingResearchRunActionReceipt | null;
  onCommitted: () => void;
};

type ActionState =
  | { state: "idle" }
  | { state: "confirming"; action: "COMPLETE" | "FAIL" | "CANCEL" }
  | { state: "submitting"; action: "COMPLETE" | "FAIL" | "CANCEL" }
  | { state: "unconfirmed"; action: "COMPLETE" | "FAIL" | "CANCEL" }
  | { state: "conflict" }
  | { state: "rejected"; message: string };

const producedGroups = [
  { key: "claimIds", label: "可能答案 ID（每行一个，可留空）" },
  { key: "assessmentIds", label: "评价 ID（每行一个，可留空）" },
  { key: "resolutionIds", label: "工作结论 ID（每行一个，可留空）" },
  { key: "noteRevisionIds", label: "笔记版本 ID（每行一个，可留空）" },
] as const;

const initialForm = { summary: "", claimIds: "", assessmentIds: "", resolutionIds: "", noteRevisionIds: "", gaps: "" };

export function ResearchRunTerminalActions({ projectId, issueId, runId, runStatus, pending, onCommitted }: Props) {
  const [actionState, setActionState] = useState<ActionState>({ state: "idle" });
  const [form, setForm] = useState(initialForm);
  const [pendingReceipt, setPendingReceipt] = useState<PendingResearchRunActionReceipt | null>(pending);

  useEffect(() => setPendingReceipt(pending), [pending]);

  // Self-restore a scope-matched pending action on mount (parent may pass null).
  useEffect(() => {
    if (pending) return;
    const stored = loadPendingResearchRunActionReceipt();
    if (stored && stored.projectId === projectId && stored.issueId === issueId && stored.runId === runId) {
      setPendingReceipt(stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, issueId, runId]);

  const relevantPending = pendingReceipt !== null && pendingReceipt.runId === runId
    && (pendingReceipt.action === "COMPLETE" || pendingReceipt.action === "FAIL" || pendingReceipt.action === "CANCEL")
    ? pendingReceipt : null;

  function discard(): void {
    clearPendingResearchRunActionReceipt();
    setPendingReceipt(null);
    setActionState({ state: "idle" });
    setForm(initialForm);
  }

  async function runTerminal(action: "COMPLETE" | "FAIL" | "CANCEL", body: { output: unknown }, receiptForRetry?: PendingResearchRunActionReceipt): Promise<void> {
    setActionState({ state: "submitting", action });
    let receipt = receiptForRetry;
    if (!receipt) {
      try {
        receipt = await getOrCreateResearchRunActionReceipt({ projectId, issueId, runId }, action, body);
        setPendingReceipt(receipt);
      } catch (error) {
        if (error instanceof PendingResearchRunActionIntentConflictError) {
          setActionState({ state: "conflict" });
          return;
        }
        setActionState({ state: "rejected", message: error instanceof Error && error.message ? error.message : "研究轮次操作输入不正确。" });
        return;
      }
    }
    const send = action === "COMPLETE"
      ? () => completeResearchRun(projectId, issueId, runId, receipt!.idempotencyKey, body.output as never)
      : action === "FAIL"
        ? () => failResearchRun(projectId, issueId, runId, receipt!.idempotencyKey, null)
        : () => cancelResearchRun(projectId, issueId, runId, receipt!.idempotencyKey, null);
    try {
      await send();
      clearPendingResearchRunActionReceipt();
      setPendingReceipt(null);
      setActionState({ state: "idle" });
      setForm(initialForm);
      onCommitted();
    } catch (error) {
      if (error instanceof ProjectApiError) {
        if (error.status >= 500 || error.status === 503) {
          setActionState({ state: "unconfirmed", action });
          return;
        }
        if (error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT") {
          setActionState({ state: "conflict" });
          return;
        }
        // Definitive rejection: 400 invalid, 404 not found, 409 read-only / already-terminal.
        clearPendingResearchRunActionReceipt();
        setPendingReceipt(null);
        setActionState({ state: "rejected", message: error.message || "研究轮次操作被拒绝。" });
        if (error.status === 409) onCommitted(); // reload actual state (e.g. ALREADY_TERMINAL)
        return;
      }
      setActionState({ state: "unconfirmed", action });
    }
  }

  function submitComplete(): void {
    let output;
    try {
      output = parseResearchRunCompleteOutput({
      summary: form.summary,
      produced: { claimIds: form.claimIds, assessmentIds: form.assessmentIds, resolutionIds: form.resolutionIds, noteRevisionIds: form.noteRevisionIds },
      gaps: form.gaps.split("\n").filter(line => line.trim().length > 0).map(line => {
        const separator = line.lastIndexOf("::");
        const description = separator === -1 ? line : line.slice(0, separator);
        const status = separator === -1 ? "OPEN" : line.slice(separator + 2).trim().toUpperCase();
        return { description, status };
      }),
      });
    } catch (error) {
      setActionState({ state: "rejected", message: error instanceof Error ? error.message : "研究产出输入不正确。" });
      return;
    }
    void runTerminal("COMPLETE", { output });
  }

  function retryPending(): void {
    if (!relevantPending) return;
    const action = relevantPending.action;
    if (action !== "COMPLETE" && action !== "FAIL" && action !== "CANCEL") return;
    const command = relevantPending.command as { output: unknown };
    void runTerminal(action, { output: command.output }, relevantPending);
  }

  const confirming = actionState.state === "confirming" ? actionState.action : null;

  return <div className="research-run-actions">
    <h4>研究轮次终态操作</h4>

    {relevantPending && (actionState.state === "idle" || actionState.state === "unconfirmed" || actionState.state === "conflict") ? <p className="research-run-pending-note" role="status">
      检测到尚未确认的「{relevantPending.action === "COMPLETE" ? "完成" : relevantPending.action === "FAIL" ? "失败" : "取消"}」提交，已保留原提交标识。
      {runStatus !== undefined && runStatus !== "RUNNING" && actionState.state === "idle" ? <button type="button" onClick={retryPending}>使用同一标识重试</button> : null}
    </p> : null}

    {actionState.state === "idle" && !confirming && (runStatus === undefined || runStatus === "RUNNING") ? <div className="research-run-start-actions">
      <button type="button" onClick={() => setActionState({ state: "confirming", action: "COMPLETE" })}>标记完成</button>
      <button type="button" onClick={() => setActionState({ state: "confirming", action: "FAIL" })}>标记失败</button>
      <button type="button" onClick={() => setActionState({ state: "confirming", action: "CANCEL" })}>取消轮次</button>
      {relevantPending ? <button type="button" onClick={retryPending}>使用同一标识重试</button> : null}
    </div> : null}

    {confirming === "COMPLETE" ? <div className="research-run-complete-form">
      <h4>标记完成（不可撤销）</h4>
      <label>研究产出摘要
        <textarea rows={2} value={form.summary} onChange={event => setForm(previous => ({ ...previous, summary: event.target.value }))} />
      </label>
      {producedGroups.map(group => <label key={group.key}>{group.label}
        <textarea rows={2} value={form[group.key]} onChange={event => setForm(previous => ({ ...previous, [group.key]: event.target.value }))} />
      </label>)}
      <label>缺口（可选，每行「描述::OPEN|BLOCKED|DEFERRED」，缺省 OPEN）
        <textarea rows={2} value={form.gaps} onChange={event => setForm(previous => ({ ...previous, gaps: event.target.value }))} />
      </label>
      <div className="research-run-start-actions">
        <button type="button" className="research-primary" disabled={actionState.state === "submitting"} onClick={submitComplete}>
          {actionState.state === "submitting" ? "正在提交…" : "确认标记完成"}
        </button>
        <button type="button" onClick={() => setActionState({ state: "idle" })}>返回</button>
      </div>
    </div> : null}

    {confirming === "FAIL" || confirming === "CANCEL" ? <div className="research-error" role="alert">
      {confirming === "FAIL"
        ? "确认将此研究轮次标记为失败？此操作不可撤销，将结束该轮次。"
        : "确认取消此研究轮次？此操作不可撤销，将结束该轮次。"}
      <div className="research-run-start-actions">
        <button type="button" className="research-primary" disabled={actionState.state === "submitting"} onClick={() => void runTerminal(confirming, { output: null })}>
          {actionState.state === "submitting" ? "正在提交…" : confirming === "FAIL" ? "确认标记失败" : "确认取消轮次"}
        </button>
        <button type="button" onClick={() => setActionState({ state: "idle" })}>返回</button>
      </div>
    </div> : null}

    {actionState.state === "unconfirmed" ? <div className="research-error" role="alert">
      研究轮次操作结果尚未确认。可以使用同一标识重试。
      <div className="research-run-start-actions">
        <button type="button" onClick={retryPending}>使用同一标识重试</button>
        <button type="button" onClick={discard}>放弃未确认提交，重新开始</button>
      </div>
    </div> : null}
    {actionState.state === "conflict" ? <div className="research-error" role="alert">
      当前提交标识与已保存的研究轮次操作不一致，需要明确放弃后才能重新提交。
      <div className="research-run-start-actions">
        <button type="button" onClick={discard}>放弃未确认提交，重新开始</button>
      </div>
    </div> : null}
    {actionState.state === "rejected" ? <div className="research-error" role="alert">{actionState.message}</div> : null}
  </div>;
}
