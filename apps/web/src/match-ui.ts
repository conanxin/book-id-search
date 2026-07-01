import type { Book, MatchInfo, MatchType } from "./api";

// --------------------------------------------------------------------
// Exact match predicate — defensive: null/undefined match returns false.
// Used by BookCard and DetailPage to decide whether to render the
// "精确匹配" emphasis. Mirrors apps/api/src/search/match.ts.
// --------------------------------------------------------------------

export function isExactMatch(match: MatchInfo | null | undefined): boolean {
  if (!match || typeof match.type !== "string") return false;
  const t: string = match.type;
  return (
    t === "exact_identifier" ||
    t === "exact_isbn" ||
    t === "exact_ssid" ||
    t === "exact_dxid" ||
    t === "exact_title"
  );
}

// --------------------------------------------------------------------
// Match badge variant. Drives the CSS class on the badge so we can
// give exact_* an emphasized style and partial hits a quieter look.
// --------------------------------------------------------------------

export type MatchBadgeVariant = "exact" | "default" | "muted";

export function matchBadgeVariant(match: MatchInfo | null | undefined): MatchBadgeVariant {
  if (!match) return "muted";
  if (isExactMatch(match)) return "exact";
  if (match.type === "mixed" || match.type === "title") return "default";
  return "default";
}

export function matchBadgeLabel(match: MatchInfo | null | undefined): string {
  if (!match || !match.label) return "";
  return match.label;
}

// --------------------------------------------------------------------
// Parse-warning text. Maps the well-known machine codes from
// importer-warning lists to Chinese explanations; falls through to the
// raw warning text for anything we don't recognize, so future warning
// codes are still surfaced verbatim rather than dropped silently.
// --------------------------------------------------------------------

const WARNING_LABEL_MAP: Record<string, string> = {
  missing_isbn: "缺 ISBN",
  missing_dxid: "缺 DXID",
  missing_ssid: "缺 SSID",
  missing_title: "缺书名",
  embedded_comma_in_fields: "字段中含未转义逗号",
};

function formatKnownWarning(code: string): string | null {
  // year_non_numeric:* / pages_non_numeric:* — wildcard prefixes.
  const m = /^(year|pages)_non_numeric:(.*)$/.exec(code);
  if (m) {
    const which = m[1] === "year" ? "年份" : "页数";
    return `${which}异常：${m[2]}`;
  }
  if (WARNING_LABEL_MAP[code]) return WARNING_LABEL_MAP[code];
  return null;
}

export function explainParseWarning(code: string): string {
  const known = formatKnownWarning(code);
  return known ?? code;
}

export function explainParseWarnings(warnings: string[] | undefined): string {
  if (!warnings || warnings.length === 0) return "无";
  return warnings.map(explainParseWarning).join("，");
}

export function parseStatusNarrative(book: Pick<Book, "parseStatus" | "parseWarnings">): string {
  if (book.parseStatus === "ok") return "记录结构完整";
  if (book.parseStatus === "weak") {
    const detail = explainParseWarnings(book.parseWarnings);
    return `弱解析：${detail}`;
  }
  return "解析失败，建议核对原始记录";
}

// --------------------------------------------------------------------
// Synthesize a detail-page match info.
// The detail endpoint returns a Book without a query, so there's no
// "what did the user search for" to classify against. We surface a
// light-weight trust descriptor based on parseStatus so the UI can
// still show a consistent badge row.
// --------------------------------------------------------------------

export function detailMatchInfo(book: Pick<Book, "parseStatus" | "parseWarnings">): MatchInfo {
  if (book.parseStatus === "ok") {
    return {
      type: "title",
      label: "记录结构完整",
      score: 0.6,
      fields: [],
    };
  }
  if (book.parseStatus === "weak") {
    return {
      type: "title",
      label: `弱解析 · ${explainParseWarnings(book.parseWarnings)}`,
      score: 0.3,
      fields: [],
    };
  }
  return {
    type: "unknown",
    label: "解析失败，建议核对原始记录",
    score: 0,
    fields: [],
  };
}