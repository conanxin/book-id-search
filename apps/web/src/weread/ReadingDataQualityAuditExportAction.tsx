/**
 * S27Q-3B — Reading Data Quality Audit Markdown Export Action.
 *
 * Pure-React child component that owns the local UI state for
 * downloading the audit Markdown. Lives in its own file so the
 * parent `ReadingDataQualityAuditPanel` can remain zero-hook while
 * the export child still uses `useState` + `useEffect` (key-reset)
 * to track idle / ready / error status.
 *
 * Privacy contract:
 *   - Never invokes fetch / AI / related-books.
 *   - Never writes to localStorage / sessionStorage / IndexedDB.
 *   - Never mutates the audit, archive, range, Top N, cache, retry
 *     semantics.
 *   - Never touches the URL bar.
 *   - Never uses innerHTML / dangerouslySetInnerHTML.
 *
 * Hook order safety: this component introduces its own hooks but
 * places them BEFORE any conditional return so the hook list is
 * stable across re-renders.
 */

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

import type { WereadReadingDataQualityAudit } from "./wereadReadingDataQualityAudit";
import {
  buildReadingDataQualityAuditMarkdown,
  triggerReadingDataQualityAuditMarkdownDownload,
} from "./wereadReadingDataQualityAuditMarkdown";

// ---------- props ----------

export interface ReadingDataQualityAuditExportActionProps {
  audit: WereadReadingDataQualityAudit;
  rangeLabel: string;
  topBooksLimit: 6 | 12 | 18;
  bootstrapLoading: boolean;
}

type ExportStatus = "idle" | "success" | "error";

// ---------- constants ----------

const EXPORT_NOTICE =
  "审计文件只在当前浏览器中生成，不会重新请求年度数据，也不会上传或保存到服务器。";

const EXPORT_SUCCESS = "已生成数据质量审计 Markdown。";

const EXPORT_ERROR = "生成审计文件失败，请稍后重试。";

// ---------- helpers ----------

/**
 * Deterministic reset key derived from safe audit fields. Never
 * includes the raw archive, audit.auditedAt Date, Issue details,
 * title / author / catalogId, or any private identifier.
 */
export function buildReadingDataQualityAuditExportResetKey(
  audit: WereadReadingDataQualityAudit,
  args: { rangeLabel: string; topBooksLimit: 6 | 12 | 18 },
): string {
  const issueIds = audit.issues.map((i) => i.id).sort().join(",");
  return [
    args.rangeLabel,
    args.topBooksLimit,
    audit.status,
    audit.summary.errorCount,
    audit.summary.warningCount,
    audit.summary.infoCount,
    audit.coverage.targetYears.join(","),
    audit.coverage.loadedYears.join(","),
    audit.coverage.failedYears.join(","),
    audit.coverage.unaccountedYears.join(","),
    audit.coverage.unexpectedLoadedYears.join(","),
    audit.summary.accountedRatio,
    audit.summary.datedRecordRatio,
    audit.summary.matchedRecordRatio,
    audit.summary.publicTopBookMetadataRatio,
    audit.summary.yearLinkCoverageRatio,
    issueIds,
  ].join("|");
}

// ---------- component ----------

export default function ReadingDataQualityAuditExportAction({
  audit,
  rangeLabel,
  topBooksLimit,
  bootstrapLoading,
}: ReadingDataQualityAuditExportActionProps) {
  // ---- hooks (BEFORE any conditional return) ----
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportMessage, setExportMessage] = useState<string>("");

  const resetKey = buildReadingDataQualityAuditExportResetKey(audit, {
    rangeLabel,
    topBooksLimit,
  });

  useEffect(() => {
    setExportStatus("idle");
    setExportMessage("");
    // We deliberately depend on the reset key only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // ---- derived ----
  // Loading state still allows export once bootstrap returns; the
  // button is only disabled while bootstrap is running AND the audit
  // has not produced any loaded year yet.
  const canExport = !bootstrapLoading || audit.summary.loadedYearCount > 0;

  // ---- handler ----
  const handleExport = () => {
    try {
      const built = buildReadingDataQualityAuditMarkdown({
        audit,
        rangeLabel,
        topBooksLimit,
        exportedAt: new Date(),
      });
      triggerReadingDataQualityAuditMarkdownDownload({
        content: built.content,
        filename: built.filename,
      });
      setExportStatus("success");
      setExportMessage(EXPORT_SUCCESS);
    } catch (err: unknown) {
      void err;
      setExportStatus("error");
      setExportMessage(EXPORT_ERROR);
    }
  };

  // ---- render ----
  return (
    <div
      className="weread-reading-data-quality__export"
      data-testid="weread-reading-data-quality-export"
      data-export-status={exportStatus}
    >
      <div className="weread-reading-data-quality__export-actions">
        <button
          type="button"
          className="weread-reading-data-quality__export-button"
          onClick={handleExport}
          disabled={!canExport}
          data-testid="weread-reading-data-quality-export-button"
          aria-label="导出数据质量审计 Markdown"
        >
          <Download size={14} aria-hidden="true" /> 导出数据质量审计 Markdown
        </button>
      </div>
      <p
        className="weread-reading-data-quality__export-summary"
        data-testid="weread-reading-data-quality-export-summary"
      >
        当前范围：{rangeLabel} · 高互动书目口径：Top {topBooksLimit} · 成功加载{" "}
        {audit.summary.loadedYearCount} 个年份
        {audit.summary.failedYearCount > 0
          ? ` · 失败 ${audit.summary.failedYearCount} 个年份`
          : ""}
      </p>
      <p
        className="weread-reading-data-quality__export-notice"
        data-testid="weread-reading-data-quality-export-notice"
      >
        {EXPORT_NOTICE}
      </p>
      {exportStatus !== "idle" ? (
        <p
          className={
            exportStatus === "success"
              ? "weread-reading-data-quality__export-status weread-reading-data-quality__export-status--success"
              : "weread-reading-data-quality__export-status weread-reading-data-quality__export-status--error"
          }
          data-testid="weread-reading-data-quality-export-status"
          data-status={exportStatus}
          role="status"
        >
          {exportMessage}
        </p>
      ) : null}
    </div>
  );
}