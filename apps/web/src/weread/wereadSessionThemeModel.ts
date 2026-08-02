/**
 * S27H-2 — Session Theme Overlay model helpers.
 *
 * Strict privacy contract (mirrors the S27E/S27G/S27H boundary):
 *   - These helpers NEVER read note text, comment, wereadBookId,
 *     noteId, highlightId, chapterTitle, or raw WeRead title / author.
 *   - The only AI-summary fields they touch are `themes[].title` and
 *     `readingDirections[]`. They NEVER read `overview`, `keyPoints`,
 *     or `reviewQuestions`.
 *   - The overlay never carries the search term (`q`), the token, or
 *     any private catalog id. Only public `catalogId`s extracted from
 *     items already filtered by `matched: true` are surfaced.
 *   - Pure functions only — no React, no DOM, no network calls.
 */

import type {
  WereadAiSummaryResult,
  WereadAiSummaryTheme,
  WereadPrivateNoteItem,
} from "../wereadPrivate";

// ---------- types ----------

export type WereadSessionThemeSource = "theme" | "direction";

export interface WereadSessionTheme {
  id: string;
  label: string;
  source: WereadSessionThemeSource;
}

export interface WereadSessionThemeOverlay {
  enabled: boolean;
  themes: WereadSessionTheme[];
  catalogIds: string[];
  notesUsed: number;
}

/**
 * Public catalogId shape used across S27F / S27G / S27H: a sequence
 * of digits, an underscore, then a fixed-width numeric suffix.
 *
 * We accept a slightly looser pattern here (digits / underscore / 6–16
 * digits) than the strict server-side validator, because the goal is
 * to drop garbage before it ever reaches the network. Anything that
 * looks implausible is filtered client-side as well.
 */
const PUBLIC_CATALOG_ID_PATTERN = /^\d+_\d{6,16}$/;

// ---------- default / empty ----------

export const EMPTY_SESSION_THEME_OVERLAY: WereadSessionThemeOverlay = {
  enabled: false,
  themes: [],
  catalogIds: [],
  notesUsed: 0,
};

// ---------- internal helpers ----------

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function trimLabel(raw: string): string {
  // Spec: trim each label and clamp to 60 characters max.
  return raw.replace(/\s+/g, " ").trim().slice(0, 60);
}

function isPublicCatalogId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 0) return false;
  return PUBLIC_CATALOG_ID_PATTERN.test(value);
}

/**
 * Defensive read of `summary.themes[].title`. We never trust the
 * `summary` shape beyond `themes` and `readingDirections`; even if a
 * server bug or a forged response put an `overview` blob next to
 * those arrays, this helper never touches it.
 */
function readThemeTitles(summary: WereadAiSummaryResult | null): string[] {
  if (!summary || typeof summary !== "object") return [];
  const themes = Array.isArray(summary.themes) ? summary.themes : [];
  const out: string[] = [];
  for (const t of themes) {
    if (!t || typeof t !== "object") continue;
    const title = asString((t as WereadAiSummaryTheme).title);
    if (!title) continue;
    out.push(title);
  }
  return out;
}

function readReadingDirections(summary: WereadAiSummaryResult | null): string[] {
  if (!summary || typeof summary !== "object") return [];
  const dirs = Array.isArray(summary.readingDirections) ? summary.readingDirections : [];
  const out: string[] = [];
  for (const d of dirs) {
    const dir = asString(d);
    if (!dir) continue;
    out.push(dir);
  }
  return out;
}

function dedupePreserveOrder(values: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// ---------- public helpers ----------

/**
 * Build the list of session theme labels from the AI summary.
 *
 * Rules (from the spec):
 *   - Prefer `themes[].title`.
 *   - Top up with `readingDirections[]` when fewer than 6 themes exist.
 *   - Cap at 6.
 *   - Trim and clamp to 60 characters.
 *   - Deduplicate (case-sensitive, after trim) and preserve insertion order.
 *   - IDs: `theme-N` first, then `direction-N`.
 */
export function buildSessionThemeLabels(
  summary: WereadAiSummaryResult | null
): WereadSessionTheme[] {
  const themes = readThemeTitles(summary);
  const directions = readReadingDirections(summary);

  const labels: Array<{ source: WereadSessionThemeSource; label: string }> = [];
  const seen = new Set<string>();
  const push = (source: WereadSessionThemeSource, raw: string) => {
    const label = trimLabel(raw);
    if (!label) return;
    if (seen.has(label)) return;
    seen.add(label);
    labels.push({ source, label });
  };

  for (const t of themes) push("theme", t);
  for (const d of directions) {
    if (labels.length >= 6) break;
    push("direction", d);
  }

  const capped = labels.slice(0, 6);
  const counters: Record<WereadSessionThemeSource, number> = { theme: 0, direction: 0 };
  return capped.map((entry) => {
    const id = `${entry.source}-${counters[entry.source]}`;
    counters[entry.source] += 1;
    return {
      id,
      label: entry.label,
      source: entry.source,
    };
  });
}

/**
 * Extract the public catalogIds for nodes we want to highlight.
 *
 * Rules:
 *   - Only items with `matched: true` and a non-empty public `catalogId`
 *     are kept.
 *   - Catalog IDs are deduplicated.
 *   - Capped at 100 to keep the React tree trivial.
 *   - Items whose catalogId does not look like a public id are dropped.
 */
export function buildSessionCatalogIds(
  items: ReadonlyArray<WereadPrivateNoteItem>
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.matched !== true) continue;
    if (!isPublicCatalogId(item.catalogId)) continue;
    const id = item.catalogId;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 100) break;
  }
  return ids;
}

