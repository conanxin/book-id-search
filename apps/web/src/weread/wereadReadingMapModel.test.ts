import { describe, expect, it } from "vitest";
import {
  NETWORK_VIEWBOX_HEIGHT,
  NETWORK_VIEWBOX_WIDTH,
  RADIUS_LIMITS,
  READING_MAP_VIEWBOX,
  TIMELINE_VIEWBOX_HEIGHT,
  TIMELINE_VIEWBOX_WIDTH,
  buildReadingMapEdgeLayout,
  buildReadingMapNodeLayout,
  buildTimelineBarModel,
  formatReadingMapDateRange,
  formatReadingMapMonth,
  formatReadingMapOverview,
  getReadingMapLinkLabel,
  getReadingMapNodeLayout,
  getReadingMapNodeRadius,
  hasReadingMapData,
  truncateReadingMapTitle,
} from "./wereadReadingMapModel";
import type {
  WereadReadingMapBook,
  WereadReadingMapLink,
  WereadReadingMapMonth,
  WereadReadingMapOverview,
  WereadReadingMapResponse,
} from "../wereadPrivate";

// ---------- formatters ----------

describe("formatReadingMapMonth", () => {
  it("formats YYYY-MM as YYYY 年 N 月", () => {
    expect(formatReadingMapMonth("2026-01")).toBe("2026 年1 月");
    expect(formatReadingMapMonth("2026-12")).toBe("2026 年12 月");
  });
  it("falls back to the raw string for malformed keys", () => {
    expect(formatReadingMapMonth("nope")).toBe("nope");
    expect(formatReadingMapMonth("2026-13")).toBe("2026-13");
  });
});

describe("formatReadingMapDateRange", () => {
  it("formats ISO timestamps as YYYY-MM-DD", () => {
    expect(formatReadingMapDateRange("2026-01-05T00:00:00.000Z", "2026-07-12T00:00:00.000Z"))
      .toBe("2026-01-05 → 2026-07-12");
  });
  it("returns fallback text when either side is null", () => {
    expect(formatReadingMapDateRange(null, null)).toBe("暂无笔记日期");
    expect(formatReadingMapDateRange("2026-01-01T00:00:00.000Z", null)).toBe("暂无笔记日期");
  });
});

describe("formatReadingMapOverview", () => {
  it("returns placeholder strings for null input", () => {
    const v = formatReadingMapOverview(null);
    expect(v.booksCount).toBe("—");
    expect(v.hasData).toBe(false);
  });
  it("populates fields from a real overview", () => {
    const overview: WereadReadingMapOverview = {
      booksCount: 1586,
      notesCount: 6989,
      matchedCatalogsCount: 323,
      matchedNoteRecordsCount: 281,
      firstNoteAt: "2024-01-01T00:00:00.000Z",
      lastNoteAt: "2026-07-12T00:00:00.000Z",
      activeMonths: 30,
      currentStreakMonths: 12,
      longestStreakMonths: 24,
    };
    const v = formatReadingMapOverview(overview);
    expect(v.booksCount).toBe("1,586");
    expect(v.activeMonths).toBe("30");
    expect(v.hasData).toBe(true);
  });
});

// ---------- timeline ----------

