/**
 * S27H-2 — Unit tests for the session theme overlay model.
 *
 * 16+ assertions per the S27H-2 spec.
 */

import { describe, it, expect } from "vitest";
import {
  EMPTY_SESSION_THEME_OVERLAY,
  buildSessionCatalogIds,
  buildSessionThemeLabels,
  buildSessionThemeOverlay,
  filterSessionLinks,
  formatSessionOverlaySummary,
  isSessionMapNode,
  sessionThemeOverlayKey,
  validateSessionThemeOverlay,
} from "./wereadSessionThemeModel";
import type {
  WereadAiSummaryResult,
  WereadPrivateNoteItem,
} from "../wereadPrivate";

function makeSummary(
  themes: Array<{ title: string; summary?: string; evidenceCount?: number }>,
  directions: string[] = []
): WereadAiSummaryResult {
  return {
    overview: "forbidden overview body — must never leak into overlay",
    themes: themes.map((t) => ({
      title: t.title,
      summary: t.summary ?? "forbidden theme summary",
      evidenceCount: t.evidenceCount ?? 99,
    })),
    keyPoints: ["forbidden key point 1", "forbidden key point 2"],
    reviewQuestions: ["forbidden review question"],
    readingDirections: directions,
  };
}

function makeItem(opts: {
  matched: boolean;
  catalogId: string | null;
  text?: string;
  comment?: string | null;
}): WereadPrivateNoteItem {
  return {
    type: "highlight",
    text: opts.text ?? "forbidden note text body",
    comment: opts.comment ?? null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: null,
    matched: opts.matched,
    catalogId: opts.catalogId,
    source: "private_weread",
  };
}

describe("wereadSessionThemeModel — buildSessionThemeLabels", () => {
  it("prefers themes[].title over readingDirections", () => {
    const labels = buildSessionThemeLabels(
      makeSummary(
        [
          { title: "主题A" },
          { title: "主题B" },
        ],
        ["方向X", "方向Y"]
      )
    );
    // Themes first, then directions top up to the 6-entry cap.
    expect(labels.map((l) => l.source)).toEqual([
      "theme",
      "theme",
      "direction",
      "direction",
    ]);
    expect(labels.map((l) => l.label)).toEqual([
      "主题A",
      "主题B",
      "方向X",
      "方向Y",
    ]);
  });

  it("tops up with readingDirections when fewer than 6 themes exist", () => {
    const labels = buildSessionThemeLabels(
      makeSummary([{ title: "主题A" }], ["方向X", "方向Y", "方向Z"])
    );
    expect(labels.map((l) => l.source)).toEqual([
      "theme",
      "direction",
      "direction",
      "direction",
    ]);
    expect(labels.map((l) => l.label)).toEqual([
      "主题A",
      "方向X",
      "方向Y",
      "方向Z",
    ]);
  });

  it("caps at 6 entries total", () => {
    const labels = buildSessionThemeLabels(
      makeSummary(
        [
          { title: "A" },
          { title: "B" },
          { title: "C" },
          { title: "D" },
          { title: "E" },
        ],
        ["F", "G", "H", "I"]
      )
    );
    expect(labels.length).toBe(6);
  });

  it("trims whitespace and clamps to 60 chars", () => {
    const long = "长".repeat(80);
    const labels = buildSessionThemeLabels(
      makeSummary([{ title: `  ${long}  ` }])
    );
    expect(labels.length).toBe(1);
    expect(labels[0].label.length).toBe(60);
    expect(labels[0].label.startsWith("  ")).toBe(false);
    expect(labels[0].label.endsWith("  ")).toBe(false);
  });

  it("deduplicates identical labels (post-trim)", () => {
    const labels = buildSessionThemeLabels(
      makeSummary([{ title: "  主题A " }, { title: "主题A" }], ["主题A"])
    );
    expect(labels.map((l) => l.label)).toEqual(["主题A"]);
  });

  it("assigns stable ids theme-N / direction-N", () => {
    const labels = buildSessionThemeLabels(
      makeSummary([{ title: "T1" }], ["D1"])
    );
    expect(labels.map((l) => l.id)).toEqual(["theme-0", "direction-0"]);
  });
});

