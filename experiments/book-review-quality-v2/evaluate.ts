import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { deriveBookWebSourceClues } from "../../apps/api/src/ai/book-web-source-clues.js";
import { assessBookReviewCandidate } from "../../apps/api/src/ai/book-web-review-candidate.js";
import { isDirectBookReviewCandidate } from "../book-review-quality-v1/baseline-guard.js";
import { summarize, validateCasebook } from "../book-review-quality-v1/evaluate.js";

export function compareCandidates(value: unknown) {
  validateCasebook(value);
  const rows = value.cases.map(row => {
    const book = { ...value.books[row.bookKey], ...row.bookOverride };
    const clues = deriveBookWebSourceClues(book, row.source);
    const baseline = isDirectBookReviewCandidate({ ...row.source, id: "W1", kind: "web",
      pageAge: null, truncated: false, bookClues: clues }, book.title);
    const evidence = assessBookReviewCandidate(row.source, book);
    const verdict = (admitted: boolean) => row.label === "uncertain" ? "UNJUDGED"
      : admitted ? row.label === "yes" ? "TP" : "FP" : row.label === "yes" ? "FN" : "TN";
    return { id: row.id, bookKey: row.bookKey, origin: row.origin, label: row.label,
      editionStatus: row.editionStatus, labelReason: row.labelReason,
      baseline: { admitted: baseline, verdict: verdict(baseline) },
      candidate: { admitted: evidence.eligible, verdict: verdict(evidence.eligible), evidence },
      sourceUrl: row.source.url };
  });
  const metrics = (subset: typeof rows) => Object.fromEntries((["baseline", "candidate"] as const).map(policy =>
    [policy, summarize(subset.map(row => ({ label: row.label, admitted: row[policy].admitted })))]));
  return {
    taskId: "BOOK_REVIEW_EVIDENCE_P3", baselineCommit: value.baselineCommit,
    annotationStatus: "ASSISTANT_PROVISIONAL_HUMAN_REVIEW_PENDING",
    metricTarget: "post-selection work-review candidate coverage on curated inputs; not live search or final recommendation quality",
    inputLimit: "Whole-page labels can be positive while the provided excerpt lacks genre cues.",
    newModelCalls: 0, productionAccess: 0,
    observed: metrics(rows.filter(row => row.origin !== "synthetic")),
    synthetic: metrics(rows.filter(row => row.origin === "synthetic")),
    byOrigin: Object.fromEntries([...new Set(rows.map(row => row.origin))]
      .map(origin => [origin, metrics(rows.filter(row => row.origin === origin))])),
    rows,
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (!process.argv[2] || !process.argv[3]) throw Error("Usage: evaluate.ts INPUT OUTPUT");
    const raw = readFileSync(process.argv[2]);
    const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
    const result = { ...compareCandidates(JSON.parse(raw.toString("utf8"))),
      datasetSha256: hash(raw),
      candidateSourceSha256: hash(readFileSync(new URL("../../apps/api/src/ai/book-web-review-candidate.ts", import.meta.url))),
      baselineSourceSha256: hash(readFileSync(new URL("../book-review-quality-v1/baseline-guard.ts", import.meta.url))),
      clueSourceSha256: hash(readFileSync(new URL("../../apps/api/src/ai/book-web-source-clues.ts", import.meta.url))),
    };
    writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify({ output: resolve(process.argv[3]), observed: result.observed, synthetic: result.synthetic }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "EVALUATION_FAILED");
    process.exitCode = 1;
  }
}
