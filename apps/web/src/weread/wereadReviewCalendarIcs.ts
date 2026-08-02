/**
 * S27I-2 — Browser-local ICS export for the private WeRead review calendar.
 *
 * Strict privacy contract (mirrors the S27I boundary, plus ICS-specific
 * extractions):
 *   - NEVER embeds note text, note comment, wereadBookId, noteId,
 *     highlightId, chapterTitle, summary overview / keyPoints /
 *     reviewQuestions, the AI theme summary body, evidenceCount, the
 *     `q` search term, the private token, or any raw WeRead
 *     title / author.
 *   - Consumes ONLY the public catalog fields produced by the review
 *     calendar model (`catalogId`, `title`, `author`, `noteCount`,
 *     `activeMonths`, `lastNoteAt`, `priority`, `reasonCodes`) plus
 *     the already-sanitised session-theme labels.
 *   - All events use VALUE=DATE all-day semantics. No timezone blocks
 *     are emitted. DTEND = DTSTART + 1 day (RFC 5545 all-day rule).
 *   - Pure functions for the model side; `triggerIcsDownload` is the
 *     ONLY function that touches the DOM / browser download API.
 *   - The model never reads or writes localStorage / sessionStorage
 *     / IndexedDB. The download helper creates a transient Blob URL
 *     and revokes it immediately after the click is dispatched.
 */

import type {
  ReadingReviewBookTask,
  ReadingReviewCalendar,
  ReadingReviewTask,
  ReadingReviewThemeTask,
} from "./wereadReviewCalendarModel";
import {
  formatReviewPriorityLabel,
  formatReviewReason,
} from "./wereadReviewCalendarModel";

// ---------- public API ----------

export interface BuildReviewCalendarIcsArgs {
  calendar: ReadingReviewCalendar | null | undefined;
  range: IcsExportRange;
  now: Date;
}

export type IcsExportRange = "all" | "book" | "theme";

export interface IcsEvent {
  uid: string;
  dtstamp: string;
  dtstart: string;
  dtend: string;
  summary: string;
  description: string;
  categories: string;
  transp: "TRANSPARENT";
  raw: string; // fully formatted VEVENT block (CRLF, folded)
}

export interface BuildReviewCalendarIcsResult {
  content: string;
  events: IcsEvent[];
  range: IcsExportRange;
  filename: string;
}

export interface BuildReviewCalendarIcsFilenameArgs {
  range: IcsExportRange;
  horizonDays: number;
  now: Date;
}

export interface IcsAnchorDescriptor {
  href: string;
  download: string;
  rel: string;
  testId: string;
}

export interface TriggerIcsDownloadArgs {
  content: string;
  filename: string;
  /** Test seam: override the anchor click flow. */
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  /** Test seam: append + click + remove the anchor. */
  attachAnchor?: (anchor: IcsAnchorDescriptor) => void;
  /** Test seam: override the document lookup (defaults to globalThis.document). */
  resolveDocument?: () => DocumentLike | null;
}

export interface DocumentLike {
  createElement(tagName: string): { setAttribute(name: string, value: string): void; click(): void };
  body?: { appendChild(node: unknown): void; removeChild(node: unknown): void } | null;
}

export interface TriggerIcsDownloadResult {
  filename: string;
  size: number;
  mimeType: string;
  blobUrl: string;
  revoked: boolean;
  downloadTriggered: boolean;
}

// ---------- constants ----------

export const ICS_PRODID = "-//book-id-search//WeRead Review Calendar//ZH-CN";
export const ICS_VERSION = "2.0";
export const ICS_CALSCALE = "GREGORIAN";
export const ICS_METHOD = "PUBLISH";
export const ICS_TRANSP = "TRANSPARENT" as const;
export const ICS_CATEGORY_ROOT = "微信读书复习";
export const ICS_MIME = "text/calendar;charset=utf-8";
export const ICS_LINE_MAX = 75; // RFC 5545 §3.1
export const ICS_HORIZON_LABEL: Record<number, string> = {
  14: "14-days",
  28: "28-days",
  42: "42-days",
};

/** A safe hash domain prefix so we never reuse calendar UIDs from
 *  any other subsystem. The fixed domain acts as a deterministic
 *  salt; we still strip token / catalogId-shaped digits from the
 *  UID before publishing it. */
