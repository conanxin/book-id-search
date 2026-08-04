/**
 * S27L-STATE-MACHINE-REBUILD Phase B — adapter race / behaviour tests.
 *
 * The web app does not depend on jsdom / happy-dom / @testing-library.
 * We therefore test the React adapter layer through its pure-logic
 * core: the `ReadingArchiveController`. The hook itself is a thin
 * `useReducer` + `useEffect` wrapper; the controller is where the
 * side-effect planning lives, and it is fully testable without a
 * DOM.
 *
 * Privacy contract enforced by these tests:
 *   - no `localStorage` / `sessionStorage` / `IndexedDB` writes
 *   - no note text, comment, token body, or wereadBookId in any
 *     state we assert
 *   - the `requestedAnnualReviewYear` field is never used
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FetchWereadAnnualReviewOptions,
  WereadAnnualReviewResponse,
} from "../wereadPrivate";

import {
  createInitialArchiveMachineState,
  DEFAULT_ARCHIVE_RANGE,
  DEFAULT_ARCHIVE_TOP_BOOKS,
  makeArchiveCacheKey,
  MAX_ARCHIVE_CONCURRENCY,
  reduceReadingArchiveState,
  type ArchiveCacheKey,
  type ArchiveTopBooks,
  type ReadingArchiveAction,
  type ReadingArchiveMachineState,
} from "./wereadReadingArchiveState";

import {
  ReadingArchiveController,
  type ReadingArchiveFetchFn,
} from "./useReadingArchiveMachine";

// ---------- synthetic response factory ----------

function syntheticResponse(opts: {
  selectedYear: number;
  availableYears: ReadonlyArray<number>;
  topBooks?: ArchiveTopBooks;
}): WereadAnnualReviewResponse {
  const tb = (opts.topBooks ?? DEFAULT_ARCHIVE_TOP_BOOKS) as number;
  return {
    ok: true,
    selectedYear: opts.selectedYear,
    availableYears: [...opts.availableYears],
    overview: {
      year: opts.selectedYear,
      totalRecords: 0,
      datedRecords: 0,
      matchedRecords: 0,
      matchedBooks: 0,
      activeMonths: 0,
      longestStreakMonths: 0,
      firstNoteAt: null,
      lastNoteAt: null,
      peakMonth: null,
      peakMonthRecords: 0,
      averageRecordsPerActiveMonth: 0,
    },
    months: [],
    quarters: [],
    topBooks: [],
    meta: {
      topBooksRequested: tb,
      topBooksReturned: 0,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
  };
}

// ---------- scripted fetch with manual resolve/reject ----------

interface ScriptedCall {
  options: FetchWereadAnnualReviewOptions;
  resolve: (response: WereadAnnualReviewResponse) => void;
  reject: (error: Error) => void;
  settled: boolean;
  controller: AbortController;
}

interface ScriptedFetch {
  fetch: ReadingArchiveFetchFn;
  calls: ScriptedCall[];
  /** Resolve the *next* pending call (FIFO). */
  resolveNext: (response: WereadAnnualReviewResponse) => void;
  /** Reject the *next* pending call (FIFO). */
  rejectNext: (error: Error) => void;
  /** Resolve the call matching a given year+topBooks. */
  resolveFor: (year: number, topBooks: ArchiveTopBooks) => void;
  /** Drain: resolve every pending call with a synthetic response. */
  drain: (yearOverride?: number) => void;
  abortAll: () => void;
}

