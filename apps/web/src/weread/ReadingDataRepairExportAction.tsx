/**
 * S27R-3B — Reading Data Repair Plan Markdown Export Action.
 *
 * Pure-React child component that owns the local UI state for
 * downloading the deterministic repair-plan Markdown. Lives in its
 * own file so the parent `ReadingDataRepairRecommendationsPanel`
 * can remain zero-hook while this child still uses `useState` +
 * `useEffect` (key-reset) to track idle / success / error status.
 *
 * Privacy contract:
 *   - Never invokes fetch / AI / related-books.
 *   - Never writes to localStorage / sessionStorage / IndexedDB.
 *   - Never mutates the plan or the underlying audit.
 *   - Never touches the URL bar.
 *   - Never uses innerHTML / dangerouslySetInnerHTML.
 *   - Never calls retry / reload.
 *   - Never evaluates the user.
 *
 * Hook order safety: this component introduces its own hooks but
 * places them BEFORE any conditional return so the hook list is
 * stable across re-renders.
 *
 * Reset key: the parent computes a deterministic, privacy-safe
 * `repairExportResetKey` (via `JSON.stringify` of the model's
 * debug snapshot) and passes it as the React `key` prop. Any
 * change to the plan / summary / priorities / counts forces a
 * fresh remount, clearing any prior `success` status.
 */

import { useEffect, useState } from "react";
import { Download } from "lucide-react";

import type { WereadReadingDataRepairPlan } from "./wereadReadingDataRepairRecommendations";

import {
  buildReadingDataRepairMarkdown,
  triggerReadingDataRepairMarkdownDownload,
} from "./wereadReadingDataRepairMarkdown";

// ---------- props ----------

export interface ReadingDataRepairExportActionProps {
  plan: WereadReadingDataRepairPlan;
  loading: boolean;
}

type ExportStatus = "idle" | "success" | "error";

// ---------- constants ----------

const EXPORT_NOTICE =
  "修复建议文件只在当前浏览器中生成，不会执行重试、重新加载或修改任何数据，也不会上传到服务器。";

const EXPORT_SUCCESS = "已生成修复建议 Markdown。";

const EXPORT_ERROR = "生成修复建议文件失败，请稍后重试。";

// ---------- component ----------

export default function ReadingDataRepairExportAction({
  plan,
  loading,
}: ReadingDataRepairExportActionProps) {
  // ---- hooks (BEFORE any conditional return) ----
  const [exportStatus, setExportStatus] = useState<ExportStatus>("idle");
  const [exportMessage, setExportMessage] = useState<string>("");

  useEffect(() => {
    // Reset whenever the parent remounts us with a fresh plan
    // (the React `key` prop drives remount; this effect also runs
    // on first mount to make the intent explicit).
    setExportStatus("idle");
    setExportMessage("");
    // We only want to reset when the remount happens; the parent
    // uses a stable derived key, so a no-deps effect is fine here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- derived ----
  // While `loading` is true we disable the export button so the
  // user does not download a half-built plan. After loading
  // completes (including the empty plan case) the button is
  // enabled: the empty plan still produces a valid Markdown
  // export with full metadata + safety + methodology sections.
  const canExport = !loading;

  // ---- handler ----
  const handleExport = () => {
    try {
      const built = buildReadingDataRepairMarkdown({
        plan,
        exportedAt: new Date(),
      });
      triggerReadingDataRepairMarkdownDownload({
        content: built.content,
        filename: built.filename,
        mimeType: built.mimeType,
      });
      setExportStatus("success");
      setExportMessage(EXPORT_SUCCESS);
    } catch (err: unknown) {
      // Never leak the error object / stack into the UI. Log
      // suppression is intentional — the caller sees a fixed
      // neutral message and may retry.
      void err;
      setExportStatus("error");
      setExportMessage(EXPORT_ERROR);
    }
  };

  // ---- render ----
  return (
    <div
      className="weread-reading-data-repair__export"
      data-testid="weread-reading-data-repair-export"
      data-export-status={exportStatus}
      data-loading={loading ? "true" : "false"}
    >
      <div className="weread-reading-data-repair__export-actions">
        <button
          type="button"
          className="weread-reading-data-repair__export-button"
          onClick={handleExport}
          disabled={!canExport}
          data-testid="weread-reading-data-repair-export-button"
          aria-label="导出修复建议 Markdown"
        >
          <Download size={14} aria-hidden="true" /> 导出修复建议 Markdown
        </button>
      </div>
      <p
        className="weread-reading-data-repair__export-summary"
        data-testid="weread-reading-data-repair-export-summary"
      >
        建议总数：{plan.summary.total} · 可重试 {plan.summary.retryable} · 可重新加载{" "}
        {plan.summary.reloadable} · 需人工核对 {plan.summary.manualReview} · 当前字段不足{" "}
        {plan.summary.unsupported}
      </p>
      <p
        className="weread-reading-data-repair__export-notice"
        data-testid="weread-reading-data-repair-export-notice"
      >
        {EXPORT_NOTICE}
      </p>
      {exportStatus !== "idle" ? (
        <p
          className={
            exportStatus === "success"
              ? "weread-reading-data-repair__export-status weread-reading-data-repair__export-status--success"
              : "weread-reading-data-repair__export-status weread-reading-data-repair__export-status--error"
          }
          data-testid="weread-reading-data-repair-export-status"
          data-status={exportStatus}
          role="status"
        >
          {exportMessage}
        </p>
      ) : null}
    </div>
  );
}