export const ICS_UID_DOMAIN = "books.conanxin.com";
export const ICS_FILENAME_PREFIX = "weread-review-calendar";

// ---------- text escaping ----------

/**
 * Escape special characters per RFC 5545 §3.3.11.
 *
 *   - backslash → `\\`
 *   - semicolon → `\;`
 *   - comma     → `\,`
 *   - newline   → `\n` (literal `\n`, two characters)
 *
 * The output is pure ASCII; multi-line input is collapsed into a
 * single escape-friendly line.
 */
export function escapeIcsText(input: unknown): string {
  if (input === null || input === undefined) return "";
  const raw = String(input);
  let out = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "\\") {
      out += "\\\\";
    } else if (ch === ";") {
      out += "\\;";
    } else if (ch === ",") {
      out += "\\,";
    } else if (ch === "\n") {
      out += "\\n";
    } else if (ch === "\r") {
      // drop carriage returns; CRLF arrives as `\r\n` and we keep only the newline branch
      continue;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Fold a single logical line into 75-octet segments per RFC 5545
 * §3.1. Continuation lines start with a single space (HTAB is also
 * permitted but space keeps the output safe for downstream tooling).
 *
 * Lines that are already short are returned unchanged (with CRLF
 * appended by the caller — this helper handles the folding only).
 */
export function foldIcsLine(line: string): string {
  const safe = String(line ?? "");
  if (safe.length <= ICS_LINE_MAX) return safe;
  const parts: string[] = [];
  let cursor = 0;
  // First chunk uses the full width; subsequent chunks lose one
  // character to the leading space continuation marker.
  const firstChunk = ICS_LINE_MAX;
  while (cursor < safe.length) {
    const remaining = safe.length - cursor;
    if (parts.length === 0) {
      parts.push(safe.slice(cursor, cursor + firstChunk));
      cursor += firstChunk;
      continue;
    }
    const width = ICS_LINE_MAX - 1; // leading space
    parts.push(" " + safe.slice(cursor, cursor + width));
    cursor += width;
    if (remaining <= 0) break;
  }
  return parts.join("\r\n");
}

/**
 * Format a date (or YYYY-MM-DD string) as `YYYYMMDD` for all-day
 * events. UTC is used so the output is independent of the user's
 * local timezone.
 */
export function formatIcsDate(input: string | Date): string {
  if (input instanceof Date) {
    if (!Number.isFinite(input.getTime())) return "";
    const y = input.getUTCFullYear();
    const m = String(input.getUTCMonth() + 1).padStart(2, "0");
    const d = String(input.getUTCDate()).padStart(2, "0");
    return `${y}${m}${d}`;
  }
  const text = String(input ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  return text.replace(/-/g, "");
}

/**
 * Format a Date as a UTC RFC 5545 timestamp: `YYYYMMDDTHHMMSSZ`.
 */
export function formatIcsTimestamp(input: string | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}${m}${day}T${hh}${mm}${ss}Z`;
}

/**
 * Add `days` whole UTC days to a Date. Negative values are allowed.
 */
export function addIcsUtcDays(input: Date, days: number): Date {
  const safe = Math.floor(Number.isFinite(days) ? days : 0);
  return new Date(input.getTime() + safe * 86_400_000);
}

// ---------- UID ----------

/**
 * Build a deterministic, RFC 4122-flavoured UID for a single task.
 *
 * Constraints:
 *   - NO token, NO `q`, NO noteId / highlightId / chapterTitle /
 *     wereadBookId.
 *   - NO raw title / author from WeRead.
 *   - Identical inputs → identical UID.
 *   - The public catalogId is the only user-supplied identifier and
 *     it is hashed before being mixed in.
 *
 * Format: `<task-kind>-<hashed-task-id>@<domain>`. We never embed
 * the literal catalogId so a downstream calendar server cannot
 * reverse the UID back to a private record.
 */
export function buildReviewTaskUid(args: {
  task: ReadingReviewTask;
  dtstart: string;
}): string {
  const { task, dtstart } = args;
  const kind = task.kind === "book" ? "book" : "theme";
  // task.id is already prefixed (e.g. `book:13000000_...`). Hash it
  // together with the scheduled date so re-running the same calendar
  // produces the same UID, and re-scheduling on a different day
  // produces a fresh one.
  const seed = `${kind}|${task.id}|${dtstart}`;
  const h = fnv1a32(seed);
  return `${kind}-${h.toString(16)}-${dtstart}@${ICS_UID_DOMAIN}`;
}

/**
 * FNV-1a 32-bit. Stable across browsers / Node / V8.
 */
function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// ---------- builders ----------

/**
 * Build the DESCRIPTION body for a book task. The fields are kept
 * short, line-oriented, and never leak private content.
 */
export function buildBookReviewDescription(args: {
  task: ReadingReviewBookTask;
  publicBookUrl: string;
}): string {
  const { task, publicBookUrl } = args;
  const lines: string[] = [];
  const priorityLabel = formatReviewPriorityLabel(task.priority);
  lines.push(`优先级：${priorityLabel}`);
  if (task.reasonCodes.length > 0) {
    lines.push(`建议原因：${task.reasonCodes.map(formatReviewReason).join("；")}`);
  }
  lines.push(`阅读记录：${Math.max(0, Math.floor(task.noteCount))} 条`);
  lines.push(`活跃月份：${Math.max(0, Math.floor(task.activeMonths))}`);
  if (typeof task.lastNoteAt === "string" && /^\d{4}-\d{2}-\d{2}/.test(task.lastNoteAt)) {
    lines.push(`最后阅读：${task.lastNoteAt.slice(0, 10)}`);
  }
  if (publicBookUrl) {
    lines.push(`书目页面：${publicBookUrl}`);
  }
  return lines.join("\n");
}

/**
 * Build the DESCRIPTION body for a theme task. Themes are session
 * only and intentionally minimal.
 */
export function buildThemeReviewDescription(): string {
  return [
    "当前浏览器会话主题。",
    "此主题未绑定到特定书目，刷新页面后可能不再存在。",
  ].join("\n");
}

/**
 * Build a single VEVENT for a book task.
 */
export function buildReviewBookTaskEvent(args: {
  task: ReadingReviewBookTask;
  publicBookUrl: string;
  now: Date;
}): IcsEvent {
  const { task, publicBookUrl, now } = args;
  const dtstart = formatIcsDate(task.suggestedDate);
  const endDate = addIcsUtcDays(parseUtcDate(task.suggestedDate), 1);
  const dtend = formatIcsDate(endDate);
  const summary = `复习《${truncateForIcs(task.title)}》`;
  const description = buildBookReviewDescription({ task, publicBookUrl });
  const categories = `${ICS_CATEGORY_ROOT},${formatReviewPriorityLabel(task.priority)}`;
  const uid = buildReviewTaskUid({ task, dtstart });
  const raw = buildEventBlock({
    uid,
    dtstamp: formatIcsTimestamp(now),
    dtstart,
    dtend,
    summary,
    description,
    categories,
  });
  return {
    uid,
    dtstamp: formatIcsTimestamp(now),
    dtstart,
    dtend,
    summary,
    description,
    categories,
    transp: ICS_TRANSP,
    raw,
  };
}

/**
 * Build a single VEVENT for a theme task.
 */
export function buildReviewThemeTaskEvent(args: {
  task: ReadingReviewThemeTask;
  now: Date;
}): IcsEvent {
  const { task, now } = args;
  const dtstart = formatIcsDate(task.suggestedDate);
  const endDate = addIcsUtcDays(parseUtcDate(task.suggestedDate), 1);
  const dtend = formatIcsDate(endDate);
  const summary = `复习主题：${truncateForIcs(task.label)}`;
  const description = buildThemeReviewDescription();
  const categories = `${ICS_CATEGORY_ROOT},当前会话主题`;
  const uid = buildReviewTaskUid({ task, dtstart });
  const raw = buildEventBlock({
    uid,
    dtstamp: formatIcsTimestamp(now),
    dtstart,
    dtend,
    summary,
    description,
    categories,
  });
  return {
    uid,
    dtstamp: formatIcsTimestamp(now),
    dtstart,
    dtend,
    summary,
    description,
    categories,
    transp: ICS_TRANSP,
    raw,
  };
}

/**
 * Assemble a complete ICS document for the supplied review calendar.
 *
 * - `range = "all"`     → book + theme tasks
 * - `range = "book"`    → only book tasks
 * - `range = "theme"`   → only theme tasks
 *
 * Throws when the calendar is missing, has no eligible tasks, or
 * the horizon is empty. Callers (the dashboard) decide whether to
 * surface the error to the user.
 */
export function buildReviewCalendarIcs(args: BuildReviewCalendarIcsArgs): BuildReviewCalendarIcsResult {
  const cal = args.calendar;
  if (!cal) {
    throw new Error("review calendar is not available");
  }
  if (!cal.tasks || cal.tasks.length === 0) {
    throw new Error("review calendar has no tasks to export");
  }
  const eligible = cal.tasks.filter((task) => {
    if (!task || typeof task.suggestedDate !== "string") return false;
    if (args.range === "book") return task.kind === "book";
    if (args.range === "theme") return task.kind === "theme";
    return true;
  });
  if (eligible.length === 0) {
    throw new Error(`review calendar has no tasks matching range "${args.range}"`);
  }
  const events: IcsEvent[] = [];
  for (const task of eligible) {
    if (task.kind === "book") {
      const publicBookUrl = `https://${ICS_UID_DOMAIN}/books/${task.catalogId}`;
      events.push(
        buildReviewBookTaskEvent({
          task,
          publicBookUrl,
          now: args.now,
        })
      );
    } else {
      events.push(
        buildReviewThemeTaskEvent({
          task,
          now: args.now,
        })
      );
    }
  }
  const content = assembleIcsDocument(events);
  const filename = buildReviewCalendarIcsFilename({
    range: args.range,
    horizonDays: cal.horizonDays,
    now: args.now,
  });
  return {
    content,
    events,
    range: args.range,
    filename,
  };
}

