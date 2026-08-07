// SPDX-License-Identifier: MIT
//
// wereadReadingDataRepairNavigationRuntime.ts
//
// S27S-2B — Runtime Surface Resolver and User-triggered Scroll/Focus.
//
// THIS IS THE ONLY MODULE ALLOWED TO USE BROWSER DOM APIs IN S27S.
//
// Hardcoded whitelist of locators — surfaceKey is NEVER used as a
// selector. Each existing surfaceKey maps to exactly one locator
// strategy: either an exact `data-testid` match or an exact
// `data-weread-repair-surface` match. No string concatenation from
// user-controlled fields is allowed.
//
// Execution contract:
//   - request must pass defense-in-depth validation
//   - resolver must find EXACTLY ONE element
//   - exactly one scrollIntoView + one focus per accepted request
//   - no retry, no timeout, no RAF, no observer

import type { ReadingDataRepairNavigationRequest } from "./wereadReadingDataRepairNavigationUi";

// ---------- runtime locator ----------

/**
 * Hardcoded locator descriptor. `value` is a literal string in source code,
 * never derived from a request or user input. Only two locator kinds are
 * supported: exact `data-testid` match or exact `data-weread-repair-surface`
 * match.
 */
export type ReadingDataRepairNavigationRuntimeLocator =
  | { kind: "data_testid"; value: string }
  | { kind: "repair_surface"; value: string };

/**
 * Whitelist of the 7 verified existing surfaceKeys. Each maps to its
 * hardcoded locator. This is the ONLY way `surfaceKey` is translated
 * into a DOM lookup.
 */
export const RUNTIME_LOCATOR_WHITELIST_INTERNAL: Readonly<Record<string, ReadingDataRepairNavigationRuntimeLocator>> = {
  "weread-reading-archive-controls": {
    kind: "data_testid",
    value: "weread-reading-archive-controls",
  },
  "weread-reading-archive-year-grid": {
    kind: "data_testid",
    value: "weread-reading-archive-year-grid",
  },
  "weread-reading-data-quality": {
    kind: "data_testid",
    value: "weread-reading-data-quality",
  },
  "archive_book_grid:top": {
    kind: "repair_surface",
    value: "archive_book_grid:recurring",
  },
  "weread-reading-archive-links": {
    kind: "data_testid",
    value: "weread-reading-archive-links",
  },
  "archive_book_grid:recurring": {
    kind: "repair_surface",
    value: "archive_book_grid:recurring",
  },
  "weread-reading-data-repair": {
    kind: "data_testid",
    value: "weread-reading-data-repair",
  },
};

// ---------- execution result ----------

/**
 * Safe execution result. Never includes the resolved element or any
 * HTML / innerHTML / selector. Only safe enum values.
 */
export type ReadingDataRepairNavigationExecutionStatus =
  | "navigated"
  | "surface_not_found"
  | "ambiguous_surface"
  | "rejected_request";

export interface ReadingDataRepairNavigationExecutionResult {
  status: ReadingDataRepairNavigationExecutionStatus;
  surfaceKey: string;
  // Counts for verification — never the element itself.
  scrollCount: 0 | 1;
  focusCount: 0 | 1;
}

// ---------- resolution ----------

export interface ReadingDataRepairNavigationRootLike {
  querySelectorAll: (selector: string) => ArrayLike<Element>;
}

/**
 * Resolve a navigation request to exactly one DOM element, or fail safely.
 *
 * - Validates the request's `surfaceKey` against the hardcoded whitelist.
 * - Uses the corresponding fixed locator (never any selector from request).
 * - Requires EXACTLY ONE matching element. Zero or multiple matches both
 *   fail safely (no element is ever returned to the caller).
 */
export function resolveReadingDataRepairNavigationElement(
  request: ReadingDataRepairNavigationRequest,
  root: ReadingDataRepairNavigationRootLike,
): { ok: true; element: Element } | { ok: false; status: "surface_not_found" | "ambiguous_surface" } {
  const locator = RUNTIME_LOCATOR_WHITELIST_INTERNAL[request.surfaceKey];
  if (!locator) {
    return { ok: false, status: "surface_not_found" };
  }

  const selector =
    locator.kind === "data_testid"
      ? `[data-testid="${locator.value}"]`
      : `[data-weread-repair-surface="${locator.value}"]`;

  const results = Array.from(root.querySelectorAll(selector));
  if (results.length === 0) {
    return { ok: false, status: "surface_not_found" };
  }
  if (results.length > 1) {
    return { ok: false, status: "ambiguous_surface" };
  }
  return { ok: true, element: results[0] };
}

// ---------- execution ----------

/**
 * Defense-in-depth validation: even if a caller hand-constructs a Request
 * with incorrect flags, the runtime refuses to execute.
 */
function isRequestExecutionSafe(
  request: ReadingDataRepairNavigationRequest,
): boolean {
  return (
    request.initiatedBy === "user_click" &&
    request.automatic === false &&
    request.executesRepair === false &&
    request.requestedNetwork === false &&
    request.modifiesSourceData === false
  );
}

/**
 * Scroll options used on accepted navigation. Hardcoded — not configurable.
 */
const SCROLL_OPTIONS: ScrollIntoViewOptions = {
  behavior: "smooth",
  block: "start",
  inline: "nearest",
};

/**
 * Focus options used on accepted navigation. `preventScroll: true` prevents
 * a second scroll triggered by the focus call itself.
 */
const FOCUS_OPTIONS: FocusOptions = {
  preventScroll: true,
};

/**
 * Execute a navigation request: validate, resolve exactly one element,
 * then perform exactly one scrollIntoView + one programmatic focus.
 *
 * Never retries. Never waits. Never observes. Never mutates the request.
 */
export function executeReadingDataRepairNavigationRequest(
  request: ReadingDataRepairNavigationRequest,
  root: ReadingDataRepairNavigationRootLike = typeof document !== "undefined"
    ? (document as unknown as ReadingDataRepairNavigationRootLike)
    : ({
        querySelectorAll: () => [],
      } as ReadingDataRepairNavigationRootLike),
): ReadingDataRepairNavigationExecutionResult {
  if (!isRequestExecutionSafe(request)) {
    return { status: "rejected_request", surfaceKey: request.surfaceKey, scrollCount: 0, focusCount: 0 };
  }

  const resolution = resolveReadingDataRepairNavigationElement(request, root);
  if (!resolution.ok) {
    return { status: resolution.status, surfaceKey: request.surfaceKey, scrollCount: 0, focusCount: 0 };
  }

  const element = resolution.element;
  // scrollIntoView and focus accept Element-like; the underlying
  // HTMLElement is required but Element duck-types for our purposes.
  type ScrollableElement = Element & {
    scrollIntoView: (options?: ScrollIntoViewOptions) => void;
    focus: (options?: FocusOptions) => void;
  };
  const scrollable = element as ScrollableElement;
  scrollable.scrollIntoView(SCROLL_OPTIONS);
  scrollable.focus(FOCUS_OPTIONS);

  return { status: "navigated", surfaceKey: request.surfaceKey, scrollCount: 1, focusCount: 1 };
}

/**
 * Public read-only access to the whitelist keys (for verification /
 * cross-checks). Values are never returned.
 */
export function getReadingDataRepairNavigationRuntimeKeys(): readonly string[] {
  return Object.keys(RUNTIME_LOCATOR_WHITELIST_INTERNAL);
}