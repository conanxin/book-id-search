import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Brain, Check, Copy, Loader2, Sparkles, Trash2, X } from "lucide-react";
import {
  fetchWereadAiSummary,
  type WereadAiSummaryInputItem,
  type WereadAiSummaryResult,
  type WereadPrivateNoteItem,
} from "../wereadPrivate";
import {
  AI_SUMMARY_CLIENT_LIMITS,
  buildAiSummaryInput,
  buildAiSummaryMarkdown,
  formatAiSummaryMeta,
  getAiSummaryErrorMessage,
  hasAiSummaryContent,
  validateAiSummaryEligibility,
} from "./wereadAiSummaryModel";
import RelatedBooksDiscovery from "./RelatedBooksDiscovery";

interface NotesAiSummaryProps {
  token: string;
  items: WereadPrivateNoteItem[];
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; summary: WereadAiSummaryResult; metaText: string }
  | { kind: "error"; message: string };

/**
 * S27E — Private WeRead AI notes summarisation panel.
 *
 * Lives inside NotesLibrary, below the loaded items list. The user must
 * explicitly click the button to trigger an AI summary; nothing runs on
 * mount or when the token / search changes.
 *
 * Privacy contract (UI):
 *  - The summary only ever describes the notes the user already sees on
 *    this page. The payload sent to the server is sanitised by
 *    `buildAiSummaryInput` (drops empty items, caps at 30, trims text).
 *  - Search terms (`q`), private token, wereadBookId / noteId / highlightId
 *    / chapterTitle / catalogId, title, author, dates, the matched flag,
 *    and the URL are NOT included in the request payload.
 *  - The privacy notice is always visible. The button is disabled when
 *    there are no notes to summarise or when the AI is already running.
 *  - Old summaries are cleared on token / items / filter / search / sort
 *    changes so the displayed summary always matches the current view.
 *  - An AbortController cancels in-flight requests when the token changes
 *    or the user leaves the page.
 *  - The summary is rendered as React children only (never
 *    dangerouslySetInnerHTML), so HTML tags inside the response text are
 *    displayed literally and never executed.
 */