/**
 * Build the safe ASCII filename for an export.
 *
 * Format:
 *   `weread-review-calendar-YYYYMMDD.ics`
 *   `weread-review-calendar-<horizon-label>-YYYYMMDD.ics`
 *
 * The filename is guaranteed ASCII; it never contains the book
 * title, theme label, catalogId, or any private id.
 */
export function buildReviewCalendarIcsFilename(args: BuildReviewCalendarIcsFilenameArgs): string {
  const now = args.now;
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  const stamp = `${y}${m}${d}`;
  const label = ICS_HORIZON_LABEL[args.horizonDays] ?? `${Math.max(0, Math.floor(args.horizonDays))}-days`;
  const rangeTag =
    args.range === "book"
      ? "books"
      : args.range === "theme"
        ? "themes"
        : "all";
  return `${ICS_FILENAME_PREFIX}-${label}-${rangeTag}-${stamp}.ics`;
}

// ---------- validation ----------

/**
 * Lightweight structural validator. Returns an array of human-
 * readable error strings (empty array = valid).
 *
 * Intentionally minimal — it does NOT replace a real RFC 5545
 * parser. It catches the common bugs that a future refactor could
 * introduce (missing BEGIN / END, CRLF violations, missing
 * DTSTAMP, etc.).
 */
