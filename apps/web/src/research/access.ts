import { useSyncExternalStore } from "react";

export const S32_TOKEN_KEY = "book-id-search:s32-private-token:v1";
let token: string | null | undefined;
const listeners = new Set<() => void>();
function readToken() {
  if (token === undefined) {
    try { token = globalThis.sessionStorage?.getItem(S32_TOKEN_KEY) || null; }
    catch { token = null; }
  }
  return token;
}
export function saveS32Token(value: string | null) {
  token = value?.trim() || null;
  try {
    if (token) globalThis.sessionStorage?.setItem(S32_TOKEN_KEY, token);
    else globalThis.sessionStorage?.removeItem(S32_TOKEN_KEY);
  } catch { /* The in-memory token remains usable when storage is unavailable. */ }
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useS32Token() {
  return useSyncExternalStore(subscribe, readToken, () => null);
}
export { readToken as getS32Token };
