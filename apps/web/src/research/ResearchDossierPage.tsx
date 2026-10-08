import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { IssueResolutionType, ResearchRunStatus } from "./api";
import type { DossierView } from "./dossier-reader";
import { useResearchDossier } from "./useResearchDossier";

const resolutionLabels: Record<IssueResolutionType, string> = {
  PREFERRED_CLAIM: "采用一个可能答案",
  INSUFFICIENT_EVIDENCE: "证据不足",
  NO_WORKING_CONCLUSION: "明确暂不形成工作结论",
};
const runLabels: Record<ResearchRunStatus, string> = {
  RUNNING: "进行中", SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已取消",
};
const dateLabel = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "未提供";
type Coverage = DossierView["runs"]["coverage"];
type ReadError = DossierView["runs"]["error"];

function StreamFoot({ noun, coverage, error, onMore }: {
  noun: string; coverage: Coverage; error: ReadError; onMore?: () => void;
}) {
  const { status, loadedCount, nextCursor, exhausted } = coverage;
  return <div className="dossier-stream-foot">
    {status === "notRequested" ? <span>尚未读取{noun}。</span> : null}
    {status === "loading" ? <span role="status">正在读取{noun}…</span> : null}
    {status !== "notRequested" && status !== "loading" ? <span>已加载 {loadedCount} 条{noun}{exhausted ? " · 已读完当前可见分页" : " · 仅代表已加载记录"}</span> : null}
    {error ? <span role="alert">读取失败{error.status ? "（" + error.status + "）" : ""}，不能视为无记录。</span> : null}
    {onMore && (nextCursor || error || status === "notRequested") ?
      <button type="button" className="research-text-button" disabled={status === "loading"} onClick={onMore}>
        {error ? "重试读取" : status === "notRequested" ? "读取" + noun : "加载更多"}
      </button> : null}
  </div>;
}
function Panel({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return <section id={id} className="research-panel dossier-section" aria-labelledby={id + "-heading"}>
    <h2 id={id + "-heading"}>{title}</h2>{children}
  </section>;
}
function ReadErrorText({ status }: { status: "loading" | "unavailable" | "error" | "notRequested" | "ready" | "partial" }) {
  if (status === "loading") return <p role="status">正在读取…</p>;
  if (status === "error") return <p role="alert" className="research-error">读取失败，不能据此断言没有研究记录。</p>;
  if (status === "unavailable") return <p className="research-muted">该对象目前不可访问。</p>;
  return null;
}
export function ResearchDossierPage({ projectId, issueId }: { projectId: string; issueId: string }) {
  const { view, read, refresh } = useResearchDossier(projectId, issueId);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [resolutionId, setResolutionId] = useState<string | null>(null);
  const [assessmentId, setAssessmentId] = useState<string | null>(null);
  useEffect(() => {
    const previous = document.title;
    document.title = "研究档案 · BOOK-ID-SEARCH";
    return () => { document.title = previous; };
  }, []);
  useEffect(() => {
    setClaimId(null);
    setRunId(null);
    setResolutionId(null);
    setAssessmentId(null);
  }, [projectId, issueId]);

  const refreshAll = () => {
    setClaimId(null); setRunId(null); setResolutionId(null); setAssessmentId(null);
    refresh();
  };
  if (!view) return <p className="research-panel" role="status">正在准备研究档案…</p>;
  const question = view.question;
  if (question.status === "loading" || question.status === "notRequested") {
    return <p className="research-panel" role="status">正在核对研究问题及访问权限…</p>;
  }
  if (question.status === "error" || question.status === "unavailable" || !question.data) {
    return <div role="alert" className="research-error">
      {question.status === "unavailable" ? "研究问题不存在，或不属于当前项目。" : "研究档案暂不可用，不能将错误视为无记录。"}
      <button type="button" onClick={refreshAll}>重试读取研究档案</button>
    </div>;
  }
  const { project, issue } = question.data;
  const selectedAssessments = view.assessments.find(section => section.claimId === claimId);
  const selectedAssessment = view.assessmentDetails.find(detail => detail.assessment.id === assessmentId && detail.assessment.claimId === claimId);
  const selectedResolution = view.resolutionDetails.find(detail => detail.resolution.id === resolutionId);
  const selectedRun = view.runDetails.find(detail => detail.run.runId === runId);

  return <article className="dossier-page">
    <header className="research-panel dossier-header">
      <Link className="research-back" to={"/research/projects/" + encodeURIComponent(projectId) + "/issues/" + encodeURIComponent(issueId)}>返回研究问题</Link>
      <div className="research-detail-status">
        <span className="research-eyebrow">Research Dossier · 只读派生视图</span>
        {project.readOnly || issue.lifecycleState === "ARCHIVED" ? <span className="research-read-only">已归档 · 只读</span> : null}
      </div>
      <h1>{issue.title}</h1>
      <p className="dossier-question">{issue.question}</p>
      <p className="research-muted">研究项目：{project.name} · 更新：{dateLabel(issue.updatedAt)}</p>
      <button type="button" className="research-text-button" onClick={refreshAll}>刷新整个档案</button>
      <p className="research-muted">各分区独立读取，仅代表当前可见且已加载的记录；不是单一数据库时点的完整快照。</p>
    </header>

    <nav className="dossier-index" aria-label="研究档案目录">
      <a href="#dossier-current">当前结论</a>
      <a href="#dossier-claims">可能答案与评价</a>
      <a href="#dossier-evidence">证据依据</a>
      <a href="#dossier-history">结论历史</a>
      <a href="#dossier-runs">研究轮次</a>
      <a href="#dossier-change">研究变化</a>
      <a href="#dossier-references">对象引用</a>
    </nav>

    <Panel id="dossier-current" title="当前工作结论">
      {view.current.status === "loading" || view.current.status === "notRequested" ?
        <p role="status">正在读取当前结论…</p> : null}
      {view.current.status === "none" ? <p className="research-muted">尚未形成当前工作结论。</p> : null}
      {view.current.status === "changed" ? <p className="research-error" role="alert">当前结论指针已变化，需要刷新本档案核对。</p> : null}
      {view.current.status === "error" ? <p className="research-error" role="alert">当前工作结论读取失败，不能使用历史第一条替代。</p> : null}
      {view.current.status === "recorded" ? <>
        <p><strong>{resolutionLabels[view.current.summary.resolutionType]}</strong></p>
        {view.current.summary.rationaleExcerpt ? <p>{view.current.summary.rationaleExcerpt}</p> : null}
        <p className="research-muted">记录于 {dateLabel(view.current.summary.createdAt)}</p>
        {view.current.summary.evidenceBasisAvailable ? <p>有当前授权的证据依据。</p> : <p>未指定或目前不能展开证据依据。</p>}
        {view.current.detail.data ? <p>{view.current.detail.data.resolution.rationale || "未记录完整理由"}</p> :
          <button className="research-text-button" type="button" onClick={() => void read({ kind: "resolution", resolutionId: view.current.status === "recorded" ? view.current.summary.id : "" })}>读取完整理由</button>}
        <ReadErrorText status={view.current.detail.status} />
      </> : null}
    </Panel>

    <Panel id="dossier-claims" title="竞争性可能答案与评价">
      <StreamFoot noun="可能答案" coverage={view.claims.coverage} error={view.claims.error}
        onMore={() => void read({ kind: "claims" })} />
      {view.claims.rows.length === 0 && view.claims.coverage.status === "ready" ? <p className="research-muted">当前没有可见的可能答案。</p> : null}
      <div className="dossier-cards">
        {view.claims.rows.map(claim => <div className="dossier-item" key={claim.id}>
          <h3>{claim.statement}</h3>
          <p className="research-muted">{claim.lifecycleState === "ARCHIVED" ? "已归档" : "活动中"} · {dateLabel(claim.createdAt)}</p>
          <button className="research-text-button" type="button" onClick={() => {
            setClaimId(claim.id); setAssessmentId(null);
            void read({ kind: "assessments", claimId: claim.id, cursor: null });
          }}>查看此答案的评价</button>
          <button className="research-text-button" type="button" onClick={() => void read({ kind: "candidates", claimId: claim.id })}>核对可用来源映射</button>
        </div>)}
      </div>
      {claimId ? <div className="dossier-inline">
        <h3>该可能答案的评价</h3>
        {selectedAssessments ? <>
          {selectedAssessments.rows.map(item => <div className="dossier-item" key={item.id}>
            <strong>{item.stance}</strong> · {item.confidenceLevel ?? "未评置信等级"}
            <p>{item.reasoningExcerpt || "未提供摘要"}</p>
            <p className="research-muted">证据清单：{item.evidenceManifest.itemCount} 项</p>
            <button className="research-text-button" type="button" onClick={() => {
              setAssessmentId(item.id);
              void read({ kind: "assessment", claimId, assessmentId: item.id });
            }}>读取评价详情</button>
          </div>)}
          {selectedAssessments.rows.length === 0 && selectedAssessments.coverage.status === "ready" ?
            <p className="research-muted">暂无当前可见评价；不代表历史上从未存在。</p> : null}
          <StreamFoot noun="评价历史" coverage={selectedAssessments.coverage} error={selectedAssessments.error}
            onMore={() => void read({ kind: "assessments", claimId, cursor: selectedAssessments.coverage.nextCursor })} />
        </> : <p role="status">正在读取评价…</p>}
        {selectedAssessment ? <div className="dossier-detail">
          <h4>评价详情</h4>
          <p>{selectedAssessment.assessment.reasoning || "未记录完整理由"}</p>
          <p className="research-muted">已授权证据清单 {selectedAssessment.evidenceManifest.itemCount} 项 · {selectedAssessment.evidenceManifest.manifestSha256}</p>
        </div> : null}
      </div> : null}
    </Panel>

    <Panel id="dossier-evidence" title="可见证据依据">
      <p className="research-muted">只显示当前可见的证据依据索引；冻结的 EvidenceManifest 不会随新评价而改变。</p>
      <StreamFoot noun="可见证据依据" coverage={view.evidenceBases.coverage} error={view.evidenceBases.error}
        onMore={() => void read({ kind: "bases", cursor: view.evidenceBases.coverage.nextCursor })} />
      {view.evidenceBases.rows.map(base => <div className="dossier-item" key={base.assessmentId}>
        <p>{base.claimStatementExcerpt}</p>
        <p className="research-muted">{base.stance} · {base.itemCount} 项证据 · {dateLabel(base.assessmentCreatedAt)}</p>
        <span className="dossier-fingerprint">{base.manifestSha256}</span>
        <button className="research-text-button" type="button" onClick={() => {
          setClaimId(base.claimId); setAssessmentId(base.assessmentId);
          void read({ kind: "assessment", claimId: base.claimId, assessmentId: base.assessmentId });
        }}>读取关联评价</button>
      </div>)}
    </Panel>

    <Panel id="dossier-history" title="工作结论历史">
      <StreamFoot noun="结论历史" coverage={view.resolutions.coverage} error={view.resolutions.error}
        onMore={() => void read({ kind: "resolutions", cursor: view.resolutions.coverage.nextCursor })} />
      {view.resolutions.rows.length === 0 && view.resolutions.coverage.status === "ready" ? <p className="research-muted">尚无已记录工作结论。</p> : null}
      {view.resolutions.rows.map(item => <div className="dossier-item" key={item.id}>
        <div><strong>{resolutionLabels[item.resolutionType]}</strong> {item.isCurrent ? <span className="dossier-current-tag">当前</span> : null}</div>
        <p>{item.rationaleExcerpt || "未提供理由摘要"}</p>
        <p className="research-muted">{dateLabel(item.createdAt)} · {item.evidenceBasisAvailable ? "证据当前可用" : "证据未指定或不可展开"}</p>
        <button className="research-text-button" type="button" onClick={() => {
          setResolutionId(item.id);
          void read({ kind: "resolution", resolutionId: item.id });
        }}>读取结论详情</button>
      </div>)}
      {selectedResolution ? <div className="dossier-detail">
        <h3>选中结论的原始理由</h3>
        <p>{selectedResolution.resolution.rationale || "未记录完整理由"}</p>
        <p className="research-muted">依据：{selectedResolution.evidenceBasisAvailable ? "当前可用" : "未指定或不可展开"}</p>
      </div> : null}
    </Panel>

    <Panel id="dossier-runs" title="研究轮次（按开始时间）">
      <StreamFoot noun="研究轮次" coverage={view.runs.coverage} error={view.runs.error}
        onMore={() => void read({ kind: "runs", cursor: view.runs.coverage.nextCursor })} />
      {view.runs.rows.length === 0 && view.runs.coverage.status === "ready" ? <p className="research-muted">还没有研究轮次。</p> : null}
      {view.runs.rows.map(item => <div className="dossier-item" key={item.runId}>
        <div><strong>{runLabels[item.status]}</strong> · 开始于 {dateLabel(item.startedAt)}</div>
        {item.completedAt ? <p className="research-muted">结束于 {dateLabel(item.completedAt)}</p> : null}
        <p className="research-muted">证据清单 {item.evidenceManifest.itemCount} 项 · {item.evidenceManifest.available ? "当前可展开" : "当前不可展开"}</p>
        <button className="research-text-button" type="button" onClick={() => {
          setRunId(item.runId); void read({ kind: "run", runId: item.runId });
        }}>只读查看轮次详情</button>
      </div>)}
      {selectedRun ? <div className="dossier-detail">
        <h3>轮次详情 · {runLabels[selectedRun.run.status]}</h3>
        <p><strong>目标：</strong>{selectedRun.run.procedure.objective}</p>
        <p><strong>方法：</strong>{selectedRun.run.procedure.method}</p>
        <ul>{selectedRun.run.procedure.steps.map((step, index) => <li key={index}>{step.kind}：{step.description}</li>)}</ul>
        {selectedRun.run.output ? <>
          <h4>研究输出</h4><p>{selectedRun.run.output.summary}</p>
          {selectedRun.run.output.gaps.map((gap, index) => <p key={index}>{gap.status}：{gap.description}</p>)}
        </> : <p className="research-muted">当前没有已记录的终态输出。</p>}
        <h4>证据快照</h4>
        <p className="dossier-fingerprint">{selectedRun.evidenceManifest.manifestSha256}</p>
        {selectedRun.evidenceManifest.available ?
          <ol>{selectedRun.evidenceManifest.items.map(item => <li key={item.ordinal}>{item.role} · {item.targetType}{item.note ? " · " + item.note : ""}</li>)}</ol> :
          <p className="research-muted">当前不可展开原始证据条目。</p>}
        {selectedRun.producedReferences.length ? <><h4>本轮关联对象（逐项授权后展示）</h4>
          <ul>{selectedRun.producedReferences.map(ref => <li key={ref.kind + ":" + ref.ordinal}>
            {ref.kind} #{ref.ordinal}：{ref.status === "resolved" ?
              (ref.href ? <Link to={ref.href}>查看已核实的引用</Link> : "已核实对象 " + ref.id)
              : ref.status === "error" ? "读取失败" : ref.status === "unavailable" ? "当前不可用" :
                ref.status === "loading" ? "正在验证" : "映射尚未核实"}
          </li>)}</ul>
        </> : null}
      </div> : null}
    </Panel>

    <Panel id="dossier-change" title="What Changed? · 已加载记录">
      <p className="research-muted">D01-A：两条时间线分别保留来源顺序。同一毫秒内跨类型记录不推断先后，也不声称已加载完整历史。</p>
      <div className="dossier-timelines">
        <section><h3>工作结论记录</h3>
          <ol>{view.whatChanged.resolutionEvents.map(event => <li key={event.id}>记录工作结论 · {dateLabel(event.at)}</li>)}</ol>
        </section>
        <section><h3>研究轮次（开始顺序）</h3>
          <ol>{view.whatChanged.runCards.map(card => <li key={card.runId}>
            开始：{dateLabel(card.started.at)}
            {card.terminated ? <span> · {runLabels[card.terminated.status]}于 {dateLabel(card.terminated.at)}</span> : <span> · 进行中</span>}
          </li>)}</ol>
        </section>
      </div>
    </Panel>

    <Panel id="dossier-references" title="来源与对象引用">
      <p className="research-muted">仅显示已有授权与真实对象依据。清单指纹不是源文件字节校验和；缺少页码或定位时不生成链接。</p>
      {view.references.length === 0 ? <p className="research-muted">尚无可展开的已核实对象引用。</p> : <ul className="dossier-references">
        {view.references.map((reference, index) => <li key={reference.origin + ":" + reference.recordId + ":" + reference.targetId + ":" + index}>
          <span>{reference.origin} · {reference.targetType}</span>
          {reference.href ? <Link to={reference.href}>{reference.materialTitle || "已核实材料"}</Link> : <span>对象引用已核实，暂无可用定位</span>}
          <span className="dossier-fingerprint">{reference.manifestSha256}</span>
        </li>)}
      </ul>}
    </Panel>
    <p className="research-muted">研究档案 v0.1 · 只读 · 不创建或更新研究对象 · 不保存持久快照</p>
  </article>;
}
