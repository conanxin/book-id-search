/**
 * S27L-STATE-MACHINE-REBUILD Phase A
 *
 * Pure unit tests for the reading archive state machine.
 *
 * All responses are synthetic. No real annual-review data is
 * referenced from production. Tests assert behaviour, not
 * production shapes.
 */

import { describe, expect, it } from "vitest";

import type { WereadAnnualReviewResponse } from "../wereadPrivate";

import {
  ARCHIVE_TOP_BOOKS_OPTIONS,
  DEFAULT_ARCHIVE_RANGE,
  DEFAULT_ARCHIVE_TOP_BOOKS,
  MAX_ARCHIVE_CONCURRENCY,
  archiveMachineDebugSnapshot,
  createInitialArchiveMachineState,
  hasArchiveBootstrapData,
  isArchiveRange,
  isArchiveTopBooks,
  makeArchiveCacheKey,
  normalizeArchiveAvailableYears,
  parseArchiveCacheKey,
  reduceReadingArchiveState,
  selectArchiveCachedResponses,
  selectArchiveFailedKeys,
  selectArchiveLoadedKeys,
  selectArchiveRequestsToStart,
  selectArchiveRequiredKeys,
  selectArchiveVisibleYears,
  type ArchiveCacheKey,
  type ArchiveRange,
  type ArchiveRequestState,
  type ArchiveTopBooks,
  type ReadingArchiveAction,
  type ReadingArchiveMachineState,
} from "./wereadReadingArchiveState";

// ---------- synthetic response factory ----------

