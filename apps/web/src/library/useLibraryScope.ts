import { useCallback, useEffect, useRef } from "react";
import { getWebAuthAuthGeneration, getWebAuthSnapshot } from "../auth/session";

/** Abort on unmount and reject even a mock/server that ignores AbortSignal. */
export function useLibraryScope(generation: number) {
  const mounted = useRef(true);
  const pending = useRef(new Set<AbortController>());
  const current = useCallback(() => mounted.current
    && getWebAuthAuthGeneration() === generation
    && getWebAuthSnapshot().status === "authenticated", [generation]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const controller of pending.current) controller.abort();
      pending.current.clear();
    };
  }, [generation]);

  const run = useCallback(async <T,>(read: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    if (!current()) throw new DOMException("Request no longer current", "AbortError");
    const controller = new AbortController();
    pending.current.add(controller);
    try {
      const result = await read(controller.signal);
      if (!current() || controller.signal.aborted) throw new DOMException("Request no longer current", "AbortError");
      return result;
    } finally {
      pending.current.delete(controller);
    }
  }, [current]);

  return { run, current };
}
