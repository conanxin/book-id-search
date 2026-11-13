import type { BookWebSourceEvidenceResponse } from "./book-web-source-evidence-contract.js";

export const BOOK_WEB_SOURCE_COMPARISON_LIMITS = {
  MIN_SOURCES: 2, MAX_SOURCES: 3, QUESTION_CHARS: 1000, TOTAL_TEXT_CHARS: 60_000,
  SELECTED_PASSAGES_PER_SOURCE: 2, SELECTION_CHARS: 2000, PROVIDER_TIMEOUT_MS: 60_000,
} as const;

const errors = {
  BOOK_COMPARISON_INVALID_INPUT: [400, "请选择 2–3 篇不同的已读网页并填写有效问题，最多 1000 字符。"],
  BOOK_COMPARISON_EXPIRED: [410, "所选网页中有快照已失效，请重新读取相关来源后再对照。"],
  BOOK_COMPARISON_TEXT_LIMIT: [400, "所选网页正文合计超过 60,000 字符，请减少来源后重试。"],
  BOOK_COMPARISON_INVALID_OUTPUT: [502, "本次多来源原文选择不完整，请稍后重试。"],
  BOOK_COMPARISON_UNAVAILABLE: [503, "多来源原文对照暂不可用，请稍后重试。"],
  BOOK_COMPARISON_TIMEOUT: [504, "本次多来源原文对照超时，请稍后重试。"],
} as const;

export class BookWebSourceComparisonError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}

export interface BookWebSourceComparisonResponse {
  bookId: string;
  question: string;
  mode: "source_comparison";
  sources: BookWebSourceEvidenceResponse[];
  generatedAt: string;
}
