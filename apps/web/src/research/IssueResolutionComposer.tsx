import { useEffect, useState } from "react";
import {
  createIssueResolution,
  listCandidateClaims,
  listIssueResolutionEvidenceBases,
  listIssueResolutions,
  ProjectApiError,
  type CandidateClaim,
  type IssueResolutionCreateResponse,
  type IssueResolutionEvidenceBasisSummary,
  type IssueResolutionType,
  type ResearchIssue,
  type ResearchIssueProjectContext,
} from "./api";
import {
  PendingIssueResolutionIntentConflictError,
  clearPendingIssueResolutionReceipt,
  getOrCreateIssueResolutionReceipt,
  loadPendingIssueResolutionReceipt,
  normalizeIssueResolutionBrowserCommand,
  type PendingIssueResolutionReceipt,
} from "./issue-resolution-draft";

type LoadState = "loading" | "ready" | "unavailable";
type ComposerState =
  | "idle"
  | "submitting"
  | "unconfirmed"
  | "rejected"
  | "idempotency-conflict"
  | "success"
  | "read-only";

type Props = {
  project: ResearchIssueProjectContext;
  issue: ResearchIssue;
  onCommitted?: (result: IssueResolutionCreateResponse) => void;
};

function matchingReceipt(
  receipt: PendingIssueResolutionReceipt | null,
  projectId: string,
  issueId: string,
): receipt is PendingIssueResolutionReceipt {
  return !!receipt
    && receipt.projectId === projectId.toLowerCase()
    && receipt.issueId === issueId.toLowerCase();
}

function basisLabel(basis: IssueResolutionEvidenceBasisSummary): string {
  const confidence = basis.confidenceLevel ? ` · ${basis.confidenceLevel}` : "";
  return `${basis.claimStatementExcerpt} · ${basis.stance}${confidence} · ${basis.itemCount} 条证据`;
}

