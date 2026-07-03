#!/usr/bin/env tsx
/**
 * S26I-FIX: Repair invalid confirmed matches in the review queue.
 *
 * Reads: private-data/weread/derived/latest/weread-match-review.json
 * Writes: same path (repaired review queue)
 * Summary: private-data/weread/derived/latest/weread-repair-invalid-confirmed-summary.json
 *
 * Privacy: stdout only prints counts; never prints titles, IDs, or catalogIds.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------- types ----------
type MatchMethod = "isbn" | "title_author" | "title_similarity" | "manual";
type MatchConfidence = "high" | "medium" | "low";
type DecisionSource = "auto_seed" | "manual" | "auto_high_confidence" | "manual_review_required";
type ReviewStatus = "pending" | "accepted" | "rejected" | "needs_manual_search";

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

type ReviewItem = {
  reviewId: string;
  wereadBookId: string;
  wereadTitle: string;
  wereadAuthor: string;
  status: ReviewStatus;
  decisionSource: DecisionSource;
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
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return null;
    return argv[i + 1] as string;
  };
  const has = (key: string) => argv.includes(key);
  return {
    reviewPath: get("--review") ?? "private-data/weread/derived/latest/weread-match-review.json",
    summaryPath: get("--summary") ?? "private-data/weread/derived/latest/weread-repair-invalid-confirmed-summary.json",
    dryRun: has("--dry-run"),
  };
}

// ---------- validation ----------
function isValidCatalogId(value: string): boolean {
  return /^\d{8}_\d{12}$/.test(value);
}

function isValidCandidate(candidate: MatchCandidate): boolean {
  if (!candidate) return false;
  if (!isValidCatalogId(candidate.catalogId)) return false;
  if (!candidate.ssid || !/^\d{8}$/.test(candidate.ssid)) return false;
  if (!candidate.dxid || !/^\d{12}$/.test(candidate.dxid)) return false;
  return true;
}

function hasAnyValidCandidate(candidates: MatchCandidate[]): boolean {
  return candidates.some((c) => isValidCandidate(c));
}

// ---------- main ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let reviewItems: ReviewItem[] = [];
  try {
    reviewItems = JSON.parse(fs.readFileSync(args.reviewPath, "utf8"));
  } catch (err) {
    console.error(`[weread:review:repair-invalid] Failed to read review queue: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const stats = {
    scanned: reviewItems.length,
    repaired: 0,
    setPending: 0,
    setNeedsManualSearch: 0,
    alreadyValidAccepted: 0,
    notAccepted: 0,
    dryRun: args.dryRun,
  };

  const repairedItems: ReviewItem[] = [];

  for (const item of reviewItems) {
    if (item.status !== "accepted") {
      stats.notAccepted += 1;
      repairedItems.push(item);
      continue;
    }

    const selectedCandidate =
      item.selectedCandidateIndex !== null && item.selectedCandidateIndex >= 0
        ? item.candidates[item.selectedCandidateIndex]
        : null;

    const isValidSelection =
      selectedCandidate &&
      isValidCandidate(selectedCandidate) &&
      item.selectedCatalogId === selectedCandidate.catalogId;

    if (isValidSelection) {
      stats.alreadyValidAccepted += 1;
      repairedItems.push(item);
      continue;
    }

    // Invalid confirmed row: revert to pending if any valid candidate exists, else needs_manual_search
    stats.repaired += 1;
    if (hasAnyValidCandidate(item.candidates)) {
      item.status = "pending";
      stats.setPending += 1;
    } else {
      item.status = "needs_manual_search";
      stats.setNeedsManualSearch += 1;
    }
    item.selectedCatalogId = null;
    item.selectedCandidateIndex = null;
    item.decisionSource = "manual_review_required";
    item.reason = "repaired: invalid catalogId or dxid";
    item.notes = (item.notes ? item.notes + "\n" : "") + "[S26I-FIX] Reverted from accepted due to invalid catalogId/dxid.";
    repairedItems.push(item);
  }

  const summary = {
    appliedAt: new Date().toISOString(),
    ...stats,
  };

  fs.mkdirSync(path.dirname(args.summaryPath), { recursive: true });
  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(args.reviewPath), { recursive: true });
    fs.writeFileSync(args.reviewPath, JSON.stringify(repairedItems, null, 2) + "\n");
  }
  fs.writeFileSync(args.summaryPath, JSON.stringify(summary, null, 2) + "\n");

  console.log("[weread:review:repair-invalid] STATUS=PASS");
  console.log(`[weread:review:repair-invalid] scanned=${stats.scanned}`);
  console.log(`[weread:review:repair-invalid] repaired=${stats.repaired}`);
  console.log(`[weread:review:repair-invalid] setPending=${stats.setPending}`);
  console.log(`[weread:review:repair-invalid] setNeedsManualSearch=${stats.setNeedsManualSearch}`);
  console.log(`[weread:review:repair-invalid] alreadyValidAccepted=${stats.alreadyValidAccepted}`);
  console.log(`[weread:review:repair-invalid] notAccepted=${stats.notAccepted}`);
  if (args.dryRun) {
    console.log("[weread:review:repair-invalid] DRY_RUN: no files modified");
  }
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
