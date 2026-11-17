/** AI labels describe visible search text only. Evidence always comes from the
 * server snapshot; matching an ID does not certify the label or its claims. */
export interface BookWebResearchEvidence {
  id: string;
  field: "title" | "excerpt";
  start: number;
  end: number;
  text: string;
}
export interface BookWebResearchAssessment {
  sourceId: string;
  relationship: "book_candidate" | "other_book" | "related_background" | "unclear";
  materialType: "bibliographic" | "review" | "research" | "discussion" | "other";
  evidence: BookWebResearchEvidence[];
}
interface VisibleSource { id: string; title: string; excerpt: string }
const RELATIONSHIPS = ["book_candidate", "other_book", "related_background", "unclear"];
const MATERIAL_TYPES = ["bibliographic", "review", "research", "discussion", "other"];
const EVIDENCE_CHARS = 400;
const BOUNDARY_MIN_CHARS = 80;
const unpairedSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function safeEnd(text: string, end: number): number {
  return end < text.length && /[\ud800-\udbff]/.test(text[end - 1])
    && /[\udc00-\udfff]/.test(text[end]) ? end - 1 : end;
}
function lastBoundary(text: string, pattern: RegExp): number | undefined {
  let boundary: number | undefined;
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (end >= BOUNDARY_MIN_CHARS) boundary = end;
  }
  return boundary;
}

/** Complete title and contiguous excerpt slices: no trimming, rewriting,
 * omitted tail or split surrogate pair. IDs are scoped to the source. */
export function createBookWebSourceEvidence(source: VisibleSource): BookWebResearchEvidence[] {
  if (!/^W[1-9][0-9]*$/.test(source.id) || !source.title.trim() || source.title.length > 300
    || !source.excerpt.trim() || source.excerpt.length > 3000
    || (unpairedSurrogate.test(source.title) || unpairedSurrogate.test(source.excerpt))) throw new Error("Invalid visible source");
  const result: BookWebResearchEvidence[] = [{
    id: source.id + ":T", field: "title", start: 0, end: source.title.length, text: source.title,
  }];
  for (let start = 0, number = 1; start < source.excerpt.length; number++) {
    let end = safeEnd(source.excerpt, Math.min(start + EVIDENCE_CHARS, source.excerpt.length));
    if (end < source.excerpt.length) {
      const window = source.excerpt.slice(start, end);
      const boundary = lastBoundary(window, /\n[ \t]*\n/g)
        ?? lastBoundary(window, /[。！？.!?][”’"'」』）)]*(?:[ \t]*\n)?/g);
      if (boundary !== undefined) end = safeEnd(source.excerpt, start + boundary);
    }
    result.push({ id: source.id + ":E" + number, field: "excerpt", start, end,
      text: source.excerpt.slice(start, end) });
    start = end;
  }
  return result;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** null means invalid, including a missing/partial new contract. Call only
 * when the provider explicitly supplied assessments; omission stays legacy. */
export function parseBookWebSourceAssessments(
  value: unknown,
  selectedIds: string[],
  evidenceBySource: ReadonlyMap<string, BookWebResearchEvidence[]>,
): BookWebResearchAssessment[] | null {
  if (!Array.isArray(value) || value.length !== selectedIds.length || value.length > 4) return null;
  const result: BookWebResearchAssessment[] = [];
  for (let index = 0; index < value.length; index++) {
    const item: unknown = value[index];
    if (!record(item) || Object.keys(item).some(key =>
      !["sourceId", "relationship", "materialType", "evidenceIds"].includes(key))
      || item.sourceId !== selectedIds[index]
      || typeof item.relationship !== "string" || !RELATIONSHIPS.includes(item.relationship)
      || typeof item.materialType !== "string" || !MATERIAL_TYPES.includes(item.materialType)
      || !Array.isArray(item.evidenceIds) || item.evidenceIds.length < 1 || item.evidenceIds.length > 2) return null;
    const candidates = evidenceBySource.get(selectedIds[index]);
    if (!candidates) return null;
    const known = new Map(candidates.map(candidate => [candidate.id, candidate]));
    const seen = new Set<string>();
    for (const id of item.evidenceIds) {
      if (typeof id !== "string" || !known.has(id) || seen.has(id)) return null;
      seen.add(id);
    }
    const evidence = candidates.filter(candidate => seen.has(candidate.id)).map(candidate => ({ ...candidate }));
    if (!evidence.some(candidate => candidate.field === "excerpt")
      || evidence.some(candidate => !candidate.text.trim())) return null;
    result.push({
      sourceId: selectedIds[index],
      relationship: item.relationship as BookWebResearchAssessment["relationship"],
      materialType: item.materialType as BookWebResearchAssessment["materialType"],
      evidence,
    });
  }
  return result;
}
