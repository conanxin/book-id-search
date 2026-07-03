#!/usr/bin/env tsx
/**
 * S26C: Apply review decisions to generate confirmed matches.
 *
 * Input: private-data/weread/derived/latest/weread-match-review.json
 * Output: private-data/weread/derived/latest/weread-matches.confirmed.json
 * Summary: private-data/weread/derived/latest/weread-match-confirmation-summary.json
 *
 * Only status=accepted items flow into the confirmed output.
 *
 * Privacy: stdout only prints counts; never prints titles or IDs.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------- types ----------
type MatchMethod = "isbn" | "title_author" | "title_similarity" | "manual";
type MatchConfidence = "high" | "medium" | "low";

type MatchCandidate = {
  catalogId: string;
  ssid: string;
  dxid: string;
  isbn: string | null;
  title: string;
  author: string;
  matchMethod: "isbn" | "title_author" | "title_similarity";
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

type ConfirmedMatch = {
  wereadBookId: string;
  catalogId: string;
  ssid: string;
  dxid: string;
  isbn: string | null;
  matchMethod: MatchMethod;
  matchConfidence: MatchConfidence;
  decisionSource: "manual" | "auto_high_confidence";
  confirmedAt: string;
  confirmedBy: string;
};

// ---------- args ----------
interface Args {
  reviewPath: string;
  outPath: string;
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
    outPath: get("--out") ?? "private-data/weread/derived/latest/weread-matches.confirmed.json",
    summaryPath: get("--summary") ?? "private-data/weread/derived/latest/weread-match-confirmation-summary.json",
  };
}

// ---------- validation ----------
export function validateAcceptedItem(item: ReviewItem, index: number): ConfirmedMatch {
  if (!item.selectedCatalogId || item.selectedCatalogId.trim() === "") {
    throw new Error(`[${index}] accepted item missing selectedCatalogId`);
  }

  // Prefer selectedCandidateIndex when valid
  let candidate: MatchCandidate | undefined;
  if (
    item.selectedCandidateIndex !== null &&
    item.selectedCandidateIndex >= 0 &&
    item.selectedCandidateIndex < item.candidates.length
  ) {
    candidate = item.candidates[item.selectedCandidateIndex];
    if (candidate.catalogId !== item.selectedCatalogId) {
      throw new Error(
        `[${index}] selectedCandidateIndex points to catalogId ${candidate.catalogId} but selectedCatalogId is ${item.selectedCatalogId}`,
      );
    }
  } else {
    candidate = item.candidates.find((c) => c.catalogId === item.selectedCatalogId);
    if (!candidate) {
      throw new Error(
        `[${index}] selectedCatalogId ${item.selectedCatalogId} not found in candidates`,
      );
    }
  }

  return {
    wereadBookId: item.wereadBookId,
    catalogId: candidate.catalogId,
    ssid: candidate.ssid,
    dxid: candidate.dxid,
    isbn: candidate.isbn,
    matchMethod: candidate.matchMethod,
    matchConfidence: candidate.matchConfidence,
    decisionSource: item.decisionSource === "auto_seed" ? "auto_high_confidence" : "manual",
    confirmedAt: new Date().toISOString(),
    confirmedBy: "local-user",
  };
}

// ---------- main ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let reviewItems: ReviewItem[] = [];
  try {
    reviewItems = JSON.parse(fs.readFileSync(args.reviewPath, "utf8"));
  } catch (err) {
    console.error(`[weread:review:apply] Failed to read review queue: ${(err as Error).message}`);
    process.exit(1);
  }

  const counts = {
    total: reviewItems.length,
    pending: 0,
    accepted: 0,
    rejected: 0,
    needs_manual_search: 0,
  };

  const confirmed: ConfirmedMatch[] = [];
  const seenWereadBookIds = new Set<string>();

  for (let i = 0; i < reviewItems.length; i++) {
    const item = reviewItems[i];
    counts[item.status] += 1;

    if (item.status !== "accepted") continue;

    if (seenWereadBookIds.has(item.wereadBookId)) {
      console.error(`[weread:review:apply] FAIL: duplicate wereadBookId ${item.wereadBookId}`);
      process.exit(1);
    }

    try {
      const confirmedMatch = validateAcceptedItem(item, i);
      seenWereadBookIds.add(item.wereadBookId);
      confirmed.push(confirmedMatch);
    } catch (err) {
      console.error(`[weread:review:apply] FAIL: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  const confidenceDist = { high: 0, medium: 0, low: 0 };
  for (const c of confirmed) {
    confidenceDist[c.matchConfidence] += 1;
  }

  const summary = {
    appliedAt: new Date().toISOString(),
    totalReviewItems: counts.total,
    status: {
      pending: counts.pending,
      accepted: counts.accepted,
      rejected: counts.rejected,
      needs_manual_search: counts.needs_manual_search,
    },
    confirmedCount: confirmed.length,
    confidenceDistribution: confidenceDist,
  };

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, JSON.stringify(confirmed, null, 2) + "\n");
  fs.writeFileSync(args.summaryPath, JSON.stringify(summary, null, 2) + "\n");

  console.log("[weread:review:apply] STATUS=PASS");
  console.log(`[weread:review:apply] totalReviewItems=${counts.total}`);
  console.log(`[weread:review:apply] accepted=${counts.accepted}`);
  console.log(`[weread:review:apply] rejected=${counts.rejected}`);
  console.log(`[weread:review:apply] pending=${counts.pending}`);
  console.log(`[weread:review:apply] needs_manual_search=${counts.needs_manual_search}`);
  console.log(`[weread:review:apply] confirmed=${confirmed.length}`);
  console.log(`[weread:review:apply] high=${confidenceDist.high}`);
  console.log(`[weread:review:apply] medium=${confidenceDist.medium}`);
  console.log(`[weread:review:apply] low=${confidenceDist.low}`);
}

main();
