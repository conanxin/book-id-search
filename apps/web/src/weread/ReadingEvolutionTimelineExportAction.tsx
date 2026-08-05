/**
 * S27P-3 — Reading Evolution Timeline Export Action.
 *
 * Pure-React child component that owns the local UI state for
 * downloading the timeline Markdown. Lives in its own file so the
 * parent `ReadingEvolutionTimelinePanel` can remain zero-hook while
 * the export child still uses `useState` + `useEffect` (or
 * key-reset) to track idle / ready / error status.
 *
 * The component is bound by the same privacy contract as the model:
 *   - NEVER invokes fetch / AI / related-books.
 *   - NEVER writes to browser storage APIs (local/session/indexed).
 *   - NEVER mutates the timeline, archive, range, Top N, cache,
 *     or retry semantics.
 *   - NEVER touches the URL.
 *
 * Hook order safety: this component introduces its own hooks but
 * places them BEFORE any conditional return so the hook list is
 * stable across re-renders. (Parent `ReadingEvolutionTimelinePanel`
 * is zero-hook — see `ReadingEvolutionTimelinePanel.tsx`.)
 */

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

import type { WereadReadingEvolutionTimeline } from "./wereadReadingEvolutionTimeline";
import {
  buildReadingEvolutionMarkdown,
  triggerReadingEvolutionMarkdownDownload,
  type ReadingEvolutionRangeLabel,
} from "./wereadReadingEvolutionMarkdown";

// ---------- props ----------

export interface ReadingEvolutionTimelineExportActionProps {
  timeline: WereadReadingEvolutionTimeline;
  rangeLabel: ReadingEvolutionRangeLabel;
  topBooksLimit: 6 | 12 | 18;
  failedYears: number[];
  bootstrapLoading: boolean;
}

type ExportStatus = "idle" | "ready" | "error";

// ---------- constants ----------

const EXPORT_NOTICE =
  "年度统计时间线文件只在当前浏览器中生成，不会重新请求年度数据，也不会上传或保存到服务器。";

const EXPORT_SUCCESS = "已生成年度统计时间线 Markdown。";

const EXPORT_ERROR = "未能生成 Markdown，请稍后重试。";

// ---------- helpers ----------

function buildExportResetKey(args: {
  rangeLabel: ReadingEvolutionRangeLabel;
  topBooksLimit: 6 | 12 | 18;
  loadedYearCount: number;
  transitionCount: number;
  significantTransitionCount: number;
  failedYears: number[];
}): string {
  return [
    args.rangeLabel,
    args.topBooksLimit,
    args.loadedYearCount,
    args.transitionCount,
    args.significantTransitionCount,
    args.failedYears.join(","),
  ].join(":");
}

// ---------- component ----------

export default function ReadingEvolutionTimelineExportAction({
  timeline,
  rangeLabel,
  topBooksLimit,
  failedYears,
  bootstrapLoading,
}: ReadingEvolutionTimelineExportActionProps) {
  // ---- hooks (BEFORE any early return) ----
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportMessage, setExportMessage] = useState<string>("");

  const resetKey = buildExportResetKey({
    rangeLabel,
    topBooksLimit,
    loadedYearCount: timeline.summary.loadedYearCount,
    transitionCount: timeline.summary.transitionCount,
    significantTransitionCount: timeline.summary.significantTransitionCount,
    failedYears,
  });

  useEffect(() => {
    setExportStatus("idle");
    setExportMessage("");
    // We deliberately depend on the reset key only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // ---- derived ----
  const canExport = !bootstrapLoading || timeline.summary.loadedYearCount > 0;

  // ---- handler ----
  const handleExport = () => {
    try {
      const built = buildReadingEvolutionMarkdown({
        timeline,
        rangeLabel,
        topBooksLimit,
        failedYears,
        exportedAt: new Date(),
      });
      triggerReadingEvolutionMarkdownDownload({
        content: built.content,
        filename: built.filename,
      });
      setExportStatus("ready");
      setExportMessage(EXPORT_SUCCESS);
    } catch (err: unknown) {
      setExportStatus("error");
      setExportMessage(EXPORT_ERROR);
    }
  };

  // ---- render ----
  return (
    <div
      className="weread-reading-evolution__export"
      data-testid="weread-reading-evolution-export"
      data-export-status={exportStatus}
    >
      <div className="weread-reading-evolution__export-actions">
        <button
          type="button"
          className="weread-reading-evolution__export-button"
          onClick={handleExport}
          disabled={!canExport}
          data-testid="weread-reading-evolution-export-button"
          aria-label="导出年度统计时间线 Markdown"
        >
          <Download size={14} aria-hidden="true" /> 导出年度统计时间线 Markdown
        </button>
      </div>
      <p
        className="weread-reading-evolution__export-summary"
        data-testid="weread-reading-evolution-export-summary"
      >
        当前范围：{rangeLabel} · Top {topBooksLimit} · 成功加载{" "}
        {timeline.summary.loadedYearCount} 个年份
        {failedYears.length > 0 ? ` · 失败 ${failedYears.length} 个年份` : ""}
      </p>
      <p
        className="weread-reading-evolution__export-notice"
        data-testid="weread-reading-evolution-export-notice"
      >
        {EXPORT_NOTICE}
      </p>
      {exportStatus !== "idle" ? (
        <p
          className={
            exportStatus === "ready"
              ? "weread-reading-evolution__export-status weread-reading-evolution__export-status--success"
              : "weread-reading-evolution__export-status weread-reading-evolution__export-status--error"
          }
          data-testid="weread-reading-evolution-export-status"
          data-status={exportStatus}
          role="status"
        >
          {exportMessage}
        </p>
      ) : null}
    </div>
  );
}
