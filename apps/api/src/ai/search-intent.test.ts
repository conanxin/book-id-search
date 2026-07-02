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
import { SimpleCache } from "./cache.js";
import { _clearDefaultCache, type AiSearchResponse } from "./search-intent.js";

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
    // Clear the module-level default cache so prior tests don't pollute
    _clearDefaultCache();
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
  beforeEach(() => {
    _clearDefaultCache();
  });
  afterEach(() => {
    _clearDefaultCache();
  });

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
    expect(out.warnings.some((w) => w.includes("fallback_to_raw_query"))).toBe(true);
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
    const searchFn = vi.fn().mockResolvedValue([]); // both AI queries AND raw fallback = 0
    const out = await runAiSearchIntent("anything", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.items).toHaveLength(0);
    // New behavior (S21A-TP2): warns AND marks fallbackUsed
    expect(out.warnings.some((w) => /no_meili_hits|fallback/i.test(w))).toBe(true);
    expect(out.ai.fallbackUsed).toBe(true);
  });

  it("propagates chat failure on plan step → now falls back to raw query (S21A-TP2)", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(errChat("down", 502))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const out = await runAiSearchIntent("anything", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    // S21A-TP2 graceful fallback: no throw, items present from raw search
    expect(out.ai.fallbackUsed).toBe(true);
    expect(out.items).toHaveLength(1);
  });

  it("skips AI reason when second chat fails, but attaches fallback reason (S21A-TP2)", async () => {
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
    // S21A-TP2: aiReason is now always set (fallback to deterministic text)
    expect(out.items[0].aiReason).toBeDefined();
    expect(out.items[0].aiReason).toContain("这条记录来自真实书目库");
    expect(out.warnings.some((w) => w.startsWith("ai_reason"))).toBe(true);
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
  beforeEach(() => {
    _clearDefaultCache();
  });
  afterEach(() => {
    _clearDefaultCache();
  });

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

describe("runAiSearchIntent — cache, evidence, fallback (S21A-TP2)", () => {
  // Helper: stable env so cache key is reproducible
  beforeEach(() => {
    process.env.MINIMAX_API_KEY = FAKE_KEY;
    process.env.MINIMAX_BASE_URL = BASE;
    process.env.MINIMAX_MODEL = "test-model";
    process.env.MINIMAX_WIRE_API = "openai_chat";
    _clearDefaultCache();
  });
  afterEach(() => {
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MINIMAX_BASE_URL;
    delete process.env.MINIMAX_MODEL;
    delete process.env.MINIMAX_WIRE_API;
    _clearDefaultCache();
  });

  it("first call invokes chat; second call hits cache and skips chat", async () => {
    const cache: SimpleCache<AiSearchResponse> = new SimpleCache({ ttlMs: 5 * 60 * 1000, maxEntries: 100 });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q1"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[{"id":"a_1","reason":"hit"}]}'));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const deps = { isEnabled: () => true, chat, searchFn, cache, cacheVersion: "t1" };

    const r1 = await runAiSearchIntent("披肩", deps);
    expect(r1.cache?.hit).toBe(false);
    expect(chat).toHaveBeenCalledTimes(2); // plan + reason
    expect(searchFn).toHaveBeenCalledTimes(1);

    const r2 = await runAiSearchIntent("披肩", deps);
    expect(r2.cache?.hit).toBe(true);
    expect(r2.cache?.ttlSeconds).toBe(300);
    // chat was NOT called again (only the 2 calls from r1)
    expect(chat).toHaveBeenCalledTimes(2);
    // searchFn was NOT called again
    expect(searchFn).toHaveBeenCalledTimes(1);
    // response body is the same
    expect(r2.query).toBe(r1.query);
    expect(r2.items[0].id).toBe(r1.items[0].id);
  });

  it("expired cache calls chat again", async () => {
    let now = 0;
    const cache: SimpleCache<AiSearchResponse> = new SimpleCache({ ttlMs: 1000, maxEntries: 100, now: () => now });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'))
      .mockResolvedValueOnce(okChat('{"searchQueries":["q"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const deps = { isEnabled: () => true, chat, searchFn, cache, cacheVersion: "t1" };

    await runAiSearchIntent("披肩", deps);
    now = 1500; // expired
    await runAiSearchIntent("披肩", deps);
    expect(chat).toHaveBeenCalledTimes(4);
  });

  it("does not cache responses with provider errors (chat_failed warning)", async () => {
    const cache: SimpleCache<AiSearchResponse> = new SimpleCache({ ttlMs: 60000, maxEntries: 100 });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(errChat("down", 502));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const deps = { isEnabled: () => true, chat, searchFn, cache, cacheVersion: "t1" };

    await runAiSearchIntent("披肩", deps);
    // Since chat_reason failed, warning includes "ai_reason_chat_failed" → not cached
    expect(cache.get("t1::openai_chat::test-model::披肩")).toBeUndefined();
  });

  it("different query does not share cache", async () => {
    const cache: SimpleCache<AiSearchResponse> = new SimpleCache({ ttlMs: 60000, maxEntries: 100 });
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["a"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'))
      .mockResolvedValueOnce(okChat('{"searchQueries":["b"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const deps = { isEnabled: () => true, chat, searchFn, cache, cacheVersion: "t1" };

    const r1 = await runAiSearchIntent("披肩", deps);
    const r2 = await runAiSearchIntent("吊带", deps);
    expect(r1.cache?.hit).toBe(false);
    expect(r2.cache?.hit).toBe(false);
    expect(chat).toHaveBeenCalledTimes(4);
  });

  it("duplicate hits merge matchedQueries", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q1","q2"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce([makeBook("a_1", "T")])  // q1 hit
      .mockResolvedValueOnce([makeBook("a_1", "T")]); // q2 also hit
    const out = await runAiSearchIntent("anything", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.items[0].aiEvidence?.matchedQueryCount).toBe(2);
    expect(out.items[0].aiEvidence?.matchedQueries).toEqual(["q1", "q2"]);
    expect(out.items[0].aiEvidence?.source).toBe("ai_query");
  });

  it("multi-query hit outranks single-query hit", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q1","q2"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const a1 = makeBook("a_1", "multi hit");
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce([a1, makeBook("b_1", "single hit q1 only")])  // q1: a_1 AND b_1
      .mockResolvedValueOnce([a1]);                                         // q2: a_1 again
    const out = await runAiSearchIntent("anything", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    // a_1 hit both queries (matchedQueryCount=2), b_1 only q1 (matchedQueryCount=1)
    expect(out.items[0].id).toBe("a_1");
    expect(out.items[0].aiEvidence?.matchedQueryCount).toBe(2);
  });

  it("ok parseStatus outranks weak when matched-count equal", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const weak = makeBook("w_1", "Weak");
    (weak as any).parseStatus = "weak";
    const ok = makeBook("o_1", "OK");
    (ok as any).parseStatus = "ok";
    const searchFn = vi.fn().mockResolvedValue([weak, ok]); // weak first in Meili
    const out = await runAiSearchIntent("anything", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    // Both have matchedQueryCount=1, but ok outranks weak
    expect(out.items[0].id).toBe("o_1");
  });

  it("aiReason id whitelist still works — fake ids dropped", async () => {
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
  });

  it("aiReason fallback when AI returns nothing", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["q1"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const out = await runAiSearchIntent("披肩", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.items[0].aiReason).toContain("这条记录来自真实书目库");
    expect(out.items[0].aiReason).toContain("q1");
  });

  it("AI queries no hit → fallback to raw query and find items", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["nonsense_query_xyz"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi
      .fn()
      .mockResolvedValueOnce([])                           // AI query → no hit
      .mockResolvedValueOnce([makeBook("a_1", "Found by raw")]); // raw query → hit
    const out = await runAiSearchIntent("披肩", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.ai.fallbackUsed).toBe(true);
    expect(out.ai.fallbackReason).toBeTruthy();
    expect(out.items.length).toBe(1);
    expect(out.items[0].id).toBe("a_1");
    expect(out.items[0].aiEvidence?.source).toBe("fallback_query");
  });

  it("fallback also no hit → 200 with empty items and warning", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(okChat('{"searchQueries":["nope"],"keywords":[],"reason":"r"}'))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi.fn().mockResolvedValue([]); // everything empty
    const out = await runAiSearchIntent("想找一本蓝色封面讲月球茶壶维修的中文书", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.items).toHaveLength(0);
    expect(out.ai.fallbackUsed).toBe(true);
    expect(out.warnings.some((w) => /no_meili_hits|fallback/i.test(w))).toBe(true);
  });

  it("AI chat plan failure → fallback to raw query", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(errChat("down", 502))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const out = await runAiSearchIntent("披肩", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    expect(out.ai.fallbackUsed).toBe(true);
    expect(out.items.length).toBe(1);
  });

  it("no key leak in warnings or response", async () => {
    const chat = vi
      .fn()
      .mockResolvedValueOnce(errChat(`Bearer ${FAKE_KEY} invalid`, 502))
      .mockResolvedValueOnce(okChat('{"reasons":[]}'));
    const searchFn = vi.fn().mockResolvedValue([makeBook("a_1", "T")]);
    const out = await runAiSearchIntent("q", {
      isEnabled: () => true,
      chat,
      searchFn,
    });
    const dump = JSON.stringify(out);
    expect(dump).not.toContain(FAKE_KEY);
  });
});