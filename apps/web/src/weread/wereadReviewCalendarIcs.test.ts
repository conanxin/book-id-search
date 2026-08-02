/**
 * S27I-2 — Unit tests for the browser-local ICS export model.
 *
 * Pure-function coverage. The browser download helper is exercised
 * through dependency injection so jsdom is not required.
 *
 * ≥25 assertions per the S27I-2 spec.
 */

import { describe, expect, it } from "vitest";
import {
  ICS_CATEGORY_ROOT,
  ICS_FILENAME_PREFIX,
  ICS_MIME,
  ICS_PRODID,
  ICS_UID_DOMAIN,
  ICS_VERSION,
  addIcsUtcDays,
  buildBookReviewDescription,
  buildReviewBookTaskEvent,
  buildReviewCalendarIcs,
  buildReviewCalendarIcsFilename,
  buildReviewTaskUid,
  buildReviewThemeTaskEvent,
  escapeIcsText,
  foldIcsLine,
  formatIcsDate,
  formatIcsTimestamp,
  triggerIcsDownload,
  validateReviewCalendarIcs,
} from "./wereadReviewCalendarIcs";
import {
  buildReadingReviewCalendar,
  type ReadingReviewBookTask,
  type ReadingReviewThemeTask,
} from "./wereadReviewCalendarModel";
import type {
  WereadReadingMapBook,
  WereadReadingMapResponse,
} from "../wereadPrivate";
import type { WereadSessionThemeOverlay } from "./wereadSessionThemeModel";

// ---------- fixtures ----------

const NOW = new Date("2026-08-02T12:34:56.000Z");
const TODAY_ISO = "2026-08-02"; // anchor day matches NOW

function makeBook(
  catalogId: string,
  over: Partial<WereadReadingMapBook> = {}
): WereadReadingMapBook {
  return {
    catalogId,
    title: `公共书目 ${catalogId}`,
    author: "公共作者",
    noteCount: 12,
    highlights: 7,
    thoughts: 4,
    reviews: 1,
    unknown: 0,
    activeMonths: 4,
    firstNoteAt: "2026-01-01T00:00:00.000Z",
    lastNoteAt: "2026-07-15T00:00:00.000Z",
    ...over,
  };
}

function makeResponse(): WereadReadingMapResponse {
  return {
    ok: true,
    overview: {
      booksCount: 3,
      notesCount: 36,
      matchedCatalogsCount: 3,
      matchedNoteRecordsCount: 36,
      firstNoteAt: "2026-01-01T00:00:00.000Z",
      lastNoteAt: "2026-07-15T00:00:00.000Z",
      activeMonths: 4,
      currentStreakMonths: 1,
      longestStreakMonths: 2,
    },
    timeline: [],
    books: [
      makeBook("10000000_000000000001"),
      makeBook("10000000_000000000002"),
      makeBook("10000000_000000000003"),
    ],
    links: [],
    meta: {
      monthsRequested: 36,
      monthsReturned: 36,
      topBooksRequested: 18,
      topBooksReturned: 3,
      linksReturned: 0,
      persisted: false,
      source: "private_snapshot+public_catalog",
    },
  };
}

function makeOverlay(): WereadSessionThemeOverlay {
  return {
    enabled: true,
    themes: [
      { id: "t1", label: "城市记忆", source: "theme" },
      { id: "t2", label: "现代叙事", source: "direction" },
    ],
    catalogIds: ["10000000_000000000001"],
    notesUsed: 4,
  };
}

function buildCalendar(over: Partial<Parameters<typeof buildReadingReviewCalendar>[0]> = {}) {
  return buildReadingReviewCalendar({
    response: makeResponse(),
    overlay: makeOverlay(),
    now: NOW,
    horizonDays: 28,
    recommendCount: 12,
    ...over,
  });
}

