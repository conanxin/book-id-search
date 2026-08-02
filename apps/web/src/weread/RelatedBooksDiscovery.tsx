import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, BookOpen, Loader2, RefreshCw, Search, Trash2 } from "lucide-react";
import {
  fetchWereadRelatedBooks,
  type WereadAiSummaryResult,
  type WereadRelatedBookItem,
  type WereadPrivateNoteItem,
} from "../wereadPrivate";
import {
  buildRelatedBookExclusions,
  buildRelatedBookSeeds,
  formatRelatedBookMeta,
  getRelatedBookReason,
  validateRelatedBookEligibility,
} from "./wereadRelatedBooksModel";

interface RelatedBooksDiscoveryProps {
  token: string;
  /**
   * The current AI summary. When `null` the related-books button stays
   * disabled — the user MUST run an AI summary first. The summary is
   * exposed by the parent (`NotesAiSummary`) only after its ready state.
   */
  summary: WereadAiSummaryResult | null;
  /** Currently loaded private notes — used only for catalogId exclusions. */
  notes: WereadPrivateNoteItem[];
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; items: WereadRelatedBookItem[]; metaText: string }
  | { kind: "empty"; metaText: string }
  | { kind: "error"; message: string };

/**
 * S27G — Discover related public books from the sanitised AI-summary themes.
 *
 * Privacy contract (UI):
 *   - The button is DISABLED until the user has an actual AI summary.
 *   - Only short theme / direction labels leave the browser — no overview,
 *     keyPoints, raw note text, token, q, wereadBookId/noteId/highlightId /
 *     chapterTitle, private title/author.
 *   - The request is fired exactly once per click. Subsequent clicks cancel
 *     any in-flight request via AbortController.
 *   - The summary / token / notes mutation clears the previous result so the
 *     UI never shows results derived from a stale summary.
 *   - Results are kept only in React state and never persisted to
 *     localStorage, sessionStorage, IndexedDB, query string, or files.
 *   - Card text is rendered as React children only — no
 *     dangerouslySetInnerHTML.
 */
