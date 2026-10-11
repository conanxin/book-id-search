import { useCallback, useEffect, useRef, useState } from "react";
import { createDossierReader, type DossierReader, type DossierView } from "./dossier-reader";
import type { DossierRequest } from "./dossier-model";

type Snapshot = { key: string; view: DossierView };
/** Routes and auth changes discard private page memory before a new scope renders. */
export function useResearchDossier(projectId: string, issueId: string, authGeneration = 1) {
  const key = JSON.stringify([projectId, issueId, authGeneration]);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const readerRef = useRef<{ key: string; reader: DossierReader } | null>(null);

  useEffect(() => {
    const reader = createDossierReader({ projectId, issueId, authGeneration });
    readerRef.current = { key, reader };
    setSnapshot({ key, view: reader.view() });
    const unsubscribe = reader.subscribe(view => setSnapshot({ key, view }));
    reader.start();
    return () => {
      unsubscribe();
      if (readerRef.current?.reader === reader) readerRef.current = null;
      reader.dispose();
    };
  }, [key, projectId, issueId, authGeneration]);

  const read = useCallback((request: DossierRequest): Promise<boolean> => {
    const current = readerRef.current;
    return current?.key === key ? current.reader.read(request) : Promise.resolve(false);
  }, [key]);
  const refresh = useCallback(() => {
    const current = readerRef.current;
    if (current?.key === key) current.reader.refresh();
  }, [key]);

  // Do not show the preceding Issue while the current route's Effect is mounting.
  return { view: snapshot?.key === key ? snapshot.view : null, read, refresh };
}
