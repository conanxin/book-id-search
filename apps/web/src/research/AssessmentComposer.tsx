import { useState } from "react";
import {
  ProjectApiError,
  createAssessment,
  type AssessmentConfidenceLevel,
  type AssessmentCreateResponse,
  type AssessmentStance,
} from "./api";
import {
  PendingAssessmentIntentConflictError,
  clearPendingAssessmentReceipt,
  getOrCreateAssessmentReceipt,
  loadPendingAssessmentReceipt,
  normalizeAssessmentBrowserCommand,
  type PendingAssessmentReceipt,
} from "./assessment-draft";
import type { CurrentEvidencePreview } from "./EvidenceEditor";

type ComposerState =
  | "idle"
  | "submitting"
  | "unconfirmed"
  | "rejected"
  | "idempotency-conflict"
  | "success"
  | "read-only";

export interface AssessmentComposerProps {
  token: string;
  projectId: string;
  issueId: string;
  claimId: string;
  preview: CurrentEvidencePreview | null;
  writeAllowed: boolean;
  integrityBlocked: boolean;
  onCommitted: (result: AssessmentCreateResponse) => void;
  onNeedsEvidenceRefresh: () => void;
  onPreviewInvalidated: () => void;
}

function matchesScope(
  receipt: PendingAssessmentReceipt | null,
  projectId: string,
  issueId: string,
  claimId: string,
): receipt is PendingAssessmentReceipt {
  return !!receipt
    && receipt.projectId === projectId.toLowerCase()
    && receipt.issueId === issueId.toLowerCase()
    && receipt.claimId === claimId.toLowerCase();
}

