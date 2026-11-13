import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { isBookWebResearchAbort, type BookWebResearchSource } from "./bookWebResearch";
import type { BookWebSourceReadResponse } from "./bookWebSourceReader";
import {
  assertBookWebSourceEvidenceResponse, bookWebSourceEvidenceContent, bookWebSourceEvidenceErrorMessage,
  findBookWebSourceEvidence, type BookWebSourceEvidenceResponse, type BookWebSourcePassage,
} from "./bookWebSourceEvidence";
import { useLibraryScope } from "./useLibraryScope";

interface Props {
  snapshot: BookWebSourceReadResponse;
  source: BookWebResearchSource;
  generation: number;
  initialQuestion: string;
  onLocate: (passage: BookWebSourcePassage | null) => void;
}

/** Lives only inside one read snapshot; editing the question never changes personal book content. */
export function BookWebSourceEvidence({ snapshot, source, generation, initialQuestion, onLocate }: Props) {
  const { run, current } = useLibraryScope(generation);
  const [question, setQuestion] = useState(initialQuestion);
  const [response, setResponse] = useState<BookWebSourceEvidenceResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [expanded, setExpanded] = useState<string[]>([]);
  const questionId = useId();
  const passageId = useId();
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const resultHeading = useRef<HTMLParagraphElement>(null);
  const copyField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => { sequence.current += 1; active.current?.abort(); }, []);
  useEffect(() => {
    if (response && root.current?.contains(document.activeElement)) resultHeading.current?.focus({ preventScroll: true });
  }, [response]);
  useEffect(() => {
    if (copyFallback && root.current?.contains(document.activeElement)) {
      copyField.current?.focus(); copyField.current?.select();
    }
  }, [copyFallback]);

  function clear() {
    sequence.current += 1; active.current?.abort(); active.current = null;
    setLoading(false); setResponse(null); setError(null); setCopying(false);
    setCopyFallback(null); setMessage(""); setExpanded([]); onLocate(null);
  }
  async function find(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const asked = question.trim();
    if (active.current || !current() || !asked || asked.length > 1000) return;
    clear();
    const request = ++sequence.current, controller = new AbortController();
    active.current = controller; setLoading(true);
    try {
      const value = await run(signal => {
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        return findBookWebSourceEvidence(snapshot, source, asked, controller.signal)
          .finally(() => signal.removeEventListener("abort", abort));
      });
      if (request !== sequence.current || controller.signal.aborted || !current()) return;
      assertBookWebSourceEvidenceResponse(value, snapshot, source, asked);
      setResponse(value);
    } catch (e) {
      if (request === sequence.current && current() && !controller.signal.aborted && !isBookWebResearchAbort(e)) {
        setError(bookWebSourceEvidenceErrorMessage(e));
      }
    } finally {
      if (request === sequence.current && current()) { active.current = null; setLoading(false); }
    }
  }
  async function copy() {
    if (!response || copying || !current()) return;
    let content: string;
    try {
      assertBookWebSourceEvidenceResponse(response, snapshot, source, question.trim());
      content = bookWebSourceEvidenceContent(response, snapshot, source);
    } catch (e) { setError(bookWebSourceEvidenceErrorMessage(e)); return; }
    const request = sequence.current;
    const stillCurrent = () => request === sequence.current && current();
    setCopying(true); setCopyFallback(null); setMessage("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(content);
      if (stillCurrent()) setMessage("已复制原文片段、来源与读取时间。");
    } catch {
      if (stillCurrent()) {
        setCopyFallback(content); setMessage("无法自动复制，请在下方选择文字并手动复制。");
      }
    } finally { if (stillCurrent()) setCopying(false); }
  }
  function locate(passage: BookWebSourcePassage) {
    if (!response || !current()) return;
    try {
      assertBookWebSourceEvidenceResponse(response, snapshot, source, question.trim());
      onLocate(passage);
    } catch (e) { setError(bookWebSourceEvidenceErrorMessage(e)); }
  }

  if (!snapshot.snapshotToken) return <p className="library-meta book-web-evidence-legacy">
    本次读取尚不支持查找原文依据；可重新读取网页正文后再试。已读文字仍可查看和复制。
  </p>;

  return <div ref={root} className="book-web-source-evidence" aria-busy={loading}>
    <form className="book-web-evidence-form" onSubmit={event => void find(event)}>
      <p className="book-web-excerpt-label">从这篇网页找原文依据</p>
      <p className="library-meta">填写要核对的问题，AI 会从当前已读文字中挑选相关原句。只在点击查找后运行。</p>
      <label className="library-field" htmlFor={questionId}>
        <span>原文依据问题 {source.id}</span>
        <textarea id={questionId} rows={3} maxLength={1000} value={question}
          onChange={event => { clear(); setQuestion(event.currentTarget.value); }} />
      </label>
      <div className="library-actions">
        <button type="submit" className="library-button" disabled={loading || !question.trim() || question.trim().length > 1000}
          aria-label={"查找原文依据 " + source.id}>{loading ? "正在查找原文依据…" : "查找原文依据"}</button>
        {loading && <button type="button" className="library-text-button" aria-label={"取消查找原文依据 " + source.id}
          onClick={clear}>取消查找</button>}
        {!loading && (response || error) && <button type="button" className="library-text-button"
          aria-label={"清除原文依据 " + source.id} onClick={clear}>清除原文依据</button>}
      </div>
    </form>
    {loading && <p className="library-status" role="status">正在从已读网页中定位相关原句。</p>}
    {error && <p className="library-error" role="alert">{error}</p>}
    {response && <section aria-label={"原文依据 " + source.id} className="book-web-evidence-result">
      <p ref={resultHeading} tabIndex={-1} className="book-web-excerpt-label">AI 选中的原文片段</p>
      <p className="library-meta">问题：{response.question}</p>
      <a className="library-text-button" href={response.finalUrl} target="_blank" rel="noopener noreferrer"
        aria-label={"查看原文依据网页 " + source.id}>[{source.id}] {response.title} <ExternalLink size={12} aria-hidden="true" /></a>
      <p className="book-web-source-url">{response.finalUrl}</p>
      <p className="library-meta">网页读取时间：<time dateTime={response.fetchedAt}>{response.fetchedAt}</time></p>
      <p className="library-meta">选段时间：<time dateTime={response.generatedAt}>{response.generatedAt}</time></p>
      <p className="library-meta">以下文字逐字来自本次已读网页。片段编号用于定位网页文字，不是原书页码。</p>
      {response.sourceTruncated && <p className="library-meta">本次网页提取已截短，片段只覆盖已读取的部分。</p>}
      {response.status === "insufficient_evidence" ? <p className="library-status" role="status">
        未找到足够相关的原文。可修改问题，或查看已读网页文字与源网页。
      </p> : <ol className="book-web-evidence-passages">
        {response.passages.map(passage => <li key={passage.id} data-evidence-passage-id={passage.id}>
          <p className="book-web-excerpt-label">[{source.id} / {passage.id}] 原文片段</p>
          <blockquote id={passageId + "-" + passage.id}
            className={"book-web-evidence-text" + (expanded.includes(passage.id) ? " is-expanded" : "")}>{passage.text}</blockquote>
          <div className="library-actions">
            <button type="button" className="library-text-button" aria-controls={passageId + "-" + passage.id}
              aria-expanded={expanded.includes(passage.id)} aria-label={(expanded.includes(passage.id) ? "收起" : "展开") + "原文片段 " + passage.id + " " + source.id}
              onClick={() => setExpanded(values => values.includes(passage.id) ? values.filter(id => id !== passage.id) : [...values, passage.id])}>
              {expanded.includes(passage.id) ? "收起片段" : "展开片段"}
            </button>
            <button type="button" className="library-text-button" aria-label={"在网页正文中定位 " + passage.id + " " + source.id}
              onClick={() => locate(passage)}>在正文中查看前后文</button>
          </div>
        </li>)}
      </ol>}
      {response.passages.length > 0 && <div className="library-actions">
        <button type="button" className="library-button" disabled={copying} aria-label={"复制原文依据与来源 " + source.id} onClick={() => void copy()}>
          <Copy size={16} aria-hidden="true" />复制片段与出处
        </button>
      </div>}
    </section>}
    {copyFallback !== null && <label className="library-field"><span>可复制的原文依据 {source.id}</span>
      <textarea ref={copyField} rows={8} value={copyFallback} readOnly onFocus={event => event.currentTarget.select()} />
    </label>}
    <p className="library-status" role="status" aria-live="polite">{message}</p>
  </div>;
}
