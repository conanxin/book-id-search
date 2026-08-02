/**
 * S27G — Client-side model helpers for the private related-book discovery
 * panel. Pure functions only — no React, no DOM, no fetch.
 *
 * Inputs come from the in-browser AI summary (themes + readingDirections)
 * and the currently loaded private notes (used to derive catalogue id
 * exclusions). The output is the exact JSON shape sent to
 * `POST /api/private/weread/related-books`.
 *
 * Strict privacy contract:
 *   - Only sanitised theme/direction TITLES are used as seeds. We never
 *     forward summary overview text, keyPoints full sentences, raw note
 *     text or comment, q, token, wereadBookId / noteId / highlightId /
 *     chapterTitle, private titles, private authors.
 *   - Themes are prioritised. Directions are appended only if we still
 *     have fewer than 2 themes. We never combine both lists naively.
 *   - Seeds are deduplicated by lower-cased trimmed text; the first id wins.
 *   - Each seed text is trimmed, internal-whitespace collapsed,
 *     control-char-stripped, and length-clamped.
 *   - Exclusions come from currently loaded notes' non-empty catalogIds
 *     and are deduplicated.
 *   - Nothing is persisted (no localStorage, sessionStorage, IndexedDB,
 *     URL, query string, or file).
 */

import type {
  WereadAiSummaryResult,
  WereadRelatedBookItem,
  WereadRelatedBookSeed,
  WereadPrivateNoteItem,
} from "../wereadPrivate";

export const WEREAD_RELATED_BOOKS_UI_LIMITS = {
  MAX_SEEDS: 6,
  MAX_SEED_CHARS: 80,
  MIN_THEMES_PRIORITISED: 2,
} as const;

const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const ELLIPSIS = "…";
const MAX_CATALOG_IDS = 100;
const CATALOG_ID_RE = /^[0-9]+_[0-9]{12}$/;

function cleanThemeText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const stripped = raw.replace(CONTROL_CHAR_RE, "").trim();
  if (stripped.length === 0) return null;
  const collapsed = stripped.replace(/\s+/g, " ");
  if (collapsed.length === 0) return null;
  if (collapsed.length <= WEREAD_RELATED_BOOKS_UI_LIMITS.MAX_SEED_CHARS) return collapsed;
  return collapsed.slice(0, WEREAD_RELATED_BOOKS_UI_LIMITS.MAX_SEED_CHARS - 1) + ELLIPSIS;
}

export interface BuildRelatedBooksSeedsOptions {
  summary?: WereadAiSummaryResult | null;
  /**
   * Optional fallback seed set when no summary is available. Typically
   * `null` — the related-books button stays disabled without a summary.
   */
  fallback?: ReadonlyArray<{ id: string; text: string }> | null;
}

export interface BuildRelatedBooksSeedsResult {
  seeds: WereadRelatedBookSeed[];
  ok: boolean;
  reason?: string;
}

/**
 * Build the request body seed list from a sanitised AI summary.
 *
 * Order:
 *   1. `summary.themes[*].title` — first 6 unique titles.
 *   2. If we still have < 2 seeds, append `summary.readingDirections[*]`
 *      up to MAX_SEEDS.
 *
 * Rejection conditions (return `{ok:false}` so the UI disables the
 * button — it NEVER silently sends an empty body):
 *   - No summary passed in.
 *   - Summary is empty / no themes and no directions.
 */
export function buildRelatedBookSeeds(
  options: BuildRelatedBooksSeedsOptions
): BuildRelatedBooksSeedsResult {
  const summary = options.summary ?? null;
  if (!summary) {
    return { seeds: [], ok: false, reason: "需要先完成 AI 摘要。" };
  }

  const seeds: WereadRelatedBookSeed[] = [];
  const seenLower = new Set<string>();

  function pushSeed(rawId: string, rawText: unknown): void {
    const cleaned = cleanThemeText(rawText);
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seenLower.has(key)) return;
    seenLower.add(key);
    seeds.push({ id: rawId, text: cleaned });
  }

  // 1) Themes first.
  if (Array.isArray(summary.themes)) {
    for (let i = 0; i < summary.themes.length; i++) {
      if (seeds.length >= WEREAD_RELATED_BOOKS_UI_LIMITS.MAX_SEEDS) break;
      const theme = summary.themes[i];
      if (!theme || typeof theme !== "object") continue;
      const title = (theme as { title?: unknown }).title;
      // Use theme-{i} id so callers can render local reasons.
      pushSeed(`theme-${i}`, title);
    }
  }

  // 2) Directions only when we still have fewer than 2 themes.
  if (
    seeds.length < WEREAD_RELATED_BOOKS_UI_LIMITS.MIN_THEMES_PRIORITISED &&
    Array.isArray(summary.readingDirections)
  ) {
    for (let i = 0; i < summary.readingDirections.length; i++) {
      if (seeds.length >= WEREAD_RELATED_BOOKS_UI_LIMITS.MAX_SEEDS) break;
      const dir = summary.readingDirections[i];
      pushSeed(`direction-${i}`, dir);
    }
  }

  // 3) Allow an explicit fallback (rare; no summary case).
  if (seeds.length === 0 && Array.isArray(options.fallback)) {
    for (const f of options.fallback) {
      if (seeds.length >= WEREAD_RELATED_BOOKS_UI_LIMITS.MAX_SEEDS) break;
      if (!f || typeof f !== "object") continue;
      pushSeed(f.id, f.text);
    }
  }

  if (seeds.length === 0) {
    return { seeds, ok: false, reason: "尚未抽取到主题词。" };
  }
  return { seeds, ok: true };
}