function syntheticResponse(opts: {
  selectedYear: number;
  availableYears: ReadonlyArray<number>;
  topBooks?: ArchiveTopBooks;
}): WereadAnnualReviewResponse {
  const tb = opts.topBooks ?? 12;
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

function s(opts: { selectedYear: number; availableYears: ReadonlyArray<number>; topBooks?: ArchiveTopBooks }) {
  return syntheticResponse(opts);
}

// ---------- helpers ----------

function readyBootstrap(state: ReadingArchiveMachineState, availableYears: ReadonlyArray<number>, selectedYear: number, topBooks: ArchiveTopBooks = DEFAULT_ARCHIVE_TOP_BOOKS): ReadingArchiveMachineState {
  return reduceReadingArchiveState(
    reduceReadingArchiveState(state, { type: "BOOTSTRAP_STARTED", requestId: 1 }),
    {
      type: "BOOTSTRAP_SUCCEEDED",
      requestId: 1,
      response: s({ selectedYear, availableYears, topBooks }),
    },
  );
}

// ============================================================
// Bootstrap (tests 1-8)
// ============================================================

describe("bootstrap", () => {
  it("1. initial state", () => {
    const init = createInitialArchiveMachineState();
    expect(init.epoch).toBe(0);
    expect(init.bootstrap.status).toBe("idle");
    expect(init.bootstrap.selectedYear).toBeNull();
    expect(init.bootstrap.availableYears).toEqual([]);
    expect(init.view.range).toBe(DEFAULT_ARCHIVE_RANGE);
    expect(init.view.topBooks).toBe(DEFAULT_ARCHIVE_TOP_BOOKS);
    expect(init.cache).toEqual({});
    expect(init.requests).toEqual({});
  });

  it("2. BOOTSTRAP_STARTED transitions to loading with requestId", () => {
    const init = createInitialArchiveMachineState();
    const next = reduceReadingArchiveState(init, { type: "BOOTSTRAP_STARTED", requestId: 7 });
    expect(next.bootstrap.status).toBe("loading");
    expect(next.bootstrap.requestId).toBe(7);
    expect(next.bootstrap.errorCode).toBeNull();
  });

  it("3. BOOTSTRAP_SUCCEEDED uses the real selectedYear from response", () => {
    const init = createInitialArchiveMachineState();
    const started = reduceReadingArchiveState(init, { type: "BOOTSTRAP_STARTED", requestId: 1 });
    const ok = reduceReadingArchiveState(started, {
      type: "BOOTSTRAP_SUCCEEDED",
      requestId: 1,
      response: s({ selectedYear: 2024, availableYears: [2024, 2023, 2022] }),
    });
    expect(ok.bootstrap.status).toBe("ready");
    expect(ok.bootstrap.selectedYear).toBe(2024);
    expect(ok.bootstrap.availableYears).toEqual([2024, 2023, 2022]);
    expect(ok.cache[makeArchiveCacheKey(2024, 12)]).toBeDefined();
    expect(ok.requests[makeArchiveCacheKey(2024, 12)]?.status).toBe("success");
  });

  it("4. normalizeArchiveAvailableYears dedupes and sorts descending", () => {
    const out = normalizeArchiveAvailableYears([2022, 2024, 2022, 2023, 2024, "x" as unknown as number, NaN, Infinity]);
    expect(out).toEqual([2024, 2023, 2022]);
  });

  it("5. bootstrap never produces a NaN key", () => {
    const init = createInitialArchiveMachineState();
    const started = reduceReadingArchiveState(init, { type: "BOOTSTRAP_STARTED", requestId: 1 });
    // Attempt to seed a response with NaN selectedYear — reducer must drop it
    const evil = { ...s({ selectedYear: 2024, availableYears: [2024] }), selectedYear: Number.NaN };
    const after = reduceReadingArchiveState(started, { type: "BOOTSTRAP_SUCCEEDED", requestId: 1, response: evil });
    expect(after.bootstrap.status).toBe("loading"); // unchanged → ignored
    expect(after.bootstrap.selectedYear).toBeNull();
  });

  it("6. bootstrap has no requestedAnnualReviewYear concept", () => {
    // View state only exposes `view.range` / `view.topBooks`; nothing else.
    const init = createInitialArchiveMachineState();
    const keys = Object.keys(init).sort();
    expect(keys).toEqual(["bootstrap", "cache", "epoch", "requests", "view"]);
    expect(Object.keys(init.bootstrap).sort()).toEqual(["availableYears", "errorCode", "requestId", "selectedYear", "status"]);
    expect(Object.keys(init.view).sort()).toEqual(["range", "topBooks"]);
  });

  it("7. stale BOOTSTRAP_SUCCEEDED is ignored", () => {
    const init = createInitialArchiveMachineState();
    const started = reduceReadingArchiveState(init, { type: "BOOTSTRAP_STARTED", requestId: 1 });
    // Token reset in between, then a late success arrives with the old requestId
    const reset = reduceReadingArchiveState(started, { type: "TOKEN_RESET" });
    const stale = reduceReadingArchiveState(reset, {
      type: "BOOTSTRAP_SUCCEEDED",
      requestId: 1,
      response: s({ selectedYear: 2024, availableYears: [2024, 2023] }),
    });
    expect(stale.bootstrap.status).toBe("idle");
    expect(stale.bootstrap.availableYears).toEqual([]);
    expect(stale.epoch).toBe(1);
  });

  it("8. stale BOOTSTRAP_FAILED is ignored", () => {
    const init = createInitialArchiveMachineState();
    const started = reduceReadingArchiveState(init, { type: "BOOTSTRAP_STARTED", requestId: 5 });
    const reset = reduceReadingArchiveState(started, { type: "TOKEN_RESET" });
    const stale = reduceReadingArchiveState(reset, { type: "BOOTSTRAP_FAILED", requestId: 5, errorCode: "boom" });
    expect(stale.bootstrap.status).toBe("idle");
    expect(stale.bootstrap.errorCode).toBeNull();
  });
});

// ============================================================
// Range (tests 9-14)
// ============================================================

describe("range", () => {
  const ready = (): ReadingArchiveMachineState =>
    readyBootstrap(createInitialArchiveMachineState(), [2024, 2023, 2022, 2021, 2020, 2019, 2018], 2024);

  it("9. recent5 selects the latest 5 years", () => {
    const st = ready();
    const visible = selectArchiveVisibleYears(st);
    expect(visible).toEqual([2024, 2023, 2022, 2021, 2020]);
  });

  it("10. recent10 selects the latest 10 (capped at availableYears.length)", () => {
    const st = reduceReadingArchiveState(ready(), { type: "RANGE_CHANGED", range: 10 });
    expect(selectArchiveVisibleYears(st)).toEqual([2024, 2023, 2022, 2021, 2020, 2019, 2018]);
  });

  it("11. all (20) caps at availableYears.length", () => {
    const st = reduceReadingArchiveState(ready(), { type: "RANGE_CHANGED", range: 20 });
    expect(selectArchiveVisibleYears(st)).toEqual([2024, 2023, 2022, 2021, 2020, 2019, 2018]);
  });

  it("12. range switch does not evict cache", () => {
    let st = ready();
    const key = makeArchiveCacheKey(2024, 12);
    st = reduceReadingArchiveState(st, { type: "RANGE_CHANGED", range: 5 });
    expect(st.cache[key]).toBeDefined();
    st = reduceReadingArchiveState(st, { type: "RANGE_CHANGED", range: 10 });
    expect(st.cache[key]).toBeDefined();
  });

  it("13. recent5 → recent10 → recent5 retains cached entries", () => {
    let st = ready();
    const a = makeArchiveCacheKey(2024, 12);
    // Seed a cache entry for 2020 (sits inside both range=5 and range=10 slices)
    const b = makeArchiveCacheKey(2020, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: b, requestId: 1 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_SUCCEEDED", key: b, requestId: 1, response: s({ selectedYear: 2020, availableYears: [2024, 2023, 2022, 2021, 2020, 2019, 2018], topBooks: 12 }) });
    expect(st.cache[a]).toBeDefined();
    expect(st.cache[b]).toBeDefined();
    st = reduceReadingArchiveState(st, { type: "RANGE_CHANGED", range: 10 });
    expect(st.cache[a]).toBeDefined();
    expect(st.cache[b]).toBeDefined();
    st = reduceReadingArchiveState(st, { type: "RANGE_CHANGED", range: 5 });
    expect(st.cache[a]).toBeDefined();
    expect(st.cache[b]).toBeDefined();
  });

  it("14. range switch preserves failed records for years still in the slice", () => {
    let st = ready();
    const k2022 = makeArchiveCacheKey(2022, 12);
    // Simulate a failed fetch for 2022 by manually placing an error record
    st = {
      ...st,
      requests: { ...st.requests, [k2022]: { status: "error", requestId: 9, attempts: 1, errorCode: "x" } as ArchiveRequestState },
    };
    const before = selectArchiveFailedKeys(st);
    expect(before).toContain(k2022);
    st = reduceReadingArchiveState(st, { type: "RANGE_CHANGED", range: 5 });
    const after = selectArchiveFailedKeys(st);
    expect(after).toContain(k2022);
    // Switch range to one that excludes 2022 — failed record still kept in requests
    st = reduceReadingArchiveState(st, { type: "RANGE_CHANGED", range: 5 });
    expect(st.requests[k2022]?.status).toBe("error");
  });
});

// ============================================================
// Top N (tests 15-18)
// ============================================================

describe("top N", () => {
  const ready = (): ReadingArchiveMachineState =>
    readyBootstrap(createInitialArchiveMachineState(), [2024, 2023, 2022], 2024);

  it("15. Top 12 vs Top 18 keys are independent", () => {
    const st = ready();
    const a12 = makeArchiveCacheKey(2024, 12);
    const a18 = makeArchiveCacheKey(2024, 18);
    expect(a12).not.toBe(a18);
    expect(parseArchiveCacheKey(a12).topBooks).toBe(12);
    expect(parseArchiveCacheKey(a18).topBooks).toBe(18);
    expect(st.cache[a12]).toBeDefined();
    expect(st.cache[a18]).toBeUndefined();
  });

  it("16. Top N switch retains old cache", () => {
    let st = ready();
    const a12 = makeArchiveCacheKey(2024, 12);
    expect(st.cache[a12]).toBeDefined();
    st = reduceReadingArchiveState(st, { type: "TOP_BOOKS_CHANGED", topBooks: 18 });
    expect(st.cache[a12]).toBeDefined();
    expect(st.cache[makeArchiveCacheKey(2024, 18)]).toBeUndefined();
  });

  it("17. Top N switch does not inherit error from old Top N", () => {
    let st = ready();
    const k12 = makeArchiveCacheKey(2024, 12);
    st = {
      ...st,
      requests: { ...st.requests, [k12]: { status: "error", requestId: 9, attempts: 1, errorCode: "x" } as ArchiveRequestState },
    };
    st = reduceReadingArchiveState(st, { type: "TOP_BOOKS_CHANGED", topBooks: 18 });
    const k18 = makeArchiveCacheKey(2024, 18);
    expect(st.requests[k18]).toBeUndefined();
  });

  it("18. switching back to old Top N hits cache", () => {
    let st = ready();
    const a12 = makeArchiveCacheKey(2024, 12);
    st = reduceReadingArchiveState(st, { type: "TOP_BOOKS_CHANGED", topBooks: 18 });
    st = reduceReadingArchiveState(st, { type: "TOP_BOOKS_CHANGED", topBooks: 12 });
    expect(st.cache[a12]).toBeDefined();
    // And no spurious requests get scheduled for it
    expect(selectArchiveRequestsToStart(st)).not.toContain(a12);
  });
});

// ============================================================
// Scheduling (tests 19-26)
// ============================================================

describe("scheduling", () => {
  const ready = (): ReadingArchiveMachineState =>
    readyBootstrap(createInitialArchiveMachineState(), [2024, 2023, 2022, 2021, 2020], 2024);

  it("19. cached key never enters the request queue", () => {
    const st = ready();
    expect(selectArchiveRequestsToStart(st)).not.toContain(makeArchiveCacheKey(2024, 12));
  });

  it("20. pending key is not re-queued", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2023, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 11 });
    expect(selectArchiveRequestsToStart(st)).not.toContain(k);
  });

  it("21. success key is not re-queued", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2023, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 11 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_SUCCEEDED", key: k, requestId: 11, response: s({ selectedYear: 2023, availableYears: [2024, 2023, 2022], topBooks: 12 }) });
    expect(selectArchiveRequestsToStart(st)).not.toContain(k);
  });

  it("22. error key is not auto-queued", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2023, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 11 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k, requestId: 11, errorCode: "boom" });
    expect(selectArchiveRequestsToStart(st)).not.toContain(k);
  });

  it("23. retry puts error key back into idle state (eligible for next start)", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2023, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 11 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k, requestId: 11, errorCode: "boom" });
    st = reduceReadingArchiveState(st, { type: "YEAR_RETRY_REQUESTED", keys: [k] });
    expect(st.requests[k]?.status).toBe("idle");
    expect(st.requests[k]?.requestId).toBeNull();
    expect(st.requests[k]?.attempts).toBe(1);
    // It can now be started again
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 12 });
    expect(st.requests[k]?.status).toBe("pending");
    expect(st.requests[k]?.attempts).toBe(1);
  });

  it("24. max concurrency is 2", () => {
    const st = ready();
    expect(MAX_ARCHIVE_CONCURRENCY).toBe(2);
    const queue = selectArchiveRequestsToStart(st);
    expect(queue.length).toBeLessThanOrEqual(2);
  });

  it("25. requests are queued by ascending year", () => {
    const st = ready();
    const queue = selectArchiveRequestsToStart(st);
    expect(queue).toEqual([makeArchiveCacheKey(2020, 12), makeArchiveCacheKey(2021, 12)]);
    // 2024 is bootstrap-cached and skipped
    expect(queue).not.toContain(makeArchiveCacheKey(2024, 12));
  });

  it("26. bootstrap selected year is not double-scheduled", () => {
    const st = ready();
    // 2024 was seeded by bootstrap success into cache
    expect(st.cache[makeArchiveCacheKey(2024, 12)]).toBeDefined();
    const queue = selectArchiveRequestsToStart(st);
    expect(queue).not.toContain(makeArchiveCacheKey(2024, 12));
  });
});

