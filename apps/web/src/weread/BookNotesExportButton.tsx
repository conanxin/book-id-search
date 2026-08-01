import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Check, Download, Loader2, X } from "lucide-react";
import {
  fetchAllWereadBookNotes,
  getWereadBookPagination,
} from "../wereadPrivate";
import {
  buildWereadBookExport,
  type WereadBookExportMeta,
} from "./wereadBookExportModel";
import { getBook } from "../api";

interface BookNotesExportButtonProps {
  token: string;
  catalogId: string;
  /** Optional public-book metadata to avoid an extra fetch. */
  metaHint?: WereadBookExportMeta;
  /** Override the default button label. */
  label?: string;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; filename: string; count: number; truncated: boolean }
  | { kind: "error"; message: string };

const DEFAULT_ERROR = "未能获取本书笔记，请稍后重试。";
const FALLBACK_META_ERROR = "公共书目信息暂不可用，将使用书目 ID 导出。";

/**
 * S27F — Per-book private WeRead Markdown export button.
 *
 * Flow:
 *  1. User clicks the button.
 *  2. Component fetches public book metadata (title/author) from
 *     `/books/:catalogId`.
 *  3. Component paginates every private note attached to that catalogId via
 *     `fetchAllWereadBookNotes`.
 *  4. Component builds a Markdown file via `buildWereadBookExport`.
 *  5. Component downloads the file in the browser using Blob + a temporary
 *     anchor element. The Markdown is NEVER POSTed to the server.
 *  6. An AbortController cancels in-flight requests when the token changes
 *     or the component unmounts. At most one export runs at a time per
 *     instance.
 */
export default function BookNotesExportButton({
  token,
  catalogId,
  metaHint,
  label = "导出本书全部笔记",
}: BookNotesExportButtonProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [resolvedMetaTitle, setResolvedMetaTitle] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    setState({ kind: "idle" });
    setResolvedMetaTitle("");
    abortRef.current?.abort();
    abortRef.current = null;
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [token, catalogId]);

  const handleClick = useCallback(async () => {
    if (state.kind === "loading") return;
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const myId = ++requestIdRef.current;
    setState({ kind: "loading" });

    try {
      // 1. Resolve public title/author (graceful fallback if the catalog
      //    detail endpoint is unavailable; we still export with the id).
      let meta: WereadBookExportMeta;
      if (metaHint && metaHint.catalogId === catalogId) {
        meta = metaHint;
      } else {
        try {
          const detail = await getBook(catalogId);
          const item = detail?.item;
          meta = {
            catalogId,
            title: typeof item?.title === "string" ? item.title : "",
            author: typeof item?.author === "string" ? item.author : "",
          };
        } catch {
          meta = { catalogId, title: "", author: "" };
        }
      }

      // 2. Paginate every private note attached to this catalogId.
      const result = await fetchAllWereadBookNotes(token, catalogId, {
        ...getWereadBookPagination(),
        signal: ctl.signal,
      });

      if (myId !== requestIdRef.current) return;
      if (!result.items || result.items.length === 0) {
        setState({ kind: "error", message: "没有可导出的笔记。" });
        return;
      }

      // 3. Build the Markdown.
      const built = buildWereadBookExport({
        meta,
        items: result.items,
        total: result.total,
        truncated: result.truncated,
      });
      setResolvedMetaTitle(meta.title || "");

      // 4. Trigger the browser download. We use a Blob and an anchor element
      //    so the Markdown never leaves the browser tab.
      const blob = new Blob([built.markdown], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = built.filename;
      a.setAttribute("data-testid", "weread-book-export-anchor");
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);

      const truncationSuffix = result.truncated ? "（已达安全上限，可能不完整）" : "";
      setState({
        kind: "ready",
        filename: built.filename,
        count: result.items.length,
        truncated: result.truncated,
      });
      void truncationSuffix; // used implicitly via state.truncated
    } catch (err) {
      if (myId !== requestIdRef.current) return;
      const msg =
        err instanceof DOMException && err.name === "AbortError"
          ? "导出已取消。"
          : err instanceof Error
            ? err.message || DEFAULT_ERROR
            : DEFAULT_ERROR;
      setState({ kind: "error", message: msg });
    } finally {
      if (abortRef.current === ctl) abortRef.current = null;
    }
  }, [catalogId, label, metaHint, state.kind, token]);

  const handleClose = useCallback(() => {
    abortRef.current?.abort();
    setState({ kind: "idle" });
  }, []);

  const showFallbackNotice =
    state.kind === "ready" && resolvedMetaTitle.trim() === "";

  return (
    <div className="weread-book-export" data-testid="weread-book-export">
      <button
        type="button"
        className="weread-book-export__button"
        onClick={handleClick}
        disabled={state.kind === "loading"}
        data-testid="weread-book-export-button"
        title={`按 catalogId ${catalogId} 导出本书全部微信读书笔记`}
      >
        {state.kind === "loading" ? (
          <>
            <Loader2 size={14} className="spin" aria-hidden="true" />
            正在整理本书笔记…
          </>
        ) : (
          <>
            <BookOpen size={14} aria-hidden="true" />
            {label}
          </>
        )}
      </button>

      {state.kind === "ready" ? (
        <p
          className="weread-book-export__status"
          data-testid="weread-book-export-status"
          role="status"
        >
          <Check size={12} aria-hidden="true" />
          已生成 <code>{state.filename}</code>，共 {state.count} 条笔记。
          {state.truncated ? "（已达安全上限，可能不完整）" : ""}
          {showFallbackNotice ? ` ${FALLBACK_META_ERROR}` : ""}
          <button
            type="button"
            className="weread-book-export__close"
            onClick={handleClose}
            title="关闭状态"
          >
            <X size={12} aria-hidden="true" /> 关闭
          </button>
        </p>
      ) : null}

      {state.kind === "error" ? (
        <p
          className="weread-book-export__error"
          data-testid="weread-book-export-error"
          role="alert"
        >
          <Download size={12} aria-hidden="true" />
          {state.message}
          <button
            type="button"
            className="weread-book-export__close"
            onClick={handleClose}
            title="关闭"
          >
            <X size={12} aria-hidden="true" /> 关闭
          </button>
        </p>
      ) : null}
    </div>
  );
}