/**
 * Build the `excludeCatalogIds` list from the currently loaded private
 * notes' non-empty catalogIds. Drops malformed values, deduplicates,
 * caps at 100.
 */
export function buildRelatedBookExclusions(
  notes: ReadonlyArray<WereadPrivateNoteItem>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const note of notes) {
    if (!note || typeof note !== "object") continue;
    const id = (note as { catalogId?: unknown }).catalogId;
    if (typeof id !== "string") continue;
    const trimmed = id.trim();
    if (!CATALOG_ID_RE.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_CATALOG_IDS) break;
  }
  return out;
}

/**
 * Sanity-check whether the related-book button should be enabled at all.
 * UI callers SHOULD gate the button on this AND on a non-null
 * `buildRelatedBookSeeds` result.
 */
export function validateRelatedBookEligibility(input: {
  summary?: WereadAiSummaryResult | null;
  itemsCount: number;
}): { eligible: true } | { eligible: false; reason: string } {
  const seedsResult = buildRelatedBookSeeds({ summary: input.summary });
  if (!seedsResult.ok) {
    return { eligible: false, reason: seedsResult.reason ?? "尚未具备检索条件。" };
  }
  // We still require at least one loaded note so that exclusions are
  // meaningful; without any loaded note, the related button should hide.
  if (input.itemsCount <= 0) {
    return { eligible: false, reason: "请先加载至少一条笔记。" };
  }
  return { eligible: true };
}

/**
 * Render a friendly meta line for the UI:
 *
 *   "种子 2 / 候选 12 / 返回 6"
 *
 * Numbers only — never includes the theme text.
 */
export function formatRelatedBookMeta(meta: {
  seedsUsed: number;
  candidatesConsidered: number;
  returned: number;
  excluded: number;
}): string {
  return `种子 ${meta.seedsUsed} / 候选 ${meta.candidatesConsidered} / 返回 ${meta.returned}`;
}

/**
 * Build a human-readable "为什么这本候选被推荐" sentence for the UI from
 * the synthetic seed ids the server attached to the item. The seed ids
 * come from the local AI summary, so this lookup never echoes note text.
 */
export function getRelatedBookReason(
  item: WereadRelatedBookItem,
  summary: WereadAiSummaryResult | null
): string {
  if (!item.matchedSeedIds || item.matchedSeedIds.length === 0) {
    return "命中主题候选";
  }
  const titles: string[] = [];
  const themeTitles: string[] = Array.isArray(summary?.themes)
    ? summary.themes.map((t) =>
        typeof t === "object" && t && typeof (t as { title?: unknown }).title === "string"
          ? ((t as { title: string }).title as string)
          : ""
      )
    : [];
  const dirTitles: string[] = Array.isArray(summary?.readingDirections)
    ? (summary.readingDirections.filter(
        (d): d is string => typeof d === "string"
      ) as string[])
    : [];

  for (const seedId of item.matchedSeedIds) {
    if (typeof seedId !== "string") continue;
    const m = /^(theme| direction)-(\d+)$/.exec(seedId);
    if (!m) continue;
    const idx = Number(m[2]);
    if (Number.isNaN(idx)) continue;
    if (m[1] === "theme" && themeTitles[idx]) titles.push(themeTitles[idx]);
    else if (m[1] === "direction" && dirTitles[idx]) titles.push(dirTitles[idx]);
  }
  const dedup = Array.from(new Set(titles));
  if (dedup.length === 0) return "命中主题候选";
  if (dedup.length === 1) return `与主题「${dedup[0]}」相关`;
  if (dedup.length === 2) return `与主题「${dedup[0]}」和「${dedup[1]}」相关`;
  return `与主题「${dedup[0]}」等 ${dedup.length} 项相关`;
}

/**
 * Merge a fresh server response with the existing display list. Currently
 * a thin wrapper that returns the new items, but documented so future
 * callers can re-fetch / paginate / append safely.
 */
export function mergeRelatedBookResults(
  prev: ReadonlyArray<WereadRelatedBookItem>,
  next: ReadonlyArray<WereadRelatedBookItem>
): WereadRelatedBookItem[] {
  if (prev.length === 0) return Array.from(next);
  const seen = new Set(prev.map((it) => it.catalogId));
  const merged = Array.from(prev);
  for (const item of next) {
    if (seen.has(item.catalogId)) continue;
    seen.add(item.catalogId);
    merged.push(item);
  }
  return merged;
}
