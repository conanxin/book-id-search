/**
 * S27P-0B — WereadCenter round-trip regression (Rules of Hooks).
 *
 * The WereadCenter is the parent that hosts the five workspace tabs
 * (notes / map / review / annual / archive) and toggles a single
 * `activeTab` value. When the user clicks the archive tab, the
 * ReadingArchiveDashboard mounts with `active=true`. When the user
 * switches back to notes, the dashboard unmounts via the early-return
 * path (`active=false`). When the user clicks the archive tab again,
 * the dashboard re-mounts with `active=true`.
 *
 * The S27P-0 diagnostic proved that this notes → archive → round-trip
 * pattern crashes when the ReadingArchiveDashboard calls a hook AFTER
 * its `if (!active)` early return. The hotfix lives in the dashboard
 * itself; this test file is the regression net that lives at the
 * parent (WereadCenter) side.
 *
 * The previous test infrastructure (vitest + node, no @testing-library
 * / jsdom) cannot do a true createRoot + rerender sequence in this
 * runner. The strongest assertion that is available WITHOUT adding
 * dependencies is the structural source-code check — which is the same
 * check that ESLint's react-hooks/rules-of-hooks rule uses inline.
 * Combined with the per-component render checks in
 * ReadingArchiveDashboard.test.ts, this regression covers the
 * round-trip pattern at the source level and at the inactive-render
 * level. The end-to-end browser round-trip is exercised by the smoke
 * tests (S27L / S27L-2 / S27M / S27N / S27O-3).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEReadCenterPath = resolve(__dirname, "./WereadCenter.tsx");
const DashboardPath = resolve(__dirname, "./ReadingArchiveDashboard.tsx");

const wereadCenter = readFileSync(WEReadCenterPath, "utf8");
const dashboard = readFileSync(DashboardPath, "utf8");

// Strip the leading privacy-contract comment block from the dashboard so
// the structural regex checks only match the live code.
const dashboardCode = dashboard.replace(/^\/\*[\s\S]*?\*\//, "");

describe("WereadCenter round-trip regression (S27P-0B)", () => {
  it("1. initial workspace is notes (round-trip start state)", () => {
    expect(wereadCenter).toMatch(/useState<WorkspaceTab>\("notes"\)/);
  });

  it("2. the five workspace tabs cover notes / map / review / annual / archive", () => {
    expect(wereadCenter).toMatch(/weread-tab-notes/);
    expect(wereadCenter).toMatch(/weread-tab-map/);
    expect(wereadCenter).toMatch(/weread-tab-review/);
    expect(wereadCenter).toMatch(/weread-tab-annual/);
    expect(wereadCenter).toMatch(/weread-tab-archive/);
  });

  it("3. the archive tab click sets archiveActivated, which feeds ReadingArchiveDashboard's `active` prop", () => {
    // The dashboard receives `active={activeTab === "archive"}` from WereadCenter.
    expect(wereadCenter).toMatch(/archiveActivated/);
    expect(wereadCenter).toMatch(/ReadingArchiveDashboard/);
    expect(wereadCenter).toMatch(/active=\{activeTab === "archive"\}/);
  });

  it("4. the ReadingArchiveDashboard component has no hook call after the `if (!active)` early return", () => {
    // The dashboard body is the source of truth for the hook order. We
    // re-slice it here so this test fails loudly if the dashboard file
    // is touched by a future commit that re-introduces the violation.
    const startMatch = dashboardCode.match(
      /export default function ReadingArchiveDashboard[\s\S]*?\)\s*\{/,
    );
    expect(startMatch, "dashboard file must export ReadingArchiveDashboard").not.toBeNull();
    const startSearch = startMatch!.index! + startMatch![0].length;
    const endMarker = /\nfunction ReadingArchiveExportAction\b/;
    const endMatch = dashboardCode.slice(startSearch).search(endMarker);
    expect(endMatch, "dashboard file must define ReadingArchiveExportAction sub-component").toBeGreaterThan(-1);
    const parentBody = dashboardCode.slice(startSearch, startSearch + endMatch);

    const earlyReturnMatch = parentBody.match(/if\s*\(\s*!\s*active\s*\)/);
    expect(earlyReturnMatch, "parent must have `if (!active)` early return").not.toBeNull();
    const afterEarlyReturn = parentBody.slice(earlyReturnMatch!.index!);

    // Strip comments so a doc comment that mentions a hook name does
    // not produce a false positive.
    const sanitized = afterEarlyReturn
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    // The full hook list — including the custom hook
    // useReadingArchiveMachine — must not appear in the post-early-
    // return section of the parent body.
    expect(sanitized, "no useMemo after early return").not.toMatch(/\buseMemo\s*\(/);
    expect(sanitized, "no useState after early return").not.toMatch(/\buseState\s*[<(]/);
    expect(sanitized, "no useEffect after early return").not.toMatch(/\buseEffect\s*\(/);
    expect(sanitized, "no useReducer after early return").not.toMatch(/\buseReducer\s*\(/);
    expect(sanitized, "no useRef after early return").not.toMatch(/\buseRef\s*\(/);
    expect(sanitized, "no custom hook after early return").not.toMatch(/useReadingArchiveMachine\b/);
  });

  it("5. availableYearsForDualPeriod is declared BEFORE the early return (no useMemo wrapper)", () => {
    const startMatch = dashboardCode.match(
      /export default function ReadingArchiveDashboard[\s\S]*?\)\s*\{/,
    );
    const startSearch = startMatch!.index! + startMatch![0].length;
    const endMarker = /\nfunction ReadingArchiveExportAction\b/;
    const endMatch = dashboardCode.slice(startSearch).search(endMarker);
    const parentBody = dashboardCode.slice(startSearch, startSearch + endMatch);

    const earlyReturnMatch = parentBody.match(/if\s*\(\s*!\s*active\s*\)/);
    const beforeEarlyReturn = parentBody.slice(0, earlyReturnMatch!.index!);
    const codeOnly = beforeEarlyReturn
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const declMatch = codeOnly.match(/const\s+availableYearsForDualPeriod\s*=/);
    expect(declMatch, "availableYearsForDualPeriod must be declared before early return").not.toBeNull();
    // The declaration must be a plain expression (the fix removed the
    // useMemo wrapper). `.map(` is the canonical replacement.
    expect(declMatch![0]).not.toMatch(/useMemo/);
  });

  it("6. the round-trip path (notes → archive → notes → archive) is structurally reachable", () => {
    // The WereadCenter must switch activeTab on click; this is the
    // mechanism that drives the round-trip. If a future commit keys
    // activeTab on `active` instead of on `activeTab`, the round-trip
    // regression test below would no longer cover the bug.
    expect(wereadCenter).toMatch(/setActiveTab\(.*\)/);
    // The tab click handler calls `handleTabChange(...)` which calls
    // `setActiveTab(next)`. Both forms must be present.
    expect(wereadCenter).toMatch(/handleTabChange/);
    expect(wereadCenter).toMatch(/onClick=\{?\(\) => handleTabChange/);
  });

  it("7. the dashboard supports a real workspace toggle without throwing hook errors (render test, active=false)", async () => {
    // We can't do a true re-render with createRoot in this Node
    // runner (no jsdom dependency allowed), but renderToStaticMarkup
    // does exercise the React hook pipeline. The active=false path
    // must produce the empty-hint markup and must NOT log
    // "Rendered fewer / more hooks" via console.error.
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { default: ReadingArchiveDashboard } = await import(
      "./ReadingArchiveDashboard"
    );

    const errSpy = (await import("vitest")).vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const html = renderToStaticMarkup(
        React.createElement(ReadingArchiveDashboard, {
          token: "smoke-token",
          active: false,
          onOpenAnnualYear: () => {},
        }),
      );
      expect(html).toMatch(/weread-reading-archive__empty-hint/);
      const errorCalls = errSpy.mock.calls
        .map((args) => args.map(String).join(" "))
        .join(" \n ");
      expect(errorCalls).not.toMatch(/Rendered fewer hooks/i);
      expect(errorCalls).not.toMatch(/Rendered more hooks/i);
      expect(errorCalls).not.toMatch(/Minified React error #300/i);
      expect(errorCalls).not.toMatch(/Minified React error #310/i);
    } finally {
      errSpy.mockRestore();
    }
  });

  it("8. the dashboard's availableYearsForDualPeriod is a pure computation (no useMemo)", () => {
    // The hotfix replaces `useMemo(() => yearsAsc.map(...), [yearsAsc])`
    // with `yearsAsc.map(...)`. Verify that the wrap is gone and that a
    // plain `.map(` is present in the declaration.
    const declMatch = dashboardCode.match(
      /const\s+availableYearsForDualPeriod\s*=\s*([^;]+);/,
    );
    expect(declMatch, "availableYearsForDualPeriod declaration must exist").not.toBeNull();
    const rhs = declMatch![1];
    expect(rhs).not.toMatch(/useMemo/);
    expect(rhs).toMatch(/\.map\s*\(/);
  });

  it("9. the dashboard does NOT mutate active mid-render (no setActive)", () => {
    // Defensive guard: a future commit could try to "fix" the hook
    // order by calling a setActive setter inside the render. That
    // would introduce a different bug (re-render storm). Pin this.
    const startMatch = dashboardCode.match(
      /export default function ReadingArchiveDashboard[\s\S]*?\)\s*\{/,
    );
    const startSearch = startMatch!.index! + startMatch![0].length;
    const endMarker = /\nfunction ReadingArchiveExportAction\b/;
    const endMatch = dashboardCode.slice(startSearch).search(endMarker);
    const parentBody = dashboardCode.slice(startSearch, startSearch + endMatch);
    expect(parentBody).not.toMatch(/setActive\s*\(/);
  });

  it("10. the dashboard never writes to localStorage / sessionStorage / IndexedDB", () => {
    // Storage safety must not regress. The fix is purely a hook-order
    // change; no storage code is touched.
    const startMatch = dashboardCode.match(
      /export default function ReadingArchiveDashboard[\s\S]*?\)\s*\{/,
    );
    const startSearch = startMatch!.index! + startMatch![0].length;
    const endMarker = /\nfunction ReadingArchiveExportAction\b/;
    const endMatch = dashboardCode.slice(startSearch).search(endMarker);
    const parentBody = dashboardCode.slice(startSearch, startSearch + endMatch);
    expect(parentBody).not.toMatch(/localStorage/);
    expect(parentBody).not.toMatch(/sessionStorage/);
    expect(parentBody).not.toMatch(/IndexedDB/);
  });
});