export default function NotesAiSummary({ token, items }: NotesAiSummaryProps) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const requestIdRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const eligibility = useMemo(
    () => validateAiSummaryEligibility(items),
    [items]
  );

  const itemsCount = items.length;
  const itemsUsedInCall = Math.min(
    itemsCount,
    AI_SUMMARY_CLIENT_LIMITS.MAX_INPUT_ITEMS
  );
  const truncated = itemsCount > AI_SUMMARY_CLIENT_LIMITS.MAX_INPUT_ITEMS;

  // Clear stale summaries whenever the loaded notes / token / etc. changes.
  useEffect(() => {
    setState({ kind: "idle" });
    setCopyState("idle");
  }, [token, itemsCount]);

  // Abort on unmount.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const handleSummarize = useCallback(async () => {
    if (!eligibility.eligible) return;
    if (state.kind === "loading") return;

    const payload = buildAiSummaryInput(items);
    if (payload.length === 0) return;

    // Cancel any prior request and start a new one.
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;

    const myId = ++requestIdRef.current;
    setState({ kind: "loading" });
    try {
      const safeInput: WereadAiSummaryInputItem[] = payload.map((p) => ({
        type: p.type,
        text: p.text,
        comment: p.comment,
      }));
      const resp = await fetchWereadAiSummary(token, safeInput, ctl.signal);
      if (myId !== requestIdRef.current) return; // stale
      if (!hasAiSummaryContent(resp.summary)) {
        setState({
          kind: "error",
          message: "AI 输出无法显示，请稍后再试。",
        });
        return;
      }
      setState({
        kind: "ready",
        summary: resp.summary,
        metaText: formatAiSummaryMeta(resp.meta),
      });
    } catch (err) {
      if (myId !== requestIdRef.current) return;
      setState({ kind: "error", message: getAiSummaryErrorMessage(err) });
    } finally {
      if (abortRef.current === ctl) abortRef.current = null;
    }
  }, [eligibility, items, state.kind, token]);

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    setState({ kind: "idle" });
    setCopyState("idle");
  }, []);

  const handleCopy = useCallback(async () => {
    if (state.kind !== "ready") return;
    const md = buildAiSummaryMarkdown(state.summary, {
      itemsUsed: itemsUsedInCall,
      totalCharacters: state.summary.overview.length, // approximation only
      persisted: false,
      provider: "minimax",
    });
    try {
      await navigator.clipboard?.writeText(md);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1200);
    } catch {
      // best-effort: clipboard not available
    }
  }, [itemsUsedInCall, state]);

  return (
    <section
      className="weread-ai-summary"
      data-testid="weread-ai-summary"
      aria-label="AI 整理当前已加载笔记"
    >
      <header className="weread-ai-summary__header">
        <h3 className="weread-ai-summary__title">
          <Brain size={16} aria-hidden="true" />
          AI 整理当前笔记
        </h3>
        <p className="weread-ai-summary__notice" data-testid="weread-ai-summary-notice">
          <Sparkles size={12} aria-hidden="true" />
          点击后，当前已加载的最多 {AI_SUMMARY_CLIENT_LIMITS.MAX_INPUT_ITEMS} 条笔记将发送给 MiniMax
          生成临时摘要。不会写入公开搜索或 Meilisearch，也不会保存到服务器。
        </p>
      </header>

      <div className="weread-ai-summary__actions" data-testid="weread-ai-summary-actions">
        <button
          type="button"
          className="weread-ai-summary__primary"
          onClick={handleSummarize}
          disabled={!eligibility.eligible || state.kind === "loading"}
          data-testid="weread-ai-summary-button"
          aria-busy={state.kind === "loading"}
        >
          {state.kind === "loading" ? (
            <>
              <Loader2 size={14} className="spin" aria-hidden="true" />
              正在整理…
            </>
          ) : (
            <>
              <Sparkles size={14} aria-hidden="true" />
              AI 整理当前已加载笔记
            </>
          )}
        </button>
        {state.kind === "ready" ? (
          <>
            <button
              type="button"
              className="weread-ai-summary__secondary"
              onClick={handleCopy}
              data-testid="weread-ai-summary-copy"
            >
              {copyState === "copied" ? (
                <>
                  <Check size={14} aria-hidden="true" />
                  已复制
                </>
              ) : (
                <>
                  <Copy size={14} aria-hidden="true" />
                  复制摘要
                </>
              )}
            </button>
            <button
              type="button"
              className="weread-ai-summary__secondary"
              onClick={handleClear}
              data-testid="weread-ai-summary-clear"
            >
              <Trash2 size={14} aria-hidden="true" />
              清除摘要
            </button>
          </>
        ) : null}
      </div>

      <p className="weread-ai-summary__meta" data-testid="weread-ai-summary-meta">
        当前已加载 {itemsCount} 条{truncated ? `（本次使用前 ${itemsUsedInCall} 条）` : ""}
        。不会发送搜索词、token、内部 ID 或书目信息。
      </p>

      {state.kind === "loading" ? (
        <div className="weread-ai-summary__loading" data-testid="weread-ai-summary-loading">
          <Loader2 size={14} className="spin" aria-hidden="true" />
          AI 正在整理最多 {itemsUsedInCall} 条笔记，请稍候…
        </div>
      ) : null}

      {state.kind === "error" ? (
        <div className="weread-ai-summary__error" data-testid="weread-ai-summary-error">
          <AlertCircle size={14} aria-hidden="true" />
          <span>{state.message}</span>
          <button
            type="button"
            className="weread-ai-summary__secondary weread-ai-summary__secondary--inline"
            onClick={handleClear}
          >
            <X size={12} aria-hidden="true" />
            关闭
          </button>
        </div>
      ) : null}

      {state.kind === "ready" ? (
        <div className="weread-ai-summary__body" data-testid="weread-ai-summary-body">
          <p className="weread-ai-summary__meta">{state.metaText}</p>

          <section className="weread-ai-summary__section" data-testid="weread-ai-summary-section-overview">
            <h4 className="weread-ai-summary__section-title">主题概览</h4>
            <p className="weread-ai-summary__text">{state.summary.overview}</p>
          </section>

          {state.summary.themes.length > 0 ? (
            <section className="weread-ai-summary__section" data-testid="weread-ai-summary-section-themes">
              <h4 className="weread-ai-summary__section-title">主要主题</h4>
              <div className="weread-ai-summary__themes">
                {state.summary.themes.map((t, i) => (
                  <article
                    key={`t-${i}`}
                    className="weread-ai-summary__theme-card"
                    data-testid="weread-ai-summary-theme"
                  >
                    <h5 className="weread-ai-summary__theme-title">{t.title}</h5>
                    <p className="weread-ai-summary__text">{t.summary}</p>
                    <span className="weread-ai-summary__theme-evidence">
                      基于 {t.evidenceCount} 条证据
                    </span>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {state.summary.keyPoints.length > 0 ? (
            <section className="weread-ai-summary__section" data-testid="weread-ai-summary-section-keypoints">
              <h4 className="weread-ai-summary__section-title">关键观点</h4>
              <ul className="weread-ai-summary__list">
                {state.summary.keyPoints.map((p, i) => (
                  <li key={`k-${i}`}>{p}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {state.summary.reviewQuestions.length > 0 ? (
            <section className="weread-ai-summary__section" data-testid="weread-ai-summary-section-questions">
              <h4 className="weread-ai-summary__section-title">待复习问题</h4>
              <ul className="weread-ai-summary__list">
                {state.summary.reviewQuestions.map((q, i) => (
                  <li key={`q-${i}`}>{q}</li>
                ))}
              </ul>
            </section>
          ) : null}

          {state.summary.readingDirections.length > 0 ? (
            <section className="weread-ai-summary__section" data-testid="weread-ai-summary-section-directions">
              <h4 className="weread-ai-summary__section-title">延伸阅读方向</h4>
              <ul className="weread-ai-summary__list">
                {state.summary.readingDirections.map((d, i) => (
                  <li key={`d-${i}`}>{d}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <p className="weread-ai-summary__disclaimer">
            AI 输出可能有遗漏，请人工复核。
          </p>

          {/* S27G: once a valid AI summary is ready, surface the
              "discover related books by topic" panel. The panel itself
              gates the request on a validated summary + at least one
              loaded note, so rendering it here is safe. */}
          <RelatedBooksDiscovery
            token={token}
            summary={state.summary}
            notes={items}
          />
        </div>
      ) : null}
    </section>
  );
}