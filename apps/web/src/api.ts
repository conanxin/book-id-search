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
}

export interface SearchResponse {
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

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`);
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