export function AssessmentComposer({
  token,
  projectId,
  issueId,
  claimId,
  preview,
  writeAllowed,
  integrityBlocked,
  onCommitted,
  onNeedsEvidenceRefresh,
  onPreviewInvalidated,
}: AssessmentComposerProps) {
  const initialReceipt = (() => {
    const receipt = loadPendingAssessmentReceipt();
    return matchesScope(receipt, projectId, issueId, claimId) ? receipt : null;
  })();

  const [pendingReceipt, setPendingReceipt] = useState<PendingAssessmentReceipt | null>(initialReceipt);
  const [stance, setStance] = useState<AssessmentStance | "">(initialReceipt?.command.stance ?? "");
  const [confidence, setConfidence] = useState<AssessmentConfidenceLevel | "">(
    initialReceipt?.command.confidenceLevel ?? "",
  );
  const [reasoning, setReasoning] = useState(initialReceipt?.command.reasoning ?? "");
  const [state, setState] = useState<ComposerState>(initialReceipt ? "unconfirmed" : "idle");
  const [message, setMessage] = useState(initialReceipt ? "评价提交结果尚未确认。" : "");

  const frozen = state === "submitting" || state === "unconfirmed" || state === "idempotency-conflict";
  const locallyReadOnly = state === "read-only";

  function currentCommand() {
    if (!preview || !stance) return null;
    try {
      return normalizeAssessmentBrowserCommand({
        stance,
        confidenceLevel: confidence || null,
        reasoning,
        expectedManifestSha256: preview.manifestSha256,
        items: preview.items,
      });
    } catch {
      return null;
    }
  }

  const normalized = currentCommand();
  const canSubmit = !!normalized
    && writeAllowed
    && !integrityBlocked
    && !frozen
    && !locallyReadOnly;

  async function submit() {
    if (state === "submitting") return;

    let receipt = pendingReceipt;
    if (!receipt) {
      if (!normalized || !writeAllowed || integrityBlocked || locallyReadOnly) return;
      try {
        receipt = await getOrCreateAssessmentReceipt(
          { projectId, issueId, claimId },
          normalized,
        );
        setPendingReceipt(receipt);
      } catch (error) {
        if (error instanceof PendingAssessmentIntentConflictError) {
          setState("idempotency-conflict");
          setMessage("已有另一条评价提交尚未确认。请先放弃旧的未确认提交，再重新开始。");
          return;
        }
        setState("rejected");
        setMessage(error instanceof Error ? error.message : "评价输入不正确。");
        return;
      }
    }

    setState("submitting");
    setMessage("");
    try {
      const result = await createAssessment(
        token,
        projectId,
        issueId,
        claimId,
        receipt.idempotencyKey,
        receipt.command,
      );
      clearPendingAssessmentReceipt();
      setPendingReceipt(null);
      setStance("");
      setConfidence("");
      setReasoning("");
      setState("success");
      setMessage(
        result.status === "replayed" && result.visible === false
          ? "此评价此前已经成功提交，但当前不可显示其详细内容。"
          : result.status === "replayed"
            ? "此评价此前已经成功提交。"
            : "评价已成功提交。",
      );
      onCommitted(result);
    } catch (error) {
      if (error instanceof ProjectApiError) {
        if (error.status === 503 && error.code === "ASSESSMENT_STORE_UNAVAILABLE") {
          setState("unconfirmed");
          setMessage("评价提交结果尚未确认。评价服务暂不可用，可以使用同一标识重试。");
          return;
        }

        if (error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT") {
          setState("idempotency-conflict");
          setMessage("当前提交标识与已保存的评价内容不一致。请放弃未确认提交后重新开始。");
          return;
        }

        if (error.status === 409 && error.code === "EVIDENCE_PREVIEW_STALE") {
          clearPendingAssessmentReceipt();
          setPendingReceipt(null);
          setState("rejected");
          setMessage(error.message);
          onPreviewInvalidated();
          return;
        }

        if (error.status === 404 && error.code === "EVIDENCE_TARGET_NOT_AVAILABLE") {
          clearPendingAssessmentReceipt();
          setPendingReceipt(null);
          setState("rejected");
          setMessage(error.message);
          onNeedsEvidenceRefresh();
          return;
        }

        if (
          error.status === 409
          && (error.code === "PROJECT_READ_ONLY" || error.code === "RESEARCH_ISSUE_READ_ONLY")
        ) {
          clearPendingAssessmentReceipt();
          setPendingReceipt(null);
          setState("read-only");
          setMessage(error.message);
          return;
        }

        if (
          error.status === 400
          || error.status === 404
          || error.status === 409
          || error.status === 500
        ) {
          clearPendingAssessmentReceipt();
          setPendingReceipt(null);
          setState("rejected");
          setMessage(
            error.status === 500
              ? "当前研究数据存在完整性问题，暂时不能提交新的评价。"
              : error.message,
          );
          return;
        }
      }

      // A network failure, malformed success response, or any other result whose
      // commit state cannot be proven keeps the exact committed intent frozen.
      setState("unconfirmed");
      setMessage("评价提交结果尚未确认。请使用同一标识重试。");
    }
  }

  function discardPending() {
    clearPendingAssessmentReceipt();
    setPendingReceipt(null);
    setStance("");
    setConfidence("");
    setReasoning("");
    setState("idle");
    setMessage("");
    onPreviewInvalidated();
  }

  if (locallyReadOnly) {
    return <div className="assessment-composer">
      <p className="research-issue-notice" role="alert">{message}</p>
    </div>;
  }

  if (!pendingReceipt && (!preview || !writeAllowed)) return null;

  return <section className="assessment-composer" aria-label="评价这个 Claim">
    <h4>评价这个 Claim</h4>

    <fieldset disabled={frozen}>
      <legend>判断</legend>
      <label>
        <input
          type="radio"
          name={`assessment-stance-${claimId}`}
          value="SUPPORTS"
          checked={stance === "SUPPORTS"}
          onChange={() => setStance("SUPPORTS")}
        />
        支持
      </label>
      <label>
        <input
          type="radio"
          name={`assessment-stance-${claimId}`}
          value="CONTRADICTS"
          checked={stance === "CONTRADICTS"}
          onChange={() => setStance("CONTRADICTS")}
        />
        反驳
      </label>
      <label>
        <input
          type="radio"
          name={`assessment-stance-${claimId}`}
          value="INCONCLUSIVE"
          checked={stance === "INCONCLUSIVE"}
          onChange={() => setStance("INCONCLUSIVE")}
        />
        尚不能判断
      </label>
    </fieldset>

    <label>
      信心
      <select
        value={confidence}
        disabled={frozen}
        onChange={event => setConfidence(event.target.value as AssessmentConfidenceLevel | "")}
      >
        <option value="">不指定</option>
        <option value="LOW">LOW</option>
        <option value="MEDIUM">MEDIUM</option>
        <option value="HIGH">HIGH</option>
      </select>
    </label>

    <label>
      判断理由
      <textarea
        rows={5}
        value={reasoning}
        disabled={frozen}
        onChange={event => setReasoning(event.target.value)}
      />
    </label>

    {integrityBlocked && !pendingReceipt
      ? <p className="research-issue-notice" role="alert">
          评价历史存在数据完整性问题，暂时不能提交新的评价。
        </p>
      : null}

    {message
      ? <p className="research-issue-notice" role={state === "success" ? "status" : "alert"}>
          {message}
        </p>
      : null}

    {state === "unconfirmed" && pendingReceipt
      ? <div className="assessment-pending-actions">
          <button type="button" onClick={() => void submit()}>使用同一标识重试</button>
          <button type="button" onClick={discardPending}>放弃未确认提交，重新开始</button>
        </div>
      : state === "idempotency-conflict"
        ? <div className="assessment-pending-actions">
            <button type="button" onClick={discardPending}>放弃未确认提交，重新开始</button>
          </div>
        : <button
            type="button"
            className="research-primary"
            disabled={!canSubmit || state === "submitting"}
            onClick={() => void submit()}
          >
            {state === "submitting" ? "正在提交…" : "提交评价"}
          </button>}
  </section>;
}
