import {
  resolveMiniMaxConfig,
  type ChatCompletionError,
  type ChatMessage,
  type MiniMaxConfig,
} from "./minimax.js";

export interface MiniMaxWebResult {
  title: string;
  url: string;
  excerpt: string;
  pageAge: string | null;
}

export type MiniMaxWebSearchResponse = {
  ok: true;
  queries: string[];
  searchCalls: number;
  results: MiniMaxWebResult[];
} | ChatCompletionError;

const REQUEST_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_CHARS = 32_000;
const MAX_CONTENT_BLOCKS = 128;
const MAX_SEARCH_CALLS = 12;
const MAX_RESULT_ENTRIES = 256;
const MAX_QUERY_CHARS = 1_000;
const MAX_URL_CHARS = 4_096;

function failure(error: string, status = 502): ChatCompletionError {
  return { ok: false, error, status };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length > MAX_URL_CHARS || !/^https?:\/\//i.test(trimmed)
      || /[\u0000-\u0020\u007f\\]/.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (!url.hostname || url.username || url.password
        || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
    // Fragment changes do not identify another search source.
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

/** Keep whole snapshots for service-level, explicitly marked truncation. */
function extractSearch(data: unknown): MiniMaxWebSearchResponse {
  const invalid = () => failure("MiniMax web search returned an invalid or incomplete response");
  if (!isRecord(data) || data.type !== "message" || data.role !== "assistant"
      || data.stop_reason !== "end_turn" || data.error != null
      || (data.status !== undefined && data.status !== "completed")
      || !Array.isArray(data.content) || data.content.length > MAX_CONTENT_BLOCKS) return invalid();
  if (data.base_resp !== undefined && (!isRecord(data.base_resp)
      || data.base_resp.status_code !== 0)) return invalid();

  const calls = new Map<string, { query: string; complete: boolean }>();
  const results = new Map<string, MiniMaxWebResult>();
  let resultEntries = 0;
  for (const block of data.content) {
    if (!isRecord(block)) continue;
    if (block.type === "server_tool_use" && block.name === "web_search") {
      if (typeof block.id !== "string" || !block.id.trim() || block.id.length > 200
          || calls.has(block.id) || calls.size >= MAX_SEARCH_CALLS
          || !isRecord(block.input) || typeof block.input.query !== "string") return invalid();
      const query = block.input.query.trim();
      if (!query || query.length > MAX_QUERY_CHARS) return invalid();
      calls.set(block.id, { query, complete: false });
    } else if (block.type === "web_search_tool_result") {
      const call = typeof block.tool_use_id === "string" ? calls.get(block.tool_use_id) : undefined;
      if (!call || call.complete || block.is_error === true || block.error != null
          || !Array.isArray(block.content)) return invalid();
      call.complete = true;
      for (const entry of block.content) {
        if (++resultEntries > MAX_RESULT_ENTRIES) return invalid();
        if (!isRecord(entry)) continue;
        if (entry.type === "web_search_tool_result_error" || entry.type === "error"
            || entry.is_error === true || entry.error != null) return invalid();
        if (entry.type !== "web_search_result") continue;
        if (typeof entry.title !== "string" || typeof entry.url !== "string"
            || typeof entry.content !== "string") return invalid();
        const url = safeUrl(entry.url);
        const title = entry.title.trim();
        const excerpt = entry.content.trim();
        if (!url || !title || !excerpt || results.has(url)) continue;
        results.set(url, {
          title, url, excerpt,
          pageAge: typeof entry.page_age === "string" ? entry.page_age.trim() || null : null,
        });
      }
    } else if (block.type === "web_search_tool_result_error" || block.type === "error") {
      return invalid();
    }
    // Text, thinking and client tool blocks are never search evidence.
  }
  if (!calls.size || [...calls.values()].some(call => !call.complete)) return invalid();
  return {
    ok: true,
    queries: [...calls.values()].map(call => call.query),
    searchCalls: calls.size,
    results: [...results.values()],
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredBytes = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error("Response limit");
  }
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Response limit");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/**
 * MiniMax hosted web search, Anthropic Messages wire only.
 * Official format: https://platform.minimax.cn/docs/guides/server-tools
 *
 * A completed, paired server trace is required. Generated text is deliberately
 * discarded: downstream synthesis uses only the provider's result snapshots.
 * No page fetch, continuation, retry, or response-body logging occurs here.
 */
export async function searchMiniMaxWeb(
  messages: ChatMessage[],
  options: {
    config?: MiniMaxConfig;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<MiniMaxWebSearchResponse> {
  const config = options.config ?? resolveMiniMaxConfig();
  if (!config || config.wireApi !== "anthropic") {
    return failure("MiniMax web search is not configured for the Anthropic wire API", 503);
  }
  if (options.signal?.aborted) return failure("MiniMax web search was cancelled", 499);
  const system = messages.filter(message => message.role === "system").map(message => message.content).join("\n\n");
  const conversation = messages.filter(message => message.role !== "system");
  if (!conversation.some(message => message.role === "user")) {
    return failure("MiniMax web search requires a user question");
  }
  const body = JSON.stringify({
    model: config.model,
    system,
    messages: conversation,
    max_tokens: 4096,
    stream: false,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });
  if (body.length > MAX_REQUEST_CHARS) return failure("MiniMax web search request is too large");

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(`${config.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(`MiniMax web search HTTP ${response.status}`, response.status);
    }
    const data = await boundedJson(response);
    if (controller.signal.aborted) {
      return options.signal?.aborted
        ? failure("MiniMax web search was cancelled", 499)
        : failure("MiniMax web search timed out", 504);
    }
    return extractSearch(data);
  } catch {
    if (options.signal?.aborted) return failure("MiniMax web search was cancelled", 499);
    if (controller.signal.aborted) return failure("MiniMax web search timed out", 504);
    // Never include provider bodies, thrown messages, model names or credentials.
    return failure("MiniMax web search request failed");
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}
