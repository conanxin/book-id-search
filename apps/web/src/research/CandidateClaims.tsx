import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  createCandidateClaim,
  listCandidateClaims,
  ProjectApiError,
  type CandidateClaim,
  type ResearchIssue,
  type ResearchIssueProjectContext,
} from "./api";
import { EvidenceEditor, type CurrentEvidencePreview } from "./EvidenceEditor";
import { AssessmentComposer } from "./AssessmentComposer";
import { AssessmentHistory } from "./AssessmentHistory";
import { AssessmentDetail } from "./AssessmentDetail";
import {
  clearPendingCandidateClaimReceipt,
  getOrCreateCandidateClaimReceipt,
  normalizeCandidateClaimDraft,
  PendingCandidateClaimIntentConflictError,
} from "./candidate-claim-draft";

type Props = {
  token: string;
  project: ResearchIssueProjectContext;
  issue: ResearchIssue;
};

export function CandidateClaims(props: Props) {
  return <CandidateClaimsSession key={`${props.token}:${props.project.id}:${props.issue.id}`} {...props} />;
}

function ClaimAssessmentSession({
  token,
  project,
  issue,
  claim,
}: Props & { claim: CandidateClaim }) {
  const [preview, setPreview] = useState<CurrentEvidencePreview | null>(null);
  const [historyRefreshVersion, setHistoryRefreshVersion] = useState(0);
  const [integrityBlocked, setIntegrityBlocked] = useState(false);
  const [selectedAssessmentId, setSelectedAssessmentId] = useState<string | null>(null);
  const [evidenceRefreshVersion, setEvidenceRefreshVersion] = useState(0);

  const writeAllowed = !project.readOnly
    && (issue.lifecycleState === "OPEN" || issue.lifecycleState === "RESOLVED");

  function refreshEvidence() {
    setPreview(null);
    setEvidenceRefreshVersion(version => version + 1);
  }

  function refreshHistory() {
    setHistoryRefreshVersion(version => version + 1);
  }

  return <article className="research-card">
    <span className="research-issue-state">{claim.lifecycleState}</span>
    <p>{claim.statement}</p>
    <small>创建于 {new Date(claim.createdAt).toLocaleString("zh-CN")}</small>

    <EvidenceEditor
      key={`${claim.id}:${evidenceRefreshVersion}`}
      token={token}
      projectId={project.id}
      issueId={issue.id}
      claim={claim}
      onPreviewChange={setPreview}
    />

    <AssessmentComposer
      token={token}
      projectId={project.id}
      issueId={issue.id}
      claimId={claim.id}
      preview={preview}
      writeAllowed={writeAllowed}
      integrityBlocked={integrityBlocked}
      onCommitted={() => {
        refreshEvidence();
        refreshHistory();
      }}
      onNeedsEvidenceRefresh={refreshEvidence}
      onPreviewInvalidated={() => setPreview(null)}
    />

    <AssessmentHistory
      token={token}
      projectId={project.id}
      issueId={issue.id}
      claimId={claim.id}
      refreshVersion={historyRefreshVersion}
      onIntegrityBlocked={setIntegrityBlocked}
      onOpenDetail={setSelectedAssessmentId}
    />

    {selectedAssessmentId ? <AssessmentDetail
      token={token}
      projectId={project.id}
      issueId={issue.id}
      claimId={claim.id}
      assessmentId={selectedAssessmentId}
      onClose={() => setSelectedAssessmentId(null)}
      onRefreshHistory={refreshHistory}
    /> : null}
  </article>;
}

