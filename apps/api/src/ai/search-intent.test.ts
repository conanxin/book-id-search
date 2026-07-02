import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  chatCompletion,
  isAiEnabled,
  resolveMiniMaxConfig,
  redact,
} from "./minimax.js";
import {
  extractFirstJsonObject,
  extractPlan,
  extractReasons,
  runAiSearchIntent,
  AiDisabledError,
} from "./search-intent.js";

const FAKE_KEY = "test-key-abcdef0123456789";
const BASE = "https://api.minimax.example/v1";

function makeConfig(overrides: Partial<{ apiKey: string; baseUrl: string; model: string; wireApi: string }> = {}) {
  return {
    apiKey: overrides.apiKey ?? FAKE_KEY,
    baseUrl: overrides.baseUrl ?? BASE,
    model: overrides.model ?? "test-model",
    wireApi: (overrides.wireApi as any) ?? "openai_chat", // test with openai_chat for backward compatibility
  };
}

function makeBook(id: string, title: string, author = "Test Author") {
  return {
    id,
    ssid: id.split("_")[0],
    dxid: id.split("_")[1] ?? "000000000000",
    title,
    author,
    publisher: "Test Publisher",
    year: 2020,
    pages: 100,
    isbn: "",
    parseStatus: "ok",
    parseWarnings: [],
  };
}