export function IssueResolutionComposer({ project, issue, onCommitted }: Props) {
  const restored = (() => {
    const receipt = loadPendingIssueResolutionReceipt();
    return matchingReceipt(receipt, project.id, issue.id) ? receipt : null;
  })();

  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [loadVersion, setLoadVersion] = useState(0);
  const [claims, setClaims] = useState<CandidateClaim[]>([]);
  const [evidenceBases, setEvidenceBases] = useState<IssueResolutionEvidenceBasisSummary[]>([]);
  const [currentResolutionId, setCurrentResolutionId] = useState<string | null>(
    restored?.command.expectedCurrentResolutionId ?? null,
  );
  const [resolutionType, setResolutionType] = useState<IssueResolutionType | "">(
    restored?.command.resolutionType ?? "",
  );
  const [preferredClaimId, setPreferredClaimId] = useState(
    restored?.command.preferredClaimId ?? "",
  );
  const [evidenceManifestId, setEvidenceManifestId] = useState(
    restored?.command.evidenceManifestId ?? "",
  );
  const [rationale, setRationale] = useState(restored?.command.rationale ?? "");
  const [pendingReceipt, setPendingReceipt] = useState<PendingIssueResolutionReceipt | null>(restored);
  const [state, setState] = useState<ComposerState>(restored ? "unconfirmed" : "idle");
  const [message, setMessage] = useState(restored ? "工作结论提交结果尚未确认。" : "");

  const isSubmitting = state === "submitting";
  const frozen = isSubmitting || state === "unconfirmed" || state === "idempotency-conflict";

  useEffect(() => {
    const controller = new AbortController();
    setLoadState("loading");

    void Promise.all([
      listIssueResolutions(project.id, issue.id, { limit: 1 }, controller.signal),
      listCandidateClaims(project.id, issue.id, controller.signal),
      listIssueResolutionEvidenceBases(project.id, issue.id, { limit: 50 }, controller.signal),
    ]).then(([history, candidatePage, evidencePage]) => {
      if (controller.signal.aborted) return;
      setCurrentResolutionId(current => pendingReceipt ? current : history.issue.currentResolutionId);
      setClaims(candidatePage.claims);
      setEvidenceBases(evidencePage.evidenceBases);
      setLoadState("ready");
      if (!pendingReceipt && history.issue.lifecycleState === "ARCHIVED") {
        setState("read-only");
        setMessage("当前研究问题已归档，不能新增工作结论。");
      }
    }).catch(() => {
      if (!controller.signal.aborted) setLoadState("unavailable");
    });

    return () => controller.abort();
  }, [project.id, issue.id, loadVersion, pendingReceipt]);

  const writeAllowed = !project.readOnly
    && (issue.lifecycleState === "OPEN" || issue.lifecycleState === "RESOLVED")
    && state !== "read-only";

  function currentCommand() {
    if (!resolutionType) return null;
    try {
      return normalizeIssueResolutionBrowserCommand({
        expectedCurrentResolutionId: currentResolutionId,
        resolutionType,
        preferredClaimId: resolutionType === "PREFERRED_CLAIM" ? (preferredClaimId || null) : null,
        rationale,
        evidenceManifestId: evidenceManifestId || null,
      });
    } catch {
      return null;
    }
  }

  const normalized = currentCommand();
  const canSubmit = !!normalized && writeAllowed && loadState === "ready" && !frozen;

  async function submit() {
    if (state === "submitting") return;

    let receipt = pendingReceipt;
    if (!receipt) {
      if (!normalized || !writeAllowed || loadState !== "ready") return;
      try {
        receipt = await getOrCreateIssueResolutionReceipt(
          { projectId: project.id, issueId: issue.id },
          normalized,
        );
        setPendingReceipt(receipt);
      } catch (error) {
        if (error instanceof PendingIssueResolutionIntentConflictError) {
          setState("idempotency-conflict");
          setMessage("已有另一条工作结论提交尚未确认。请先放弃旧的未确认提交，再重新开始。");
          return;
        }
        setState("rejected");
        setMessage(error instanceof Error ? error.message : "工作结论输入不正确。");
        return;
      }
    }

    setState("submitting");
    setMessage("");
    try {
      const result = await createIssueResolution(project.id,
        issue.id,
        receipt.idempotencyKey,
        receipt.command,
      );
      clearPendingIssueResolutionReceipt();
      setPendingReceipt(null);
      setCurrentResolutionId(result.resolutionId);
      setResolutionType("");
      setPreferredClaimId("");
      setEvidenceManifestId("");
      setRationale("");
      setState("success");
      setMessage(result.status === "replayed"
        ? "此工作结论此前已经成功提交。"
        : "工作结论已成功提交。");
      onCommitted?.(result);
    } catch (error) {
      if (error instanceof ProjectApiError) {
        if (error.status === 503 && error.code === "ISSUE_RESOLUTION_STORE_UNAVAILABLE") {
          setState("unconfirmed");
          setMessage("工作结论提交结果尚未确认。服务暂不可用，可以使用同一标识重试。");
          return;
        }
        if (error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT") {
          setState("idempotency-conflict");
          setMessage("当前提交标识与已保存的工作结论内容不一致。请放弃未确认提交后重新开始。");
          return;
        }
        if (error.status === 409 && error.code === "ISSUE_RESOLUTION_STALE") {
          clearPendingIssueResolutionReceipt();
          setPendingReceipt(null);
          setState("rejected");
          setMessage("当前工作结论已变化，已刷新提交基线。请确认后重新提交。");
          setLoadVersion(version => version + 1);
          return;
        }
        if (
          error.status === 400
          || error.status === 404
          || (error.status === 409 && (
            error.code === "PROJECT_READ_ONLY"
            || error.code === "RESEARCH_ISSUE_READ_ONLY"
          ))
        ) {
          clearPendingIssueResolutionReceipt();
          setPendingReceipt(null);
          setState(
            error.code === "PROJECT_READ_ONLY" || error.code === "RESEARCH_ISSUE_READ_ONLY"
              ? "read-only"
              : "rejected",
          );
          setMessage(error.message);
          setLoadVersion(version => version + 1);
          return;
        }
      }

      setState("unconfirmed");
      setMessage("工作结论提交结果尚未确认。请使用同一标识重试。");
    }
  }

  function discardPending() {
    clearPendingIssueResolutionReceipt();
    setPendingReceipt(null);
    setResolutionType("");
    setPreferredClaimId("");
    setEvidenceManifestId("");
    setRationale("");
    setState("idle");
    setMessage("");
    setLoadVersion(version => version + 1);
  }

  if (!writeAllowed && !pendingReceipt && state !== "success" && state !== "read-only") return null;

  return <section className="issue-resolution-composer" aria-labelledby="issue-resolution-composer-heading">
    <h2 id="issue-resolution-composer-heading">形成工作结论</h2>
    <p>这是对整个研究问题的当前工作结论，不会自动把任何可能答案判定为真或假。</p>

    {loadState === "loading" ? <p role="status">正在准备工作结论…</p> : null}
    {loadState === "unavailable" && !pendingReceipt ? <div className="research-error" role="alert">
      工作结论所需数据暂不可用。
      <button type="button" onClick={() => setLoadVersion(version => version + 1)}>重试工作结论</button>
    </div> : null}

    {(loadState === "ready" || pendingReceipt) ? <>
      <fieldset disabled={frozen || state === "read-only"}>
        <legend>结论类型</legend>
        <label>
          <input
            type="radio"
            name="issue-resolution-type"
            value="PREFERRED_CLAIM"
            checked={resolutionType === "PREFERRED_CLAIM"}
            onChange={() => setResolutionType("PREFERRED_CLAIM")}
          />
          采用一个可能答案
        </label>
        <label>
          <input
            type="radio"
            name="issue-resolution-type"
            value="INSUFFICIENT_EVIDENCE"
            checked={resolutionType === "INSUFFICIENT_EVIDENCE"}
            onChange={() => { setResolutionType("INSUFFICIENT_EVIDENCE"); setPreferredClaimId(""); }}
          />
          证据不足
        </label>
        <label>
          <input
            type="radio"
            name="issue-resolution-type"
            value="NO_WORKING_CONCLUSION"
            checked={resolutionType === "NO_WORKING_CONCLUSION"}
            onChange={() => { setResolutionType("NO_WORKING_CONCLUSION"); setPreferredClaimId(""); }}
          />
          暂不形成工作结论
        </label>
      </fieldset>

      {resolutionType === "PREFERRED_CLAIM" ? <label>
        首选可能答案
        <select
          value={preferredClaimId}
          disabled={frozen || state === "read-only"}
          onChange={event => setPreferredClaimId(event.target.value)}
        >
          <option value="">请选择</option>
          {claims.map(claim => <option key={claim.id} value={claim.id}>{claim.statement}</option>)}
          {pendingReceipt?.command.preferredClaimId
            && !claims.some(claim => claim.id === pendingReceipt.command.preferredClaimId)
            ? <option value={pendingReceipt.command.preferredClaimId}>已保存的可能答案</option>
            : null}
        </select>
      </label> : null}

      <label>
        证据依据（可选）
        <select
          value={evidenceManifestId}
          disabled={frozen || state === "read-only"}
          onChange={event => setEvidenceManifestId(event.target.value)}
        >
          <option value="">不指定</option>
          {evidenceBases.map(basis => <option key={basis.assessmentId} value={basis.manifestId}>
            {basisLabel(basis)}
          </option>)}
          {pendingReceipt?.command.evidenceManifestId
            && !evidenceBases.some(basis => basis.manifestId === pendingReceipt.command.evidenceManifestId)
            ? <option value={pendingReceipt.command.evidenceManifestId}>已保存的证据依据</option>
            : null}
        </select>
      </label>

      <label>
        结论理由
        <textarea
          rows={6}
          value={rationale}
          disabled={frozen || state === "read-only"}
          onChange={event => setRationale(event.target.value)}
        />
      </label>

      {message ? <p className="research-issue-notice" role={state === "success" ? "status" : "alert"}>
        {message}
      </p> : null}

      {state === "unconfirmed" && pendingReceipt ? <div className="assessment-pending-actions">
        <button type="button" onClick={() => void submit()}>使用同一标识重试</button>
        <button type="button" onClick={discardPending}>放弃未确认提交，重新开始</button>
      </div> : state === "idempotency-conflict" ? <div className="assessment-pending-actions">
        <button type="button" onClick={discardPending}>放弃未确认提交，重新开始</button>
      </div> : state === "read-only" ? null : <button
        type="button"
        className="research-primary"
        disabled={!canSubmit || isSubmitting}
        onClick={() => void submit()}
      >
        {isSubmitting ? "正在提交…" : "提交工作结论"}
      </button>}
    </> : null}
  </section>;
}