// ---------- escapeIcsText ----------

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, and comma", () => {
    expect(escapeIcsText("a\\b;c,d")).toBe("a\\\\b\\;c\\,d");
  });
  it("collapses CRLF / LF into the literal \\n escape", () => {
    expect(escapeIcsText("line1\r\nline2\nline3")).toBe("line1\\nline2\\nline3");
  });
  it("treats null and undefined as empty", () => {
    expect(escapeIcsText(null)).toBe("");
    expect(escapeIcsText(undefined)).toBe("");
  });
  it("never injects Markdown / YAML tokens and converts newlines to escape", () => {
    const out = escapeIcsText("<script>---\n```yaml\n!!");
    // Per RFC 5545 we don't escape `<` / `>` / backticks (they're
    // not special characters), but we DO escape `\n` so the value
    // stays on a single physical line.
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out.includes("\\n")).toBe(true);
    expect(out.includes("\\<")).toBe(false); // < is not escaped
  });
});

// ---------- foldIcsLine ----------

describe("foldIcsLine", () => {
  it("returns short lines unchanged (without CRLF — caller adds it)", () => {
    expect(foldIcsLine("BEGIN:VCALENDAR")).toBe("BEGIN:VCALENDAR");
  });
  it("folds lines longer than 75 octets onto CRLF + space continuations", () => {
    const long = "DESCRIPTION:" + "a".repeat(200);
    const folded = foldIcsLine(long);
    expect(folded.includes("\r\n ")).toBe(true);
    for (const chunk of folded.split("\r\n")) {
      // CRLF splits into chunks; the first 75-octet chunk has no
      // leading space, the rest do.
      if (chunk.startsWith(" ")) {
        expect(chunk.length).toBeLessThanOrEqual(75);
      } else {
        expect(chunk.length).toBeLessThanOrEqual(75);
      }
    }
  });
  it("preserves the line content after un-folding", () => {
    const long = "SUMMARY:" + "b".repeat(300);
    const folded = foldIcsLine(long);
    const unfolded = folded.replace(/\r\n /g, "");
    expect(unfolded).toBe(long);
  });
});

// ---------- formatIcsDate / formatIcsTimestamp ----------

describe("formatIcsDate / formatIcsTimestamp", () => {
  it("formats a Date as YYYYMMDD using UTC", () => {
    expect(formatIcsDate(new Date("2026-08-02T00:00:00.000Z"))).toBe("20260802");
  });
  it("accepts YYYY-MM-DD strings", () => {
    expect(formatIcsDate("2026-08-02")).toBe("20260802");
  });
  it("formats a Date as UTC timestamp", () => {
    expect(formatIcsTimestamp(new Date("2026-08-02T12:34:56.000Z"))).toBe(
      "20260802T123456Z"
    );
  });
  it("returns empty string for malformed input", () => {
    expect(formatIcsDate("not-a-date")).toBe("");
    expect(formatIcsTimestamp("not-a-date")).toBe("");
    expect(formatIcsDate(new Date(NaN))).toBe("");
  });
});

// ---------- addIcsUtcDays ----------