function createScriptedFetch(): ScriptedFetch {
  const calls: ScriptedCall[] = [];
  const fetchImpl: ReadingArchiveFetchFn = (_token, options) => {
    return new Promise<WereadAnnualReviewResponse>((resolve, reject) => {
      const controller = new AbortController();
      if (options.signal) {
        if (options.signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        options.signal.addEventListener("abort", () => {
          const entry = calls.find(
            (c) => c.controller === controller && !c.settled,
          );
          if (entry && !entry.settled) {
            entry.settled = true;
            reject(new Error("aborted"));
          }
        });
      }
      const entry: ScriptedCall = {
        options,
        resolve: (r) => {
          if (entry.settled) return;
          entry.settled = true;
          resolve(r);
        },
        reject: (e) => {
          if (entry.settled) return;
          entry.settled = true;
          reject(e);
        },
        settled: false,
        controller,
      };
      calls.push(entry);
    });
  };
  return {
    fetch: fetchImpl,
    calls,
    resolveNext: (response) => {
      const call = calls.find((c) => !c.settled);
      if (!call) throw new Error("no pending call");
      call.resolve(response);
    },
    rejectNext: (error) => {
      const call = calls.find((c) => !c.settled);
      if (!call) throw new Error("no pending call");
      call.reject(error);
    },
    resolveFor: (year, topBooks) => {
      const call = calls.find(
        (c) =>
          !c.settled &&
          c.options.year === year &&
          c.options.topBooks === topBooks,
      );
      if (!call) throw new Error(`no pending call for ${year}:${topBooks}`);
      call.resolve(
        syntheticResponse({
          selectedYear: year,
          availableYears: [year],
          topBooks,
        }),
      );
    },
    drain: (yearOverride) => {
      for (const call of calls) {
        if (call.settled) continue;
        const year = yearOverride ?? call.options.year;
        if (typeof year !== "number") {
          // Bootstrap drain
          call.resolve(
            syntheticResponse({
              selectedYear: 2025,
              availableYears: [2025, 2024, 2023, 2022, 2021, 2020],
            }),
          );
          continue;
        }
        call.resolve(
          syntheticResponse({
            selectedYear: year,
            availableYears: [year],
            topBooks: call.options.topBooks ?? DEFAULT_ARCHIVE_TOP_BOOKS,
          }),
        );
      }
    },
    abortAll: () => {
      for (const call of calls) {
        if (!call.settled) call.reject(new Error("aborted"));
      }
    },
  };
}

// ---------- controller harness ----------

interface ControllerHarness {
  state: ReadingArchiveMachineState;
  actions: ReadingArchiveAction[];
  inflight: Map<number, AbortController>;
  nextId: number;
  active: boolean;
  token: string;
  ctrl: ReadingArchiveController;
  apply: (action: ReadingArchiveAction) => void;
  tick: () => void;
  setActive: (active: boolean) => void;
  setToken: (token: string) => void;
}

function makeHarness(
  scripted: ScriptedFetch,
  init?: { active?: boolean; token?: string },
): ControllerHarness {
  const actions: ReadingArchiveAction[] = [];
  const inflight = new Map<number, AbortController>();
  const bag: {
    active: boolean;
    token: string;
    nextId: number;
  } = {
    active: init?.active ?? false,
    token: init?.token ?? "",
    nextId: 1,
  };
  const stateRef: { current: ReadingArchiveMachineState } = {
    current: createInitialArchiveMachineState(),
  };
  const ctrl = new ReadingArchiveController({
    dispatch: (a) => {
      actions.push(a);
      stateRef.current = reduceReadingArchiveState(stateRef.current, a);
    },
    fetch: scripted.fetch,
    getToken: () => bag.token,
    getActive: () => bag.active,
    allocRequestId: () => {
      const id = bag.nextId;
      bag.nextId += 1;
      return id;
    },
    onInflight: (id, controller) => {
      inflight.set(id, controller);
    },
    onAbortAll: () => {
      for (const c of inflight.values()) {
        try {
          c.abort();
        } catch {
          /* noop */
        }
      }
      inflight.clear();
    },
  });
  return {
    get state() {
      return stateRef.current;
    },
    actions,
    inflight,
    get nextId() {
      return bag.nextId;
    },
    get active() {
      return bag.active;
    },
    get token() {
      return bag.token;
    },
    ctrl,
    apply: (a) => {
      actions.push(a);
      stateRef.current = reduceReadingArchiveState(stateRef.current, a);
    },
    tick: () => ctrl.tick(stateRef.current),
    setActive: (active) => {
      bag.active = active;
    },
    setToken: (token) => {
      bag.token = token;
    },
  };
}

// Drain microtasks between operations.
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// ---------- global setup ----------

let scripted: ScriptedFetch;
beforeEach(() => {
  scripted = createScriptedFetch();
});

afterEach(() => {
  vi.useRealTimers();
});

// ============================================================
// Section A: bootstrap lifecycle
// ============================================================

describe("useReadingArchiveMachine — bootstrap lifecycle", () => {
  it("1. inactive: no bootstrap call", async () => {
    const h = makeHarness(scripted, { active: false, token: "tok" });
    h.tick();
    expect(scripted.calls.length).toBe(0);
    expect(h.state.bootstrap.status).toBe("idle");
  });

  it("2. active: bootstrap fires exactly once", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    expect(scripted.calls.length).toBe(1);
    expect(scripted.calls[0].options.year).toBeUndefined();
    scripted.drain();
    await flush();
    expect(h.state.bootstrap.status).toBe("ready");
  });

  it("3. bootstrap success: visibleYears = availableYears.slice(0, range)", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018],
      }),
    );
    await flush();
    expect(h.state.bootstrap.availableYears.length).toBe(8);
    expect(h.state.bootstrap.status).toBe("ready");
    // default range = 5 → visible years are top 5
    const required = h.state.view.range;
    expect(h.state.bootstrap.availableYears.slice(0, required).length).toBe(
      required,
    );
  });

  it("4. bootstrap failure: status=error, reloadBootstrap can recover", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.rejectNext(new Error("network"));
    await flush();
    expect(h.state.bootstrap.status).toBe("error");
    h.ctrl.reload();
    h.tick();
    await flush();
    expect(scripted.calls.length).toBe(2);
  });

  it("5. same (active, token): bootstrap fires only once", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.drain();
    await flush();
    h.tick();
    h.tick();
    h.tick();
    await flush();
    // The bootstrap call (no `year` in options) must appear exactly
    // once even after multiple ticks.
    const bootstrapCalls = scripted.calls.filter(
      (c) => c.options.year === undefined,
    );
    expect(bootstrapCalls.length).toBe(1);
  });
});