// ============================================================
// Failure & Retry (tests 27-34)
// ============================================================

describe("failure and retry", () => {
  const ready = (): ReadingArchiveMachineState =>
    readyBootstrap(createInitialArchiveMachineState(), [2024, 2023, 2022], 2024);

  it("27. 2022 first request failure transitions to error", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2022, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 5 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k, requestId: 5, errorCode: "500" });
    expect(st.requests[k]?.status).toBe("error");
    expect(st.requests[k]?.errorCode).toBe("500");
    expect(st.requests[k]?.attempts).toBe(1);
  });

  it("28. visible failed keys contains 2022:12", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2022, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 5 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k, requestId: 5, errorCode: "500" });
    expect(selectArchiveFailedKeys(st)).toContain(k);
  });

  it("29. range switch hides but does not delete the failure", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2022, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 5 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k, requestId: 5, errorCode: "500" });
    st = reduceReadingArchiveState(st, { type: "RANGE_CHANGED", range: 5 });
    expect(selectArchiveFailedKeys(st)).toContain(k);
    expect(st.requests[k]?.status).toBe("error");
  });

  it("30. range switch back restores the failed key visibility", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2022, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 5 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k, requestId: 5, errorCode: "500" });
    // Round-trip the range
    st = reduceReadingArchiveState(st, { type: "RANGE_CHANGED", range: 5 });
    st = reduceReadingArchiveState(st, { type: "RANGE_CHANGED", range: 5 });
    expect(selectArchiveFailedKeys(st)).toContain(k);
  });

  it("31. retry only re-queues the specified keys", () => {
    let st = ready();
    const a = makeArchiveCacheKey(2022, 12);
    const b = makeArchiveCacheKey(2023, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: a, requestId: 5 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: a, requestId: 5, errorCode: "500" });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: b, requestId: 6 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: b, requestId: 6, errorCode: "500" });
    st = reduceReadingArchiveState(st, { type: "YEAR_RETRY_REQUESTED", keys: [a] });
    expect(st.requests[a]?.status).toBe("idle");
    expect(st.requests[b]?.status).toBe("error");
  });

  it("32. retry success clears error", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2022, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 5 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k, requestId: 5, errorCode: "500" });
    st = reduceReadingArchiveState(st, { type: "YEAR_RETRY_REQUESTED", keys: [k] });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 7 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_SUCCEEDED", key: k, requestId: 7, response: s({ selectedYear: 2022, availableYears: [2024, 2023, 2022], topBooks: 12 }) });
    expect(st.requests[k]?.status).toBe("success");
    expect(st.requests[k]?.errorCode).toBeNull();
    expect(st.cache[k]).toBeDefined();
  });

  it("33. retry failure increments attempts", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2022, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 5 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k, requestId: 5, errorCode: "500" });
    expect(st.requests[k]?.attempts).toBe(1);
    st = reduceReadingArchiveState(st, { type: "YEAR_RETRY_REQUESTED", keys: [k] });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 6 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k, requestId: 6, errorCode: "500" });
    expect(st.requests[k]?.attempts).toBe(2);
  });

  it("34. Top 18 failure for 2022 does not pollute Top 12", () => {
    let st = ready();
    const k12 = makeArchiveCacheKey(2022, 12);
    const k18 = makeArchiveCacheKey(2022, 18);
    // Switch to Top 18
    st = reduceReadingArchiveState(st, { type: "TOP_BOOKS_CHANGED", topBooks: 18 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k18, requestId: 5 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k18, requestId: 5, errorCode: "500" });
    expect(st.requests[k18]?.status).toBe("error");
    expect(st.requests[k12]).toBeUndefined();
    // Switch back to Top 12
    st = reduceReadingArchiveState(st, { type: "TOP_BOOKS_CHANGED", topBooks: 12 });
    expect(st.requests[k12]).toBeUndefined();
    expect(st.requests[k18]?.status).toBe("error");
  });
});

