import { useEffect, useRef, useState } from "react";
import {
  clearPendingResearchRunActionReceipt,
  loadPendingResearchRunActionReceipt,
  type PendingResearchRunActionReceipt,
} from "./research-run-action-draft";
import { cancelResearchRun, completeResearchRun, failResearchRun, ProjectApiError } from "./api";
import {
  listResearchRuns,
  type ResearchRunSummary,
} from "./api";
import { ResearchRunDetail } from "./ResearchRunDetail";

type Props = {
  projectId: string;
  issueId: string;
  refreshVersion?: number;
  writeAllowed?: boolean;
};

type LoadState = "loading" | "ready" | "unavailable";
type PageState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; cursor: string };

const STATUS_LABELS: Record<ResearchRunSummary["status"], string> = {
  RUNNING: "进行中",
  SUCCEEDED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
};

function statusClass(status: ResearchRunSummary["status"]): string {
  return {
    RUNNING: "research-run-status--running",
    SUCCEEDED: "research-run-status--succeeded",
    FAILED: "research-run-status--failed",
    CANCELLED: "research-run-status--cancelled",
  }[status];
}

export function ResearchRunHistory({ projectId, issueId, refreshVersion = 0, writeAllowed = false }: Props) {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [runs, setRuns] = useState<ResearchRunSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pageState, setPageState] = useState<PageState>({ state: "idle" });
  const initial = useRef<AbortController | null>(null);
  const older = useRef<AbortController | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [offPagePending, setOffPagePending] = useState<{ runId: string; action: string } | null>(null);
  const [offPageRetry, setOffPageRetry] = useState<{ state: "idle" } | { state: "submitting" } | { state: "unconfirmed"; message: string } | { state: "rejected"; message: string }>({ state: "idle" });

  async function retryOffPagePending(): Promise<void> {
    const stored = loadPendingResearchRunActionReceipt();
    if (!stored || stored.runId !== offPagePending?.runId) return;
    const receipt: PendingResearchRunActionReceipt = stored;
    const command = receipt.command as { output: unknown };
    setOffPageRetry({ state: "submitting" });
    const send = receipt.action === "COMPLETE"
      ? () => completeResearchRun(projectId, issueId, receipt.runId, receipt.idempotencyKey, command.output as never)
      : receipt.action === "FAIL"
        ? () => failResearchRun(projectId, issueId, receipt.runId, receipt.idempotencyKey, null)
        : () => cancelResearchRun(projectId, issueId, receipt.runId, receipt.idempotencyKey, null);
    try {
      await send();
      clearPendingResearchRunActionReceipt();
      setOffPagePending(null);
      setOffPageRetry({ state: "idle" });
      await loadInitial();
    } catch (error) {
      if (error instanceof ProjectApiError && (error.status >= 500 || error.status === 503)) {
        setOffPageRetry({ state: "unconfirmed", message: "研究轮次操作结果尚未确认。可以使用同一标识重试。" });
        return;
      }
      // Definitive outcome (already terminal / conflict / invalid): receipt 已被服务器判定, 清除本地 pending.
      clearPendingResearchRunActionReceipt();
      setOffPagePending(null);
      setOffPageRetry({ state: "idle" });
      await loadInitial();
    }
  }

  async function loadInitial(signal?: AbortSignal) {
    setLoadState("loading");
    setPageState({ state: "idle" });
    try {
      const result = await listResearchRuns(projectId, issueId, { limit: 20 }, signal);
      if (signal?.aborted) return;
      setRuns(result.runs);
      setNextCursor(result.nextCursor);
      setLoadState("ready");
      const stored = loadPendingResearchRunActionReceipt();
      if (stored && stored.projectId === projectId && stored.issueId === issueId) {
        const onPage = result.runs.some(run => run.runId === stored.runId);
        setOffPagePending(onPage ? null : { runId: stored.runId, action: stored.action });
      } else {
        setOffPagePending(null);
      }
    } catch {
      if (!signal?.aborted) setLoadState("unavailable");
    }
  }

  const scopeKey = `${projectId}:${issueId}`;
  const lastScope = useRef(scopeKey);

  useEffect(() => {
    const scopeChanged = lastScope.current !== scopeKey;
    lastScope.current = scopeKey;
    initial.current?.abort();
    older.current?.abort();
    const controller = new AbortController();
    initial.current = controller;
    // Only a real scope change clears the list and selection; a refreshVersion
    // bump must keep rows and any open detail mounted (pending receipt /
    // created state must survive a post-action history refresh).
    if (scopeChanged) {
      setRuns([]);
      setNextCursor(null);
      setSelectedRunId(null);
    }
    void loadInitial(controller.signal);
    return () => controller.abort();
  }, [projectId, issueId, refreshVersion, scopeKey]);

  function refreshSelf(): void {
    initial.current?.abort();
    older.current?.abort();
    const controller = new AbortController();
    initial.current = controller;
    // Keep existing rows mounted (a refresh must not unmount an open detail
    // and its pending-receipt/created state); loadInitial replaces the list
    // atomically once fresh data arrives.
    void loadInitial(controller.signal);
    return void controller; // keep abort-cleanup semantics local
  }

  async function loadOlder(cursor: string) {
    older.current?.abort();
    const controller = new AbortController();
    older.current = controller;
    setPageState({ state: "loading" });
    try {
      const result = await listResearchRuns(projectId, issueId, { limit: 20, cursor }, controller.signal);
      if (controller.signal.aborted) return;
      setRuns(previous => {
        const seen = new Set(previous.map(run => run.runId));
        return [...previous, ...result.runs.filter(run => !seen.has(run.runId))];
      });
      setNextCursor(result.nextCursor);
      setPageState({ state: "idle" });
    } catch {
      if (!controller.signal.aborted) setPageState({ state: "error", cursor });
    } finally {
      if (older.current === controller) older.current = null;
    }
  }

  return <section className="research-run-history" aria-label="研究轮次">
    <h2>研究轮次</h2>
    {offPagePending ? <div className="research-run-pending-note" role="status" data-run-id={offPagePending.runId}>
      <p>
        检测到尚未确认的「{offPagePending.action === "COMPLETE" ? "完成" : offPagePending.action === "FAIL" ? "失败" : "取消"}」提交（研究轮次 <code>{offPagePending.runId}</code>），已保留原提交标识。
        {offPageRetry.state === "idle" ? <button type="button" onClick={() => void retryOffPagePending()}>使用同一标识重试</button> : null}
      </p>
      {offPageRetry.state === "submitting" ? <p role="status">正在提交…</p> : null}
      {offPageRetry.state === "unconfirmed" ? <p className="research-error" role="alert">{offPageRetry.message}</p> : null}
    </div> : null}
    {loadState === "loading" ? <p role="status">正在读取研究轮次…</p> : null}
    {loadState === "unavailable" ? <div className="research-error" role="alert">
      研究轮次暂时无法加载。
      <button type="button" onClick={() => void loadInitial()}>重试研究轮次</button>
    </div> : null}
    {loadState === "ready" && runs.length === 0 ? <p>还没有研究轮次。</p> : null}
    {(loadState === "ready" || (loadState === "loading" && runs.length > 0)) && runs.length > 0 ? <ol className="research-run-history-list">
      {runs.map(run => <li key={run.runId} className="research-run-card">
        <div className="research-run-card-heading">
          <span className={`research-run-status ${statusClass(run.status)}`} title={run.status}>{STATUS_LABELS[run.status]}</span>
          <span className="research-run-meta">Run: <code>{run.runId}</code></span>
        </div>
        <p className="research-run-meta">开始：{new Date(run.startedAt).toLocaleString("zh-CN")}</p>
        <p className="research-run-meta">{run.status === "RUNNING" ? "尚未结束" : `结束：${new Date(run.completedAt as string).toLocaleString("zh-CN")}`}</p>
        <p className="research-run-evidence">证据快照：{run.evidenceManifest.itemCount} 项 · {run.evidenceManifest.available ? "当前可用" : "当前不可访问"}</p>
        {run.replayOf !== null ? <p className="research-run-replay">重放自：<code>{run.replayOf}</code></p> : null}
        <button type="button" className="research-run-open-detail" aria-expanded={selectedRunId === run.runId} onClick={() => setSelectedRunId(selected => selected === run.runId ? null : run.runId)}>
          {selectedRunId === run.runId ? "收起完整研究轮次" : "查看完整研究轮次"}
        </button>
        {selectedRunId === run.runId ? <ResearchRunDetail
          projectId={projectId}
          issueId={issueId}
          runId={run.runId}
          writeAllowed={writeAllowed ?? false}
          onHistoryRefresh={refreshSelf}
        /> : null}
      </li>)}
    </ol> : null}
    {nextCursor ? <button
      type="button"
      className="research-run-older"
      disabled={pageState.state === "loading"}
      onClick={() => void loadOlder(nextCursor)}
    >
      {pageState.state === "loading" ? "正在加载…" : "加载更早研究轮次"}
    </button> : null}
    {pageState.state === "error" ? <div className="research-error" role="alert">
      更早的研究轮次暂时无法加载。
      <button type="button" onClick={() => void loadOlder(pageState.cursor)}>重试加载更早研究轮次</button>
    </div> : null}
  </section>;
}
