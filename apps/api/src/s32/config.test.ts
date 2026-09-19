import { describe, expect, it } from "vitest";
import { readS32Config } from "./config.js";

describe("readS32Config", () => {
  it("is disabled by default and does not require a database URL", () => {
    expect(readS32Config({})).toEqual({
      enabled: false,
      databaseUrl: null,
      privateToken: null,
    });
  });

  it("reads explicit S32 settings without falling back to WeRead settings", () => {
    expect(readS32Config({
      S32_FEATURES_ENABLED: "true",
      S32_DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/db",
      S32_PRIVATE_API_TOKEN: "secret",
      WEREAD_PRIVATE_API_TOKEN: "must-not-be-used",
    })).toEqual({
      enabled: true,
      databaseUrl: "postgresql://u:p@127.0.0.1:5432/db",
      privateToken: "secret",
    });
  });
});
