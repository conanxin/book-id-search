/**
 * S27L-STATE-MACHINE-REBUILD Phase B — React adapter
 *
 * Thin presenter layer that couples the pure Phase A state machine
 * (see `./wereadReadingArchiveState.ts`) to React lifecycle and the
 * real `fetchWereadAnnualReview` network call.
 *
 * Design contract:
 *
 *   1. The reducer is the **single source of truth** for archive
 *      state. This hook MUST NOT maintain a parallel cache, a
 *      separate failedYears list, or a second inflight tracker.
 *      All such concerns live in the reducer / selectors.
 *
 *   2. The hook is split into two layers:
 *        - `useReadingArchiveMachine` (React glue): wraps the
 *          reducer with `useReducer` and runs `useEffect` to
 *          forward state changes to the controller.
 *        - `ReadingArchiveController` (pure JS): given the latest
 *          state, decides which fetches to issue, which Abort
 *          calls to make, and which dispatch calls to fire. The
 *          controller is fully testable without a DOM.
 *
 *   3. Privacy: this layer never sees note text, comment, token
 *      body, wereadBookId, AI summaries. The token is only held
 *      in the React effect closure and is forwarded verbatim to
 *      `fetchWereadAnnualReview`; it never enters the reducer
 *      state and never appears in any selector result.
 *
 *   4. Persistence: all cache lives in reducer state (in-memory
 *      only). No browser storage is touched by this layer.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from "react";

import {
  fetchWereadAnnualReview,
  type FetchWereadAnnualReviewOptions,
  type WereadAnnualReviewResponse,
} from "../wereadPrivate";

import {
  DEFAULT_ARCHIVE_TOP_BOOKS,
  MAX_ARCHIVE_CONCURRENCY,
  createInitialArchiveMachineState,
  hasArchiveBootstrapData,
  makeArchiveCacheKey,
  parseArchiveCacheKey,
  reduceReadingArchiveState,
  selectArchiveFailedKeys,
  selectArchiveRequestsToStart,
  selectArchiveRequiredKeys,
  selectArchiveVisibleYears,
  type ArchiveCacheKey,
  type ArchiveRange,
  type ArchiveTopBooks,
  type ReadingArchiveAction,
  type ReadingArchiveMachineState,
} from "./wereadReadingArchiveState";

// ---------- public hook contract ----------

export interface UseReadingArchiveMachineOptions {
  token: string;
  active: boolean;
  /**
   * Override the fetch implementation. Defaults to
   * `fetchWereadAnnualReview`. Tests inject a synthetic fetch.
   */
  fetch?: ReadingArchiveFetchFn;
}

export interface UseReadingArchiveMachineResult {
  state: ReadingArchiveMachineState;

  bootstrapLoading: boolean;
  visibleYears: number[];
  cachedResponses: WereadAnnualReviewResponse[];
  failedKeys: ArchiveCacheKey[];
  loadedCount: number;
  requestedCount: number;

  setRange: (range: ArchiveRange) => void;
  setTopBooks: (topBooks: ArchiveTopBooks) => void;
  retryFailed: () => void;
  reloadBootstrap: () => void;
}

// ---------- internal: per-request abort + id bookkeeping ----------

export type ReadingArchiveFetchFn = (
  token: string,
  options: FetchWereadAnnualReviewOptions,
) => Promise<WereadAnnualReviewResponse>;

interface RequestHandle {
  controller: AbortController;
}

const MAX_CONCURRENCY = MAX_ARCHIVE_CONCURRENCY;

// ---------- pure controller (no React) ----------
//
// Encapsulates: "given the latest reducer state, what side effects
// should I trigger next?" The hook is a thin wrapper that drives
// `controller.tick(state)` on every state change.

export interface ReadingArchiveControllerDeps {
  /** Reducer dispatch function (useReducer's [state, dispatch]). */
  dispatch: (action: ReadingArchiveAction) => void;
  /** The actual fetch implementation. */
  fetch: ReadingArchiveFetchFn;
  /**
   * The token to use for fetches. May be empty string when
   * inactive. The controller never stores the token itself.
   */
  getToken: () => string;
  /** True iff the workspace tab is currently active. */
  getActive: () => boolean;
  /** Allocates a monotonic request id. */
  allocRequestId: () => number;
  /**
   * Optional callback fired whenever the controller starts a
   * fetch. Lets the hook record the AbortController for the
   * token-change / unmount paths. Tests can ignore this.
   */
  onInflight?: (requestId: number, controller: AbortController) => void;
  /**
   * Optional callback fired when the controller aborts everything
   * (token reset / unmount). Tests can ignore this.
   */
  onAbortAll?: () => void;
}

export class ReadingArchiveController {
  private readonly deps: ReadingArchiveControllerDeps;
  private destroyed = false;
  private lastActive: boolean;
  private lastToken: string;

  constructor(deps: ReadingArchiveControllerDeps) {
    this.deps = deps;
    this.lastActive = deps.getActive();
    this.lastToken = deps.getToken();
  }

