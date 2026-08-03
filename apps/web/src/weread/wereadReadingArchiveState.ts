/**
 * S27L-STATE-MACHINE-REBUILD Phase A
 *
 * Pure client-side state machine for ReadingArchiveDashboard.
 *
 * The state machine is the single source of truth for:
 *   - bootstrap lifecycle (discover availableYears from the network)
 *   - view selection (range, topBooks)
 *   - cache of annual-review responses (keyed by `${year}:${topBooks}`)
 *   - per-key request lifecycle (idle | pending | success | error)
 *
 * It MUST NOT know about:
 *   - tokens (no token fields, no token reads)
 *   - DOM, React, fetch / AbortController
 *   - requestedAnnualReviewYear (a separate WereadCenter concern)
 *   - private IDs, note text, comment text, AI summaries
 *
 * The contract is: caller owns token and side-effects, the reducer
 * owns state transitions, and selectors drive the next network
 * requests. This file is the surface that Phase B's React adapter
 * will consume.
 */

import type {
  WereadAnnualReviewResponse,
  WereadAnnualReviewTopBooksOption,
} from "../wereadPrivate";

// ---------- range / top books ----------

export type ArchiveRange = 5 | 10 | 20;
export type ArchiveTopBooks = WereadAnnualReviewTopBooksOption; // 6 | 12 | 18
export type ArchiveCacheKey = `${number}:${ArchiveTopBooks}`;

export const ARCHIVE_RANGE_OPTIONS: ReadonlyArray<ArchiveRange> = [5, 10, 20];
export const ARCHIVE_TOP_BOOKS_OPTIONS: ReadonlyArray<ArchiveTopBooks> = [6, 12, 18];

export const DEFAULT_ARCHIVE_RANGE: ArchiveRange = 5;
export const DEFAULT_ARCHIVE_TOP_BOOKS: ArchiveTopBooks = 12;

export const MAX_ARCHIVE_CONCURRENCY = 2;

// ---------- request status ----------

export type ArchiveRequestStatus = "idle" | "pending" | "success" | "error";

export interface ArchiveRequestState {
  status: ArchiveRequestStatus;
  requestId: number | null;
  attempts: number;
  errorCode: string | null;
}

export const EMPTY_REQUEST_STATE: ArchiveRequestState = {
  status: "idle",
  requestId: null,
  attempts: 0,
  errorCode: null,
};

// ---------- bootstrap status ----------

export type BootstrapStatus = "idle" | "loading" | "ready" | "error";

export interface BootstrapState {
  status: BootstrapStatus;
  requestId: number | null;
  selectedYear: number | null;
  availableYears: number[];
  errorCode: string | null;
}

// ---------- view ----------

export interface ViewState {
  range: ArchiveRange;
  topBooks: ArchiveTopBooks;
}

// ---------- machine state ----------

export interface ReadingArchiveMachineState {
  epoch: number;
  bootstrap: BootstrapState;
  view: ViewState;
  cache: Partial<Record<ArchiveCacheKey, WereadAnnualReviewResponse>>;
  requests: Partial<Record<ArchiveCacheKey, ArchiveRequestState>>;
}

// ---------- actions ----------

export type ReadingArchiveAction =
  | { type: "TOKEN_RESET" }
  | { type: "BOOTSTRAP_STARTED"; requestId: number }
  | {
      type: "BOOTSTRAP_SUCCEEDED";
      requestId: number;
      response: WereadAnnualReviewResponse;
    }
  | { type: "BOOTSTRAP_FAILED"; requestId: number; errorCode: string }
  | { type: "RANGE_CHANGED"; range: ArchiveRange }
  | { type: "TOP_BOOKS_CHANGED"; topBooks: ArchiveTopBooks }
  | {
      type: "YEAR_REQUEST_STARTED";
      key: ArchiveCacheKey;
      requestId: number;
    }
  | {
      type: "YEAR_REQUEST_SUCCEEDED";
      key: ArchiveCacheKey;
      requestId: number;
      response: WereadAnnualReviewResponse;
    }
  | {
      type: "YEAR_REQUEST_FAILED";
      key: ArchiveCacheKey;
      requestId: number;
      errorCode: string;
    }
  | { type: "YEAR_RETRY_REQUESTED"; keys: ReadonlyArray<ArchiveCacheKey> };

