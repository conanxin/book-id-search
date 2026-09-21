import { useEffect, useRef, useState } from "react";
import {
  listAssessments,
  ProjectApiError,
  type AssessmentSummary,
} from "./api";

type Props = {
  token: string;
  projectId: string;
  issueId: string;
  claimId: string;
  refreshVersion: number;
  onIntegrityBlocked: (blocked: boolean) => void;
  onOpenDetail: (assessmentId: string) => void;
};

type LoadState =
  | { state: "loading" }
  | { state: "ready" }
  | { state: "unavailable" }
  | { state: "integrity" };

type PageState =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error"; cursor: string }
  | { state: "invalid-cursor" };

function confidenceLabel(value: AssessmentSummary["confidenceLevel"]): string {
  return value ? `${value}` : "未指定信心";
}

export function AssessmentHistory({
  token,
  projectId,
  issueId,
  claimId,
  refreshVersion,
  onIntegrityBlocked,
  onOpenDetail,
}: Props) {
  const [load, setLoad] = useState<LoadState>({ state: "loading" });
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [page, setPage] = useState<PageState>({ state: "idle" });
  const initial = useRef<AbortController | null>(null);
  const older = useRef<AbortController | null>(null);

  async function loadInitial(signal?: AbortSignal) {
    setLoad({ state: "loading" });
    setPage({ state: "idle" });
    try {
      const result = await listAssessments(
        token,
        projectId,
        issueId,
        claimId,
        { limit: 20 },
        signal,
      );
      if (signal?.aborted) return;
      setAssessments(result.assessments);
      setNextCursor(result.nextCursor);
      setLoad({ state: "ready" });
      onIntegrityBlocked(false);
    } catch (error) {
      if (signal?.aborted) return;
      if (error instanceof ProjectApiError && error.status === 500) {
        setLoad({ state: "integrity" });
        onIntegrityBlocked(true);
      } else {
        setLoad({ state: "unavailable" });
        onIntegrityBlocked(false);
      }
    }
  }

  useEffect(() => {
    initial.current?.abort();
    older.current?.abort();
    const controller = new AbortController();
    initial.current = controller;
    void loadInitial(controller.signal);
    return () => controller.abort();
  }, [token, projectId, issueId, claimId, refreshVersion]);

  async function loadOlder(cursor: string) {
    older.current?.abort();
    const controller = new AbortController();
    older.current = controller;
    setPage({ state: "loading" });
    try {
      const result = await listAssessments(
        token,
        projectId,
        issueId,
        claimId,
        { limit: 20, cursor },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setAssessments(previous => [...previous, ...result.assessments]);
      setNextCursor(result.nextCursor);
      setPage({ state: "idle" });
    } catch (error) {
      if (controller.signal.aborted) return;
      if (error instanceof ProjectApiError && error.code === "ASSESSMENT_CURSOR_INVALID") {
        setNextCursor(null);
        setPage({ state: "invalid-cursor" });
      } else {
        setPage({ state: "error", cursor });
      }
    } finally {
      if (older.current === controller) older.current = null;
    }
  }

  if (load.state === "loading") {
    return <section className="assessment-history" aria-label="评价历史"><p role="status">正在读取评价历史…</p></section>;
  }
  if (load.state === "integrity") {
    return <section className="assessment-history" aria-label="评价历史"><div className="research-error" role="alert">评价历史存在数据完整性问题。</div></section>;
  }
  if (load.state === "unavailable") {
    return <section className="assessment-history" aria-label="评价历史">
      <div className="research-error" role="alert">
        评价历史暂时无法加载。
        <button type="button" onClick={() => void loadInitial()}>重试评价历史</button>
      </div>
    </section>;
  }

  return <section className="assessment-history" aria-label="评价历史">
    <h4>评价历史</h4>
    {assessments.length === 0 ? <p>当前没有可显示的评价记录。</p> : <ol className="assessment-history-list">
      {assessments.map((assessment, index) => (
        <li key={assessment.id} className="assessment-history-item">
          {index === 0 ? <strong>最近一次评价</strong> : null}
          {index === 0
            ? <div>{assessment.stance} · {confidenceLabel(assessment.confidenceLevel)}</div>
            : <>
                <div>{assessment.stance}</div>
                <small>信心：{confidenceLabel(assessment.confidenceLevel)}</small>
              </>}
          <div>{assessment.evidenceManifest.itemCount} 条证据</div>
          <small>{new Date(assessment.createdAt).toLocaleString("zh-CN")}</small>
          <p>{assessment.reasoningExcerpt ?? "未记录判断理由"}</p>
          <code className="assessment-hash">{assessment.evidenceManifest.manifestSha256}</code>
          <button type="button" onClick={() => onOpenDetail(assessment.id)}>查看完整评价</button>
        </li>
      ))}
    </ol>}
    {nextCursor && page.state !== "invalid-cursor" ? (
      <button
        type="button"
        disabled={page.state === "loading"}
        onClick={() => void loadOlder(nextCursor)}
      >
        {page.state === "loading" ? "正在加载…" : "加载更早评价"}
      </button>
    ) : null}
    {page.state === "error" ? <div className="research-error" role="alert">
      更早的评价暂时无法加载。
      <button type="button" onClick={() => void loadOlder(page.cursor)}>重试加载更早评价</button>
    </div> : null}
    {page.state === "invalid-cursor" ? <div className="research-error" role="alert">
      评价历史分页状态已失效。
      <button type="button" onClick={() => void loadInitial()}>重新加载评价历史</button>
    </div> : null}
  </section>;
}
