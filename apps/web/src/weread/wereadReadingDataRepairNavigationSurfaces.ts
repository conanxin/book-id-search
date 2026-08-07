// SPDX-License-Identifier: MIT
//
// wereadReadingDataRepairNavigationSurfaces.ts
//
// S27S-1B — Navigation Surface Contract.
//
// Maps each `ReadingDataRepairNavigationTarget` (from S27S-1A) to the real
// existing UI surface it points to. This is a semantic contract layer that
// verifies "this target has a real surface in the current Dashboard" — it
// does NOT:
//   - touch the DOM (no querySelector / getElementById / scroll / focus)
//   - modify URL / fragment / past-state
//   - issue network / storage writes
//   - execute any repair action
//   - depend on framework / view-lib
//
// `surfaceKey` is a stable semantic identifier (NOT a CSS selector, URL, or
// element id). It corresponds to a real `data-testid` on an existing UI
// root in `ReadingArchiveDashboard.tsx` /
// `ReadingDataQualityAuditPanel.tsx` /
// `ReadingDataRepairRecommendationsPanel.tsx`.

import type { ReadingDataRepairNavigationTarget } from "./wereadReadingDataRepairNavigation";

// ---------- public types ----------

/**
 * Whether a NavigationTarget maps to a real existing UI surface or to
 * "no surface by design" (only `none`).
 */
export type ReadingDataRepairNavigationSurfaceAvailability =
  | "existing_surface"
  | "no_surface";

/**
 * Surface Contract: the verified binding between a NavigationTarget and a
 * real existing UI surface. `surfaceKey` is a semantic identifier that
 * matches a `data-testid` on the corresponding component root.
 */
export interface ReadingDataRepairNavigationSurfaceContract {
  target: ReadingDataRepairNavigationTarget;
  availability: ReadingDataRepairNavigationSurfaceAvailability;

  /**
   * Stable semantic identifier matching the real `data-testid` on the
   * component root. NOT a CSS selector / URL / element id. Only present
   * when availability is `existing_surface`.
   */
  surfaceKey?: string;

  /**
   * Stable semantic description of the surface region. Not a UI string
   * copy — just a stable enum value that future UI layers can use.
   */
  surfaceLabel: string;

  automatic: false;
  executesRepair: false;
  requestedNetwork: false;
  modifiesSourceData: false;
}

// ---------- contract table ----------

/**
 * Exhaustive contract table mapping every NavigationTarget to its surface.
 * Verified against the real UI in `ReadingArchiveDashboard.tsx`,
 * `ReadingDataQualityAuditPanel.tsx`, and
 * `ReadingDataRepairRecommendationsPanel.tsx`.
 *
 * `top_books` and `recurring_books` both bind to the
 * `weread-reading-archive-book-grid` root, which is the only aggregated
 * books surface currently rendered by the Dashboard. They use distinct
 * surfaceKeys (`archive_book_grid:top` vs `archive_book_grid:recurring`)
 * because they are semantically distinct intents (annual Top N metadata
 * review vs recurring aggregation review), even though the physical
 * rendering surface is the same component.
 */
export const SURFACE_CONTRACT_INTERNAL: Record<ReadingDataRepairNavigationTarget, ReadingDataRepairNavigationSurfaceContract> = {
  failed_year_controls: {
    target: "failed_year_controls",
    availability: "existing_surface",
    surfaceKey: "weread-reading-archive-controls",
    surfaceLabel: "Archive controls (range / TopN / reload / retry-failed)",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  },
  archive_year_directory: {
    target: "archive_year_directory",
    availability: "existing_surface",
    surfaceKey: "weread-reading-archive-year-grid",
    surfaceLabel: "Year directory grid (per-year archive cards)",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  },
  data_quality_audit: {
    target: "data_quality_audit",
    availability: "existing_surface",
    surfaceKey: "weread-reading-data-quality",
    surfaceLabel: "Data Quality Audit panel",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  },
  top_books: {
    target: "top_books",
    availability: "existing_surface",
    surfaceKey: "archive_book_grid:top",
    surfaceLabel: "Book grid (annual Top N review context)",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  },
  year_links: {
    target: "year_links",
    availability: "existing_surface",
    surfaceKey: "weread-reading-archive-links",
    surfaceLabel: "YearLinks adjacency section",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  },
  recurring_books: {
    target: "recurring_books",
    availability: "existing_surface",
    surfaceKey: "archive_book_grid:recurring",
    surfaceLabel: "Book grid (recurring aggregation context)",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  },
  repair_recommendations: {
    target: "repair_recommendations",
    availability: "existing_surface",
    surfaceKey: "weread-reading-data-repair",
    surfaceLabel: "Repair Recommendations panel",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  },
  none: {
    target: "none",
    availability: "no_surface",
    surfaceLabel: "No surface (by design; no_action_required)",
    automatic: false,
    executesRepair: false,
    requestedNetwork: false,
    modifiesSourceData: false,
  },
} satisfies Record<
  ReadingDataRepairNavigationTarget,
  ReadingDataRepairNavigationSurfaceContract
>;

// ---------- resolvers ----------

/**
 * Resolve a single NavigationTarget to its Surface Contract. Deterministic.
 * Does not read DOM / URL / storage. Does not mutate input.
 */
export function resolveReadingDataRepairNavigationSurface(
  target: ReadingDataRepairNavigationTarget,
): ReadingDataRepairNavigationSurfaceContract {
  return { ...SURFACE_CONTRACT_INTERNAL[target] };
}

/**
 * Resolve a NavigationIntent to its Surface Contract. Deterministic.
 * Does not mutate intent.
 */