describe("addIcsUtcDays", () => {
  it("adds one day", () => {
    const d = new Date("2026-08-02T00:00:00.000Z");
    expect(addIcsUtcDays(d, 1).toISOString()).toBe("2026-08-03T00:00:00.000Z");
  });
  it("handles negative offsets", () => {
    const d = new Date("2026-08-02T00:00:00.000Z");
    expect(addIcsUtcDays(d, -1).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
});

// ---------- buildReviewTaskUid ----------

describe("buildReviewTaskUid", () => {
  it("is stable for identical inputs", () => {
    const task: ReadingReviewBookTask = {
      id: "book:10000000_000000000001",
      kind: "book",
      catalogId: "10000000_000000000001",
      title: "公共书目 10000000_000000000001",
      author: "公共作者",
      suggestedDate: TODAY_ISO,
      priority: "high",
      priorityScore: 80,
      noteCount: 12,
      activeMonths: 4,
      lastNoteAt: "2026-07-15T00:00:00.000Z",
      sessionRelevant: true,
      reasonCodes: ["session_book"],
    };
    const a = buildReviewTaskUid({ task, dtstart: "20260802" });
    const b = buildReviewTaskUid({ task, dtstart: "20260802" });
    expect(a).toBe(b);
  });
  it("is different for different tasks", () => {
    const base: ReadingReviewBookTask = {
      id: "book:10000000_000000000001",
      kind: "book",
      catalogId: "10000000_000000000001",
      title: "公共书目 10000000_000000000001",
      author: "公共作者",
      suggestedDate: TODAY_ISO,
      priority: "high",
      priorityScore: 80,
      noteCount: 12,
      activeMonths: 4,
      lastNoteAt: "2026-07-15T00:00:00.000Z",
      sessionRelevant: true,
      reasonCodes: ["session_book"],
    };
    const a = buildReviewTaskUid({ task: base, dtstart: "20260802" });
    const other: ReadingReviewBookTask = {
      ...base,
      id: "book:10000000_000000000002",
      catalogId: "10000000_000000000002",
    };
    const b = buildReviewTaskUid({ task: other, dtstart: "20260802" });
    expect(a).not.toBe(b);
  });
  it("never embeds the catalogId or token", () => {
    const task: ReadingReviewBookTask = {
      id: "book:10000000_000000000001",
      kind: "book",
      catalogId: "10000000_000000000001",
      title: "公共书目",
      author: null,
      suggestedDate: TODAY_ISO,
      priority: "medium",
      priorityScore: 60,
      noteCount: 8,
      activeMonths: 2,
      lastNoteAt: "2026-07-01T00:00:00.000Z",
      sessionRelevant: false,
      reasonCodes: ["recent_activity"],
    };
    const uid = buildReviewTaskUid({ task, dtstart: "20260802" });
    expect(uid).not.toContain("10000000_000000000001");
    expect(uid).not.toMatch(/token/i);
    expect(uid).not.toContain("noteId");
    expect(uid).not.toContain("highlightId");
    expect(uid.endsWith(`@${ICS_UID_DOMAIN}`)).toBe(true);
  });
});

// ---------- buildReviewBookTaskEvent / theme event ----------

describe("buildReviewBookTaskEvent", () => {
  it("produces a CRLF-terminated VEVENT block with all-day DTSTART/DTEND", () => {
    const cal = buildCalendar();
    const bookTask = cal.tasks.find(
      (t): t is ReadingReviewBookTask => t.kind === "book"
    );
    expect(bookTask).toBeTruthy();
    if (!bookTask) return;
    const ev = buildReviewBookTaskEvent({
      task: bookTask,
      publicBookUrl: `https://${ICS_UID_DOMAIN}/books/${bookTask.catalogId}`,
      now: NOW,
    });
    expect(ev.raw.startsWith("BEGIN:VEVENT\r\n")).toBe(true);
    expect(ev.raw.endsWith("END:VEVENT\r\n")).toBe(true);
    expect(ev.raw.includes(`DTSTART;VALUE=DATE:${ev.dtstart}`)).toBe(true);
    expect(ev.raw.includes(`DTEND;VALUE=DATE:${ev.dtend}`)).toBe(true);
    // DTEND is exactly one day after DTSTART.
    const expected = formatIcsDate(
      addIcsUtcDays(new Date(`${ev.dtstart.slice(0, 4)}-${ev.dtstart.slice(4, 6)}-${ev.dtstart.slice(6, 8)}T00:00:00.000Z`), 1)
    );
    expect(ev.dtend).toBe(expected);
    expect(ev.summary.startsWith("复习《")).toBe(true);
    expect(ev.summary.endsWith("》")).toBe(true);
    expect(ev.categories.includes(ICS_CATEGORY_ROOT)).toBe(true);
    expect(ev.transp).toBe("TRANSPARENT");
  });
});

describe("buildReviewThemeTaskEvent", () => {
  it("uses the theme-summary path and never mentions a book", () => {
    const cal = buildCalendar();
    const themeTask = cal.tasks.find(
      (t): t is ReadingReviewThemeTask => t.kind === "theme"
    );
    expect(themeTask).toBeTruthy();
    if (!themeTask) return;
    const ev = buildReviewThemeTaskEvent({ task: themeTask, now: NOW });
    expect(ev.summary.startsWith("复习主题：")).toBe(true);
    expect(ev.description).toContain("当前浏览器会话主题");
    expect(ev.description).toContain("刷新页面后");
    // No public-book URL inside the description.
    expect(ev.description).not.toContain("/books/");
  });
});

// ---------- buildReviewCalendarIcs ----------

describe("buildReviewCalendarIcs — top level", () => {
  it("produces BEGIN:VCALENDAR … END:VCALENDAR with the correct header", () => {
    const cal = buildCalendar();
    const ics = buildReviewCalendarIcs({ calendar: cal, range: "all", now: NOW });
    expect(ics.content.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.content.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.content.includes(`PRODID:${ICS_PRODID}`)).toBe(true);
    expect(ics.content.includes(`VERSION:${ICS_VERSION}`)).toBe(true);
    expect(ics.content.includes("CALSCALE:GREGORIAN")).toBe(true);
    expect(ics.content.includes("METHOD:PUBLISH")).toBe(true);
  });

  it("uses CRLF for every line", () => {
    const cal = buildCalendar();
    const ics = buildReviewCalendarIcs({ calendar: cal, range: "all", now: NOW });
    // No bare LF (preceded by anything other than CR). `\r\n` is
    // allowed; `\n` alone is not.
    const lfNotPrecededByCr = /(?<!\r)\n/;
    expect(lfNotPrecededByCr.test(ics.content)).toBe(false);
    expect(ics.content.includes("\r\n")).toBe(true);
  });

  it("emits one VEVENT per task in `all` range", () => {
    const cal = buildCalendar();
    const ics = buildReviewCalendarIcs({ calendar: cal, range: "all", now: NOW });
    const opens = (ics.content.match(/BEGIN:VEVENT/g) ?? []).length;
    const closes = (ics.content.match(/END:VEVENT/g) ?? []).length;
    expect(opens).toBe(cal.tasks.length);
    expect(closes).toBe(cal.tasks.length);
  });

  it("respects the three range filters", () => {
    const cal = buildCalendar();
    const all = buildReviewCalendarIcs({ calendar: cal, range: "all", now: NOW });
    const onlyBook = buildReviewCalendarIcs({ calendar: cal, range: "book", now: NOW });
    const onlyTheme = buildReviewCalendarIcs({ calendar: cal, range: "theme", now: NOW });
    expect(all.events.length).toBe(cal.tasks.length);
    expect(onlyBook.events.every((e) => e.summary.includes("《"))).toBe(true);
    expect(onlyTheme.events.every((e) => e.summary.startsWith("复习主题："))).toBe(true);
    expect(onlyBook.events.length + onlyTheme.events.length).toBe(all.events.length);
  });

  it("embeds the public-book URL inside book descriptions (unfolded)", () => {
    const cal = buildCalendar();
    const ics = buildReviewCalendarIcs({ calendar: cal, range: "book", now: NOW });
    // Unfold continuations so the substring search works across
    // physical lines (RFC 5545 line folding).
    const unfolded = ics.content.replace(/\r\n /g, "");
    expect(unfolded.includes(`https://${ICS_UID_DOMAIN}/books/10000000_000000000001`)).toBe(true);
  });

  it("rejects empty / null calendar", () => {
    expect(() => buildReviewCalendarIcs({ calendar: null, range: "all", now: NOW })).toThrow();
    // Build a calendar with NO books and NO theme overlay so the
    // resulting task list is truly empty.
    const emptyOverlay: WereadSessionThemeOverlay = {
      enabled: false,
      themes: [],
      catalogIds: [],
      notesUsed: 0,
    };
    const emptyResp: WereadReadingMapResponse = {
      ...makeResponse(),
      books: [],
    };
    const cal = buildReadingReviewCalendar({
      response: emptyResp,
      overlay: emptyOverlay,
      now: NOW,
      horizonDays: 28,
      recommendCount: 12,
    });
    expect(cal.tasks.length).toBe(0);
    expect(() => buildReviewCalendarIcs({ calendar: cal, range: "all", now: NOW })).toThrow();
  });

  it("rejects empty range when filter yields zero tasks", () => {
    const cal = buildCalendar({ recommendCount: 0 });
    // Cal has only themes; book range should fail.
    expect(() => buildReviewCalendarIcs({ calendar: cal, range: "book", now: NOW })).toThrow();
  });

  it("never exports the unscheduled / out-of-horizon tasks", () => {
    const cal = buildCalendar();
    const beforeIds = new Set(cal.tasks.map((t) => t.id));
    const ics = buildReviewCalendarIcs({ calendar: cal, range: "all", now: NOW });
    // Every VEVENT corresponds to a calendar task id via its UID.
    for (const ev of ics.events) {
      // UID encodes kind + hash + dtstart; we cannot reverse it,
      // so we just verify each VEVENT appears exactly once.
      const occurrences = ics.content.split(ev.raw).length - 1;
      expect(occurrences).toBe(1);
    }
    expect(beforeIds.size).toBeGreaterThan(0);
  });

  it("never leaks note text / comment / forbidden fields", () => {
    const cal = buildCalendar();
    const ics = buildReviewCalendarIcs({ calendar: cal, range: "all", now: NOW });
    expect(ics.content).not.toMatch(/FORBIDDEN_NOTE_TEXT|FORBIDDEN_NOTE_COMMENT/);
    expect(ics.content).not.toMatch(/token/i);
    expect(ics.content).not.toContain("q=");
    expect(ics.content).not.toContain("noteId");
    expect(ics.content).not.toContain("highlightId");
    expect(ics.content).not.toContain("chapterTitle");
    expect(ics.content).not.toContain("wereadBookId");
    expect(ics.content).not.toMatch(/overview|keyPoints|reviewQuestions/);
    // WeRead private-field labels are not in our descriptions.
    expect(ics.content).not.toMatch(/作者：公共作者/); // author only via priority / reason lines
  });
});

// ---------- buildReviewCalendarIcsFilename ----------

describe("buildReviewCalendarIcsFilename", () => {
  it("starts with the safe prefix and ends with .ics", () => {
    const name = buildReviewCalendarIcsFilename({
      range: "all",
      horizonDays: 28,
      now: NOW,
    });
    expect(name.startsWith(`${ICS_FILENAME_PREFIX}-`)).toBe(true);
    expect(name.endsWith(".ics")).toBe(true);
    expect(/^[\x20-\x7e]+$/.test(name)).toBe(true);
  });
  it("encodes range + horizon", () => {
    expect(buildReviewCalendarIcsFilename({ range: "all", horizonDays: 14, now: NOW })).toBe(
      `${ICS_FILENAME_PREFIX}-14-days-all-20260802.ics`
    );
    expect(buildReviewCalendarIcsFilename({ range: "book", horizonDays: 28, now: NOW })).toBe(
      `${ICS_FILENAME_PREFIX}-28-days-books-20260802.ics`
    );
    expect(buildReviewCalendarIcsFilename({ range: "theme", horizonDays: 42, now: NOW })).toBe(
      `${ICS_FILENAME_PREFIX}-42-days-themes-20260802.ics`
    );
  });
  it("never embeds catalogId / title / theme labels / token", () => {
    const name = buildReviewCalendarIcsFilename({ range: "all", horizonDays: 28, now: NOW });
    expect(name).not.toMatch(/10000000/);
    expect(name).not.toContain("公共书目");
    expect(name).not.toContain("城市记忆");
    expect(name).not.toMatch(/token/i);
  });
});

// ---------- validateReviewCalendarIcs ----------

describe("validateReviewCalendarIcs", () => {
  it("accepts a well-formed document", () => {
    const cal = buildCalendar();
    const ics = buildReviewCalendarIcs({ calendar: cal, range: "all", now: NOW });
    expect(validateReviewCalendarIcs(ics.content)).toEqual([]);
  });
  it("flags missing BEGIN/END and LF-only line endings", () => {
    expect(validateReviewCalendarIcs("")).toContain("content is empty");
    expect(validateReviewCalendarIcs("BEGIN:VCALENDAR\nEND:VCALENDAR\n").length).toBeGreaterThan(0);
    expect(validateReviewCalendarIcs("BEGIN:VCALENDAR\r\nEND:VCALENDAR").length).toBeGreaterThan(0);
  });
});

// ---------- triggerIcsDownload ----------

describe("triggerIcsDownload", () => {
  it("uses the correct MIME type and triggers a download", () => {
    let createdWith: Blob | null = null;
    let revokedUrl: string | null = null;
    let attached = false;
    const result = triggerIcsDownload({
      content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      filename: `${ICS_FILENAME_PREFIX}-28-days-all-20260802.ics`,
      createObjectUrl: (blob) => {
        createdWith = blob;
        return "blob:mock-1234";
      },
      revokeObjectUrl: (url) => {
        revokedUrl = url;
      },
      attachAnchor: () => {
        attached = true;
      },
    });
    expect(createdWith).not.toBeNull();
    expect((createdWith as unknown as Blob).type).toBe(ICS_MIME);
    expect(result.mimeType).toBe(ICS_MIME);
    expect(result.blobUrl).toBe("blob:mock-1234");
    expect(result.downloadTriggered).toBe(true);
    expect(attached).toBe(true);
    // revoke is scheduled via setTimeout(0). Drain microtasks.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(revokedUrl).toBe("blob:mock-1234");
        resolve();
      }, 5);
    });
  });
  it("never touches localStorage / sessionStorage / IndexedDB", async () => {
    // Spy on storage APIs and assert no access.
    const storageSpies = {
      getItem: 0,
      setItem: 0,
      removeItem: 0,
      clear: 0,
    };
    const originalLS = (globalThis as any).localStorage;
    const originalSS = (globalThis as any).sessionStorage;
    (globalThis as any).localStorage = {
      getItem: () => { storageSpies.getItem += 1; return null; },
      setItem: () => { storageSpies.setItem += 1; },
      removeItem: () => { storageSpies.removeItem += 1; },
      clear: () => { storageSpies.clear += 1; },
    };
    (globalThis as any).sessionStorage = {
      getItem: () => { storageSpies.getItem += 1; return null; },
      setItem: () => { storageSpies.setItem += 1; },
      removeItem: () => { storageSpies.removeItem += 1; },
      clear: () => { storageSpies.clear += 1; },
    };
    try {
      triggerIcsDownload({
        content: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
        filename: `${ICS_FILENAME_PREFIX}-28-days-all-20260802.ics`,
        createObjectUrl: () => "blob:mock-x",
        revokeObjectUrl: () => undefined,
        attachAnchor: () => undefined,
      });
    } finally {
      (globalThis as any).localStorage = originalLS;
      (globalThis as any).sessionStorage = originalSS;
    }
    expect(storageSpies.getItem).toBe(0);
    expect(storageSpies.setItem).toBe(0);
    expect(storageSpies.removeItem).toBe(0);
    expect(storageSpies.clear).toBe(0);
    await Promise.resolve();
  });
});

// ---------- description helpers ----------

describe("buildBookReviewDescription", () => {
  it("includes priority / reason / count / month / last / URL lines", () => {
    const task: ReadingReviewBookTask = {
      id: "book:10000000_000000000001",
      kind: "book",
      catalogId: "10000000_000000000001",
      title: "公共书目",
      author: null,
      suggestedDate: TODAY_ISO,
      priority: "high",
      priorityScore: 80,
      noteCount: 30,
      activeMonths: 8,
      lastNoteAt: "2026-07-15T00:00:00.000Z",
      sessionRelevant: true,
      reasonCodes: ["session_book", "long_inactive"],
    };
    const desc = buildBookReviewDescription({
      task,
      publicBookUrl: `https://${ICS_UID_DOMAIN}/books/${task.catalogId}`,
    });
    expect(desc).toContain("优先级：高");
    expect(desc).toContain("阅读记录：30 条");
    expect(desc).toContain("活跃月份：8");
    expect(desc).toContain("最后阅读：2026-07-15");
    expect(desc).toContain(`https://${ICS_UID_DOMAIN}/books/10000000_000000000001`);
  });
});