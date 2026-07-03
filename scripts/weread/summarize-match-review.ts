#!/usr/bin/env tsx
/**
 * S26C: Summarize a review queue and optional confirmed output.
 *
 * Input: --review private-data/weread/derived/latest/weread-match-review.json
 * Input: --confirmed private-data/weread/derived/latest/weread-matches.confirmed.json
 *
 * Privacy: stdout only prints counts; never prints titles or IDs.
 */
import fs from "node:fs";
import process from "node:process";

// ---------- types ----------
type ReviewStatus = "pending" | "accepted" | "rejected" | "needs_manual_search";
type Confidence = "high" | "medium" | "low" | "none";

type MatchCandidate = {
  catalogId: string;
  ssid: string;
  dxid: string;
  isbn: string | null;
  title: string;
  author: string;
  matchMethod: "isbn" | "title_author" | "title_similarity";
  matchConfidence: "high" | "medium" | "low";
  reason: string;
};

type ReviewItem = {
  reviewId: string;
  wereadBookId: string;
  wereadTitle: string;
  wereadAuthor: string;
  status: ReviewStatus;
  decisionSource: "auto_seed" | "manual";
  selectedCatalogId: string | null;
  selectedCandidateIndex: number | null;
  confidence: Confidence;
  reason: string;
  candidates: MatchCandidate[];
  notes: string;
};

type ConfirmedMatch = {
  wereadBookId: string;
  catalogId: string;
  ssid: string;
  dxid: string;
  isbn: string | null;
  matchMethod: "isbn" | "title_author" | "title_similarity" | "manual";
  matchConfidence: "high" | "medium" | "low";
  decisionSource: "manual" | "auto_high_confidence";
  confirmedAt: string;
  confirmedBy: string;
};

// ---------- args ----------
interface Args {
  reviewPath: string;
  confirmedPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return null;
    return argv[i + 1] as string;
  };
  return {
    reviewPath: get("--review") ?? "private-data/weread/derived/latest/weread-match-review.json",
    confirmedPath: get("--confirmed") ?? null,
  };
}

// ---------- main ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let reviewItems: ReviewItem[] = [];
  try {
    reviewItems = JSON.parse(fs.readFileSync(args.reviewPath, "utf8"));
  } catch (err) {
    console.error(`[weread:review:summary] Failed to read review queue: ${(err as Error).message}`);
    process.exit(1);
  }

  const statusCounts = { pending: 0, accepted: 0, rejected: 0, needs_manual_search: 0 };
  const confidenceCounts = { high: 0, medium: 0, low: 0, none: 0 };
  const methodCounts = { isbn: 0, title_author: 0, title_similarity: 0, none: 0 };

  for (const item of reviewItems) {
    statusCounts[item.status] += 1;
    confidenceCounts[item.confidence] += 1;

    if (item.status === "accepted" && item.candidates.length > 0 && item.selectedCandidateIndex !== null) {
      const candidate = item.candidates[item.selectedCandidateIndex];
      if (candidate) {
        methodCounts[candidate.matchMethod] += 1;
      } else {
        methodCounts.none += 1;
      }
    } else if (item.status === "needs_manual_search") {
      methodCounts.none += 1;
    }
  }

  let confirmedCount = 0;
  let confirmedConfidence = { high: 0, medium: 0, low: 0 };
  if (args.confirmedPath && fs.existsSync(args.confirmedPath)) {
    try {
      const confirmed: ConfirmedMatch[] = JSON.parse(fs.readFileSync(args.confirmedPath, "utf8"));
      confirmedCount = confirmed.length;
      for (const c of confirmed) {
        confirmedConfidence[c.matchConfidence] += 1;
      }
    } catch (err) {
      console.error(`[weread:review:summary] Failed to read confirmed: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const total = reviewItems.length;
  const remaining = total - (statusCounts.accepted + statusCounts.rejected);
  const progressPercent = total === 0 ? 0 : Math.round(((statusCounts.accepted + statusCounts.rejected) / total) * 100);

  console.log("[weread:review:summary] STATUS=PASS");
  console.log(`[weread:review:summary] total=${total}`);
  console.log(`[weread:review:summary] pending=${statusCounts.pending}`);
  console.log(`[weread:review:summary] accepted=${statusCounts.accepted}`);
  console.log(`[weread:review:summary] rejected=${statusCounts.rejected}`);
  console.log(`[weread:review:summary] needs_manual_search=${statusCounts.needs_manual_search}`);
  console.log(`[weread:review:summary] confirmed=${confirmedCount}`);
  console.log(`[weread:review:summary] high=${confidenceCounts.high}`);
  console.log(`[weread:review:summary] medium=${confidenceCounts.medium}`);
  console.log(`[weread:review:summary] low=${confidenceCounts.low}`);
  console.log(`[weread:review:summary] none=${confidenceCounts.none}`);
  console.log(`[weread:review:summary] isbn=${methodCounts.isbn}`);
  console.log(`[weread:review:summary] title_author=${methodCounts.title_author}`);
  console.log(`[weread:review:summary] title_similarity=${methodCounts.title_similarity}`);
  console.log(`[weread:review:summary] remaining=${remaining}`);
  console.log(`[weread:review:summary] progressPercent=${progressPercent}%`);
}

main();
