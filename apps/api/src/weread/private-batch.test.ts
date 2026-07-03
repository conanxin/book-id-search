import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  checkPrivateAuth,
} from "./private-auth.js";
import {
  clearWereadOverlayCache,
  getWereadOverlayDataDir,
  getWereadStatusesByCatalogIds,
  loadWereadOverlay,
  setWereadOverlayCacheTtl,
} from "./private-overlay.js";

function runBatchAuth(req: { headers: { authorization?: string; "x-private-token"?: string } }) {
  const auth = checkPrivateAuth(req.headers.authorization, req.headers["x-private-token"]);
  if (!auth.ok) {
    return { status: auth.status, body: { ok: false, error: auth.message } };
  }
  const body = req.body as unknown;
  if (!body || typeof body !== "object" || !Array.isArray((body as Record<string, unknown>).catalogIds)) {
    return { status: 400, body: { ok: false, error: "invalid catalogIds" } };
  }
  const rawCatalogIds = (body as Record<string, unknown>).catalogIds as unknown[];
  if (rawCatalogIds.length === 0 || rawCatalogIds.length > 100) {
    return { status: 400, body: { ok: false, error: "invalid catalogIds" } };
  }
  const catalogIds: string[] = [];
  for (const item of rawCatalogIds) {
    if (typeof item !== "string" || !/^[0-9]+_[0-9]{12}$/.test(item)) {
      return { status: 400, body: { ok: false, error: "invalid catalogIds" } };
    }
    catalogIds.push(item);
  }
  const data = loadWereadOverlay(getWereadOverlayDataDir());
  const results = getWereadStatusesByCatalogIds(data, catalogIds);
  return { status: 200, body: { ok: true, results } };
}

describe("batch status route logic", () => {
  let tmpDir = "";

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weread-batch-"));
    process.env.WEREAD_PRIVATE_DATA_DIR = tmpDir;
    process.env.WEREAD_OVERLAY_ENABLED = "true";
    process.env.WEREAD_PRIVATE_API_TOKEN = "secret-token";
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

  it("unauthorized -> 401", () => {
    const result = runBatchAuth({ headers: { "Content-Type": "application/json" }, body: { catalogIds: ["13000000_000000000001"] } });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ ok: false, error: "Missing token." });
  });

  it("wrong token -> 403", () => {
    const result = runBatchAuth({ headers: { authorization: "Bearer wrong", "Content-Type": "application/json" }, body: { catalogIds: ["13000000_000000000001"] } });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ ok: false, error: "Invalid token." });
  });

  it("empty array -> 400", () => {
    const result = runBatchAuth({ headers: { authorization: "Bearer secret-token", "Content-Type": "application/json" }, body: { catalogIds: [] } });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "invalid catalogIds" });
  });

  it("too many -> 400", () => {
    const ids = Array.from({ length: 101 }, (_, i) => `13000000_${String(i).padStart(12, "0")}`);
    const result = runBatchAuth({ headers: { authorization: "Bearer secret-token", "Content-Type": "application/json" }, body: { catalogIds: ids } });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "invalid catalogIds" });
  });

  it("invalid catalogId -> 400", () => {
    const result = runBatchAuth({ headers: { authorization: "Bearer secret-token", "Content-Type": "application/json" }, body: { catalogIds: ["bad-id"] } });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "invalid catalogIds" });
  });

  it("matched and unmatched response", () => {
    writeFixture("snapshots/latest/weread-books.snapshot.json", [
      { wereadBookId: "wb1", readingStatus: "finished", progress: 100 },
    ]);
    writeFixture("snapshots/latest/weread-notes.snapshot.json", [
      { wereadBookId: "wb1", type: "note" },
      { wereadBookId: "wb1", type: "highlight" },
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
    const result = runBatchAuth({ headers: { authorization: "Bearer secret-token", "Content-Type": "application/json" }, body: { catalogIds: ["13000000_000000000001", "00000000_000000000000"] } });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; results: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.results["13000000_000000000001"]).toMatchObject({
      matched: true,
      catalogId: "13000000_000000000001",
      weread: {
        readingStatus: "finished",
        progress: 100,
        noteCount: 1,
        highlightCount: 1,
        matchMethod: "isbn",
        matchConfidence: "high",
        decisionSource: "auto_seed",
      },
    });
    expect(body.results["00000000_000000000000"]).toMatchObject({
      matched: false,
      catalogId: "00000000_000000000000",
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain("wereadBookId");
    expect(json).not.toContain("title");
    expect(json).not.toContain("author");
    expect(json).not.toContain("secret-token");
  });
});
