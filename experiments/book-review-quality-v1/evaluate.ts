import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { deriveBookWebSourceClues } from "../../apps/api/src/ai/book-web-source-clues.js";
import { isDirectBookReviewCandidate } from "./baseline-guard.js";

export type Decision = { label: "yes" | "no" | "uncertain"; admitted: boolean };
export function summarize(rows: Decision[]) {
  let tp = 0, fp = 0, tn = 0, fn = 0, excluded = 0;
  for (const row of rows) {
    if (row.label === "uncertain") { excluded++; continue; }
    if (row.label === "yes") { if (row.admitted) tp++; else fn++; }
    else { if (row.admitted) fp++; else tn++; }
  }
  const rate = (n: number, d: number) => d ? n / d : null;
  return { total: rows.length, judged: rows.length - excluded, excluded, tp, fp, tn, fn,
    precision: rate(tp, tp + fp), recall: rate(tp, tp + fn), falsePositiveRate: rate(fp, fp + tn) };
}
type Book = { title: string; author: string; isbn: string };
type Origin = "page_excerpt" | "historical_search" | "synthetic";
export interface ReviewCase {
  id: string; bookKey: string; bookOverride?: Partial<Book> | null; origin: Origin;
  source: { title: string; excerpt: string; url: string };
  label: Decision["label"]; editionStatus: string; labelReason: string;
  humanReview: string; assessor: string;
}
export interface Casebook { schemaVersion: number; baselineCommit: string; books: Record<string, Book>; cases: ReviewCase[] }
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
export function validateCasebook(value: unknown): asserts value is Casebook {
  if (!record(value) || value.schemaVersion !== 1 || !record(value.books) || !Array.isArray(value.cases)
    || typeof value.baselineCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.baselineCommit)) throw Error("INVALID_CASEBOOK");
  const seen = new Set<string>();
  for (const row of value.cases) {
    if (!record(row) || typeof row.id !== "string" || !row.id || seen.has(row.id)
      || typeof row.bookKey !== "string" || !Object.hasOwn(value.books, row.bookKey)
      || !["page_excerpt", "historical_search", "synthetic"].includes(String(row.origin))
      || !["yes", "no", "uncertain"].includes(String(row.label)) || !record(row.source)
      || typeof row.source.title !== "string" || !row.source.title || row.source.title.length > 300
      || typeof row.source.excerpt !== "string" || !row.source.excerpt || row.source.excerpt.length > 3000
      || typeof row.source.url !== "string" || !/^https?:\/\//.test(row.source.url)
      || typeof row.editionStatus !== "string" || typeof row.labelReason !== "string"
      || !row.labelReason || row.humanReview !== "pending" || row.assessor !== "assistant") throw Error("INVALID_CASE");
    if (row.bookOverride !== undefined && row.bookOverride !== null
      && (!record(row.bookOverride) || Object.keys(row.bookOverride).some(k => !["title", "author", "isbn"].includes(k))
        || Object.values(row.bookOverride).some(v => typeof v !== "string"))) throw Error("INVALID_BOOK_OVERRIDE");
    const book = value.books[row.bookKey];
    if (!record(book) || ["title", "author", "isbn"].some(k => typeof book[k] !== "string") || !book.title) throw Error("INVALID_BOOK");
    new URL(row.source.url);
    seen.add(row.id);
  }
}
export function evaluateCasebook(value: unknown) {
  validateCasebook(value);
  const rows = value.cases.map(row => {
    const book = { ...value.books[row.bookKey], ...row.bookOverride };
    const clues = deriveBookWebSourceClues(book, row.source);
    const admitted = isDirectBookReviewCandidate({ id: "W1", kind: "web", ...row.source,
      pageAge: null, truncated: false, bookClues: clues }, book.title);
    return { id: row.id, bookKey: row.bookKey, origin: row.origin, label: row.label,
      admitted, verdict: row.label === "uncertain" ? "UNJUDGED" : admitted
        ? row.label === "yes" ? "TP" : "FP" : row.label === "yes" ? "FN" : "TN",
      bookClues: clues, editionStatus: row.editionStatus, labelReason: row.labelReason, sourceUrl: row.source.url };
  });
  const observed = rows.filter(r => r.origin !== "synthetic");
  const group = (key: "origin" | "bookKey", subset: typeof rows) => Object.fromEntries(
    [...new Set(subset.map(r => r[key]))].map(k => [k, summarize(subset.filter(r => r[key] === k))]));
  return { taskId: "BOOK_REVIEW_QUALITY_P2", baselineCommit: value.baselineCommit,
    labelStatus: "ASSISTANT_PROVISIONAL_HUMAN_REVIEW_PENDING",
    metricTarget: "work-level review candidate coverage; not exact-edition verification or live retrieval quality",
    runtimePolicyWrites: 0, newModelCalls: 0, observed: summarize(observed),
    synthetic: summarize(rows.filter(r => r.origin === "synthetic")), byOrigin: group("origin", rows),
    byBookObserved: group("bookKey", observed),
    editionStatusObserved: Object.fromEntries([...new Set(observed.map(r => r.editionStatus))]
      .map(k => [k, observed.filter(r => r.editionStatus === k).length])), rows };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const root = new URL("./", import.meta.url);
    const input = process.argv[2] || fileURLToPath(new URL("cases.json", root));
    const output = process.argv[3] || fileURLToPath(new URL("results.json", root));
    const raw = readFileSync(input);
    const result = { ...evaluateCasebook(JSON.parse(raw.toString("utf8"))),
      datasetSha256: createHash("sha256").update(raw).digest("hex"),
      gateSourceSha256: createHash("sha256").update(readFileSync(new URL("baseline-guard.ts", root))).digest("hex"),
      clueSourceSha256: createHash("sha256").update(readFileSync(new URL("../../apps/api/src/ai/book-web-source-clues.ts", root))).digest("hex") };
    writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ observed: result.observed, synthetic: result.synthetic, byOrigin: result.byOrigin, output }));
  } catch (error) { console.error(error instanceof Error ? error.message : "EVALUATION_FAILED"); process.exitCode = 1; }
}