describe("buildTimelineBarModel", () => {
  const months: WereadReadingMapMonth[] = [
    { month: "2026-02", total: 0, highlights: 0, thoughts: 0, reviews: 0, unknown: 0, matched: 0 },
    { month: "2026-03", total: 3, highlights: 2, thoughts: 1, reviews: 0, unknown: 0, matched: 1 },
    { month: "2026-04", total: 2, highlights: 1, thoughts: 1, reviews: 0, unknown: 0, matched: 0 },
    { month: "2026-05", total: 2, highlights: 1, thoughts: 0, reviews: 1, unknown: 0, matched: 1 },
    { month: "2026-06", total: 3, highlights: 1, thoughts: 2, reviews: 0, unknown: 0, matched: 2 },
    { month: "2026-07", total: 1, highlights: 1, thoughts: 0, reviews: 0, unknown: 0, matched: 1 },
  ];

  it("returns one bar per month with consistent ratios", () => {
    const model = buildTimelineBarModel(months, 6);
    expect(model.bars).toHaveLength(6);
    expect(model.maxTotal).toBe(3);
    expect(model.width).toBe(TIMELINE_VIEWBOX_WIDTH);
    expect(model.stepX).toBeGreaterThan(0);
  });
  it("heightPct is 0 for empty months", () => {
    const model = buildTimelineBarModel(months, 6);
    expect(model.bars[0].heightPct).toBe(0);
    expect(model.bars[0].total).toBe(0);
  });
  it("heightPct is bounded between 0 and 100", () => {
    const model = buildTimelineBarModel(months, 6);
    for (const bar of model.bars) {
      expect(bar.heightPct).toBeGreaterThanOrEqual(0);
      expect(bar.heightPct).toBeLessThanOrEqual(100);
    }
  });
  it("type percentages sum to ≤ 100 and never NaN", () => {
    const model = buildTimelineBarModel(months, 6);
    for (const bar of model.bars) {
      const sum = bar.highlightPct + bar.thoughtPct + bar.reviewPct + bar.unknownPct;
      expect(sum).toBeLessThanOrEqual(100.0001);
      for (const v of [bar.highlightPct, bar.thoughtPct, bar.reviewPct, bar.unknownPct]) {
        expect(Number.isNaN(v)).toBe(false);
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
  it("hasAnyActivity reflects whether any month had notes", () => {
    const empty = buildTimelineBarModel(
      months.map((m) => ({ ...m, total: 0 })),
      6
    );
    expect(empty.hasAnyActivity).toBe(false);
  });
});

// ---------- network ----------

function makeBooks(n: number): WereadReadingMapBook[] {
  return Array.from({ length: n }, (_, i) => ({
    catalogId: `1000000${i}_000000000000`,
    title: `书目 ${i + 1}`,
    author: `作者 ${i + 1}`,
    publisher: null,
    publishYear: 2024,
    noteCount: 10 + i,
    highlights: 5,
    thoughts: 2,
    reviews: 1,
    unknown: 0,
    activeMonths: 6,
    firstNoteAt: null,
    lastNoteAt: null,
  }));
}

describe("buildReadingMapNodeLayout", () => {
  it("returns one node per book with bounded radius", () => {
    const nodes = buildReadingMapNodeLayout({ books: makeBooks(6) });
    expect(nodes).toHaveLength(6);
    for (const n of nodes) {
      expect(n.radius).toBeGreaterThanOrEqual(RADIUS_LIMITS.MIN);
      expect(n.radius).toBeLessThanOrEqual(RADIUS_LIMITS.MAX);
    }
  });
  it("places nodes inside the viewBox", () => {
    const nodes = buildReadingMapNodeLayout({ books: makeBooks(12) });
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(0);
      expect(n.x).toBeLessThanOrEqual(NETWORK_VIEWBOX_WIDTH);
      expect(n.y).toBeGreaterThanOrEqual(0);
      expect(n.y).toBeLessThanOrEqual(NETWORK_VIEWBOX_HEIGHT);
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });
  it("produces stable positions across runs", () => {
    const a = buildReadingMapNodeLayout({ books: makeBooks(8) });
    const b = buildReadingMapNodeLayout({ books: makeBooks(8) });
    expect(a.map((n) => [n.x, n.y])).toEqual(b.map((n) => [n.x, n.y]));
  });
  it("handles 6/12/18 nodes without crashing", () => {
    for (const n of [6, 12, 18]) {
      const nodes = buildReadingMapNodeLayout({ books: makeBooks(n) });
      expect(nodes).toHaveLength(n);
    }
  });
  it("returns an empty array for empty input", () => {
    expect(buildReadingMapNodeLayout({ books: [] })).toEqual([]);
  });
  it("does not produce NaN/Infinity", () => {
    const nodes = buildReadingMapNodeLayout({ books: makeBooks(18) });
    for (const n of nodes) {
      expect(Number.isNaN(n.x)).toBe(false);
      expect(Number.isNaN(n.y)).toBe(false);
      expect(Number.isNaN(n.radius)).toBe(false);
    }
  });
  it("does not pack nodes tighter than minRadius apart (acceptable overlap)", () => {
    const nodes = buildReadingMapNodeLayout({ books: makeBooks(18) });
    const minDist = RADIUS_LIMITS.MIN * 1.4;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        // With 18 nodes and a 520px-tall canvas, packed into two rings, the
        // minimum radius gap is well above 1.4× the smallest node radius.
        expect(dist).toBeGreaterThanOrEqual(minDist);
      }
    }
  });
});

describe("buildReadingMapEdgeLayout", () => {
  const books = makeBooks(4);
  const nodes = buildReadingMapNodeLayout({ books });
  const links: WereadReadingMapLink[] = [
    { sourceCatalogId: books[0].catalogId, targetCatalogId: books[1].catalogId, sharedMonths: 3, weight: 6 },
    { sourceCatalogId: books[0].catalogId, targetCatalogId: books[2].catalogId, sharedMonths: 2, weight: 4 },
    { sourceCatalogId: books[2].catalogId, targetCatalogId: books[3].catalogId, sharedMonths: 1, weight: 2 },
  ];
  it("maps each link onto node coordinates", () => {
    const edges = buildReadingMapEdgeLayout({ links, nodes });
    expect(edges).toHaveLength(3);
    for (const e of edges) {
      expect(Number.isFinite(e.length)).toBe(true);
      expect(e.length).toBeGreaterThanOrEqual(0);
    }
  });
  it("drops links whose endpoints are missing", () => {
    const broken: WereadReadingMapLink[] = [
      ...links,
      { sourceCatalogId: "missing", targetCatalogId: "missing", sharedMonths: 1, weight: 1 },
    ];
    const edges = buildReadingMapEdgeLayout({ links: broken, nodes });
    expect(edges).toHaveLength(3);
  });
});

describe("getReadingMapNodeRadius", () => {
  it("respects min/max bounds", () => {
    expect(getReadingMapNodeRadius(0, 100)).toBe(RADIUS_LIMITS.MIN);
    expect(getReadingMapNodeRadius(100, 100)).toBe(RADIUS_LIMITS.MAX);
    expect(getReadingMapNodeRadius(-5, 100)).toBe(RADIUS_LIMITS.MIN);
  });
  it("never returns NaN/Infinity for invalid inputs", () => {
    const r = getReadingMapNodeRadius(NaN, NaN);
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBe(RADIUS_LIMITS.MIN);
  });
});

describe("truncateReadingMapTitle", () => {
  it("returns empty string for empty input", () => {
    expect(truncateReadingMapTitle("")).toBe("");
  });
  it("returns the original when shorter than the cap", () => {
    expect(truncateReadingMapTitle("短标题", 18)).toBe("短标题");
  });
  it("truncates long titles with an ellipsis", () => {
    const long = "这是一个非常非常长的书目标题，应该被截断";
    const out = truncateReadingMapTitle(long, 18);
    expect(out.length).toBeLessThanOrEqual(18);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("getReadingMapLinkLabel", () => {
  it("uses singular for 1 shared month", () => {
    expect(getReadingMapLinkLabel({ sourceCatalogId: "a", targetCatalogId: "b", sharedMonths: 1, weight: 2 }))
      .toBe("共同活跃 1 个月");
  });
  it("uses plural otherwise", () => {
    expect(getReadingMapLinkLabel({ sourceCatalogId: "a", targetCatalogId: "b", sharedMonths: 3, weight: 5 }))
      .toBe("共同活跃 3 个月");
  });
});

describe("hasReadingMapData", () => {
  it("returns false for null", () => {
    expect(hasReadingMapData(null)).toBe(false);
  });
  it("returns true when overview has matched records", () => {
    const resp: WereadReadingMapResponse = {
      ok: true,
      overview: {
        booksCount: 5,
        notesCount: 10,
        matchedCatalogsCount: 5,
        matchedNoteRecordsCount: 1,
        firstNoteAt: null,
        lastNoteAt: null,
        activeMonths: 1,
        currentStreakMonths: 1,
        longestStreakMonths: 1,
      },
      timeline: [],
      books: [],
      links: [],
      meta: {
        monthsRequested: 24,
        monthsReturned: 24,
        topBooksRequested: 12,
        topBooksReturned: 0,
        linksReturned: 0,
        persisted: false,
        source: "private_snapshot+public_catalog",
      },
    };
    expect(hasReadingMapData(resp)).toBe(true);
  });
  it("returns true when timeline has activity", () => {
    const resp: WereadReadingMapResponse = {
      ok: true,
      overview: {
        booksCount: 5,
        notesCount: 0,
        matchedCatalogsCount: 0,
        matchedNoteRecordsCount: 0,
        firstNoteAt: null,
        lastNoteAt: null,
        activeMonths: 0,
        currentStreakMonths: 0,
        longestStreakMonths: 0,
      },
      timeline: [
        { month: "2026-07", total: 1, highlights: 1, thoughts: 0, reviews: 0, unknown: 0, matched: 0 },
      ],
      books: [],
      links: [],
      meta: {
        monthsRequested: 24,
        monthsReturned: 24,
        topBooksRequested: 12,
        topBooksReturned: 0,
        linksReturned: 0,
        persisted: false,
        source: "private_snapshot+public_catalog",
      },
    };
    expect(hasReadingMapData(resp)).toBe(true);
  });
});

// ---------- viewBox constants ----------

describe("viewBox constants", () => {
  it("network viewBox is 900×520", () => {
    expect(NETWORK_VIEWBOX_WIDTH).toBe(900);
    expect(NETWORK_VIEWBOX_HEIGHT).toBe(520);
  });
  it("timeline viewBox is 900×220", () => {
    expect(TIMELINE_VIEWBOX_WIDTH).toBe(900);
    expect(TIMELINE_VIEWBOX_HEIGHT).toBe(220);
  });
  it("READING_MAP_VIEWBOX mirrors the constants", () => {
    expect(READING_MAP_VIEWBOX.network).toEqual({ width: 900, height: 520 });
    expect(READING_MAP_VIEWBOX.timeline).toEqual({ width: 900, height: 220 });
  });
});

describe("getReadingMapNodeLayout exposes same algorithm", () => {
  it("matches buildReadingMapNodeLayout output", () => {
    const books = makeBooks(5);
    expect(getReadingMapNodeLayout({ books })).toEqual(buildReadingMapNodeLayout({ books }));
  });
});