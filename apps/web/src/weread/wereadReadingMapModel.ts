/**
 * S27H — Front-end pure helpers for the personal reading-map dashboard.
 *
 * Strict privacy contract:
 *   - These helpers NEVER read note text, comment, wereadBookId, noteId,
 *     highlightId, chapterTitle, or raw WeRead title / author. They
 *     consume ONLY the aggregate counts / dates / catalog ids that the
 *     `/api/private/weread/reading-map` endpoint returns.
 *   - The SVG layout functions are deterministic — no random numbers,
 *     no Date.now() — so test snapshots and Playwright screenshots stay
 *     stable across runs and machines.
 *   - No external chart library is introduced: layout + bars + network
 *     geometry are all computed in pure functions so the React layer
 *     just maps the result onto <rect>, <line>, <circle> elements.
 */

import type {
  WereadReadingMapBook,
  WereadReadingMapLink,
  WereadReadingMapMonth,
  WereadReadingMapOverview,
  WereadReadingMapResponse,
} from "../wereadPrivate";
import type { WereadSessionThemeOverlay } from "./wereadSessionThemeModel";

// ---------- formatters ----------

const MONTH_NAMES_ZH = [
  "1 月",
  "2 月",
  "3 月",
  "4 月",
  "5 月",
  "6 月",
  "7 月",
  "8 月",
  "9 月",
  "10 月",
  "11 月",
  "12 月",
];

export function formatReadingMapMonth(monthKey: string): string {
  if (!/^\d{4}-\d{2}$/.test(monthKey)) return monthKey;
  const m = Number(monthKey.slice(5, 7));
  const year = monthKey.slice(0, 4);
  if (!Number.isFinite(m) || m < 1 || m > 12) return monthKey;
  return `${year} 年${MONTH_NAMES_ZH[m - 1]}`;
}

export function formatReadingMapDateRange(
  firstNoteAt: string | null,
  lastNoteAt: string | null
): string {
  if (!firstNoteAt || !lastNoteAt) return "暂无笔记日期";
  const fmt = (iso: string) => {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return "—";
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  };
  return `${fmt(firstNoteAt)} → ${fmt(lastNoteAt)}`;
}

export interface ReadingMapOverviewView {
  booksCount: string;
  notesCount: string;
  matchedCatalogsCount: string;
  matchedNoteRecordsCount: string;
  firstNoteAtLabel: string;
  lastNoteAtLabel: string;
  activeMonths: string;
  currentStreakMonths: string;
  longestStreakMonths: string;
  hasData: boolean;
}

export function formatReadingMapOverview(
  overview: WereadReadingMapOverview | null | undefined
): ReadingMapOverviewView {
  const safe = (n: number | undefined) =>
    typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("zh-CN") : "0";
  if (!overview) {
    return {
      booksCount: "—",
      notesCount: "—",
      matchedCatalogsCount: "—",
      matchedNoteRecordsCount: "—",
      firstNoteAtLabel: "—",
      lastNoteAtLabel: "—",
      activeMonths: "—",
      currentStreakMonths: "—",
      longestStreakMonths: "—",
      hasData: false,
    };
  }
  return {
    booksCount: safe(overview.booksCount),
    notesCount: safe(overview.notesCount),
    matchedCatalogsCount: safe(overview.matchedCatalogsCount),
    matchedNoteRecordsCount: safe(overview.matchedNoteRecordsCount),
    firstNoteAtLabel: overview.firstNoteAt ? overview.firstNoteAt.slice(0, 10) : "—",
    lastNoteAtLabel: overview.lastNoteAt ? overview.lastNoteAt.slice(0, 10) : "—",
    activeMonths: safe(overview.activeMonths),
    currentStreakMonths: safe(overview.currentStreakMonths),
    longestStreakMonths: safe(overview.longestStreakMonths),
    hasData: overview.matchedNoteRecordsCount > 0,
  };
}

// ---------- timeline model ----------

export interface TimelineBar {
  month: string;
  monthLabel: string;
  total: number;
  highlights: number;
  thoughts: number;
  reviews: number;
  unknown: number;
  matched: number;
  heightPct: number;
  matchedPct: number;
  highlightPct: number;
  thoughtPct: number;
  reviewPct: number;
  unknownPct: number;
}

export interface TimelineBarModel {
  bars: TimelineBar[];
  maxTotal: number;
  width: number;
  /** X coordinate for the centre of each bar (in the same coordinate space as width). */
  stepX: number;
  hasAnyActivity: boolean;
}

export const TIMELINE_VIEWBOX_WIDTH = 900;
export const TIMELINE_VIEWBOX_HEIGHT = 220;
export const TIMELINE_PADDING = { top: 12, right: 12, bottom: 28, left: 12 };

function safeRatio(part: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  if (!Number.isFinite(part) || part <= 0) return 0;
  return Math.min(100, Math.max(0, (part / total) * 100));
}

