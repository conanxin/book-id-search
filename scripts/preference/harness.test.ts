import { describe, expect, it } from "vitest";

import {
  DEFAULT_SOVEREIGN_BUDGET,
  composeSlate,
  computeInputHashes,
  evaluatePreferenceSession,
  resetPreferenceProfile,
} from "./harness.js";
import type {
  InputHashes,
  PreferenceCandidate,
  PreferenceLane,
  PreferenceProfile,
  PreferenceSession,
  T0Feedback,
  T7Feedback,
} from "./types.js";

const HASHES: InputHashes = {
  profileHash: "profile-v1",
  seedFixtureHash: "seeds-v1",
  knownBookSetHash: "known-v1",
  protocolHash: "protocol-v1",
};

function profile(overrides: Partial<PreferenceProfile> = {}): PreferenceProfile {
  return {
    version: "profile.v0.1",
    entries: [],
    constraints: {
      temporaryMax: 2,
      sameAuthorMax: 1,
      sameSeriesMax: 2,
      topicCaps: {},
      avoidTopics: [],
    },
    ...overrides,
  };
}

function candidate(
  n: number,
  lane: PreferenceLane = "CORE",
  overrides: Partial<PreferenceCandidate> = {}
): PreferenceCandidate {
  return {
    catalogId: `synthetic-${String(n).padStart(3, "0")}`,
    title: `合成测试书 ${n}`,
    author: `合成作者 ${n}`,
    series: null,
    lane,
    topics: [lane.toLowerCase()],
    sourceLayers: lane === "SURPRISE" ? [] : ["P1"],
    matchedSeedIds: [`seed-${lane.toLowerCase()}`],
    retrievalCallId: `retrieval-${lane.toLowerCase()}-${n}`,
    retrievalRank: n,
    reasonCode: `TEST_${lane}`,
    ...overrides,
  };
}

function makeSession(
  items: PreferenceCandidate[],
  overrides: Partial<PreferenceSession> = {}
): PreferenceSession {
  return {
    sessionId: "synthetic-session",
    mode: "B",
    profileVersion: "profile.v0.1",
    inputHashes: HASHES,
    noHistory: false,
    budget: DEFAULT_SOVEREIGN_BUDGET,
    items: items.map((item, index) => ({ ...item, finalRank: index + 1 })),
    state: items.length === 10 ? "COMPLETE" : "UNDERFILLED",
    ...overrides,
  };
}

function t0(
  item: PreferenceCandidate,
  overrides: Partial<T0Feedback> = {}
): T0Feedback {
  return {
    catalogId: item.catalogId,
    relevanceNow: 3,
    curiosity: 3,
    surprise: 3,
    researchValue: 3,
    explanationFit: 3,
    saveNow: false,
    alreadyKnown: false,
    tooSimilar: false,
    wrongDirection: false,
    ...overrides,
  };
}

function t7(
  item: PreferenceCandidate,
  overrides: Partial<T7Feedback> = {}
): T7Feedback {
  return {
    catalogId: item.catalogId,
    wouldRecommendToPastSelf: false,
    delayedValue: 3,
    actionTaken: [],
    preferenceShift: "NONE",
    preferenceShiftEndorsed: "UNSURE",
    ...overrides,
  };
}

