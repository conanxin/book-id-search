import { useEffect, useId, useRef, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { isBookWebResearchAbort, type BookWebResearchSource } from "./bookWebResearch";
import {
  assertBookWebSourceReadResponse, bookWebSourceContent, bookWebSourceReadErrorMessage, readBookWebSource,
  type BookWebSourceReadResponse,
} from "./bookWebSourceReader";
import { useLibraryScope } from "./useLibraryScope";

interface Props { bookId: string; generation: number; source: BookWebResearchSource }

/** Each source belongs to one search result; older responses without a read token remain excerpt-only. */
export function BookWebSourceReader(props: Props) {
  if (!props.source.readToken) return null;
  return <SourceReader key={JSON.stringify([props.bookId, props.generation, props.source.id, props.source.url, props.source.readToken])} {...props} />;
}

function SourceReader({ bookId, generation, source }: Props) {
  const { run, current } = useLibraryScope(generation);
  const [response, setResponse] = useState<BookWebSourceReadResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const bodyId = useId();
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

  function cancel() {
    sequence.current += 1; active.current?.abort(); active.current = null; setLoading(false);
  }
  async function read() {
    if (active.current || !current()) return;
    setError(null); setResponse(null); setLoading(true); setExpanded(false);
    setCopying(false); setCopyFallback(null); setMessage("");
    const request = ++sequence.current, controller = new AbortController();
    active.current = controller;
    try {
      const value = await run(signal => {
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        return readBookWebSource(bookId, source, controller.signal)
          .finally(() => signal.removeEventListener("abort", abort));
      });
      if (request !== sequence.current || controller.signal.aborted || !current()) return;
      assertBookWebSourceReadResponse(value, bookId, source);
      setResponse(value);
    } catch (e) {
      if (request === sequence.current && current() && !controller.signal.aborted && !isBookWebResearchAbort(e)) setError(bookWebSourceReadErrorMessage(e));
    } finally {
      if (request === sequence.current && current()) { active.current = null; setLoading(false); }
    }
  }
  async function copyText() {
    if (!response || copying || !current()) return;
    let content: string;
    try { content = bookWebSourceContent(response, source); }
    catch (e) { setError(bookWebSourceReadErrorMessage(e)); return; }
    const request = sequence.current;
    const stillCurrent = () => request === sequence.current && current();
    setCopying(true); setCopyFallback(null); setMessage("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(content);
      if (stillCurrent()) setMessage("已复制网页文字、来源与读取时间。");
    } catch {
      if (stillCurrent()) {
        setCopyFallback(content); setMessage("无法自动复制，请在下方选择文字并手动复制。");
      }
    } finally { if (stillCurrent()) setCopying(false); }
  }

  return <div ref={root} className="book-web-source-reader" data-web-reader-source-id={source.id} aria-busy={loading}>
    {!response && <>
      <p className="library-meta">{error ? "未提取网页文字，搜索节选仍保留。" : "当前仅有搜索节选，可按需读取公开网页文字。"}</p>
      <div className="library-actions">
        <button type="button" className="library-button library-button--quiet" disabled={loading}
          aria-label={`读取网页正文 ${source.id}`} onClick={() => void read()}>
          {loading ? "正在读取网页…" : error ? "重试读取网页正文" : "读取网页正文"}
        </button>
        {loading && <button type="button" className="library-text-button" aria-label={`取消读取网页 ${source.id}`} onClick={cancel}>取消读取</button>}
      </div>
    </>}
    {loading && <p className="library-status" role="status">正在提取这个网页的可读文字。</p>}
    {error && <p className="library-error" role="alert">{error}</p>}
    {response && <section aria-label={`网页可读文字 ${source.id}`}>
      <div className="book-ai-source-heading">
        <p ref={resultHeading} tabIndex={-1} className="book-web-excerpt-label">网页可读文字（自动提取）</p>
        <span className="library-tag">已提取网页文字</span>
      </div>
      <p className="library-meta">{response.title}</p>
      <a className="library-text-button" href={response.finalUrl} target="_blank" rel="noopener noreferrer"
        aria-label={`查看已读取网页 ${source.id}`}>查看网页 <ExternalLink size={12} aria-hidden="true" /></a>
      <p className="book-web-source-url">{response.finalUrl}</p>
      {response.finalUrl !== response.requestedUrl && <p className="library-meta">此链接已跳转；搜索时的原链接仍保留在上方。</p>}
      <p className="library-meta">读取时间：<time dateTime={response.fetchedAt}>{response.fetchedAt}</time></p>
      <p className="library-meta">自动提取的网页文字可能不完整，不代表已读取原书。</p>
      {response.truncated && <p className="library-meta">本次提取已截短，可打开网页查看余下内容。</p>}
      <blockquote id={bodyId} className={expanded ? "book-web-readable-text is-expanded" : "book-web-readable-text"}>{response.text}</blockquote>
      <button type="button" className="library-text-button book-web-excerpt-toggle" aria-expanded={expanded} aria-controls={bodyId}
        aria-label={`${expanded ? "收起" : "展开"}网页文字 ${source.id}`} onClick={() => setExpanded(value => !value)}>
        {expanded ? "收起网页文字" : "展开已提取文字"}
      </button>
      <div className="library-actions">
        <button type="button" className="library-button" disabled={copying} aria-label={`复制网页文字与来源 ${source.id}`} onClick={() => void copyText()}>
          <Copy size={16} aria-hidden="true" />复制文字与来源
        </button>
      </div>
    </section>}
    {copyFallback !== null && <label className="library-field"><span>可复制的网页文字 {source.id}</span>
      <textarea ref={copyField} rows={8} value={copyFallback} readOnly onFocus={event => event.currentTarget.select()} />
    </label>}
    <p className="library-status" role="status" aria-live="polite">{message}</p>
  </div>;
}
