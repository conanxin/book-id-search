import type { BookWebSourceResponse } from "./book-web-source-contract.js";

export const BOOK_WEB_SOURCE_EVIDENCE_LIMITS = {
  QUESTION_CHARS: 1000, SNAPSHOT_TTL_MS: 30 * 60_000, SNAPSHOTS: 32,
  PASSAGE_CHARS: 1200, BOUNDARY_MIN_CHARS: 600, PASSAGES: 64, SELECTED_PASSAGES: 4,
  SELECTION_CHARS: 2000, PROVIDER_TIMEOUT_MS: 60_000,
} as const;

const errors = {
  BOOK_EVIDENCE_INVALID_INPUT: [400, "请选择已读取的网页并填写有效问题，最多 1000 字。"],
  BOOK_EVIDENCE_EXPIRED: [410, "这份网页快照已失效，请重新读取网页后再查找原文。"],
  BOOK_EVIDENCE_INVALID_OUTPUT: [502, "本次原文选择不完整，请稍后重试。"],
  BOOK_EVIDENCE_UNAVAILABLE: [503, "原文查找暂不可用，请稍后重试。"],
  BOOK_EVIDENCE_TIMEOUT: [504, "本次原文查找超时，请稍后重试。"],
} as const;

export class BookWebSourceEvidenceError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}

export type BookWebSourceSnapshot = Readonly<Omit<BookWebSourceResponse, "snapshotToken"> & { snapshotToken: string }>;
export interface BookWebSourcePassage {
  id: string;
  /** Half-open offsets in the exact snapshot text, measured in UTF-16 code units. */
  start: number;
  end: number;
  text: string;
}
export interface BookWebSourceEvidenceResponse {
  bookId: string;
  sourceId: string;
  snapshotToken: string;
  question: string;
  mode: "source_passages";
  status: "selected" | "insufficient_evidence";
  requestedUrl: string;
  finalUrl: string;
  title: string;
  fetchedAt: string;
  sourceTruncated: boolean;
  passages: BookWebSourcePassage[];
  generatedAt: string;
}
