#!/usr/bin/env tsx
/**
 * S26C-AUTO: Auto-accept top-candidate ISBN high-confidence matches in the review queue.
 *
 * Reads: private-data/weread/derived/latest/weread-match-review.json
 * Writes: same path (review queue with accepted ISBN matches)
 * Summary: private-data/weread/derived/latest/weread-auto-accept-isbn-summary.json
 *
 * Auto-accept criteria:
 * - status is pending
 * - top candidate (index 0) exists
 * - top candidate matchMethod === "isbn"
 * - top candidate matchConfidence === "high"
 *
 * Privacy: stdout only prints counts; never prints titles, IDs, or catalogIds.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------- types ----------
type MatchMethod = "isbn" | "title_author" | "title_similarity";
type MatchConfidence = "high" | "medium" | "low";

type MatchCandidate = {
  catalogId: string;
  ssid: string;
  dxid: string;
  isbn: string | null;
  title: string;
  author: string;
  matchMethod: MatchMethod;
  matchConfidence: MatchConfidence;
  reason: string;
};

type ReviewStatus = "pending" | "accepted" | "rejected" | "needs_manual_search";

type ReviewItem = {
  reviewId: string;
  wereadBookId: string;
  wereadTitle: string;
  wereadAuthor: string;
  status: ReviewStatus;
  decisionSource: "auto_seed" | "manual";
  selectedCatalogId: string | null;
  selectedCandidateIndex: number | null;
  confidence: MatchConfidence | "none";
  reason: string;
  candidates: MatchCandidate[];
  notes: string;
};

// ---------- args ----------
interface Args {
  reviewPath: string;
  summaryPath: string;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return null;
    return argv[i + 1] as string;
  };
  return {
    reviewPath: get("--review") ?? "private-data/weread/derived/latest/weread-match-review.json",
    summaryPath: get("--summary") ?? "private-data/weread/derived/latest/weread-auto-accept-isbn-summary.json",
  };
}

// ---------- main ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let reviewItems: ReviewItem[] = [];
  try {
    reviewItems = JSON.parse(fs.readFileSync(args.reviewPath, "utf8"));
  } catch (err) {
    console.error(`[weread:review:auto-accept] Failed to read review queue: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const stats = {
    scanned: reviewItems.length,
    autoAccepted: 0,
    alreadyAccepted: 0,
    skippedNonIsbn: 0,
    skippedNotHigh: 0,
    skippedNoCandidate: 0,
    skippedOther: 0,
  };

  for (const item of reviewItems) {
    if (item.status === "accepted") {
      stats.alreadyAccepted += 1;
      continue;
    }
    if (item.status === "needs_manual_search") {
      stats.skippedOther += 1;
      continue;
    }
    if (item.status !== "pending") {
      stats.skippedOther += 1;
      continue;
    }

    const topCandidate = item.candidates[0];
    if (!topCandidate) {
      stats.skippedNoCandidate += 1;
      continue;
    }
    if (topCandidate.matchMethod !== "isbn") {
      stats.skippedNonIsbn += 1;
      continue;
    }
    if (topCandidate.matchConfidence !== "high") {
      stats.skippedNotHigh += 1;
      continue;
    }

    item.status = "accepted";
    item.decisionSource = "auto_seed";
    item.selectedCandidateIndex = 0;
    item.selectedCatalogId = topCandidate.catalogId;
    item.reason = "auto-accepted: top candidate is ISBN high-confidence";
    stats.autoAccepted += 1;
  }

  const summary = {
    appliedAt: new Date().toISOString(),
    ...stats,
  };

  fs.mkdirSync(path.dirname(args.reviewPath), { recursive: true });
  fs.writeFileSync(args.reviewPath, JSON.stringify(reviewItems, null, 2) + "\n");
  fs.mkdirSync(path.dirname(args.summaryPath), { recursive: true });
  fs.writeFileSync(args.summaryPath, JSON.stringify(summary, null, 2) + "\n");

  console.log("[weread:review:auto-accept] STATUS=PASS");
  console.log(`[weread:review:auto-accept] scanned=${stats.scanned}`);
  console.log(`[weread:review:auto-accept] autoAccepted=${stats.autoAccepted}`);
  console.log(`[weread:review:auto-accept] alreadyAccepted=${stats.alreadyAccepted}`);
  console.log(`[weread:review:auto-accept] skippedNonIsbn=${stats.skippedNonIsbn}`);
  console.log(`[weread:review:auto-accept] skippedNotHigh=${stats.skippedNotHigh}`);
  console.log(`[weread:review:auto-accept] skippedNoCandidate=${stats.skippedNoCandidate}`);
  console.log(`[weread:review:auto-accept] skippedOther=${stats.skippedOther}`);
}

main();