describe("wereadSessionThemeModel — buildSessionCatalogIds", () => {
  it("extracts matched public catalogIds only", () => {
    const items: WereadPrivateNoteItem[] = [
      makeItem({ matched: true, catalogId: "123_456789012345" }),
      makeItem({ matched: true, catalogId: "987_654321098765" }),
    ];
    const ids = buildSessionCatalogIds(items);
    expect(ids.sort()).toEqual(["123_456789012345", "987_654321098765"]);
  });

  it("drops unmatched notes", () => {
    const items: WereadPrivateNoteItem[] = [
      makeItem({ matched: false, catalogId: "111_222222222222" }),
      makeItem({ matched: true, catalogId: null }),
    ];
    expect(buildSessionCatalogIds(items)).toEqual([]);
  });

  it("deduplicates repeated catalogIds", () => {
    const items: WereadPrivateNoteItem[] = [
      makeItem({ matched: true, catalogId: "111_222222222222" }),
      makeItem({ matched: true, catalogId: "111_222222222222" }),
      makeItem({ matched: true, catalogId: "111_222222222222" }),
    ];
    expect(buildSessionCatalogIds(items)).toEqual(["111_222222222222"]);
  });

  it("drops catalogIds that don't look public", () => {
    const items: WereadPrivateNoteItem[] = [
      makeItem({ matched: true, catalogId: "private-id" }),
      makeItem({ matched: true, catalogId: "" }),
      makeItem({ matched: true, catalogId: "12_3" }),
      makeItem({ matched: true, catalogId: "123_456789012345" }),
    ];
    expect(buildSessionCatalogIds(items)).toEqual(["123_456789012345"]);
  });
});

describe("wereadSessionThemeModel — buildSessionThemeOverlay", () => {
  it("returns enabled=false when there is no summary", () => {
    const overlay = buildSessionThemeOverlay({
      summary: null,
      items: [makeItem({ matched: true, catalogId: "123_456789012345" })],
    });
    expect(overlay.enabled).toBe(false);
    expect(overlay.themes).toEqual([]);
    // catalogIds are still extracted (so the UI knows where to highlight once
    // a summary arrives), but enabled stays false without a summary.
    expect(overlay.catalogIds).toEqual(["123_456789012345"]);
    expect(validateSessionThemeOverlay(overlay)).toBe(true);
  });

  it("can be enabled with themes even when no catalogIds match", () => {
    const overlay = buildSessionThemeOverlay({
      summary: makeSummary([{ title: "主题A" }, { title: "主题B" }]),
      items: [makeItem({ matched: false, catalogId: null })],
    });
    expect(overlay.enabled).toBe(true);
    expect(overlay.themes.length).toBe(2);
    expect(overlay.catalogIds).toEqual([]);
    expect(validateSessionThemeOverlay(overlay)).toBe(true);
  });

  it("never contains note text or comment", () => {
    const items: WereadPrivateNoteItem[] = [
      makeItem({
        matched: true,
        catalogId: "123_456789012345",
        text: "SHOULD-NOT-LEAK-TEXT",
        comment: "SHOULD-NOT-LEAK-COMMENT",
      }),
    ];
    const overlay = buildSessionThemeOverlay({
      summary: makeSummary([{ title: "主题A" }]),
      items,
      notesUsed: 1,
    });
    const json = JSON.stringify(overlay);
    expect(json.includes("SHOULD-NOT-LEAK-TEXT")).toBe(false);
    expect(json.includes("SHOULD-NOT-LEAK-COMMENT")).toBe(false);
  });

  it("never contains overview / keyPoints / reviewQuestions", () => {
    const overlay = buildSessionThemeOverlay({
      summary: makeSummary([{ title: "主题A" }], ["方向X"]),
      items: [makeItem({ matched: true, catalogId: "123_456789012345" })],
      notesUsed: 1,
    });
    const json = JSON.stringify(overlay);
    expect(json.includes("forbidden overview body")).toBe(false);
    expect(json.includes("forbidden key point")).toBe(false);
    expect(json.includes("forbidden review question")).toBe(false);
    expect(json.includes("forbidden theme summary")).toBe(false);
  });

  it("never carries token / q / private IDs / dates / titles", () => {
    const overlay = buildSessionThemeOverlay({
      summary: makeSummary([{ title: "主题A" }]),
      items: [
        makeItem({ matched: true, catalogId: "123_456789012345" }),
      ],
      notesUsed: 1,
    });
    const json = JSON.stringify(overlay);
    expect(json.includes("token")).toBe(false);
    expect(json.includes("wereadBookId")).toBe(false);
    expect(json.includes("noteId")).toBe(false);
    expect(json.includes("highlightId")).toBe(false);
    expect(json.includes("2026-01-01")).toBe(false);
    expect(json.includes("createdAt")).toBe(false);
    expect(json.includes("updatedAt")).toBe(false);
  });

  it("honours a custom notesUsed value", () => {
    const overlay = buildSessionThemeOverlay({
      summary: makeSummary([{ title: "主题A" }]),
      items: [makeItem({ matched: true, catalogId: "123_456789012345" })],
      notesUsed: 42,
    });
    expect(overlay.notesUsed).toBe(42);
  });
});