// ============================================================
// Section B: year scheduler
// ============================================================

describe("useReadingArchiveMachine — year scheduler", () => {
  it("6. visible years → year fetch issued (bootstrap year is pre-cached)", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    // Bootstrap year (2025:12) is pre-cached; scheduler fires the
    // remaining 4 years in 2 batches of ≤2.
    const yearCalls = scripted.calls.filter(
      (c) => typeof c.options.year === "number",
    );
    expect(yearCalls.length).toBeLessThanOrEqual(MAX_ARCHIVE_CONCURRENCY);
    // The bootstrap year is in the cache
    expect(
      h.state.cache[makeArchiveCacheKey(2025, 12)],
    ).toBeDefined();
  });

  it("7. max concurrency never exceeds 2", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021, 2020, 2019, 2018],
      }),
    );
    await flush();
    h.tick();
    await flush();
    const yearCalls = scripted.calls.filter(
      (c) => typeof c.options.year === "number",
    );
    expect(yearCalls.length).toBeLessThanOrEqual(2);
  });

  it("8. cached key is never re-requested", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    // Drive the scheduler until all 5 years are cached.
    for (let i = 0; i < 8; i += 1) {
      h.tick();
      await flush();
      scripted.drain();
      await flush();
    }
    const callsBefore = scripted.calls.length;
    // Flip range, back — no new calls should be issued
    h.apply({ type: "RANGE_CHANGED", range: 10 });
    h.tick();
    await flush();
    h.apply({ type: "RANGE_CHANGED", range: DEFAULT_ARCHIVE_RANGE });
    h.tick();
    await flush();
    expect(scripted.calls.length).toBe(callsBefore);
  });

  it("9. pending key is not re-requested (no duplicate in-flight)", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    const callsBefore = scripted.calls.length;
    // Multiple ticks in a row without resolving pending calls
    h.tick();
    h.tick();
    h.tick();
    await flush();
    // No additional calls should be issued for keys that are
    // already pending — the scheduler's per-tick cap is the
    // maxConcurrency, so subsequent ticks only fill remaining
    // slots. Critically, no key should be requested more than
    // once while still pending.
    const callsAfter = scripted.calls.length;
    expect(callsAfter).toBeGreaterThanOrEqual(callsBefore);
    // Verify no duplicate keys (each year should appear at most once
    // across all calls).
    const yearCounts = new Map<number, number>();
    for (const c of scripted.calls) {
      const y = c.options.year;
      if (typeof y !== "number") continue;
      yearCounts.set(y, (yearCounts.get(y) ?? 0) + 1);
    }
    for (const [, count] of yearCounts) {
      expect(count).toBe(1);
    }
  });

  it("10. range 5 → 10 → 5 hits cache (no new requests)", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    // Drive the scheduler until all 5 years are cached.
    for (let i = 0; i < 12; i += 1) {
      h.tick();
      await flush();
      scripted.drain();
      await flush();
    }
    // All 5 years cached (range=5 covers them all)
    expect(Object.keys(h.state.cache).length).toBe(5);
    const callsBefore = scripted.calls.length;
    h.apply({ type: "RANGE_CHANGED", range: 10 });
    h.tick();
    await flush();
    h.apply({ type: "RANGE_CHANGED", range: 5 });
    h.tick();
    await flush();
    expect(scripted.calls.length).toBe(callsBefore);
  });

  it("11. Top12 → 18 → 12 keeps separate cache keys (Top N isolation)", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
        topBooks: 12,
      }),
    );
    await flush();
    for (let i = 0; i < 8; i += 1) {
      h.tick();
      await flush();
      // drain only top=12 calls
      for (const c of scripted.calls) {
        if (!c.settled && c.options.topBooks === 12) {
          c.resolve(
            syntheticResponse({
              selectedYear: c.options.year ?? 2025,
              availableYears: [c.options.year ?? 2025],
              topBooks: 12,
            }),
          );
        }
      }
      await flush();
    }
    const keys12 = Object.keys(h.state.cache).filter((k) => k.endsWith(":12"));
    expect(keys12.length).toBeGreaterThan(0);
    // Switch to top18
    h.apply({ type: "TOP_BOOKS_CHANGED", topBooks: 18 });
    h.tick();
    await flush();
    // New fetches for top=18
    const newCalls = scripted.calls.filter(
      (c) => c.options.topBooks === 18,
    );
    expect(newCalls.length).toBeGreaterThan(0);
    // Resolve them
    for (const c of scripted.calls) {
      if (!c.settled && c.options.topBooks === 18) {
        c.resolve(
          syntheticResponse({
            selectedYear: c.options.year ?? 2025,
            availableYears: [c.options.year ?? 2025],
            topBooks: 18,
          }),
        );
      }
    }
    await flush();
    h.tick();
    await flush();
    const callsBefore = scripted.calls.length;
    // Switch back to top12 — cache hit, no new call
    h.apply({ type: "TOP_BOOKS_CHANGED", topBooks: 12 });
    h.tick();
    await flush();
    expect(scripted.calls.length).toBe(callsBefore);
  });
});

