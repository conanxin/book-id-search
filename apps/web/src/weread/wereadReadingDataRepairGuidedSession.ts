// SPDX-License-Identifier: MIT
//
// wereadReadingDataRepairGuidedSession.ts
//
// S27S-3A — Guided Repair Navigation Feedback and Session Model.
//
// Pure model layer that:
//   - derives a SAFE Feedback from a Navigation Request + Runtime
//     Execution Result
//   - maintains an EPHEMERAL in-memory session state (no persistence,
//     no timestamps, no random IDs)
//   - never touches DOM / framework / storage / network / URL / wall-clock timestamps
//
// Feedback describes ONLY what happened to the navigation operation
// (e.g. "navigation completed", "surface not available"). It MUST NOT
// describe user performance, reading quality, or ability.

import type {
  ReadingDataRepairNavigationRequest,
} from "./wereadReadingDataRepairNavigationUi";
import type {
  ReadingDataRepairNavigationExecutionResult,
  ReadingDataRepairNavigationExecutionStatus,
} from "./wereadReadingDataRepairNavigationRuntime";
import type {
  ReadingDataRepairNavigationTarget,
} from "./wereadReadingDataRepairNavigation";

// ---------- feedback status ----------

/**
 * High-level feedback status. Maps 1:1 from Runtime Execution Status.
 * "warning" kinds here describe "this navigation did not happen", NOT
 * user risk or reading quality.
 */
export type ReadingDataRepairNavigationFeedbackStatus =
  | "navigation_complete"
  | "surface_unavailable"
  | "surface_ambiguous"
  | "request_rejected";

export const ALL_FEEDBACK_STATUSES_INTERNAL: readonly ReadingDataRepairNavigationFeedbackStatus[] = [
  "navigation_complete",
  "surface_unavailable",
  "surface_ambiguous",
  "request_rejected",
] as const;

export const RUNTIME_STATUS_TO_FEEDBACK_STATUS = {
  navigated: "navigation_complete",
  surface_not_found: "surface_unavailable",
  ambiguous_surface: "surface_ambiguous",
  rejected_request: "request_rejected",
} as const satisfies Record<
  ReadingDataRepairNavigationExecutionStatus,
  ReadingDataRepairNavigationFeedbackStatus
>;

// ---------- feedback kind ----------

export type ReadingDataRepairNavigationFeedbackKind =
  | "success"
  | "notice"
  | "warning";

export const FEEDBACK_STATUS_TO_KIND = {
  navigation_complete: "success",
  surface_unavailable: "notice",
  surface_ambiguous: "warning",
  request_rejected: "warning",
} as const satisfies Record<
  ReadingDataRepairNavigationFeedbackStatus,
  ReadingDataRepairNavigationFeedbackKind
>;

// ---------- feedback label key ----------

export type ReadingDataRepairNavigationFeedbackLabelKey =
  | "navigation_completed"
  | "surface_not_available"
  | "multiple_surfaces_detected"
  | "navigation_request_rejected";

export const FEEDBACK_STATUS_TO_LABEL_KEY = {
  navigation_complete: "navigation_completed",
  surface_unavailable: "surface_not_available",
  surface_ambiguous: "multiple_surfaces_detected",
  request_rejected: "navigation_request_rejected",
} as const satisfies Record<
  ReadingDataRepairNavigationFeedbackStatus,
  ReadingDataRepairNavigationFeedbackLabelKey
>;

// ---------- feedback shape ----------

export interface ReadingDataRepairNavigationFeedback {
  status: ReadingDataRepairNavigationFeedbackStatus;
  kind: ReadingDataRepairNavigationFeedbackKind;
  labelKey: ReadingDataRepairNavigationFeedbackLabelKey;

  target: ReadingDataRepairNavigationTarget;

  year?: number;
  fromYear?: number;
  toYear?: number;

  initiatedBy: "user_click";

  automatic: false;
  executesRepair: false;
  requestedNetwork: false;
  modifiesSourceData: false;
}

// ---------- feedback builder ----------

/**
 * Build a safe Feedback from a Request + Execution Result.
 *
 * - deterministic
 * - does not mutate request or result
 * - status / kind / label are exhaustive 1:1 mappings
 * - only passes through safe locator fields (target + year/fromYear/toYear)
 * - even for rejected_request, all four false safety flags remain
 */
