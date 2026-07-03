import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearWereadOverlayCache,
  getWereadStatusByCatalogId,
  getWereadStatusesByCatalogIds,
  getWereadSummary,
  loadWereadOverlay,
  setWereadOverlayCacheTtl,
} from "./private-overlay.js";

describe("private-overlay", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-overlay-"));
    setWereadOverlayCacheTtl(0);
    clearWereadOverlayCache();
  });

  afterEach(() => {
    clearWereadOverlayCache();
    setWereadOverlayCacheTtl(60_000);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFixture(name: string, content: unknown) {
    const fullPath = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, JSON.stringify(content, null, 2));
  }

  it("summary count matches fixtures", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", [
      { wereadBookId: "wb1", readingStatus: "finished", progress: 100 },
      { wereadBookId: "wb2", readingStatus: "reading", progress: 30 },
    ]);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", [
      { wereadBookId: "wb1", type: "note" },
      { wereadBookId: "wb1", type: "highlight" },
      { wereadBookId: "wb2", type: "note" },
    ]);
    writeFixture("derived/latest/weread-matches.confirmed.json", [
      {
        wereadBookId: "wb1",
        catalogId: "13000000_000000000001",
        ssid: "13000000",
        dxid: "000000000001",
        matchMethod: "isbn",
        matchConfidence: "high",
        decisionSource: "auto_seed",
      },
    ]);
    const data = loadWereadOverlay(tmpDir);
    const summary = getWereadSummary(data);
    expect(summary.dataAvailable).toBe(true);
    expect(summary.booksCount).toBe(2);
    expect(summary.notesCount).toBe(3);
    expect(summary.confirmedMatchesCount).toBe(1);
  });

  it("status for matched catalogId returns redacted status", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", [
      { wereadBookId: "wb1", readingStatus: "finished", progress: 100, lastReadAt: "2026-01-01T00:00:00Z" },
    ]);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", [
      { wereadBookId: "wb1", type: "note", note: "private note text" },
      { wereadBookId: "wb1", type: "highlight", comment: "private comment" },
    ]);
    writeFixture("derived/latest/weread-matches.confirmed.json", [
      {
        wereadBookId: "wb1",
        catalogId: "13000000_000000000001",
        ssid: "13000000",
        dxid: "000000000001",
        matchMethod: "isbn",
        matchConfidence: "high",
        decisionSource: "auto_seed",
      },
    ]);
    const data = loadWereadOverlay(tmpDir);
    const status = getWereadStatusByCatalogId(data, "13000000_000000000001");
    expect(status.matched).toBe(true);
    expect(status.catalogId).toBe("13000000_000000000001");
    expect(status.weread?.readingStatus).toBe("finished");
    expect(status.weread?.progress).toBe(100);
    expect(status.weread?.noteCount).toBe(1);
    expect(status.weread?.highlightCount).toBe(1);
    // must not leak private fields
    const json = JSON.stringify(status);
    expect(json).not.toContain("wereadBookId");
    expect(json).not.toContain("private note text");
    expect(json).not.toContain("private comment");
    expect(json).not.toContain("title");
    expect(json).not.toContain("author");
  });

  it("batch status deduplicates and redacts", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", [
      { wereadBookId: "wb1", readingStatus: "finished", progress: 100, lastReadAt: "2026-01-01T00:00:00Z" },
    ]);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", [
      { wereadBookId: "wb1", type: "note", note: "private note text" },
      { wereadBookId: "wb1", type: "highlight", comment: "private comment" },
    ]);
    writeFixture("derived/latest/weread-matches.confirmed.json", [
      {
        wereadBookId: "wb1",
        catalogId: "13000000_000000000001",
        ssid: "13000000",
        dxid: "000000000001",
        matchMethod: "isbn",
        matchConfidence: "high",
        decisionSource: "auto_seed",
      },
    ]);
    const data = loadWereadOverlay(tmpDir);
    const results = getWereadStatusesByCatalogIds(data, [
      "13000000_000000000001",
      "13000000_000000000001",
      "00000000_000000000000",
    ]);
    expect(Object.keys(results)).toEqual([
      "13000000_000000000001",
      "00000000_000000000000",
    ]);
    expect(results["13000000_000000000001"].matched).toBe(true);
    expect(results["00000000_000000000000"].matched).toBe(false);
    const json = JSON.stringify(results);
    expect(json).not.toContain("wereadBookId");
    expect(json).not.toContain("private note text");
    expect(json).not.toContain("private comment");
    expect(json).not.toContain("title");
    expect(json).not.toContain("author");
  });

  it("status for unmatched catalogId returns matched=false", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", []);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", []);
    writeFixture("derived/latest/weread-matches.confirmed.json", []);
    const data = loadWereadOverlay(tmpDir);
    const status = getWereadStatusByCatalogId(data, "13000000_000000000000");
    expect(status.matched).toBe(false);
    expect(status.catalogId).toBe("13000000_000000000000");
    expect(status.weread).toBeUndefined();
  });

  it("missing files returns dataAvailable=false", () => {
    const data = loadWereadOverlay(tmpDir);
    expect(data.dataAvailable).toBe(false);
    expect(data.books.size).toBe(0);
  });

  it("cache returns same object within ttl", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", [{ wereadBookId: "wb1" }]);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", []);
    writeFixture("derived/latest/weread-matches.confirmed.json", []);
    setWereadOverlayCacheTtl(60_000);
    const d1 = loadWereadOverlay(tmpDir);
    const d2 = loadWereadOverlay(tmpDir);
    expect(d1).toBe(d2);
  });
});
