import { createHash } from "node:crypto";

import type {
  InputHashes,
  PreferenceCandidate,
  PreferenceConstraints,
  PreferenceEntry,
  PreferenceEvaluation,
  PreferenceHardFailure,
  PreferenceLane,
  PreferenceMetrics,
  PreferenceMode,
  PreferenceProfile,
  PreferenceSession,
  SlateBudget,
  SlateItem,
  T0Feedback,
  T7Feedback,
} from "./types.js";

export const DEFAULT_SOVEREIGN_BUDGET: SlateBudget = {
  CORE: 6,
  ADJACENT: 2,
  DISTANT: 1,
  SURPRISE: 1,
};

export type ProfileResetAction =
  | "RESET_P0"
  | "RESET_TEMP"
  | "RESET_EXPLORATION"
  | "RESET_ALL_DERIVED"
  | "FULL_PROFILE_RESET";

export interface ComposeSlateOptions {
  sessionId: string;
  mode: PreferenceMode;
  profile: PreferenceProfile;
  candidates: PreferenceCandidate[];
  knownCatalogIds?: Iterable<string>;
  inputHashes: InputHashes;
  slateSize?: number;
  budget?: SlateBudget;
  noHistory?: boolean;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function computeInputHashes(input: {
  profile: unknown;
  seedFixture: unknown;
  knownBookSet: Iterable<string>;
  protocol: unknown;
}): InputHashes {
  return {
    profileHash: sha256(input.profile),
    seedFixtureHash: sha256(input.seedFixture),
    knownBookSetHash: sha256(Array.from(input.knownBookSet).sort()),
    protocolHash: sha256(input.protocol),
  };
}

export function resetPreferenceProfile(
  profile: PreferenceProfile,
  action: ProfileResetAction
): PreferenceProfile {
  if (action === "FULL_PROFILE_RESET") {
    return {
      ...profile,
      entries: [],
      constraints: {},
    };
  }

  let entries: PreferenceEntry[];
  switch (action) {
    case "RESET_P0":
      entries = profile.entries.filter((entry) => entry.layer !== "P0");
      break;
    case "RESET_TEMP":
      entries = profile.entries.filter((entry) => entry.state !== "TEMPORARY");
      break;
    case "RESET_EXPLORATION":
      entries = profile.entries.filter((entry) => entry.state !== "EXPLORE");
      break;
    case "RESET_ALL_DERIVED":
      entries = profile.entries.filter(
        (entry) => entry.layer !== "P0" && entry.sourceType !== "SYSTEM_INFERENCE"
      );
      break;
  }

  return {
    ...profile,
    entries,
  };
}

function isModeEligible(
  candidate: PreferenceCandidate,
  mode: PreferenceMode,
  noHistory: boolean
): boolean {
  if (noHistory && candidate.sourceLayers.includes("P0")) return false;
  if (mode === "D" && candidate.lane === "SURPRISE") return true;

  const allowed =
    mode === "A"
      ? new Set(["P0"])
      : mode === "B"
        ? new Set(["P1"])
        : new Set(["P1", "P2", "P3"]);

  return candidate.sourceLayers.some((layer) => allowed.has(layer));
}

function sortedCandidates(candidates: PreferenceCandidate[]): PreferenceCandidate[] {
  return [...candidates].sort(
    (a, b) => a.retrievalRank - b.retrievalRank || a.catalogId.localeCompare(b.catalogId)
  );
}

interface ConstraintState {
  temporary: number;
  authors: Map<string, number>;
  series: Map<string, number>;
  topics: Map<string, number>;
}

function createConstraintState(): ConstraintState {
  return {
    temporary: 0,
    authors: new Map(),
    series: new Map(),
    topics: new Map(),
  };
}

function count(map: Map<string, number>, key: string): number {
  return map.get(key) ?? 0;
}

function violatesConstraints(
  candidate: PreferenceCandidate,
  constraints: PreferenceConstraints,
  state: ConstraintState
): boolean {
  if ((constraints.avoidTopics ?? []).some((topic) => candidate.topics.includes(topic))) {
    return true;
  }

  if (
    candidate.temporaryTopic &&
    Number.isFinite(constraints.temporaryMax) &&
    state.temporary >= (constraints.temporaryMax ?? Number.POSITIVE_INFINITY)
  ) {
    return true;
  }

  const author = candidate.author?.trim();
  if (
    author &&
    Number.isFinite(constraints.sameAuthorMax) &&
    count(state.authors, author) >= (constraints.sameAuthorMax ?? Number.POSITIVE_INFINITY)
  ) {
    return true;
  }

  const series = candidate.series?.trim();
  if (
    series &&
    Number.isFinite(constraints.sameSeriesMax) &&
    count(state.series, series) >= (constraints.sameSeriesMax ?? Number.POSITIVE_INFINITY)
  ) {
    return true;
  }

  for (const topic of candidate.topics) {
    const cap = constraints.topicCaps?.[topic];
    if (cap !== undefined && count(state.topics, topic) >= cap) return true;
  }

  return false;
}

function recordConstraintState(candidate: PreferenceCandidate, state: ConstraintState): void {
  if (candidate.temporaryTopic) state.temporary += 1;

  const author = candidate.author?.trim();
  if (author) state.authors.set(author, count(state.authors, author) + 1);

  const series = candidate.series?.trim();
  if (series) state.series.set(series, count(state.series, series) + 1);

  for (const topic of candidate.topics) {
    state.topics.set(topic, count(state.topics, topic) + 1);
  }
}

function selectCandidate(
  candidate: PreferenceCandidate,
  selected: SlateItem[],
  state: ConstraintState
): void {
  selected.push({
    ...candidate,
    finalRank: selected.length + 1,
  });
  recordConstraintState(candidate, state);
}

export function composeSlate(options: ComposeSlateOptions): PreferenceSession {
  const slateSize = options.slateSize ?? 10;
  const budget = options.budget ?? DEFAULT_SOVEREIGN_BUDGET;
  const noHistory = options.noHistory ?? options.profile.constraints.noHistory ?? false;
  const known = new Set(options.knownCatalogIds ?? []);
  const constraintsActive = options.mode === "C" || options.mode === "D";
  const state = createConstraintState();

  const eligible = sortedCandidates(options.candidates).filter((candidate) => {
    if (known.has(candidate.catalogId)) return false;
    return isModeEligible(candidate, options.mode, noHistory);
  });

  const selected: SlateItem[] = [];

  if (options.mode === "D") {
    const lanes: PreferenceLane[] = ["CORE", "ADJACENT", "DISTANT", "SURPRISE"];
    for (const lane of lanes) {
      const laneQuota = Math.min(budget[lane], Math.max(0, slateSize - selected.length));
      let added = 0;
      for (const candidate of eligible) {
        if (added >= laneQuota || selected.length >= slateSize) break;
        if (candidate.lane !== lane) continue;
        if (selected.some((item) => item.catalogId === candidate.catalogId)) continue;
        if (constraintsActive && violatesConstraints(candidate, options.profile.constraints, state)) {
          continue;
        }
        selectCandidate(candidate, selected, state);
        added += 1;
      }
    }
  } else {
    for (const candidate of eligible) {
      if (selected.length >= slateSize) break;
      if (constraintsActive && violatesConstraints(candidate, options.profile.constraints, state)) {
        continue;
      }
      selectCandidate(candidate, selected, state);
    }
  }

  return {
    sessionId: options.sessionId,
    mode: options.mode,
    profileVersion: options.profile.version,
    inputHashes: options.inputHashes,
    noHistory,
    budget,
    items: selected,
    state: selected.length === slateSize ? "COMPLETE" : "UNDERFILLED",
  };
}

function validateScale(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${field} must be an integer from 1 to 5`);
  }
}

function uniqueByCatalogId<T extends { catalogId: string }>(rows: T[], label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const row of rows) {
    if (map.has(row.catalogId)) throw new Error(`duplicate ${label} for ${row.catalogId}`);
    map.set(row.catalogId, row);
  }
  return map;
}

function validateFeedback(t0: T0Feedback[], t7: T7Feedback[]): {
  t0ById: Map<string, T0Feedback>;
  t7ById: Map<string, T7Feedback>;
} {
  for (const row of t0) {
    validateScale(row.relevanceNow, "relevanceNow");
    validateScale(row.curiosity, "curiosity");
    validateScale(row.surprise, "surprise");
    validateScale(row.researchValue, "researchValue");
    validateScale(row.explanationFit, "explanationFit");
  }
  for (const row of t7) validateScale(row.delayedValue, "delayedValue");

  return {
    t0ById: uniqueByCatalogId(t0, "T0 feedback"),
    t7ById: uniqueByCatalogId(t7, "T7 feedback"),
  };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function provenanceComplete(item: SlateItem): boolean {
  return Boolean(
    item.retrievalCallId.trim() &&
      item.matchedSeedIds.length > 0 &&
      item.reasonCode.trim() &&
      item.lane
  );
}

function sameHashes(a: InputHashes, b: InputHashes): boolean {
  return (
    a.profileHash === b.profileHash &&
    a.seedFixtureHash === b.seedFixtureHash &&
    a.knownBookSetHash === b.knownBookSetHash &&
    a.protocolHash === b.protocolHash
  );
}

function constraintFailures(
  session: PreferenceSession,
  profile: PreferenceProfile
): { capFail: boolean; metaFail: boolean } {
  if (session.mode !== "C" && session.mode !== "D") return { capFail: false, metaFail: false };

  const constraints = profile.constraints;
  const authors = new Map<string, number>();
  const series = new Map<string, number>();
  const topics = new Map<string, number>();
  let temporary = 0;
  let capFail = false;
  let metaFail = false;

  for (const item of session.items) {
    if (item.temporaryTopic) temporary += 1;

    const author = item.author?.trim();
    if (author) authors.set(author, count(authors, author) + 1);

    const itemSeries = item.series?.trim();
    if (itemSeries) series.set(itemSeries, count(series, itemSeries) + 1);

    for (const topic of item.topics) {
      topics.set(topic, count(topics, topic) + 1);
      if ((constraints.avoidTopics ?? []).includes(topic)) metaFail = true;
    }
  }

  if (
    constraints.temporaryMax !== undefined &&
    temporary > constraints.temporaryMax
  ) capFail = true;

  if (constraints.sameAuthorMax !== undefined) {
    for (const value of authors.values()) if (value > constraints.sameAuthorMax) capFail = true;
  }

  if (constraints.sameSeriesMax !== undefined) {
    for (const value of series.values()) if (value > constraints.sameSeriesMax) capFail = true;
  }

  for (const [topic, cap] of Object.entries(constraints.topicCaps ?? {})) {
    if (count(topics, topic) > cap) {
      capFail = true;
      metaFail = true;
    }
  }

  return { capFail, metaFail };
}

export function evaluatePreferenceSession(input: {
  session: PreferenceSession;
  profile: PreferenceProfile;
  t0?: T0Feedback[];
  t7?: T7Feedback[];
  baselineInputHashes?: InputHashes;
}): PreferenceEvaluation {
  const t0 = input.t0 ?? [];
  const t7 = input.t7 ?? [];
  const { t0ById, t7ById } = validateFeedback(t0, t7);

  const hardFailures = new Set<PreferenceHardFailure>();

  const provenanceValid = input.session.items.filter(provenanceComplete).length;
  if (provenanceValid !== input.session.items.length) {
    hardFailures.add("PREF_PROVENANCE_FAIL");
  }

  const { capFail, metaFail } = constraintFailures(input.session, input.profile);
  if (capFail) hardFailures.add("PREF_CAP_FAIL");
  if (metaFail) hardFailures.add("PREF_META_INVERSION_FAIL");

  if (
    input.session.noHistory &&
    input.session.items.some((item) => item.sourceLayers.includes("P0"))
  ) {
    hardFailures.add("PREF_FALSE_RESET_FAIL");
  }

  if (
    input.baselineInputHashes &&
    !sameHashes(input.session.inputHashes, input.baselineInputHashes)
  ) {
    hardFailures.add("PREF_MODE_LEAK_FAIL");
  }

  const t0ForSession = input.session.items
    .map((item) => t0ById.get(item.catalogId))
    .filter((row): row is T0Feedback => Boolean(row));

  const t7ForSession = input.session.items
    .map((item) => t7ById.get(item.catalogId))
    .filter((row): row is T7Feedback => Boolean(row));

  const irmRows = t0ForSession.filter((row) => !row.alreadyKnown);
  const IRM = mean(irmRows.map((row) => row.relevanceNow));

  const DER = rate(
    t7ForSession.filter((row) => row.wouldRecommendToPastSelf).length,
    t7ForSession.length
  );

  const RAR = rate(
    t7ForSession.filter((row) => row.actionTaken.length > 0).length,
    t7ForSession.length
  );

  const uncertainWithReview = input.session.items.filter(
    (item) => item.preExperimentUncertain && t7ById.has(item.catalogId)
  );
  const resolvedUncertain = uncertainWithReview.filter((item) => {
    const resolution = t7ById.get(item.catalogId)?.preferenceResolved;
    return resolution === "CONTINUE" || resolution === "STOP";
  });
  const PDY = rate(resolvedUncertain.length, uncertainWithReview.length);

  const laneCounts: Record<PreferenceLane, number> = {
    CORE: 0,
    ADJACENT: 0,
    DISTANT: 0,
    SURPRISE: 0,
  };
  for (const item of input.session.items) laneCounts[item.lane] += 1;

  const EBE =
    input.session.mode === "D"
      ? (Object.keys(input.session.budget) as PreferenceLane[]).reduce(
          (sum, lane) => sum + Math.abs(laneCounts[lane] - input.session.budget[lane]),
          0
        )
      : 0;

  let NVD = 0;
  for (const item of input.session.items) {
    if (item.lane === "CORE") continue;
    const immediate = t0ById.get(item.catalogId);
    if (immediate?.alreadyKnown) continue;
    const delayed = t7ById.get(item.catalogId);
    if (!delayed) continue;
    if (delayed.wouldRecommendToPastSelf || delayed.delayedValue >= 4) NVD += 1;
  }

  const wrongDirectionRate = rate(
    t0ForSession.filter((row) => row.wrongDirection).length,
    t0ForSession.length
  );
  const alreadyKnownRate = rate(
    t0ForSession.filter((row) => row.alreadyKnown).length,
    t0ForSession.length
  );

  const metrics: PreferenceMetrics = {
    IRM,
    DER,
    RAR,
    PDY,
    MPC: capFail || metaFail ? 0 : 1,
    EBE,
    NVD,
    ETR: input.session.items.length === 0 ? 1 : provenanceValid / input.session.items.length,
    wrongDirectionRate,
    alreadyKnownRate,
    meanSurprise: mean(t0ForSession.map((row) => row.surprise)),
    meanDelayedValue: mean(t7ForSession.map((row) => row.delayedValue)),
  };

  return {
    verdict: hardFailures.size > 0 ? "HARD_FAIL" : "PASS",
    hardFailures: Array.from(hardFailures).sort(),
    metrics,
  };
}