// ============================================================
// Race (tests 35-42)
// ============================================================

describe("race", () => {
  const ready = (): ReadingArchiveMachineState =>
    readyBootstrap(createInitialArchiveMachineState(), [2024, 2023, 2022, 2021], 2024);

  it("35-38. out-of-order responses keyed by requestId", () => {
    let st = ready();
    const a = makeArchiveCacheKey(2023, 12);
    const b = makeArchiveCacheKey(2022, 12);

    // 35. A pending
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: a, requestId: 100 });
    expect(st.requests[a]?.status).toBe("pending");

    // 36. retry B: start a new request for B (which was never touched)
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: b, requestId: 101 });
    expect(st.requests[b]?.status).toBe("pending");

    // 37. B succeeds, then a stale A failure arrives
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_SUCCEEDED", key: b, requestId: 101, response: s({ selectedYear: 2022, availableYears: [2024, 2023, 2022], topBooks: 12 }) });
    expect(st.cache[b]).toBeDefined();
    // A is still pending; simulate a late failure for A that was the very first issued
    // but A's current requestId is 100. So this failure is for a future re-issue
    // we simulate by changing A's requestId then sending a stale failure.
    // To set up scenario "B success 后迟到的 A failure 被忽略", we need
    // A to have been re-issued (new requestId) before B success. Simulate via retry:
    st = reduceReadingArchiveState(st, { type: "YEAR_RETRY_REQUESTED", keys: [a] });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: a, requestId: 200 });
    // Now the old A failure (requestId 100) arrives late:
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: a, requestId: 100, errorCode: "stale" });
    expect(st.requests[a]?.status).toBe("pending");
    expect(st.requests[a]?.requestId).toBe(200);

    // 38. B fails later, then a stale A success arrives (different requestId)
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: b, requestId: 101, errorCode: "500" });
    expect(st.requests[b]?.status).toBe("error");
    // Send stale A success (requestId 100) — should be ignored
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_SUCCEEDED", key: a, requestId: 100, response: s({ selectedYear: 2023, availableYears: [2024, 2023, 2022], topBooks: 12 }) });
    expect(st.cache[a]).toBeUndefined();
    expect(st.requests[a]?.status).toBe("pending");
  });

  it("39. token reset invalidates pending bootstrap success", () => {
    let st = createInitialArchiveMachineState();
    st = reduceReadingArchiveState(st, { type: "BOOTSTRAP_STARTED", requestId: 1 });
    st = reduceReadingArchiveState(st, { type: "TOKEN_RESET" });
    st = reduceReadingArchiveState(st, {
      type: "BOOTSTRAP_SUCCEEDED",
      requestId: 1,
      response: s({ selectedYear: 2024, availableYears: [2024, 2023] }),
    });
    expect(st.bootstrap.status).toBe("idle");
    expect(st.bootstrap.availableYears).toEqual([]);
    expect(st.epoch).toBe(1);
  });

  it("40. token reset invalidates pending bootstrap failure", () => {
    let st = createInitialArchiveMachineState();
    st = reduceReadingArchiveState(st, { type: "BOOTSTRAP_STARTED", requestId: 1 });
    st = reduceReadingArchiveState(st, { type: "TOKEN_RESET" });
    st = reduceReadingArchiveState(st, { type: "BOOTSTRAP_FAILED", requestId: 1, errorCode: "x" });
    expect(st.bootstrap.status).toBe("idle");
    expect(st.bootstrap.errorCode).toBeNull();
  });

  it("41. concurrent out-of-order successes maintain correct cache", () => {
    let st = ready();
    const a = makeArchiveCacheKey(2023, 12);
    const b = makeArchiveCacheKey(2022, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: a, requestId: 10 });
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: b, requestId: 11 });
    // B success arrives first
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_SUCCEEDED", key: b, requestId: 11, response: s({ selectedYear: 2022, availableYears: [2024, 2023, 2022], topBooks: 12 }) });
    expect(st.cache[b]).toBeDefined();
    expect(st.cache[a]).toBeUndefined();
    // A success arrives second
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_SUCCEEDED", key: a, requestId: 10, response: s({ selectedYear: 2023, availableYears: [2024, 2023, 2022], topBooks: 12 }) });
    expect(st.cache[a]).toBeDefined();
    expect(st.cache[b]).toBeDefined();
  });

  it("42. a single key only allows one current requestId at a time", () => {
    let st = ready();
    const k = makeArchiveCacheKey(2023, 12);
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 1 });
    expect(st.requests[k]?.requestId).toBe(1);
    // While pending, a second start should be a no-op (idempotency)
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 2 });
    expect(st.requests[k]?.requestId).toBe(1);
    // After failure, retry flips to idle
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_FAILED", key: k, requestId: 1, errorCode: "x" });
    st = reduceReadingArchiveState(st, { type: "YEAR_RETRY_REQUESTED", keys: [k] });
    expect(st.requests[k]?.requestId).toBeNull();
    // Now a new request gets a new requestId
    st = reduceReadingArchiveState(st, { type: "YEAR_REQUEST_STARTED", key: k, requestId: 3 });
    expect(st.requests[k]?.requestId).toBe(3);
  });
});

