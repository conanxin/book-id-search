import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Copy, Sparkles, X } from "lucide-react";
import { getWebAuthAuthGeneration } from "../auth/session";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import {
  bookAiDraftContent, bookAiErrorMessage, generateBookAi, isBookAiAbort,
  type BookAiAction, type BookAiResponse,
} from "./bookAi";
import { useLibraryScope } from "./useLibraryScope";
import { BookProse } from "./BookProse";
import { BookWebResearch } from "./BookWebResearch";
import "./library.css";
import "./book-ai.css";

interface BookAiAssistantProps { bookId: string }

const MODES: { action: BookAiAction; label: string; description: string; generate: string }[] = [
  { action: "introduction", label: "参考介绍", description: "根据已有资料，整理这本书的介绍与阅读线索。", generate: "生成参考介绍" },
  { action: "notes_summary", label: "笔记摘要", description: "从已保存的笔记中，提炼主题与阅读问题。", generate: "生成笔记摘要" },
  { action: "question", label: "资料问答", description: "带着问题回看本书资料，并核对回答的依据。", generate: "根据资料回答" },
];
const SOURCE_LABELS = { catalog: "书目信息", introduction: "补充介绍", note: "我的笔记", weread: "微信读书" };

/** Requests and transient results belong to one book and one Google session. */
export function BookAiAssistant({ bookId }: BookAiAssistantProps) {
  const session = useWebAuthSession();
  if (session.status !== "authenticated") return null;
  const generation = getWebAuthAuthGeneration();
  return <BookAiPanel key={JSON.stringify([bookId, generation])} bookId={bookId} generation={generation} />;
}

function BookAiPanel(props: BookAiAssistantProps & { generation: number }) {
  const [scope, setScope] = useState<"book" | "web">("book");
  const [action, setAction] = useState<BookAiAction>("introduction");
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const mode = MODES.find(value => value.action === action)!;

  useEffect(() => { if (mobileOpen) heading.current?.focus({ preventScroll: true }); }, [mobileOpen]);

  return <>
    <button ref={toggle} type="button" className="library-button library-button--primary book-ai-toggle"
      aria-expanded={mobileOpen} aria-controls={sidebarId} onClick={() => setMobileOpen(value => !value)}>
      {mobileOpen ? <X size={18} aria-hidden="true" /> : <Sparkles size={18} aria-hidden="true" />}
      {mobileOpen ? "关闭 AI 助手" : "打开 AI 助手"}
    </button>
    <aside id={sidebarId} className={`library-panel book-ai-panel book-ai-sidebar${mobileOpen ? " is-open" : ""}`}
      aria-label="本书 AI 助手" onKeyDown={event => {
        if (event.key === "Escape" && mobileOpen) {
          event.preventDefault(); setMobileOpen(false); toggle.current?.focus();
        }
      }}>
      <div className="book-ai-title"><Sparkles size={19} aria-hidden="true" /><h2 ref={heading} tabIndex={-1}>本书 AI 助手</h2></div>
      <p className="library-muted">生成结果仅作阅读参考，可核对来源后复制使用。</p>
      <p className="book-ai-boundary">你的介绍和笔记由你编辑，AI 不会替你修改。</p>
      <div className="book-ai-scopes" role="group" aria-label="AI 资料范围">
        <button type="button" className="book-ai-mode" aria-pressed={scope === "book"} onClick={() => setScope("book")}><strong>本书资料</strong></button>
        <button type="button" className="book-ai-mode" aria-pressed={scope === "web"} onClick={() => setScope("web")}><strong>联网研究</strong></button>
      </div>
      {scope === "book" ? <>
      <div className="book-ai-modes" role="group" aria-label="AI 整理方式">
        {MODES.map(item => <button key={item.action} type="button" className="book-ai-mode" aria-label={item.label}
          aria-pressed={action === item.action} onClick={() => setAction(item.action)}><strong>{item.label}</strong></button>)}
      </div>
      <p className="book-ai-mode-description">{mode.description}</p>
      <details className="book-ai-scope">
        <summary>AI 会使用哪些资料？</summary>
        <div className="book-ai-limits" aria-label="使用资料范围">
          使用本书的书目信息、已保存的补充介绍、我的笔记，以及已关联的微信读书记录。生成后可以查看本次实际使用的资料和节选。
          <br />尚未保存的编辑内容与电子版外链全文不在本次资料中。
        </div>
      </details>
      <BookAiTask key={action} {...props} action={action} />
      </> : <BookWebResearch {...props} />}
    </aside>
  </>;
}