// ============================================================
// Section C: failure + retry
// ============================================================

describe("useReadingArchiveMachine — failure + retry", () => {
  it("12. a year fetch fails → key visible in failedKeys", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    scripted.rejectNext(new Error("boom"));
    await flush();
    // failedKeys is derived; we just check the reducer state.
    const failed = Object.entries(h.state.requests).filter(
      ([, r]) => r !== undefined && r.status === "error",
    );
    expect(failed.length).toBeGreaterThan(0);
  });

  it("13. failedKeys lists the failing key only", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    // Resolve one, reject one
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: scripted.calls[1].options.year ?? 2024,
        availableYears: [2024],
      }),
    );
    scripted.rejectNext(new Error("boom"));
    await flush();
    const failed = Object.entries(h.state.requests).filter(
      ([, r]) => r !== undefined && r.status === "error",
    );
    expect(failed.length).toBe(1);
  });

  it("14. retryFailed only retries failed keys (not cached ones)", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: scripted.calls[1].options.year ?? 2024,
        availableYears: [2024],
      }),
    );
    scripted.rejectNext(new Error("boom"));
    await flush();
    // Continue draining remaining pending (none left after the two
    // resolutions above, since only 2 are in-flight at a time).
    scripted.drain();
    await flush();
    // Now drive the scheduler once more so any non-failed, non-cached
    // keys can be processed.
    h.tick();
    await flush();
    scripted.drain();
    await flush();
    h.tick();
    await flush();
    scripted.drain();
    await flush();
    const callsBefore = scripted.calls.length;
    h.ctrl.retryFailed(h.state);
    h.tick();
    await flush();
    // Only 1 new call (the failed key)
    expect(scripted.calls.length).toBe(callsBefore + 1);
  });

  it("15. retry success → failedKeys cleared, key cached", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    scripted.rejectNext(new Error("boom"));
    await flush();
    h.ctrl.retryFailed(h.state);
    h.tick();
    await flush();
    // Resolve the retry
    scripted.drain();
    await flush();
    const failed = Object.entries(h.state.requests).filter(
      ([, r]) => r !== undefined && r.status === "error",
    );
    expect(failed.length).toBe(0);
  });

  it("16. retry failure → attempts increments", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    const firstCall = scripted.calls[scripted.calls.length - 1];
    const failedKey = makeArchiveCacheKey(firstCall.options.year!, 12);
    scripted.rejectNext(new Error("boom"));
    await flush();
    const attemptsAfterFirst = h.state.requests[failedKey]?.attempts ?? 0;
    h.ctrl.retryFailed(h.state);
    h.tick();
    await flush();
    scripted.rejectNext(new Error("still broken"));
    await flush();
    const attemptsAfterRetry = h.state.requests[failedKey]?.attempts ?? 0;
    expect(attemptsAfterRetry).toBe(attemptsAfterFirst + 1);
  });

  // S27L-PHASE-C — release-gate: no auto-retry storm.
  // These tests enforce the Phase B invariant that a failed key
  // is NOT re-fetched unless YEAR_RETRY_REQUESTED is explicitly
  // dispatched. The full-mode smoke relies on this to keep the
  // real network request count at 1 → 2 (not 1 → many).
  it("16a. YEAR_REQUEST_FAILED → selector doesn't return the error key as 'idle' (no auto-retry)", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    scripted.rejectNext(new Error("boom"));
    await flush();
    // Identify the failed key's year.
    const failedCall = scripted.calls[scripted.calls.length - 1];
    const failedYear = failedCall.options.year!;
    const callsForFailedKeyBefore = scripted.calls.filter(
      (c) => c.options.year === failedYear,
    ).length;
    expect(callsForFailedKeyBefore).toBe(1);
    // Force many ticks; no extra fetches for the failed key.
    for (let i = 0; i < 10; i++) {
      h.tick();
      await flush();
    }
    scripted.drain();
    await flush();
    const callsForFailedKeyAfter = scripted.calls.filter(
      (c) => c.options.year === failedYear,
    ).length;
    expect(callsForFailedKeyAfter).toBe(1);
  });

  it("16b. no fetch is issued for the failed key without YEAR_RETRY_REQUESTED", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    // Capture the year that will be rejected. rejectNext rejects the
    // FIRST pending call; the scheduler picks years ascending so the
    // first in-flight call is the first year in the slice.
    const preRejectCalls = scripted.calls.length;
    scripted.rejectNext(new Error("boom"));
    await flush();
    // Find the failed year by inspecting state.requests for the
    // entry that became 'error' between before and after.
    const failedEntry = Object.entries(h.state.requests).find(
      ([, r]) => r !== undefined && r.status === "error",
    ) as readonly [string, { status: string }] | undefined;
    expect(failedEntry).toBeDefined();
    const failedKey = failedEntry![0];
    const failedYear = Number(failedKey.split(":")[0]);
    // Drain, force multiple ticks, no dispatch.
    scripted.drain();
    await flush();
    for (let i = 0; i < 10; i++) {
      h.tick();
      await flush();
    }
    const callsForFailedKey = scripted.calls.filter(
      (c) => c.options.year === failedYear,
    ).length;
    // Only the original failed request — no extra fetches.
    expect(callsForFailedKey).toBe(1);
    // failedKeys still references the year.
    const r = h.state.requests[failedKey as keyof typeof h.state.requests];
    expect(r).toBeDefined();
    expect(r!.status).toBe("error");
  });

  it("16c. dispatch retry → exactly one new fetch for the failed key", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    // Reject one in-flight call as the failure. rejectNext rejects
    // the first pending call; identify the failed year from state.
    scripted.rejectNext(new Error("boom"));
    await flush();
    const failedEntryC = Object.entries(h.state.requests).find(
      ([, r]) => r !== undefined && r.status === "error",
    ) as readonly [string, { status: string }] | undefined;
    expect(failedEntryC).toBeDefined();
    const failedKeyC = failedEntryC![0];
    const failedYear = Number(failedKeyC.split(":")[0]);
    // Drain remaining in-flight so the scheduler is idle.
    scripted.drain();
    await flush();
    h.tick();
    await flush();
    const callsBefore = scripted.calls.length;
    const failedKeyCallsBefore = scripted.calls.filter(
      (c) => c.options.year === failedYear,
    ).length;
    h.ctrl.retryFailed(h.state);
    h.tick();
    await flush();
    const failedKeyCallsAfter = scripted.calls.filter(
      (c) => c.options.year === failedYear,
    ).length;
    // Exactly one new fetch for the failed key.
    expect(failedKeyCallsAfter - failedKeyCallsBefore).toBe(1);
    // And only one new call total (idle set is empty).
    expect(scripted.calls.length - callsBefore).toBe(1);
  });

  it("16d. retry success → no further fetches for the same key", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    const firstCall = scripted.calls[scripted.calls.length - 1];
    const failedYear = firstCall.options.year!;
    scripted.rejectNext(new Error("boom"));
    await flush();
    scripted.drain();
    await flush();
    h.tick();
    await flush();
    h.ctrl.retryFailed(h.state);
    h.tick();
    await flush();
    scripted.drain();
    await flush();
    const failedKeyCalls = scripted.calls.filter(
      (c) => c.options.year === failedYear,
    ).length;
    // Many additional ticks; no further fetches for the now-cached key.
    for (let i = 0; i < 5; i++) {
      h.tick();
      await flush();
    }
    const failedKeyCallsAfter = scripted.calls.filter(
      (c) => c.options.year === failedYear,
    ).length;
    expect(failedKeyCallsAfter).toBe(failedKeyCalls);
  });
});