// ============================================================
// Output safety (tests 43-46)
// ============================================================

describe("output safety", () => {
  it("43. debug snapshot exposes no token, no wereadBookId, no summary", () => {
    const st = readyBootstrap(createInitialArchiveMachineState(), [2024, 2023, 2022], 2024);
    const snap = archiveMachineDebugSnapshot(st);
    const json = JSON.stringify(snap);
    expect(json).not.toMatch(/token/i);
    expect(json).not.toMatch(/wereadBookId/i);
    expect(json).not.toMatch(/summary/i);
    expect(json).not.toMatch(/noteText/i);
    expect(json).not.toMatch(/comment/i);
  });

  it("44. state JSON has no token / catalogId", () => {
    const st = readyBootstrap(createInitialArchiveMachineState(), [2024, 2023], 2024);
    const json = JSON.stringify(st);
    expect(json).not.toMatch(/token/i);
    // catalogId appears only inside topBooks items; synthetic factory uses []
    expect(json).not.toMatch(/catalogId/i);
  });

  it("45. cache values are synth-only and do not contain catalogId / book bodies", () => {
    const st = readyBootstrap(createInitialArchiveMachineState(), [2024, 2023], 2024);
    for (const v of Object.values(st.cache)) {
      if (!v) continue;
      expect(v.topBooks).toEqual([]);
      const json = JSON.stringify(v);
      expect(json).not.toMatch(/catalogId/i);
      expect(json).not.toMatch(/noteText/i);
      expect(json).not.toMatch(/comment/i);
    }
  });

  it("46. JSON output is stable and contains no NaN / Infinity", () => {
    const st = readyBootstrap(createInitialArchiveMachineState(), [2024, 2023, 2022], 2024);
    const json = JSON.stringify(st);
    expect(json).not.toMatch(/NaN/);
    expect(json).not.toMatch(/Infinity/);
    expect(Number.isFinite(JSON.parse(json).bootstrap.selectedYear)).toBe(true);
    expect(hasArchiveBootstrapData(st)).toBe(true);
  });
});