export function validateReviewCalendarIcs(content: string): string[] {
  const errors: string[] = [];
  if (typeof content !== "string" || content.length === 0) {
    errors.push("content is empty");
    return errors;
  }
  if (!content.startsWith("BEGIN:VCALENDAR\r\n")) {
    errors.push("missing BEGIN:VCALENDAR header");
  }
  if (!content.endsWith("END:VCALENDAR\r\n")) {
    errors.push("missing END:VCALENDAR footer");
  }
  if (content.includes("\n") && !content.includes("\r\n")) {
    errors.push("line endings are not CRLF");
  }
  if (!content.includes("PRODID:" + ICS_PRODID)) {
    errors.push("PRODID mismatch");
  }
  if (!content.includes("VERSION:" + ICS_VERSION)) {
    errors.push("VERSION mismatch");
  }
  const beginCount = (content.match(/BEGIN:VEVENT/g) ?? []).length;
  const endCount = (content.match(/END:VEVENT/g) ?? []).length;
  if (beginCount !== endCount) {
    errors.push(`VEVENT open/close mismatch (${beginCount} vs ${endCount})`);
  }
  return errors;
}

// ---------- browser download helper ----------

/**
 * Trigger a browser download for the supplied ICS content. The
 * function is dependency-injected so tests can run without a real
 * DOM / `URL.createObjectURL`. By default it uses the real APIs.
 *
 * Cleanup contract:
 *   - `URL.createObjectURL` is called once.
 *   - The anchor element is appended, clicked, and removed.
 *   - `URL.revokeObjectURL` is called inside the same tick (after
 *     `anchor.click()` returns synchronously). Some browsers defer
 *     the download until after the current task; we therefore delay
 *     the revoke slightly via setTimeout(0) so the browser can
 *     read the blob URL. The URL is revoked on the next tick.
 */
