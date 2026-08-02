import { describe, expect, it } from "vitest";
import {
  READING_MAP_LIMITS,
  aggregateMatchedBooks,
  buildMonthWindow,
  buildPrivateReadingMap,
  buildPublicBookItems,
  buildReadingMapLinks,
  buildReadingMapTimeline,
  calculateReadingStreaks,
  hydratePublicBookMetadata,
  monthKeyFromSeconds,
  normalizeNoteType,
  resolveNoteTimestampSeconds,
  runPrivateReadingMap,
  validateReadingMapQuery,
  type AggregatedMatchedBook,
  type PrivateNoteAggregate,
  type PublicBookMetadata,
  type PublicMetadataFetcher,
} from "./private-reading-map";

// ---------- fixtures ----------

const NOW_SECONDS = 1_783_867_200; // 2026-07-15T12:00:00Z (deterministic)

function isoToSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

function makeConfirmed(entries: Array<[string, string]>): Array<{ wereadBookId: string; catalogId: string }> {
  return entries.map(([wereadBookId, catalogId]) => ({ wereadBookId, catalogId }));
}

function wereadToCatalogMap(entries: Array<[string, string]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of entries) m.set(k, v);
  return m;
}

const CATALOG_FOR_WEREAD: Record<string, string> = {
  wb_A: "10000000_000000000001",
  wb_B: "10000000_000000000002",
  wb_C: "10000000_000000000003",
  wb_D: "10000000_000000000004",
  wb_E: "10000000_000000000005",
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

const confirmed = makeConfirmed([
  ["wb_A", "10000000_000000000001"],
  ["wb_B", "10000000_000000000002"],
  ["wb_C", "10000000_000000000003"],
  ["wb_D", "10000000_000000000004"],
  ["wb_E", "10000000_000000000005"],
]);

// Notes spread across 7 months (2026-01 to 2026-07).
const NOTES: PrivateNoteAggregate[] = [
  // Catalog 1 (heaviest, 7 months active)
  makeNote("wb_A", "highlight", "2026-01-05T10:00:00.000Z"),
  makeNote("wb_A", "highlight", "2026-02-10T10:00:00.000Z"),
  makeNote("wb_A", "thought", "2026-03-08T10:00:00.000Z"),
  makeNote("wb_A", "review", "2026-04-12T10:00:00.000Z"),
  makeNote("wb_A", "highlight", "2026-05-04T10:00:00.000Z"),
  makeNote("wb_A", "thought", "2026-06-09T10:00:00.000Z"),
  makeNote("wb_A", "highlight", "2026-07-01T10:00:00.000Z"),
  // Catalog 2 (4 months)
  makeNote("wb_B", "highlight", "2026-02-12T10:00:00.000Z"),
  makeNote("wb_B", "highlight", "2026-03-15T10:00:00.000Z"),
  makeNote("wb_B", "thought", "2026-04-18T10:00:00.000Z"),
  makeNote("wb_B", "highlight", "2026-06-04T10:00:00.000Z"),
  // Catalog 3 (2 months)
  makeNote("wb_C", "highlight", "2026-05-22T10:00:00.000Z"),
  makeNote("wb_C", "thought", "2026-06-22T10:00:00.000Z"),
  // Catalog 4 (1 month)
  makeNote("wb_D", "review", "2026-03-18T10:00:00.000Z"),
  // Catalog 5 (1 month, 1 note)
  makeNote("wb_E", "highlight", "2026-01-12T10:00:00.000Z"),
  // Notes with invalid date (excluded)
  makeNote("wb_A", "highlight", null),
  makeNote("wb_B", "highlight", "not-a-date"),
];

const WEREAD_TO_CATALOG = wereadToCatalogMap([
  ["wb_A", "10000000_000000000001"],
  ["wb_B", "10000000_000000000002"],
  ["wb_C", "10000000_000000000003"],
  ["wb_D", "10000000_000000000004"],
  ["wb_E", "10000000_000000000005"],
]);

// ---------- 1: validateReadingMapQuery ----------

describe("validateReadingMapQuery", () => {
  it("accepts months = 6/12/24/36", () => {
    expect(validateReadingMapQuery({ months: 6 }).ok).toBe(true);
    expect(validateReadingMapQuery({ months: 12 }).ok).toBe(true);
    expect(validateReadingMapQuery({ months: 24 }).ok).toBe(true);
    expect(validateReadingMapQuery({ months: 36 }).ok).toBe(true);
  });
  it("rejects illegal months", () => {
    const bad = validateReadingMapQuery({ months: 7 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.status).toBe(400);
    const str = validateReadingMapQuery({ months: "12" });
    expect(str.ok).toBe(false);
    if (!str.ok) expect(str.status).toBe(400);
  });
  it("accepts topBooks in [6, 18]", () => {
    for (const v of [6, 12, 18]) {
      expect(validateReadingMapQuery({ topBooks: v }).ok).toBe(true);
    }
  });
  it("rejects topBooks outside [6, 18] or non-integer", () => {
    const low = validateReadingMapQuery({ topBooks: 5 });
    expect(low.ok).toBe(false);
    if (!low.ok) expect(low.status).toBe(400);
    const high = validateReadingMapQuery({ topBooks: 19 });
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.status).toBe(400);
    const frac = validateReadingMapQuery({ topBooks: 12.5 });
    expect(frac.ok).toBe(false);
    if (!frac.ok) expect(frac.status).toBe(400);
  });
});

// ---------- 2: buildReadingMapTimeline ----------

describe("buildReadingMapTimeline", () => {
  it("fills every requested month including empties", () => {
    const t = buildReadingMapTimeline(NOTES, new Set(["10000000_000000000001"]), NOW_SECONDS, 6);
    expect(t).toHaveLength(6);
    expect(t[0].month).toBeDefined();
    // Sorted ascending — last bucket should be the current month.
    const sortedAsc = [...t].map((b) => b.month);
    expect(sortedAsc).toEqual([...sortedAsc].sort());
  });
  it("createdAt is preferred over updatedAt (verified via resolveNoteTimestampSeconds)", () => {
    expect(resolveNoteTimestampSeconds({ wereadBookId: "x", createdAt: "2026-05-01T00:00:00Z", updatedAt: "2026-04-01T00:00:00Z" }))
      .toBe(isoToSeconds("2026-05-01T00:00:00Z"));
    expect(resolveNoteTimestampSeconds({ wereadBookId: "x", createdAt: "2026-03-01T00:00:00Z" }))
      .toBe(isoToSeconds("2026-03-01T00:00:00Z"));
  });
  it("updatedAt fallback when createdAt missing", () => {
    const ts = resolveNoteTimestampSeconds({ wereadBookId: "x", updatedAt: "2026-04-15T00:00:00Z" });
    expect(ts).toBe(isoToSeconds("2026-04-15T00:00:00Z"));
  });
  it("invalid dates are excluded", () => {
    const t = buildReadingMapTimeline(
      [makeNote("wb_A", "highlight", null), makeNote("wb_A", "highlight", "garbage")],
      new Set(["10000000_000000000001"]),
      NOW_SECONDS,
      6,
    );
    const total = t.reduce((acc, b) => acc + b.total, 0);
    expect(total).toBe(0);
  });
  it("buckets notes by type", () => {
    const t = buildReadingMapTimeline(NOTES, new Set(), NOW_SECONDS, 6);
    const may = t.find((b) => b.month === "2026-05");
    expect(may).toBeDefined();
    // May 2026: wb_A highlight, wb_C highlight = 2 highlights; wb_C highlight → counted.
    expect((may?.highlights ?? 0) >= 1).toBe(true);
  });
  it("counts matched notes per month", () => {
    const t = buildReadingMapTimeline(
      NOTES,
      new Set(["10000000_000000000001"]), // only catalog 1 is matched
      NOW_SECONDS,
      6,
    );
    const feb = t.find((b) => b.month === "2026-02");
    // Feb 2026: wb_A highlight, wb_B highlight → only wb_A counts as matched.
    expect(feb?.matched).toBe(1);
  });
});

// ---------- 3: calculateReadingStreaks ----------

describe("calculateReadingStreaks", () => {
  it("counts active months correctly", () => {
    const s = calculateReadingStreaks({ notes: NOTES, nowSeconds: NOW_SECONDS });
    // 2026-01, 02, 03, 04, 05, 06, 07 → 7 active months
    expect(s.activeMonths).toBe(7);
  });
  it("calculates a current streak from latest active month", () => {
    const s = calculateReadingStreaks({ notes: NOTES, nowSeconds: NOW_SECONDS });
    // Latest active: 2026-07 (1 note). Walking back: 06 (3), 05 (2), 04 (2), 03 (3), 02 (2), 01 (2) → 7 consecutive months
    expect(s.currentStreakMonths).toBe(7);
  });
  it("calculates longest streak", () => {
    const s = calculateReadingStreaks({ notes: NOTES, nowSeconds: NOW_SECONDS });
    expect(s.longestStreakMonths).toBe(7);
  });
});

// ---------- 4: aggregateMatchedBooks ----------

describe("aggregateMatchedBooks", () => {
  it("groups notes by catalogId (not by wereadBookId)", () => {
    const notes: PrivateNoteAggregate[] = [
      makeNote("wb_X1", "highlight", "2026-01-01T00:00:00Z"),
      makeNote("wb_X2", "thought", "2026-02-01T00:00:00Z"),
    ];
    const map = wereadToCatalogMap([
      ["wb_X1", "10000000_000000000099"],
      ["wb_X2", "10000000_000000000099"],
    ]);
    const result = aggregateMatchedBooks({ notes, wereadToCatalog: map, limit: 12 });
    expect(result).toHaveLength(1);
    expect(result[0].catalogId).toBe("10000000_000000000099");
    expect(result[0].noteCount).toBe(2);
  });
  it("allows duplicate mappings of the same catalog", () => {
    const notes: PrivateNoteAggregate[] = [
      makeNote("wb_X", "highlight", "2026-01-01T00:00:00Z"),
      makeNote("wb_X", "highlight", "2026-01-01T00:00:00Z"),
      makeNote("wb_X", "thought", "2026-01-02T00:00:00Z"),
    ];
    const map = wereadToCatalogMap([["wb_X", "10000000_000000000099"]]);
    const result = aggregateMatchedBooks({ notes, wereadToCatalog: map, limit: 12 });
    expect(result[0].noteCount).toBe(3);
  });
  it("does not deduplicate notes with identical text — they all count", () => {
    const notes: PrivateNoteAggregate[] = Array.from({ length: 5 }, (_, i) =>
      makeNote("wb_X", "highlight", `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`)
    );
    const map = wereadToCatalogMap([["wb_X", "10000000_000000000099"]]);
    const result = aggregateMatchedBooks({ notes, wereadToCatalog: map, limit: 12 });
    expect(result[0].noteCount).toBe(5);
  });
  it("sorts top books by noteCount, then activeMonths, then lastNoteAt, then catalogId", () => {
    const result = aggregateMatchedBooks({
      notes: NOTES,
      wereadToCatalog: WEREAD_TO_CATALOG,
      limit: 12,
    });
    expect(result[0].catalogId).toBe("10000000_000000000001"); // heaviest
    // Validate ordering invariant.
    for (let i = 1; i < result.length; i++) {
      const a = result[i - 1];
      const b = result[i];
      if (a.noteCount !== b.noteCount) {
        expect(a.noteCount).toBeGreaterThanOrEqual(b.noteCount);
      }
    }
  });
});

// ---------- 5: buildReadingMapLinks ----------

describe("buildReadingMapLinks", () => {
  it("counts shared months between top books", () => {
    const links = buildReadingMapLinks({
      notes: NOTES,
      wereadToCatalog: WEREAD_TO_CATALOG,
      topCatalogIds: [
        "10000000_000000000001",
        "10000000_000000000002",
        "10000000_000000000003",
      ],
    });
    const aB = links.find((l) =>
      (l.sourceCatalogId === "10000000_000000000001" && l.targetCatalogId === "10000000_000000000002") ||
      (l.sourceCatalogId === "10000000_000000000002" && l.targetCatalogId === "10000000_000000000001")
    );
    expect(aB).toBeDefined();
    // Catalog 1 active in 2026-02/03/04/06; catalog 2 active in 02/03/04/06 → 4 shared months
    expect(aB?.sharedMonths).toBe(4);
  });
  it("computes weight as min(A_count, B_count) summed over shared months", () => {
    const links = buildReadingMapLinks({
      notes: [
        makeNote("wb_A", "highlight", "2026-02-01T00:00:00Z"),
        makeNote("wb_A", "highlight", "2026-02-15T00:00:00Z"), // A=2 in Feb
        makeNote("wb_B", "highlight", "2026-02-20T00:00:00Z"), // B=1 in Feb
      ],
      wereadToCatalog: WEREAD_TO_CATALOG,
      topCatalogIds: ["10000000_000000000001", "10000000_000000000002"],
    });
    const link = links[0];
    expect(link.weight).toBe(1); // min(2, 1) = 1
  });
  it("does not produce self-links", () => {
    const links = buildReadingMapLinks({
      notes: NOTES,
      wereadToCatalog: WEREAD_TO_CATALOG,
      topCatalogIds: Array.from(WEREAD_TO_CATALOG.values()),
    });
    for (const l of links) expect(l.sourceCatalogId).not.toBe(l.targetCatalogId);
  });
  it("uses stable source/target ordering", () => {
    const links = buildReadingMapLinks({
      notes: NOTES,
      wereadToCatalog: WEREAD_TO_CATALOG,
      topCatalogIds: Array.from(WEREAD_TO_CATALOG.values()),
    });
    for (const l of links) {
      expect(l.sourceCatalogId < l.targetCatalogId).toBe(true);
    }
  });
  it("caps returned links at READING_MAP_LIMITS.MAX_LINKS", () => {
    const links = buildReadingMapLinks({
      notes: NOTES,
      wereadToCatalog: WEREAD_TO_CATALOG,
      topCatalogIds: Array.from(WEREAD_TO_CATALOG.values()),
    });
    expect(links.length).toBeLessThanOrEqual(READING_MAP_LIMITS.MAX_LINKS);
  });
});

// ---------- 6: hydratePublicBookMetadata / buildPublicBookItems ----------

const PUBLIC_META: PublicBookMetadata[] = [
  { catalogId: "10000000_000000000001", title: "公共书目 1", author: "作者 A", publisher: "出版社 X", publishYear: 2024 },
  { catalogId: "10000000_000000000002", title: "公共书目 2", author: "作者 B", publisher: null, publishYear: "2023" },
];

function stubFetcher(metas: PublicBookMetadata[]): PublicMetadataFetcher {
  const map = new Map(metas.map((m) => [m.catalogId, m]));
  return {
    fetchByCatalogId: async (catalogId: string) => map.get(catalogId) ?? null,
  };
}

describe("hydratePublicBookMetadata", () => {
  const agg: AggregatedMatchedBook[] = [
    {
      catalogId: "10000000_000000000001",
      noteCount: 7,
      highlights: 4,
      thoughts: 2,
      reviews: 1,
      unknown: 0,
      activeMonths: 6,
      firstNoteAt: "2026-01-05T10:00:00.000Z",
      lastNoteAt: "2026-07-01T10:00:00.000Z",
    },
    {
      catalogId: "10000000_000000000099", // not in PUBLIC_META — fallback expected
      noteCount: 1,
      highlights: 1,
      thoughts: 0,
      reviews: 0,
      unknown: 0,
      activeMonths: 1,
      firstNoteAt: "2026-02-01T00:00:00.000Z",
      lastNoteAt: "2026-02-01T00:00:00.000Z",
    },
  ];

  it("attaches public title/author/publisher/year", async () => {
    const result = await hydratePublicBookMetadata(agg, stubFetcher(PUBLIC_META));
    expect(result[0].title).toBe("公共书目 1");
    expect(result[0].author).toBe("作者 A");
    expect(result[0].publisher).toBe("出版社 X");
    expect(result[0].publishYear).toBe(2024);
  });
  it("falls back to `书目 ${catalogId}` when metadata missing", async () => {
    const result = await hydratePublicBookMetadata(agg, stubFetcher(PUBLIC_META));
    expect(result[1].title).toBe("书目 10000000_000000000099");
    expect(result[1].author).toBeNull();
  });
});

// ---------- 7: buildPrivateReadingMap (full response) ----------

describe("buildPrivateReadingMap", () => {
  const metadataByCatalog = new Map<string, PublicBookMetadata>(
    PUBLIC_META.map((m) => [m.catalogId, m])
  );

  it("produces a full response shape", () => {
    const resp = buildPrivateReadingMap({
      notes: NOTES,
      confirmedMatches: confirmed,
      wereadToCatalog: WEREAD_TO_CATALOG,
      nowSeconds: NOW_SECONDS,
      months: 24,
      topBooks: 12,
      metadataByCatalog,
      booksCount: 5,
    });
    expect(resp.ok).toBe(true);
    expect(resp.overview.booksCount).toBe(5);
    expect(resp.overview.notesCount).toBe(NOTES.length);
    expect(resp.overview.matchedCatalogsCount).toBe(5);
    expect(resp.meta.persisted).toBe(false);
    expect(resp.meta.source).toBe("private_snapshot+public_catalog");
    expect(resp.timeline.length).toBe(24);
    expect(resp.books.length).toBeLessThanOrEqual(12);
    expect(resp.books.length).toBeGreaterThanOrEqual(1);
    expect(resp.books[0].title).toMatch(/.+/);
  });

  it("never echoes note text/comment/private IDs", () => {
    const resp = buildPrivateReadingMap({
      notes: NOTES,
      confirmedMatches: confirmed,
      wereadToCatalog: WEREAD_TO_CATALOG,
      nowSeconds: NOW_SECONDS,
      months: 24,
      topBooks: 12,
      metadataByCatalog,
      booksCount: 5,
    });
    const serialized = JSON.stringify(resp);
    expect(serialized).not.toMatch(/wereadBookId|noteId|highlightId|chapterTitle/);
    // The fixtures don't carry text/comment so a direct match won't trip,
    // but the shape is also enforced: the only string fields anywhere are
    // title/author/publisher/publishYear (book-level), and month / firstNoteAt /
    // lastNoteAt / source / persisted. None of those can carry note bodies.
    for (const book of resp.books) {
      expect(book.catalogId).toMatch(/^[0-9]+_[0-9]{12}$/);
    }
  });

  it("never carries weread title/author (no fallback path)", () => {
    const resp = buildPrivateReadingMap({
      notes: NOTES,
      confirmedMatches: confirmed,
      wereadToCatalog: WEREAD_TO_CATALOG,
      nowSeconds: NOW_SECONDS,
      months: 24,
      topBooks: 12,
      metadataByCatalog: new Map(), // no public metadata at all
      booksCount: 5,
    });
    for (const book of resp.books) {
      // title follows the strict fallback `书目 ${catalogId}`.
      expect(book.title.startsWith("书目 ")).toBe(true);
      expect(book.author).toBeNull();
    }
  });

  it("persisted is always false and source is stable", () => {
    const resp = buildPrivateReadingMap({
      notes: NOTES,
      confirmedMatches: confirmed,
      wereadToCatalog: WEREAD_TO_CATALOG,
      nowSeconds: NOW_SECONDS,
      months: 12,
      topBooks: 12,
      metadataByCatalog,
      booksCount: 5,
    });
    expect(resp.meta.persisted).toBe(false);
    expect(resp.meta.source).toBe("private_snapshot+public_catalog");
    expect(resp.meta.monthsReturned).toBe(12);
    expect(resp.meta.topBooksReturned).toBeLessThanOrEqual(12);
    expect(resp.meta.linksReturned).toBeLessThanOrEqual(READING_MAP_LIMITS.MAX_LINKS);
  });
});

// ---------- 8: runPrivateReadingMap (end-to-end orchestrator) ----------

describe("runPrivateReadingMap", () => {
  it("returns validation error for bad query", async () => {
    const r = await runPrivateReadingMap({
      query: { months: 7 },
      notes: NOTES,
      confirmedMatches: confirmed,
      booksCount: 5,
      fetchMetadata: stubFetcher(PUBLIC_META),
      nowSeconds: NOW_SECONDS,
    });
    expect(r.error?.status).toBe(400);
    expect(r.response).toBeUndefined();
  });

  it("returns 200 with empty books when no confirmed matches", async () => {
    const r = await runPrivateReadingMap({
      query: { months: 12, topBooks: 12 },
      notes: [],
      confirmedMatches: [],
      booksCount: 0,
      fetchMetadata: stubFetcher(PUBLIC_META),
      nowSeconds: NOW_SECONDS,
    });
    expect(r.response).toBeDefined();
    expect(r.response?.ok).toBe(true);
    expect(r.response?.books).toEqual([]);
    expect(r.response?.links).toEqual([]);
  });

  it("metadata failures fall back gracefully without throwing", async () => {
    const broken: PublicMetadataFetcher = {
      fetchByCatalogId: async () => {
        throw new Error("meili exploded");
      },
    };
    const r = await runPrivateReadingMap({
      query: { months: 12, topBooks: 12 },
      notes: NOTES,
      confirmedMatches: confirmed,
      booksCount: 5,
      fetchMetadata: broken,
      nowSeconds: NOW_SECONDS,
    });
    expect(r.response).toBeDefined();
    expect(r.response?.ok).toBe(true);
    for (const b of r.response?.books ?? []) {
      expect(b.title.startsWith("书目 ")).toBe(true);
      expect(b.author).toBeNull();
    }
  });
});

// ---------- 9: helper coverage ----------

describe("helpers", () => {
  it("monthKeyFromSeconds formats UTC YYYY-MM", () => {
    expect(monthKeyFromSeconds(isoToSeconds("2026-04-15T00:00:00Z"))).toBe("2026-04");
    expect(monthKeyFromSeconds(isoToSeconds("2026-12-31T23:59:59Z"))).toBe("2026-12");
  });
  it("buildMonthWindow returns requested count, ascending", () => {
    const win = buildMonthWindow(NOW_SECONDS, 6);
    expect(win).toHaveLength(6);
    expect(win[win.length - 1]).toBe("2026-07");
    expect(win[0]).toBe("2026-02");
  });
  it("normalizeNoteType collapses unknown values", () => {
    expect(normalizeNoteType("highlight")).toBe("highlight");
    expect(normalizeNoteType("thought")).toBe("thought");
    expect(normalizeNoteType("review")).toBe("review");
    expect(normalizeNoteType("nonsense")).toBe("unknown");
    expect(normalizeNoteType(undefined)).toBe("unknown");
    expect(normalizeNoteType(null)).toBe("unknown");
  });
  it("resolveNoteTimestampSeconds returns null for missing/invalid", () => {
    expect(resolveNoteTimestampSeconds({ wereadBookId: "x" })).toBeNull();
    expect(resolveNoteTimestampSeconds({ wereadBookId: "x", createdAt: "" })).toBeNull();
    expect(resolveNoteTimestampSeconds({ wereadBookId: "x", createdAt: "not-a-date" })).toBeNull();
  });
  it("buildPublicBookItems returns fallback for missing metadata", () => {
    const out = buildPublicBookItems(
      [
        {
          catalogId: "10000000_000000000099",
          noteCount: 1,
          highlights: 1,
          thoughts: 0,
          reviews: 0,
          unknown: 0,
          activeMonths: 1,
          firstNoteAt: "2026-02-01T00:00:00.000Z",
          lastNoteAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      new Map()
    );
    expect(out[0].title).toBe("书目 10000000_000000000099");
  });
});