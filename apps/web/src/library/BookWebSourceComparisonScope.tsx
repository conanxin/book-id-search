import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import type { BookWebResearchSource } from "./bookWebResearch";
import { assertBookWebSourceReadResponse, type BookWebSourceReadResponse } from "./bookWebSourceReader";
import type { BookWebSourceComparisonSelection } from "./bookWebSourceComparison";

interface RegisteredSource {
  selection: BookWebSourceComparisonSelection;
  reader: symbol;
}
interface Registry {
  entries: readonly BookWebSourceComparisonSelection[];
  register: (source: BookWebResearchSource, snapshot: BookWebSourceReadResponse | null, reader: symbol) => void;
  unregister: (source: BookWebResearchSource, reader: symbol) => void;
  contains: (selection: BookWebSourceComparisonSelection) => boolean;
}
const ComparisonRegistry = createContext<Registry | null>(null);
const sourceKey = (source: BookWebResearchSource) => JSON.stringify([source.id, source.url, source.readToken]);

/** Mounted inside one resultRevision: an old W1 or a stale reader cannot enter a new search. */
export function BookWebSourceComparisonProvider({
  bookId, sources, children,
}: { bookId: string; sources: readonly BookWebResearchSource[]; children: ReactNode }) {
  const allowed = useMemo(() => new Map(sources.map(source => [sourceKey(source), source])), [sources]);
  const registered = useRef(new Map<string, RegisteredSource>());
  const [entries, setEntries] = useState<readonly BookWebSourceComparisonSelection[]>([]);
  useEffect(() => () => { registered.current.clear(); }, []);
  const publish = useCallback(() => {
    setEntries(sources.flatMap(source => {
      const value = registered.current.get(sourceKey(source));
      return value ? [value.selection] : [];
    }));
  }, [sources]);
  const unregister = useCallback((source: BookWebResearchSource, reader: symbol) => {
    const key = sourceKey(source), value = registered.current.get(key);
    if (value?.reader !== reader) return;
    registered.current.delete(key); publish();
  }, [publish]);
  const register = useCallback((source: BookWebResearchSource, snapshot: BookWebSourceReadResponse | null, reader: symbol) => {
    if (!allowed.has(sourceKey(source))) return;
    if (!snapshot?.snapshotToken || !/^[A-Za-z0-9_-]{32}$/.test(snapshot.snapshotToken)) {
      unregister(source, reader); return;
    }
    try { assertBookWebSourceReadResponse(snapshot, bookId, source); }
    catch { unregister(source, reader); return; }
    const key = sourceKey(source), previous = registered.current.get(key);
    if (previous?.reader === reader && previous.selection.snapshot === snapshot) return;
    registered.current.set(key, { reader, selection: { source: allowed.get(key)!, snapshot } });
    publish();
  }, [allowed, bookId, publish, unregister]);
  const contains = useCallback((selection: BookWebSourceComparisonSelection) =>
    registered.current.get(sourceKey(selection.source))?.selection === selection, []);
  const value = useMemo(() => ({ entries, register, unregister, contains }), [entries, register, unregister, contains]);
  return <ComparisonRegistry.Provider value={value}>{children}</ComparisonRegistry.Provider>;
}

/** Optional outside research; existing standalone readers need no comparison provider. */
export function useBookWebSourceComparisonRegistration(
  source: BookWebResearchSource, snapshot: BookWebSourceReadResponse | null, reading: boolean,
): () => void {
  const registry = useContext(ComparisonRegistry);
  const reader = useRef(Symbol("web-source-reader"));
  const register = registry?.register, unregister = registry?.unregister;
  useEffect(() => {
    register?.(source, reading ? null : snapshot, reader.current);
  }, [register, source, snapshot, reading]);
  useEffect(() => {
    const identity = reader.current;
    return () => unregister?.(source, identity);
  }, [unregister, source]);
  // Invalidating synchronously closes the race with an already-resolving comparison.
  return useCallback(() => unregister?.(source, reader.current), [unregister, source]);
}
export function useBookWebSourceComparisonRegistry(): Registry {
  const registry = useContext(ComparisonRegistry);
  if (!registry) throw new Error("Web source comparison requires the current research scope");
  return registry;
}
