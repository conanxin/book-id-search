import { afterEach, describe, expect, it, vi } from "vitest";
import { chatCompletion, type MiniMaxConfig, type WireApi } from "./minimax.js";

const answer = '{"title":"阅读摘要","paragraphs":[{"text":"渡口附近有石桥。","sourceIds":["S2"]}],"insufficientEvidence":false}';
const messages = [{ role: "user" as const, content: "根据提供的资料，返回带引用的 JSON。" }];

function call(wireApi: WireApi, payload: unknown, requireCompleted?: boolean) {
  const config: MiniMaxConfig = {
    apiKey: "fixture-key", model: "fixture-model", wireApi,
    baseUrl: wireApi === "anthropic" ? "https://provider.example.test/anthropic" : "https://provider.example.test/v1",
  };
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), {
    status: 200, headers: { "Content-Type": "application/json" },
  }));
  return { fetchImpl, result: chatCompletion(messages, { config, fetchImpl, maxTokens: 3500, requireCompleted }) };
}

function assistant(content: unknown[], extra: Record<string, unknown> = {}) {
  return { type: "message", role: "assistant", status: "completed", content, ...extra };
}

describe("MiniMax wire response compatibility", () => {
  it("sends the Responses output limit and joins final message blocks while ignoring preceding reasoning", async () => {
    const split = answer.indexOf("paragraphs");
    const request = call("responses", { status: "completed", output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: "REASONING_IS_NOT_A_REPLY" }] },
      assistant([{ type: "output_text", text: answer.slice(0, split) }, { type: "output_text", text: answer.slice(split) }]),
    ] });
    expect(await request.result).toMatchObject({ ok: true, content: answer });
    const [url, init] = request.fetchImpl.mock.calls[0];
    expect(url).toBe("https://provider.example.test/v1/responses");
    expect(JSON.parse(init!.body as string)).toMatchObject({ input: messages, max_output_tokens: 3500, stream: false });
    expect(JSON.parse(init!.body as string)).not.toHaveProperty("max_tokens");
  });

  it("accepts the direct output_text convenience shape when no output list was returned", async () => {
    expect(await call("responses", { status: "completed", output_text: answer }).result)
      .toMatchObject({ ok: true, content: answer });
  });

  it("uses the final assistant message instead of earlier messages or the convenience field", async () => {
    expect(await call("responses", { status: "completed", output_text: "EARLIER_OUTPUT", output: [
      assistant([{ type: "output_text", text: "EARLIER_OUTPUT" }]),
      assistant([{ type: "output_text", text: answer }]),
    ] }).result).toMatchObject({ ok: true, content: answer });
  });

  it("does not turn JSON-shaped reasoning into an answer even when output_text is also present", async () => {
    expect(await call("responses", { status: "completed", output_text: answer, output: [
      { type: "reasoning", content: [{ type: "reasoning_text", text: answer }] },
    ] }).result).toMatchObject({ ok: false, status: 502 });
  });

  it.each(["incomplete", "failed"])("does not accept an answer from a %s Responses result", async status => {
    expect(await call("responses", { status, output_text: answer,
      output: [assistant([{ type: "output_text", text: answer }])] }).result)
      .toMatchObject({ ok: false, status: 502 });
  });

  it("does not substitute an earlier answer for an unfinished final assistant message", async () => {
    expect(await call("responses", { status: "completed", output: [
      assistant([{ type: "output_text", text: answer }]),
      assistant([{ type: "output_text", text: "{" }], { status: "incomplete" }),
    ] }).result).toMatchObject({ ok: false, status: 502 });
  });

  it.each([
    { output: null, output_text: answer },
    { output: [assistant([null, "text", { text: answer }, { type: "reasoning_text", text: answer }])] },
    { output: [{ type: "message", role: "user", content: [{ type: "output_text", text: answer }] }] },
  ])("rejects malformed or non-answer Responses blocks %#", async payload => {
    expect(await call("responses", payload).result).toMatchObject({ ok: false, status: 502 });
  });

  it("joins Anthropic text blocks and preserves its max_tokens request field", async () => {
    const request = call("anthropic", { type: "message", role: "assistant", content: [
      { type: "thinking", thinking: "REASONING_IS_NOT_A_REPLY", text: "ALSO_NOT_A_REPLY" },
      { type: "text", text: answer.slice(0, 15) }, { type: "text", text: answer.slice(15) },
    ] });
    expect(await request.result).toMatchObject({ ok: true, content: answer });
    const [url, init] = request.fetchImpl.mock.calls[0];
    expect(url).toBe("https://provider.example.test/anthropic/v1/messages");
    expect(JSON.parse(init!.body as string)).toMatchObject({ messages, max_tokens: 3500 });
    expect(JSON.parse(init!.body as string)).not.toHaveProperty("max_output_tokens");
  });

  it("rejects Anthropic content with only thinking or untyped text", async () => {
    expect(await call("anthropic", { content: [null, { type: "thinking", text: answer }, { text: answer }] }).result)
      .toMatchObject({ ok: false, status: 502 });
  });

  it("preserves Chat Completions content and its existing generation limit", async () => {
    const request = call("openai_chat", { choices: [{ message: { content: answer, reasoning_content: "NOT_A_REPLY" } }] });
    expect(await request.result).toMatchObject({ ok: true, content: answer });
    const [url, init] = request.fetchImpl.mock.calls[0];
    expect(url).toBe("https://provider.example.test/v1/chat/completions");
    expect(JSON.parse(init!.body as string)).toMatchObject({ messages, max_tokens: 3500, stream: false });
    expect(JSON.parse(init!.body as string)).not.toHaveProperty("max_output_tokens");
  });
});

