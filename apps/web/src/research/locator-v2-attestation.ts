import type { LocatorDraftV2, LocatorWitnessV2 } from "./locator-v2-draft";

/** Nonproduction in-memory model. Supplied context is not authenticated here. */
export type LocatorAttestationContext = {
  witness: LocatorWitnessV2;
  actor: { id: string; type: "HUMAN" | "AGENT" };
  authGeneration: number;
  accessRevision: number;
};
export type ReviewState = "AWAITING_BYTES" | "HASHING" | "AWAITING_HUMAN" |
  "HUMAN_MATCH_RECORDED" | "HUMAN_MISMATCH_RECORDED" | "REVOKED" | "UNAVAILABLE";
export type ReviewEvent = {
  sequence: number;
  action: "BYTES_MATCHED" | "HUMAN_MATCH_RECORDED" | "HUMAN_MISMATCH_RECORDED" | "ATTESTATION_REVOKED";
  actorId: string;
  recordedAt: string;
  subject: Readonly<LocatorDraftV2>;
  assetPageNumber: number | null;
  observedLabel: string | null;
  reason: "CORRECTION" | "WITHDRAWN" | null;
};
export type ReviewView = {
  state: ReviewState;
  locator: { kind: LocatorDraftV2["kind"]; label: string } | null;
  bytesMatched: boolean;
  events: readonly ReviewEvent[];
  verified: false;
  href: null;
  excerpt: null;
};
export type ReviewOutcome = { ok: true } | { ok: false; code: string };
export type ReviewOptions = {
  currentContext: () => LocatorAttestationContext | null;
  now: () => string;
};
export type LocatorReviewSession = {
  observeOriginal: (bytes: Uint8Array) => Promise<ReviewOutcome>;
  recordHumanCheck: (input: unknown) => ReviewOutcome;
  revoke: (input: unknown) => ReviewOutcome;
  view: () => ReviewView;
  dispose: () => void;
};

/** Test-first scaffold: deliberately does not implement successful operations. */
export function createLocatorReviewSession(_proposal: unknown, _options: ReviewOptions): LocatorReviewSession {
  return {
    observeOriginal: async () => ({ ok: false, code: "NOT_IMPLEMENTED" }),
    recordHumanCheck: () => ({ ok: false, code: "NOT_IMPLEMENTED" }),
    revoke: () => ({ ok: false, code: "NOT_IMPLEMENTED" }),
    view: () => ({ state: "UNAVAILABLE", locator: null, bytesMatched: false, events: [], verified: false, href: null, excerpt: null }),
    dispose: () => {},
  };
}