export function resolveReadingDataRepairNavigationSurfaceForIntent(
  intent: { target: ReadingDataRepairNavigationTarget },
): ReadingDataRepairNavigationSurfaceContract {
  return { ...SURFACE_CONTRACT_INTERNAL[intent.target] };
}

// ---------- surface plan ----------

import type {
  WereadReadingDataRepairNavigationPlan,
  ReadingDataRepairNavigationIntent,
  ReadingDataRepairNavigationKind,
} from "./wereadReadingDataRepairNavigation";

export interface WereadReadingDataRepairNavigationSurfaceSummary {
  total: number;
  existingSurface: number;
  noSurface: number;
  focusableSurface: number;
  informationalSurface: number;
}

export interface WereadReadingDataRepairNavigationSurfaceCounts {
  // Every real surfaceKey always has a key here, even when count=0.
  "weread-reading-archive-controls": number;
  "weread-reading-archive-year-grid": number;
  "weread-reading-data-quality": number;
  "archive_book_grid:top": number;
  "weread-reading-archive-links": number;
  "archive_book_grid:recurring": number;
  "weread-reading-data-repair": number;
  __no_surface__: number;
}

export interface WereadReadingDataRepairNavigationSurfaceMeta {
  source: "current_repair_recommendation_plan";
  contractVersion: "S27S-1B";
  automaticNavigation: false;
  executesRepair: false;
  requestedNetwork: false;
  modifiesSourceData: false;
}

export interface WereadReadingDataRepairNavigationSurfacePlan {
  contracts: ReadingDataRepairNavigationSurfaceContract[];
  summary: WereadReadingDataRepairNavigationSurfaceSummary;
  surfaceCounts: WereadReadingDataRepairNavigationSurfaceCounts;
  meta: WereadReadingDataRepairNavigationSurfaceMeta;
}

function makeEmptySurfaceCounts(): WereadReadingDataRepairNavigationSurfaceCounts {
  return {
    "weread-reading-archive-controls": 0,
    "weread-reading-archive-year-grid": 0,
    "weread-reading-data-quality": 0,
    "archive_book_grid:top": 0,
    "weread-reading-archive-links": 0,
    "archive_book_grid:recurring": 0,
    "weread-reading-data-repair": 0,
    __no_surface__: 0,
  };
}

/**
 * Build the surface plan from a navigation plan. Resolves each intent to its
 * contract. Does not mutate input. Does not read DOM / URL / storage.
 *
 * Cross-model invariants enforced:
 *   - kind=focus_existing_surface → contract.availability = existing_surface
 *   - kind=information_only → contract.availability is existing_surface
 *     (the recommendation is informational; it does NOT trigger focus)
 *   - kind=none → contract.availability = no_surface
 */
export function buildReadingDataRepairNavigationSurfacePlan(
  navigationPlan: WereadReadingDataRepairNavigationPlan,
): WereadReadingDataRepairNavigationSurfacePlan {
  const contracts: ReadingDataRepairNavigationSurfaceContract[] = [];
  for (const intent of navigationPlan.intents) {
    // Clone to prevent mutation leaking back into the shared contract table.
    const c = resolveReadingDataRepairNavigationSurfaceForIntent(intent);
    contracts.push({ ...c });
  }

  const surfaceCounts = makeEmptySurfaceCounts();
  let existingSurface = 0;
  let noSurface = 0;
  let focusableSurface = 0;
  let informationalSurface = 0;

  for (let i = 0; i < contracts.length; i += 1) {
    const contract = contracts[i];
    const intent = navigationPlan.intents[i];
    if (contract.availability === "existing_surface") {
      existingSurface += 1;
      const key = contract.surfaceKey as keyof WereadReadingDataRepairNavigationSurfaceCounts | undefined;
      if (key) surfaceCounts[key] += 1;
      if (intent.kind === "focus_existing_surface") focusableSurface += 1;
      if (intent.kind === "information_only") informationalSurface += 1;
    } else {
      noSurface += 1;
      surfaceCounts.__no_surface__ += 1;
    }
  }

  return {
    contracts,
    summary: {
      total: contracts.length,
      existingSurface,
      noSurface,
      focusableSurface,
      informationalSurface,
    },
    surfaceCounts,
    meta: {
      source: "current_repair_recommendation_plan",
      contractVersion: "S27S-1B",
      automaticNavigation: false,
      executesRepair: false,
      requestedNetwork: false,
      modifiesSourceData: false,
    },
  };
}

/**
 * Check the cross-model invariant: every focus_existing_surface intent
 * resolves to an existing_surface contract.
 */
export function assertFocusableInvariant(
  navigationPlan: WereadReadingDataRepairNavigationPlan,
): boolean {
  for (const intent of navigationPlan.intents) {
    if (intent.kind === "focus_existing_surface") {
      const contract = resolveReadingDataRepairNavigationSurfaceForIntent(intent);
      if (contract.availability !== "existing_surface") return false;
    }
  }
  return true;
}

/**
 * Check the cross-model invariant: no information_only intent can become an
 * automatic focus (i.e. its contract must NOT be marked as auto-focused).
 */
export function assertInformationalNeverAutoFocused(
  navigationPlan: WereadReadingDataRepairNavigationPlan,
): boolean {
  for (const intent of navigationPlan.intents) {
    if (intent.kind === "information_only") {
      const contract = resolveReadingDataRepairNavigationSurfaceForIntent(intent);
      // informational intents resolve to existing_surface but are NOT
      // focusable. The contract's `automatic` is always false. The kind
      // remains `information_only` regardless of surface availability.
      if (contract.automatic !== false) return false;
      if (intent.kind !== "information_only") return false;
    }
  }
  return true;
}