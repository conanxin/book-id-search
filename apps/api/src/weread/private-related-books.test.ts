import { describe, expect, it } from "vitest";

import {
  RELATED_BOOKS_LIMITS,
  buildPrivateRelatedBooksResponse,
  fuseRelatedBookCandidates,
  runPrivateRelatedBooksSearch,
  sanitizeRelatedBookSeeds,
  searchRelatedBooksForSeed,
  validateRelatedBooksRequest,
  type MeiliSearchHandle,
  type RelatedBookSeed,
} from "./private-related-books.js";

function makeDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "13000000_000000000001",
    ssid: "13300000_000000000001",
    dxid: "9300000_000000000001",
    title: "合成测试标题 1",
    author: "合成测试作者",
    publisher: "合成测试出版社",
    year: 2024,
    isbn: "9787000000001",
    pages: 200,
    parseStatus: "ok",
    parseWarnings: [],
    ...overrides,
  };
}

describe("RELATED_BOOKS_LIMITS", () => {
  it("exposes the documented cap values", () => {
    expect(RELATED_BOOKS_LIMITS.MIN_SEEDS).toBe(1);
    expect(RELATED_BOOKS_LIMITS.MAX_SEEDS).toBe(6);
    expect(RELATED_BOOKS_LIMITS.MAX_SEED_CHARS).toBe(80);
    expect(RELATED_BOOKS_LIMITS.MAX_TOTAL_CHARS).toBe(320);
    expect(RELATED_BOOKS_LIMITS.MIN_LIMIT).toBe(1);
    expect(RELATED_BOOKS_LIMITS.MAX_LIMIT).toBe(24);
    expect(RELATED_BOOKS_LIMITS.DEFAULT_LIMIT).toBe(12);
    expect(RELATED_BOOKS_LIMITS.PER_SEED_FETCH).toBe(20);
    expect(RELATED_BOOKS_LIMITS.MAX_EXCLUDE_IDS).toBe(100);
    expect(RELATED_BOOKS_LIMITS.SEED_ID_RE.test("theme-1")).toBe(true);
    expect(RELATED_BOOKS_LIMITS.SEED_ID_RE.test("a:b")).toBe(false);
    expect(RELATED_BOOKS_LIMITS.SEED_ID_RE.test("a".repeat(33))).toBe(false);
    expect(RELATED_BOOKS_LIMITS.CATALOG_ID_RE.test("13000000_000000000001")).toBe(true);
    expect(RELATED_BOOKS_LIMITS.CATALOG_ID_RE.test("bad")).toBe(false);
  });
});

