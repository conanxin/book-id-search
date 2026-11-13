import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { isBookWebResearchAbort } from "./bookWebResearch";
import type { BookWebSourceEvidenceResponse, BookWebSourcePassage } from "./bookWebSourceEvidence";
import {
  assertBookWebSourceComparisonInput, assertBookWebSourceComparisonResponse,
  bookWebSourceComparisonContent, bookWebSourceComparisonErrorMessage, bookWebSourceComparisonUrl,
  findBookWebSourceComparison, type BookWebSourceComparisonResponse, type BookWebSourceComparisonSelection,
} from "./bookWebSourceComparison";
import { useBookWebSourceComparisonRegistry } from "./BookWebSourceComparisonScope";
import { useLibraryScope } from "./useLibraryScope";

interface AcceptedComparison {
  response: BookWebSourceComparisonResponse;
  selections: readonly BookWebSourceComparisonSelection[];
}
function sameSelections(a: readonly BookWebSourceComparisonSelection[], b: readonly BookWebSourceComparisonSelection[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

function ComparisonSource({
  value, selection, validate,
}: { value: BookWebSourceEvidenceResponse; selection: BookWebSourceComparisonSelection; validate: () => boolean }) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [highlight, setHighlight] = useState<BookWebSourcePassage | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const mark = useRef<HTMLElement>(null);
  const id = useId();
  useEffect(() => {
    if (contextOpen && highlight && root.current?.contains(document.activeElement)) {
      mark.current?.focus({ preventScroll: true });
      mark.current?.scrollIntoView?.({ block: "nearest" });
    }
  }, [contextOpen, highlight]);
  function locate(passage: BookWebSourcePassage) {
    if (!validate()) return;
    setHighlight({ ...passage }); setContextOpen(true);
  }
  return <section ref={root} className="book-ai-source book-web-comparison-source"
    aria-label={"对照来源 " + value.sourceId} data-comparison-source-id={value.sourceId} data-comparison-source-status={value.status}>
    <div className="book-ai-source-heading">
      <a href={value.finalUrl} target="_blank" rel="noopener noreferrer" aria-label={"打开对照网页 " + value.sourceId}>
        [{value.sourceId}] {value.title} <ExternalLink size={12} aria-hidden="true" />
      </a>
    </div>
    <p className="book-web-source-url">{value.finalUrl}</p>
    {value.finalUrl !== value.requestedUrl && <p className="library-meta">搜索时地址：{value.requestedUrl}</p>}
    <p className="library-meta">网页读取时间：<time dateTime={value.fetchedAt}>{value.fetchedAt}</time></p>
    {value.sourceTruncated && <p className="library-meta">本次网页提取已截短，片段只覆盖已读取的部分。</p>}
    {value.status === "insufficient_evidence" ? <p className="library-status" role="status">
      本次未选出足够相关的原文，可调整问题或查看该网页；这不代表整篇网页或其他资料没有答案。
    </p> : <ol className="book-web-evidence-passages">
      {value.passages.map(passage => <li key={passage.id} data-comparison-passage-id={passage.id}>
        <p className="book-web-excerpt-label">[{value.sourceId} / {passage.id}] 原文片段</p>
        <blockquote id={id + "-" + passage.id}
          className={"book-web-evidence-text" + (expanded.includes(passage.id) ? " is-expanded" : "")}>{passage.text}</blockquote>
        <div className="library-actions">
          <button type="button" className="library-text-button" aria-controls={id + "-" + passage.id}
            aria-expanded={expanded.includes(passage.id)}
            aria-label={(expanded.includes(passage.id) ? "收起" : "展开") + "对照片段 " + passage.id + " " + value.sourceId}
            onClick={() => setExpanded(items => items.includes(passage.id) ? items.filter(item => item !== passage.id) : [...items, passage.id])}>
            {expanded.includes(passage.id) ? "收起片段" : "展开片段"}
          </button>
          <button type="button" className="library-text-button"
            aria-label={"在对照正文中定位 " + passage.id + " " + value.sourceId} onClick={() => locate(passage)}>查看前后文</button>
        </div>
      </li>)}
    </ol>}
    {highlight && <div className="book-web-comparison-context">
      <button type="button" className="library-text-button" aria-expanded={contextOpen} aria-controls={id + "-body"}
        aria-label={(contextOpen ? "收起" : "展开") + "对照正文 " + value.sourceId}
        onClick={() => { if (validate()) setContextOpen(open => !open); }}>
        {contextOpen ? "收起该来源正文" : "展开该来源正文"}
      </button>
      <div id={id + "-body"} hidden={!contextOpen}>
        <p className="book-web-excerpt-label">本次读取的正文与上下文</p>
        <blockquote className="book-web-comparison-body">
          {selection.snapshot.text.slice(0, highlight.start)}<mark ref={mark} tabIndex={-1}
            data-comparison-highlight={highlight.id} aria-label={"对照原文片段 " + highlight.id + " " + value.sourceId}>{highlight.text}</mark>{selection.snapshot.text.slice(highlight.end)}
        </blockquote>
      </div>
    </div>}
  </section>;
}

/** A single explicit question over the user's chosen public snapshots, with no personal-content callbacks. */
export function BookWebSourceComparison({
  bookId, generation, initialQuestion,
}: { bookId: string; generation: number; initialQuestion: string }) {
  const { entries, contains } = useBookWebSourceComparisonRegistry();
  const { run, current } = useLibraryScope(generation);
  const [selected, setSelected] = useState<readonly BookWebSourceComparisonSelection[]>([]);
  const [question, setQuestion] = useState(initialQuestion);
  const [accepted, setAccepted] = useState<AcceptedComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  const selectionRef = useRef(selected);
  selectionRef.current = selected;
  const root = useRef<HTMLElement>(null);
  const heading = useRef<HTMLParagraphElement>(null);
  const copyField = useRef<HTMLTextAreaElement>(null);
  const questionId = useId();
  const validSelection = selected.filter(contains);
  const validAccepted = accepted && sameSelections(accepted.selections, selected)
    && accepted.response.question === question.trim() && accepted.selections.every(contains) ? accepted : null;
  const characters = validSelection.reduce((sum, item) => sum + item.snapshot.text.length, 0);

  const clear = useCallback(() => {
    sequence.current += 1; active.current?.abort(); active.current = null;
    setLoading(false); setAccepted(null); setError(null); setCopying(false); setCopyFallback(null); setMessage("");
  }, []);
  useEffect(() => () => { sequence.current += 1; active.current?.abort(); }, []);
  useEffect(() => {
    if (selected.some(entry => !contains(entry))) {
      clear(); setSelected(items => items.filter(contains));
      setMessage("已移除正在重读或已清除的来源，请在读取后重新选择。");
    }
  }, [entries, selected, contains, clear]);
  useEffect(() => {
    if (accepted && root.current?.contains(document.activeElement)) heading.current?.focus({ preventScroll: true });
  }, [accepted]);
  useEffect(() => {
    if (copyFallback && root.current?.contains(document.activeElement)) {
      copyField.current?.focus(); copyField.current?.select();
    }
  }, [copyFallback]);

  function unavailableReason(entry: BookWebSourceComparisonSelection): string | null {
    if (validSelection.includes(entry)) return null;
    if (validSelection.some(item => item.source.id === entry.source.id
      || item.snapshot.snapshotToken === entry.snapshot.snapshotToken
      || bookWebSourceComparisonUrl(item.snapshot.finalUrl) === bookWebSourceComparisonUrl(entry.snapshot.finalUrl))) {
      return "与已选来源为同一网页，请选择其他来源。";
    }
    return validSelection.length >= 3 ? "最多选择三篇网页。" : null;
  }
  function toggle(entry: BookWebSourceComparisonSelection) {
    if (!current() || !contains(entry) || unavailableReason(entry)) return;
    clear();
    setSelected(items => items.includes(entry) ? items.filter(item => item !== entry) : [...items.filter(contains), entry]);
  }
  function stillSelected(selections: readonly BookWebSourceComparisonSelection[]): boolean {
    return current() && sameSelections(selections, selectionRef.current) && selections.every(contains);
  }
  async function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (active.current || !current()) return;
    const asked = question.trim(), selections = [...selected];
    try { assertBookWebSourceComparisonInput(bookId, selections, asked); }
    catch (e) { setError(bookWebSourceComparisonErrorMessage(e)); return; }
    if (!stillSelected(selections)) return;
    clear();
    const request = ++sequence.current, controller = new AbortController();
    active.current = controller; setLoading(true);
    try {
      const value = await run(signal => {
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        return findBookWebSourceComparison(bookId, selections, asked, controller.signal)
          .finally(() => signal.removeEventListener("abort", abort));
      });
      if (request !== sequence.current || controller.signal.aborted || !stillSelected(selections)) return;
      assertBookWebSourceComparisonResponse(value, bookId, selections, asked);
      setAccepted({ response: value, selections });
    } catch (e) {
      if (request === sequence.current && stillSelected(selections) && !controller.signal.aborted && !isBookWebResearchAbort(e)) {
        setError(bookWebSourceComparisonErrorMessage(e));
      }
    } finally {
      if (request === sequence.current && current()) { active.current = null; setLoading(false); }
    }
  }
  function validate(): boolean {
    if (!validAccepted || !stillSelected(validAccepted.selections)) return false;
    try {
      assertBookWebSourceComparisonResponse(validAccepted.response, bookId, validAccepted.selections, question.trim());
      return true;
    } catch (e) { setError(bookWebSourceComparisonErrorMessage(e)); return false; }
  }
  async function copy() {
    if (!validAccepted || copying || !validate()) return;
    const { response, selections } = validAccepted;
    const content = bookWebSourceComparisonContent(response, bookId, selections), request = sequence.current;
    const isCurrent = () => request === sequence.current && stillSelected(selections);
    setCopying(true); setCopyFallback(null); setMessage("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(content);
      if (isCurrent()) setMessage("已复制同一问题、分源原文与出处。");
    } catch {
      if (isCurrent()) { setCopyFallback(content); setMessage("无法自动复制，请在下方选择文字并手动复制。"); }
    } finally { if (isCurrent()) setCopying(false); }
  }

  return <section ref={root} className="book-web-source-comparison" aria-label="多来源原文对照" aria-busy={loading}>
    <h4>多来源原文对照</h4>
    <p className="library-meta">选择 2–3 篇已读网页，用同一个问题查看各自的原句。只在点击查找后运行，不自动判定共同结论。</p>
    {entries.length === 0 ? <p className="library-status">当前没有可用于对照的已读网页。先读取至少两篇网页正文，再选择要对照的来源。</p>
      : <fieldset className="book-web-comparison-picker">
        <legend>选择已读网页</legend>
        {entries.map(entry => {
          const reason = unavailableReason(entry);
          return <label key={entry.source.id} className="book-web-comparison-option">
            <input type="checkbox" aria-label={"选择来源 " + entry.source.id}
              checked={validSelection.includes(entry)} disabled={Boolean(reason)} onChange={() => toggle(entry)} />
            <span><strong>[{entry.source.id}] {entry.snapshot.title}</strong>
              <span className="book-web-source-url">{entry.snapshot.finalUrl}</span>
              <span className="library-meta">读取时间：{entry.snapshot.fetchedAt}{entry.snapshot.truncated ? " · 已截短" : ""}</span>
              {reason && <span className="library-meta">{reason}</span>}
            </span>
          </label>;
        })}
      </fieldset>}
    <p className="library-meta">已选择 {validSelection.length} / 3 篇，按勾选顺序展示。{validSelection.length === 1 ? "还需选择一篇不同来源。" : ""}</p>
    <form onSubmit={event => void find(event)}>
      <label className="library-field" htmlFor={questionId}><span>多来源对照问题</span>
        <textarea id={questionId} rows={3} maxLength={1000} value={question}
          onChange={event => { clear(); setQuestion(event.currentTarget.value); }} />
      </label>
      {characters > 60000 && <p className="library-error" role="alert">所选网页文字合计超过 60,000 字符，请减少来源后再试。</p>}
      <div className="library-actions">
        <button type="submit" className="library-button" aria-label="查找多来源原文依据"
          disabled={loading || validSelection.length < 2 || validSelection.length > 3 || characters > 60000
            || !question.trim() || question.trim().length > 1000}>
          {loading ? "正在查找多来源原文依据…" : "查找多来源原文依据"}
        </button>
        {loading && <button type="button" className="library-text-button" aria-label="取消多来源原文查找" onClick={clear}>取消查找</button>}
        {!loading && (validAccepted || error) && <button type="button" className="library-text-button"
          aria-label="清除多来源原文依据" onClick={clear}>清除对照结果</button>}
      </div>
    </form>
    {loading && <p className="library-status" role="status">正在分别查找所选网页中的相关原句。</p>}
    {error && <p className="library-error" role="alert">{error}</p>}
    {validAccepted && <section aria-label="多来源原文依据" className="book-web-comparison-result">
      <p ref={heading} tabIndex={-1} className="book-web-excerpt-label">所选网页各自的原文依据</p>
      <p className="library-meta">问题：{validAccepted.response.question}</p>
      <p className="library-meta">选段时间：<time dateTime={validAccepted.response.generatedAt}>{validAccepted.response.generatedAt}</time></p>
      <p className="library-meta">不同网页不等于相互独立的证据。以下片段逐字来自本次读取，编号用于定位网页文字，不是原书页码。</p>
      <div className="book-web-comparison-sources">
        {validAccepted.response.sources.map((source, index) => <ComparisonSource key={source.sourceId}
          value={source} selection={validAccepted.selections[index]} validate={validate} />)}
      </div>
      {validAccepted.response.sources.some(source => source.passages.length > 0) && <div className="library-actions">
        <button type="button" className="library-button" aria-label="复制多来源原文与出处" disabled={copying} onClick={() => void copy()}>
          <Copy size={16} aria-hidden="true" />复制分源原文与出处
        </button>
      </div>}
    </section>}
    {validAccepted && copyFallback !== null && <label className="library-field"><span>可复制的多来源原文依据</span>
      <textarea ref={copyField} rows={8} readOnly value={copyFallback} onFocus={event => event.currentTarget.select()} />
    </label>}
    <p className="library-status" role="status" aria-live="polite">{message}</p>
  </section>;
}
