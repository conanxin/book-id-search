import { describe, it, expect, vi } from "vitest";
import { SimpleCache, buildAiCacheKey, normalizeQueryForCache } from "./cache";

describe("SimpleCache", () => {
  it("returns undefined for missing key", () => {
    const c = new SimpleCache<string>({ ttlMs: 1000, maxEntries: 10 });
    expect(c.get("nope")).toBeUndefined();
  });

  it("returns stored value", () => {
    const c = new SimpleCache<string>({ ttlMs: 1000, maxEntries: 10 });
    c.set("k", "v");
    expect(c.get("k")).toBe("v");
  });

  it("expires after ttl", () => {
    let now = 0;
    const c = new SimpleCache<string>({ ttlMs: 1000, maxEntries: 10, now: () => now });
    c.set("k", "v");
    now = 500;
    expect(c.get("k")).toBe("v");
    now = 1500;
    expect(c.get("k")).toBeUndefined();
  });

  it("evicts LRU when over maxEntries", () => {
    const c = new SimpleCache<string>({ ttlMs: 10000, maxEntries: 3 });
    c.set("a", "1");
    c.set("b", "2");
    c.set("c", "3");
    c.get("a"); // touch a (most recently used)
    c.set("d", "4"); // should evict b (oldest not-touched)
    expect(c.get("a")).toBe("1");
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe("3");
    expect(c.get("d")).toBe("4");
  });

  it("stats track hits/misses/evictions", () => {
    const c = new SimpleCache<string>({ ttlMs: 1000, maxEntries: 2 });
    c.set("a", "1");
    c.get("a");
    c.get("a");
    c.get("nope");
    c.set("b", "2");
    c.set("c", "3"); // evicts a
    const s = c.stats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBeGreaterThanOrEqual(1);
    expect(s.evictions).toBeGreaterThanOrEqual(1);
    expect(s.size).toBe(2);
  });
});

describe("normalizeQueryForCache", () => {
  it("trims and collapses whitespace", () => {
    expect(normalizeQueryForCache("  hello   world  ")).toBe("hello world");
  });
  it("lowercases", () => {
    expect(normalizeQueryForCache("Hello WORLD")).toBe("hello world");
  });
  it("truncates to 200", () => {
    const s = "x".repeat(500);
    expect(normalizeQueryForCache(s).length).toBe(200);
  });
  it("stable across CJK (no case)", () => {
    expect(normalizeQueryForCache("日本人 披肩")).toBe("日本人 披肩");
  });
});

describe("buildAiCacheKey", () => {
  it("same query+model+wire+version yields same key", () => {
    const k1 = buildAiCacheKey({ query: "x", model: "m", wireApi: "anthropic", version: "v1" });
    const k2 = buildAiCacheKey({ query: "x", model: "m", wireApi: "anthropic", version: "v1" });
    expect(k1).toBe(k2);
  });
  it("different version yields different key", () => {
    const k1 = buildAiCacheKey({ query: "x", model: "m", wireApi: "anthropic", version: "v1" });
    const k2 = buildAiCacheKey({ query: "x", model: "m", wireApi: "anthropic", version: "v2" });
    expect(k1).not.toBe(k2);
  });
  it("different query yields different key", () => {
    const k1 = buildAiCacheKey({ query: "x", model: "m", wireApi: "anthropic", version: "v1" });
    const k2 = buildAiCacheKey({ query: "y", model: "m", wireApi: "anthropic", version: "v1" });
    expect(k1).not.toBe(k2);
  });
});
