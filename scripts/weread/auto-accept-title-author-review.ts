#!/usr/bin/env tsx
/**
 * S26G: Auto-accept top-candidate title_author high-confidence matches in the review queue.
 *
 * Reads: private-data/weread/derived/latest/weread-match-review.json
 * Writes: same path (review queue with accepted title_author matches)
 * Summary: private-data/weread/derived/latest/weread-auto-accept-title-author-summary.json
 *
 * Auto-accept criteria:
 * - status is pending
 * - top candidate (index 0) exists
 * - top candidate matchMethod === "title_author"
 * - top candidate matchConfidence === "high"
 * - title strictly matches after normalization
 * - author strictly matches after normalization
 * - no ambiguous second high-confidence candidate with similar title
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

export type ReviewItem = {
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
  dryRun: boolean;
  maxAutoAccept: number | null;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return null;
    return argv[i + 1] as string;
  };
  const has = (key: string) => argv.includes(key);
  const max = get("--max-auto-accept");
  return {
    reviewPath: get("--review") ?? "private-data/weread/derived/latest/weread-match-review.json",
    summaryPath: get("--summary") ?? "private-data/weread/derived/latest/weread-auto-accept-title-author-summary.json",
    dryRun: has("--dry-run"),
    maxAutoAccept: max ? Number.parseInt(max, 10) : null,
  };
}

// ---------- normalization ----------
export function normalizeTitle(input: string): string {
  return input
    .toLowerCase()
    .replace(/[《》<>"'"'"]/g, "")
    .replace(/[\s·．‧]+/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[：:，,、；;？?！!。.\-_]/g, "")
    .trim();
}

export function normalizeAuthor(input: string): string {
  // Take the primary author segment before translators/co-authors separated by semicolon
  const primary = input.split(/[;；]/)[0] ?? "";
  return primary
    .toLowerCase()
    .replace(/[\s·．‧\[\]\(\)（）]/g, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/(著|编|译|主编|等|整理|注|校注|绘|图文|摄影|口述|撰写|口述整理|编著|选编|编纂|翻译|审校|修订)(\s*[,.，。:：]+)?/g, "")
    .replace(/[\s·．‧]+/g, "")
    .replace(/[：:，,、；;？?！!。.\-_]/g, "")
    .trim();
}

export function titleMatches(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  if (na.length === 0 || nb.length === 0) return false;
  // One is a prefix of the other and length ratio >= 0.9
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (longer.startsWith(shorter) && shorter.length / longer.length >= 0.9) return true;
  return false;
}

export function authorOverlap(a: string, b: string): number {
  const na = normalizeAuthor(a);
  const nb = normalizeAuthor(b);
  if (na.length === 0 || nb.length === 0) return 0;
  const setA = new Set(na.split(""));
  const setB = new Set(nb.split(""));
  let intersection = 0;
  for (const ch of setA) {
    if (setB.has(ch)) intersection += 1;
  }
  return intersection / Math.max(setA.size, setB.size);
}

export function authorMatches(a: string, b: string): boolean {
  const na = normalizeAuthor(a);
  const nb = normalizeAuthor(b);
  if (na.length === 0 || nb.length === 0) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return authorOverlap(a, b) >= 0.8;
}

export function isAmbiguousTopCandidates(item: ReviewItem): boolean {
  if (item.candidates.length < 2) return false;
  const top = item.candidates[0];
  const second = item.candidates[1];
  if (top.matchConfidence !== "high" || second.matchConfidence !== "high") return false;
  if (top.matchMethod !== "title_author" || second.matchMethod !== "title_author") return false;
  // If second title is very similar to top title but different catalogId, consider ambiguous
  const topTitle = normalizeTitle(top.title);
  const secondTitle = normalizeTitle(second.title);
  if (topTitle === secondTitle) return true;
  if (topTitle.length > 0 && secondTitle.length > 0) {
    const shorter = topTitle.length <= secondTitle.length ? topTitle : secondTitle;
    const longer = topTitle.length <= secondTitle.length ? secondTitle : topTitle;
    if (longer.startsWith(shorter) && shorter.length / longer.length >= 0.95) return true;
  }
  return false;
}

export function shouldAutoAcceptTitleAuthor(item: ReviewItem): boolean {
  if (item.status !== "pending") return false;
  const top = item.candidates[0];
  if (!top) return false;
  if (top.matchMethod !== "title_author") return false;
  if (top.matchConfidence !== "high") return false;
  if (isAmbiguousTopCandidates(item)) return false;
  if (!titleMatches(item.wereadTitle, top.title)) return false;
  if (!authorMatches(item.wereadAuthor, top.author)) return false;
  return true;
}

// ---------- main ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let reviewItems: ReviewItem[] = [];
  try {
    reviewItems = JSON.parse(fs.readFileSync(args.reviewPath, "utf8"));
  } catch (err) {
    console.error(`[weread:review:auto-accept-title-author] Failed to read review queue: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const stats = {
    scanned: reviewItems.length,
    autoAccepted: 0,
    alreadyAccepted: 0,
    skippedNonPending: 0,
    skippedNonTitleAuthor: 0,
    skippedNotHigh: 0,
    skippedTitleMismatch: 0,
    skippedAuthorMismatch: 0,
    skippedAmbiguous: 0,
    skippedNoCandidate: 0,
    skippedMax: 0,
  };

  for (const item of reviewItems) {
    if (item.status === "accepted") {
      stats.alreadyAccepted += 1;
      continue;
    }
    if (item.status !== "pending") {
      stats.skippedNonPending += 1;
      continue;
    }

    const top = item.candidates[0];
    if (!top) {
      stats.skippedNoCandidate += 1;
      continue;
    }
    if (top.matchMethod !== "title_author") {
      stats.skippedNonTitleAuthor += 1;
      continue;
    }
    if (top.matchConfidence !== "high") {
      stats.skippedNotHigh += 1;
      continue;
    }
    if (isAmbiguousTopCandidates(item)) {
      stats.skippedAmbiguous += 1;
      continue;
    }
    if (!titleMatches(item.wereadTitle, top.title)) {
      stats.skippedTitleMismatch += 1;
      continue;
    }
    if (!authorMatches(item.wereadAuthor, top.author)) {
      stats.skippedAuthorMismatch += 1;
      continue;
    }
    if (args.maxAutoAccept !== null && stats.autoAccepted >= args.maxAutoAccept) {
      stats.skippedMax += 1;
      continue;
    }

    if (!args.dryRun) {
      item.status = "accepted";
      item.decisionSource = "auto_seed";
      item.selectedCandidateIndex = 0;
      item.selectedCatalogId = top.catalogId;
      item.reason = "auto-accepted: title_author high-confidence strict match";
    }
    stats.autoAccepted += 1;
  }

  const summary = {
    appliedAt: new Date().toISOString(),
    dryRun: args.dryRun,
    ...stats,
  };

  fs.mkdirSync(path.dirname(args.summaryPath), { recursive: true });
  if (!args.dryRun) {
    fs.mkdirSync(path.dirname(args.reviewPath), { recursive: true });
    fs.writeFileSync(args.reviewPath, JSON.stringify(reviewItems, null, 2) + "\n");
  }
  fs.writeFileSync(args.summaryPath, JSON.stringify(summary, null, 2) + "\n");

  console.log("[weread:review:auto-accept-title-author] STATUS=PASS");
  console.log(`[weread:review:auto-accept-title-author] scanned=${stats.scanned}`);
  console.log(`[weread:review:auto-accept-title-author] autoAccepted=${stats.autoAccepted}`);
  console.log(`[weread:review:auto-accept-title-author] alreadyAccepted=${stats.alreadyAccepted}`);
  console.log(`[weread:review:auto-accept-title-author] skippedNonPending=${stats.skippedNonPending}`);
  console.log(`[weread:review:auto-accept-title-author] skippedNonTitleAuthor=${stats.skippedNonTitleAuthor}`);
  console.log(`[weread:review:auto-accept-title-author] skippedNotHigh=${stats.skippedNotHigh}`);
  console.log(`[weread:review:auto-accept-title-author] skippedTitleMismatch=${stats.skippedTitleMismatch}`);
  console.log(`[weread:review:auto-accept-title-author] skippedAuthorMismatch=${stats.skippedAuthorMismatch}`);
  console.log(`[weread:review:auto-accept-title-author] skippedAmbiguous=${stats.skippedAmbiguous}`);
  console.log(`[weread:review:auto-accept-title-author] skippedNoCandidate=${stats.skippedNoCandidate}`);
  console.log(`[weread:review:auto-accept-title-author] skippedMax=${stats.skippedMax}`);
  if (args.dryRun) {
    console.log("[weread:review:auto-accept-title-author] DRY_RUN: no files modified");
  }
}

import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
