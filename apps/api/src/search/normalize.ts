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
// Labeled identifier extraction (S25A):
//   If the query contains an explicit label like "ISBN 是 978-..." /
//   "SSID: 13000000" / "DXID 是 000008232537", we strip the label
//   and surrounding prose, and force the normalized value to the
//   digit run. This lets natural-language queries like "ISBN 是
//   978-7-5384-5525-0 的书" hit the exact-identifier path instead
//   of falling back to a text search over the digit tokens.
//
//   We do NOT activate extraction when no label is present. Bare
//   "2011 年北京旅游" must still resolve to "text" — only labeled
//   prose triggers extraction, so year/page-count numbers in
//   natural-language queries remain safe.
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

// Labeled identifier extraction. Matches queries like:
//   "ISBN 是 978-7-5384-5525-0 的书"
//   "ISBN: 9787538455250"
//   "ISBN 9787538455250"
//   "查 ISBN 978-7-5384-5525-0"
//   "SSID 是 13000000"
//   "DXID: 000008232537"
//   "DXID 是 000008232537"
//
// Returns the digit run (possibly containing hyphens) and the
// forced type, or null when no label is present. The digit run is
// then compacted (hyphens removed) before being used as the
// normalized value, so ISBN-13 "978-7-5384-5525-0" → "9787538455250".
//
// We require an explicit label (ISBN|SSID|DXID). Bare digit runs
// without a label still go through the normal detectType path
// so "2011 年北京旅游" stays a text query and doesn't get
// accidentally pulled into the 8-digit SSID branch.
const LABELED_ID_RE =
  /\b(?:ISBN|SSID|DXID)\b\s*[:：是为是]?\s*((?:[0-9][\s\-]*){8,13}[0-9Xx]?)/i;

function extractLabeledIdentifier(
  input: string
): { id: string; type: QueryType } | null {
  const m = LABELED_ID_RE.exec(input);
  if (!m) return null;
  const idRaw = m[1];
  if (!idRaw) return null;
  // Compact: drop spaces and hyphens, uppercase X for ISBN-10.
  const id = idRaw.replace(/[\s\-]/g, "").toUpperCase();
  if (!id) return null;
  // ISBN-13 vs ISBN-10 vs DXID (12) vs SSID (8). Order matters: a
  // 10-digit id with optional X is ISBN-10 only; a 12-digit is DXID;
  // 13-digit starting 978/979 is ISBN-13; an 8-digit is SSID.
  if (id.length === 13 && (id.startsWith("978") || id.startsWith("979"))) {
    return { id, type: "isbn" };
  }
  if (id.length === 10 && /^[0-9]{9}[0-9Xx]$/.test(id)) {
    return { id, type: "isbn" };
  }
  if (id.length === 12) {
    return { id, type: "dxid" };
  }
  if (id.length === 8) {
    return { id, type: "ssid" };
  }
  // Labeled run with no matching length — still a labeled intent,
  // but the corpus doesn't store that form. Return null so the
  // caller falls through to the text-search path with the original
  // prose.
  return null;
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

  // Labeled identifier path (S25A). When a label like "ISBN" /
  // "SSID" / "DXID" appears, we extract the digit run and force
  // the type. The extraction already compacts hyphens / spaces
  // and uppercases X for ISBN-10, so the normalized value is
  // ready to hit the exact-identifier path downstream.
  const labeled = extractLabeledIdentifier(trimmed);
  if (labeled) {
    return {
      original,
      normalized: labeled.id,
      detectedType: labeled.type,
    };
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