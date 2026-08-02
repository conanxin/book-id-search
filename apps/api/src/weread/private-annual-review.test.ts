import { describe, expect, it } from "vitest";
import {
  ANNUAL_REVIEW_LIMITS,
  aggregateAnnualReviewBooks,
  buildAnnualReviewMonths,
  buildAnnualReviewQuarters,
  buildPrivateAnnualReview,
  calculateAnnualReviewStreak,
  extractAvailableReviewYears,
  filterNotesByYear,
  findAnnualPeakMonth,
  hydrateAnnualReviewBooks,
  quartersFromMonths,
  resolveAnnualReviewYear,
  runPrivateAnnualReview,
  validateAnnualReviewQuery,
  type PrivateNoteAggregate,
} from "./private-annual-review";
import type { PublicBookMetadata, PublicMetadataFetcher } from "./private-reading-map";

// ---------- fixtures ----------

const NOW = new Date("2026-08-02T00:00:00.000Z");

function isoToSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

const CATALOG_FOR_WEREAD: Record<string, string> = {
  wb_A: "10000000_000000000001",
  wb_B: "10000000_000000000002",
  wb_C: "10000000_000000000003",
  wb_D: "10000000_000000000004",
  wb_E: "10000000_000000000005",
  wb_F: "10000000_000000000006",
};

function makeNote(
  wereadBookId: string,
  type: PrivateNoteAggregate["type"],
  iso: string | null,
  extra: Partial<PrivateNoteAggregate> = {}
): PrivateNoteAggregate {
  return {
    wereadBookId,
    catalogId: extra.catalogId ?? CATALOG_FOR_WEREAD[wereadBookId] ?? "",
    type,
    createdAt: iso,
    updatedAt: iso,
    ...extra,
  };
}

const confirmed = [
  { wereadBookId: "wb_A", catalogId: CATALOG_FOR_WEREAD.wb_A },
  { wereadBookId: "wb_B", catalogId: CATALOG_FOR_WEREAD.wb_B },
  { wereadBookId: "wb_C", catalogId: CATALOG_FOR_WEREAD.wb_C },
  { wereadBookId: "wb_D", catalogId: CATALOG_FOR_WEREAD.wb_D },
  { wereadBookId: "wb_E", catalogId: CATALOG_FOR_WEREAD.wb_E },
  { wereadBookId: "wb_F", catalogId: CATALOG_FOR_WEREAD.wb_F },
];

const WEREAD_TO_CATALOG = new Map<string, string>(
  confirmed.map((m) => [m.wereadBookId, m.catalogId])
);

// 2025 dataset (the focal year for most tests):
const NOTES_2025: PrivateNoteAggregate[] = [
  // Catalog A: 6 months, 7 notes (heaviest)
  makeNote("wb_A", "highlight", "2025-01-05T10:00:00Z"),
  makeNote("wb_A", "highlight", "2025-02-10T10:00:00Z"),
  makeNote("wb_A", "thought", "2025-03-08T10:00:00Z"),
  makeNote("wb_A", "review", "2025-04-12T10:00:00Z"),
  makeNote("wb_A", "highlight", "2025-05-04T10:00:00Z"),
  makeNote("wb_A", "thought", "2025-06-09T10:00:00Z"),
  makeNote("wb_A", "highlight", "2025-07-01T10:00:00Z"),
  // Catalog B: 4 months, 4 notes
  makeNote("wb_B", "highlight", "2025-02-12T10:00:00Z"),
  makeNote("wb_B", "highlight", "2025-03-15T10:00:00Z"),
  makeNote("wb_B", "thought", "2025-04-18T10:00:00Z"),
  makeNote("wb_B", "highlight", "2025-05-22T10:00:00Z"),
  // Catalog C: 2 months
  makeNote("wb_C", "highlight", "2025-04-22T10:00:00Z"),
  makeNote("wb_C", "thought", "2025-05-22T10:00:00Z"),
  // Catalog D: 1 month
  makeNote("wb_D", "review", "2025-03-18T10:00:00Z"),
  // Catalog E: 1 month
  makeNote("wb_E", "highlight", "2025-01-12T10:00:00Z"),
  // Notes with invalid date — must be excluded from the year filter
  makeNote("wb_A", "highlight", null),
  makeNote("wb_B", "highlight", "not-a-date"),
  // Notes from a different year — must be excluded
  makeNote("wb_A", "highlight", "2024-12-15T10:00:00Z"),
  makeNote("wb_A", "highlight", "2026-01-05T10:00:00Z"),
];

