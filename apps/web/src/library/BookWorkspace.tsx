import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { getWebAuthAuthGeneration } from "../auth/session";
import { useWebAuthSession } from "../auth/useWebAuthSession";
import {
  createBookNote, createBookResource, deleteBookNote, deleteBookResource,
  getBookNoteRevision, getBookWorkspace, isLibraryAbort, LibraryApiError,
  libraryErrorMessage, safeResourceUrl, saveBookWorkspace, updateBookNote, updateBookResource,
  type BookNote, type BookNoteRevision, type BookResource, type BookResourceInput, type BookWorkspaceData,
} from "./api";
import { useLibraryScope } from "./useLibraryScope";
import "./library.css";

type WorkspaceOperation = (request: (signal: AbortSignal) => Promise<BookWorkspaceData>) => Promise<BookWorkspaceData>;
interface PanelProps {
  bookId: string;
  item: BookWorkspaceData;
  busy: boolean;
  operate: WorkspaceOperation;
  reload: () => Promise<BookWorkspaceData>;
}

export function libraryDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }) : "";
}

function ErrorMessage({ message }: { message: string | null }) {
  return message ? <p className="library-error" role="alert">{message}</p> : null;
}

/** The wrapper removes private content synchronously on book or auth changes. */
export function BookWorkspace({ bookId }: { bookId: string }) {
  const session = useWebAuthSession();
  const generation = getWebAuthAuthGeneration();
  if (session.status !== "authenticated") return <section className="library-panel" aria-label="本书的个人内容">
    <p className="library-muted">{["idle", "loading", "signing_in"].includes(session.status)
      ? "正在读取登录状态…" : "请使用 Google 登录，查看和整理本书的介绍、笔记与电子版本。"}</p>
  </section>;
  return <BookWorkspaceContent key={JSON.stringify([bookId, generation])} bookId={bookId} generation={generation} />;
}

function BookWorkspaceContent({ bookId, generation }: { bookId: string; generation: number }) {
  const { run, current } = useLibraryScope(generation);
  const [item, setItem] = useState<BookWorkspaceData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const pending = useRef(false);

  const operate = useCallback<WorkspaceOperation>(async request => {
    if (pending.current) throw new LibraryApiError(409, "正在保存其他内容，请稍候。");
    pending.current = true;
    setBusy(true);
    try {
      const next = await run(request);
      if (next.bookId !== bookId) throw new LibraryApiError(502, "书籍内容返回异常，请重新读取后再试。");
      setItem(next);
      return next;
    } finally {
      pending.current = false;
      if (current()) setBusy(false);
    }
  }, [bookId, current, run]);

  const reload = useCallback(() => operate(signal => getBookWorkspace(bookId, signal)), [bookId, operate]);
  const initialLoad = useCallback(async () => {
    setError(null);
    try { await reload(); }
    catch (e) { if (!isLibraryAbort(e) && current()) setError(libraryErrorMessage(e)); }
  }, [current, reload]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setBusy(true);
    void getBookWorkspace(bookId, controller.signal).then(next => {
      if (active && current() && !controller.signal.aborted) setItem(next);
    }).catch(e => {
      if (active && current() && !isLibraryAbort(e)) setError(libraryErrorMessage(e));
    }).finally(() => { if (active && current()) setBusy(false); });
    return () => { active = false; controller.abort(); };
  }, [bookId, current]);

  async function saveToLibrary() {
    setError(null);
    setMessage("");
    try {
      await operate(signal => saveBookWorkspace(bookId, {}, signal));
      setMessage("已加入我的书籍。");
    } catch (e) { if (!isLibraryAbort(e)) setError(libraryErrorMessage(e)); }
  }

  if (!item) return <section className="library-panel" aria-label="本书的个人内容" aria-busy={busy}>
    <h2>我的阅读资料</h2>
    {error ? <><ErrorMessage message={error} /><button className="library-button" onClick={() => void initialLoad()} disabled={busy}>重新读取</button></>
      : <p className="library-muted" role="status">正在读取本书的介绍、笔记和电子版本…</p>}
  </section>;

  const props = { bookId, item, busy, operate, reload };
  return <div className="book-workspace" aria-label="本书的个人内容">
    <div className="library-workspace-bar">
      <div><strong>我的阅读资料</strong><p className="library-muted">介绍、笔记和电子版本会保存在这本书下，方便随时回来继续整理。</p></div>
      {item.saved ? <Link className="library-button library-button--quiet" to="/library">已在我的书籍中</Link>
        : <button className="library-button library-button--primary" onClick={() => void saveToLibrary()} disabled={busy}>加入我的书籍</button>}
    </div>
    <ErrorMessage message={error} />
    <p className="library-status" role="status" aria-live="polite">{message}</p>
    <IntroductionPanel {...props} />
    <NotesPanel {...props} generation={generation} />
    <ResourcesPanel {...props} />
  </div>;
}