function CandidateClaimsSession({ token, project, issue }: Props) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<"loading" | "ready" | "unavailable">("loading");
  const [claims, setClaims] = useState<CandidateClaim[]>([]);
  const [statement, setStatement] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "unconfirmed" | "rejected" | "idempotency-conflict">("idle");
  const [message, setMessage] = useState("");
  const active = useRef<AbortController | null>(null);

  useEffect(() => () => active.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoad("loading");
    void listCandidateClaims(token, project.id, issue.id, controller.signal)
      .then(result => {
        if (!controller.signal.aborted) {
          setClaims(result.claims);
          setLoad("ready");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad("unavailable");
      });
    return () => controller.abort();
  }, [token, project.id, issue.id, attempt]);

  const canCreate = !project.readOnly && issue.lifecycleState === "OPEN";

  async function submit(forceNew = false) {
    if (active.current || !canCreate) return;
    let normalized: string;
    try {
      normalized = normalizeCandidateClaimDraft(statement);
    } catch (error) {
      setState("rejected");
      setMessage(error instanceof Error ? error.message : "可能答案输入不正确。");
      return;
    }

    const controller = new AbortController();
    active.current = controller;
    setState("submitting");
    setMessage("");
    try {
      const receipt = await getOrCreateCandidateClaimReceipt(project.id, issue.id, normalized, forceNew);
      if (controller.signal.aborted) return;
      await createCandidateClaim(token, project.id, issue.id, receipt.idempotencyKey, normalized, controller.signal);
      if (controller.signal.aborted) return;
      clearPendingCandidateClaimReceipt();
      setStatement("");
      setState("idle");
      // Canonical order (ACTIVE before ARCHIVED, created_at ASC, id ASC) comes
      // only from the server GET; a local append could reorder against
      // PostgreSQL's microsecond-precision created_at.
      setAttempt(value => value + 1);
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof PendingCandidateClaimIntentConflictError) {
        setState("idempotency-conflict");
        setMessage(error.message);
      } else if (error instanceof ProjectApiError && error.code === "IDEMPOTENCY_CONFLICT") {
        setState("idempotency-conflict");
        setMessage("创建请求标识与当前可能答案内容不一致。");
      } else if (
        error instanceof ProjectApiError
        && (
          [400, 404].includes(error.status)
          || ["PROJECT_READ_ONLY", "RESEARCH_ISSUE_READ_ONLY"].includes(error.code ?? "")
        )
      ) {
        clearPendingCandidateClaimReceipt();
        setState("rejected");
        setMessage(error.message);
      } else {
        setState("unconfirmed");
        setMessage("创建结果尚未确认。请使用同一标识重试。");
      }
    } finally {
      if (!controller.signal.aborted) active.current = null;
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void submit();
  };

  return <section className="research-candidate-claims" aria-labelledby="candidate-claims-heading">
    <h2 id="candidate-claims-heading">可能答案</h2>
    {load === "loading" ? <p role="status">正在读取可能答案…</p> : null}
    {load === "unavailable" ? <div className="research-error" role="alert">
      可能答案暂不可用。
      <button onClick={() => setAttempt(value => value + 1)}>重试可能答案</button>
    </div> : null}
    {load === "ready" ? <>
      {claims.length ? <div className="research-claim-list">
        {claims.map(claim => <ClaimAssessmentSession
          key={claim.id}
          token={token}
          project={project}
          issue={issue}
          claim={claim}
        />)}
      </div> : <p>还没有可能答案。</p>}
      {canCreate ? <form className="research-issue-form" onSubmit={onSubmit}>
        <label htmlFor="candidate-statement">可能答案正文</label>
        <textarea
          id="candidate-statement"
          rows={4}
          value={statement}
          disabled={state === "submitting" || state === "unconfirmed"}
          onChange={event => setStatement(event.target.value)}
        />
        {message ? <p role="alert" className="research-issue-notice">{message}</p> : null}
        {state === "unconfirmed"
          ? <button type="button" onClick={() => void submit()}>使用同一标识重试</button>
          : state === "idempotency-conflict"
            ? <button type="button" onClick={() => void submit(true)}>作为新的可能答案重新提交</button>
            : <button
                type="submit"
                className="research-primary"
                disabled={state === "submitting"}
              >
                {state === "submitting" ? "正在添加…" : "添加可能答案"}
              </button>}
      </form> : null}
    </> : null}
  </section>;
}