function BookAiTask({ bookId, action, generation }: BookAiAssistantProps & { action: BookAiAction; generation: number }) {
  const { run, current } = useLibraryScope(generation);
  const [question, setQuestion] = useState("");
  const [response, setResponse] = useState<BookAiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copying, setCopying] = useState(false);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  const taskRoot = useRef<HTMLDivElement>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const copyField = useRef<HTMLTextAreaElement>(null);
  const sourceElements = useRef<Record<string, HTMLLIElement | null>>({});
  const mode = MODES.find(value => value.action === action)!;

  useEffect(() => () => { sequence.current += 1; active.current?.abort(); }, []);
  useEffect(() => {
    if (response && taskRoot.current?.contains(document.activeElement)) resultHeading.current?.focus();
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
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (active.current) return;
    const asked = question.trim();
    if (action === "question" && (!asked || asked.length > 1000)) {
      setError("请填写想问这本书的问题，最多 1,000 字符。"); return;
    }
    clearResult(); setError(null); setLoading(true);
    const request = ++sequence.current;
    const controller = new AbortController();
    active.current = controller;
    try {
      const value = await run(signal => {
        const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true });
        return generateBookAi(bookId, action === "question" ? { action, question: asked } : { action }, controller.signal)
          .finally(() => signal.removeEventListener("abort", abort));
      });
      if (request !== sequence.current || controller.signal.aborted || !current()) return;
      // Check the cited snapshots before exposing the result or its copy action.
      if (value.source === "ai") bookAiDraftContent(value);
      setResponse(value);
    } catch (e) {
      if (request === sequence.current && current() && !controller.signal.aborted && !isBookAiAbort(e)) setError(bookAiErrorMessage(e));
    } finally {
      if (request === sequence.current && current()) { active.current = null; setLoading(false); }
    }
  }

  async function copyResult() {
    if (!response || response.source !== "ai" || copying || !current()) return;
    let content: string;
    try { content = bookAiDraftContent(response); }
    catch (e) { setError(bookAiErrorMessage(e)); return; }
    const request = sequence.current;
    const stillCurrent = () => request === sequence.current && current();
    setCopying(true); setCopyFallback(null); setMessage("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(content);
      if (stillCurrent()) setMessage("已复制 AI 结果与来源。");
    } catch {
      if (stillCurrent()) {
        setCopyFallback(content);
        setMessage("无法自动复制，请在下方选择文字并手动复制。");
      }
    } finally { if (stillCurrent()) setCopying(false); }
  }
  function showSource(id: string) {
    setSourcesOpen(true); setActiveSource(id);
    if (sourcesOpen) sourceElements.current[id]?.focus();
  }

  return <div ref={taskRoot} className="book-ai-task" aria-busy={loading}>
    <form aria-label={mode.generate} onSubmit={event => void generate(event)}>
      {action === "question" && <label className="library-field" htmlFor="book-ai-question"><span id="book-ai-question-label">想问这本书的问题</span>
        <textarea id="book-ai-question" aria-labelledby="book-ai-question-label" rows={3} value={question} required maxLength={1000}
          onChange={event => changeQuestion(event.target.value)} placeholder="例如：我的笔记提到了哪些古道地点？还有什么线索值得继续查？" />
      </label>}
      <div className="library-actions">
        <button type="submit" className="library-button library-button--primary" disabled={loading}>{loading ? "正在整理本书资料…" : mode.generate}</button>
        {loading && <button type="button" className="library-button library-button--quiet" onClick={cancel}>取消生成</button>}
      </div>
      <p className="library-field-hint">每次生成会重新读取已保存的资料。结果仅在当前页面保留。</p>
    </form>
    {loading && <p className="library-status" role="status">正在根据已保存的资料生成，请稍候。</p>}
    {error && <p className="library-error" role="alert">{error}</p>}
    {response && <div className="book-ai-result">
      <div className="book-ai-result-heading">
        <h3 ref={resultHeading} tabIndex={-1}>{response.source === "ai" ? "AI 参考结果" : "本书资料暂不足以完成这次整理"}</h3>
        <span className="library-tag">{response.source === "ai" ? "请核对来源" : "资料不足"}</span>
      </div>
      {response.question && <p className="book-ai-question-note">本次问题：{response.question}</p>}
      <div className="book-ai-context" aria-label="本次实际使用的资料">
        <ul className="book-ai-counts">
          <li>书目信息</li>
          <li>补充介绍 {response.context.introductionIncluded ? "已使用" : "未使用"}</li>
          <li>我的笔记 {response.context.notesIncluded} / {response.context.notesAvailable} 篇</li>
          <li>{response.context.wereadEnabled ? `微信读书 ${response.context.wereadIncluded} / ${response.context.wereadAvailable} 条` : "微信读书未启用"}</li>
        </ul>
        {response.context.truncated && <p className="book-ai-limits">本次使用了部分资料或节选。可以展开下方来源核对实际文字，再打开原记录继续阅读。</p>}
      </div>
      {response.source === "insufficient_context" ? <div className="library-empty">{response.draft.content}</div> : <>
        <div role="region" aria-label="AI 参考结果"><BookProse content={response.draft.content} /></div>
        {response.citedSourceIds.length > 0 && <div className="book-ai-citations" aria-label="结果引用的来源">
          {response.citedSourceIds.map(id => <button key={id} type="button" className="library-text-button" onClick={() => showSource(id)}>查看依据 {id}</button>)}
        </div>}
        <div className="library-actions">
          <button type="button" className="library-button" disabled={copying} onClick={() => void copyResult()}><Copy size={16} aria-hidden="true" />复制结果与来源</button>
          <button type="button" className="library-button library-button--quiet" onClick={clear}>清除结果</button>
        </div>
        {copyFallback !== null && <label className="library-field"><span>可复制的 AI 结果</span>
          <textarea ref={copyField} rows={8} value={copyFallback} readOnly onFocus={event => event.currentTarget.select()} />
        </label>}
      </>}
      <p className="library-status" role="status" aria-live="polite">{message}</p>
      {response.sources.length > 0 && <details className="book-ai-sources" open={sourcesOpen} onToggle={event => setSourcesOpen(event.currentTarget.open)}>
        <summary>查看本次资料来源（{response.sources.length}）</summary>
        <ol className="book-ai-source-list">
          {response.sources.map(source => <li key={source.id} className="book-ai-source" id={`book-ai-source-${source.id}`} data-ai-source-id={source.id}
            tabIndex={-1} ref={element => { sourceElements.current[source.id] = element; }}>
            <div className="book-ai-source-heading">
              <a href={source.href}>[{source.id}] {source.label}</a>
              <span className="library-tag">{SOURCE_LABELS[source.kind]}{response.citedSourceIds.includes(source.id) ? " · 已引用" : ""}</span>
            </div>
            <blockquote>{source.excerpt}</blockquote>
            {source.truncated && <p className="library-meta">本条为节选，可打开来源查看完整记录。</p>}
          </li>)}
        </ol>
      </details>}
    </div>}
  </div>;
}
