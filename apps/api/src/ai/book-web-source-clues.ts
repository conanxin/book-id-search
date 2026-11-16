/**
 * Literal clues in returned search text, not bibliographic verification.
 * ISBN shape/labels are recognized without checksums or 10/13 conversion.
 */
export interface BookWebSourceClues {
  isbn: "matched" | "mixed" | "other_only" | "not_seen" | "unavailable";
  text: Array<"title" | "author">;
}

interface PublicBookFields { title: string; author: string; isbn: string }
interface VisibleSourceFields { title: string; excerpt: string }

// NFKC handles full-width digits/letters and the full-width hyphen. Treat the
// remaining common hyphen/dash glyphs alike, but retain all other punctuation.
function isbnText(value: string): string {
  return value.normalize("NFKC").toUpperCase().replace(/[\u2010-\u2015\u2212]/g, "-");
}
function isbnValue(value: string, labelledLength?: string): string | undefined {
  const compact = value.replace(/[\s-]/g, "");
  if (!/^(?:97[89][0-9]{10}|[0-9]{9}[0-9X])$/.test(compact)) return undefined;
  if (labelledLength && compact.length !== Number(labelledLength)) return undefined;
  return compact;
}
function catalogIsbn(value: string): string | undefined {
  const normalized = isbnText(value).trim();
  const label = /^ISBN(?:\s*-\s*(10|13))?\s*:?\s*/.exec(normalized);
  return isbnValue(label ? normalized.slice(label[0].length) : normalized, label?.[1]);
}
function visibleIsbns(value: string, truncated: boolean): Set<string> {
  const normalized = isbnText(value), found = new Set<string>();
  // A maximal numeric run prevents extracting an ISBN from a longer number,
  // including a longer number formatted with spaces or hyphens.
  const labelled = /(?<![A-Z\p{N}_])ISBN(?:\s*-\s*(10|13))?\s*:?\s*([\p{N}X](?:[\s-]*[\p{N}X])*)/gu;
  const bareText = normalized.replace(labelled, (whole: string, length: string | undefined, digits: string, offset: number) => {
    const after = normalized[offset + whole.length] ?? "";
    const isbn = isbnValue(digits, length);
    if (isbn && !/[A-Z\p{N}_]/u.test(after)
      && !(truncated && /^[\s-]*$/.test(normalized.slice(offset + whole.length)))) found.add(isbn);
    // Even a contradictory ISBN-10/13 label must not be bypassed by the bare
    // ISBN-13 pass. A later list value does not inherit this explicit label.
    return "#".repeat(whole.length);
  });
  for (const match of bareText.matchAll(/[\p{N}X](?:[\s-]*[\p{N}X])*/gu)) {
    const before = bareText[match.index! - 1] ?? "", after = bareText[match.index! + match[0].length] ?? "";
    if (/[A-Z\p{N}_]/u.test(before) || /[A-Z\p{N}_]/u.test(after)) continue;
    const isbn = isbnValue(match[0]);
    if (isbn?.length === 13 && !(truncated && /^[\s-]*$/.test(normalized.slice(match.index! + match[0].length)))) found.add(isbn);
  }
  return found;
}
function comparableText(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
function isWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}\p{M}_]/u.test(value)
    && !/[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u.test(value);
}
function characterAt(value: string, index: number): string {
  const point = value.codePointAt(index);
  return point === undefined ? "" : String.fromCodePoint(point);
}
function characterBefore(value: string, index: number): string {
  if (index <= 0) return "";
  return index >= 2 && /[\udc00-\udfff]/.test(value[index - 1]) && /[\ud800-\udbff]/.test(value[index - 2])
    ? value.slice(index - 2, index) : value[index - 1];
}
function containsCompleteText(haystack: string, needle: string, truncated: boolean): boolean {
  if (!needle) return false;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = characterBefore(haystack, index), after = characterAt(haystack, index + needle.length);
    if ((!isWordCharacter(characterAt(needle, 0)) || !isWordCharacter(before))
      && (!isWordCharacter(characterBefore(needle, needle.length)) || !isWordCharacter(after))
      && !(truncated && index + needle.length === haystack.length)) return true;
    from = index + 1;
  }
  return false;
}

/** Call only after source title/excerpt cleaning and truncation. Candidates
 * touching a cut-off field end are ambiguous: the unseen suffix could extend
 * a number or word. Neither fields nor author names are joined or inferred. */
export function deriveBookWebSourceClues(book: PublicBookFields, source: VisibleSourceFields,
  truncated: { title?: boolean; excerpt?: boolean } = {}): BookWebSourceClues {
  const fields = [{ value: source.title, truncated: !!truncated.title }, { value: source.excerpt, truncated: !!truncated.excerpt }];
  const normalizedFields = fields.map(field => ({ ...field, value: comparableText(field.value) }));
  const text: BookWebSourceClues["text"] = [];
  for (const field of ["title", "author"] as const) {
    const needle = comparableText(book[field]);
    if (needle && normalizedFields.some(field => containsCompleteText(field.value, needle, field.truncated))) text.push(field);
  }
  const target = catalogIsbn(book.isbn);
  if (!target) return { isbn: "unavailable", text };
  const observed = new Set(fields.flatMap(field => [...visibleIsbns(field.value, field.truncated)]));
  const targetSeen = observed.has(target), otherSeen = [...observed].some(value => value !== target);
  return { isbn: targetSeen ? (otherSeen ? "mixed" : "matched") : otherSeen ? "other_only" : "not_seen", text };
}
