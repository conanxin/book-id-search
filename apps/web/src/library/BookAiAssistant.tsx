import { useEffect, useRef, useState, type FormEvent } from "react";
import { Sparkles } from "lucide-react";
import { getWebAuthAuthGeneration } from "../auth/session";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import {
  createBookNote, isLibraryAbort, LibraryApiError, libraryErrorMessage, saveBookWorkspace,
  type BookWorkspaceData,
} from "./api";
import {
  bookAiDraftContent, bookAiErrorMessage, generateBookAi, isBookAiAbort,
  type BookAiAction, type BookAiResponse,
} from "./bookAi";
import { useLibraryScope } from "./useLibraryScope";
import { BookProse } from "./BookProse";
import "./library.css";
import "./book-ai.css";

interface BookAiAssistantProps {
  bookId: string;
  busy: boolean;
  operate: (request: (signal: AbortSignal) => Promise<BookWorkspaceData>) => Promise<BookWorkspaceData>;
  reload: () => Promise<BookWorkspaceData>;
}

const MODES: { action: BookAiAction; label: string; description: string; generate: string }[] = [
  { action: "introduction", label: "介绍草稿", description: "整理简介与阅读线索", generate: "生成介绍草稿" },
  { action: "notes_summary", label: "笔记摘要", description: "提炼主题与阅读问题", generate: "生成笔记摘要" },
  { action: "question", label: "资料问答", description: "带着问题回看本书资料", generate: "根据资料回答" },
];
const SOURCE_LABELS = { catalog: "书目信息", introduction: "补充介绍", note: "我的笔记", weread: "微信读书" };

/** The wrapper removes requests, results and drafts on book or Google-session changes. */
export function BookAiAssistant(props: BookAiAssistantProps) {
  const session = useWebAuthSession();
  if (session.status !== "authenticated") return null;
  const generation = getWebAuthAuthGeneration();
  return <BookAiPanel key={JSON.stringify([props.bookId, generation])} {...props} generation={generation} />;
}

function BookAiPanel(props: BookAiAssistantProps & { generation: number }) {
  const [action, setAction] = useState<BookAiAction>("introduction");
  return <section className="library-panel book-ai-panel" aria-labelledby="book-ai-heading">
    <div className="library-section-heading">
      <div><span className="library-eyebrow">从资料继续阅读</span><div className="book-ai-title"><Sparkles size={19} aria-hidden="true" /><h2 id="book-ai-heading">本书 AI 助手</h2></div></div>
    </div>
    <p className="library-muted">把这本书已有的介绍与阅读记录整理成草稿。核对来源、修改文字后，再保存到本书。</p>
    <div className="book-ai-modes" role="group" aria-label="AI 整理方式">
      {MODES.map(mode => <button key={mode.action} type="button" className="book-ai-mode" aria-label={mode.label}
        aria-pressed={action === mode.action} disabled={props.busy} onClick={() => setAction(mode.action)}>
        <strong>{mode.label}</strong><span>{mode.description}</span>
      </button>)}
    </div>
    <div className="book-ai-limits" aria-label="使用资料范围">
      使用本书的书目信息、已保存的补充介绍、我的笔记，以及已关联的微信读书记录。生成后可以查看本次实际使用的资料和节选。
      <br />尚未保存的编辑内容与电子版外链全文不在本次资料中。
    </div>
    <BookAiTask key={action} {...props} action={action} />
  </section>;
}

