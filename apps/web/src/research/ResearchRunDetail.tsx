import { useCallback, useEffect, useRef, useState } from "react";
import {
  getResearchRun,
  type ResearchRunDetailResponse,
  type ResearchRunStatus,
} from "./api";
import { ResearchRunTerminalActions } from "./ResearchRunTerminalActions";
import { ResearchRunReplayComposer } from "./ResearchRunReplayComposer";
import {
  loadPendingResearchRunActionReceipt,
  type PendingResearchRunActionReceipt,
} from "./research-run-action-draft";

type Props = {
  projectId: string;
  issueId: string;
  runId: string;
  writeAllowed: boolean;
  onHistoryRefresh: () => void;
};

type LoadState = "loading" | "ready" | "unavailable";

const STATUS_LABELS: Record<ResearchRunStatus, string> = {
  RUNNING: "进行中", SUCCEEDED: "已完成", FAILED: "失败", CANCELLED: "已取消",
};
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
const ROLE_LABELS: Record<string, string> = {
  SUPPORTING: "支持", CONTRADICTORY: "反对", CONTEXTUAL: "背景",
};
const TARGET_TYPE_LABELS: Record<string, string> = {
  SOURCE: "来源", SOURCE_ASSET: "来源资产", NOTE_REVISION: "笔记版本",
};
const GAP_STATUS_LABELS: Record<string, string> = {
  OPEN: "未解决", BLOCKED: "受阻", DEFERRED: "暂缓",
};

function dateTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN");
}