// ---------- pure helpers ----------

export function isArchiveRange(v: unknown): v is ArchiveRange {
  return v === 5 || v === 10 || v === 20;
}

export function isArchiveTopBooks(v: unknown): v is ArchiveTopBooks {
  return v === 6 || v === 12 || v === 18;
}

export function makeArchiveCacheKey(
  year: number,
  topBooks: ArchiveTopBooks,
): ArchiveCacheKey {
  return `${year}:${topBooks}` as ArchiveCacheKey;
}

export function parseArchiveCacheKey(
  key: ArchiveCacheKey,
): { year: number; topBooks: ArchiveTopBooks } {
  const idx = key.lastIndexOf(":");
  const yearRaw = key.slice(0, idx);
  const topRaw = key.slice(idx + 1);
  const year = Number(yearRaw);
  const topBooks = Number(topRaw) as ArchiveTopBooks;
  return { year, topBooks };
}

export function normalizeArchiveAvailableYears(
  raw: ReadonlyArray<unknown>,
): number[] {
  const set = new Set<number>();
  for (const v of raw) {
    if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) {
      set.add(v);
    }
  }
  return Array.from(set).sort((a, b) => b - a);
}

export function isFiniteYear(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v);
}

// ---------- initial state ----------

export function createInitialArchiveMachineState(): ReadingArchiveMachineState {
  return {
    epoch: 0,
    bootstrap: {
      status: "idle",
      requestId: null,
      selectedYear: null,
      availableYears: [],
      errorCode: null,
    },
    view: {
      range: DEFAULT_ARCHIVE_RANGE,
      topBooks: DEFAULT_ARCHIVE_TOP_BOOKS,
    },
    cache: {},
    requests: {},
  };
}

export function hasArchiveBootstrapData(state: ReadingArchiveMachineState): boolean {
  return (
    state.bootstrap.status === "ready" &&
    state.bootstrap.availableYears.length > 0 &&
    state.bootstrap.selectedYear !== null
  );
}

// ---------- selectors ----------

export function selectArchiveVisibleYears(
  state: ReadingArchiveMachineState,
): number[] {
  return state.bootstrap.availableYears.slice(0, state.view.range);
}

export function selectArchiveRequiredKeys(
  state: ReadingArchiveMachineState,
): ArchiveCacheKey[] {
  const years = selectArchiveVisibleYears(state);
  return years.map((y) => makeArchiveCacheKey(y, state.view.topBooks));
}

export function selectArchiveCachedResponses(
  state: ReadingArchiveMachineState,
): Partial<Record<ArchiveCacheKey, WereadAnnualReviewResponse>> {
  const out: Partial<Record<ArchiveCacheKey, WereadAnnualReviewResponse>> = {};
  for (const k of selectArchiveRequiredKeys(state)) {
    const v = state.cache[k];
    if (v) out[k] = v;
  }
  return out;
}

export function selectArchiveFailedKeys(
  state: ReadingArchiveMachineState,
): ArchiveCacheKey[] {
  const required = new Set(selectArchiveRequiredKeys(state));
  const failed: ArchiveCacheKey[] = [];
  for (const [k, r] of Object.entries(state.requests) as Array<
    [ArchiveCacheKey, ArchiveRequestState]
  >) {
    if (r.status === "error" && required.has(k)) {
      failed.push(k);
    }
  }
  return failed.sort();
}

export function selectArchiveRequestsToStart(
  state: ReadingArchiveMachineState,
  maxConcurrency: number = MAX_ARCHIVE_CONCURRENCY,
): ArchiveCacheKey[] {
  const required = selectArchiveRequiredKeys(state);
  const sorted = [...required].sort(
    (a, b) => parseArchiveCacheKey(a).year - parseArchiveCacheKey(b).year,
  );
  const out: ArchiveCacheKey[] = [];
  for (const k of sorted) {
    if (out.length >= maxConcurrency) break;
    if (state.cache[k]) continue; // cached keys never re-request
    const r = state.requests[k];
    if (!r) {
      out.push(k);
      continue;
    }
    if (r.status === "pending") continue;
    if (r.status === "success") continue;
    if (r.status === "error") continue; // explicit retry required
    if (r.status === "idle") out.push(k);
  }
  return out;
}

