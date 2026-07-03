#!/usr/bin/env tsx
/**
 * S26C: Build a manual review queue from generated WeRead match candidates.
 *
 * Input: private-data/weread/derived/latest/weread-matches.generated.json
 * Output: private-data/weread/derived/latest/weread-match-review.json
 * Summary: private-data/weread/derived/latest/weread-match-review-summary.json
 *
 * Privacy: stdout only prints counts; never prints titles or IDs.
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

type GeneratedMatch = {
  wereadBookId: string;
  title: string;
  author: string;
  candidates: MatchCandidate[];
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
  matchesPath: string;
  outPath: string;
  summaryPath: string;
  autoAcceptHighIsbn: boolean;
  maxCandidates: number;
  overwrite: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return null;
    return argv[i + 1] as string;
  };

  const getFlag = (key: string) => argv.includes(key);

  return {
    matchesPath: get("--matches") ?? "private-data/weread/derived/latest/weread-matches.generated.json",
    outPath: get("--out") ?? "private-data/weread/derived/latest/weread-match-review.json",
    summaryPath: get("--summary") ?? "private-data/weread/derived/latest/weread-match-review-summary.json",
    autoAcceptHighIsbn: get("--auto-accept-high-isbn") === "true",
    maxCandidates: parseInt(get("--max-candidates") ?? "5", 10),
    overwrite: getFlag("--overwrite"),
  };
}

// ---------- helpers ----------
function generateReviewId(bookId: string, index: number): string {
  return `wr-review-${index.toString().padStart(5, "0")}`;
}

function determineTopConfidence(candidates: MatchCandidate[]): MatchConfidence | "none" {
  if (candidates.length === 0) return "none";
  return candidates[0].matchConfidence;
}

export function buildReviewItem(
  match: GeneratedMatch,
  index: number,
  maxCandidates: number,
  autoAcceptHighIsbn: boolean,
): ReviewItem {
  const topCandidates = match.candidates.slice(0, maxCandidates);
  const topConfidence = determineTopConfidence(topCandidates);

  const base: ReviewItem = {
    reviewId: generateReviewId(match.wereadBookId, index),
    wereadBookId: match.wereadBookId,
    wereadTitle: match.title,
    wereadAuthor: match.author,
    status: "pending",
    decisionSource: "manual",
    selectedCatalogId: null,
    selectedCandidateIndex: null,
    confidence: topConfidence,
    reason: topCandidates.length > 0 ? "Awaiting manual review" : "No candidates generated",
    candidates: topCandidates,
    notes: "",
  };

  if (autoAcceptHighIsbn) {
    const top = topCandidates[0];
    if (top && top.matchMethod === "isbn" && top.matchConfidence === "high") {
      base.status = "accepted";
      base.decisionSource = "auto_seed";
      base.selectedCatalogId = top.catalogId;
      base.selectedCandidateIndex = 0;
      base.reason = "Auto-accepted: high-confidence ISBN match";
    }
  }

  if (topCandidates.length === 0) {
    base.status = "needs_manual_search";
  }

  return base;
}

// ---------- main ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.overwrite && fs.existsSync(args.outPath)) {
    console.error("[weread:review:build] BLOCKED_ALREADY_EXISTS");
    console.error(`[weread:review:build] ${args.outPath} already exists.`);
    console.error("[weread:review:build] Backup it or pass --overwrite to rebuild.");
    process.exitCode = 1;
    return;
  }

  let generated: GeneratedMatch[] = [];
  try {
    generated = JSON.parse(fs.readFileSync(args.matchesPath, "utf8"));
  } catch (err) {
    console.error(`[weread:review:build] Failed to read matches: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const reviewItems: ReviewItem[] = generated.map((m, i) =>
    buildReviewItem(m, i, args.maxCandidates, args.autoAcceptHighIsbn),
  );

  // Counts for stdout
  const counts = {
    total: reviewItems.length,
    pending: 0,
    accepted: 0,
    rejected: 0,
    needs_manual_search: 0,
    high: 0,
    medium: 0,
    low: 0,
    none: 0,
  };

  for (const item of reviewItems) {
    counts[item.status] += 1;
    counts[item.confidence] += 1;
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    total: counts.total,
    status: {
      pending: counts.pending,
      accepted: counts.accepted,
      rejected: counts.rejected,
      needs_manual_search: counts.needs_manual_search,
    },
    confidence: {
      high: counts.high,
      medium: counts.medium,
      low: counts.low,
      none: counts.none,
    },
    autoAcceptHighIsbn: args.autoAcceptHighIsbn,
    maxCandidates: args.maxCandidates,
  };

  fs.mkdirSync(path.dirname(args.outPath), { recursive: true });
  fs.writeFileSync(args.outPath, JSON.stringify(reviewItems, null, 2) + "\n");
  fs.writeFileSync(args.summaryPath, JSON.stringify(summary, null, 2) + "\n");

  console.log("[weread:review:build] STATUS=PASS");
  console.log(`[weread:review:build] total=${counts.total}`);
  console.log(`[weread:review:build] pending=${counts.pending}`);
  console.log(`[weread:review:build] accepted=${counts.accepted}`);
  console.log(`[weread:review:build] rejected=${counts.rejected}`);
  console.log(`[weread:review:build] needs_manual_search=${counts.needs_manual_search}`);
  console.log(`[weread:review:build] high=${counts.high}`);
  console.log(`[weread:review:build] medium=${counts.medium}`);
  console.log(`[weread:review:build] low=${counts.low}`);
  console.log(`[weread:review:build] none=${counts.none}`);
}

main();
