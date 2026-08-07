// SPDX-License-Identifier: MIT
//
// wereadReadingDataRepairNavigationUi.ts
//
// S27S-2A — Explicit Guided Navigation Trigger and UI Behavior Contract.
//
// Defines what UI behavior a NavigationIntent should produce, and the pure
// builder for an explicit user-initiated NavigationRequest. This module:
//   - DOES NOT execute any navigation (no DOM / no scroll / no focus)
//   - DOES NOT issue any request on its own (only constructs them)
//   - DOES NOT carry selector / URL / element / ID fields
//   - DOES NOT depend on view-lib / DOM / framework

import type {
  ReadingDataRepairNavigationIntent,
  ReadingDataRepairNavigationKind,
} from "./wereadReadingDataRepairNavigation";
import type { ReadingDataRepairNavigationSurfaceContract } from "./wereadReadingDataRepairNavigationSurfaces";
import { resolveReadingDataRepairNavigationSurfaceForIntent } from "./wereadReadingDataRepairNavigationSurfaces";
import type { ReadingDataRepairAction, ReadingDataRepairCapability } from "./wereadReadingDataRepairRecommendations";
import type { ReadingDataQualityIssueCode } from "./wereadReadingDataQualityAudit";

// ---------- trigger state ----------

/**
 * How the UI should treat an intent:
 *   - `enabled`: real "view related area" button can be rendered.
 *   - `informational`: render neutral informational text only; no nav button.
 *   - `hidden`: render nothing.
 */
export type ReadingDataRepairNavigationTriggerState =
  | "enabled"
  | "informational"
  | "hidden";

export const ALL_READING_DATA_REPAIR_NAVIGATION_TRIGGER_STATES: readonly ReadingDataRepairNavigationTriggerState[] = [
  "enabled",
  "informational",
  "hidden",
] as const;

const KIND_TO_TRIGGER_STATE = {
  focus_existing_surface: "enabled",
  information_only: "informational",
  none: "hidden",
} as const satisfies Record<
  ReadingDataRepairNavigationKind,
  ReadingDataRepairNavigationTriggerState
>;

// ---------- label key ----------

/**
 * Stable label key. Actual user-visible text lives in the component layer.
 * No user-evaluation language allowed here.
 */
export type ReadingDataRepairNavigationUiLabelKey =
  | "view_related_area"
  | "information_only"
  | "no_navigation";

export const ALL_READING_DATA_REPAIR_NAVIGATION_UI_LABEL_KEYS: readonly ReadingDataRepairNavigationUiLabelKey[] = [
  "view_related_area",
  "information_only",
  "no_navigation",
] as const;

const TRIGGER_STATE_TO_LABEL_KEY = {
  enabled: "view_related_area",
  informational: "information_only",
  hidden: "no_navigation",
} as const satisfies Record<
  ReadingDataRepairNavigationTriggerState,
  ReadingDataRepairNavigationUiLabelKey
>;

// ---------- selectors ----------

export function resolveNavigationTriggerState(
  intent: ReadingDataRepairNavigationIntent,
): ReadingDataRepairNavigationTriggerState {
  return KIND_TO_TRIGGER_STATE[intent.kind];
}

export function resolveNavigationUiLabelKey(
  intent: ReadingDataRepairNavigationIntent,
): ReadingDataRepairNavigationUiLabelKey {
  return TRIGGER_STATE_TO_LABEL_KEY[KIND_TO_TRIGGER_STATE[intent.kind]];
}

// ---------- navigation request ----------

/**
 * Explicit user-initiated navigation request. Only produced from
 * `focus_existing_surface` intents, only when the Surface Contract is an
 * existing surface. `surfaceKey` comes from the S27S-1B Surface Contract.
 *
 * This is the ONLY thing the UI may emit from a real click. The builder
 * itself never emits — it only constructs.
 */
export interface ReadingDataRepairNavigationRequest {
  sourceIssueCode: ReadingDataQualityIssueCode;
  action: ReadingDataRepairAction;
  capability: ReadingDataRepairCapability;

  target: ReadingDataRepairNavigationIntent["target"];
  surfaceKey: string;

  year?: number;
  fromYear?: number;
  toYear?: number;
  itemIndex?: number;
  rank?: number;

  initiatedBy: "user_click";

  automatic: false;
  executesRepair: false;
  requestedNetwork: false;
  modifiesSourceData: false;
}

/**
 * Build a navigation request from a NavigationIntent, but only if the
 * intent is `focus_existing_surface` and resolves to an `existing_surface`
 * Contract. Otherwise returns `null`.
 *
 * This function NEVER triggers navigation on its own. It only constructs
 * a request payload that the caller (UI click handler) may emit.
 */
export function buildReadingDataRepairNavigationRequest(
  intent: ReadingDataRepairNavigationIntent,
): ReadingDataRepairNavigationRequest | null {
  if (intent.kind !== "focus_existing_surface") return null;

  const contract: ReadingDataRepairNavigationSurfaceContract =
    resolveReadingDataRepairNavigationSurfaceForIntent(intent);

  if (contract.availability !== "existing_surface") return null;
  if (!contract.surfaceKey) return null;

  return {
    sourceIssueCode: intent.sourceIssueCode,
    action: intent.action,
    capability: intent.capability,
    target: intent.target,
    surfaceKey: contract.surfaceKey,
    year: intent.year,
    fromYear: intent.fromYear,
    toYear: intent.toYear,
    itemIndex: intent.itemIndex,
    rank: intent.rank,
    initiatedBy: "user_click",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  };
}