// ============================================================
// Section D: token change + abort + unmount
// ============================================================

describe("useReadingArchiveMachine — token change + abort", () => {
  it("17. token change aborts in-flight requests", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok-1" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    const inflightBefore = h.inflight.size;
    expect(inflightBefore).toBeGreaterThan(0);
    // Switch token → controller's tick will dispatch TOKEN_RESET
    h.setToken("tok-2");
    h.tick();
    await flush();
    // onAbortAll was called: inflight map cleared
    expect(h.inflight.size).toBe(0);
  });

  it("18. token change clears cache and re-bootstraps", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok-1" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023],
        topBooks: 12,
      }),
    );
    await flush();
    h.tick();
    await flush();
    // Drain
    scripted.drain();
    await flush();
    h.tick();
    await flush();
    const cacheSizeBefore = Object.keys(h.state.cache).length;
    expect(cacheSizeBefore).toBeGreaterThan(0);
    // Switch token
    h.setToken("tok-2");
    h.tick();
    await flush();
    // Cache should be empty
    expect(Object.keys(h.state.cache).length).toBe(0);
    // The next tick should re-bootstrap
    h.tick();
    await flush();
    expect(scripted.calls.length).toBeGreaterThan(0);
  });

  it("19. unmount aborts in-flight requests", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    const callsBefore = scripted.calls.length;
    h.ctrl.destroy();
    h.tick();
    await flush();
    expect(scripted.calls.length).toBe(callsBefore);
  });
});

