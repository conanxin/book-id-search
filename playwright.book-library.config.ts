import { randomUUID } from "node:crypto";
import { defineConfig } from "@playwright/test";

const runId = process.env.BOOK_LIBRARY_BROWSER_RUN_ID ?? randomUUID();
process.env.BOOK_LIBRARY_BROWSER_RUN_ID = runId;
const databaseUrl = process.env.S32_LIBRARY_TEST_DATABASE_URL ?? "postgresql://s32_app:library-app-test-only@127.0.0.1:5432/s32_library_test";
process.env.S32_LIBRARY_TEST_DATABASE_URL = databaseUrl;
const sessionSecret = "book-library-synthetic-session-secret-for-local-ci-only";
const scope = process.env.BOOK_LIBRARY_BROWSER_SCOPE ?? "all";
if (!["all", "weread"].includes(scope)) throw new Error("BOOK_LIBRARY_BROWSER_SCOPE_MUST_BE_ALL_OR_WEREAD");

export default defineConfig({
  testDir: "./scripts",
  testMatch: scope === "weread" ? "book-weread-browser.spec.ts" : [
    "book-library-browser.spec.ts", "book-weread-browser.spec.ts", "book-weread-bindings-browser.spec.ts", "book-ai-browser.spec.ts", "book-web-research-browser.spec.ts",
  ],
  outputDir: "test-results/book-library",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "test-results/book-library-report", open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:5173",
    browserName: "chromium", headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure", screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node --import tsx scripts/book-library-test-api.ts",
      url: "http://127.0.0.1:3001/api/health",
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        NODE_ENV: "development", BOOK_LIBRARY_TEST_ONLY: "YES", BOOK_LIBRARY_BROWSER_RUN_ID: runId,
        BOOK_LIBRARY_BROWSER_SCOPE: scope,
        S32_LIBRARY_TEST_DATABASE_URL: databaseUrl, GOOGLE_AUTH_ENABLED: "true",
        GOOGLE_CLIENT_ID: "book-library-browser-test.apps.googleusercontent.com",
        BOOK_ID_SEARCH_OWNER_GOOGLE_SUB: "book-library-test-owner",
        BOOK_ID_SEARCH_SESSION_SECRET: sessionSecret,
        BOOK_ID_SEARCH_PUBLIC_ORIGIN: "http://127.0.0.1:5173",
      },
    },
    {
      command: "pnpm --filter @book-id-search/web dev --port 5173 --strictPort",
      url: "http://127.0.0.1:5173",
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        VITE_API_BASE_URL: "/api",
        // The spec injects a real signed session cookie; it does not load GIS
        // or pretend a browser-owned Google OAuth login occurred.
        VITE_GOOGLE_CLIENT_ID: "",
        VITE_S32_RESEARCH_ENABLED: "false",
      },
    },
  ],
});
