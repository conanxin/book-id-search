import { afterEach, describe, expect, it } from "vitest";
import { createBookWereadFixture, getBookBrowserCatalogIds } from "./book-browser-fixtures.js";
import { loadPrivateNotesData, normalizeNotesQuery, queryPrivateNotes } from "../apps/api/src/weread/private-notes.js";
import { clearWereadOverlayCache, getWereadStatusByCatalogId, getWereadSummary, loadWereadOverlay } from "../apps/api/src/weread/private-overlay.js";

const fixtures: ReturnType<typeof createBookWereadFixture>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.dispose(); clearWereadOverlayCache(); });

describe("synthetic browser WeRead snapshots use the real matching/query services", () => {
  it("uses valid, distinct, repeatable catalog IDs for each browser run", () => {
    const ids = getBookBrowserCatalogIds("fixture-run-one");
    expect(ids.A).toMatch(/^[0-9]+_[0-9]{12}$/);
    expect(ids.B).toMatch(/^[0-9]+_[0-9]{12}$/);
    expect(ids.A).not.toBe(ids.B);
    expect(ids.A.split("_")[0]).not.toBe(ids.B.split("_")[0]);
    expect(ids.A.split("_")[1]).not.toBe(ids.B.split("_")[1]);
    expect(getBookBrowserCatalogIds("fixture-run-one")).toEqual(ids);
    expect(getBookBrowserCatalogIds("fixture-run-two").A).not.toBe(ids.A);
    expect(() => getBookBrowserCatalogIds("")).toThrow("SYNTHETIC_BROWSER_RUN_ID_REQUIRED");
  });

  it("loads 20 + 7 records only for A, three only for B, and the real per-type counts without private IDs", () => {
    const fixture = createBookWereadFixture("fixture-real-query"); fixtures.push(fixture);
    const data = loadPrivateNotesData(fixture.directory);
    const query = (catalogId: string, offset = 0, type: "all" | "highlight" | "thought" | "review" = "all") =>
      queryPrivateNotes(data, normalizeNotesQuery({ catalogId, offset, limit: 20, type }));
    const first = query(fixture.ids.A);
    const next = query(fixture.ids.A, 20);
    expect(first.pageInfo).toEqual({ limit: 20, offset: 0, total: 27, hasMore: true });
    expect(next.pageInfo).toEqual({ limit: 20, offset: 20, total: 27, hasMore: false });
    expect(first.items).toHaveLength(20);
    expect(next.items).toHaveLength(7);
    expect(new Set([...first.items, ...next.items].map(item => item.text)).size).toBe(27);
    expect([...first.items, ...next.items].every(item => item.catalogId === fixture.ids.A && item.matched)).toBe(true);
    expect(query(fixture.ids.A, 0, "highlight").pageInfo.total).toBe(22);
    expect(query(fixture.ids.A, 0, "thought").pageInfo.total).toBe(3);
    expect(query(fixture.ids.A, 0, "review").pageInfo.total).toBe(2);
    const other = query(fixture.ids.B);
    expect(other.items).toHaveLength(3);
    expect(other.items.every(item => item.catalogId === fixture.ids.B && item.text.startsWith("乙书"))).toBe(true);
    for (const item of [...first.items, ...next.items, ...other.items]) {
      expect(Object.keys(item).sort()).toEqual(["catalogId", "comment", "createdAt", "matched", "source", "text", "type", "updatedAt"]);
    }
    const overlay = loadWereadOverlay(fixture.directory);
    expect(getWereadSummary(overlay)).toMatchObject({ booksCount: 2, notesCount: 30, confirmedMatchesCount: 2 });
    expect(getWereadStatusByCatalogId(overlay, fixture.ids.A)).toMatchObject({ matched: true, weread: { notesSummary: { total: 27, highlights: 22, thoughts: 3, reviews: 2 } } });
    expect(getWereadStatusByCatalogId(overlay, fixture.ids.B)).toMatchObject({ matched: true, weread: { notesSummary: { total: 3, highlights: 1, thoughts: 1, reviews: 1 } } });
  });
});
