#!/usr/bin/env tsx
/**
 * S26A: WeRead catalog matching prototype.
 *
 * Offline script that maps WeRead bookshelf entries to entries in the public
 * book-id-search catalog by calling the /api/search endpoint. No writes to the
 * public catalog. No API keys required.
 *
 * Strategies (in order of confidence):
 * 1. ISBN exact match → high
 * 2. Title + author both appear in catalog entry → high
 * 3. Title only similarity ≥ 0.7 → medium
 * 4. Title only similarity ≥ 0.5 → low
 * 5. Otherwise: no candidates
 *
 * Results are written to --out and are NOT persisted in the catalog. The output
 * is intended for local review only.
 *
 * Usage:
 *   tsx scripts/weread/match-weread-catalog.ts \
 *     --weread samples/weread/weread-books.sample.json \
 *     --catalog-query-url https://books.conanxin.com/api/search \
 *     --out private-data/weread/derived/weread-matches.generated.json
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

// ---------- types ----------
type WereadBook = {
  wereadBookId: string;
  title: string;
  author: string;
  isbn?: string | null;
  category?: string | null;
  progress?: number | null;
};

type CatalogResult = {
  id: string;
  ssid: string;
  dxid: string;
  isbn?: string;
  title: string;
  author: string;
};

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

type BookWithCandidates = {
  wereadBookId: string;
  title: string;
  author: string;
  candidates: MatchCandidate[];
};

// ---------- args ----------
interface Args {
  wereadPath: string;
  catalogQueryUrl: string;
  outPath: string;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string) => {
    const i = argv.indexOf(key);
    if (i < 0) return null;
    return argv[i + 1] as string;
  };

  const wereadPath = get("--weread") ?? "samples/weread/weread-books.sample.json";
  const catalogQueryUrl =
    get("--catalog-query-url") ?? "https://books.conanxin.com/api/search";
  const outPath = get("--out") ?? "private-data/weread/derived/weread-matches.generated.json";

  return { wereadPath, catalogQueryUrl, outPath };
}

// ---------- helpers: string normalization & similarity ----------
function clean(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

/** Dice coefficient between two strings after splitting into bigrams. */
function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const n = a.length - 1;
  const m = b.length - 1;
  const bigramsA = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const bg = a.slice(i, i + 2);
    bigramsA.set(bg, (bigramsA.get(bg) ?? 0) + 1);
  }

  let common = 0;
  for (let i = 0; i < m; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigramsA.get(bg) ?? 0;
    if (count > 0) {
      bigramsA.set(bg, count - 1);
      common++;
    }
  }

  return (2 * common) / (n + m);
}

function normalizeIsbn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/[^0-9X]/gi, "").toUpperCase();
}

// ---------- query construction ----------
function buildQueries(book: WereadBook): string[] {
  const queries: string[] = [];
  // Strategy 1: search by ISBN when available
  const isbn = normalizeIsbn(book.isbn);
  if (isbn && isbn.length >= 10) {
    queries.push(isbn);
  }
  // Strategy 2: title + author
  const author = book.author?.trim() ?? "";
  const title = book.title.trim();
  if (author && title) {
    queries.push(`${title} ${author}`);
  }
  // Strategy 3: title only
  if (title && !author) {
    queries.push(title);
  } else if (title) {
    queries.push(title);
  }
  return queries;
}