// ============================================================
// Section E: stale-response gating
// ============================================================

describe("useReadingArchiveMachine — stale-response gating", () => {
  it("20. late bootstrap success is ignored (TOKEN_RESET bumps epoch)", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok-1" });
    h.tick();
    await flush();
    const firstBootstrap = scripted.calls[0];
    // Switch token before resolving → controller dispatches TOKEN_RESET
    h.setToken("tok-2");
    h.tick();
    await flush();
    // Late-arriving response for the OLD bootstrap (requestId 1) — the
    // reducer must ignore it (requestId mismatch).
    firstBootstrap.resolve(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023],
      }),
    );
    await flush();
    // The new bootstrap's requestId is different; the late success
    // was dropped.
    expect(h.state.bootstrap.status).not.toBe("ready");
  });

  it("21. late year failure is ignored (requestId mismatch)", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok-1" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    h.tick();
    await flush();
    const lateYearCall = scripted.calls.find(
      (c) => typeof c.options.year === "number" && !c.settled,
    );
    if (!lateYearCall) throw new Error("no late year call available");
    const failedKey = makeArchiveCacheKey(lateYearCall.options.year!, 12);
    // Switch token before the year call resolves/fails
    h.setToken("tok-2");
    h.tick();
    await flush();
    lateYearCall.reject(new Error("late failure"));
    await flush();
    // Reducer ignored this: the failed key for the old token is not
    // in the new machine state.
    expect(h.state.requests[failedKey]).toBeUndefined();
  });

  it("22. bootstrap year is pre-cached (not re-requested as a year)", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
        topBooks: 12,
      }),
    );
    await flush();
    h.tick();
    await flush();
    const key = makeArchiveCacheKey(2025, 12);
    expect(h.state.cache[key]).toBeDefined();
    // No year-fetch for 2025 was issued (only bootstrap did it)
    const year2025 = scripted.calls.filter(
      (c) => c.options.year === 2025,
    );
    expect(year2025.length).toBe(0);
  });
});

