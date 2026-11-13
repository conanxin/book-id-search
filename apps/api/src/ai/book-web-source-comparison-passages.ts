import { BOOK_WEB_SOURCE_LIMITS } from "./book-web-source-contract.js";
import {
  BOOK_WEB_SOURCE_EVIDENCE_LIMITS as LIMITS, BookWebSourceEvidenceError, type BookWebSourcePassage,
} from "./book-web-source-evidence-contract.js";
import { splitBookWebSourcePassages } from "./book-web-source-evidence.js";

interface Range { start: number; end: number }
interface Node extends Range {
  previous: number;
  next: number;
  version: number;
  live: boolean;
}
interface Join {
  left: number;
  right: number;
  leftVersion: number;
  rightVersion: number;
  length: number;
  start: number;
}
const before = (a: Join, b: Join) => a.length < b.length || (a.length === b.length && a.start < b.start);

/** Only the two neighbours of a merge change; obsolete heap entries are checked when popped. */
class JoinHeap {
  private readonly items: Join[] = [];

  push(value: Join): void {
    const items = this.items;
    let index = items.length;
    items.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(value, items[parent])) break;
      items[index] = items[parent]; index = parent;
    }
    items[index] = value;
  }

  pop(): Join | undefined {
    const items = this.items, first = items[0], last = items.pop();
    if (!last || !items.length) return first;
    let index = 0;
    while (index * 2 + 1 < items.length) {
      let child = index * 2 + 1;
      if (child + 1 < items.length && before(items[child + 1], items[child])) child += 1;
      if (!before(items[child], last)) break;
      items[index] = items[child]; index = child;
    }
    items[index] = last;
    return first;
  }
}

/** Keep the separators in their original ranges, including all leading and trailing whitespace. */
function paragraphRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let start = 0;
  for (const match of text.matchAll(/\r?\n(?:[ \t]*\r?\n)+/g)) {
    const end = match.index + match[0].length;
    if (!text.slice(start, end).trim()) continue;
    ranges.push({ start, end }); start = end;
  }
  if (start < text.length) {
    if (text.slice(start).trim()) ranges.push({ start, end: text.length });
    else if (ranges.length) ranges[ranges.length - 1].end = text.length;
  }
  return ranges;
}

function mergeToBudget(ranges: Range[]): Range[] | undefined {
  const nodes: Node[] = ranges.map((range, index) => ({
    ...range, previous: index - 1, next: index + 1 < ranges.length ? index + 1 : -1,
    version: 0, live: true,
  }));
  const heap = new JoinHeap();
  function enqueue(index: number) {
    if (index < 0) return;
    const left = nodes[index];
    if (!left.live || left.next < 0) return;
    const right = nodes[left.next], length = right.end - left.start;
    if (!right.live || right.previous !== index || left.end !== right.start || length > LIMITS.PASSAGE_CHARS) return;
    heap.push({ left: index, right: left.next, leftVersion: left.version, rightVersion: right.version,
      length, start: left.start });
  }
  for (let index = 0; index + 1 < nodes.length; index++) enqueue(index);
  let count = nodes.length;
  while (count > LIMITS.PASSAGES) {
    const join = heap.pop();
    if (!join) return undefined;
    const left = nodes[join.left], right = nodes[join.right];
    if (!left.live || !right.live || left.version !== join.leftVersion || right.version !== join.rightVersion
      || left.next !== join.right || right.previous !== join.left || left.end !== right.start
      || right.end - left.start !== join.length) continue;
    left.end = right.end; left.next = right.next; left.version += 1;
    right.live = false; right.version += 1;
    if (right.next >= 0) nodes[right.next].previous = join.left;
    count -= 1;
    enqueue(left.previous); enqueue(join.left);
  }
  return nodes.filter(node => node.live).map(({ start, end }) => ({ start, end }));
}

/**
 * Comparison keeps natural paragraphs selectable instead of padding short prose with
 * neighbouring metadata. Only over-budget sources coalesce their shortest adjacent ranges.
 * All ranges cover the original UTF-16 text exactly; no paragraph is ranked or discarded.
 */
export function splitBookWebSourceComparisonPassages(text: string): BookWebSourcePassage[] {
  if (typeof text !== "string" || !text.trim() || text.length > BOOK_WEB_SOURCE_LIMITS.TEXT_CHARS
    || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)) {
    throw new BookWebSourceEvidenceError("BOOK_EVIDENCE_INVALID_OUTPUT");
  }
  const natural: Range[] = [];
  for (const range of paragraphRanges(text)) {
    if (range.end - range.start <= LIMITS.PASSAGE_CHARS) natural.push(range);
    else {
      // Existing long-passage sentence and surrogate boundaries stay unchanged.
      for (const part of splitBookWebSourcePassages(text.slice(range.start, range.end))) {
        natural.push({ start: range.start + part.start, end: range.start + part.end });
      }
    }
  }
  const bounded = natural.length <= LIMITS.PASSAGES ? natural : mergeToBudget(natural);
  // At 30,000 units a merge always exists above 64 ranges: otherwise 32 disjoint
  // adjacent pairs would each exceed 1,200 units, requiring more than 38,400.
  // Keep the original complete splitter as a fallback if those limits ever change.
  if (!bounded) return splitBookWebSourcePassages(text);
  return bounded.map(({ start, end }, index) => ({ id: "P" + (index + 1), start, end, text: text.slice(start, end) }));
}
