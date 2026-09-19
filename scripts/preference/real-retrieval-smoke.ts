import {
  runPrivateRelatedBooksSearch,
  type Searcher,
} from "../../apps/api/src/weread/private-related-books.js";
import {
  composeSlate,
  computeInputHashes,
  evaluatePreferenceSession,
} from "./harness.js";
import type {
  PreferenceCandidate,
  PreferenceLane,
  PreferenceProfile,
} from "./types.js";

const baseUrl = (process.env.PREF_SMOKE_BASE_URL ?? "https://books.conanxin.com").replace(/\/$/, "");

const laneSeeds: Record<PreferenceLane, Array<{ id: string; text: string }>> = {
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

interface PublicSearchResponse {
  items?: Array<Record<string, unknown>>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function publicApiSearcher(): Searcher {
  return async (query, perSeedFetch) => {
    const url = new URL("/api/search", baseUrl);
    url.searchParams.set("q", query);
    url.searchParams.set("limit", String(Math.max(1, Math.min(perSeedFetch, 20))));

    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`public search returned HTTP ${response.status}`);
    }

    const body = (await response.json()) as PublicSearchResponse;
    const items = Array.isArray(body.items) ? body.items : [];

    return items.flatMap((doc, rank) => {
      const rawId = doc.id ?? doc.catalogId;
      if (typeof rawId !== "string") return [];
      const catalogId = rawId.trim();
      if (!/^[0-9]+_[0-9]{12}$/.test(catalogId)) return [];
      return [{ catalogId, doc, rank }];
    });
  };
}

async function fetchLane(
  lane: PreferenceLane,
  searcher: Searcher
): Promise<PreferenceCandidate[]> {
  const result = await runPrivateRelatedBooksSearch(
    {
      seeds: laneSeeds[lane],
      limit: 20,
    },
    searcher
  );

  if (result.error || !result.response) {
    throw new Error(`${lane} retrieval failed: ${result.error?.message ?? "missing response"}`);
  }

  const sourceLayers =
    lane === "CORE"
      ? (["P1"] as const)
      : lane === "SURPRISE"
        ? ([] as const)
        : (["P3"] as const);

  return result.response.items.map((item, index) => ({
    catalogId: item.catalogId,
    title: item.title,
    author: item.author ?? null,
    series: null,
    lane,
    topics: [lane.toLowerCase()],
    sourceLayers: [...sourceLayers],
    matchedSeedIds: item.matchedSeedIds,
    retrievalCallId: `live-${lane.toLowerCase()}-rrf`,
    retrievalRank: index,
    reasonCode: `LIVE_RRF_${lane}`,
    preExperimentUncertain: lane !== "CORE",
  }));
}

async function main() {
  const searcher = publicApiSearcher();
  const laneCandidates: Record<PreferenceLane, PreferenceCandidate[]> = {
    CORE: await fetchLane("CORE", searcher),
    ADJACENT: await fetchLane("ADJACENT", searcher),
    DISTANT: await fetchLane("DISTANT", searcher),
    SURPRISE: await fetchLane("SURPRISE", searcher),
  };

  const profile: PreferenceProfile = {
    version: "pref-exp-1d-smoke.v0.1",
    entries: [],
    constraints: {
      temporaryMax: 2,
      sameAuthorMax: 1,
      sameSeriesMax: 2,
      topicCaps: {},
      avoidTopics: [],
      noHistory: false,
    },
  };

  const seedFixture = {
    version: "pref-exp-1d-live-seeds.v0.1",
    lanes: laneSeeds,
  };
  const protocol = {
    version: "pref-exp-1d.v0.1",
    mode: "D",
    budget: { CORE: 6, ADJACENT: 2, DISTANT: 1, SURPRISE: 1 },
    readOnly: true,
  };

  const inputHashes = computeInputHashes({
    profile,
    seedFixture,
    knownBookSet: [],
    protocol,
  });

  const session = composeSlate({
    sessionId: "pref-exp-1d-live-smoke",
    mode: "D",
    profile,
    candidates: [
      ...laneCandidates.CORE,
      ...laneCandidates.ADJACENT,
      ...laneCandidates.DISTANT,
      ...laneCandidates.SURPRISE,
    ],
    knownCatalogIds: [],
    inputHashes,
  });

  const evaluation = evaluatePreferenceSession({
    session,
    profile,
  });

  const laneCounts = Object.fromEntries(
    (["CORE", "ADJACENT", "DISTANT", "SURPRISE"] as const).map((lane) => [
      lane,
      session.items.filter((item) => item.lane === lane).length,
    ])
  );

  const report = {
    status:
      session.state === "COMPLETE" &&
      evaluation.verdict === "PASS" &&
      evaluation.metrics.EBE === 0 &&
      evaluation.metrics.ETR === 1
        ? "PASS"
        : "FAIL",
    baseUrl,
    retrieval: Object.fromEntries(
      (["CORE", "ADJACENT", "DISTANT", "SURPRISE"] as const).map((lane) => [
        lane,
        {
          seeds: laneSeeds[lane],
          candidates: laneCandidates[lane].length,
        },
      ])
    ),
    session: {
      state: session.state,
      laneCounts,
      itemCount: session.items.length,
      inputHashes,
    },
    evaluation: {
      verdict: evaluation.verdict,
      hardFailures: evaluation.hardFailures,
      EBE: evaluation.metrics.EBE,
      ETR: evaluation.metrics.ETR,
    },
    items: session.items.map((item) => ({
      rank: item.finalRank,
      lane: item.lane,
      catalogId: item.catalogId,
      title: item.title,
      author: asString(item.author),
      matchedSeedIds: item.matchedSeedIds,
      reasonCode: item.reasonCode,
    })),
    boundaries: {
      httpMethods: ["GET"],
      productionWrites: false,
      privateWereadData: false,
      onlineLearning: false,
      llmCalls: false,
    },
  };

  console.log(JSON.stringify(report, null, 2));

  if (report.status !== "PASS") {
    process.exitCode = 1;
  }
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
