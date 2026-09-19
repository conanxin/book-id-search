type Lane = "CORE" | "ADJACENT" | "DISTANT" | "SURPRISE";

const baseUrl = (process.env.PREF_SMOKE_BASE_URL ?? "https://books.conanxin.com").replace(/\/$/, "");
const perSeedLimit = 20;

const laneSeeds: Record<Lane, Array<{ id: string; text: string }>> = {
  CORE: [
    { id: "core-ancient-road", text: "古道" },
    { id: "core-transport-gazetteer", text: "交通志" },
    { id: "core-temple", text: "寺庙" },
  ],
  ADJACENT: [
    { id: "adj-environmental-history", text: "环境史" },
    { id: "adj-infrastructure-history", text: "基础设施史" },
  ],
  DISTANT: [
    { id: "dist-material-culture", text: "物质文化" },
    { id: "dist-social-memory", text: "社会记忆" },
  ],
  SURPRISE: [
    { id: "surprise-meteorological-history", text: "气象史" },
  ],
};

interface SearchItem {
  id?: unknown;
  title?: unknown;
  author?: unknown;
  publisher?: unknown;
  year?: unknown;
}

interface SearchResponse {
  items?: SearchItem[];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalize(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function finiteYear(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d{4}$/.test(value.trim())) return Number(value.trim());
  return null;
}

async function fetchSeed(seed: string): Promise<SearchItem[]> {
  const url = new URL("/api/search", baseUrl);
  url.searchParams.set("q", seed);
  url.searchParams.set("limit", String(perSeedLimit));

  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });

  if (!response.ok) throw new Error(`GET /api/search failed with HTTP ${response.status}`);

  const body = (await response.json()) as SearchResponse;
  return Array.isArray(body.items) ? body.items : [];
}

function uniqueNonEmpty(values: string[]): number {
  return new Set(values.filter(Boolean)).size;
}

async function main() {
  const laneReports: Record<string, unknown> = {};
  let totalQueries = 0;
  let totalReturned = 0;
  let invalidCatalogIds = 0;

  for (const [lane, seeds] of Object.entries(laneSeeds) as Array<
    [Lane, Array<{ id: string; text: string }>]
  >) {
    const seedReports = [];
    const laneIds = new Set<string>();
    const laneAuthors: string[] = [];
    const lanePublishers: string[] = [];

    for (const seed of seeds) {
      totalQueries += 1;
      const items = await fetchSeed(seed.text);
      totalReturned += items.length;

      const seedNorm = normalize(seed.text);
      const titles = items.map((item) => text(item.title));
      const authors = items.map((item) => text(item.author));
      const publishers = items.map((item) => text(item.publisher));
      const years = items.map((item) => finiteYear(item.year)).filter((year): year is number => year !== null);

      const exactTitle = titles.filter((title) => normalize(title) === seedNorm).length;
      const titleContains = titles.filter((title) => normalize(title).includes(seedNorm)).length;

      for (const item of items) {
        const id = text(item.id);
        if (!/^[0-9]+_[0-9]{12}$/.test(id)) invalidCatalogIds += 1;
        if (id) laneIds.add(id);
      }
      laneAuthors.push(...authors);
      lanePublishers.push(...publishers);

      seedReports.push({
        seedId: seed.id,
        seed: seed.text,
        returned: items.length,
        exactTitleCount: exactTitle,
        exactTitleRate: items.length ? exactTitle / items.length : null,
        titleContainsSeedCount: titleContains,
        titleContainsSeedRate: items.length ? titleContains / items.length : null,
        uniqueTitles: uniqueNonEmpty(titles),
        uniqueAuthors: uniqueNonEmpty(authors),
        uniquePublishers: uniqueNonEmpty(publishers),
        knownYearRate: items.length ? years.length / items.length : null,
        yearMin: years.length ? Math.min(...years) : null,
        yearMax: years.length ? Math.max(...years) : null,
        preview: items.slice(0, 5).map((item, index) => ({
          rank: index + 1,
          catalogId: text(item.id),
          title: text(item.title),
          author: text(item.author) || null,
          publisher: text(item.publisher) || null,
          year: finiteYear(item.year),
          exactTitle: normalize(text(item.title)) === seedNorm,
        })),
      });
    }

    laneReports[lane] = {
      seedCount: seeds.length,
      unionCandidateCount: laneIds.size,
      uniqueAuthors: uniqueNonEmpty(laneAuthors),
      uniquePublishers: uniqueNonEmpty(lanePublishers),
      seeds: seedReports,
    };
  }

  const report = {
    status: invalidCatalogIds === 0 && totalQueries === 8 ? "PASS" : "FAIL",
    calibrationStatus: "AUTOMATED_DIAGNOSTICS_COMPLETE",
    humanSemanticReview: "PENDING",
    baseUrl,
    perSeedLimit,
    totalQueries,
    totalReturned,
    invalidCatalogIds,
    lanes: laneReports,
    interpretationGuardrails: {
      exactTitleRate: "lexical-shortcut diagnostic; not a direct quality score",
      titleContainsSeedRate: "surface lexical-fit diagnostic; not semantic relevance",
      diversity: "candidate variety diagnostic; not user-value evidence",
      semanticFit: "requires separate blinded human review before Pilot",
    },
    boundaries: {
      httpMethods: ["GET"],
      productionWrites: false,
      privateWereadData: false,
      onlineLearning: false,
      llmCalls: false,
    },
  };

  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        status: "ERROR",
        message: error instanceof Error ? error.message : "unknown error",
      },
      null,
      2
    )
  );
  process.exitCode = 1;
});