export function ResearchRunDetail({ projectId, issueId, runId, writeAllowed, onHistoryRefresh }: Props) {
  const [state, setState] = useState<LoadState>("loading");
  const [detail, setDetail] = useState<ResearchRunDetailResponse | null>(null);
  const [pending, setPending] = useState<PendingResearchRunActionReceipt | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);

  const reload = useCallback((signal?: AbortSignal) => {
    setState("loading");
    getResearchRun(projectId, issueId, runId, signal)
      .then(result => {
        if (signal?.aborted) return;
        setDetail(result);
        setState("ready");
      })
      .catch(() => {
        if (!signal?.aborted) setState("unavailable");
      });
  }, [projectId, issueId, runId]);

  useEffect(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setDetail(null);
    reload(controller.signal);
    return () => controller.abort();
  }, [projectId, issueId, runId, reloadVersion, reload]);

  useEffect(() => {
    const existing = loadPendingResearchRunActionReceipt();
    setPending(existing && existing.projectId === projectId && existing.issueId === issueId ? existing : null);
  }, [projectId, issueId]);

  function afterActionChange(): void {
    setReloadVersion(version => version + 1);
    onHistoryRefresh();
  }

  const pendingMatchesRun = pending !== null && pending.runId === runId;
  const actionsAllowed = (writeAllowed || pendingMatchesRun) && state === "ready" && detail !== null;

  return <div className="research-run-detail">
    {state === "loading" ? <p role="status">正在读取研究轮次详情…</p> : null}
    {state === "unavailable" ? <div className="research-error" role="alert">
      研究轮次详情暂时无法加载。
      <button type="button" onClick={() => reload()}>重试读取详情</button>
    </div> : null}
    {state === "ready" && detail ? (() => {
      const { run, evidenceManifest, ancestors } = detail;
      return <>
        <div className="research-run-detail-heading">
          <span className="research-run-status" title={run.status}>{STATUS_LABELS[run.status]}</span>
          <span className="research-run-meta">Run: <code>{run.runId}</code></span>
        </div>
        <p className="research-run-meta">开始：{dateTime(run.startedAt)}</p>
        <p className="research-run-meta">{run.status === "RUNNING" ? "尚未结束" : `结束：${run.completedAt ? dateTime(run.completedAt) : "—"}`}</p>
        {run.knowledgeCutoff !== null ? <p className="research-run-meta">知识截止：{run.knowledgeCutoff}</p> : null}
        {run.replayOf !== null ? <p className="research-run-replay">重放自：<code>{run.replayOf}</code></p> : null}

        <h4>研究方案</h4>
        <p>目标：{run.procedure.objective}</p>
        <p>方法：{run.procedure.method}</p>
        <ol className="research-run-detail-steps">
          {run.procedure.steps.map((step, index) => <li key={index}>
            {STEP_KIND_LABELS[step.kind] ?? step.kind} · {step.description}
          </li>)}
        </ol>

        <h4>执行契约</h4>
        <p>模式：{MODE_LABELS[run.executionContract.mode] ?? run.executionContract.mode} · 可复现等级：{REPRO_LABELS[run.executionContract.reproducibilityLevel] ?? run.executionContract.reproducibilityLevel}</p>
        {run.executionContract.tools.length > 0 ? <ul className="research-run-detail-tools">
          {run.executionContract.tools.map((tool, index) => <li key={index}>{tool.name}{tool.version !== null ? `（${tool.version}）` : ""}</li>)}
        </ul> : <p className="research-run-meta">未记录工具。</p>}

        <h4>环境</h4>
        {Object.keys(run.environment).length === 0
          ? <p className="research-run-meta">本版本未记录环境变量或凭据。</p>
          : <dl className="research-run-detail-environment">
              {Object.entries(run.environment).map(([key, value]) => <div key={key}>
                <dt>{key}</dt>
                <dd>{typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}</dd>
              </div>)}
            </dl>}

        <h4>证据快照</h4>
        <p>快照：<code>{evidenceManifest.id}</code></p>
        <p className="research-run-meta">SHA-256：<code>{evidenceManifest.manifestSha256}</code> · {evidenceManifest.itemCount} 项</p>
        {!evidenceManifest.available ? <p className="research-run-evidence-unavailable">证据当前不可访问</p> : <ol className="research-run-detail-evidence-items">
          {evidenceManifest.items.map(item => <li key={item.ordinal}>
            #{item.ordinal} · {ROLE_LABELS[item.role] ?? item.role} · {TARGET_TYPE_LABELS[item.targetType] ?? item.targetType}
            {item.note !== null ? ` · ${item.note}` : ""}
          </li>)}
        </ol>}

        {run.status !== "RUNNING" && run.output !== null ? <>
          <h4>研究产出</h4>
          <p>{run.output.summary}</p>
          <ul className="research-run-detail-produced">
            {run.output.produced.claimIds.length > 0 ? <li>可能答案：{run.output.produced.claimIds.map(id => <code key={id}>{id}</code>)}</li> : null}
            {run.output.produced.assessmentIds.length > 0 ? <li>评价：{run.output.produced.assessmentIds.map(id => <code key={id}>{id}</code>)}</li> : null}
            {run.output.produced.resolutionIds.length > 0 ? <li>工作结论：{run.output.produced.resolutionIds.map(id => <code key={id}>{id}</code>)}</li> : null}
            {run.output.produced.noteRevisionIds.length > 0 ? <li>笔记版本：{run.output.produced.noteRevisionIds.map(id => <code key={id}>{id}</code>)}</li> : null}
          </ul>
          {run.output.gaps.length > 0 ? <ul className="research-run-detail-gaps">
            {run.output.gaps.map((gap, index) => <li key={index}>{gap.description}（{GAP_STATUS_LABELS[gap.status] ?? gap.status}）</li>)}
          </ul> : null}
        </> : null}
        {run.status === "RUNNING" ? <p className="research-run-meta">研究仍在进行中，尚无最终产出。</p> : null}

        {ancestors.length > 0 ? <>
          <h4>重放祖先链（最早在前）</h4>
          <ol className="research-run-detail-ancestors">
            {ancestors.map(ancestor => <li key={ancestor.runId}>
              <code>{ancestor.runId}</code> · {STATUS_LABELS[ancestor.status]}（{ancestor.status}）· 证据 {ancestor.evidenceManifest.itemCount} 项{ancestor.evidenceManifest.available ? "" : "（当前不可访问）"}
            </li>)}
          </ol>
        </> : null}

        {actionsAllowed && run.status === "RUNNING" ? <ResearchRunTerminalActions
          projectId={projectId}
          issueId={issueId}
          runId={runId}
          pending={pendingMatchesRun ? pending : null}
          onCommitted={afterActionChange}
        /> : null}
        {run.status === "RUNNING" && !actionsAllowed ? <p className="research-run-meta">当前范围只读，无法执行研究轮次终态操作。</p> : null}

        {actionsAllowed && run.status !== "RUNNING" ? <ResearchRunReplayComposer
          projectId={projectId}
          issueId={issueId}
          parentRunId={runId}
          parentProcedure={run.procedure}
          parentContract={run.executionContract}
          parentEnvironment={run.environment}
          parentManifestId={run.evidenceManifestId}
          pending={pendingMatchesRun ? pending : null}
          onCommitted={afterActionChange}
        /> : null}
      </>;
    })() : null}
  </div>;
}
