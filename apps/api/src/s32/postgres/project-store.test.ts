import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createPostgresProjectStore } from "./project-store.js";
import { ProjectStoreUnavailableError } from "../application/projects.js";

describe("project store error boundary", () => {
  it.each(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "EPIPE", "08006", "57P01", "53300"])("classifies %s as unavailable", async (code) => {
    const store = createPostgresProjectStore({ query: vi.fn().mockRejectedValue(Object.assign(new Error("DB private details"), { code })) } as unknown as Pool);
    await expect(store.list()).rejects.toBeInstanceOf(ProjectStoreUnavailableError);
  });
  it("keeps other errors distinguishable from an empty result", async () => {
    const store = createPostgresProjectStore({ query: vi.fn().mockRejectedValue(new Error("SQL failure")) } as unknown as Pool);
    await expect(store.list()).rejects.toThrow("SQL failure");
  });
});
