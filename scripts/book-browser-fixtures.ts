/** Synthetic, run-scoped catalog IDs and local WeRead snapshots for browser checks. */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export function getBookBrowserCatalogIds(runId: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(runId)) throw new Error("SYNTHETIC_BROWSER_RUN_ID_REQUIRED");
  const digest = createHash("sha256").update(runId).digest("hex");
  const seed = BigInt(`0x${digest.slice(0, 16)}`);
  const ssid = 90_000_000n + (seed % 5_000_000n) * 2n;
  const dxid = seed % 999_999_999_999n;
  return {
    A: `${ssid}_${dxid.toString().padStart(12, "0")}`,
    B: `${ssid + 1n}_${(dxid + 1n).toString().padStart(12, "0")}`,
  };
}

// AI journeys save their own books. Keep their catalog IDs and searchable
// titles outside the existing library journey's runId filter, so file order
// cannot change either journey's initial database state or saved-book counts.
export function getBookAiBrowserFixtureKey(runId: string): string {
  getBookBrowserCatalogIds(runId);
  return `ai-${createHash("sha256").update(runId).digest("hex").slice(0, 32)}`;
}

export function createBookWereadFixture(runId: string, now = Date.now()) {
  const ids = getBookBrowserCatalogIds(runId);
  const directory = mkdtempSync(join(tmpdir(), "book-weread-browser-synthetic-"));
  const books = ["a", "b"].map((key, index) => ({
    wereadBookId: `synthetic-weread-${runId}-${key}`,
    title: `合成微信读书${index === 0 ? "甲" : "乙"}`,
    author: "合成测试作者", isbn: null, readingStatus: "reading", progress: 50,
    updatedAt: new Date(now).toISOString(),
  }));
  const kinds = ["highlight", "thought", "review"] as const;
  const labels = { highlight: "划线", thought: "想法", review: "书评" };
  const notes = books.flatMap((book, bookIndex) => Array.from({ length: bookIndex === 0 ? 27 : 3 }, (_, index) => {
    const type = bookIndex === 0 ? index < 22 ? "highlight" : index < 25 ? "thought" : "review" : kinds[index];
    const number = String(index + 1).padStart(2, "0");
    return {
      wereadBookId: book.wereadBookId,
      noteId: `synthetic-private-note-${bookIndex}-${number}`,
      chapterTitle: "合成私有章节", type,
      text: `${bookIndex === 0 ? "甲" : "乙"}书微信${labels[type]} ${number} · 合成验收`,
      comment: type === "thought" ? `合成补充想法 ${number}` : null,
      createdAt: String(Math.floor(now / 1000) - index * 60), updatedAt: null,
    };
  }));
  const confirmed = books.map((book, index) => {
    const catalogId = index === 0 ? ids.A : ids.B;
    const [ssid, dxid] = catalogId.split("_");
    return { wereadBookId: book.wereadBookId, catalogId, ssid, dxid,
      isbn: null, matchMethod: "manual", matchConfidence: "high", decisionSource: "manual" };
  });
  const write = (relativePath: string, content: unknown) => {
    const path = join(directory, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(content));
  };
  write("snapshots/latest/weread-books.snapshot.json", books);
  write("snapshots/latest/weread-notes.snapshot.json", notes);
  write("derived/latest/weread-matches.confirmed.json", confirmed);
  return { directory, ids, dispose: () => rmSync(directory, { recursive: true, force: true }) };
}