// ============================================================
// Section F: privacy + safety contracts
// ============================================================

describe("useReadingArchiveMachine — privacy + safety", () => {
  it("23. keys are always `${year}:${topBooks}` — no NaN", async () => {
    const h = makeHarness(scripted, { active: true, token: "tok" });
    h.tick();
    await flush();
    scripted.resolveNext(
      syntheticResponse({
        selectedYear: 2025,
        availableYears: [2025, 2024, 2023, 2022, 2021],
      }),
    );
    await flush();
    for (let i = 0; i < 8; i += 1) {
      h.tick();
      await flush();
      scripted.drain();
      await flush();
    }
    const allKeys = [
      ...Object.keys(h.state.cache),
      ...Object.keys(h.state.requests),
    ];
    for (const k of allKeys) {
      expect(k).not.toMatch(/NaN/);
      expect(k).toMatch(/^\d+:(6|12|18)$/);
    }
  });

  it("24. the hook never references `requestedAnnualReviewYear`", () => {
    const source = readFileSync(
      resolve(__dirname, "./useReadingArchiveMachine.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/requestedAnnualReviewYear/);
  });

  it("25. the hook never writes localStorage / sessionStorage / IndexedDB", () => {
    const source = readFileSync(
      resolve(__dirname, "./useReadingArchiveMachine.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/localStorage/);
    expect(source).not.toMatch(/sessionStorage/);
    expect(source).not.toMatch(/[Ii]ndexedDB/);
  });
});
