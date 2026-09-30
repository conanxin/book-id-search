import { useCallback, useEffect, useRef, useState } from "react";
import {
  listIssueResolutionEvidenceBases,
  startResearchRun,
  ProjectApiError,
  type IssueResolutionEvidenceBasisSummary,
} from "./api";
import {
  loadPendingResearchRunStartReceipt,
  getOrCreateResearchRunStartReceipt,
  clearPendingResearchRunStartReceipt,
  PendingResearchRunStartIntentConflictError,
  RESEARCH_RUN_STEP_KINDS,
  RESEARCH_RUN_MODES,
  RESEARCH_RUN_REPRO_LEVELS,
  type PendingResearchRunStartReceipt,
} from "./research-run-start-draft";

type Props = {
  projectId: string;
  issueId: string;
  writeAllowed: boolean;
  onCommitted: (runId: string) => void;
};

type EvidenceState =
  | { state: "loading" }
  | { state: "ready"; bases: IssueResolutionEvidenceBasisSummary[]; nextCursor: string | null }
  | { state: "unavailable" };
type EvidencePage = { state: "idle" | "loading" } | { state: "error"; cursor: string };

type SubmitState =
  | { state: "idle" }
  | { state: "submitting" }
  | { state: "success"; message: string }
  | { state: "unconfirmed" }
  | { state: "conflict" }
  | { state: "rejected"; message: string };

type StepDraft = { kind: string; description: string };
type ToolDraft = { name: string; version: string };

const STEP_KIND_LABELS: Record<string, string> = {
  SEARCH: "搜索", READ: "阅读", COMPARE: "比较", FIELDWORK: "田野",
  MAP_ANALYSIS: "地图分析", IMAGE_ANALYSIS: "图像分析", OTHER: "其他",
};
const MODE_LABELS: Record<string, string> = {
  HUMAN: "人工", HUMAN_AI: "人机协作", AUTOMATED: "自动执行",
};
const REPRO_LABELS: Record<string, string> = {
  EXACT: "精确复现", PROCEDURE: "方法复现", AUDIT: "审计可追溯",
};
const STANCE_LABELS: Record<string, string> = {
  SUPPORTS: "支持", CONTRADICTS: "反对", INCONCLUSIVE: "不确定",
};
const EVIDENCE_LIMIT = 50;

function stanceLabel(stance: string): string { return STANCE_LABELS[stance] ?? stance; }

