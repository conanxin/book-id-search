import { deriveBookWebSourceClues, type BookWebSourceClues } from "./book-web-source-clues.js";

type Book = { title: string; author: string; isbn: string };
type Source = { title: string; excerpt: string; truncated?: boolean };
type Cut = { title?: boolean; excerpt?: boolean };

export interface BookReviewCandidateEvidence {
  work: {
    titleForm: "full" | "main_title" | "not_seen";
    authorTextSeen: boolean;
    titleAmbiguous: boolean;
  };
  genre: { reviewTextSeen: boolean; nonReviewTextSeen: boolean };
  edition: { isbnText: BookWebSourceClues["isbn"] };
  eligible: boolean;
}

/** Text cues for a work-level candidate, never a verified review or edition.
 * Uses only the cleaned visible title/excerpt. No site reputation, URL inference,
 * invented aliases, transliteration, or model-generated classification. */
function normalized(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}
function titleText(value: string): string {
  return normalized(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
function mainTitle(value: string): string {
  return value.split(/[:：]/u, 1)[0].trim();
}
function titleForm(candidate: string, target: string): BookReviewCandidateEvidence["work"]["titleForm"] {
  if (titleText(candidate) === titleText(target) && titleText(target)) return "full";
  if (/[:：]/u.test(candidate) && /[:：]/u.test(target)) return "not_seen";
  const main = titleText(mainTitle(target));
  // A subtitle is an explicit colon-delimited form, not arbitrary prefix matching.
  return main.length >= 2 && main === titleText(mainTitle(candidate)) ? "main_title" : "not_seen";
}
function wholeText(haystack: string, needle: string): boolean {
  if (!needle) return false;
  let start = 0;
  while (start <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, start);
    if (at < 0) return false;
    const before = haystack[at - 1] ?? "", after = haystack[at + needle.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    start = at + 1;
  }
  return false;
}
function headlineTitle(source: string, target: string) {
  const quoted: string[] = [];
  let open = -1;
  const unclear = { titleForm: "not_seen" as const, titleAmbiguous: true };
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "《") {
      if (open >= 0) return unclear;
      open = index;
    } else if (source[index] === "》") {
      if (open < 0 || index === open + 1) return unclear;
      quoted.push(source.slice(open + 1, index));
      open = -1;
    }
  }
  if (open >= 0) return unclear;
  if (quoted.length) {
    const forms = quoted.map(value => titleForm(value, target));
    return { titleForm: forms.includes("full") ? "full" as const
      : forms.includes("main_title") ? "main_title" as const : "not_seen" as const,
    titleAmbiguous: new Set(quoted.map(titleText)).size > 1 };
  }
  const headline = titleText(source);
  if (wholeText(headline, titleText(target))) return { titleForm: "full" as const, titleAmbiguous: false };
  const unframed = normalized(source)
    .replace(/^(?:book review|review|书评|書評)\s*[:：]\s*/iu, "")
    .replace(/\s*[:：|—–-]\s*(?:book review|review|书评|書評|读后感|讀後感)\s*$/iu, "");
  if (/[:：]/u.test(target) && /[:：]/u.test(unframed)) return unclear;
  const main = titleText(mainTitle(target));
  return { titleForm: main.length >= 2 && wholeText(headline, main) ? "main_title" as const : "not_seen" as const,
    titleAmbiguous: false };
}
function authors(value: string): string[] {
  // Explicit responsibility segments only. Editors/translators do not become
  // authors just because their name appears on a catalog record.
  return value.split(/[;；]/u).map(part => part.trim())
    .filter(part => !/(?:主编|主編|编者|編者|编辑|編輯|译|譯|editor|translator)\s*[)）]?\s*$/iu.test(part)
      && !/^(?:主编|主編|编者|編者|编辑|編輯|译者|譯者)\s*[:：]/u.test(part)
      && !/^(?:edited|translated)\s+by\b/iu.test(part))
    .map(part => part.replace(/^(?:作者|著者)\s*[:：]\s*/u, "")
      .replace(/\s*(?:编著|編著|著)\s*$/u, "").trim()).filter(Boolean);
}
function withoutTargetTitle(value: string, target: string): string {
  let text = normalized(value).replace(/《([^《》\r\n]+)》/gu, (whole: string, inner: string) =>
    titleForm(inner, target) === "not_seen" ? whole : "《》");
  // Mask book-name words before genre checks: Interview with the Vampire is
  // a title, and the words "interview" or "review" in it are not page genres.
  for (const form of [normalized(target), normalized(mainTitle(target))]) {
    if (form.length < 2) continue;
    const escaped = titleText(form).split(" ").join("[^\\p{L}\\p{N}]+");
    text = text.replace(new RegExp("(?<![\\p{L}\\p{N}])" + escaped + "(?![\\p{L}\\p{N}])", "gu"), " ");
  }
  return text;
}

