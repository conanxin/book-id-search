/** Literal forms in returned source text, never book identity or edition claims. */
export interface BookWebSourceTextContext {
  kind: "quoted_title" | "edition_text";
  field: "title" | "excerpt";
  value: string;
  matchStart: number;
  matchEnd: number;
  /** Context coordinates, like match coordinates, use the source field's UTF-16 indices. */
  start: number;
  end: number;
  text: string;
}
export interface BookWebSourceTextContexts {
  items: BookWebSourceTextContext[];
  limited: boolean;
}
interface VisibleSource { title: string; excerpt: string }
interface Match {
  kind: BookWebSourceTextContext["kind"];
  matchStart: number;
  matchEnd: number;
  value: string;
}
export const BOOK_WEB_SOURCE_TEXT_CONTEXT_LIMITS = {
  PER_KIND: 4, CONTEXT_CHARS: 400, QUOTED_TITLE_CHARS: 120, EDITION_TEXT_CHARS: 40,
} as const;
const editions = /第[ \t]*[0-9０-９一二三四五六七八九十百千零〇两兩]+[ \t]*版|初版|再版|重版|修订版|修訂版|增订版|增訂版|版本|版次/gu;
const high = (value: string) => /[\ud800-\udbff]/.test(value);
const low = (value: string) => /[\udc00-\udfff]/.test(value);

/** Skip a whole nested/unclosed form, including its apparently valid inner pairs. */
function quotedTitles(text: string): Match[] {
  const result: Match[] = [];
  let depth = 0, start = 0, nested = false;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "《") {
      if (depth === 0) { start = index; nested = false; }
      else nested = true;
      depth++;
    } else if (text[index] === "》" && depth > 0) {
      depth--;
      if (depth !== 0 || nested) continue;
      const inside = text.slice(start + 1, index);
      if (!inside.trim() || /[\r\n\u0085\u2028\u2029]/.test(inside)) continue;
      result.push({ kind: "quoted_title", matchStart: start, matchEnd: index + 1,
        value: text.slice(start, index + 1) });
    }
  }
  return result;
}

function context(text: string, match: Match) {
  let start = Math.max(0, match.matchStart - 120);
  let end = Math.min(text.length, start + BOOK_WEB_SOURCE_TEXT_CONTEXT_LIMITS.CONTEXT_CHARS);
  if (end === text.length) start = Math.max(0, end - BOOK_WEB_SOURCE_TEXT_CONTEXT_LIMITS.CONTEXT_CHARS);
  // Move inward at a cut through an astral character. Literal match delimiters
  // are BMP characters, so this cannot remove the matched form itself.
  if (start > 0 && low(text[start]) && high(text[start - 1])) start++;
  if (end < text.length && high(text[end - 1]) && low(text[end])) end--;
  return { start, end, text: text.slice(start, end) };
}

/** Call after the same source cleaning/truncation used by bookClues. No NFKC,
 * title/author/ISBN rematching, cross-field joining, or version reconciliation. */
export function deriveBookWebSourceTextContexts(source: VisibleSource,
  truncated: { title?: boolean; excerpt?: boolean } = {}): BookWebSourceTextContexts {
  const items: BookWebSourceTextContext[] = [];
  const counts = { quoted_title: 0, edition_text: 0 };
  let limited = false;
  for (const field of ["title", "excerpt"] as const) {
    const text = source[field];
    const matches = [...quotedTitles(text), ...Array.from(text.matchAll(editions), match => ({
      kind: "edition_text" as const, matchStart: match.index!, matchEnd: match.index! + match[0].length, value: match[0],
    }))].sort((left, right) => left.matchStart - right.matchStart || left.matchEnd - right.matchEnd);
    for (const match of matches) {
      const maximum = match.kind === "quoted_title"
        ? BOOK_WEB_SOURCE_TEXT_CONTEXT_LIMITS.QUOTED_TITLE_CHARS : BOOK_WEB_SOURCE_TEXT_CONTEXT_LIMITS.EDITION_TEXT_CHARS;
      // A closing 》 establishes a complete literal form even at a cut. A
      // version word touching a known cut could continue beyond visible text.
      if (match.value.length > maximum || counts[match.kind] === BOOK_WEB_SOURCE_TEXT_CONTEXT_LIMITS.PER_KIND
        || (match.kind === "edition_text" && truncated[field] && match.matchEnd === text.length)) {
        limited = true;
        continue;
      }
      items.push({ kind: match.kind, field, value: match.value, matchStart: match.matchStart, matchEnd: match.matchEnd,
        ...context(text, match) });
      counts[match.kind]++;
    }
  }
  return { items, limited };
}