export function ResearchRunStartComposer({ projectId, issueId, writeAllowed, onCommitted }: Props) {
  const [open, setOpen] = useState(false);
  const [pendingReceipt, setPendingReceipt] = useState<PendingResearchRunStartReceipt | null>(null);

  const [objective, setObjective] = useState("");
  const [method, setMethod] = useState("");
  const [steps, setSteps] = useState<StepDraft[]>([{ kind: "SEARCH", description: "" }]);
  const [mode, setMode] = useState("");
  const [repro, setRepro] = useState("");
  const [tools, setTools] = useState<ToolDraft[]>([]);
  const [evidenceId, setEvidenceId] = useState("");

  const [evidence, setEvidence] = useState<EvidenceState>({ state: "loading" });
  const [evidencePage, setEvidencePage] = useState<EvidencePage>({ state: "idle" });
  const [submitState, setSubmitState] = useState<SubmitState>({ state: "idle" });

  const initialEvidence = useRef<AbortController | null>(null);
  const olderEvidence = useRef<AbortController | null>(null);

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
    initialEvidence.current?.abort();
    olderEvidence.current?.abort();
    const controller = new AbortController();
    initialEvidence.current = controller;
    void loadEvidence(controller.signal);
    return () => controller.abort();
  }, [loadEvidence]);

  // Pending receipt restores and expands automatically.
  useEffect(() => {
    const existing = loadPendingResearchRunStartReceipt();
    if (existing && existing.projectId === projectId && existing.issueId === issueId) {
      setPendingReceipt(existing);
      setOpen(true);
      const command = existing.command;
      setObjective(command.procedure.objective);
      setMethod(command.procedure.method);
      setSteps(command.procedure.steps.map(step => ({ kind: step.kind, description: step.description })));
      setMode(command.executionContract.mode);
      setRepro(command.executionContract.reproducibilityLevel);
      setTools(command.executionContract.tools.map(tool => ({ name: tool.name, version: tool.version ?? "" })));
      setEvidenceId(command.evidenceManifestId);
    }
  }, [projectId, issueId]);

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
        const merged = [...previous.bases, ...result.evidenceBases.filter(base => !seen.has(base.manifestId))];
        return { state: "ready", bases: merged, nextCursor: result.nextCursor };
      });
      setEvidencePage({ state: "idle" });
    } catch {
      if (!controller.signal.aborted) setEvidencePage({ state: "error", cursor });
    } finally {
      if (olderEvidence.current === controller) olderEvidence.current = null;
    }
  }

  function resetForm(): void {
    setObjective(""); setMethod("");
    setSteps([{ kind: "SEARCH", description: "" }]);
    setMode(""); setRepro(""); setTools([]); setEvidenceId("");
    setSubmitState({ state: "idle" });
  }

  function discardPending(): void {
    clearPendingResearchRunStartReceipt();
    setPendingReceipt(null);
    resetForm();
    void loadEvidence();
  }

  const formValid = objective.trim().length > 0
    && method.trim().length > 0
    && steps.length >= 1 && steps.every(step => step.description.trim().length > 0)
    && mode !== "" && repro !== ""
    && evidenceId !== ""
    && evidence.state === "ready";

  async function submit(): Promise<void> {
    setSubmitState({ state: "submitting" });
    const command = {
      procedure: {
        version: 1 as const,
        objective,
        method,
        steps: steps.map(step => ({ kind: step.kind, description: step.description })),
      },
      executionContract: {
        version: 1 as const,
        mode: mode as "HUMAN" | "HUMAN_AI" | "AUTOMATED",
        reproducibilityLevel: repro as "EXACT" | "PROCEDURE" | "AUDIT",
        tools: tools.map(tool => ({ name: tool.name, version: tool.version === "" ? null : tool.version })),
      },
      environment: {},
      evidenceManifestId: evidenceId,
      replayOf: null,
    };
    let receipt: PendingResearchRunStartReceipt;
    try {
      receipt = await getOrCreateResearchRunStartReceipt({ projectId, issueId }, command);
    } catch (error) {
      if (error instanceof PendingResearchRunStartIntentConflictError) {
        setSubmitState({ state: "conflict" });
        return;
      }
      setSubmitState({ state: "rejected", message: error instanceof Error ? "研究轮次输入不正确。" : "研究轮次输入不正确。" });
      return;
    }
    setPendingReceipt(receipt);
    try {
      const result = await startResearchRun(projectId, issueId, receipt.idempotencyKey, receipt.command);
      clearPendingResearchRunStartReceipt();
      setPendingReceipt(null);
      setSubmitState({
        state: "success",
        message: result.status === "created" ? "研究轮次已开始。" : "此研究轮次此前已经成功开始。",
      });
      onCommitted(result.runId);
      window.setTimeout(() => { resetForm(); setOpen(false); }, 1600);
    } catch (error) {
      if (error instanceof ProjectApiError) {
        if (error.status === 503 || error.status === 0 || error.status >= 500) {
          setSubmitState({ state: "unconfirmed" });
          return;
        }
        if (error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT") {
          setSubmitState({ state: "conflict" });
          return;
        }
        // Definitive rejection: 400 invalid / 404 evidence or scope / 409 read-only.
        clearPendingResearchRunStartReceipt();
        setPendingReceipt(null);
        if (error.status === 404) void loadEvidence();
        setSubmitState({ state: "rejected", message: error.message || "研究轮次提交被拒绝。" });
        return;
      }
      setSubmitState({ state: "unconfirmed" });
    }
  }

  if (!writeAllowed && !pendingReceipt) return null;

  const savedOptionNeeded = pendingReceipt !== null
    && (evidence.state !== "ready" || !evidence.bases.some(base => base.manifestId === pendingReceipt.command.evidenceManifestId));

  return <section className="research-run-start" aria-label="开始研究轮次">
    {!open ? <button type="button" className="research-run-start-entry" onClick={() => setOpen(true)}>开始新的研究轮次</button> : <div className="research-run-start-form">
      <h2>开始新的研究轮次</h2>
      {pendingReceipt ? <p className="research-run-pending-note" role="status">
        检测到尚未确认的研究轮次提交，已恢复原提交标识。
      </p> : null}

      {evidence.state === "loading" ? <p role="status">正在读取证据快照…</p> : null}
      {evidence.state === "unavailable" ? <div className="research-error" role="alert">
        研究轮次所需的证据快照暂不可用。
        <button type="button" onClick={() => void loadEvidence()}>重试读取证据快照</button>
      </div> : null}
      {evidence.state === "ready" && evidence.bases.length === 0 ? <p className="research-run-evidence-empty">
        还没有可用于研究轮次的证据快照。请先在可能答案下完成至少一次带证据的评价。
      </p> : null}

      {evidence.state === "ready" && (evidence.bases.length > 0 || savedOptionNeeded) ? <>
        <label className="research-run-evidence-choice">
          证据快照
          <select value={evidenceId} onChange={event => setEvidenceId(event.target.value)}>
            <option value="">请选择证据快照…</option>
            {evidence.bases.map(base => <option key={base.manifestId} value={base.manifestId}>
              {base.claimStatementExcerpt} · {stanceLabel(base.stance)}
              {base.confidenceLevel ? ` · ${base.confidenceLevel}` : ""} · {base.itemCount} 条证据
            </option>)}
            {savedOptionNeeded && pendingReceipt ? <option value={pendingReceipt.command.evidenceManifestId}>
              已保存的证据快照（{pendingReceipt.command.evidenceManifestId}）
            </option> : null}
          </select>
        </label>
        {evidence.nextCursor ? <button
          type="button"
          className="research-run-evidence-more"
          disabled={evidencePage.state === "loading"}
          onClick={() => evidence.state === "ready" && evidence.nextCursor && void loadOlderEvidence(evidence.nextCursor)}
        >
          {evidencePage.state === "loading" ? "正在加载…" : "加载更多证据快照"}
        </button> : null}
        {evidencePage.state === "error" ? <div className="research-error" role="alert">
          更早的证据快照暂时无法加载。
          <button type="button" onClick={() => void loadOlderEvidence(evidencePage.state === "error" ? evidencePage.cursor : "")}>重试加载更早证据快照</button>
        </div> : null}

        <label>研究目标
          <textarea value={objective} onChange={event => setObjective(event.target.value)} rows={2} />
        </label>
        <label>研究方法
          <textarea value={method} onChange={event => setMethod(event.target.value)} rows={2} />
        </label>

        <fieldset>
          <legend>研究步骤（至少一条，顺序将原样保存）</legend>
          <ol className="research-run-step-list">
            {steps.map((step, index) => <li key={index} className="research-run-step">
              <select value={step.kind} aria-label={`步骤 ${index + 1} 类型`} onChange={event => setSteps(previous => previous.map((item, i) => i === index ? { ...item, kind: event.target.value } : item))}>
                {RESEARCH_RUN_STEP_KINDS.map(kind => <option key={kind} value={kind}>{STEP_KIND_LABELS[kind]}</option>)}
              </select>
              <input value={step.description} aria-label={`步骤 ${index + 1} 描述`} onChange={event => setSteps(previous => previous.map((item, i) => i === index ? { ...item, description: event.target.value } : item))} />
              <button type="button" disabled={index === 0} onClick={() => setSteps(previous => { const next = [...previous]; const [moved] = next.splice(index, 1); next.splice(index - 1, 0, moved); return next; })}>上移</button>
              <button type="button" disabled={index === steps.length - 1} onClick={() => setSteps(previous => { const next = [...previous]; const [moved] = next.splice(index, 1); next.splice(index + 1, 0, moved); return next; })}>下移</button>
              <button type="button" disabled={steps.length === 1} onClick={() => setSteps(previous => previous.filter((_, i) => i !== index))}>删除</button>
            </li>)}
          </ol>
          <button type="button" onClick={() => setSteps(previous => [...previous, { kind: "SEARCH", description: "" }])}>添加步骤</button>
        </fieldset>

        <fieldset>
          <legend>执行模式（需显式选择）</legend>
          {RESEARCH_RUN_MODES.map(option => <label key={option} className="research-run-choice">
            <input type="radio" name="research-run-mode" value={option} checked={mode === option} onChange={() => setMode(option)} />
            {MODE_LABELS[option]}
          </label>)}
        </fieldset>

        <fieldset>
          <legend>可复现等级（需显式选择）</legend>
          {RESEARCH_RUN_REPRO_LEVELS.map(option => <label key={option} className="research-run-choice">
            <input type="radio" name="research-run-repro" value={option} checked={repro === option} onChange={() => setRepro(option)} />
            {REPRO_LABELS[option]}
          </label>)}
          <p className="research-run-note">“精确复现”指按同一方案与工具重跑；“方法复现”指按记录的方法重做；“审计可追溯”指保留可供核查的执行痕迹。可复现等级不保证外部结果完全一致。</p>
        </fieldset>

        <fieldset>
          <legend>工具（可选）</legend>
          <ul className="research-run-tool-list">
            {tools.map((tool, index) => <li key={index} className="research-run-tool">
              <input value={tool.name} aria-label={`工具 ${index + 1} 名称`} placeholder="名称" onChange={event => setTools(previous => previous.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} />
              <input value={tool.version} aria-label={`工具 ${index + 1} 版本`} placeholder="版本（可选）" onChange={event => setTools(previous => previous.map((item, i) => i === index ? { ...item, version: event.target.value } : item))} />
              <button type="button" onClick={() => setTools(previous => previous.filter((_, i) => i !== index))}>删除</button>
            </li>)}
          </ul>
          <button type="button" onClick={() => setTools(previous => [...previous, { name: "", version: "" }])}>添加工具</button>
        </fieldset>

        <p className="research-run-note">本版本暂不记录环境变量或凭据。</p>
      </> : null}

      {submitState.state === "success" ? <p className="research-run-success" role="status">{submitState.message}</p> : null}
      {submitState.state === "unconfirmed" ? <div className="research-error" role="alert">
        研究轮次提交结果尚未确认。可以使用同一标识重试。
        <div className="research-run-start-actions">
          <button type="button" disabled={submitState.state !== "unconfirmed"} onClick={() => void submit()}>使用同一标识重试</button>
          <button type="button" onClick={discardPending}>放弃未确认提交，重新开始</button>
        </div>
      </div> : null}
      {submitState.state === "conflict" ? <div className="research-error" role="alert">
        当前提交标识与已保存的研究轮次内容不一致，需要明确放弃后才能重新提交。
        <div className="research-run-start-actions">
          <button type="button" onClick={discardPending}>放弃未确认提交，重新开始</button>
        </div>
      </div> : null}
      {submitState.state === "rejected" ? <div className="research-error" role="alert">{submitState.message}</div> : null}

      <div className="research-run-start-actions">
        <button type="button" className="research-primary" disabled={!formValid || submitState.state === "submitting"} onClick={() => void submit()}>
          {submitState.state === "submitting" ? "正在提交…" : "开始研究轮次"}
        </button>
        {submitState.state !== "unconfirmed" && submitState.state !== "conflict" && !pendingReceipt ? <button type="button" onClick={() => { setOpen(false); resetForm(); }}>收起</button> : null}
      </div>
    </div>}
  </section>;
}