// ---------- candidate scoring ----------
function scoreCandidate(
  book: WereadBook,
  result: CatalogResult,
): Pick<MatchCandidate, "matchMethod" | "matchConfidence" | "reason"> | null {
  const bookIsbn = normalizeIsbn(book.isbn);
  const resultIsbn = normalizeIsbn(result.isbn);

  // 1. ISBN exact match
  if (bookIsbn && resultIsbn && bookIsbn === resultIsbn) {
    return { matchMethod: "isbn", matchConfidence: "high", reason: "ISBN exact match" };
  }

  // 2. Title + author both appear
  const cleanBookTitle = clean(book.title);
  const cleanBookAuthor = clean(book.author ?? "");
  const cleanResultTitle = clean(result.title);
  const cleanResultAuthor = clean(result.author ?? "");

  if (cleanBookTitle && cleanBookAuthor) {
    if (
      cleanResultTitle.includes(cleanBookTitle) ||
      cleanResultTitle.includes(cleanBookTitle.slice(0, Math.max(4, cleanBookTitle.length - 2)))
    ) {
      if (
        cleanResultAuthor.includes(cleanBookAuthor) ||
        cleanBookAuthor.includes(cleanResultAuthor)
      ) {
        return {
          matchMethod: "title_author",
          matchConfidence: "high",
          reason: "Title and author both matched",
        };
      }
    }
  }

  // 3. Title only similarity
  const sim = dice(cleanBookTitle, cleanResultTitle);
  if (sim >= 0.7) {
    return {
      matchMethod: "title_similarity",
      matchConfidence: "high",
      reason: `Title high similarity (${sim.toFixed(2)})`,
    };
  }
  if (sim >= 0.5) {
    return {
      matchMethod: "title_similarity",
      matchConfidence: "medium",
      reason: `Title medium similarity (${sim.toFixed(2)})`,
    };
  }
  if (sim >= 0.35) {
    return {
      matchMethod: "title_similarity",
      matchConfidence: "low",
      reason: `Title low similarity (${sim.toFixed(2)})`,
    };
  }

  return null;
}

// ---------- main ----------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  console.log(`[weread:match] weread=${args.wereadPath}`);
  console.log(`[weread:match] catalog=${args.catalogQueryUrl}`);
  console.log(`[weread:match] output=${args.outPath}`);
  console.log("");

  // 1. Load weread books
  let wereadBooks: WereadBook[];
  try {
    wereadBooks = JSON.parse(fs.readFileSync(args.wereadPath, "utf8"));
  } catch (err) {
    console.error(`[weread:match] Failed to read weread books: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log(`[weread:match] Loaded ${wereadBooks.length} WeRead books`);

  // 2. Query catalog for each
  const results: BookWithCandidates[] = [];
  for (const book of wereadBooks) {
    const queries = buildQueries(book);
    if (queries.length === 0) {
      console.warn(`[weread:match] Skipping ${book.wereadBookId}: no viable search query`);
      results.push({
        wereadBookId: book.wereadBookId,
        title: book.title,
        author: book.author,
        candidates: [],
      });
      continue;
    }

    // Try queries in order; stop on first non-empty result set
    let matched = false;
    const allCandidates: MatchCandidate[] = [];

    for (const query of queries) {
      const url = new URL(args.catalogQueryUrl);
      url.searchParams.set("q", query);
      url.searchParams.set("limit", "5");

      try {
        const res = await fetch(url.toString());
        if (!res.ok) continue;
        const json = (await res.json()) as { results?: CatalogResult[] };
        const catalogResults = json.results ?? [];
        if (catalogResults.length === 0) continue;

        for (const result of catalogResults) {
          const score = scoreCandidate(book, result);
          if (score) {
            // Check if duplicate ssid already exists (different queries may hit same catalog entry)
            const existing = allCandidates.find((c) => c.ssid === result.ssid);
            if (!existing) {
              allCandidates.push({
                catalogId: result.id,
                ssid: result.ssid,
                dxid: result.dxid,
                isbn: result.isbn ?? null,
                title: result.title,
                author: result.author,
                ...score,
              });
            }
            if (score.matchConfidence === "high") matched = true;
          }
        }

        if (matched && allCandidates.length >= 1) break;
      } catch (err) {
        // Network failures are silent; continue to next query
      }
    }

    // Sort: high first, then medium, then low
    const sorted = allCandidates.sort((a, b) => {
      const order: Record<string, number> = { high: 3, medium: 2, low: 1 };
      return (order[b.matchConfidence] ?? 0) - (order[a.matchConfidence] ?? 0);
    });

    // Cap at top 5
    const top5 = sorted.slice(0, 5);
    results.push({
      wereadBookId: book.wereadBookId,
      title: book.title,
      author: book.author,
      candidates: top5,
    });
    console.log(
      `  ✓ ${book.wereadBookId}: ${book.title} → ${top5.length} candidate(s) [top: ${top5[0]?.matchConfidence ?? "-"}]`,
    );
  }

  // 3. Write output
  const outDir = path.dirname(args.outPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  fs.writeFileSync(args.outPath, JSON.stringify(results, null, 2) + "\n");
  console.log("");
  console.log(
    `[weread:match] Done: ${results.length} books, ${results.reduce((s, r) => s + r.candidates.length, 0)} total candidates`,
  );
}

main();