function reviewCue(pattern: RegExp, text: string, cut: boolean): boolean {
  return [...text.matchAll(new RegExp(pattern.source, pattern.flags + "g"))]
    .some(match => !cut || match.index + match[0].length < text.length);
}

export function assessBookReviewCandidate(source: Source, book: Book, cut?: Cut): BookReviewCandidateEvidence {
  // When only the aggregate flag survives, be conservative. snapshotSources
  // supplies the precise cut flags, so an old pageAge cut cannot hide a review.
  const cuts = cut ?? { title: !!source.truncated, excerpt: !!source.truncated };
  const title = cuts.title ? { titleForm: "not_seen" as const, titleAmbiguous: false }
    : headlineTitle(source.title, book.title);
  const authorTextSeen = authors(book.author).some(author =>
    deriveBookWebSourceClues({ title: "", author, isbn: "" }, source, cuts).text.includes("author"));
  const isbnText = deriveBookWebSourceClues(book, source, cuts).isbn;
  const heading = withoutTargetTitle(source.title, book.title);
  const excerpt = withoutTargetTitle(source.excerpt, book.title);
  const reviewHeading = reviewCue(/书评|書評|读后感|讀後感|评介|評介|评述|評述|(?:读|讀|评|評)《|\breview\b/iu, heading, !!cuts.title);
  const reviewExcerpt = reviewCue(/书评|書評|读后感|讀後感|\bbook review\b|\breview(?:ed)? (?:by|of)\b/iu, excerpt, !!cuts.excerpt);
  const nonReviewHeading = /采访|採訪|访谈|訪談|专访|專訪|出版汇总|出版彙總|书目|書目|馆藏|館藏|目录|目錄|商品|购买|購買|\binterview\b|\bcatalog(?:ue)?\b|\bproduct\b|\broundup\b/iu.test(heading);
  const nonReviewExcerpt = /库存信息|庫存資訊|好评率|好評率|本书口碑|本書口碑|接受采访|接受採訪|采访实录|訪談實錄|访谈实录|出版汇总|出版彙總|商品详情|商品詳情|加入购物车|加入購物車|购买入口|購買入口|购买本书|購買本書|馆藏记录|館藏記錄|不是(?:第三方)?书评|不提供评论正文|\b(?:author interview|interview with|interviewed by|add to cart|buy now|customer reviews|reader reviews|product details)\b/iu.test(excerpt);
  const genre = { reviewTextSeen: reviewHeading || reviewExcerpt, nonReviewTextSeen: nonReviewHeading || nonReviewExcerpt };
  // Main-title compatibility always needs an author cue. Even an exact ISBN
  // cannot bypass a missing/wrong headline, or certify a mixed-ISBN page.
  const identityCue = title.titleForm !== "not_seen" && !title.titleAmbiguous
    && (authorTextSeen || (title.titleForm === "full" && isbnText === "matched"));
  return { work: { ...title, authorTextSeen }, genre, edition: { isbnText },
    eligible: identityCue && genre.reviewTextSeen && !genre.nonReviewTextSeen };
}