export function selectArchiveLoadedKeys(
  state: ReadingArchiveMachineState,
): ArchiveCacheKey[] {
  const out: ArchiveCacheKey[] = [];
  for (const k of selectArchiveRequiredKeys(state)) {
    if (state.cache[k]) out.push(k);
  }
  return out;
}

// ---------- debug snapshot (privacy-safe) ----------

export interface ArchiveMachineDebugSnapshot {
  epoch: number;
  bootstrap: {
    status: BootstrapStatus;
    selectedYear: number | null;
    availableYearsCount: number;
    errorCode: string | null;
  };
  view: ViewState;
  cacheKeys: ArchiveCacheKey[];
  requestKeys: ArchiveCacheKey[];
  failedKeys: ArchiveCacheKey[];
  pendingKeys: ArchiveCacheKey[];
  idleKeys: ArchiveCacheKey[];
  requiredKeys: ArchiveCacheKey[];
}

export function archiveMachineDebugSnapshot(
  state: ReadingArchiveMachineState,
): ArchiveMachineDebugSnapshot {
  const required = selectArchiveRequiredKeys(state);
  const requiredSet = new Set(required);
  const cacheKeys: ArchiveCacheKey[] = [];
  const requestKeys: ArchiveCacheKey[] = [];
  const failedKeys: ArchiveCacheKey[] = [];
  const pendingKeys: ArchiveCacheKey[] = [];
  const idleKeys: ArchiveCacheKey[] = [];
  for (const [k, v] of Object.entries(state.cache) as Array<
    [ArchiveCacheKey, WereadAnnualReviewResponse]
  >) {
    if (v) cacheKeys.push(k);
  }
  for (const [k, r] of Object.entries(state.requests) as Array<
    [ArchiveCacheKey, ArchiveRequestState]
  >) {
    requestKeys.push(k);
    if (r.status === "error" && requiredSet.has(k)) failedKeys.push(k);
    if (r.status === "pending") pendingKeys.push(k);
    if (r.status === "idle") idleKeys.push(k);
  }
  return {
    epoch: state.epoch,
    bootstrap: {
      status: state.bootstrap.status,
      selectedYear: state.bootstrap.selectedYear,
      availableYearsCount: state.bootstrap.availableYears.length,
      errorCode: state.bootstrap.errorCode,
    },
    view: { ...state.view },
    cacheKeys: cacheKeys.sort(),
    requestKeys: requestKeys.sort(),
    failedKeys: failedKeys.sort(),
    pendingKeys: pendingKeys.sort(),
    idleKeys: idleKeys.sort(),
    requiredKeys: required.slice().sort(),
  };
}

// ---------- reducer ----------

