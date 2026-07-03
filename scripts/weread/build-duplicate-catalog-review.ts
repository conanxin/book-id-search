#!/usr/bin/env tsx
/**
 * S26K: Build a private duplicate catalogId review pack.
 *
 * Inputs:
 *   --confirmed private-data/weread/derived/latest/weread-matches.confirmed.json
 *   --review    private-data/weread/derived/latest/weread-match-review.json
 *   --out       private-data/weread/derived/latest/weread-duplicate-catalog-review.json
 *   --summary   private-data/weread/derived/latest/weread-duplicate-catalog-review-summary.json
 *
 * Privacy:
 *   - private review file may contain wereadBookId/catalogId/title/author because it is not committed.
 *   - stdout only prints counts and high-level status.
 */
import fs from "node:fs";
import process from "node:process";

type MatchMethod = "isbn" | "title_author" | "title_similarity" | "manual";
type MatchConfidence = "high" | "medium" | "low";

type ConfirmedMatch = {
  wereadBookId: string;
  catalogId: string;
  ssid: string;
  dxid: string;
  isbn: string | null;
  matchMethod: MatchMethod;
  matchConfidence: MatchConfidence;
};

type ReviewItem = {
  reviewId: string;
  wereadBookId: string;
  wereadTitle: string;
  wereadAuthor: string;
  selectedCatalogId: string | null;
  candidates: {
    catalogId: string;
    title: string;
    author: string;
    matchMethod: MatchMethod;
    matchConfidence: MatchConfidence;
  }[];
};

type DuplicateReviewGroup = {
  catalogId: string;
  entries: {
    wereadBookId: string;
    wereadTitle: string;
    wereadAuthor: string;
    matchMethod: MatchMethod;
    matchConfidence: MatchConfidence;
    selectedCatalogId: string | null;
  }[];
  candidateDecisionNeeded: boolean;
};

type ReviewSummary = {
  duplicateCatalogIdGroups: number;
  duplicateCatalogIdEntries: number;
  candidateDecisionNeeded: number;
  generatedAt: string;
};

interface Args {
  confirmedPath: string;
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
    confirmedPath: get("--confirmed") ?? "private-data/weread/derived/latest/weread-matches.confirmed.json",
    reviewPath: get("--review") ?? "private-data/weread/derived/latest/weread-match-review.json",
    outPath: get("--out") ?? "private-data/weread/derived/latest/weread-duplicate-catalog-review.json",
    summaryPath: get("--summary") ?? "private-data/weread/derived/latest/weread-duplicate-catalog-review-summary.json",
  };
}

function normalizeTitle(title: string): string {
  return title
    .replace(/[\s\u3000]+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeAuthor(author: string): string {
  return author
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[\[\]（）()]/g, "")
    .trim()
    .toLowerCase();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const confirmed: ConfirmedMatch[] = JSON.parse(fs.readFileSync(args.confirmedPath, "utf8"));
  const reviewItems: ReviewItem[] = fs.existsSync(args.reviewPath) ? JSON.parse(fs.readFileSync(args.reviewPath, "utf8")) : [];

  const reviewByWereadId = new Map<string, ReviewItem>();
  for (const r of reviewItems) {
    if (r?.wereadBookId) reviewByWereadId.set(r.wereadBookId, r);
  }

  const byCatalog = new Map<string, ConfirmedMatch[]>();
  for (const row of confirmed) {
    const arr = byCatalog.get(row.catalogId) ?? [];
    arr.push(row);
    byCatalog.set(row.catalogId, arr);
  }

  const groups: DuplicateReviewGroup[] = [];
  for (const [catalogId, entries] of byCatalog.entries()) {
    if (entries.length <= 1) continue;

    const group: DuplicateReviewGroup = {
      catalogId,
      entries: entries.map((e) => {
        const review = reviewByWereadId.get(e.wereadBookId);
        return {
          wereadBookId: e.wereadBookId,
          wereadTitle: review?.wereadTitle ?? "",
          wereadAuthor: review?.wereadAuthor ?? "",
          matchMethod: e.matchMethod,
          matchConfidence: e.matchConfidence,
          selectedCatalogId: review?.selectedCatalogId ?? null,
        };
      }),
      candidateDecisionNeeded: false,
    };

    // Determine if all entries look like the same work.
    const titles = group.entries.map((e) => normalizeTitle(e.wereadTitle));
    const authors = group.entries.map((e) => normalizeAuthor(e.wereadAuthor));
    const sameTitle = titles.every((t) => t === titles[0] && t.length > 0);
    const sameAuthor = authors.every((a) => a === authors[0]);
    const sameCatalogId = group.entries.every((e) => e.selectedCatalogId === catalogId);
    const highConfidence = group.entries.every((e) => e.matchConfidence === "high");
    const validMethod = group.entries.every((e) => e.matchMethod === "isbn" || e.matchMethod === "title_author");

    group.candidateDecisionNeeded = !(sameTitle && sameAuthor && sameCatalogId && highConfidence && validMethod);
    groups.push(group);
  }

  fs.writeFileSync(args.outPath, JSON.stringify(groups, null, 2));

  const summary: ReviewSummary = {
    duplicateCatalogIdGroups: groups.length,
    duplicateCatalogIdEntries: groups.reduce((acc, g) => acc + g.entries.length, 0),
    candidateDecisionNeeded: groups.filter((g) => g.candidateDecisionNeeded).length,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(args.summaryPath, JSON.stringify(summary, null, 2));

  console.log(`[weread:duplicate:review] duplicateCatalogIdGroups=${summary.duplicateCatalogIdGroups}`);
  console.log(`[weread:duplicate:review] duplicateCatalogIdEntries=${summary.duplicateCatalogIdEntries}`);
  console.log(`[weread:duplicate:review] candidateDecisionNeeded=${summary.candidateDecisionNeeded}`);
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((err) => {
    console.error(`[weread:duplicate:review] ERROR: ${err.message}`);
    process.exit(1);
  });
}
