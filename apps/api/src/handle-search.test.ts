import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { handleSearch } from "./index.js";

function mockReq(q: string): Request {
  return { query: { q } } as unknown as Request;
}

function mockRes() {
  const res: { statusCode: number; body: unknown; status: (s: number) => typeof res; json: (b: unknown) => typeof res } = {
    statusCode: 200,
    body: null,
    status(s: number) {
      this.statusCode = s;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
  return res as unknown as Response;
}

function mockMeili() {
  // Simulate an index with NO sortable attributes configured (the S16B
  // --sortable-profile minimal configuration). Any call to search with
  // sort:["year:desc"] would throw a Meilisearch 500.
  const search = vi.fn(async () => {
    throw new Error("Attribute `year` is not sortable. This index does not have configured sortable attributes.");
  });
  return { search };
}

const isExactLikeImpl = (q: string) => /^[0-9X]{7,20}$/.test(q);
const exactSearchImpl = vi.fn(async () => [] as any[]);

describe("handleSearch — empty query", () => {
  it("returns 200 with empty payload, never calls meili.search", async () => {
    const meili = mockMeili();
    const req = mockReq("");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect(res.statusCode).toBe(200);
    expect(meili.search).not.toHaveBeenCalled();
    expect(res.body).toEqual({ query: "", page: 1, limit: 20, total: 0, items: [] });
  });

  it("trims whitespace before treating as empty", async () => {
    const meili = mockMeili();
    const req = mockReq("   ");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect(meili.search).not.toHaveBeenCalled();
    expect((res.body as any).total).toBe(0);
  });
});

describe("handleSearch — non-empty query", () => {
  it("ISBN search delegates to meili.search and returns hits", async () => {
    const meili = {
      search: vi.fn(async () => ({
        estimatedTotalHits: 1,
        hits: [{ id: "13000000_000008232537", title: "时尚秋冬披肩、吊带", isbn: "9787538455250" }],
      })),
    };
    const req = mockReq("9787538455250");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect(meili.search).toHaveBeenCalledWith("9787538455250", { limit: 20, offset: 0 });
    expect((res.body as any).total).toBe(1);
    expect((res.body as any).items[0].title).toBe("时尚秋冬披肩、吊带");
  });

  it("title search returns correct total and items", async () => {
    const meili = {
      search: vi.fn(async () => ({
        estimatedTotalHits: 2955,
        hits: [{ id: "x1", title: "时尚秋冬毛衣编织  精选款" }, { id: "x2", title: "时尚秋冬女装" }],
      })),
    };
    const req = mockReq("时尚秋冬");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect(meili.search).toHaveBeenCalledWith("时尚秋冬", { limit: 20, offset: 0 });
    expect((res.body as any).total).toBe(2955);
    expect((res.body as any).items).toHaveLength(2);
  });

  it("does NOT depend on year being sortable", async () => {
    // Regression test for S16D-lite: previously the empty-query branch
    // called index.search with sort:["year:desc"], which throws on the
    // minimal index. We assert here that no code path in handleSearch
    // passes a sort parameter to meili.search.
    const meili = {
      search: vi.fn(async () => ({ estimatedTotalHits: 0, hits: [] })),
    };
    const req = mockReq("时尚秋冬");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    const callArgs = meili.search.mock.calls[0][1];
    expect(callArgs).not.toHaveProperty("sort");
  });

  it("returns 500 with friendly message on meili error", async () => {
    const meili = mockMeili(); // throws "year not sortable" on any search
    const req = mockReq("hello");
    const res = mockRes();
    await handleSearch(req, res, meili, exactSearchImpl, isExactLikeImpl);
    expect(res.statusCode).toBe(500);
    expect((res.body as any).error.message).toMatch(/搜索失败/);
  });
});