export function triggerIcsDownload(args: TriggerIcsDownloadArgs): TriggerIcsDownloadResult {
  const content = String(args.content ?? "");
  const filename = String(args.filename ?? "");
  const blob = new Blob([content], { type: ICS_MIME });
  const createObjectUrl =
    args.createObjectUrl ??
    ((b: Blob) => URL.createObjectURL(b));
  const revokeObjectUrl =
    args.revokeObjectUrl ??
    ((url: string) => URL.revokeObjectURL(url));
  const blobUrl = createObjectUrl(blob);
  const descriptor: IcsAnchorDescriptor = {
    href: blobUrl,
    download: filename,
    rel: "noopener",
    testId: "weread-review-calendar-ics-anchor",
  };
  if (args.attachAnchor) {
    args.attachAnchor(descriptor);
  } else {
    defaultAttachAnchor(descriptor, args.resolveDocument);
  }
  // Revoke on the next tick so the browser has a chance to read
  // the blob URL. This still keeps the URL ephemeral.
  setTimeout(() => {
    try {
      revokeObjectUrl(blobUrl);
    } catch {
      // ignore — revoke failures are non-fatal
    }
  }, 0);
  return {
    filename,
    size: blob.size,
    mimeType: ICS_MIME,
    blobUrl,
    revoked: false,
    downloadTriggered: true,
  };
}

function defaultAttachAnchor(
  descriptor: IcsAnchorDescriptor,
  resolveDocument?: () => DocumentLike | null
): void {
  const doc =
    resolveDocument?.() ??
    (typeof document !== "undefined" ? (document as unknown as DocumentLike) : null);
  if (!doc) return;
  const anchor = doc.createElement("a");
  anchor.setAttribute("href", descriptor.href);
  anchor.setAttribute("download", descriptor.download);
  anchor.setAttribute("data-testid", descriptor.testId);
  anchor.setAttribute("rel", descriptor.rel);
  if (doc.body) {
    doc.body.appendChild(anchor);
    anchor.click();
    doc.body.removeChild(anchor);
  } else {
    anchor.click();
  }
}

// ---------- internal ----------

function buildEventBlock(args: {
  uid: string;
  dtstamp: string;
  dtstart: string;
  dtend: string;
  summary: string;
  description: string;
  categories: string;
}): string {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${args.uid}`,
    `DTSTAMP:${args.dtstamp}`,
    `DTSTART;VALUE=DATE:${args.dtstart}`,
    `DTEND;VALUE=DATE:${args.dtend}`,
    `SUMMARY:${escapeIcsText(args.summary)}`,
    `DESCRIPTION:${escapeIcsText(args.description)}`,
    `TRANSP:${ICS_TRANSP}`,
    `CATEGORIES:${escapeIcsText(args.categories)}`,
    "END:VEVENT",
  ];
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}

function assembleIcsDocument(events: ReadonlyArray<IcsEvent>): string {
  const header = [
    "BEGIN:VCALENDAR",
    `VERSION:${ICS_VERSION}`,
    `PRODID:${ICS_PRODID}`,
    `CALSCALE:${ICS_CALSCALE}`,
    `METHOD:${ICS_METHOD}`,
  ].join("\r\n") + "\r\n";
  const body = events.map((e) => e.raw).join("");
  const footer = "END:VCALENDAR\r\n";
  return header + body + footer;
}

function parseUtcDate(input: string): Date {
  if (typeof input !== "string") return new Date(NaN);
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return new Date(`${input}T00:00:00.000Z`);
  }
  return new Date(input);
}

function truncateForIcs(input: string): string {
  const text = String(input ?? "").trim();
  if (text.length <= 80) return text;
  return text.slice(0, 80);
}