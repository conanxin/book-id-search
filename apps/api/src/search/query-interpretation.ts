/**
 * S31-B1: pure, conservative interpretation of one explicitly quoted title.
 * No I/O, author dictionary, benchmark lookup or API integration.
 * Authors are user-supplied syntactic hints, not verified bibliographic facts.
 * B1 accepts simple 2-4-Han-character single-author forms only.
 */
export interface BookQueryInterpretation {
  status: "parsed" | "passthrough";
  task: "known_item_lookup" | null;
  originalQuery: string;
  workTitle: string | null;
  author: string | null;
  searchQuery: string;
  reason: "single_title" | "no_single_title" | "unsupported_context";
}

const REQUEST_PREFIX = /^(?:请\s*)?(?:(?:帮我|我想|想)\s*)?(?:查找|找)(?:一下)?\s*(?:一本\s*)?/u;
const EXISTS_PREFIX = /^有没有\s*(?:一本\s*)?/u;
const AUTHOR_PREFIX = /^([\p{Script=Han}]{2,4}?)\s*(?:所著的|写的|著的|著|的)$/u;
// Reject explicit non-author cues rather than treating every short phrase as a name.
const NON_AUTHOR = /出版|书店|版本|新版|旧版|原版|作者|编者|译者|主编|公司|大学|研究|关于|有关|推荐|介绍|解读|[和与及或等的]/u;
const UNCERTAIN_PERSON = /^(?:我|你|他|她|它|这|那|某|不|非)/u;

export function interpretBookQuery(rawQuery: string): BookQueryInterpretation {
  if (typeof rawQuery !== "string") {
    throw new TypeError("rawQuery must be a string");
  }
  const unchanged = (reason: BookQueryInterpretation["reason"]): BookQueryInterpretation => ({
    status: "passthrough", task: null, originalQuery: rawQuery,
    workTitle: null, author: null, searchQuery: rawQuery, reason,
  });

  // No global cleanup: text inside the single pair of title brackets is protected.
  // Identifier/plain-keyword queries have no such pair and remain unchanged.
  const match = /^([^《》]*)《([^《》]+)》([^《》]*)$/u.exec(rawQuery.trim());
  if (!match || !match[2].trim()) return unchanged("no_single_title");
  const title = match[2];
  let prefix = match[1].trim();
  const suffix = match[3];
  if (/[\r\n]/u.test(title) || !/^[\s。.!！?？]*$/u.test(suffix)) {
    // Never discard edition, publisher, year, audience or exclusion constraints.
    return unchanged("unsupported_context");
  }

  const request = REQUEST_PREFIX.exec(prefix) ?? EXISTS_PREFIX.exec(prefix);
  if (request) prefix = prefix.slice(request[0].length).trim();

  let author: string | null = null;
  if (prefix) {
    const named = AUTHOR_PREFIX.exec(prefix);
    if (!named || NON_AUTHOR.test(named[1]) || UNCERTAIN_PERSON.test(named[1])) {
      return unchanged("unsupported_context");
    }
    author = named[1];
  }

  return {
    status: "parsed", task: "known_item_lookup", originalQuery: rawQuery,
    workTitle: title, author,
    searchQuery: author === null ? title : `${title} ${author}`,
    reason: "single_title",
  };
}
