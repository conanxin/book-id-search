export const BOOK_WEB_SOURCE_LIMITS = {
  URL_CHARS: 4096, TITLE_CHARS: 300, TEXT_CHARS: 30_000,
  BODY_BYTES: 2 * 1024 * 1024, TIMEOUT_MS: 20_000, REDIRECTS: 3,
  TOKEN_TTL_MS: 30 * 60_000, TOKENS: 1000,
} as const;

const errors = {
  BOOK_SOURCE_INVALID_INPUT: [400, "请选择本次搜索返回的网页来源。"],
  BOOK_SOURCE_BLOCKED: [400, "这个链接不属于可读取的公开网页地址。"],
  BOOK_SOURCE_EXPIRED: [410, "来源读取凭据已失效，请重新搜索后再读取。"],
  BOOK_SOURCE_UNSUPPORTED: [415, "暂只支持可直接读取的 HTML 或纯文本网页，不支持 PDF 或其他文件。"],
  BOOK_SOURCE_TOO_LARGE: [413, "网页超过 2 MiB 读取上限，请打开原链接查看。"],
  BOOK_SOURCE_UNREADABLE: [422, "未提取到可读正文，网页可能需要登录或运行脚本，请打开原链接查看。"],
  BOOK_SOURCE_UNAVAILABLE: [502, "网页暂时无法读取，请打开原链接查看或稍后重试。"],
  BOOK_SOURCE_TIMEOUT: [504, "网页读取超过 20 秒，请打开原链接查看或稍后重试。"],
} as const;

export class BookWebSourceError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}

export type BookWebSourceContentType = "text/html" | "application/xhtml+xml" | "text/plain";
export interface BookWebSourcePage {
  finalUrl: string;
  contentType: BookWebSourceContentType;
  body: Uint8Array;
  charset?: string;
}
export type BookWebSourceFetcher = (url: string, options: { signal?: AbortSignal }) => Promise<BookWebSourcePage>;

export interface BookWebSourceResponse {
  bookId: string;
  sourceId: string;
  requestedUrl: string;
  finalUrl: string;
  title: string;
  text: string;
  contentType: BookWebSourceContentType;
  extraction: "html_readable_text" | "plain_text";
  truncated: boolean;
  fetchedAt: string;
  snapshotToken?: string;
}

export function checkSourceCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Source reading cancelled", "AbortError");
}
