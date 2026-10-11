import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Copy, ExternalLink, Globe } from "lucide-react";
import { BookProse } from "./BookProse";
import { useLibraryScope } from "./useLibraryScope";
import {
  bookWebResearchContent, bookWebResearchErrorMessage, generateBookWebResearch, isBookWebResearchAbort,
  type BookWebResearchResponse,
} from "./bookWebResearch";

const EXAMPLES = [
  { label: "内容与背景", question: "查找这本书的内容介绍、作者背景与出版信息，并说明资料出处。" },
  { label: "相关研究", question: "查找与这本书主题有关的研究文章和书评，区分已有依据与待查线索。" },
  { label: "延伸阅读", question: "查找适合与这本书对照阅读的图书，说明关联及推荐依据。" },
];

/** A read-only research task, unmounted when its book, session or sidebar scope changes. */
export function BookWebResearch({ bookId, generation }: { bookId: string; generation: number }) {
  const { run, current } = useLibraryScope(generation);
  const [question, setQuestion] = useState("");
  const [response, setResponse] = useState<BookWebResearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const questionId = useId();
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  const taskRoot = useRef<HTMLDivElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const copyField = useRef<HTMLTextAreaElement>(null);
  const questionField = useRef<HTMLTextAreaElement>(null);
  const sourceElements = useRef<Record<string, HTMLLIElement | null>>({});

  useEffect(() => () => { sequence.current += 1; active.current?.abort(); }, []);
  useEffect(() => {
    if (response && taskRoot.current?.contains(document.activeElement)) resultHeading.current?.focus({ preventScroll: true });
  }, [response]);
  useEffect(() => {
    if (copyFallback && taskRoot.current?.contains(document.activeElement)) {
      copyField.current?.focus(); copyField.current?.select();
    }
  }, [copyFallback]);
  useEffect(() => {
    if (sourcesOpen && activeSource) sourceElements.current[activeSource]?.focus();
  }, [sourcesOpen, activeSource]);

  function clearResult() {
    setResponse(null); setCopying(false); setCopyFallback(null); setMessage("");
    setSourcesOpen(false); setActiveSource(null);
  }
  function cancel() {
    sequence.current += 1; active.current?.abort(); active.current = null; setLoading(false);
  }
  function clear() { cancel(); clearResult(); setError(null); }
  function changeQuestion(value: string) { clear(); setQuestion(value); }
  async function research(event: FormEvent) {
    event.preventDefault();
    if (active.current) return;
    const asked = question.trim();
    if (!asked || asked.length > 1000) { setError("请填写想研究的问题，最多 1,000 字符。"); return; }
    clearResult(); setError(null); setLoading(true);
    const request = ++sequence.current, controller = new AbortController();
    active.current = controller;
    try {
      const value = await run(signal => {
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        return generateBookWebResearch(bookId, { question: asked }, controller.signal)
          .finally(() => signal.removeEventListener("abort", abort));
      });
      if (request !== sequence.current || controller.signal.aborted || !current()) return;
      if (value.source === "web_research") bookWebResearchContent(value);
      setResponse(value);
    } catch (e) {
      if (request === sequence.current && current() && !controller.signal.aborted && !isBookWebResearchAbort(e)) setError(bookWebResearchErrorMessage(e));
    } finally {
      if (request === sequence.current && current()) { active.current = null; setLoading(false); }
    }
  }
  async function copyResult() {
    if (!response || response.source !== "web_research" || copying || !current()) return;
    let content: string;
    try { content = bookWebResearchContent(response); }
    catch (e) { setError(bookWebResearchErrorMessage(e)); return; }
    const request = sequence.current;
    const stillCurrent = () => request === sequence.current && current();
    setCopying(true); setCopyFallback(null); setMessage("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(content);
      if (stillCurrent()) setMessage("已复制研究结果与网页来源。");
    } catch {
      if (stillCurrent()) {
        setCopyFallback(content); setMessage("无法自动复制，请在下方选择文字并手动复制。");
      }
    } finally { if (stillCurrent()) setCopying(false); }
  }
  function showSource(id: string) {
    setSourcesOpen(true); setActiveSource(id);
    if (sourcesOpen) sourceElements.current[id]?.focus();
  }

  return <div ref={taskRoot} className="book-ai-task book-web-research" aria-busy={loading}>
    <p className="book-ai-mode-description">围绕这本书查找网上资料，核对出处，发现新的阅读线索。</p>
    <details className="book-ai-scope">
      <summary>联网研究会使用哪些资料？</summary>
      <div className="book-ai-limits" aria-label="联网研究资料范围">
        使用公开的书目信息和你输入的问题搜索网页，根据搜索结果节选整理回答。不会读取你的补充介绍、笔记或微信读书记录。
        <br />搜索节选不等于网页全文，也不代表已读过电子书。
      </div>
    </details>
    <form aria-label="联网查资料" onSubmit={event => void research(event)}>
      <label className="library-field" htmlFor={questionId}><span>联网研究问题</span>
        <textarea ref={questionField} id={questionId} rows={4} value={question} required maxLength={1000}
          onChange={event => changeQuestion(event.target.value)} placeholder="例如：这本书有哪些相关研究？哪些图书适合对照阅读？" />
      </label>
      <div className="book-web-examples" role="group" aria-label="研究问题示例">
        {EXAMPLES.map(example => <button key={example.label} type="button" className="library-text-button"
          onClick={() => { changeQuestion(example.question); questionField.current?.focus(); }}>{example.label}</button>)}
      </div>
      <div className="library-actions">
        <button type="submit" className="library-button library-button--primary" disabled={loading}>
          <Globe size={16} aria-hidden="true" />{loading ? "正在搜索与整理…" : "联网查资料"}
        </button>
        {loading && <button type="button" className="library-button library-button--quiet" onClick={cancel}>取消研究</button>}
      </div>
      <p className="library-field-hint">每次围绕当前问题重新搜索。结果仅在当前页面保留。</p>
    </form>
    {loading && <p className="library-status" role="status">正在查找网页并整理依据，请稍候。</p>}
    {error && <p className="library-error" role="alert">{error}</p>}
    {response && <div className="book-ai-result">
      <div className="book-ai-result-heading">
        <h3 ref={resultHeading} tabIndex={-1}>{response.source === "web_research" ? response.draft.title : "本次搜索资料不足"}</h3>
        <span className="library-tag">{response.source === "web_research" ? "请核对网页来源" : "资料不足"}</span>
      </div>
      <p className="book-ai-question-note">本次问题：{response.question}</p>
      <details className="book-ai-sources book-web-queries">
        <summary>本次实际搜索词（{response.search.queries.length}）</summary>
        <ul aria-label="本次实际搜索词">{response.search.queries.map((query, index) => <li key={`${index}:${query}`}>{query}</li>)}</ul>
      </details>
      {response.source === "insufficient_sources" ? <div className="library-empty">{response.draft.content}</div> : <>
        <div role="region" aria-label="联网研究结果"><BookProse content={response.draft.content} /></div>
        <div className="book-ai-citations" aria-label="研究结果引用的网页">
          {response.citedSourceIds.map(id => <button key={id} type="button" className="library-text-button" onClick={() => showSource(id)}>查看网页依据 {id}</button>)}
        </div>
      </>}
      <div className="library-actions">
        {response.source === "web_research" && <button type="button" className="library-button" disabled={copying} onClick={() => void copyResult()}>
          <Copy size={16} aria-hidden="true" />复制结果与来源
        </button>}
        <button type="button" className="library-button library-button--quiet" onClick={clear}>清除结果</button>
      </div>
      {copyFallback !== null && <label className="library-field"><span>可复制的研究结果</span>
        <textarea ref={copyField} rows={8} value={copyFallback} readOnly onFocus={event => event.currentTarget.select()} />
      </label>}
      <p className="library-status" role="status" aria-live="polite">{message}</p>
      {response.sources.length > 0 && <details className="book-ai-sources" open={sourcesOpen} onToggle={event => setSourcesOpen(event.currentTarget.open)}>
        <summary>查看本次网页来源（{response.sources.length}）</summary>
        <ol className="book-ai-source-list">
          {response.sources.map(source => <li key={source.id} className="book-ai-source" data-web-source-id={source.id}
            tabIndex={-1} ref={element => { sourceElements.current[source.id] = element; }}>
            <div className="book-ai-source-heading">
              <a href={source.url} target="_blank" rel="noopener noreferrer">[{source.id}] {source.title} <ExternalLink size={12} aria-hidden="true" /></a>
              {response.citedSourceIds.includes(source.id) && <span className="library-tag">已引用</span>}
            </div>
            <p className="book-web-source-url">{source.url}</p>
            {source.pageAge && <p className="library-meta">页面时间：{source.pageAge}</p>}
            <p className="book-web-excerpt-label">搜索结果节选</p>
            <blockquote>{source.excerpt}</blockquote>
            {source.truncated && <p className="library-meta">本条搜索节选已截短，可打开网页进一步核对。</p>}
          </li>)}
        </ol>
      </details>}
    </div>}
  </div>;
}