  /** Mark the controller as disposed. Subsequent ticks are no-ops. */
  destroy(): void {
    this.destroyed = true;
  }

  /**
   * Called by the hook on every render. Inspects the latest state
   * and decides what to dispatch / fetch. Safe to call repeatedly;
   * the reducer + selectors make every dispatch idempotent.
   */
  tick(state: ReadingArchiveMachineState): void {
    if (this.destroyed) return;

    // Token change: reset the machine, abort everything, and
    // re-evaluate activation on the next tick.
    const currentToken = this.deps.getToken();
    if (currentToken !== this.lastToken) {
      const previousToken = this.lastToken;
      this.lastToken = currentToken;
      this.deps.onAbortAll?.();
      this.deps.dispatch({ type: "TOKEN_RESET" });
      // If we previously had a token and now have none, the
      // reducer will not bootstrap. If we previously had nothing
      // and now have a token, the active check below will fire
      // the bootstrap on the next tick.
      void previousToken;
      return;
    }

    if (!this.deps.getActive()) return;
    if (!currentToken) return;

    // Bootstrap (one-shot)
    if (state.bootstrap.status === "idle") {
      this.startBootstrap(currentToken, state.view.topBooks);
      return;
    }

    // Year scheduler (idempotent)
    if (!hasArchiveBootstrapData(state)) return;
    const toStart = selectArchiveRequestsToStart(state, MAX_CONCURRENCY);
    for (const key of toStart) {
      const existing = state.requests[key];
      if (existing && existing.status === "pending") continue;
      this.startYearFetch(currentToken, key);
    }
  }

  /**
   * Force a reload: abort everything, dispatch TOKEN_RESET, and
   * re-bootstrap on the next tick. Mirrors the user pressing the
   * "重新加载" button.
   */
  reload(): void {
    if (this.destroyed) return;
    this.deps.onAbortAll?.();
    this.deps.dispatch({ type: "TOKEN_RESET" });
    this.lastToken = this.deps.getToken();
  }

  /**
   * Retry every visible failed key. Emits a YEAR_RETRY_REQUESTED
   * action; the scheduler picks them up on the next tick.
   */
  retryFailed(state: ReadingArchiveMachineState): void {
    if (this.destroyed) return;
    const failed = selectArchiveFailedKeys(state);
    if (failed.length === 0) return;
    this.deps.dispatch({ type: "YEAR_RETRY_REQUESTED", keys: failed });
  }

  // ---------- internals ----------

  private startBootstrap(token: string, topBooks: ArchiveTopBooks): void {
    const requestId = this.deps.allocRequestId();
    this.deps.dispatch({ type: "BOOTSTRAP_STARTED", requestId });
    const controller = new AbortController();
    this.deps.onInflight?.(requestId, controller);
    void this.runFetch({
      token,
      options: { topBooks, signal: controller.signal },
      requestId,
      controller,
      kind: "bootstrap",
    });
  }

  private startYearFetch(token: string, key: ArchiveCacheKey): void {
    const requestId = this.deps.allocRequestId();
    this.deps.dispatch({ type: "YEAR_REQUEST_STARTED", key, requestId });
    const { year, topBooks } = parseArchiveCacheKey(key);
    const controller = new AbortController();
    this.deps.onInflight?.(requestId, controller);
    void this.runFetch({
      token,
      options: { year, topBooks, signal: controller.signal },
      requestId,
      controller,
      kind: "year",
      key,
    });
  }

  private async runFetch(args: {
    token: string;
    options: FetchWereadAnnualReviewOptions;
    requestId: number;
    controller: AbortController;
    kind: "bootstrap" | "year";
    key?: ArchiveCacheKey;
  }): Promise<void> {
    const { token, options, requestId, controller, kind, key } = args;
    try {
      const response = await this.deps.fetch(token, options);
      if (controller.signal.aborted) return;
      if (kind === "bootstrap") {
        this.deps.dispatch({
          type: "BOOTSTRAP_SUCCEEDED",
          requestId,
          response,
        });
      } else if (key) {
        this.deps.dispatch({
          type: "YEAR_REQUEST_SUCCEEDED",
          key,
          requestId,
          response,
        });
      }
    } catch (err: unknown) {
      if (controller.signal.aborted) return;
      const errorCode =
        err instanceof Error ? err.message || "fetch_failed" : "fetch_failed";
      if (kind === "bootstrap") {
        this.deps.dispatch({
          type: "BOOTSTRAP_FAILED",
          requestId,
          errorCode,
        });
      } else if (key) {
        this.deps.dispatch({
          type: "YEAR_REQUEST_FAILED",
          key,
          requestId,
          errorCode,
        });
      }
    }
  }

  /** Track activation transitions (currently unused but reserved). */
  onActiveChange(active: boolean): void {
    this.lastActive = active;
  }
}

// ---------- hook ----------

