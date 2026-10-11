import { useEffect, useRef, useState, type RefObject } from "react";
import { useLocation } from "react-router-dom";
import { getWebAuthAuthGeneration, getWebAuthSnapshot } from "../auth/session";
import type { BookWorkspaceData } from "./api";

function targetFor(hash: string, workspace: BookWorkspaceData): { id: string | null; message: string | null } {
  if (hash === "#library-introduction-heading") return { id: "library-introduction-heading", message: null };
  if (!hash.startsWith("#book-note-")) return { id: null, message: null };
  let noteId: string;
  try { noteId = decodeURIComponent(hash.slice("#book-note-".length)); }
  catch { return { id: null, message: "这篇笔记的定位地址无效，可以在本书笔记中继续查找。" }; }
  if (!/^[^\u0000-\u0020\u007f]{1,128}$/u.test(noteId)) {
    return { id: null, message: "这篇笔记的定位地址无效，可以在本书笔记中继续查找。" };
  }
  if (!workspace.notes.some(note => note.noteId === noteId)) {
    return { id: null, message: "这篇笔记已不在当前书籍中，可以查看本书其他笔记，或返回我的书籍继续查找。" };
  }
  return { id: `book-note-${noteId}`, message: null };
}

/** Resolve only this loaded book's content, once per requested fragment. */
export function useBookContentAnchor(bookId: string, generation: number, workspace: BookWorkspaceData | null, root: RefObject<HTMLElement | null>) {
  const location = useLocation();
  // Native in-page anchors also work if the router does not emit a navigation
  // for a hashchange. The override cannot survive a different route entry.
  const [nativeHash, setNativeHash] = useState<{ key: string; hash: string } | null>(null);
  const hash = nativeHash?.key === location.key ? nativeHash.hash : location.hash;
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const changed = () => {
      if (window.location.pathname === location.pathname && window.location.search === location.search) {
        setNativeHash({ key: location.key, hash: window.location.hash });
      }
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [location.key, location.pathname, location.search]);

  const ready = workspace?.bookId === bookId;
  const target = ready ? targetFor(hash, workspace) : { id: null, message: null };
  useEffect(() => {
    if (!ready || getWebAuthAuthGeneration() !== generation || getWebAuthSnapshot().status !== "authenticated") return;
    const request = JSON.stringify([bookId, generation, hash]);
    if (handled.current === request) return;
    handled.current = request;
    if (!target.id) return;
    const element = document.getElementById(target.id);
    if (!element || !root.current?.contains(element)) return;
    element.scrollIntoView({ block: "start", behavior: "auto" });
    element.focus({ preventScroll: true });
  }, [bookId, generation, hash, ready, root, target.id]);
  return target.message;
}