/**
 * Build the full overlay from AI summary + currently loaded items.
 *
 * - `enabled` is true iff the caller actually has an AI summary AND
 *   there is at least one label OR one catalog id. Without a summary
 *   the overlay is treated as disabled — the UI surface only opens
 *   once the user clicks "AI 整理当前已加载笔记" (S27E).
 * - `notesUsed` is the number of notes that were sent to MiniMax. We
 *   accept either `meta?.itemsUsed` (the canonical source) or fall back
 *   to the number of currently loaded items the caller is reporting.
 *   The value is used only for the UI summary line.
 */
export function buildSessionThemeOverlay(args: {
  summary: WereadAiSummaryResult | null;
  items: ReadonlyArray<WereadPrivateNoteItem>;
  notesUsed?: number;
}): WereadSessionThemeOverlay {
  const themes = buildSessionThemeLabels(args.summary);
  const catalogIds = buildSessionCatalogIds(args.items);
  const hasContent = themes.length > 0 || catalogIds.length > 0;
  const notesUsed =
    typeof args.notesUsed === "number" && Number.isFinite(args.notesUsed) && args.notesUsed >= 0
      ? Math.floor(args.notesUsed)
      : args.items.length;
  return {
    enabled: args.summary !== null && hasContent,
    themes,
    catalogIds,
    notesUsed,
  };
}

/**
 * Defensive validator used in tests / smoke checks. Returns `true`
 * iff the overlay is structurally well-formed and contains nothing
 * from the forbidden fields. This is a pure assertion — never log it
 * with note text, summary body, or token.
 */
export function validateSessionThemeOverlay(
  overlay: WereadSessionThemeOverlay
): boolean {
  if (!overlay || typeof overlay !== "object") return false;
  if (typeof overlay.enabled !== "boolean") return false;
  if (!Array.isArray(overlay.themes)) return false;
  if (!Array.isArray(overlay.catalogIds)) return false;
  if (typeof overlay.notesUsed !== "number" || !Number.isFinite(overlay.notesUsed)) {
    return false;
  }
  if (overlay.themes.length > 6) return false;
  if (overlay.catalogIds.length > 100) return false;
  for (const t of overlay.themes) {
    if (!t || typeof t !== "object") return false;
    if (typeof t.id !== "string" || !t.id) return false;
    if (typeof t.label !== "string") return false;
    if (t.label.length === 0 || t.label.length > 60) return false;
    if (t.source !== "theme" && t.source !== "direction") return false;
  }
  for (const id of overlay.catalogIds) {
    if (typeof id !== "string") return false;
    if (!isPublicCatalogId(id)) return false;
  }
  return true;
}

/** Node-level check used by the SVG layer. */
export function isSessionMapNode(
  catalogId: string,
  overlay: WereadSessionThemeOverlay
): boolean {
  if (!overlay.enabled || overlay.catalogIds.length === 0) return false;
  if (typeof catalogId !== "string" || !catalogId) return false;
  return overlay.catalogIds.includes(catalogId);
}

/**
 * Return only the edges that should be drawn in a focused session view.
 *
 * - A link is "session-related" iff at least one endpoint is in the
 *   session catalog set.
 * - `mode === "full"` returns every edge; `mode === "session"` returns
 *   only edges that touch at least one session node.
 *
 * The function never re-orders edges: it preserves the original index
 * order so the SVG layout stays stable.
 */
export function filterSessionLinks<L extends { sourceCatalogId: string; targetCatalogId: string }>(
  links: ReadonlyArray<L>,
  overlay: WereadSessionThemeOverlay,
  mode: "full" | "session"
): L[] {
  if (mode === "full") return [...links];
  if (!overlay.enabled || overlay.catalogIds.length === 0) return [];
  const set = new Set(overlay.catalogIds);
  const out: L[] = [];
  for (const link of links) {
    if (!link || typeof link !== "object") continue;
    if (set.has(link.sourceCatalogId) || set.has(link.targetCatalogId)) {
      out.push(link);
    }
  }
  return out;
}

/**
 * Build a short user-facing summary line. The output is always derived
 * from the overlay's count fields only — it never inlines note text
 * or AI-summary body content.
 */
export function formatSessionOverlaySummary(
  overlay: WereadSessionThemeOverlay
): string {
  if (!overlay.enabled) return "主题层尚未启用。";
  const themePart =
    overlay.themes.length === 0
      ? "主题 0 个"
      : `主题 ${overlay.themes.length} 个`;
  const bookPart =
    overlay.catalogIds.length === 0
      ? "当前会话书目 0 本"
      : `当前会话书目 ${overlay.catalogIds.length} 本`;
  const usedPart = `AI 使用笔记 ${overlay.notesUsed} 条`;
  return `${themePart} · ${bookPart} · ${usedPart}`;
}

/**
 * Stable serialisation key for useMemo / setState equivalence checks.
 * Two overlays with the same key are observationally identical.
 */
export function sessionThemeOverlayKey(
  overlay: WereadSessionThemeOverlay
): string {
  const themes = overlay.themes.map((t) => `${t.source}:${t.label}`).join("|");
  return `${overlay.enabled ? 1 : 0}|${themes}|${overlay.catalogIds.join(",")}|${overlay.notesUsed}`;
}