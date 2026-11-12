import { defineConfig } from "@playwright/test";

const origin = "http://127.0.0.1:13134";

export default defineConfig({
  testDir: "./scripts",
  testMatch: "book-search-pagination.browser.ts",
  outputDir: "test-results/search-pagination",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  use: {
    baseURL: origin,
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.BOOK_SEARCH_BROWSER_EXECUTABLE
      ? { executablePath: process.env.BOOK_SEARCH_BROWSER_EXECUTABLE }
      : undefined,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  // Build the Web app first. The spec supplies public API responses in the
  // browser; this focused journey needs no database, API server or login.
  webServer: {
    command: "corepack pnpm --filter @book-id-search/web preview --port 13134 --strictPort",
    url: origin,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
