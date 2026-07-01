// ------------------------------------------------------------------
// Query normalization
// ------------------------------------------------------------------
// Pure helpers. No I/O, no Meili access. Used by the search endpoint
// to produce a consistent queryInfo block (original vs normalized) and
// to drive the query-type detector.
//
// Rules:
//   - trim outer whitespace
//   - collapse internal whitespace runs (text queries keep spacing)
//   - full-width digit -> half-width (０-９ -> 0-9)
//   - DXID leading zeros MUST be preserved (string, never coerced)
//   - SSID / DXID / ISBN are NEVER coerced to Number
//   - Chinese characters pass through untouched
//
// `normalized` shape by detectedType:
//   - isbn   -> compactIdentifier (hyphens / spaces / dashes stripped)
//   - dxid   -> collapsed (12-digit with leading zeros)
//   - ssid   -> collapsed (8-digit)
//   - numeric / text -> collapsed (preserves inner spaces)
//   - empty  -> ""

export type QueryType = "isbn" | "ssid" | "dxid" | "numeric" | "text" | "empty";

const FULL_WIDTH_DIGITS = "０１２３４５６７８９";

// All dash-like characters we want to treat as a single separator for
// identifier compaction: ASCII '-', U+2010..U+2015 (hyphen, non-breaking
// hyphen, figure dash, en dash, em dash, horizontal bar).
const DASHES = "\\s\\-‐‑‒–—―";

export function fullWidthToAsciiDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const idx = FULL_WIDTH_DIGITS.indexOf(ch);
    if (idx >= 0) out += String(idx);
    else out += ch;
  }
  return out;
}

export function normalizeQuery(rawQuery: string): {
  original: string;
  normalized: string;
  detectedType: QueryType;
} {
  const original = rawQuery ?? "";
  const trimmed = fullWidthToAsciiDigits(original.trim());

  if (!trimmed) {
    return { original, normalized: "", detectedType: "empty" };
  }

  // collapsed: keeps inner single spaces, suitable for text / CJK.
  const collapsed = trimmed.replace(/\s+/g, " ");

  // compactIdentifier: drops every separator (space, ASCII hyphen, and
  // all Unicode dashes). Used to detect ISBN / DXID / SSID candidates.
  const compactRegex = new RegExp(`[${DASHES}]`, "g");
  const compactIdentifier = collapsed.replace(compactRegex, "");

  const detectedType = detectType(compactIdentifier, collapsed);

  // Normalized value:
  //   - ISBN  -> compact (digits only / digits+X). Caller can hit
  //              books.isbn stored as un-hyphenated form.
  //   - DXID  / SSID -> compact (digits only; SSID/DXID are pure digit
  //              identifiers in this dataset).
  //   - text  -> collapsed (preserves spacing for display).
  //   - numeric -> collapsed (user-typed a number; keep their form).
  let normalized: string;
  switch (detectedType) {
    case "isbn":
      // Use compact but uppercase X for ISBN-10 check digit.
      normalized = compactIdentifier.toUpperCase();
      break;
    case "dxid":
    case "ssid":
      normalized = compactIdentifier;
      break;
    default:
      normalized = collapsed;
  }

  return { original, normalized, detectedType };
}

function detectType(compact: string, collapsed: string): QueryType {
  if (!collapsed) return "empty";

  // Identifier candidates accept digits + (for ISBN-10) trailing X.
  const isDigitsOnly = /^[0-9]+$/.test(compact);
  const isIsbn10Like = /^[0-9]{9}[0-9Xx]$/.test(compact);

  if (!isDigitsOnly && !isIsbn10Like) {
    return "text";
  }

  const len = compact.length;

  // ISBN-13: must start with 978 or 979 (EAN prefix).
  if (len === 13 && (compact.startsWith("978") || compact.startsWith("979"))) {
    return "isbn";
  }
  // ISBN-10: 10 chars total. We don't checksum-verify; we accept the
  // shape. Books in this dataset store the un-hyphenated form so a
  // 10-char query is almost certainly ISBN-10.
  if (len === 10 && isIsbn10Like) {
    return "isbn";
  }
  // DXID: 12-digit identifier. Dataset convention: leading zeros are
  // common (e.g. "000008232537"). A bare 12-digit query without leading
  // zeros is still classified as dxid because that's the only 12-digit
  // identifier we have.
  if (len === 12) {
    return "dxid";
  }
  // SSID: 8-digit identifier.
  if (len === 8) {
    return "ssid";
  }
  // Any other digit length (year, page count, partial SSID, etc.) -> numeric.
  if (isDigitsOnly) {
    return "numeric";
  }
  return "text";
}