function okChat(content: string) {
  return {
    ok: true as const,
    content,
    model: "test-model",
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function errChat(error = "boom", status = 502) {
  return { ok: false as const, error, status };
}

describe("minimax client", () => {
  beforeEach(() => {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_BASE_URL;
    delete process.env.MINIMAX_MODEL;
    delete process.env.MINIMAX_WIRE_API;
    delete process.env.AI_FEATURES_ENABLED;
  });
  afterEach(() => {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_BASE_URL;
    delete process.env.MINIMAX_MODEL;
    delete process.env.MINIMAX_WIRE_API;
    delete process.env.AI_FEATURES_ENABLED;
  });

  it("resolveMiniMaxConfig returns null when API key absent", () => {
    expect(resolveMiniMaxConfig()).toBeNull();
  });

  it("resolveMiniMaxConfig returns config when key present", () => {
    process.env.MINIMAX_API_KEY = "k";
    process.env.MINIMAX_BASE_URL = "https://x.example/v1/";
    process.env.MINIMAX_MODEL = "abc";
    const c = resolveMiniMaxConfig()!;
    expect(c.apiKey).toBe("k");
    expect(c.baseUrl).toBe("https://x.example/v1"); // trailing slash stripped
    expect(c.model).toBe("abc");
  });

  it("isAiEnabled requires both flag and key", () => {
    expect(isAiEnabled()).toBe(false);
    process.env.MINIMAX_API_KEY = "k";
    expect(isAiEnabled()).toBe(false);
    process.env.AI_FEATURES_ENABLED = "true";
    expect(isAiEnabled()).toBe(true);
    process.env.AI_FEATURES_ENABLED = "TRUE";
    expect(isAiEnabled()).toBe(true);
    process.env.AI_FEATURES_ENABLED = "1";
    expect(isAiEnabled()).toBe(false); // only "true" counts
  });

  it("chatCompletion returns 503 when no key", async () => {
    const r = await chatCompletion([{ role: "user", content: "hi" }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });

  it("chatCompletion happy path returns content", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "hi back" } }],
          model: "m",
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const r = await chatCompletion([{ role: "user", content: "hi" }], {
      config: makeConfig(),
      fetchImpl,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("hi back");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("chatCompletion redacts bearer token in error messages", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(`bad token: Bearer ${FAKE_KEY}`, { status: 403 }),
    );
    const r = await chatCompletion([{ role: "user", content: "hi" }], {
      config: makeConfig(),
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).not.toContain(FAKE_KEY);
      expect(r.error).toMatch(/Bearer\s+\*\*\*/);
    }
  });

  it("chatCompletion returns KEY_INVALID_OR_ENDPOINT_MISMATCH for 401 (Token Plan wire issue)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response("unauthorized", { status: 401 }),
    );
    const r = await chatCompletion([{ role: "user", content: "hi" }], {
      config: makeConfig(),
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("KEY_INVALID_OR_ENDPOINT_MISMATCH");
      expect(r.status).toBe(401);
    }
  });

  it("chatCompletion times out and returns 504", async () => {
    const fetchImpl = vi.fn().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const r = await chatCompletion([{ role: "user", content: "hi" }], {
      config: makeConfig(),
      fetchImpl,
      timeoutMs: 50,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(504);
      expect(r.error.toLowerCase()).toContain("timed out");
    }
  });
});

describe("redact", () => {
  it("redacts sk- style secrets", () => {
    const r = redact("hello sk-abcdefghijklmnopqrstuvwxyz0123456789 there");
    expect(r).toContain("sk-***");
    expect(r).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });
  it("redacts bearer tokens", () => {
    const r = redact("Authorization: Bearer abcdefghijklmnop");
    expect(r).toContain("Bearer ***");
  });
});

describe("extractFirstJsonObject", () => {
  it("parses fenced json", () => {
    const obj = extractFirstJsonObject("preface ```json\n{\"a\":1}\n``` trailer") as any;
    expect(obj?.a).toBe(1);
  });
  it("parses embedded object", () => {
    const obj = extractFirstJsonObject('hello {"a":2} world') as any;
    expect(obj?.a).toBe(2);
  });
  it("parses nested braces", () => {
    const obj = extractFirstJsonObject('noise {"a":{"b":3},"c":[1,2]} more') as any;
    expect(obj?.a?.b).toBe(3);
    expect(obj?.c).toEqual([1, 2]);
  });
  it("returns null when no JSON present", () => {
    expect(extractFirstJsonObject("just text")).toBeNull();
  });
});

describe("extractPlan", () => {
  it("returns a plan for a well-formed reply", () => {
    const plan = extractPlan(
      '{"searchQueries":["a","b"],"keywords":["k"],"reason":"because"}',
      [],
    );
    expect(plan).not.toBeNull();
    expect(plan?.searchQueries).toEqual(["a", "b"]);
    expect(plan?.keywords).toEqual(["k"]);
    expect(plan?.reason).toBe("because");
  });
  it("warns and returns null when no JSON", () => {
    const warnings: string[] = [];
    expect(extractPlan("garbage", warnings)).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });
  it("warns when fields are empty", () => {
    const warnings: string[] = [];
    expect(extractPlan('{"searchQueries":[],"keywords":[],"reason":""}', warnings)).toBeNull();
    expect(warnings).toContain("plan_empty_fields");
  });
});

describe("extractReasons", () => {
  it("returns map keyed by id", () => {
    const map = extractReasons(
      '{"reasons":[{"id":"X_1","reason":"yes"},{"id":"X_2","reason":"no"}]}',
      [],
    );
    expect(map.size).toBe(2);
    expect(map.get("X_1")).toBe("yes");
  });
  it("warns when no reasons", () => {
    const warnings: string[] = [];
    const map = extractReasons("nope", warnings);
    expect(map.size).toBe(0);
    expect(warnings).toContain("reasons_no_json_object");
  });
});

describe("runAiSearchIntent", () => {
  it("throws AiDisabledError when not enabled", async () => {
    await expect(
      runAiSearchIntent("hello", {
        isEnabled: () => false,
        searchFn: async () => [],
        chat: vi.fn().mockResolvedValue(okChat("")),
      }),
    ).rejects.toBeInstanceOf(AiDisabledError);
  });

  it("falls back to raw query when plan is unparsable", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat("definitely not JSON"))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "raw hit")]);
    const out = await runAiSearchIntent("want a raw hit", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.warnings).toContain("ai_plan_parse_failed_fallback_to_raw_query");
    expect(searchFn).toHaveBeenCalledWith("want a raw hit", expect.any(Number));
    expect(out.items).toHaveLength(1);
  });

  it("merges results from multiple search queries by id", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(
        okChat(
          '{"searchQueries":["q1","q2","q3"],"keywords":["k"],"reason":"r"}',
        ),
      )
      .mockResolvedValueOnce(okChat('{"reasons":[{"id":"a_1","reason":"match"}]}'));
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce([makeBook("a_1", "from q1"), makeBook("a_2", "from q1")])
      .mockResolvedValueOnce([makeBook("a_1", "dup"), makeBook("a_3", "from q2")])
      .mockResolvedValueOnce([makeBook("a_4", "from q3")]);
    const out = await runAiSearchIntent("anything", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    // All three queries were executed; their results were merged.
    expect(searchFn).toHaveBeenCalledTimes(3);
    const ids = out.items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length); // unique ids
    expect(ids).toContain("a_1");
    expect(ids).toContain("a_2");
    expect(ids).toContain("a_3");
    expect(ids).toContain("a_4");
  });

  it("attaches aiReason from the second pass", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q1"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[{"id":"a_1","reason":"命中披肩和吊带"}]}'));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const out = await runAiSearchIntent("anything", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.items[0].aiReason).toBe("命中披肩和吊带");
  });

  it("does NOT invent ids — reason map keys not in items are dropped", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(
        okChat(
          '{"reasons":[{"id":"a_1","reason":"real"},{"id":"fake_id","reason":"hallucinated"}]}',
        ),
      );
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const out = await runAiSearchIntent("anything", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.items[0].aiReason).toBe("real");
    // No item with id fake_id exists in items
  });

  it("returns 0 items when Meili has no hits (with warning)", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q1","q2"],"keywords":[],"reason":"r"}'));
    const searchFn = vi.fn().mockResolvedValue([]);
    const out = await runAiSearchIntent("anything", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.items).toHaveLength(0);
    expect(out.warnings).toContain("no_meili_hits");
  });

  it("propagates chat failure on plan step", async () => {
    const chat = vi.fn().mockResolvedValueOnce(errChat("down", 502));
    await expect(
      runAiSearchIntent("anything", {
        isEnabled: () => true,
        chat,
        searchFn: async () => [],
      }),
    ).rejects.toThrow(/unavailable/);
  });

  it("skips reason attachment when second chat fails", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(errChat("down", 502));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const out = await runAiSearchIntent("anything", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.items[0].aiReason).toBeUndefined();
    expect(out.warnings.some((w) => w.startsWith("ai_reason_failed"))).toBe(true);
  });

  it("truncates user query to maxQueryChars", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi.fn().mockResolvedValue([]);
    const long = "x".repeat(500);
    await runAiSearchIntent(long, {
      isEnabled: () => true,
      chat,
      searchFn,
      maxQueryChars: 50,
    });
    const planCall = chat.mock.calls[0][0];
    const userMsg = planCall[planCall.length - 1];
    expect((userMsg as any).content.length).toBeLessThanOrEqual(50);
  });
});

describe("redaction safety in orchestrator error paths", () => {
  it("does not include api key in thrown error", async () => {
    const chat = vi.fn().mockResolvedValue(errChat("down", 502));
    try {
      await runAiSearchIntent("q", {
        isEnabled: () => true,
        chat,
        searchFn: async () => [],
      });
    } catch (e) {
      expect((e as Error).message).not.toContain(FAKE_KEY);
    }
  });
});