describe("MiniMax caller cancellation", () => {
  const config: MiniMaxConfig = {
    apiKey: "fixture-key", model: "fixture-model", wireApi: "anthropic",
    baseUrl: "https://provider.example.test/anthropic",
  };
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("skips an already cancelled synthesis request", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await chatCompletion(messages, { config, fetchImpl, signal: controller.signal }))
      .toEqual({ ok: false, error: "MiniMax request cancelled", status: 499 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("aborts fetch and releases the caller listener and timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const response = chatCompletion(messages, { config, fetchImpl, signal: controller.signal });
    controller.abort("private cancellation reason");
    expect(await response).toEqual({ ok: false, error: "MiniMax request cancelled", status: 499 });
    expect(fetchImpl.mock.calls[0][1]!.signal!.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases the listener after successful synthesis", async () => {
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: answer }] })));
    expect(await chatCompletion(messages, { config, fetchImpl, signal: controller.signal }))
      .toMatchObject({ ok: true, content: answer });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("MiniMax opt-in completed-response requirement", () => {
  function anthropic(extra: Record<string, unknown> = {}) {
    return { type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: answer }], base_resp: { status_code: 0 }, ...extra };
  }
  const rejected = { ok: false, error: "MiniMax returned an incomplete or failed response", status: 502 };

  it("accepts final Anthropic text with successful provider status", async () => {
    expect(await call("anthropic", anthropic(), true).result).toMatchObject({ ok: true, content: answer });
    expect(await call("anthropic", anthropic({ base_resp: undefined }), true).result)
      .toMatchObject({ ok: true, content: answer });
  });

  it.each(["max_tokens", "tool_use", "pause_turn", "stop_sequence", null, undefined])(
    "rejects complete-looking JSON from a nonfinal Anthropic reply (%s)", async stop_reason => {
      const request = call("anthropic", anthropic({ stop_reason }), true);
      expect(await request.result).toEqual(rejected);
      expect(request.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { base_resp: { status_code: 1008, status_msg: "PRIVATE_PROVIDER_DIAGNOSTIC" } },
    { base_resp: null }, { base_resp: { status_code: "0" } },
    { error: { message: "PRIVATE_PROVIDER_DIAGNOSTIC" } }, { type: "error" },
    { status: "failed" }, { status: "incomplete" }, { role: "user" },
  ])("rejects explicit failure or malformed completion metadata without exposing provider text %#", async extra => {
    expect(await call("anthropic", anthropic(extra), true).result).toEqual(rejected);
  });

  it("preserves the existing Anthropic behavior when the strict option is omitted or false", async () => {
    const truncated = anthropic({ stop_reason: "max_tokens" });
    expect(await call("anthropic", truncated).result).toMatchObject({ ok: true, content: answer });
    expect(await call("anthropic", truncated, false).result).toMatchObject({ ok: true, content: answer });
  });

  it("requires explicit completed status for both Responses output shapes", async () => {
    const completed = { status: "completed", output: [assistant([{ type: "output_text", text: answer }])] };
    expect(await call("responses", completed, true).result).toMatchObject({ ok: true, content: answer });
    expect(await call("responses", { status: "completed", output_text: answer }, true).result)
      .toMatchObject({ ok: true, content: answer });
    expect(await call("responses", { output_text: answer }, true).result).toEqual(rejected);
    expect(await call("responses", { ...completed, status: "incomplete" }, true).result).toEqual(rejected);
    expect(await call("responses", { ...completed, output: [
      assistant([{ type: "output_text", text: answer }]),
      assistant([{ type: "output_text", text: answer }], { status: "incomplete" }),
    ] }, true).result).toEqual(rejected);
  });

  it("requires normal final Chat Completions status", async () => {
    const message = { role: "assistant", content: answer };
    expect(await call("openai_chat", { choices: [{ message, finish_reason: "stop" }] }, true).result)
      .toMatchObject({ ok: true, content: answer });
    for (const finish_reason of ["length", "tool_calls", "content_filter", null, undefined]) {
      expect(await call("openai_chat", { choices: [{ message, finish_reason }] }, true).result).toEqual(rejected);
    }
    expect(await call("openai_chat", { choices: [{ message, finish_reason: "stop" }],
      base_resp: { status_code: 1008, status_msg: "PRIVATE_PROVIDER_DIAGNOSTIC" } }, true).result).toEqual(rejected);
  });
});
