export type PreferenceMode = "A" | "B" | "C" | "D";
export type PreferenceLane = "CORE" | "ADJACENT" | "DISTANT" | "SURPRISE";
export type PreferenceLayer = "P0" | "P1" | "P2" | "P3";
export type PreferenceState =
  | "ACTIVE"
  | "TEMPORARY"
  | "EXPLORE"
  | "AVOID"
  | "EXPIRED"
  | "SUPERSEDED";

export type PreferenceSourceType =
  | "USER_EXPLICIT"
  | "NOTION_RESEARCH"
  | "SEARCH_BEHAVIOR"
  | "READING_HISTORY"
  | "SYSTEM_INFERENCE";

export interface PreferenceEntry {
  id: string;
  topic: string;
  layer: PreferenceLayer;
  state: PreferenceState;
  sourceType: PreferenceSourceType;
}

export interface PreferenceConstraints {
  topicCaps?: Record<string, number>;
  avoidTopics?: string[];
  temporaryMax?: number;
  sameAuthorMax?: number;
  sameSeriesMax?: number;
  noHistory?: boolean;
}

export interface PreferenceProfile {
  version: string;
  entries: PreferenceEntry[];
  constraints: PreferenceConstraints;
}

export interface PreferenceCandidate {
  catalogId: string;
  title: string;
  author?: string | null;
  series?: string | null;
  lane: PreferenceLane;
  topics: string[];
  sourceLayers: PreferenceLayer[];
  matchedSeedIds: string[];
  retrievalCallId: string;
  retrievalRank: number;
  reasonCode: string;
  temporaryTopic?: boolean;
  preExperimentUncertain?: boolean;
}

export interface SlateItem extends PreferenceCandidate {
  finalRank: number;
}

export interface SlateBudget {
  CORE: number;
  ADJACENT: number;
  DISTANT: number;
  SURPRISE: number;
}

export interface InputHashes {
  profileHash: string;
  seedFixtureHash: string;
  knownBookSetHash: string;
  protocolHash: string;
}

export interface PreferenceSession {
  sessionId: string;
  mode: PreferenceMode;
  profileVersion: string;
  inputHashes: InputHashes;
  noHistory: boolean;
  budget: SlateBudget;
  items: SlateItem[];
  state: "COMPLETE" | "UNDERFILLED";
}

export interface T0Feedback {
  catalogId: string;
  relevanceNow: number;
  curiosity: number;
  surprise: number;
  researchValue: number;
  explanationFit: number;
  saveNow: boolean;
  alreadyKnown: boolean;
  tooSimilar: boolean;
  wrongDirection: boolean;
}

export type SubstantiveAction =
  | "SEARCHED"
  | "SAVED"
  | "FOUND_TOC"
  | "ACQUIRED_PAGES"
  | "ACQUIRED_BOOK"
  | "CREATED_RESEARCH_QUESTION"
  | "ADDED_TO_PROJECT"
  | "FIELDWORK_LEAD"
  | "METHOD_LEAD";

export interface T7Feedback {
  catalogId: string;
  wouldRecommendToPastSelf: boolean;
  delayedValue: number;
  actionTaken: SubstantiveAction[];
  preferenceShift: "NONE" | "STRENGTHENED" | "NEW_INTEREST" | "REDUCED_INTEREST";
  preferenceShiftEndorsed: "YES" | "NO" | "UNSURE";
  preferenceResolved?: "CONTINUE" | "STOP" | "UNSURE";
}

export interface PreferenceMetrics {
  IRM: number | null;
  DER: number | null;
  RAR: number | null;
  PDY: number | null;
  MPC: number;
  EBE: number;
  NVD: number;
  ETR: number;
  wrongDirectionRate: number | null;
  alreadyKnownRate: number | null;
  meanSurprise: number | null;
  meanDelayedValue: number | null;
}

export type PreferenceHardFailure =
  | "PREF_META_INVERSION_FAIL"
  | "PREF_CAP_FAIL"
  | "PREF_PROVENANCE_FAIL"
  | "PREF_MODE_LEAK_FAIL"
  | "PREF_FALSE_RESET_FAIL";

export interface PreferenceEvaluation {
  verdict: "PASS" | "HARD_FAIL";
  hardFailures: PreferenceHardFailure[];
  metrics: PreferenceMetrics;
}