describe("validateRelatedBooksRequest", () => {
  it("1) accepts 1 seed", () => {
    const v = validateRelatedBooksRequest({
      seeds: [{ id: "theme-0", text: "合成主题 1" }],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.seeds).toHaveLength(1);
      expect(v.limit).toBe(12);
      expect(v.excludeCatalogIds).toEqual([]);
    }
  });

  it("accepts up to 6 seeds", () => {
    const seeds = Array.from({ length: 6 }, (_, i) => ({
      id: `theme-${i}`,
      text: `合成主题-${i}`,
    }));
    const v = validateRelatedBooksRequest({ seeds });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.seeds).toHaveLength(6);
  });

  it("2) rejects empty seeds array", () => {
    const v = validateRelatedBooksRequest({ seeds: [] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  it("3) rejects more than 6 seeds", () => {
    const seeds = Array.from({ length: 7 }, (_, i) => ({
      id: `theme-${i}`,
      text: `合成主题-${i}`,
    }));
    const v = validateRelatedBooksRequest({ seeds });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  it("4) rejects single seed longer than 80 chars", () => {
    const long = "合".repeat(81);
    const v = validateRelatedBooksRequest({ seeds: [{ id: "theme-0", text: long }] });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  it("5) rejects total chars > 320 across seeds", () => {
    // 5 distinct seeds of 70 chars each → 350 total, exceeds the 320 cap.
    const seeds = Array.from({ length: 5 }, (_, i) => ({
      id: `theme-${i}`,
      text: `${i}-` + "合".repeat(68),
    }));
    const v = validateRelatedBooksRequest({ seeds });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  it("6) rejects invalid seed id", () => {
    const v = validateRelatedBooksRequest({
      seeds: [{ id: "非法 id 包含空格和符号!", text: "合成主题" }],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  it("7) dedupes identical seed text but keeps the first id", () => {
    const v = validateRelatedBooksRequest({
      seeds: [
        { id: "theme-a", text: "合成重复主题" },
        { id: "theme-b", text: "合成重复主题" },
      ],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.seeds).toHaveLength(1);
      expect(v.seeds[0].id).toBe("theme-a");
      expect(v.seeds[0].text).toBe("合成重复主题");
    }
  });

  it("rejects non-string seed text", () => {
    const v = validateRelatedBooksRequest({
      seeds: [{ id: "theme-0", text: 123 }],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  it("rejects empty (trim → empty) seed text", () => {
    const v = validateRelatedBooksRequest({
      seeds: [{ id: "theme-0", text: "   " }],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  it("limits excludeCatalogIds to 100", () => {
    const ids = Array.from({ length: 101 }, (_, i) =>
      `${13000000 + i}_${String(i).padStart(12, "0")}`
    );
    const v = validateRelatedBooksRequest({
      seeds: [{ id: "theme-0", text: "合成主题" }],
      excludeCatalogIds: ids,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  it("11) accept and dedupes excludeCatalogIds", () => {
    const v = validateRelatedBooksRequest({
      seeds: [{ id: "theme-0", text: "合成主题" }],
      excludeCatalogIds: [
        "13000000_000000000001",
        "13000000_000000000001",
        "13000000_000000000002",
      ],
    });
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.excludeCatalogIds).toEqual([
        "13000000_000000000001",
        "13000000_000000000002",
      ]);
    }
  });

  it("12) limit must be between 1 and 24", () => {
    expect(
      (validateRelatedBooksRequest({
        seeds: [{ id: "theme-0", text: "合成主题" }],
        limit: 0,
      }) as { ok: false }).ok
    ).toBe(false);
    expect(
      (validateRelatedBooksRequest({
        seeds: [{ id: "theme-0", text: "合成主题" }],
        limit: 1,
      }) as { ok: true }).ok
    ).toBe(true);
    expect(
      (validateRelatedBooksRequest({
        seeds: [{ id: "theme-0", text: "合成主题" }],
        limit: 24,
      }) as { ok: true }).ok
    ).toBe(true);
    expect(
      (validateRelatedBooksRequest({
        seeds: [{ id: "theme-0", text: "合成主题" }],
        limit: 25,
      }) as { ok: false }).ok
    ).toBe(false);
  });

  it("non-integer limit is rejected", () => {
    const v = validateRelatedBooksRequest({
      seeds: [{ id: "theme-0", text: "合成主题" }],
      limit: 1.5,
    });
    expect(v.ok).toBe(false);
  });

  it("reject invalid catalogId in excludeCatalogIds", () => {
    const v = validateRelatedBooksRequest({
      seeds: [{ id: "theme-0", text: "合成主题" }],
      excludeCatalogIds: ["not-a-catalog-id"],
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.status).toBe(400);
  });

  it("strict cap on single seed of exactly 80 chars passes", () => {
    const text = "合".repeat(80);
    const v = validateRelatedBooksRequest({ seeds: [{ id: "theme-0", text }] });
    expect(v.ok).toBe(true);
  });

  it("strict cap on total of exactly 320 chars passes", () => {
    const seeds = Array.from({ length: 5 }, (_, i) => ({
      id: `theme-${i}`,
      text: "合".repeat(64),
    }));
    // 5 * 64 = 320, exactly the limit
    const v = validateRelatedBooksRequest({ seeds });
    expect(v.ok).toBe(true);
  });

  it("error messages never echo seed text", () => {
    const v = validateRelatedBooksRequest({
      seeds: [{ id: "theme-0", text: "LEAK_MARKER_PRIVATE_THEME" }],
      limit: 9999,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.message).not.toContain("LEAK_MARKER_PRIVATE_THEME");
    }
  });

  it("non-object body is rejected", () => {
    expect((validateRelatedBooksRequest(null) as { ok: false }).ok).toBe(false);
    expect((validateRelatedBooksRequest("hello") as { ok: false }).ok).toBe(false);
  });
});

describe("sanitizeRelatedBookSeeds", () => {
  it("keeps first id for duplicate text and drops invalid entries", () => {
    const seeds = [
      { id: "theme-a", text: "  合成 x  " },
      { id: "theme-b", text: "合成 x" },
      { id: "BAD", text: "合成 x" },
      { id: "theme-c", text: "" },
      { id: "theme-d", text: 999 },
      { id: "theme-e", text: "合".repeat(120) },
    ];
    const out = sanitizeRelatedBookSeeds(seeds);
    expect(out.seeds.map((s) => s.id)).toEqual(["theme-a", "theme-e"]);
    // 120-char text is clamped to 80
    expect(out.seeds[1].text.length).toBe(80);
    expect(out.totalChars).toBe(out.seeds[0].text.length + 80);
  });
});

describe("searchRelatedBooksForSeed", () => {
  it("calls meili.search with seed text and a 20-cap limit", async () => {
    const meili: MeiliSearchHandle = {
      search: async () => ({
        hits: [
          makeDoc({ id: "13000000_000000000001" }),
          makeDoc({ id: "13000000_000000000002" }),
        ],
      }),
    };
    const out = await searchRelatedBooksForSeed(
      { id: "theme-0", text: "合成主题" },
      20,
      meili
    );
    expect(out).toHaveLength(2);
    expect(out[0].catalogId).toBe("13000000_000000000001");
    expect(out[0].rank).toBe(0);
  });

  it("drops hits without a parseable catalogId", async () => {
    const meili: MeiliSearchHandle = {
      search: async () => ({
        hits: [
          { id: "bad-format", title: "no catalogId" },
          makeDoc({ id: "13000000_000000000003" }),
        ] as unknown as Array<Record<string, unknown>>,
      }),
    };
    const out = await searchRelatedBooksForSeed(
      { id: "theme-0", text: "合成主题" },
      20,
      meili
    );
    expect(out).toHaveLength(1);
    expect(out[0].catalogId).toBe("13000000_000000000003");
  });

  it("caps perSeedFetch to the documented maximum", async () => {
    const seen: number[] = [];
    const meili: MeiliSearchHandle = {
      search: async (_q: string, opts: { limit?: number }) => {
        seen.push(opts.limit ?? 0);
        return { hits: [] };
      },
    };
    await searchRelatedBooksForSeed(
      { id: "theme-0", text: "合成主题" },
      9999,
      meili
    );
    expect(seen).toEqual([RELATED_BOOKS_LIMITS.PER_SEED_FETCH]);
  });

  it("propagates meili errors", async () => {
    const meili: MeiliSearchHandle = {
      search: async () => {
        throw new Error("meili-down");
      },
    };
    await expect(
      searchRelatedBooksForSeed({ id: "theme-0", text: "合成主题" }, 20, meili)
    ).rejects.toThrow("meili-down");
  });
});

describe("fuseRelatedBookCandidates", () => {
  it("8) aggregates RRF score across multiple seeds and emits matchedSeedIds", () => {
    const A: RelatedBookSeed = { id: "theme-0", text: "alpha" };
    const B: RelatedBookSeed = { id: "theme-1", text: "beta" };
    const G: RelatedBookSeed = { id: "theme-2", text: "gamma" };
    const perSeed = [
      {
        seed: A,
        hits: [
          { catalogId: "13000000_000000000001", doc: makeDoc({ id: "13000000_000000000001" }), rank: 0 },
          { catalogId: "13000000_000000000002", doc: makeDoc({ id: "13000000_000000000002" }), rank: 1 },
        ],
      },
      {
        seed: B,
        hits: [
          { catalogId: "13000000_000000000001", doc: makeDoc({ id: "13000000_000000000001", title: "合成标题覆盖 1" }), rank: 2 },
        ],
      },
      {
        seed: G,
        hits: [
          { catalogId: "13000000_000000000003", doc: makeDoc({ id: "13000000_000000000003" }), rank: 0 },
        ],
      },
    ];
    const { ranked, candidatesConsidered } = fuseRelatedBookCandidates(perSeed);
    expect(candidatesConsidered).toBe(4);
    // catalog 1 was hit by A and B → has highest score
    expect(ranked[0].catalogId).toBe("13000000_000000000001");
    expect(ranked[0].matchedSeedIds.sort()).toEqual(["theme-0", "theme-1"]);
    // Distinct seed count tie-break pushes catalog 1 above 2/3
    expect(ranked[0].distinctSeedCount).toBe(2);
  });

  it("9) dedupes identical catalogId across hits but keeps first doc", () => {
    const A: RelatedBookSeed = { id: "theme-0", text: "alpha" };
    const perSeed = [
      {
        seed: A,
        hits: [
          { catalogId: "13000000_000000000001", doc: makeDoc({ id: "13000000_000000000001", title: "合成第一次出现" }), rank: 0 },
          { catalogId: "13000000_000000000001", doc: makeDoc({ id: "13000000_000000000001", title: "合成第二次出现" }), rank: 3 },
        ],
      },
    ];
    const { ranked } = fuseRelatedBookCandidates(perSeed);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].catalogId).toBe("13000000_000000000001");
    // First doc wins; do not dedupe by title.
    expect((ranked[0].doc as { title: string }).title).toBe("合成第一次出现");
    // RRF accumulation: 1/(60+0) + 1/(60+3)
    expect(ranked[0].score).toBeCloseTo(1 / 60 + 1 / 63, 6);
  });

  it("10) matchedSeedIds only contains seed ids that actually hit", () => {
    const A: RelatedBookSeed = { id: "theme-0", text: "alpha" };
    const B: RelatedBookSeed = { id: "theme-1", text: "beta" };
    const perSeed = [
      { seed: A, hits: [{ catalogId: "13000000_000000000004", doc: makeDoc({ id: "13000000_000000000004" }), rank: 0 }] },
      { seed: B, hits: [] },
    ];
    const { ranked } = fuseRelatedBookCandidates(perSeed);
    expect(ranked[0].matchedSeedIds).toEqual(["theme-0"]);
  });

  it("11) excludeCatalogIds removes hits before fusion", () => {
    const A: RelatedBookSeed = { id: "theme-0", text: "alpha" };
    const perSeed = [
      {
        seed: A,
        hits: [
          { catalogId: "13000000_000000000001", doc: makeDoc({ id: "13000000_000000000001" }), rank: 0 },
          { catalogId: "13000000_000000000002", doc: makeDoc({ id: "13000000_000000000002" }), rank: 1 },
        ],
      },
    ];
    const { ranked, candidatesConsidered } = fuseRelatedBookCandidates(perSeed, {
      excludeCatalogIds: new Set(["13000000_000000000001"]),
    });
    expect(ranked).toHaveLength(1);
    expect(ranked[0].catalogId).toBe("13000000_000000000002");
    expect(candidatesConsidered).toBe(2); // raw count, before dedupe
  });

  it("13) returns empty list when no candidates and zero fill for candidatesConsidered", () => {
    const A: RelatedBookSeed = { id: "theme-0", text: "alpha" };
    const { ranked, candidatesConsidered } = fuseRelatedBookCandidates([
      { seed: A, hits: [] },
    ]);
    expect(ranked).toEqual([]);
    expect(candidatesConsidered).toBe(0);
  });

  it("14) stable tie-break prefers lower best rank then catalogId ascending", () => {
    const A: RelatedBookSeed = { id: "theme-0", text: "alpha" };
    const B: RelatedBookSeed = { id: "theme-1", text: "beta" };
    const perSeed = [
      {
        seed: A,
        hits: [
          { catalogId: "13000000_000000000002", doc: makeDoc({ id: "13000000_000000000002" }), rank: 0 },
        ],
      },
      {
        seed: B,
        hits: [
          { catalogId: "13000000_000000000001", doc: makeDoc({ id: "13000000_000000000001" }), rank: 0 },
        ],
      },
    ];
    const { ranked } = fuseRelatedBookCandidates(perSeed);
    // Same RRF score (each at rank 0) and same distinctSeedCount (both 1) →
    // tie-break on bestRank (both 0) then catalogId ascending.
    expect(ranked[0].catalogId).toBe("13000000_000000000001");
    expect(ranked[1].catalogId).toBe("13000000_000000000002");
  });

  it("drops hits with empty title AND no fallback metadata", () => {
    const A: RelatedBookSeed = { id: "theme-0", text: "alpha" };
    const perSeed = [
      {
        seed: A,
        hits: [
          { catalogId: "13000000_000000000099", doc: { id: "13000000_000000000099", title: "" }, rank: 0 },
          { catalogId: "13000000_000000000098", doc: makeDoc({ id: "13000000_000000000098", title: "" }), rank: 1 },
        ],
      },
    ];
    const { ranked } = fuseRelatedBookCandidates(perSeed);
    // First one has title="" and no fallback → dropped
    // Second has title="" but author/publisher/isbn → kept (safe fallback)
    expect(ranked).toHaveLength(1);
    expect(ranked[0].catalogId).toBe("13000000_000000000098");
  });
});

describe("buildPrivateRelatedBooksResponse", () => {
  it("15) does NOT include seed text on items", () => {
    const resp = buildPrivateRelatedBooksResponse({
      seeds: [{ id: "theme-0", text: "LEAK_MARKER_PRIVATE_THEME" }],
      ranked: [
        {
          catalogId: "13000000_000000000001",
          doc: makeDoc(),
          matchedSeedIds: ["theme-0"],
        },
      ],
      excluded: 0,
      candidatesConsidered: 1,
      limit: 12,
    });
    const serialized = JSON.stringify(resp);
    expect(serialized).not.toContain("LEAK_MARKER_PRIVATE_THEME");
    expect(resp.items[0].title).toBe("合成测试标题 1");
  });

  it("16) does NOT leak _rankingScore, _rankingScoreDetails or _matchesPosition", () => {
    const resp = buildPrivateRelatedBooksResponse({
      seeds: [{ id: "theme-0", text: "合成主题" }],
      ranked: [
        {
          catalogId: "13000000_000000000001",
          doc: {
            ...makeDoc(),
            _rankingScore: 0.999,
            _rankingScoreDetails: { LEAK_marker: "ranking-detail" },
            _matchesPosition: { LEAK_marker: "matches-position" },
            _formatted: { LEAK_marker: "formatted" },
          },
          matchedSeedIds: ["theme-0"],
        },
      ],
      excluded: 0,
      candidatesConsidered: 1,
      limit: 12,
    });
    const serialized = JSON.stringify(resp);
    expect(serialized).not.toContain("_rankingScore");
    expect(serialized).not.toContain("_rankingScoreDetails");
    expect(serialized).not.toContain("_matchesPosition");
    expect(serialized).not.toContain("_formatted");
    expect(serialized).not.toContain("LEAK_marker");
  });

  it("17) does NOT leak the entire Meili document", () => {
    const resp = buildPrivateRelatedBooksResponse({
      seeds: [{ id: "theme-0", text: "合成主题" }],
      ranked: [
        {
          catalogId: "13000000_000000000001",
          doc: {
            ...makeDoc(),
            ssid: "LEAK_ssid_field",
            dxid: "LEAK_dxid_field",
            rawInfo: "LEAK_rawinfo_field",
            parseWarnings: ["LEAK_warnings_field"],
            parseStatus: "ok",
            pages: 999,
            // A historical accidental private key in some schema migrations.
            wereadBookId: "LEAK_weread_book_id",
            noteId: "LEAK_note_id",
            chapterTitle: "LEAK_chapter_title",
            privateTitle: "LEAK_private_title",
          },
          matchedSeedIds: ["theme-0"],
        },
      ],
      excluded: 0,
      candidatesConsidered: 1,
      limit: 12,
    });
    const serialized = JSON.stringify(resp);
    expect(serialized).not.toContain("LEAK_ssid_field");
    expect(serialized).not.toContain("LEAK_dxid_field");
    expect(serialized).not.toContain("LEAK_rawinfo_field");
    expect(serialized).not.toContain("LEAK_warnings_field");
    expect(serialized).not.toContain("LEAK_weread_book_id");
    expect(serialized).not.toContain("LEAK_note_id");
    expect(serialized).not.toContain("LEAK_chapter_title");
    expect(serialized).not.toContain("LEAK_private_title");
    expect(serialized).not.toContain("pages");
    expect(serialized).not.toContain("parseStatus");
  });

  it("18) does NOT include private ids in matchedSeedIds", () => {
    const resp = buildPrivateRelatedBooksResponse({
      seeds: [{ id: "theme-0", text: "合成主题" }],
      ranked: [
        {
          catalogId: "13000000_000000000001",
          doc: makeDoc(),
          matchedSeedIds: ["theme-0"],
        },
      ],
      excluded: 0,
      candidatesConsidered: 1,
      limit: 12,
    });
    const serialized = JSON.stringify(resp);
    expect(serialized).not.toMatch(/wereadBookId|noteId|highlightId|chapterTitle/);
    expect(resp.items[0].matchedSeedIds).toEqual(["theme-0"]);
  });

  it("returns up to limit results and supports below-the-cap inputs", () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      catalogId: `13000000_${String(i).padStart(12, "0")}`,
      doc: makeDoc({ id: `13000000_${String(i).padStart(12, "0")}`, title: `合成标题-${i}` }),
      matchedSeedIds: ["theme-0"],
    }));
    const limited = buildPrivateRelatedBooksResponse({
      seeds: [{ id: "theme-0", text: "合成主题" }],
      ranked: items,
      excluded: 0,
      candidatesConsidered: items.length,
      limit: 2,
    });
    expect(limited.items).toHaveLength(2);
    expect(limited.meta.returned).toBe(2);
    expect(limited.meta.persisted).toBe(false);
    expect(limited.meta.source).toBe("meilisearch");
    expect(limited.meta.seedsUsed).toBe(1);
  });
});

describe("runPrivateRelatedBooksSearch", () => {
  it("returns a controlled error when search throws and NEVER echoes seed text", async () => {
    const out = await runPrivateRelatedBooksSearch(
      {
        seeds: [{ id: "theme-0", text: "LEAK_MARKER_PRIVATE_THEME" }],
      },
      async () => {
        throw new Error("meili-upstream-error-with-LEAK_MARKER_PRIVATE_THEME");
      }
    );
    expect(out.response).toBeUndefined();
    expect(out.error).toBeDefined();
    if (out.error) {
      expect(out.error.status).toBe(502);
      expect(out.error.message).not.toContain("LEAK_MARKER_PRIVATE_THEME");
    }
  });

  it("maps validation failures to error envelope", async () => {
    const out = await runPrivateRelatedBooksSearch(
      { seeds: [] },
      async () => []
    );
    expect(out.error?.status).toBe(400);
  });

  it("21) produces meta.persisted=false", async () => {
    const out = await runPrivateRelatedBooksSearch(
      { seeds: [{ id: "theme-0", text: "合成主题 x" }] },
      async () => [
        {
          catalogId: "13000000_000000000001",
          doc: makeDoc(),
          rank: 0,
        },
      ]
    );
    expect(out.response?.meta.persisted).toBe(false);
  });

  it("22) meta.source is meilisearch", async () => {
    const out = await runPrivateRelatedBooksSearch(
      { seeds: [{ id: "theme-0", text: "合成主题 y" }] },
      async () => [
        {
          catalogId: "13000000_000000000001",
          doc: makeDoc(),
          rank: 0,
        },
      ]
    );
    expect(out.response?.meta.source).toBe("meilisearch");
  });

  it("passes through a valid request and respects limit + excludeCatalogIds", async () => {
    const docs = Array.from({ length: 5 }, (_, i) =>
      makeDoc({
        id: `13000000_${String(i).padStart(12, "0")}`,
        title: `合成标题-${i}`,
      })
    );
    const out = await runPrivateRelatedBooksSearch(
      {
        seeds: [{ id: "theme-0", text: "合成主题 z" }],
        excludeCatalogIds: ["13000000_000000000000"],
        limit: 3,
      },
      async () => docs.map((doc, rank) => ({ catalogId: doc.id as string, doc, rank }))
    );
    expect(out.error).toBeUndefined();
    expect(out.response?.items).toHaveLength(3);
    expect(out.response?.meta.returned).toBe(3);
    expect(out.response?.meta.seedsUsed).toBe(1);
    expect(out.response?.meta.candidatesConsidered).toBe(5);
  });
});

describe("forbidden output guard", () => {
  it("19) smoke test: structured response omits forbidden substrings", async () => {
    const out = await runPrivateRelatedBooksSearch(
      {
        seeds: [
          { id: "theme-0", text: "LEAK-private-theme-A" },
          { id: "theme-1", text: "LEAK-private-theme-B" },
        ],
      },
      async (q) => [
        {
          catalogId: "13000000_000000000001",
          doc: makeDoc({
            id: "13000000_000000000001",
            title: "Public Title",
            wereadBookId: "LEAK-WBID",
            noteId: "LEAK-NOTE",
            chapterTitle: "LEAK-CHAP",
          }),
          rank: 0,
        },
      ]
    );
    const serialized = JSON.stringify(out.response);
    for (const forbidden of [
      "LEAK-private-theme-A",
      "LEAK-private-theme-B",
      "LEAK-WBID",
      "LEAK-NOTE",
      "LEAK-CHAP",
      "wereadBookId",
      "noteId",
      "chapterTitle",
      "_rankingScore",
      "LEAK-private-theme-A",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(out.response?.items[0].matchedSeedIds.sort()).toEqual(["theme-0", "theme-1"]);
  });
});