export function buildTimelineBarModel(
  timeline: ReadonlyArray<WereadReadingMapMonth>,
  monthsWindow = 24
): TimelineBarModel {
  const safeMonths = Math.max(1, Math.min(48, Math.floor(monthsWindow || 1)));
  const filtered = timeline.slice(-safeMonths);
  const maxTotal = filtered.reduce((acc, b) => Math.max(acc, b.total), 0);
  const innerWidth = TIMELINE_VIEWBOX_WIDTH - TIMELINE_PADDING.left - TIMELINE_PADDING.right;
  const stepX = filtered.length > 0 ? innerWidth / filtered.length : innerWidth;
  const bars: TimelineBar[] = filtered.map((b) => {
    const heightPct = safeRatio(b.total, maxTotal);
    return {
      month: b.month,
      monthLabel: formatReadingMapMonth(b.month),
      total: b.total,
      highlights: b.highlights,
      thoughts: b.thoughts,
      reviews: b.reviews,
      unknown: b.unknown,
      matched: b.matched,
      heightPct,
      matchedPct: safeRatio(b.matched, b.total),
      highlightPct: safeRatio(b.highlights, b.total),
      thoughtPct: safeRatio(b.thoughts, b.total),
      reviewPct: safeRatio(b.reviews, b.total),
      unknownPct: safeRatio(b.unknown, b.total),
    };
  });
  return {
    bars,
    maxTotal,
    width: TIMELINE_VIEWBOX_WIDTH,
    stepX,
    hasAnyActivity: bars.some((b) => b.total > 0),
  };
}

// ---------- network layout ----------

export const NETWORK_VIEWBOX_WIDTH = 900;
export const NETWORK_VIEWBOX_HEIGHT = 520;
export const NETWORK_PADDING = 32;

export const RADIUS_LIMITS = {
  MIN: 14,
  MAX: 36,
} as const;

export interface NodeLayout {
  catalogId: string;
  title: string;
  author?: string | null;
  noteCount: number;
  activeMonths: number;
  x: number;
  y: number;
  radius: number;
  ringIndex: number;
  /** Slot index within the ring (0-based). */
  ringSlot: number;
  /** S27H-2: true when this node's catalogId is in the session overlay. */
  isSession: boolean;
  /** S27H-2: true when the focus toggle is on and this node is *not* session. */
  isDimmed: boolean;
}

export interface EdgeLayout {
  sourceCatalogId: string;
  targetCatalogId: string;
  sharedMonths: number;
  weight: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  midX: number;
  midY: number;
  /** Length of the edge in the same coordinate space. */
  length: number;
  /** S27H-2: true when at least one endpoint is in the session overlay. */
  isSessionRelated: boolean;
  /** S27H-2: true when the focus toggle is on and this edge is not session-related. */
  isDimmed: boolean;
}

export interface NetworkLayout {
  nodes: NodeLayout[];
  edges: EdgeLayout[];
  viewBox: { width: number; height: number };
  empty: boolean;
}

/** Stable hash from a catalog id — FNV-1a 32-bit. Deterministic across machines. */
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Map to [0, 2π) so the angular offset is deterministic.
  return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
}

export function getReadingMapNodeRadius(noteCount: number, maxNoteCount: number): number {
  const min = RADIUS_LIMITS.MIN;
  const max = RADIUS_LIMITS.MAX;
  if (!Number.isFinite(noteCount) || noteCount <= 0) return min;
  if (!Number.isFinite(maxNoteCount) || maxNoteCount <= 0) return min;
  const ratio = noteCount / maxNoteCount;
  const radius = min + ratio * (max - min);
  if (!Number.isFinite(radius)) return min;
  return Math.max(min, Math.min(max, radius));
}

export function truncateReadingMapTitle(title: string, max = 18): string {
  if (!title) return "";
  if (title.length <= max) return title;
  return title.slice(0, Math.max(1, max - 1)) + "…";
}

export function getReadingMapNodeLayout(args: {
  books: ReadonlyArray<WereadReadingMapBook>;
  viewBoxWidth?: number;
  viewBoxHeight?: number;
}): NodeLayout[] {
  const width = args.viewBoxWidth ?? NETWORK_VIEWBOX_WIDTH;
  const height = args.viewBoxHeight ?? NETWORK_VIEWBOX_HEIGHT;
  const cx = width / 2;
  const cy = height / 2;
  const maxRadius = Math.min(width, height) / 2 - NETWORK_PADDING - RADIUS_LIMITS.MAX;
  const innerRadius = Math.max(40, Math.min(maxRadius, maxRadius - 40));

  const books = [...args.books];
  const total = books.length;
  if (total === 0) return [];

  // Two concentric rings: top half on inner ring, bottom half on outer ring.
  const innerSlots = Math.max(1, Math.ceil(total / 2));
  const outerSlots = total - innerSlots;

  const maxNoteCount = books.reduce((acc, b) => Math.max(acc, b.noteCount), 0);
  const nodes: NodeLayout[] = [];
  for (let i = 0; i < total; i++) {
    const book = books[i];
    const ringIndex = i < innerSlots ? 0 : 1;
    const ringSlot = ringIndex === 0 ? i : i - innerSlots;
    const slotCount = ringIndex === 0 ? innerSlots : outerSlots;
    // Place rings at 12 o'clock → clockwise so ordering matches index order.
    const angleStart = -Math.PI / 2;
    const angleStep = (Math.PI * 2) / Math.max(1, slotCount);
    const angle = angleStart + ringSlot * angleStep + fnv1a(book.catalogId) * 0.0001; // tiny deterministic offset
    const radius = ringIndex === 0 ? innerRadius : maxRadius;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    nodes.push({
      catalogId: book.catalogId,
      title: book.title ?? "",
      author: book.author ?? null,
      noteCount: book.noteCount,
      activeMonths: book.activeMonths,
      x,
      y,
      radius: getReadingMapNodeRadius(book.noteCount, maxNoteCount),
      ringIndex,
      ringSlot,
      isSession: false,
      isDimmed: false,
    });
  }
  return nodes;
}

