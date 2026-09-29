import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import {
  ensureAuthSessionLoaded,
  getWebAuthSnapshot,
  subscribeWebAuth,
  type WebAuthSnapshot,
} from "./session";

/**
 * Research session hook (Task 8). Returns the live auth snapshot and starts
 * the authoritative session GET on mount. Concurrent mounts rely on the
 * Task 7 in-flight dedupe: still exactly one GET.
 */
export function useWebAuthSession(): WebAuthSnapshot {
  const snapshot = useSyncExternalStore(subscribeWebAuth, getWebAuthSnapshot, getWebAuthSnapshot);
  useEffect(() => {
    void ensureAuthSessionLoaded();
  }, []);
  return snapshot;
}
