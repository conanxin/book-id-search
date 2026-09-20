import { useEffect, useId, useRef, useState } from "react";
import {
  appendProjectItemNoteRevision, createProjectItemNote, getProjectItemNote, getProjectItemNoteRevision,
  ProjectApiError, type ProjectItemNote, type ProjectItemNoteRevision, type ProjectResearchItem,
} from "./api";

type Props = { token: string; projectId: string; item: ProjectResearchItem };
type Mode = "closed" | "loading" | "failed" | "empty" | "reading" | "editing" | "history";

export function ProjectItemNotePanel(props: Props) {
  return <NotePanel key={JSON.stringify([props.token, props.projectId, props.item.bindingId])} {...props} />;
}

function NotePanel({ token, projectId, item }: Props) {
  const [mode, setMode] = useState<Mode>("closed");
  const [note, setNote] = useState<ProjectItemNote | null>(null);
  const [draft, setDraft] = useState("");
  const [staleDraft, setStaleDraft] = useState<string | null>(null);
  const [latestLoaded, setLatestLoaded] = useState(false);
  const [selected, setSelected] = useState<ProjectItemNoteRevision | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const resumeMode = useRef<"empty" | "editing" | null>(null);
  const textareaId = useId();
  useEffect(() => () => request.current?.abort(), []);

  function begin() {
    if (inFlight.current) return null;
    const controller = new AbortController();
    request.current?.abort(); request.current = controller;
    inFlight.current = true; setBusy(true); setError("");
    return controller;
  }
  function finish(controller: AbortController) {
    if (!controller.signal.aborted) { inFlight.current = false; setBusy(false); }
  }
  function message(err: unknown) {
    return err instanceof ProjectApiError ? err.message : "笔记请求未能确认，请稍后再试。";
  }
  function close(discardDraft = false) {
    resumeMode.current = !discardDraft && (mode === "empty" || mode === "editing") ? mode : null;
    request.current?.abort(); inFlight.current = false;
    setBusy(false); setMode("closed");
    if (resumeMode.current) return;
    setNote(null); setDraft(""); setStaleDraft(null);
    setSelected(null); setError(""); setLatestLoaded(false);
  }
  function open() {
    if (resumeMode.current) { setMode(resumeMode.current); resumeMode.current = null; }
    else void load();
  }
  async function load(preserveDraft = false) {
    const controller = begin(); if (!controller) return;
    if (!preserveDraft) setMode("loading");
    try {
      const data = await getProjectItemNote(token, projectId, item.bindingId, controller.signal);
      if (controller.signal.aborted) return;
      if (preserveDraft && !data.note) throw new ProjectApiError(404, "研究笔记已不可用，请保留当前草稿后重试。");
      setNote(data.note);
      if (preserveDraft) { setStaleDraft(draft); setLatestLoaded(true); setMode("editing"); }
      else { setDraft(""); setMode(data.note ? "reading" : "empty"); }
    } catch (err) {
      if (!controller.signal.aborted) { setError(message(err)); if (!preserveDraft) setMode("failed"); }
    } finally { finish(controller); }
  }
  function edit() {
    if (!note || busy) return;
    setDraft(note.currentRevision.content); setStaleDraft(null); setLatestLoaded(false);
    setError(""); setSelected(null); setMode("editing");
  }
  function cancel() {
    if (busy) return;
    if (!note) { close(true); return; }
    setDraft(""); setStaleDraft(null); setLatestLoaded(false); setError(""); setMode("reading");
  }
  async function save() {
    if (!draft.trim()) return;
    const controller = begin(); if (!controller) return;
    try {
      const data = note
        ? await appendProjectItemNoteRevision(token, projectId, item.bindingId, note.currentRevision.revisionId, draft, controller.signal)
        : await createProjectItemNote(token, projectId, item.bindingId, draft, controller.signal);
      if (!controller.signal.aborted) {
        setNote(data.note); setDraft(""); setStaleDraft(null); setLatestLoaded(false); setMode("reading");
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(message(err));
        if (err instanceof ProjectApiError && (err.code === "STALE_NOTE_REVISION" || err.code === "NOTE_ALREADY_EXISTS")) {
          setStaleDraft(draft); setLatestLoaded(false);
        }
      }
    } finally { finish(controller); }
  }
  async function history(revisionId: string) {
    const controller = begin(); if (!controller) return;
    try {
      const data = await getProjectItemNoteRevision(token, projectId, item.bindingId, revisionId, controller.signal);
      if (!controller.signal.aborted) { setSelected(data.revision); setMode("history"); }
    } catch (err) { if (!controller.signal.aborted) setError(message(err)); }
    finally { finish(controller); }
  }

  return <section className="research-note" aria-label="研究笔记">
    <div className="research-note-heading">
      <button type="button" className="research-text-button" aria-expanded={mode !== "closed"} onClick={() => mode === "closed" ? open() : close()}>{mode === "closed" ? "研究笔记" : "收起笔记"}</button>
      {mode !== "closed" ? <h4>研究笔记</h4> : null}
    </div>
    {mode !== "closed" ? <>
      {busy ? <p role="status">正在处理笔记…</p> : null}
      {error ? <p className="research-error" role="alert">{error}</p> : null}
      {mode === "failed" ? <button type="button" className="research-text-button" disabled={busy} onClick={() => void load()}>重新读取笔记</button> : null}
      {note && (mode === "reading" || (mode === "editing" && staleDraft !== null)) ? <section aria-label="当前笔记">
        <p className="research-muted">当前版本 v{note.currentRevision.revisionNo}</p>
        <pre className="research-note-content">{note.currentRevision.content}</pre>
        {mode === "reading" ? <button type="button" className="research-text-button" disabled={busy} onClick={edit}>编辑</button> : null}
      </section> : null}
      {mode === "empty" || mode === "editing" ? <form className="research-note-editor" onSubmit={e => { e.preventDefault(); void save(); }}>
        <label htmlFor={textareaId}>笔记正文</label>
        <textarea id={textareaId} rows={8} value={draft} disabled={busy} onChange={e => setDraft(e.target.value)} />
        <p className="research-muted">保存时创建新版本。正文最多 65536 UTF-8 字节。</p>
        <div className="research-note-actions"><button type="button" className="research-text-button" disabled={busy} onClick={cancel}>取消</button><button type="submit" className="research-primary" disabled={busy || !draft.trim()}>{note ? "保存新版本" : "创建笔记"}</button></div>
      </form> : null}
      {staleDraft !== null ? <section className="research-note-stale" aria-label="保留的草稿">
        <h5>保留的草稿</h5><pre className="research-note-content">{staleDraft}</pre>
        <div className="research-note-actions">
          <button type="button" className="research-text-button" disabled={busy} onClick={() => void load(true)}>重新加载最新版本</button>
          {latestLoaded && note ? <button type="button" className="research-text-button" disabled={busy} onClick={() => { setDraft(note.currentRevision.content); setError(""); }}>用最新版本重新编辑</button> : null}
        </div>
      </section> : null}
      {mode === "history" && selected ? <section aria-label={`历史版本 v${selected.revisionNo}`}>
        <h5>历史版本 v{selected.revisionNo} · 只读</h5>
        <p className="research-muted">保存于 <time dateTime={selected.createdAt}>{new Date(selected.createdAt).toLocaleString("zh-CN")}</time></p>
        <pre className="research-note-content">{selected.content}</pre>
        <button type="button" className="research-text-button" disabled={busy} onClick={() => { setSelected(null); setError(""); setMode("reading"); }}>返回当前版本</button>
      </section> : null}
      {note ? <nav className="research-note-history" aria-label="笔记历史版本"><h5>历史版本</h5><div className="research-note-actions">{note.revisions.map(rev => <button type="button" className="research-text-button" key={rev.revisionId} disabled={busy || mode === "editing"} onClick={() => void history(rev.revisionId)}>v{rev.revisionNo}{rev.revisionId === note.currentRevision.revisionId ? " 当前" : ""}</button>)}</div></nav> : null}
    </> : null}
  </section>;
}
