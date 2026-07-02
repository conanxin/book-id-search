/**
 * MiniMax chat-completion client (supports 3 wire APIs).
 *
 * Reads configuration from env (already loaded by dotenv at index.ts boot):
 *   - MINIMAX_API_KEY    (required to activate)
 *   - MINIMAX_BASE_URL   (default: https://api.minimaxi.com/v1 for Token Plan,
 *                         or https://api.minimaxi.com/anthropic for anthropic wire)
 *   - MINIMAX_MODEL      (default: MiniMax-M3)
 *   - MINIMAX_WIRE_API   (default: responses) - Token Plan wire protocol:
 *                         responses | openai_chat | anthropic
 *
 * Token Plan subscription keys are NOT interchangeable with pay-as-you-go API keys.
 * Use `responses` for /v1/responses (Token Plan default),
 *     `openai_chat` for /v1/chat/completions,
 *     `anthropic` for /anthropic/messages.
 *
 * Safety:
 *   - The API key never appears in error messages or returned objects.
 *   - All errors are normalized to plain `{ ok: false, error, status }`.
 *   - 30s timeout via AbortController.
 */

export type WireApi = "responses" | "openai_chat" | "anthropic";

export interface MiniMaxConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  wireApi: WireApi;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionResult {
  ok: true;
  content: string;
  model: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface ChatCompletionError {
  ok: false;
  error: string;
  status: number;
}

export type ChatCompletionResponse = ChatCompletionResult | ChatCompletionError;

const DEFAULT_BASE_URL = "https://api.minimaxi.com/v1";
const DEFAULT_MODEL = "MiniMax-M3";
const DEFAULT_WIRE_API: WireApi = "responses";
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Resolve MiniMax configuration from env. Returns `null` if the API key is
 * absent — the caller is expected to gate the endpoint on this.
 */
export function resolveMiniMaxConfig(env: NodeJS.ProcessEnv = process.env): MiniMaxConfig | null {
  const apiKey = env.MINIMAX_API_KEY?.trim();
  if (!apiKey) return null;

  let wireApi: WireApi = DEFAULT_WIRE_API;
  const envWire = env.MINIMAX_WIRE_API?.trim().toLowerCase();
  if (envWire === "responses" || envWire === "openai_chat" || envWire === "anthropic") {
    wireApi = envWire;
  }

  // Anthropic wire defaults to its base URL if not explicitly set
  let baseUrl = env.MINIMAX_BASE_URL?.trim();
  if (!baseUrl && wireApi === "anthropic") {
    baseUrl = "https://api.minimaxi.com/anthropic";
  }
  baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

  return {
    apiKey,
    baseUrl,
    model: env.MINIMAX_MODEL?.trim() || DEFAULT_MODEL,
    wireApi,
  };
}

/**
 * Feature flag check: AI endpoints should refuse to activate unless
 * AI_FEATURES_ENABLED=true AND the MiniMax client is configured.
 */
export function isAiEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AI_FEATURES_ENABLED?.toLowerCase() !== "true") return false;
  return resolveMiniMaxConfig(env) !== null;
}

/**
 * Extract text from MiniMax /v1/responses response (Token Plan wire).
 * Returns empty string if unrecognized structure.
 */
function extractResponsesContent(data: unknown): string {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return "";

  // Try output_text (direct)
  if (typeof d.output_text === "string") return d.output_text;

  // Try output[].content[].text
  if (Array.isArray(d.output)) {
    for (const item of d.output) {
      if (item?.content && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c?.type === "output_text" && typeof c?.text === "string") return c.text;
          if (typeof c?.text === "string") return c.text;
        }
      }
    }
  }

  // Last resort: try to extract any string field
  return "";
}

/**
 * Extract text from Anthropic Messages API response.
 */
function extractAnthropicContent(data: unknown): string {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return "";

  if (Array.isArray(d.content)) {
    for (const c of d.content) {
      if (c?.type === "text" && typeof c?.text === "string") return c.text;
      if (typeof c?.text === "string") return c.text;
    }
  }

  return "";
}