describe("PREF-EXP-1C synthetic harness", () => {
  it("T1 composes sovereign exploration as 6/2/1/1 when candidates are sufficient", () => {
    const candidates = [
      ...Array.from({ length: 12 }, (_, i) => candidate(i + 1, "CORE")),
      ...Array.from({ length: 6 }, (_, i) => candidate(100 + i, "ADJACENT")),
      ...Array.from({ length: 4 }, (_, i) => candidate(200 + i, "DISTANT")),
      ...Array.from({ length: 4 }, (_, i) => candidate(300 + i, "SURPRISE")),
    ];

    const session = composeSlate({
      sessionId: "quota",
      mode: "D",
      profile: profile(),
      candidates,
      inputHashes: HASHES,
    });

    expect(session.state).toBe("COMPLETE");
    expect(session.items).toHaveLength(10);
    const counts = Object.fromEntries(
      (["CORE", "ADJACENT", "DISTANT", "SURPRISE"] as const).map((lane) => [
        lane,
        session.items.filter((item) => item.lane === lane).length,
      ])
    );
    expect(counts).toEqual({ CORE: 6, ADJACENT: 2, DISTANT: 1, SURPRISE: 1 });

    const evaluation = evaluatePreferenceSession({
      session,
      profile: profile(),
    });
    expect(evaluation.metrics.EBE).toBe(0);
    expect(evaluation.verdict).toBe("PASS");
  });

  it("T2 enforces the temporary-topic cap even when temporary candidates rank first", () => {
    const p = profile({ constraints: { temporaryMax: 2 } });
    const candidates = [
      ...Array.from({ length: 8 }, (_, i) =>
        candidate(i + 1, "CORE", { temporaryTopic: true, sourceLayers: ["P1"] })
      ),
      ...Array.from({ length: 12 }, (_, i) =>
        candidate(100 + i, "CORE", { sourceLayers: ["P1"] })
      ),
    ];

    const session = composeSlate({
      sessionId: "temp-cap",
      mode: "C",
      profile: p,
      candidates,
      inputHashes: HASHES,
    });

    expect(session.items.filter((item) => item.temporaryTopic).length).toBe(2);
    expect(session.items).toHaveLength(10);
  });

  it("T3 prevents P0 behavior from overriding a P2 topic cap in Mode C", () => {
    const p = profile({
      constraints: {
        temporaryMax: 10,
        sameAuthorMax: 10,
        sameSeriesMax: 10,
        topicCaps: { AI: 2 },
      },
    });
    const candidates = [
      ...Array.from({ length: 8 }, (_, i) =>
        candidate(i + 1, "CORE", {
          topics: ["AI"],
          sourceLayers: ["P1", "P2"],
          author: `AI 作者 ${i}`,
        })
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        candidate(100 + i, "ADJACENT", {
          topics: ["环境史"],
          sourceLayers: ["P3"],
          author: `环境史作者 ${i}`,
        })
      ),
    ];

    const session = composeSlate({
      sessionId: "meta-cap",
      mode: "C",
      profile: p,
      candidates,
      inputHashes: HASHES,
    });
    expect(session.items.filter((item) => item.topics.includes("AI")).length).toBeLessThanOrEqual(2);

    const corrupted = makeSession(
      candidates.slice(0, 3),
      { mode: "C", profileVersion: p.version }
    );
    const evaluation = evaluatePreferenceSession({ session: corrupted, profile: p });
    expect(evaluation.hardFailures).toContain("PREF_META_INVERSION_FAIL");
    expect(evaluation.hardFailures).toContain("PREF_CAP_FAIL");
  });

  it("T4 no-history mode removes P0 provenance rather than banning matching titles", () => {
    const p = profile({ constraints: { noHistory: true } });
    const p0 = candidate(1, "CORE", {
      title: "古建筑与环境史",
      sourceLayers: ["P0"],
    });
    const p3 = candidate(2, "ADJACENT", {
      title: "古建筑环境史方法",
      sourceLayers: ["P3"],
    });

    const session = composeSlate({
      sessionId: "no-history",
      mode: "D",
      profile: p,
      candidates: [p0, p3],
      inputHashes: HASHES,
      budget: { CORE: 0, ADJACENT: 1, DISTANT: 0, SURPRISE: 0 },
      slateSize: 1,
    });

    expect(session.items.map((item) => item.catalogId)).toEqual([p3.catalogId]);
    expect(session.items[0].title).toContain("古建筑");

    const corrupted = makeSession([p0], { mode: "D", noHistory: true });
    const evaluation = evaluatePreferenceSession({ session: corrupted, profile: p });
    expect(evaluation.hardFailures).toContain("PREF_FALSE_RESET_FAIL");
  });

  it("T5 excludes known books from the final slate", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      candidate(i + 1, "CORE", { sourceLayers: ["P1"] })
    );
    const known = candidates.slice(0, 8).map((item) => item.catalogId);

    const session = composeSlate({
      sessionId: "known-exclusion",
      mode: "B",
      profile: profile(),
      candidates,
      knownCatalogIds: known,
      inputHashes: HASHES,
    });

    expect(session.items).toHaveLength(10);
    expect(session.items.some((item) => known.includes(item.catalogId))).toBe(false);
  });

  it("T6 limits repeated authors and series under sovereignty constraints", () => {
    const p = profile({
      constraints: {
        sameAuthorMax: 1,
        sameSeriesMax: 2,
        temporaryMax: 10,
      },
    });

    const sameAuthor = Array.from({ length: 7 }, (_, i) =>
      candidate(i + 1, "CORE", {
        author: "重复作者",
        series: `独立系列-${i}`,
        sourceLayers: ["P1"],
      })
    );
    const sameSeries = Array.from({ length: 5 }, (_, i) =>
      candidate(100 + i, "CORE", {
        author: `系列作者-${i}`,
        series: "重复系列",
        sourceLayers: ["P1"],
      })
    );
    const fillers = Array.from({ length: 15 }, (_, i) =>
      candidate(200 + i, "CORE", {
        author: `填充作者-${i}`,
        series: `填充系列-${i}`,
        sourceLayers: ["P1"],
      })
    );

    const session = composeSlate({
      sessionId: "concentration",
      mode: "C",
      profile: p,
      candidates: [...sameAuthor, ...sameSeries, ...fillers],
      inputHashes: HASHES,
    });

    expect(session.items.filter((item) => item.author === "重复作者")).toHaveLength(1);
    expect(session.items.filter((item) => item.series === "重复系列").length).toBeLessThanOrEqual(2);
    expect(session.items).toHaveLength(10);
  });

  it("T7 treats complete recommendation provenance as a hard requirement", () => {
    const items = Array.from({ length: 10 }, (_, i) => candidate(i + 1));
    items[0] = { ...items[0], retrievalCallId: "" };
    const session = makeSession(items);
    const evaluation = evaluatePreferenceSession({ session, profile: profile() });

    expect(evaluation.metrics.ETR).toBe(0.9);
    expect(evaluation.hardFailures).toContain("PREF_PROVENANCE_FAIL");
    expect(evaluation.verdict).toBe("HARD_FAIL");
  });

  it("T8 detects mode leakage with frozen input hashes", () => {
    const p1 = profile();
    const baseline = computeInputHashes({
      profile: p1,
      seedFixture: { version: "s1", seeds: ["古道"] },
      knownBookSet: ["known-1"],
      protocol: { version: "p1" },
    });

    const p2 = profile({
      entries: [
        {
          id: "new",
          topic: "环境史",
          layer: "P1",
          state: "ACTIVE",
          sourceType: "USER_EXPLICIT",
        },
      ],
    });
    const changed = computeInputHashes({
      profile: p2,
      seedFixture: { version: "s1", seeds: ["古道"] },
      knownBookSet: ["known-1"],
      protocol: { version: "p1" },
    });

    expect(changed.profileHash).not.toBe(baseline.profileHash);

    const session = makeSession([candidate(1)], { inputHashes: changed });
    const evaluation = evaluatePreferenceSession({
      session,
      profile: p2,
      baselineInputHashes: baseline,
    });
    expect(evaluation.hardFailures).toContain("PREF_MODE_LEAK_FAIL");
  });

  it("T9 applies reset scopes without erasing higher-order preferences accidentally", () => {
    const p = profile({
      entries: [
        { id: "p0", topic: "行为", layer: "P0", state: "ACTIVE", sourceType: "SEARCH_BEHAVIOR" },
        { id: "p1", topic: "历史地理", layer: "P1", state: "ACTIVE", sourceType: "USER_EXPLICIT" },
        { id: "p2", topic: "少刷", layer: "P2", state: "ACTIVE", sourceType: "USER_EXPLICIT" },
        { id: "p3", topic: "环境史", layer: "P3", state: "EXPLORE", sourceType: "USER_EXPLICIT" },
        { id: "temp", topic: "当前项目", layer: "P1", state: "TEMPORARY", sourceType: "NOTION_RESEARCH" },
        { id: "derived", topic: "推断", layer: "P1", state: "ACTIVE", sourceType: "SYSTEM_INFERENCE" },
      ],
    });

    expect(resetPreferenceProfile(p, "RESET_P0").entries.map((entry) => entry.id)).not.toContain("p0");
    expect(resetPreferenceProfile(p, "RESET_P0").entries.map((entry) => entry.id)).toContain("p2");

    expect(resetPreferenceProfile(p, "RESET_TEMP").entries.map((entry) => entry.id)).not.toContain("temp");
    expect(resetPreferenceProfile(p, "RESET_EXPLORATION").entries.map((entry) => entry.id)).not.toContain("p3");

    const derivedReset = resetPreferenceProfile(p, "RESET_ALL_DERIVED");
    expect(derivedReset.entries.map((entry) => entry.id)).not.toContain("p0");
    expect(derivedReset.entries.map((entry) => entry.id)).not.toContain("derived");
    expect(derivedReset.entries.map((entry) => entry.id)).toContain("p1");

    const full = resetPreferenceProfile(p, "FULL_PROFILE_RESET");
    expect(full.entries).toEqual([]);
    expect(full.constraints).toEqual({});
  });

  it("T10 returns UNDERFILLED instead of silently relaxing hard constraints", () => {
    const p = profile({
      constraints: {
        topicCaps: { AI: 2 },
        sameAuthorMax: 10,
        sameSeriesMax: 10,
        temporaryMax: 10,
      },
    });
    const candidates = Array.from({ length: 9 }, (_, i) =>
      candidate(i + 1, "CORE", { topics: ["AI"], sourceLayers: ["P1"] })
    );

    const session = composeSlate({
      sessionId: "underfilled",
      mode: "C",
      profile: p,
      candidates,
      inputHashes: HASHES,
    });

    expect(session.state).toBe("UNDERFILLED");
    expect(session.items).toHaveLength(2);
  });

  it("T11 keeps immediate relevance separate from delayed discovery value", () => {
    const x = candidate(1, "CORE");
    const y = candidate(2, "ADJACENT", { preExperimentUncertain: true });

    const xEval = evaluatePreferenceSession({
      session: makeSession([x]),
      profile: profile(),
      t0: [t0(x, { relevanceNow: 5, surprise: 1 })],
      t7: [t7(x, { wouldRecommendToPastSelf: false, delayedValue: 1, actionTaken: [] })],
    });

    const yEval = evaluatePreferenceSession({
      session: makeSession([y]),
      profile: profile(),
      t0: [t0(y, { relevanceNow: 3, surprise: 4 })],
      t7: [
        t7(y, {
          wouldRecommendToPastSelf: true,
          delayedValue: 5,
          actionTaken: ["CREATED_RESEARCH_QUESTION"],
          preferenceResolved: "CONTINUE",
        }),
      ],
    });

    expect(xEval.metrics.IRM).toBe(5);
    expect(yEval.metrics.IRM).toBe(3);
    expect(xEval.metrics.DER).toBe(0);
    expect(yEval.metrics.DER).toBe(1);
    expect(xEval.metrics.RAR).toBe(0);
    expect(yEval.metrics.RAR).toBe(1);
    expect(yEval.metrics.NVD).toBe(1);
  });

  it("T12 does not confuse high surprise with valuable discovery", () => {
    const items = Array.from({ length: 5 }, (_, i) => candidate(i + 1, "SURPRISE", { sourceLayers: ["P1"] }));
    const evaluation = evaluatePreferenceSession({
      session: makeSession(items),
      profile: profile(),
      t0: items.map((item) => t0(item, { surprise: 5 })),
      t7: items.map((item, index) =>
        t7(item, {
          wouldRecommendToPastSelf: index === 0,
          delayedValue: index === 0 ? 5 : 1,
        })
      ),
    });

    expect(evaluation.metrics.meanSurprise).toBe(5);
    expect(evaluation.metrics.NVD).toBe(1);
  });

  it("T13 counts both endorsed and rejected exploration as preference information", () => {
    const items = [
      candidate(1, "ADJACENT", { preExperimentUncertain: true }),
      candidate(2, "DISTANT", { preExperimentUncertain: true }),
      candidate(3, "SURPRISE", { preExperimentUncertain: true, sourceLayers: ["P1"] }),
    ];

    const evaluation = evaluatePreferenceSession({
      session: makeSession(items),
      profile: profile(),
      t7: [
        t7(items[0], { preferenceResolved: "CONTINUE" }),
        t7(items[1], { preferenceResolved: "STOP" }),
        t7(items[2], { preferenceResolved: "UNSURE" }),
      ],
    });

    expect(evaluation.metrics.PDY).toBeCloseTo(2 / 3);
  });

  it("validates feedback scales, duplicate rows, and zero-denominator metrics", () => {
    const item = candidate(1);
    const empty = evaluatePreferenceSession({
      session: makeSession([item]),
      profile: profile(),
    });
    expect(empty.metrics.IRM).toBeNull();
    expect(empty.metrics.DER).toBeNull();
    expect(empty.metrics.RAR).toBeNull();
    expect(empty.metrics.PDY).toBeNull();

    expect(() =>
      evaluatePreferenceSession({
        session: makeSession([item]),
        profile: profile(),
        t0: [t0(item, { relevanceNow: 6 })],
      })
    ).toThrow(/relevanceNow/);

    expect(() =>
      evaluatePreferenceSession({
        session: makeSession([item]),
        profile: profile(),
        t0: [t0(item), t0(item)],
      })
    ).toThrow(/duplicate T0 feedback/);
  });

  it("keeps hard-fail verdict even when ordinary metrics look strong", () => {
    const item = candidate(1, "ADJACENT", { retrievalCallId: "" });
    const evaluation = evaluatePreferenceSession({
      session: makeSession([item]),
      profile: profile(),
      t0: [t0(item, { relevanceNow: 5, surprise: 5 })],
      t7: [
        t7(item, {
          wouldRecommendToPastSelf: true,
          delayedValue: 5,
          actionTaken: ["ADDED_TO_PROJECT"],
        }),
      ],
    });

    expect(evaluation.metrics.IRM).toBe(5);
    expect(evaluation.metrics.DER).toBe(1);
    expect(evaluation.metrics.RAR).toBe(1);
    expect(evaluation.verdict).toBe("HARD_FAIL");
    expect(evaluation.hardFailures).toContain("PREF_PROVENANCE_FAIL");
  });
});