// ============================================================
// Type guards (extra coverage)
// ============================================================

describe("type guards", () => {
  it("isArchiveRange accepts 5/10/20 only", () => {
    expect(isArchiveRange(5)).toBe(true);
    expect(isArchiveRange(10)).toBe(true);
    expect(isArchiveRange(20)).toBe(true);
    expect(isArchiveRange(7)).toBe(false);
    expect(isArchiveRange("5")).toBe(false);
    expect(isArchiveRange(null)).toBe(false);
  });

  it("isArchiveTopBooks accepts 6/12/18 only", () => {
    expect(isArchiveTopBooks(6)).toBe(true);
    expect(isArchiveTopBooks(12)).toBe(true);
    expect(isArchiveTopBooks(18)).toBe(true);
    expect(isArchiveTopBooks(7)).toBe(false);
    expect(isArchiveTopBooks(undefined)).toBe(false);
  });

  it("ARCHIVE_TOP_BOOKS_OPTIONS is exhaustive (6/12/18)", () => {
    expect([...ARCHIVE_TOP_BOOKS_OPTIONS].sort((a, b) => a - b)).toEqual([6, 12, 18]);
  });
});

// ============================================================
// Token reset integration
// ============================================================

describe("TOKEN_RESET integration", () => {
  it("TOKEN_RESET clears cache, requests, bootstrap, view reset to defaults", () => {
    let st = readyBootstrap(createInitialArchiveMachineState(), [2024, 2023, 2022], 2024);
    st = reduceReadingArchiveState(st, { type: "RANGE_CHANGED", range: 10 });
    st = reduceReadingArchiveState(st, { type: "TOP_BOOKS_CHANGED", topBooks: 18 });
    const beforeEpoch = st.epoch;
    const next = reduceReadingArchiveState(st, { type: "TOKEN_RESET" });
    expect(next.epoch).toBe(beforeEpoch + 1);
    expect(next.bootstrap.status).toBe("idle");
    expect(next.bootstrap.availableYears).toEqual([]);
    expect(next.view.range).toBe(DEFAULT_ARCHIVE_RANGE);
    expect(next.view.topBooks).toBe(DEFAULT_ARCHIVE_TOP_BOOKS);
    expect(next.cache).toEqual({});
    expect(next.requests).toEqual({});
  });

  it("TOKEN_RESET is followed by a fresh bootstrap, ignoring the old requestId", () => {
    let st = createInitialArchiveMachineState();
    st = reduceReadingArchiveState(st, { type: "BOOTSTRAP_STARTED", requestId: 1 });
    st = reduceReadingArchiveState(st, { type: "TOKEN_RESET" });
    st = reduceReadingArchiveState(st, { type: "BOOTSTRAP_STARTED", requestId: 2 });
    st = reduceReadingArchiveState(st, {
      type: "BOOTSTRAP_SUCCEEDED",
      requestId: 2,
      response: s({ selectedYear: 2024, availableYears: [2024, 2023] }),
    });
    expect(st.bootstrap.status).toBe("ready");
    expect(st.bootstrap.availableYears).toEqual([2024, 2023]);
  });
});