export default function RelatedBooksDiscovery({
  token,
  summary,
  notes,
}: RelatedBooksDiscoveryProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const itemsCount = notes.length;

  const eligibility = useMemo(
    () => validateRelatedBookEligibility({ summary, itemsCount }),
    [summary, itemsCount]
  );

  const seedsResult = useMemo(
    () => buildRelatedBookSeeds({ summary }),
    [summary]
  );

  const exclusions = useMemo(() => buildRelatedBookExclusions(notes), [notes]);

  // Clear stale results when the source data changes.
  useEffect(() => {
    setState({ kind: "idle" });
  }, [token, summary, itemsCount]);

  // Abort on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const handleDiscover = useCallback(async () => {
    if (!eligibility.eligible) return;
    if (state.kind === "loading") return;
    if (!seedsResult.ok || seedsResult.seeds.length === 0) return;

    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    const myId = ++requestIdRef.current;
    setState({ kind: "loading" });
    try {
      const resp = await fetchWereadRelatedBooks(
        token,
        seedsResult.seeds,
        exclusions,
        ctl.signal
      );
      if (myId !== requestIdRef.current) return;
      const metaText = formatRelatedBookMeta(resp.meta);
      const items = Array.isArray(resp.items) ? resp.items : [];
      if (items.length === 0) {
        setState({ kind: "empty", metaText });
      } else {
        setState({ kind: "ready", items, metaText });
      }
    } catch (err) {
      if (myId !== requestIdRef.current) return;
      const name = (err as Error)?.name ?? "";
      if (name === "AbortError") return;
      setState({ kind: "error", message: getErrorMessage(err) });
    } finally {
      if (abortRef.current === ctl) abortRef.current = null;
    }
  }, [
    eligibility.eligible,
    seedsResult,
    exclusions,
    state.kind,
    token,
  ]);

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    setState({ kind: "idle" });
  }, []);

  return (
    <section
      className="weread-related-books"
      data-testid="weread-related-books"
      aria-label="根据当前主题发现相关书"
    >
      <header className="weread-related-books__header">
        <h4 className="weread-related-books__title">
          <BookOpen size={14} aria-hidden="true" />
          根据当前主题发现相关书
        </h4>
        <p
          className="weread-related-books__notice"
          data-testid="weread-related-books-notice"
        >
          仅将 AI 摘要中的主题词发送到本站私有检索接口。不会再次发送笔记正文给 MiniMax，
          也不会进入公开搜索日志。
        </p>
      </header>

      <div className="weread-related-books__actions" data-testid="weread-related-books-actions">
        <button
          type="button"
          className="weread-related-books__primary"
          onClick={handleDiscover}
          disabled={!eligibility.eligible || state.kind === "loading"}
          data-testid="weread-related-books-button"
          aria-busy={state.kind === "loading"}
        >
          {state.kind === "loading" ? (
            <>
              <Loader2 size={14} className="spin" aria-hidden="true" />
              正在检索…
            </>
          ) : (
            <>
              <Search size={14} aria-hidden="true" />
              发现相关书
            </>
          )}
        </button>
        {state.kind === "ready" || state.kind === "empty" ? (
          <>
            <button
              type="button"
              className="weread-related-books__secondary"
              onClick={handleDiscover}
              disabled={!eligibility.eligible}
              data-testid="weread-related-books-refresh"
            >
              <RefreshCw size={14} aria-hidden="true" />
              重新发现
            </button>
            <button
              type="button"
              className="weread-related-books__secondary"
              onClick={handleClear}
              data-testid="weread-related-books-clear"
            >
              <Trash2 size={14} aria-hidden="true" />
              清除结果
            </button>
          </>
        ) : null}
      </div>

      {!eligibility.eligible ? (
        <p
          className="weread-related-books__status"
          data-testid="weread-related-books-disabled"
        >
          {eligibility.eligible ? "" : (eligibility as { reason: string }).reason}
        </p>
      ) : (
        <p className="weread-related-books__status" data-testid="weread-related-books-meta">
          将使用 {seedsResult.seeds.length} 个主题种子 / 已排除 {exclusions.length} 本已加载书
          。不会发送搜索词、token 或正文。
        </p>
      )}

      {state.kind === "loading" ? (
        <div className="weread-related-books__status" data-testid="weread-related-books-loading">
          <Loader2 size={14} className="spin" aria-hidden="true" />
          正在根据主题检索公开书目…
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="weread-related-books__error" data-testid="weread-related-books-error">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{state.message}</span>
          <button
            type="button"
            className="weread-related-books__secondary weread-related-books__secondary--inline"
            onClick={handleClear}
          >
            关闭
          </button>
        </div>
      ) : null}

      {state.kind === "empty" ? (
        <div className="weread-related-books__status" data-testid="weread-related-books-empty">
          未命中相关公开书目。可以尝试清除结果后再次触发。
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <>
          <p className="weread-related-books__status" data-testid="weread-related-books-meta">
            {state.metaText}
          </p>
          <div className="weread-related-books__grid" data-testid="weread-related-books-grid">
            {state.items.map((it) => (
              <article
                key={it.catalogId}
                className="weread-related-book-card"
                data-testid="weread-related-book-card"
              >
                <h5 className="weread-related-book-card__title">{it.title}</h5>
                {it.author ? (
                  <p className="weread-related-book-card__meta">
                    <span>{it.author}</span>
                    {it.publisher ? <span> · {it.publisher}</span> : null}
                    {it.publishYear != null && it.publishYear !== "" ? (
                      <span> · {String(it.publishYear)}</span>
                    ) : null}
                  </p>
                ) : null}
                <p className="weread-related-book-card__reason">
                  {getRelatedBookReason(it, summary)}
                </p>
                <a
                  className="weread-related-book-card__link"
                  href={`/books/${it.catalogId}`}
                  data-testid="weread-related-book-link"
                >
                  查看书目
                </a>
              </article>
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Intentionally drop the message text — the calling layer's error
    // messages are already generic Chinese. We only keep ours to fall back
    // for client-side parse failures.
    const msg = err.message;
    if (!msg) return "相关书检索失败，请稍后再试。";
    if (
      msg.includes("Missing token") ||
      msg.includes("Invalid token") ||
      msg.includes("Not Found") ||
      msg.includes("请求体过大") ||
      msg.includes("种子")
    ) {
      return msg;
    }
    if (
      msg.includes("请求过于频繁") ||
      msg.includes("相关书检索正在处理中") ||
      msg.includes("相关书检索暂不可用") ||
      msg.includes("相关书检索请求过于频繁") ||
      msg.includes("相关书检索失败")
    ) {
      return msg;
    }
  }
  return "相关书检索失败，请稍后再试。";
}