export function useReadingArchiveMachine(
  options: UseReadingArchiveMachineOptions,
): UseReadingArchiveMachineResult {
  const { token, active, fetch = fetchWereadAnnualReview } = options;

  const [state, dispatch] = useReducer(
    reduceReadingArchiveState,
    undefined,
    createInitialArchiveMachineState,
  );

  // Monotonic request-id counter.
  const nextRequestIdRef = useRef<number>(1);
  const allocRequestId = useCallback((): number => {
    const id = nextRequestIdRef.current;
    nextRequestIdRef.current += 1;
    return id;
  }, []);

  // Per-in-flight AbortController map, keyed by requestId. Only
  // the hook ever sees this; the controller / reducer do not.
  const inflightRef = useRef<Map<number, RequestHandle>>(new Map());
  const abortAll = useCallback(() => {
    for (const handle of inflightRef.current.values()) {
      try {
        handle.controller.abort();
      } catch {
        /* noop */
      }
    }
    inflightRef.current.clear();
  }, []);

  // Lazily-created controller. Recreated when fetch changes.
  const fetchRef = useRef<ReadingArchiveFetchFn>(fetch);
  fetchRef.current = fetch;

  const controllerRef = useRef<ReadingArchiveController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new ReadingArchiveController({
      dispatch,
      fetch: (t, o) => fetchRef.current(t, o),
      getToken: () => token,
      getActive: () => active,
      allocRequestId: () => allocRequestId(),
      onInflight: (requestId, controller) => {
        inflightRef.current.set(requestId, { controller });
        // Clean up our inflight map once the request settles. We
        // can do this here (instead of in runFetch) because the
        // controller only adds via onInflight and the entries
        // never need to outlive the fetch itself.
        const inflight = inflightRef.current;
        controller.signal.addEventListener("abort", () => {
          inflight.delete(requestId);
        });
      },
      onAbortAll: () => abortAll(),
    });
  }

  // Track current token / active via ref so the controller always
  // sees the latest values.
  const stateRef = useRef<ReadingArchiveMachineState>(state);
  stateRef.current = state;
  const tokenRef = useRef<string>(token);
  tokenRef.current = token;
  const activeRef = useRef<boolean>(active);
  activeRef.current = active;

  // Replace the controller's view of token/active on every render.
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.onActiveChange(active);
  }, [active]);

  // Drive the controller on every state change.
  useEffect(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.tick(state);
  });

  // Reset request-id counter on token change so the new epoch
  // starts fresh.
  const lastTokenRef = useRef<string>(token);
  useEffect(() => {
    if (lastTokenRef.current === token) return;
    lastTokenRef.current = token;
    nextRequestIdRef.current = 1;
    // Abort everything immediately on token change. The controller
    // will pick this up via the next tick.
    abortAll();
  }, [token, abortAll]);

  // Abort on unmount.
  useEffect(() => {
    return () => {
      const ctrl = controllerRef.current;
      if (ctrl) ctrl.destroy();
      abortAll();
    };
  }, [abortAll]);

  // ----- view + retry dispatchers (stable identities) -----
  const setRange = useCallback((range: ArchiveRange) => {
    dispatch({ type: "RANGE_CHANGED", range });
  }, []);
  const setTopBooks = useCallback((topBooks: ArchiveTopBooks) => {
    dispatch({ type: "TOP_BOOKS_CHANGED", topBooks });
  }, []);
  const retryFailed = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.retryFailed(stateRef.current);
  }, []);
  const reloadBootstrap = useCallback(() => {
    const ctrl = controllerRef.current;
    if (!ctrl) return;
    ctrl.reload();
  }, []);

  // ----- derived selectors -----
  const derived = useMemo(() => {
    const visibleYears = selectArchiveVisibleYears(state);
    const requiredKeys = selectArchiveRequiredKeys(state);
    const cachedResponses: WereadAnnualReviewResponse[] = [];
    for (const k of requiredKeys) {
      const v = state.cache[k];
      if (v) cachedResponses.push(v);
    }
    const failedKeys = selectArchiveFailedKeys(state);
    const loadedCount = requiredKeys.reduce(
      (acc, k) => (state.cache[k] ? acc + 1 : acc),
      0,
    );
    const requestedCount = requiredKeys.length;
    const bootstrapLoading = state.bootstrap.status === "loading";
    return {
      visibleYears,
      cachedResponses,
      failedKeys,
      loadedCount,
      requestedCount,
      bootstrapLoading,
    };
  }, [state]);

  return {
    state,
    bootstrapLoading: derived.bootstrapLoading,
    visibleYears: derived.visibleYears,
    cachedResponses: derived.cachedResponses,
    failedKeys: derived.failedKeys,
    loadedCount: derived.loadedCount,
    requestedCount: derived.requestedCount,
    setRange,
    setTopBooks,
    retryFailed,
    reloadBootstrap,
  };
}

// Re-export commonly used pieces for convenience.
export {
  DEFAULT_ARCHIVE_TOP_BOOKS,
  makeArchiveCacheKey,
  parseArchiveCacheKey,
  selectArchiveRequestsToStart,
  selectArchiveRequiredKeys,
  selectArchiveVisibleYears,
  selectArchiveFailedKeys,
};