export function buildReadingDataRepairNavigationFeedback(
  request: ReadingDataRepairNavigationRequest,
  executionResult: ReadingDataRepairNavigationExecutionResult,
): ReadingDataRepairNavigationFeedback {
  const status =
    RUNTIME_STATUS_TO_FEEDBACK_STATUS[executionResult.status];
  const kind = FEEDBACK_STATUS_TO_KIND[status];
  const labelKey = FEEDBACK_STATUS_TO_LABEL_KEY[status];

  return {
    status,
    kind,
    labelKey,
    target: request.target,
    year: request.year,
    fromYear: request.fromYear,
    toYear: request.toYear,
    initiatedBy: "user_click",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  };
}

// ---------- session state ----------

export interface ReadingDataRepairGuidedSessionState {
  attempts: number;
  successful: number;
  unavailable: number;
  ambiguous: number;
  rejected: number;

  lastFeedback: ReadingDataRepairNavigationFeedback | null;

  persisted: false;
  requestedNetwork: false;
  modifiesSourceData: false;
}

export function createInitialReadingDataRepairGuidedSession(): ReadingDataRepairGuidedSessionState {
  return {
    attempts: 0,
    successful: 0,
    unavailable: 0,
    ambiguous: 0,
    rejected: 0,
    lastFeedback: null,
    persisted: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  };
}

// ---------- transition ----------

/**
 * Apply a Feedback to the session. Returns a NEW state object. Never
 * mutates the input. Increments exactly one outcome counter per call.
 *
 * Invariant: attempts === successful + unavailable + ambiguous + rejected
 */
export function applyReadingDataRepairNavigationFeedback(
  state: ReadingDataRepairGuidedSessionState,
  feedback: ReadingDataRepairNavigationFeedback,
): ReadingDataRepairGuidedSessionState {
  const next: ReadingDataRepairGuidedSessionState = {
    attempts: state.attempts + 1,
    successful: state.successful + (feedback.status === "navigation_complete" ? 1 : 0),
    unavailable: state.unavailable + (feedback.status === "surface_unavailable" ? 1 : 0),
    ambiguous: state.ambiguous + (feedback.status === "surface_ambiguous" ? 1 : 0),
    rejected: state.rejected + (feedback.status === "request_rejected" ? 1 : 0),
    lastFeedback: { ...feedback },
    persisted: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  };
  return next;
}

// ---------- summary ----------

export interface ReadingDataRepairGuidedSessionSummary {
  attempts: number;
  successful: number;
  unsuccessful: number;
  unavailable: number;
  ambiguous: number;
  rejected: number;
}

export function buildReadingDataRepairGuidedSessionSummary(
  state: ReadingDataRepairGuidedSessionState,
): ReadingDataRepairGuidedSessionSummary {
  const unsuccessful = state.unavailable + state.ambiguous + state.rejected;
  return {
    attempts: state.attempts,
    successful: state.successful,
    unsuccessful,
    unavailable: state.unavailable,
    ambiguous: state.ambiguous,
    rejected: state.rejected,
  };
}

// ---------- reset ----------

export function resetReadingDataRepairGuidedSession(): ReadingDataRepairGuidedSessionState {
  return createInitialReadingDataRepairGuidedSession();
}

// ---------- safe debug snapshot ----------

const SAFE_DEBUG_KEYS: ReadonlySet<string> = new Set([
  "attempts",
  "successful",
  "unavailable",
  "ambiguous",
  "rejected",
  "lastFeedbackStatus",
  "lastFeedbackKind",
  "lastFeedbackTarget",
  "meta",
]);

export interface ReadingDataRepairGuidedSessionMeta {
  source: "guided_repair_navigation_session";
  persisted: false;
  requestedNetwork: false;
  modifiesSourceData: false;
  automaticNavigation: false;
}

export function buildReadingDataRepairGuidedSessionDebugSnapshot(
  state: ReadingDataRepairGuidedSessionState,
): Record<string, unknown> {
  const last = state.lastFeedback;
  const snapshot: Record<string, unknown> = {
    attempts: state.attempts,
    successful: state.successful,
    unavailable: state.unavailable,
    ambiguous: state.ambiguous,
    rejected: state.rejected,
    lastFeedbackStatus: last?.status ?? null,
    lastFeedbackKind: last?.kind ?? null,
    lastFeedbackTarget: last?.target ?? null,
    meta: {
      source: "guided_repair_navigation_session",
      persisted: false,
      requestedNetwork: false,
      modifiesSourceData: false,
      automaticNavigation: false,
    } as ReadingDataRepairGuidedSessionMeta,
  };
  for (const key of Object.keys(snapshot)) {
    if (!SAFE_DEBUG_KEYS.has(key)) delete snapshot[key];
  }
  return snapshot;
}