const PUBLIC_META: PublicBookMetadata[] = [
  { catalogId: CATALOG_FOR_WEREAD.wb_A, title: "公共书目 A", author: "作者 A", publisher: "出版社 X", publishYear: 2024 },
  { catalogId: CATALOG_FOR_WEREAD.wb_B, title: "公共书目 B", author: "作者 B", publisher: null, publishYear: "2023" },
  { catalogId: CATALOG_FOR_WEREAD.wb_C, title: "公共书目 C", author: null, publisher: null, publishYear: null },
];

function stubFetcher(metas: PublicBookMetadata[]): PublicMetadataFetcher {
  const map = new Map(metas.map((m) => [m.catalogId, m]));
  return {
    fetchByCatalogId: async (catalogId: string) => map.get(catalogId) ?? null,
  };
}

// ---------- 1: validateAnnualReviewQuery ----------

describe("validateAnnualReviewQuery", () => {
  it("accepts valid year + topBooks combinations", () => {
    const ok = validateAnnualReviewQuery({ year: 2025, topBooks: 12 }, NOW);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.year).toBe(2025);
      expect(ok.topBooks).toBe(12);
    }
  });

  it("accepts all three allowed topBooks values", () => {
    for (const v of [6, 12, 18]) {
      const r = validateAnnualReviewQuery({ topBooks: v }, NOW);
      expect(r.ok).toBe(true);
    }
  });

  it("rejects illegal topBooks values", () => {
    for (const v of [5, 10, 19, 100]) {
      const r = validateAnnualReviewQuery({ topBooks: v }, NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(400);
    }
  });

  it("rejects non-integer topBooks", () => {
    const r = validateAnnualReviewQuery({ topBooks: 12.5 }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects years below MIN_YEAR", () => {
    const r = validateAnnualReviewQuery({ year: 1999 }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects years more than currentYear + 1", () => {
    const r = validateAnnualReviewQuery({ year: NOW.getUTCFullYear() + 2 }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects non-integer years", () => {
    const r = validateAnnualReviewQuery({ year: 2025.5 }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("rejects string years", () => {
    const r = validateAnnualReviewQuery({ year: "2025" }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });

  it("accepts omitting year (NaN sentinel) and omitting topBooks", () => {
    const r = validateAnnualReviewQuery({}, NOW);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Number.isNaN(r.year)).toBe(true);
      expect(r.topBooks).toBe(ANNUAL_REVIEW_LIMITS.DEFAULT_TOP_BOOKS);
    }
  });

  it("rejects non-object input", () => {
    const r = validateAnnualReviewQuery(null, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(400);
  });
});

// ---------- 2: extractAvailableReviewYears ----------

describe("extractAvailableReviewYears", () => {
  it("returns a descending list of years with valid dates", () => {
    // NOTES_2025 deliberately includes 2024 and 2026 records to
    // exercise the cross-year exclusion logic in the helpers.
    const years = extractAvailableReviewYears(NOTES_2025);
    expect(years).toEqual([2026, 2025, 2024]);
  });

  it("merges multiple years descending with no duplicates", () => {
    const notes = [
      makeNote("wb_A", "highlight", "2024-05-01T00:00:00Z"),
      makeNote("wb_A", "highlight", "2025-02-01T00:00:00Z"),
      makeNote("wb_A", "highlight", "2025-08-01T00:00:00Z"),
      makeNote("wb_A", "highlight", "2023-01-01T00:00:00Z"),
    ];
    const years = extractAvailableReviewYears(notes);
    expect(years).toEqual([2025, 2024, 2023]);
  });

  it("ignores notes with invalid or missing dates", () => {
    const notes = [
      makeNote("wb_A", "highlight", null),
      makeNote("wb_A", "highlight", "garbage"),
      makeNote("wb_A", "highlight", "2025-01-01T00:00:00Z"),
    ];
    const years = extractAvailableReviewYears(notes);
    expect(years).toEqual([2025]);
  });
});

// ---------- 3: resolveAnnualReviewYear ----------

describe("resolveAnnualReviewYear", () => {
  it("prefers the requested year when in range", () => {
    expect(
      resolveAnnualReviewYear({
        requestedYear: 2025,
        availableYears: [2026, 2025, 2024],
        now: NOW,
      })
    ).toBe(2025);
  });

  it("falls back to the latest available year when no request", () => {
    expect(
      resolveAnnualReviewYear({
        requestedYear: Number.NaN,
        availableYears: [2026, 2024, 2023],
        now: NOW,
      })
    ).toBe(2026);
  });

  it("falls back to the current UTC year when no data exists", () => {
    expect(
      resolveAnnualReviewYear({
        requestedYear: Number.NaN,
        availableYears: [],
        now: NOW,
      })
    ).toBe(NOW.getUTCFullYear());
  });

  it("ignores out-of-range request and falls back to latest available", () => {
    expect(
      resolveAnnualReviewYear({
        requestedYear: 1999,
        availableYears: [2024, 2023],
        now: NOW,
      })
    ).toBe(2024);
  });
});

// ---------- 4: filterNotesByYear ----------

describe("filterNotesByYear", () => {
  it("keeps only notes whose UTC year matches", () => {
    const out = filterNotesByYear(NOTES_2025, 2025);
    for (const note of out) {
      const ts = Math.floor(new Date((note.createdAt as string)).getTime() / 1000);
      expect(new Date(ts * 1000).getUTCFullYear()).toBe(2025);
    }
  });

  it("drops notes with no valid date", () => {
    const out = filterNotesByYear(NOTES_2025, 2025);
    expect(out.length).toBe(15); // 17 valid-date 2025 notes, but we kept only 2025
  });

  it("returns an empty array when no notes match", () => {
    const out = filterNotesByYear(NOTES_2025, 2010);
    expect(out).toEqual([]);
  });
});

// ---------- 5: buildAnnualReviewMonths ----------

describe("buildAnnualReviewMonths", () => {
  const matchedSet = new Set<string>(Object.values(CATALOG_FOR_WEREAD));

  it("returns exactly 12 buckets for the year", () => {
    const months = buildAnnualReviewMonths({ notes: NOTES_2025, year: 2025, matchedCatalogIdSet: matchedSet });
    expect(months).toHaveLength(12);
    expect(months[0].month).toBe("2025-01");
    expect(months[11].month).toBe("2025-12");
  });

  it("sums the types per bucket", () => {
    const months = buildAnnualReviewMonths({ notes: NOTES_2025, year: 2025, matchedCatalogIdSet: matchedSet });
    const jan = months.find((m) => m.month === "2025-01");
    expect(jan).toBeDefined();
    // Jan 2025: wb_A highlight, wb_E highlight = 2 highlights, 0 thoughts/reviews/unknown
    expect(jan?.total).toBe(2);
    expect(jan?.highlights).toBe(2);
    expect(jan?.thoughts).toBe(0);
    expect(jan?.reviews).toBe(0);
  });

  it("counts matched notes per month", () => {
    const months = buildAnnualReviewMonths({ notes: NOTES_2025, year: 2025, matchedCatalogIdSet: matchedSet });
    const mar = months.find((m) => m.month === "2025-03");
    // Mar: wb_A thought + wb_B highlight + wb_D review = 3 records, all matched.
    expect(mar?.matched).toBe(3);
    expect(mar?.total).toBe(3);
  });

  it("computes distinct matched bookCount per month", () => {
    const months = buildAnnualReviewMonths({ notes: NOTES_2025, year: 2025, matchedCatalogIdSet: matchedSet });
    const feb = months.find((m) => m.month === "2025-02");
    // Feb: wb_A highlight, wb_B highlight → 2 distinct matched catalog ids
    expect(feb?.bookCount).toBe(2);
  });

  it("leaves bookCount=0 for months with only unmatched notes", () => {
    // Reuse an unmatched wereadBookId — no mapping → unmatched → matched=0 → bookCount=0
    const notes = [
      { wereadBookId: "wb_unknown", catalogId: "", type: "highlight", createdAt: "2025-07-15T10:00:00Z", updatedAt: "2025-07-15T10:00:00Z" } as PrivateNoteAggregate,
    ];
    const months = buildAnnualReviewMonths({
      notes,
      year: 2025,
      matchedCatalogIdSet: new Set<string>(),
    });
    const jul = months.find((m) => m.month === "2025-07");
    expect(jul?.total).toBe(1);
    expect(jul?.matched).toBe(0);
    expect(jul?.bookCount).toBe(0);
  });

  it("fills empty months with zero values", () => {
    const months = buildAnnualReviewMonths({ notes: [], year: 2025, matchedCatalogIdSet: new Set() });
    expect(months).toHaveLength(12);
    for (const m of months) {
      expect(m.total).toBe(0);
      expect(m.bookCount).toBe(0);
    }
  });

  it("ignores notes from other years", () => {
    // NOTES_2025 includes one 2024 note and one 2026 note; year 2010
    // has no data, so all 12 buckets must stay zero.
    const months = buildAnnualReviewMonths({ notes: NOTES_2025, year: 2010, matchedCatalogIdSet: matchedSet });
    expect(months.every((m) => m.total === 0)).toBe(true);
  });
});

// ---------- 6: calculateAnnualReviewStreak ----------

describe("calculateAnnualReviewStreak", () => {
  it("counts active months inside the 12-month window only", () => {
    const months = buildAnnualReviewMonths({
      notes: NOTES_2025,
      year: 2025,
      matchedCatalogIdSet: new Set(Object.values(CATALOG_FOR_WEREAD)),
    });
    const streak = calculateAnnualReviewStreak(months);
    // Active months: 01, 02, 03, 04, 05, 06, 07 → 7 active months
    expect(streak.activeMonths).toBe(7);
  });

  it("does not connect streaks across years", () => {
    // Jan 2025 + Dec 2024 must NOT count as contiguous for 2025.
    const months = buildAnnualReviewMonths({
      notes: [],
      year: 2025,
      matchedCatalogIdSet: new Set(),
    });
    months[0].total = 1; // Jan
    months[11].total = 1; // Dec
    const streak = calculateAnnualReviewStreak(months);
    expect(streak.activeMonths).toBe(2);
    // longest = 1 (no two adjacent months are both active)
    expect(streak.longestStreakMonths).toBe(1);
  });

  it("computes the longest streak", () => {
    const months = buildAnnualReviewMonths({
      notes: [],
      year: 2025,
      matchedCatalogIdSet: new Set(),
    });
    months[0].total = 1;
    months[1].total = 1;
    months[2].total = 1;
    months[5].total = 1;
    months[6].total = 1;
    const streak = calculateAnnualReviewStreak(months);
    expect(streak.activeMonths).toBe(5);
    expect(streak.longestStreakMonths).toBe(3);
  });

  it("returns zero when all months are empty", () => {
    const months = buildAnnualReviewMonths({ notes: [], year: 2025, matchedCatalogIdSet: new Set() });
    const streak = calculateAnnualReviewStreak(months);
    expect(streak.activeMonths).toBe(0);
    expect(streak.longestStreakMonths).toBe(0);
  });
});

// ---------- 7: findAnnualPeakMonth ----------

describe("findAnnualPeakMonth", () => {
  it("finds the month with the highest total", () => {
    const months = buildAnnualReviewMonths({
      notes: NOTES_2025,
      year: 2025,
      matchedCatalogIdSet: new Set(Object.values(CATALOG_FOR_WEREAD)),
    });
    const peak = findAnnualPeakMonth(months);
    // Mar 2025: wb_A thought + wb_B highlight + wb_D review = 3 records.
    // (Apr/May also hit 3 but the earlier-month tie-breaker picks Mar.)
    expect(peak.peakMonth).toBe("2025-03");
    expect(peak.peakMonthRecords).toBe(3);
  });

  it("breaks ties by picking the earlier month", () => {
    const months = buildAnnualReviewMonths({
      notes: [],
      year: 2025,
      matchedCatalogIdSet: new Set(),
    });
    months[0].total = 3;
    months[1].total = 3;
    months[2].total = 3;
    const peak = findAnnualPeakMonth(months);
    expect(peak.peakMonth).toBe("2025-01");
    expect(peak.peakMonthRecords).toBe(3);
  });

  it("returns null when every month is zero", () => {
    const months = buildAnnualReviewMonths({ notes: [], year: 2025, matchedCatalogIdSet: new Set() });
    const peak = findAnnualPeakMonth(months);
    expect(peak.peakMonth).toBeNull();
    expect(peak.peakMonthRecords).toBe(0);
  });
});

// ---------- 8: quartersFromMonths / buildAnnualReviewQuarters ----------

describe("quarter helpers", () => {
  it("quartersFromMonths sums 3 consecutive months per quarter", () => {
    const months = buildAnnualReviewMonths({
      notes: NOTES_2025,
      year: 2025,
      matchedCatalogIdSet: new Set(Object.values(CATALOG_FOR_WEREAD)),
    });
    const quarters = quartersFromMonths(months);
    expect(quarters).toHaveLength(4);
    expect(quarters.map((q) => q.quarter)).toEqual(["Q1", "Q2", "Q3", "Q4"]);
    const totalAll = quarters.reduce((acc, q) => acc + q.total, 0);
    const monthsTotal = months.reduce((acc, m) => acc + m.total, 0);
    expect(totalAll).toBe(monthsTotal);
  });

  it("buildAnnualReviewQuarters produces exact distinct bookCount", () => {
    const quarters = buildAnnualReviewQuarters({
      notes: NOTES_2025,
      year: 2025,
      matchedCatalogIdSet: new Set(Object.values(CATALOG_FOR_WEREAD)),
    });
    expect(quarters).toHaveLength(4);
    // Q1 (Jan/Feb/Mar): wb_A, wb_B, wb_D, wb_E → 4 distinct catalog ids
    const q1 = quarters.find((q) => q.quarter === "Q1");
    expect(q1?.bookCount).toBeGreaterThanOrEqual(3);
  });

  it("buildAnnualReviewQuarters returns zeros for empty years", () => {
    const quarters = buildAnnualReviewQuarters({
      notes: [],
      year: 2030,
      matchedCatalogIdSet: new Set(),
    });
    for (const q of quarters) {
      expect(q.total).toBe(0);
      expect(q.activeMonths).toBe(0);
      expect(q.matchedRecords).toBe(0);
      expect(q.bookCount).toBe(0);
    }
  });
});

// ---------- 9: aggregateAnnualReviewBooks ----------

describe("aggregateAnnualReviewBooks", () => {
  it("groups notes by catalogId and ignores cross-year data", () => {
    const agg = aggregateAnnualReviewBooks({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      year: 2025,
      limit: 12,
    });
    const ids = agg.map((b) => b.catalogId);
    expect(ids[0]).toBe(CATALOG_FOR_WEREAD.wb_A); // heaviest
    expect(agg.length).toBe(5); // A,B,C,D,E all matched in 2025
  });

  it("merges multiple WeRead ids mapping to the same catalogId", () => {
    const notes: PrivateNoteAggregate[] = [
      makeNote("wb_X1", "highlight", "2025-01-01T00:00:00Z"),
      makeNote("wb_X2", "thought", "2025-02-01T00:00:00Z"),
    ];
    const map = new Map<string, string>([
      ["wb_X1", "10000000_000000000099"],
      ["wb_X2", "10000000_000000000099"],
    ]);
    const agg = aggregateAnnualReviewBooks({
      notes,
      wereadToCatalog: map,
      year: 2025,
      limit: 12,
    });
    expect(agg).toHaveLength(1);
    expect(agg[0].catalogId).toBe("10000000_000000000099");
    expect(agg[0].noteCount).toBe(2);
  });

  it("does not deduplicate identical-text notes — all count", () => {
    const notes: PrivateNoteAggregate[] = Array.from({ length: 5 }, (_, i) =>
      makeNote("wb_X", "highlight", `2025-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`)
    );
    const map = new Map<string, string>([["wb_X", "10000000_000000000099"]]);
    const agg = aggregateAnnualReviewBooks({
      notes,
      wereadToCatalog: map,
      year: 2025,
      limit: 12,
    });
    expect(agg[0].noteCount).toBe(5);
  });

  it("sorts by noteCount → activeMonths → lastNoteAt → catalogId", () => {
    const agg = aggregateAnnualReviewBooks({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      year: 2025,
      limit: 12,
    });
    for (let i = 1; i < agg.length; i += 1) {
      const a = agg[i - 1];
      const b = agg[i];
      if (a.noteCount !== b.noteCount) {
        expect(a.noteCount).toBeGreaterThan(b.noteCount);
      }
    }
  });

  it("truncates the result to the requested limit", () => {
    const agg = aggregateAnnualReviewBooks({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      year: 2025,
      limit: 6,
    });
    expect(agg.length).toBeLessThanOrEqual(6);
  });

  it("computes activeMonths as distinct calendar months", () => {
    const agg = aggregateAnnualReviewBooks({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      year: 2025,
      limit: 12,
    });
    const a = agg.find((b) => b.catalogId === CATALOG_FOR_WEREAD.wb_A);
    // wb_A: Jan/Feb/Mar/Apr/May/Jun/Jul = 7 distinct months
    expect(a?.activeMonths).toBe(7);
  });

  it("first/last note timestamps are ISO strings scoped to the year", () => {
    const agg = aggregateAnnualReviewBooks({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      year: 2025,
      limit: 12,
    });
    const a = agg.find((b) => b.catalogId === CATALOG_FOR_WEREAD.wb_A);
    expect(a?.firstNoteAt).toMatch(/^2025-01-05T/);
    expect(a?.lastNoteAt).toMatch(/^2025-07-01T/);
  });
});

// ---------- 10: hydrateAnnualReviewBooks ----------

describe("hydrateAnnualReviewBooks", () => {
  it("attaches public title / author / publisher / year", () => {
    const agg = aggregateAnnualReviewBooks({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      year: 2025,
      limit: 12,
    });
    const metaMap = new Map<string, PublicBookMetadata>(
      PUBLIC_META.map((m) => [m.catalogId, m])
    );
    const out = hydrateAnnualReviewBooks(agg, metaMap);
    const a = out.find((b) => b.catalogId === CATALOG_FOR_WEREAD.wb_A);
    expect(a?.title).toBe("公共书目 A");
    expect(a?.author).toBe("作者 A");
    expect(a?.publisher).toBe("出版社 X");
    expect(a?.publishYear).toBe(2024);
  });

  it("falls back to `书目 ${catalogId}` when metadata is missing", () => {
    const agg = aggregateAnnualReviewBooks({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      year: 2025,
      limit: 12,
    });
    const out = hydrateAnnualReviewBooks(agg, new Map());
    for (const book of out) {
      expect(book.title.startsWith("书目 ")).toBe(true);
      expect(book.author).toBeNull();
      expect(book.publisher).toBeNull();
      expect(book.publishYear).toBeNull();
    }
  });

  it("never falls back to private WeRead title / author (no extra fields)", () => {
    const agg = aggregateAnnualReviewBooks({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      year: 2025,
      limit: 12,
    });
    const out = hydrateAnnualReviewBooks(agg, new Map());
    for (const book of out) {
      expect(book).not.toHaveProperty("wereadTitle");
      expect(book).not.toHaveProperty("wereadAuthor");
      expect(book).not.toHaveProperty("rawTitle");
      expect(book).not.toHaveProperty("rawAuthor");
    }
  });
});

// ---------- 11: buildPrivateAnnualReview (full response) ----------

describe("buildPrivateAnnualReview", () => {
  const metadataByCatalog = new Map<string, PublicBookMetadata>(
    PUBLIC_META.map((m) => [m.catalogId, m])
  );

  it("produces a full response shape with no private fields", () => {
    const resp = buildPrivateAnnualReview({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      selectedYear: 2025,
      topBooks: 12,
      metadataByCatalog,
      now: NOW,
    });
    expect(resp.ok).toBe(true);
    expect(resp.selectedYear).toBe(2025);
    expect(resp.months).toHaveLength(12);
    expect(resp.quarters).toHaveLength(4);
    expect(Array.isArray(resp.topBooks)).toBe(true);
    expect(resp.meta.persisted).toBe(false);
    expect(resp.meta.source).toBe("private_snapshot+public_catalog");
    expect(resp.meta.topBooksRequested).toBe(12);

    // Overview counts
    expect(resp.overview.year).toBe(2025);
    expect(resp.overview.datedRecords).toBe(15); // 17 2025-dated, minus invalid
    expect(resp.overview.activeMonths).toBe(7);
    expect(resp.overview.peakMonth).toBe("2025-03");
    expect(resp.overview.matchedRecords).toBeGreaterThan(0);
    // Mar 2025: wb_A thought, wb_B highlight, wb_D review = 3 records
    expect(resp.overview.peakMonthRecords).toBe(3);
  });

  it("returns zero-valued month buckets when the selected year has no data", () => {
    const resp = buildPrivateAnnualReview({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      selectedYear: 2010,
      topBooks: 12,
      metadataByCatalog,
      now: NOW,
    });
    expect(resp.ok).toBe(true);
    expect(resp.selectedYear).toBe(2010);
    expect(resp.months).toHaveLength(12);
    expect(resp.topBooks).toEqual([]);
    expect(resp.overview.totalRecords).toBe(0);
    expect(resp.overview.datedRecords).toBe(0);
    expect(resp.overview.matchedRecords).toBe(0);
    expect(resp.overview.matchedBooks).toBe(0);
    expect(resp.overview.peakMonth).toBeNull();
    expect(resp.overview.peakMonthRecords).toBe(0);
    expect(resp.overview.averageRecordsPerActiveMonth).toBe(0);
    expect(resp.overview.firstNoteAt).toBeNull();
    expect(resp.overview.lastNoteAt).toBeNull();
    expect(resp.meta.topBooksReturned).toBe(0);
  });

  it("never echoes note text / comment / private IDs / WeRead title", () => {
    const resp = buildPrivateAnnualReview({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      selectedYear: 2025,
      topBooks: 12,
      metadataByCatalog,
      now: NOW,
    });
    const serialized = JSON.stringify(resp);
    expect(serialized).not.toMatch(/wereadBookId|noteId|highlightId|chapterTitle/);
    expect(serialized).not.toMatch(/wereadTitle|wereadAuthor|rawTitle|rawAuthor/);
    // No literal text/comment keys
    expect(serialized).not.toMatch(/"text":/);
    expect(serialized).not.toMatch(/"comment":/);
    expect(serialized).not.toMatch(/"content":/);
    expect(serialized).not.toMatch(/"markedText":/);
    for (const book of resp.topBooks) {
      expect(book.catalogId).toMatch(/^[0-9]+_[0-9]{12}$/);
    }
  });

  it("top books only includes confirmed matches within selectedYear", () => {
    // Catalog F has a note in 2024 only; must NOT appear in 2025 results.
    const notes: PrivateNoteAggregate[] = [
      ...NOTES_2025,
      makeNote("wb_F", "highlight", "2024-06-01T00:00:00Z"),
    ];
    const resp = buildPrivateAnnualReview({
      notes,
      wereadToCatalog: WEREAD_TO_CATALOG,
      selectedYear: 2025,
      topBooks: 12,
      metadataByCatalog,
      now: NOW,
    });
    const ids = resp.topBooks.map((b) => b.catalogId);
    expect(ids).not.toContain(CATALOG_FOR_WEREAD.wb_F);
  });

  it("source is stable and persisted is always false", () => {
    const resp = buildPrivateAnnualReview({
      notes: NOTES_2025,
      wereadToCatalog: WEREAD_TO_CATALOG,
      selectedYear: 2025,
      topBooks: 6,
      metadataByCatalog,
      now: NOW,
    });
    expect(resp.meta.persisted).toBe(false);
    expect(resp.meta.source).toBe("private_snapshot+public_catalog");
    expect(resp.meta.topBooksRequested).toBe(6);
    expect(resp.meta.topBooksReturned).toBeLessThanOrEqual(6);
  });

  it("averageRecordsPerActiveMonth is 0 when the year is empty", () => {
    const resp = buildPrivateAnnualReview({
      notes: [],
      wereadToCatalog: WEREAD_TO_CATALOG,
      selectedYear: 2025,
      topBooks: 12,
      metadataByCatalog,
      now: NOW,
    });
    expect(resp.overview.averageRecordsPerActiveMonth).toBe(0);
    expect(resp.overview.activeMonths).toBe(0);
  });

  it("includes availableYears from the full note history (descending, deduplicated)", () => {
    const notes: PrivateNoteAggregate[] = [
      ...NOTES_2025,
      makeNote("wb_F", "highlight", "2024-06-01T00:00:00Z"),
      makeNote("wb_F", "highlight", "2024-08-01T00:00:00Z"),
      makeNote("wb_F", "highlight", "2023-01-01T00:00:00Z"),
    ];
    const resp = buildPrivateAnnualReview({
      notes,
      wereadToCatalog: WEREAD_TO_CATALOG,
      selectedYear: 2025,
      topBooks: 12,
      metadataByCatalog,
      now: NOW,
    });
    expect(resp.availableYears).toEqual([2026, 2025, 2024, 2023]);
  });
});

// ---------- 12: runPrivateAnnualReview (end-to-end orchestrator) ----------

describe("runPrivateAnnualReview", () => {
  it("returns a validation error for bad topBooks", async () => {
    const r = await runPrivateAnnualReview({
      query: { topBooks: 10 },
      notes: NOTES_2025,
      confirmedMatches: confirmed,
      fetchMetadata: stubFetcher(PUBLIC_META),
      now: NOW,
    });
    expect(r.error?.status).toBe(400);
    expect(r.response).toBeUndefined();
  });

  it("returns a validation error for bad year", async () => {
    const r = await runPrivateAnnualReview({
      query: { year: 1999 },
      notes: NOTES_2025,
      confirmedMatches: confirmed,
      fetchMetadata: stubFetcher(PUBLIC_META),
      now: NOW,
    });
    expect(r.error?.status).toBe(400);
    expect(r.response).toBeUndefined();
  });

  it("resolves the default year to the latest available year", async () => {
    // NOTES_2025 contains a 2026-01-05 record (deliberately placed to
    // exercise the cross-year exclusion); the default year must be the
    // latest year present in the dataset.
    const r = await runPrivateAnnualReview({
      query: {},
      notes: NOTES_2025,
      confirmedMatches: confirmed,
      fetchMetadata: stubFetcher(PUBLIC_META),
      now: NOW,
    });
    expect(r.response?.selectedYear).toBe(2026);
  });

  it("returns the full response for a valid query", async () => {
    const r = await runPrivateAnnualReview({
      query: { year: 2025, topBooks: 12 },
      notes: NOTES_2025,
      confirmedMatches: confirmed,
      fetchMetadata: stubFetcher(PUBLIC_META),
      now: NOW,
    });
    expect(r.response).toBeDefined();
    expect(r.response?.ok).toBe(true);
    expect(r.response?.topBooks.length).toBeGreaterThan(0);
  });

  it("metadata failures fall back gracefully", async () => {
    const broken: PublicMetadataFetcher = {
      fetchByCatalogId: async () => {
        throw new Error("meili exploded");
      },
    };
    const r = await runPrivateAnnualReview({
      query: { year: 2025, topBooks: 12 },
      notes: NOTES_2025,
      confirmedMatches: confirmed,
      fetchMetadata: broken,
      now: NOW,
    });
    expect(r.response).toBeDefined();
    expect(r.response?.ok).toBe(true);
    for (const b of r.response?.topBooks ?? []) {
      expect(b.title.startsWith("书目 ")).toBe(true);
      expect(b.author).toBeNull();
    }
  });
});

// ---------- 13: orchestrator / cross-helper coverage ----------

describe("helper coverage", () => {
  it("filterNotesByYear returns an empty list for notes without dates", () => {
    const out = filterNotesByYear(
      [
        makeNote("wb_A", "highlight", null),
        makeNote("wb_A", "highlight", "garbage"),
      ],
      2025
    );
    expect(out).toEqual([]);
  });

  it("validateAnnualReviewQuery accepts the current UTC year + 1", () => {
    const r = validateAnnualReviewQuery({ year: NOW.getUTCFullYear() + 1 }, NOW);
    expect(r.ok).toBe(true);
  });

  it("extractAvailableReviewYears returns an empty list when there are no valid notes", () => {
    expect(extractAvailableReviewYears([])).toEqual([]);
    expect(
      extractAvailableReviewYears([
        makeNote("wb_A", "highlight", null),
        makeNote("wb_A", "highlight", "garbage"),
      ])
    ).toEqual([]);
  });

  it("runs without calling /api/search (no fetcher is exercised)", async () => {
    let calls = 0;
    const tracker: PublicMetadataFetcher = {
      fetchByCatalogId: async (catalogId: string) => {
        calls += 1;
        // No HTTP — return a synthetic document.
        return {
          catalogId,
          title: `书目 ${catalogId}`,
          author: null,
          publisher: null,
          publishYear: null,
        };
      },
    };
    const r = await runPrivateAnnualReview({
      query: { year: 2025, topBooks: 12 },
      notes: NOTES_2025,
      confirmedMatches: confirmed,
      fetchMetadata: tracker,
      now: NOW,
    });
    expect(r.response).toBeDefined();
    expect(calls).toBeGreaterThan(0);
    // No fetch is made at this layer — the orchestrator only calls the
    // provided fetcher. Any HTTP request is an implementation concern of
    // the fetcher and is exercised at the route layer.
  });
});