export function reduceReadingArchiveState(
  state: ReadingArchiveMachineState,
  action: ReadingArchiveAction,
): ReadingArchiveMachineState {
  switch (action.type) {
    case "TOKEN_RESET":
      // epoch +1 invalidates any in-flight requestId; bootstrap/cache/requests wiped; view reset
      return {
        epoch: state.epoch + 1,
        bootstrap: {
          status: "idle",
          requestId: null,
          selectedYear: null,
          availableYears: [],
          errorCode: null,
        },
        view: {
          range: DEFAULT_ARCHIVE_RANGE,
          topBooks: DEFAULT_ARCHIVE_TOP_BOOKS,
        },
        cache: {},
        requests: {},
      };

    case "BOOTSTRAP_STARTED": {
      // Only one bootstrap at a time. Re-entry while loading is a no-op.
      if (state.bootstrap.status === "loading") return state;
      return {
        ...state,
        bootstrap: {
          ...state.bootstrap,
          status: "loading",
          requestId: action.requestId,
          errorCode: null,
        },
      };
    }

    case "BOOTSTRAP_SUCCEEDED": {
      // Stale: requestId mismatch (token reset, superseded, etc.)
      if (state.bootstrap.requestId !== action.requestId) return state;
      // Defensive: refuse to seed NaN years from a malformed response.
      if (!isFiniteYear(action.response.selectedYear)) return state;
      const years = normalizeArchiveAvailableYears(action.response.availableYears);
      // Invariant: selectedYear must be one of availableYears.
      const selectedYear = action.response.selectedYear;
      const safeSelected = years.includes(selectedYear) ? selectedYear : null;
      const key = makeArchiveCacheKey(selectedYear, state.view.topBooks);
      return {
        ...state,
        bootstrap: {
          status: "ready",
          requestId: action.requestId,
          selectedYear: safeSelected,
          availableYears: years,
          errorCode: null,
        },
        cache: { ...state.cache, [key]: action.response },
        requests: {
          ...state.requests,
          [key]: {
            status: "success",
            requestId: action.requestId,
            attempts: 1,
            errorCode: null,
          },
        },
      };
    }

    case "BOOTSTRAP_FAILED": {
      if (state.bootstrap.requestId !== action.requestId) return state;
      return {
        ...state,
        bootstrap: {
          ...state.bootstrap,
          status: "error",
          requestId: action.requestId,
          errorCode: action.errorCode,
        },
      };
    }

    case "RANGE_CHANGED":
      // View-only; cache/requests preserved across range switches.
      return {
        ...state,
        view: { ...state.view, range: action.range },
      };

    case "TOP_BOOKS_CHANGED":
      // Top N is an independent cache dimension; old Top N entries kept.
      return {
        ...state,
        view: { ...state.view, topBooks: action.topBooks },
      };

    case "YEAR_REQUEST_STARTED": {
      // Cached: never re-request
      if (state.cache[action.key]) return state;
      const existing = state.requests[action.key];
      // Pending: ignore (avoid duplicate in-flight)
      if (existing && existing.status === "pending") return state;
      // Success: ignore
      if (existing && existing.status === "success") return state;
      // Error: ignore (must be retried first)
      if (existing && existing.status === "error") return state;
      // Idle / never-started: start a request, preserve attempts on retry
      return {
        ...state,
        requests: {
          ...state.requests,
          [action.key]: {
            status: "pending",
            requestId: action.requestId,
            attempts: existing?.attempts ?? 0,
            errorCode: null,
          },
        },
      };
    }

    case "YEAR_REQUEST_SUCCEEDED": {
      const existing = state.requests[action.key];
      // Stale: requestId mismatch or never started
      if (!existing || existing.requestId !== action.requestId) return state;
      return {
        ...state,
        cache: { ...state.cache, [action.key]: action.response },
        requests: {
          ...state.requests,
          [action.key]: {
            status: "success",
            requestId: action.requestId,
            attempts: existing.attempts + 1,
            errorCode: null,
          },
        },
      };
    }

    case "YEAR_REQUEST_FAILED": {
      const existing = state.requests[action.key];
      if (!existing || existing.requestId !== action.requestId) return state;
      return {
        ...state,
        requests: {
          ...state.requests,
          [action.key]: {
            status: "error",
            requestId: action.requestId,
            attempts: existing.attempts + 1,
            errorCode: action.errorCode,
          },
        },
      };
    }

    case "YEAR_RETRY_REQUESTED": {
      const requests: Partial<Record<ArchiveCacheKey, ArchiveRequestState>> = {
        ...state.requests,
      };
      for (const key of action.keys) {
        const existing = requests[key];
        if (existing && (existing.status === "error" || existing.status === "pending")) {
          // Retry resets to idle so the scheduler can issue a new request;
          // cache retained; other Top N keys untouched; success stays
          // success (no need to retry a successful key).
          requests[key] = {
            status: "idle",
            requestId: null,
            attempts: existing.attempts,
            errorCode: null,
          };
        } else if (!existing) {
          requests[key] = { ...EMPTY_REQUEST_STATE };
        }
        // success → no change
      }
      return { ...state, requests };
    }

    default: {
      // Exhaustiveness check
      const _exhaustive: never = action;
      void _exhaustive;
      return state;
    }
  }
}