describe("wereadSessionThemeModel — isSessionMapNode / filterSessionLinks", () => {
  const overlay = buildSessionThemeOverlay({
    summary: makeSummary([{ title: "T1" }]),
    items: [
      makeItem({ matched: true, catalogId: "111_222222222222" }),
      makeItem({ matched: true, catalogId: "333_444444444444" }),
    ],
  });

  it("isSessionMapNode returns true only for catalogIds in the overlay", () => {
    expect(isSessionMapNode("111_222222222222", overlay)).toBe(true);
    expect(isSessionMapNode("999_888888888888", overlay)).toBe(false);
  });

  it("isSessionMapNode returns false when the overlay is disabled", () => {
    expect(isSessionMapNode("111_222222222222", EMPTY_SESSION_THEME_OVERLAY)).toBe(
      false
    );
  });

  it("filterSessionLinks keeps only edges touching a session node in session mode", () => {
    const links = [
      { sourceCatalogId: "111_222222222222", targetCatalogId: "555_666666666666", sharedMonths: 3, weight: 9 },
      { sourceCatalogId: "777_888888888888", targetCatalogId: "999_000000000000", sharedMonths: 2, weight: 4 },
      { sourceCatalogId: "333_444444444444", targetCatalogId: "777_888888888888", sharedMonths: 1, weight: 1 },
    ];
    const session = filterSessionLinks(links, overlay, "session");
    expect(session.map((l) => l.sourceCatalogId + "|" + l.targetCatalogId)).toEqual([
      "111_222222222222|555_666666666666",
      "333_444444444444|777_888888888888",
    ]);
  });

  it("filterSessionLinks returns all edges in full mode", () => {
    const links = [
      { sourceCatalogId: "111_222222222222", targetCatalogId: "555_666666666666", sharedMonths: 3, weight: 9 },
      { sourceCatalogId: "777_888888888888", targetCatalogId: "999_000000000000", sharedMonths: 2, weight: 4 },
    ];
    const full = filterSessionLinks(links, overlay, "full");
    expect(full).toEqual(links);
  });
});

describe("wereadSessionThemeModel — formatSessionOverlaySummary", () => {
  it("returns a single-line summary string", () => {
    const overlay = buildSessionThemeOverlay({
      summary: makeSummary([{ title: "T1" }, { title: "T2" }]),
      items: [makeItem({ matched: true, catalogId: "123_456789012345" })],
      notesUsed: 7,
    });
    const text = formatSessionOverlaySummary(overlay);
    expect(text.split("\n")).toHaveLength(1);
    expect(text).toMatch(/主题 2 个/);
    expect(text).toMatch(/当前会话书目 1 本/);
    expect(text).toMatch(/AI 使用笔记 7 条/);
  });

  it("returns the disabled message when overlay is empty", () => {
    expect(formatSessionOverlaySummary(EMPTY_SESSION_THEME_OVERLAY)).toMatch(
      /尚未启用/
    );
  });
});

describe("wereadSessionThemeModel — stability / output shape", () => {
  it("sessionThemeOverlayKey is stable across calls for the same overlay", () => {
    const overlay = buildSessionThemeOverlay({
      summary: makeSummary([{ title: "T1" }]),
      items: [makeItem({ matched: true, catalogId: "123_456789012345" })],
      notesUsed: 1,
    });
    expect(sessionThemeOverlayKey(overlay)).toBe(sessionThemeOverlayKey(overlay));
  });

  it("sessionThemeOverlayKey changes when content changes", () => {
    const a = buildSessionThemeOverlay({
      summary: makeSummary([{ title: "T1" }]),
      items: [],
      notesUsed: 0,
    });
    const b = buildSessionThemeOverlay({
      summary: makeSummary([{ title: "T1" }, { title: "T2" }]),
      items: [],
      notesUsed: 0,
    });
    expect(sessionThemeOverlayKey(a)).not.toBe(sessionThemeOverlayKey(b));
  });

  it("validateSessionThemeOverlay rejects malformed input", () => {
    expect(
      validateSessionThemeOverlay({
        enabled: true,
        themes: [{ id: "", label: "", source: "theme" }],
        catalogIds: [],
        notesUsed: 0,
      })
    ).toBe(false);
    expect(
      validateSessionThemeOverlay({
        enabled: true,
        themes: [{ id: "theme-0", label: "T", source: "theme" }],
        catalogIds: ["not-a-public-id"],
        notesUsed: 0,
      })
    ).toBe(false);
  });
});