function BookAiTask({ bookId, action, generation, busy, operate, reload }: BookAiAssistantProps & { action: BookAiAction; generation: number }) {
  const { run, current } = useLibraryScope(generation);
  const [question, setQuestion] = useState("");
  const [response, setResponse] = useState<BookAiResponse | null>(null);
  const [draft, setDraft] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [baseVersion, setBaseVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [activeSource, setActiveSource] = useState<string | null>(null);
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  const saving = useRef(false);
  const resultHeading = useRef<HTMLHeadingElement | null>(null);
  const sourceElements = useRef<Record<string, HTMLLIElement | null>>({});
  const mode = MODES.find(value => value.action === action)!;

  useEffect(() => () => { sequence.current += 1; active.current?.abort(); }, []);
  useEffect(() => { if (response) resultHeading.current?.focus(); }, [response]);
  useEffect(() => {
    if (sourcesOpen && activeSource) sourceElements.current[activeSource]?.focus();
  }, [sourcesOpen, activeSource]);

  function clearResult() {
    setResponse(null); setDraft(""); setPreviewOpen(false); setTitle(""); setSaved(false); setSaveError(null);
    setMessage(""); setConflict(false); setLatest(null); setSourcesOpen(false); setActiveSource(null);
  }
  function cancel() {
    sequence.current += 1; active.current?.abort(); active.current = null; setLoading(false);
  }
  function changeQuestion(value: string) {
    cancel(); clearResult(); setError(null); setQuestion(value);
  }
  async function generate(event: FormEvent) {
    event.preventDefault();
    if (active.current || busy) return;
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
      const content = value.source === "ai" ? bookAiDraftContent(value) : "";
      setResponse(value); setDraft(content); setTitle(value.draft.title);
      setBaseVersion(value.context.workspaceVersion);
    } catch (e) {
      if (request === sequence.current && current() && !controller.signal.aborted && !isBookAiAbort(e)) setError(bookAiErrorMessage(e));
    } finally {
      if (request === sequence.current && current()) { active.current = null; setLoading(false); }
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!response || response.source !== "ai" || saved || saving.current || busy || conflict) return;
    if (!draft.trim() || draft.length > 50000 || (action !== "introduction" && (!title.trim() || title.length > 200))) {
      setSaveError("请检查草稿正文和笔记标题后再保存。"); return;
    }
    saving.current = true; setSaveError(null); setMessage("");
    try {
      await operate(signal => action === "introduction"
        ? saveBookWorkspace(bookId, { introduction: draft, baseVersion }, signal)
        : createBookNote(bookId, { title, content: draft }, signal));
      if (!current()) return;
      setSaved(true); setLatest(null);
      setMessage(action === "introduction" ? "AI 草稿已保存为书籍介绍。" : "AI 草稿已保存为新笔记。");
    } catch (e) {
      if (!current() || isLibraryAbort(e)) return;
      setSaveError(libraryErrorMessage(e));
      setConflict(action === "introduction" && e instanceof LibraryApiError && e.status === 409);
    } finally { saving.current = false; }
  }
  async function readLatest() {
    if (busy || saving.current) return;
    saving.current = true;
    try {
      const next = await reload();
      if (!current()) return;
      setBaseVersion(next.version); setLatest(next.introduction); setConflict(false); setSaveError(null);
      setMessage("已读取最新介绍。请对照保留的 AI 草稿，确认后再保存。");
    } catch (e) { if (current() && !isLibraryAbort(e)) setSaveError(libraryErrorMessage(e)); }
    finally { saving.current = false; }
  }
  function showSource(id: string) {
    setSourcesOpen(true); setActiveSource(id);
    if (sourcesOpen) sourceElements.current[id]?.focus();
  }

  return <div className="book-ai-task" aria-busy={loading || busy}>
    <form aria-label={mode.generate} onSubmit={event => void generate(event)}>
      {action === "question" && <label className="library-field" htmlFor="book-ai-question"><span id="book-ai-question-label">想问这本书的问题</span>
        <textarea id="book-ai-question" aria-labelledby="book-ai-question-label" rows={3} value={question} required maxLength={1000} disabled={busy}
          onChange={event => changeQuestion(event.target.value)} placeholder="例如：我的笔记提到了哪些古道地点？还有什么线索值得继续查？" />
      </label>}
      <div className="library-actions">
        <button type="submit" className="library-button library-button--primary" disabled={loading || busy}>{loading ? "正在整理本书资料…" : mode.generate}</button>
        {loading && <button type="button" className="library-button library-button--quiet" onClick={cancel}>取消生成</button>}
      </div>
      <p className="library-field-hint">每次生成会重新读取本书资料；草稿只在当前页面保留，保存后才加入本书。</p>
    </form>
    {loading && <p className="library-status" role="status">正在根据已保存的资料生成，请稍候。</p>}
    {error && <p className="library-error" role="alert">{error}</p>}
    {response && <div className="book-ai-result">
      <div className="book-ai-result-heading">
        <h3 ref={resultHeading} tabIndex={-1}>{response.source === "ai" ? "核对并保存草稿" : "本书资料暂不足以完成这次整理"}</h3>
        <span className="library-tag">{response.source === "ai" ? saved ? "已保存" : "待你核对" : "资料不足"}</span>
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
        {response.citedSourceIds.length > 0 && <div className="book-ai-citations" aria-label="草稿引用的来源">
          {response.citedSourceIds.map(id => <button key={id} type="button" className="library-text-button" onClick={() => showSource(id)}>查看依据 {id}</button>)}
        </div>}
        <form aria-label="保存 AI 草稿" onSubmit={event => void save(event)}>
          <fieldset className="library-fieldset" disabled={busy || saved}>
            {action !== "introduction" && <label className="library-field" htmlFor="book-ai-note-title"><span id="book-ai-note-title-label">AI 笔记标题</span>
              <input id="book-ai-note-title" aria-labelledby="book-ai-note-title-label" value={title} required maxLength={200} onChange={event => setTitle(event.target.value)} />
            </label>}
            <label className="library-field" htmlFor="book-ai-draft"><span id="book-ai-draft-label">AI 草稿正文</span>
              <textarea id="book-ai-draft" aria-labelledby="book-ai-draft-label" rows={12} value={draft} required maxLength={50000} onChange={event => setDraft(event.target.value)} />
            </label>
            <p className="library-field-hint">支持 Markdown 标题、列表、引用和链接。下方按钮会保存编辑框中的文字，引用与摘录可一起核对和编辑。</p>
            <details className="library-comparison" open={previewOpen} onToggle={event => setPreviewOpen(event.currentTarget.open)}>
              <summary>预览草稿</summary>{previewOpen && <BookProse content={draft} />}
            </details>
            {latest !== null && <details className="library-comparison" open><summary>刚读取的最新书籍介绍</summary><BookProse content={latest || "尚无介绍。"} /></details>}
            <div className="library-actions">
              <button type="submit" className="library-button library-button--primary" disabled={conflict}>{busy ? "正在保存…" : action === "introduction" ? "保存为书籍介绍" : "保存为新笔记"}</button>
              {conflict && <button type="button" className="library-button" onClick={() => void readLatest()}>读取最新书籍介绍</button>}
            </div>
          </fieldset>
        </form>
        <details className="book-ai-original"><summary>查看 AI 原稿</summary><BookProse content={response.draft.content} /></details>
      </>}
      {saveError && <p className="library-error" role="alert">{saveError}</p>}
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