/**
 * Run a chat completion through the configured wire API.
 * Returns either `{ ok: true, content }` or `{ ok: false, error, status }`.
 * Never echoes the API key.
 *
 * `fetchImpl` is injectable for tests. Defaults to global `fetch`.
 */
export async function chatCompletion(
  messages: ChatMessage[],
  options: {
    config?: MiniMaxConfig;
    temperature?: number;
    maxTokens?: number;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {}
): Promise<ChatCompletionResponse> {
  const config = options.config ?? resolveMiniMaxConfig();
  if (!config) {
    return { ok: false, error: "MINIMAX_API_KEY not configured", status: 503 };
  }
  const f = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    let url: string;
    let body: string;
    let authHeader: Record<string, string>;
    let extractor: (data: unknown) => string;

    const temperature = options.temperature ?? 0.2;
    const maxTokens = options.maxTokens ?? 800;

    switch (config.wireApi) {
      case "openai_chat": {
        url = `${config.baseUrl}/chat/completions`;
        body = JSON.stringify({
          model: config.model,
          messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        });
        authHeader = { Authorization: `Bearer ${config.apiKey}` };
        extractor = (d: unknown) => {
          const data = d as { choices?: { message?: { content?: string } }[] };
          return data.choices?.[0]?.message?.content ?? "";
        };
        break;
      }

      case "anthropic": {
        // Token Plan /anthropic/messages wire
        // MiniMax Token Plan uses anthropic-compatible format via MiniMax auth
        const systemMsg = messages.find((m) => m.role === "system");
        const nonSystemMsgs = messages.filter((m) => m.role !== "system");
        // If no user message, can't proceed (anthropic requires at least one user message)
        if (nonSystemMsgs.length === 0) {
          nonSystemMsgs.push({ role: "user", content: "." });
        }
        url = config.baseUrl.includes("/anthropic")
          ? `${config.baseUrl}/v1/messages`
          : `${config.baseUrl}/v1/messages`;
        body = JSON.stringify({
          model: config.model,
          max_tokens: maxTokens,
          temperature,
          system: systemMsg?.content ?? "You are a helpful assistant.",
          messages: nonSystemMsgs,
        });
        authHeader = { "x-api-key": config.apiKey, "anthropic-version": "2023-06-01" };
        extractor = extractAnthropicContent;
        break;
      }

      case "responses":
      default: {
        // MiniMax Token Plan /v1/responses wire
        url = `${config.baseUrl}/responses`;
        body = JSON.stringify({
          model: config.model,
          input: messages,
          temperature,
          max_tokens: maxTokens,
          stream: false,
        });
        authHeader = { Authorization: `Bearer ${config.apiKey}` };
        extractor = extractResponsesContent;
        break;
      }
    }

    const res = await f(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader,
      },
      body,
      signal: ctl.signal,
    });

    if (!res.ok) {
      const text = await safeText(res);
      let errorMsg = `MiniMax HTTP ${res.status}: ${redact(text).slice(0, 200)}`;
      // 401 could be key OR wrong wire API / model - don't assert key is definitely wrong
      if (res.status === 401) {
        errorMsg = `KEY_INVALID_OR_ENDPOINT_MISMATCH: HTTP ${res.status} — check key + wire API + model`;
      }
      return {
        ok: false,
        error: errorMsg,
        status: res.status,
      };
    }

    const data = (await res.json()) as unknown;
    const content = extractor(data);
    if (!content) {
      return {
        ok: false,
        error: `MiniMax returned empty content (wire=${config.wireApi})`,
        status: 502,
      };
    }
    return {
      ok: true,
      content,
      model: config.model,
    };
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    if (msg.toLowerCase().includes("abort")) {
      return { ok: false, error: "MiniMax request timed out", status: 504 };
    }
    return { ok: false, error: `MiniMax request failed: ${redact(msg)}`, status: 502 };
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 1000);
  } catch {
    return "";
  }
}

/** Redact anything that smells like a bearer token or long alphanumeric secret. */
export function redact(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer ***")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "sk-***")
    .replace(/[A-Za-z0-9_-]{32,}/g, (m) => (m === m.toLowerCase() || m === m.toUpperCase() ? m : "***"));
}
