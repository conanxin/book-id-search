export type ParseStatus = "ok" | "weak" | "failed";

export interface BookDocument {
  id: string;
  ssid: string;
  dxid: string;
  title: string;
  author: string;
  publisher: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  rawInfo: string;
  parseStatus: ParseStatus;
  parseWarnings: string[];
}

export interface ParseOptions {
  lineNumber?: number;
}

const YEAR_RE = /^(1[5-9]\d{2}|20\d{2}|21\d{2})$/;
const PAGES_RE = /^\d+$/;

function normalizeText(value: string | undefined): string {
  return (value ?? "").replace(/^\uFEFF/, "").trim();
}

export function normalizeIsbn(value: string | undefined): string {
  return normalizeText(value).replace(/[\s-]+/g, "").toUpperCase();
}

function inferDelimiter(line: string): "," | "\t" {
  const tabCount = (line.match(/\t/g) ?? []).length;
  const commaCount = (line.match(/,/g) ?? []).length;
  return tabCount >= 7 && tabCount >= commaCount ? "\t" : ",";
}

function splitDelimited(line: string, delimiter: "," | "\t"): string[] {
  const out: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && (inQuotes || current.length === 0)) {
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      out.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  out.push(current);
  return out;
}

function mapFields(parts: string[], delimiter: "," | "\t") {
  const normalized = parts.map(normalizeText);
  const [ssid = "", dxid = ""] = normalized;

  if (normalized.length <= 8) {
    return {
      ssid,
      dxid,
      title: normalized[2] ?? "",
      author: normalized[3] ?? "",
      publisher: normalized[4] ?? "",
      yearRaw: normalized[5] ?? "",
      pagesRaw: normalized[6] ?? "",
      isbnRaw: normalized[7] ?? ""
    };
  }

  const isbnRaw = normalized.at(-1) ?? "";
  const pagesRaw = normalized.at(-2) ?? "";
  const yearRaw = normalized.at(-3) ?? "";
  const publisher = normalized.at(-4) ?? "";
  const middle = normalized.slice(2, -4);

  return {
    ssid,
    dxid,
    title: middle[0] ?? "",
    author: middle.slice(1).join(delimiter),
    publisher,
    yearRaw,
    pagesRaw,
    isbnRaw
  };
}

export function parseBookLine(rawLine: string, options: ParseOptions = {}): BookDocument {
  const rawInfo = rawLine.replace(/\r?\n$/, "");
  const lineNumber = options.lineNumber ?? 0;
  const warnings: string[] = [];

  try {
    if (!rawInfo.trim()) {
      return {
        id: `line_${lineNumber || "blank"}`,
        ssid: "",
        dxid: "",
        title: "",
        author: "",
        publisher: "",
        year: null,
        pages: null,
        isbn: "",
        rawInfo,
        parseStatus: "failed",
        parseWarnings: ["blank_line"]
      };
    }

    const delimiter = inferDelimiter(rawInfo);
    const parts = splitDelimited(rawInfo, delimiter);
    if (parts.length < 7) warnings.push(`field_count_low:${parts.length}`);
    if (parts.length > 8) warnings.push(`field_count_high:${parts.length}`);
    if (delimiter === "\t") warnings.push("tab_delimited");

    const mapped = mapFields(parts, delimiter);
    const ssid = mapped.ssid;
    const dxid = mapped.dxid;
    const title = mapped.title;
    const author = mapped.author;
    const publisher = mapped.publisher;
    const isbn = normalizeIsbn(mapped.isbnRaw);

    if (!ssid) warnings.push("missing_ssid");
    if (!dxid) warnings.push("missing_dxid");
    if (!title) warnings.push("missing_title");
    if (!author) warnings.push("missing_author");
    if (!publisher) warnings.push("missing_publisher");
    if (!isbn) warnings.push("missing_isbn");

    let year: number | null = null;
    if (mapped.yearRaw) {
      if (YEAR_RE.test(mapped.yearRaw)) year = Number.parseInt(mapped.yearRaw, 10);
      else warnings.push(`year_non_numeric:${mapped.yearRaw}`);
    } else {
      warnings.push("missing_year");
    }

    let pages: number | null = null;
    if (mapped.pagesRaw) {
      if (PAGES_RE.test(mapped.pagesRaw)) pages = Number.parseInt(mapped.pagesRaw, 10);
      else warnings.push(`pages_non_numeric:${mapped.pagesRaw}`);
    } else {
      warnings.push("missing_pages");
    }

    const id = ssid && dxid ? `${ssid}_${dxid}` : `line_${lineNumber || "unknown"}`;
    const parseStatus: ParseStatus = !title && (!ssid || !dxid) ? "failed" : warnings.length ? "weak" : "ok";

    return {
      id,
      ssid,
      dxid,
      title,
      author,
      publisher,
      year,
      pages,
      isbn,
      rawInfo,
      parseStatus,
      parseWarnings: warnings
    };
  } catch (error) {
    return {
      id: `line_${lineNumber || "error"}`,
      ssid: "",
      dxid: "",
      title: "",
      author: "",
      publisher: "",
      year: null,
      pages: null,
      isbn: "",
      rawInfo,
      parseStatus: "failed",
      parseWarnings: [`parser_exception:${error instanceof Error ? error.message : String(error)}`]
    };
  }
}
