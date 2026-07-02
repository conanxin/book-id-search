export type MatchType =
  | "exact_identifier"
  | "exact_isbn"
  | "exact_ssid"
  | "exact_dxid"
  | "exact_title"
  | "title"
  | "author"
  | "publisher"
  | "mixed"
  | "unknown";

export interface MatchInfo {
  type: MatchType;
  label: string;
  score: number;
  fields: string[];
}

export type QueryType = "isbn" | "ssid" | "dxid" | "numeric" | "text" | "empty";

export interface QueryInfo {
  original: string;
  normalized: string;
  detectedType: QueryType;
}

export interface Book {
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
  parseStatus: "ok" | "weak" | "failed";
  parseWarnings: string[];
  match?: MatchInfo;
}

export interface SearchResponse {
  query?: string;
  queryInfo?: QueryInfo;
  total: number;
  page: number;
  limit: number;
  items: Book[];
}

export interface ImportReportSummary {
  imported?: number;
  totalLines?: number;
  weakParsed?: number;
  failedParsed?: number;
  finishedAt?: string | null;
  elapsedSeconds?: number | null;
}

export interface ParseQualitySummary {
  totalLines?: number;
  okParsed?: number;
  weakParsed?: number;
  failedParsed?: number;
  finishedAt?: string;
}

export interface StatsResponse {
  indexName: string;
  numberOfDocuments: number;
  isIndexing: boolean;
  lastImportReport: ImportReportSummary | null;
  parseQualityReport: ParseQualitySummary | null;
}

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:3001/api";

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, init);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error?.message ?? "请求失败");
  }
  return data as T;
}

export function searchBooks(q: string, page: number, limit = 20) {
  const params = new URLSearchParams({ q, page: String(page), limit: String(limit) });
  return requestJson<SearchResponse>(`/search?${params.toString()}`);
}

export function getBook(id: string) {
  return requestJson<{ item: Book }>(`/books/${encodeURIComponent(id)}`);
}

export function getRelatedBooks(id: string) {
  return requestJson<{ total: number; items: Book[] }>(`/books/${encodeURIComponent(id)}/related`);
}

export function getStats() {
  return requestJson<StatsResponse>("/stats");
}

// ---------------------------------------------------------------------------
// S21A — AI-assisted natural-language search
// ---------------------------------------------------------------------------

export interface AiEvidence {
  matchedQueries: string[];
  matchedQueryCount: number;
  source: "ai_query" | "fallback_query";
  rankScore: number;
}

export interface AiItem extends Book {
  aiReason?: string;
  aiEvidence?: AiEvidence;
}

export interface AiSearchResponse {
  query: string;
  ai: {
    understanding: string;
    searchQueries: string[];
    keywords: string[];
    fallbackUsed: boolean;
    fallbackReason?: string;
  };
  items: AiItem[];
  warnings: string[];
  cache?: {
    hit: boolean;
    ttlSeconds?: number;
  };
}

export function getAiStatus(): Promise<{ enabled: boolean }> {
  return requestJson<{ enabled: boolean }>("/ai/status");
}

export function searchAiIntent(query: string): Promise<AiSearchResponse> {
  return requestJson<AiSearchResponse>("/ai/search-intent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
}

// ---------------------------------------------------------------------------
// S22A — AI book detail insight
// ---------------------------------------------------------------------------

export interface BibliographicQuality {
  parseStatus: string;
  missingFields: string[];
  abnormalFields: string[];
  warnings: string[];
  trustHints: string[];
}

export interface BookInsightBasis {
  id: string;
  title: string;
  author: string;
  publisher: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  ssid: string;
  dxid: string;
  parseStatus: string;
  parseWarnings: string[];
  rawInfoExcerpt: string;
  rawInfoTruncated: boolean;
}

export interface BookInsight {
  scopeNote: string;
  shortSummary: string;
  subjectTags: string[];
  likelyAudience: string;
  bibliographicSignals: string[];
  searchSuggestions: string[];
  trustAssessment: {
    level: "high" | "medium" | "low";
    reasons: string[];
  };
  caveats: string[];
}

export interface BookInsightResponse {
  bookId: string;
  cache?: { hit: boolean; ttlSeconds?: number };
  basis: BookInsightBasis;
  quality: BibliographicQuality;
  insight: BookInsight;
  source: "ai" | "rule_based_fallback";
}

export function getBookInsight(bookId: string): Promise<BookInsightResponse> {
  return requestJson<BookInsightResponse>("/ai/book-insight", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bookId }),
  });
}