export function buildReadingMapNodeLayout(args: {
  books: ReadonlyArray<WereadReadingMapBook>;
}): NodeLayout[] {
  return getReadingMapNodeLayout(args);
}

/**
 * S27H-2 — Decorate a set of node layouts with session-overlay flags.
 *
 * Pure: never mutates input nodes. When the overlay is disabled, every
 * `isSession` stays false and `isDimmed` stays false, so the rest of
 * the SVG layer doesn't need to special-case the disabled state.
 */
export function annotateSessionNodes(
  nodes: ReadonlyArray<NodeLayout>,
  overlay: WereadSessionThemeOverlay
): NodeLayout[] {
  if (!overlay.enabled || overlay.catalogIds.length === 0) {
    return nodes.map((n) => ({ ...n, isSession: false, isDimmed: false }));
  }
  const set = new Set(overlay.catalogIds);
  return nodes.map((n) => ({
    ...n,
    isSession: set.has(n.catalogId),
    isDimmed: false,
  }));
}

/**
 * S27H-2 — Decorate a set of edge layouts with session-overlay flags.
 * Pure: never mutates input edges.
 */
export function annotateSessionEdges(
  edges: ReadonlyArray<EdgeLayout>,
  overlay: WereadSessionThemeOverlay
): EdgeLayout[] {
  if (!overlay.enabled || overlay.catalogIds.length === 0) {
    return edges.map((e) => ({ ...e, isSessionRelated: false, isDimmed: false }));
  }
  const set = new Set(overlay.catalogIds);
  return edges.map((e) => ({
    ...e,
    isSessionRelated: set.has(e.sourceCatalogId) || set.has(e.targetCatalogId),
    isDimmed: false,
  }));
}

/**
 * S27H-2 — Apply the focus toggle. In "full" mode, nothing is dimmed.
 * In "session" mode, non-session nodes/edges get `isDimmed: true`.
 */
export function applySessionFocus<
  T extends { isDimmed: boolean; isSession?: boolean; isSessionRelated?: boolean },
>(
  items: ReadonlyArray<T>,
  mode: "full" | "session",
  overlay: WereadSessionThemeOverlay
): T[] {
  if (mode === "full" || !overlay.enabled || overlay.catalogIds.length === 0) {
    return items.map((it) => ({ ...it, isDimmed: false }));
  }
  return items.map((it) => {
    const isInSession =
      "isSession" in it ? it.isSession === true : "isSessionRelated" in it ? it.isSessionRelated === true : false;
    return { ...it, isDimmed: !isInSession };
  });
}

export function buildReadingMapEdgeLayout(args: {
  links: ReadonlyArray<WereadReadingMapLink>;
  nodes: ReadonlyArray<NodeLayout>;
}): EdgeLayout[] {
  const nodeMap = new Map<string, NodeLayout>();
  for (const n of args.nodes) nodeMap.set(n.catalogId, n);
  const edges: EdgeLayout[] = [];
  for (const link of args.links) {
    const a = nodeMap.get(link.sourceCatalogId);
    const b = nodeMap.get(link.targetCatalogId);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    edges.push({
      sourceCatalogId: link.sourceCatalogId,
      targetCatalogId: link.targetCatalogId,
      sharedMonths: link.sharedMonths,
      weight: link.weight,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      midX: (a.x + b.x) / 2,
      midY: (a.y + b.y) / 2,
      length,
      isSessionRelated: false,
      isDimmed: false,
    });
  }
  return edges;
}

export function getReadingMapLinkLabel(link: WereadReadingMapLink): string {
  const m = link.sharedMonths ?? 0;
  return m <= 1 ? "共同活跃 1 个月" : `共同活跃 ${m} 个月`;
}

export function hasReadingMapData(response: WereadReadingMapResponse | null | undefined): boolean {
  if (!response || !response.overview) return false;
  return response.overview.matchedNoteRecordsCount > 0 || response.timeline.some((b) => b.total > 0);
}

// ---------- empty / error helpers ----------

export const READING_MAP_VIEWBOX = {
  timeline: { width: TIMELINE_VIEWBOX_WIDTH, height: TIMELINE_VIEWBOX_HEIGHT },
  network: { width: NETWORK_VIEWBOX_WIDTH, height: NETWORK_VIEWBOX_HEIGHT },
} as const;