function IntroductionPanel({ bookId, item, busy, operate, reload }: PanelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [baseVersion, setBaseVersion] = useState(0);
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  function edit() {
    setDraft(item.introduction);
    setBaseVersion(item.version);
    setEditing(true);
    setConflict(false);
    setLatest(null);
    setError(null);
    setMessage("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (conflict) return;
    setError(null);
    setMessage("");
    try {
      await operate(signal => saveBookWorkspace(bookId, { introduction: draft, baseVersion }, signal));
      setEditing(false);
      setLatest(null);
      setMessage("书籍介绍已保存。");
    } catch (e) {
      if (isLibraryAbort(e)) return;
      setError(libraryErrorMessage(e));
      setConflict(e instanceof LibraryApiError && e.status === 409);
    }
  }
  async function readLatest() {
    try {
      const next = await reload();
      setBaseVersion(next.version);
      setLatest(next.introduction);
      setConflict(false);
      setError(null);
      setMessage("已读取最新介绍。请对照检查保留的草稿，再决定是否保存。");
    } catch (e) { if (!isLibraryAbort(e)) setError(libraryErrorMessage(e)); }
  }

  return <section className="library-panel" aria-labelledby="library-introduction-heading">
    <div className="library-section-heading">
      <div><span className="library-eyebrow">了解这本书</span><h2 id="library-introduction-heading">我的补充介绍</h2></div>
      {!editing && <button className="library-button" onClick={edit} disabled={busy}>{item.introduction ? "编辑介绍" : "补充介绍"}</button>}
    </div>
    <p className="library-muted">记录内容简介、阅读价值、目录线索或版本说明。原始书目信息仍可在上方查看。</p>
    {editing ? <form onSubmit={event => void save(event)}>
      <fieldset className="library-fieldset" disabled={busy}>
        <label className="library-field" htmlFor="library-introduction">书籍介绍
          <textarea id="library-introduction" rows={9} value={draft} maxLength={50000} onChange={event => setDraft(event.target.value)} placeholder="这本书讲了什么？有哪些值得留意的章节或版本信息？" />
        </label>
        <p className="library-field-hint">支持分段或 Markdown 纯文本，最多 50,000 字符。</p>
        {latest !== null && <details className="library-comparison" open><summary>刚读取的最新介绍</summary><div className="library-prose">{latest || "尚无介绍。"}</div></details>}
        <div className="library-actions">
          <button className="library-button library-button--primary" type="submit" disabled={conflict}>{busy ? "正在保存…" : latest !== null ? "将我的草稿保存为新版本" : "保存介绍"}</button>
          {conflict && <button className="library-button" type="button" onClick={() => void readLatest()}>读取最新介绍</button>}
          <button className="library-button library-button--quiet" type="button" onClick={() => { setEditing(false); setError(null); setMessage(""); }}>取消编辑</button>
        </div>
      </fieldset>
    </form> : item.introduction ? <div className="library-prose">{item.introduction}</div>
      : <p className="library-empty">还没有补充介绍。把有用的信息留在这里，下次回来就能接着看。</p>}
    <ErrorMessage message={error} />
    <p className="library-status" role="status" aria-live="polite">{message}</p>
  </section>;
}

interface NoteDraft { noteId: string | null; title: string; content: string; baseRevisionId: string | null; }
function NotesPanel({ bookId, item, busy, operate, reload, generation }: PanelProps & { generation: number }) {
  const [editor, setEditor] = useState<NoteDraft | null>(null);
  const [conflict, setConflict] = useState(false);
  const [missing, setMissing] = useState(false);
  const [latest, setLatest] = useState<BookNote | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  function begin(note?: BookNote) {
    setEditor(note ? { noteId: note.noteId, title: note.title, content: note.content, baseRevisionId: note.currentRevisionId }
      : { noteId: null, title: "", content: "", baseRevisionId: null });
    setConflict(false); setMissing(false); setLatest(null); setConfirmDelete(null); setError(null); setMessage("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || conflict || missing) return;
    if (!editor.title.trim() || !editor.content.trim()) { setError("请填写笔记标题和正文。"); return; }
    setError(null); setMessage("");
    try {
      if (editor.noteId && editor.baseRevisionId) {
        await operate(signal => updateBookNote(bookId, editor.noteId!, {
          title: editor.title, content: editor.content, baseRevisionId: editor.baseRevisionId!,
        }, signal));
      } else {
        await operate(signal => createBookNote(bookId, { title: editor.title, content: editor.content }, signal));
      }
      setEditor(null); setLatest(null); setMessage("笔记已保存。");
    } catch (e) {
      if (isLibraryAbort(e)) return;
      setError(libraryErrorMessage(e));
      setConflict(e instanceof LibraryApiError && [404, 409].includes(e.status) && !!editor.noteId);
    }
  }
  async function readLatest() {
    if (!editor?.noteId) return;
    try {
      const next = await reload();
      const note = next.notes.find(value => value.noteId === editor.noteId);
      if (!note) {
        setMissing(true); setConflict(false); setLatest(null);
        setError("这篇笔记已被删除。你的草稿仍然保留，可以另存为新笔记。");
        return;
      }
      setEditor(value => value ? { ...value, baseRevisionId: note.currentRevisionId } : value);
      setLatest(note); setConflict(false); setError(null);
      setMessage("已读取最新笔记。请对照检查保留的草稿，再决定是否保存。");
    } catch (e) { if (!isLibraryAbort(e)) setError(libraryErrorMessage(e)); }
  }
  async function remove(noteId: string) {
    setError(null); setMessage("");
    try {
      await operate(signal => deleteBookNote(bookId, noteId, signal));
      setConfirmDelete(null); setMessage("笔记已从本书移除。");
    } catch (e) { if (!isLibraryAbort(e)) setError(libraryErrorMessage(e)); }
  }

  return <section className="library-panel" aria-labelledby="library-notes-heading">
    <div className="library-section-heading">
      <div><span className="library-eyebrow">留下阅读的线索</span><h2 id="library-notes-heading">我的笔记 <span className="library-count">{item.notes.length}</span></h2></div>
      <button className="library-button" onClick={() => begin()} disabled={busy || !!editor}>写一篇笔记</button>
    </div>
    <p className="library-muted">一章的摘录、一次读后感，或与其他书的比较，都可以单独记下来。</p>
    {editor && <form className="library-editor" aria-label={editor.noteId ? "编辑笔记" : "新建笔记"} onSubmit={event => void save(event)}>
      <fieldset className="library-fieldset" disabled={busy}>
        <label className="library-field" htmlFor="library-note-title">笔记标题
          <input id="library-note-title" value={editor.title} required maxLength={200} onChange={event => setEditor({ ...editor, title: event.target.value })} placeholder="给这次记录起个名字" />
        </label>
        <label className="library-field" htmlFor="library-note-content">笔记正文
          <textarea id="library-note-content" rows={10} value={editor.content} required maxLength={50000} onChange={event => setEditor({ ...editor, content: event.target.value })} placeholder="写下原文摘录、你的想法，以及下次想继续查的问题。" />
        </label>
        <p className="library-field-hint">正文最多 50,000 字符；每次保存会保留一个历史版本。</p>
        {latest && <details className="library-comparison" open><summary>刚读取的最新笔记：{latest.title}</summary><div className="library-prose">{latest.content}</div></details>}
        <div className="library-actions">
          <button className="library-button library-button--primary" type="submit" disabled={conflict || missing}>{busy ? "正在保存…" : latest ? "将我的草稿保存为新版本" : "保存笔记"}</button>
          {conflict && <button className="library-button" type="button" onClick={() => void readLatest()}>读取最新笔记</button>}
          {missing && <button className="library-button" type="button" onClick={() => {
            setEditor({ ...editor, noteId: null, baseRevisionId: null }); setMissing(false); setError(null); setMessage("草稿将保存为一篇新笔记。");
          }}>另存为新笔记</button>}
          <button className="library-button library-button--quiet" type="button" onClick={() => { setEditor(null); setError(null); setMessage(""); }}>取消编辑</button>
        </div>
      </fieldset>
    </form>}
    <ErrorMessage message={error} />
    <p className="library-status" role="status" aria-live="polite">{message}</p>
    {!item.notes.length && !editor && <p className="library-empty">还没有笔记。从一个问题或一段摘录开始。</p>}
    <div className="library-note-list">
      {item.notes.map(note => <article className="library-note" key={note.noteId} aria-label={`笔记：${note.title}`}>
        <div className="library-note-heading"><h3>{note.title}</h3><span className="library-tag">手工笔记</span></div>
        <p className="library-meta"><time dateTime={note.updatedAt}>{libraryDate(note.updatedAt)}</time> · 第 {note.revisionNo} 版</p>
        <div className="library-prose">{note.content}</div>
        <div className="library-actions">
          <button className="library-button library-button--quiet" onClick={() => begin(note)} disabled={busy || !!editor}>编辑笔记</button>
          <button className="library-button library-button--quiet" onClick={() => setConfirmDelete(note.noteId)} disabled={busy || !!editor}>删除笔记</button>
        </div>
        {confirmDelete === note.noteId && <div className="library-delete-prompt" role="group" aria-label={`删除 ${note.title}`}>
          <p>从本书移除这篇笔记？历史版本会保留。</p>
          <div className="library-actions"><button className="library-button library-button--danger" onClick={() => void remove(note.noteId)} disabled={busy}>确认删除笔记</button>
            <button className="library-button library-button--quiet" onClick={() => setConfirmDelete(null)} disabled={busy}>取消删除</button></div>
        </div>}
        <NoteHistory bookId={bookId} note={note} generation={generation} />
      </article>)}
    </div>
  </section>;
}

function NoteHistory({ bookId, note, generation }: { bookId: string; note: BookNote; generation: number }) {
  const { run } = useLibraryScope(generation);
  const [opened, setOpened] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [revision, setRevision] = useState<BookNoteRevision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { sequence.current += 1; active.current?.abort(); }, []);

  async function select(revisionId: string) {
    const request = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setSelected(revisionId); setRevision(null); setError(null);
    try {
      const value = await run(signal => {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
        return getBookNoteRevision(bookId, note.noteId, revisionId, controller.signal);
      });
      if (request === sequence.current && !controller.signal.aborted) setRevision(value);
    } catch (e) {
      if (!isLibraryAbort(e) && request === sequence.current && !controller.signal.aborted) setError(libraryErrorMessage(e));
    }
  }
  function toggle() {
    sequence.current += 1; active.current?.abort(); setOpened(!opened); setSelected(null); setRevision(null); setError(null);
  }

  return <div className="library-history">
    <button className="library-text-button" onClick={toggle} aria-expanded={opened}>{opened ? "收起历史版本" : `查看历史版本（${note.revisions.length}）`}</button>
    {opened && <div className="library-history-content">
      <p className="library-field-hint">历史版本只供查看，当前笔记仍保留在上方。</p>
      <div className="library-actions" aria-label={`${note.title} 的历史版本`}>
        {note.revisions.map(value => <button className="library-button library-button--quiet" key={value.revisionId}
          aria-pressed={selected === value.revisionId} onClick={() => void select(value.revisionId)}>
          第 {value.revisionNo} 版{value.revisionId === note.currentRevisionId ? " · 当前" : ""}
        </button>)}
      </div>
      {selected && !revision && !error && <p className="library-muted" role="status">正在读取历史版本…</p>}
      <ErrorMessage message={error} />
      {error && selected && <button className="library-button" onClick={() => void select(selected)}>重试读取此版本</button>}
      {revision && <section className="library-history-revision" aria-label={`历史版本 ${revision.revisionNo}`}>
        <h4>{revision.title}</h4><p className="library-meta"><time dateTime={revision.createdAt}>{libraryDate(revision.createdAt)}</time></p>
        <div className="library-prose">{revision.content}</div>
      </section>}
    </div>}
  </div>;
}

const emptyResource: BookResourceInput = { label: "", url: "", format: "PDF", versionLabel: "", notes: "" };
function ResourcesPanel({ bookId, item, busy, operate, reload }: PanelProps) {
  const [editor, setEditor] = useState<(BookResourceInput & { resourceId: string | null }) | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  function begin(resource?: BookResource) {
    setEditor(resource ? { ...resource } : { ...emptyResource, resourceId: null });
    setConfirmDelete(null); setConflict(false); setError(null); setMessage("");
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editor || conflict) return;
    if (!editor.label.trim()) { setError("请给电子版本填写一个名称。"); return; }
    const url = safeResourceUrl(editor.url);
    if (!url) { setError("请填写以 https:// 或 http:// 开头的完整链接。"); return; }
    const input: BookResourceInput = { label: editor.label, url, format: editor.format, versionLabel: editor.versionLabel, notes: editor.notes };
    setError(null); setMessage("");
    try {
      await operate(signal => editor.resourceId ? updateBookResource(bookId, editor.resourceId, input, signal) : createBookResource(bookId, input, signal));
      setEditor(null); setMessage("电子版本链接已保存。");
    } catch (e) {
      if (isLibraryAbort(e)) return;
      setError(libraryErrorMessage(e)); setConflict(e instanceof LibraryApiError && [404, 409].includes(e.status) && !!editor.resourceId);
    }
  }
  async function readLatest() {
    try {
      const next = await reload();
      const exists = next.resources.some(value => value.resourceId === editor?.resourceId);
      if (!exists) setEditor(value => value ? { ...value, resourceId: null } : value);
      setConflict(false); setError(null);
      setMessage(exists ? "已读取当前链接列表。草稿仍保留，请核对后保存。" : "这条链接已被移除；保留的草稿可以保存为一条新链接。");
    } catch (e) { if (!isLibraryAbort(e)) setError(libraryErrorMessage(e)); }
  }
  async function remove(resourceId: string) {
    setError(null); setMessage("");
    try {
      await operate(signal => deleteBookResource(bookId, resourceId, signal));
      setConfirmDelete(null); setMessage("电子版本链接已移除。");
    } catch (e) { if (!isLibraryAbort(e)) setError(libraryErrorMessage(e)); }
  }

  return <section className="library-panel" aria-labelledby="library-resources-heading">
    <div className="library-section-heading">
      <div><span className="library-eyebrow">回到原书</span><h2 id="library-resources-heading">电子版本 <span className="library-count">{item.resources.length}</span></h2></div>
      <button className="library-button" onClick={() => begin()} disabled={busy || !!editor}>添加电子版链接</button>
    </div>
    <p className="library-muted">保存 PDF、EPUB、网盘或在线阅读链接，文件继续留在原来的位置。登记外链不代表 AI 已读取全文。</p>
    {editor && <form className="library-editor" aria-label={editor.resourceId ? "编辑电子版本" : "添加电子版本"} onSubmit={event => void save(event)}>
      <fieldset className="library-fieldset" disabled={busy}>
        <div className="library-form-grid">
          <label className="library-field" htmlFor="library-resource-label">资源名称
            <input id="library-resource-label" value={editor.label} required maxLength={200} onChange={event => setEditor({ ...editor, label: event.target.value })} placeholder="例如：1936 年版扫描本" />
          </label>
          <label className="library-field" htmlFor="library-resource-format">格式
            <input id="library-resource-format" value={editor.format} maxLength={100} list="library-resource-formats" onChange={event => setEditor({ ...editor, format: event.target.value })} placeholder="PDF、EPUB、网页…" />
            <datalist id="library-resource-formats"><option value="PDF" /><option value="EPUB" /><option value="网页" /><option value="网盘" /><option value="其他" /></datalist>
          </label>
        </div>
        <label className="library-field" htmlFor="library-resource-url">电子版链接
          <input id="library-resource-url" type="url" inputMode="url" value={editor.url} required maxLength={4000} onChange={event => setEditor({ ...editor, url: event.target.value })} placeholder="https://…" />
        </label>
        <label className="library-field" htmlFor="library-resource-version">版本说明（可选）
          <input id="library-resource-version" value={editor.versionLabel} maxLength={200} onChange={event => setEditor({ ...editor, versionLabel: event.target.value })} placeholder="出版社、出版年份、译者或版次" />
        </label>
        <label className="library-field" htmlFor="library-resource-notes">来源与备注（可选）
          <textarea id="library-resource-notes" rows={3} value={editor.notes} maxLength={4000} onChange={event => setEditor({ ...editor, notes: event.target.value })} placeholder="来源网站、资源说明或提取码" />
        </label>
        <div className="library-actions">
          <button className="library-button library-button--primary" type="submit" disabled={conflict}>{busy ? "正在保存…" : "保存电子版链接"}</button>
          {conflict && <button className="library-button" type="button" onClick={() => void readLatest()}>读取最新链接</button>}
          <button className="library-button library-button--quiet" type="button" onClick={() => { setEditor(null); setError(null); setMessage(""); }}>取消编辑</button>
        </div>
      </fieldset>
    </form>}
    <ErrorMessage message={error} />
    <p className="library-status" role="status" aria-live="polite">{message}</p>
    {!item.resources.length && !editor && <p className="library-empty">找到电子版本后，把链接存到这里。一本书可以登记多个版本。</p>}
    <div className="library-resource-list">
      {item.resources.map(resource => {
        const href = safeResourceUrl(resource.url);
        return <article className="library-resource" key={resource.resourceId} aria-label={`电子版本：${resource.label}`}>
          <div className="library-note-heading"><h3>{resource.label}</h3>{resource.format && <span className="library-tag">{resource.format}</span>}</div>
          {resource.versionLabel && <p className="library-meta">{resource.versionLabel}</p>}
          {resource.notes && <p className="library-prose library-resource-notes">{resource.notes}</p>}
          <div className="library-actions">
            {href ? <a className="library-button" href={href} target="_blank" rel="noopener noreferrer">打开电子版本 ↗</a> : <span className="library-muted">链接格式不可用，请编辑后重试。</span>}
            <button className="library-button library-button--quiet" onClick={() => begin(resource)} disabled={busy || !!editor}>编辑链接</button>
            <button className="library-button library-button--quiet" onClick={() => setConfirmDelete(resource.resourceId)} disabled={busy || !!editor}>移除链接</button>
          </div>
          {confirmDelete === resource.resourceId && <div className="library-delete-prompt" role="group" aria-label={`移除 ${resource.label}`}>
            <p>从本书移除这条链接？原位置的文件会继续保留。</p>
            <div className="library-actions"><button className="library-button library-button--danger" onClick={() => void remove(resource.resourceId)} disabled={busy}>确认移除链接</button>
              <button className="library-button library-button--quiet" onClick={() => setConfirmDelete(null)} disabled={busy}>取消移除</button></div>
          </div>}
        </article>;
      })}
    </div>
  </section>;
}
