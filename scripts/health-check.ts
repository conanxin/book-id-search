#!/usr/bin/env tsx
/**
 * S27T-5E-R6C Postverify smoke (self-contained).
 *
 * Verifies a Web service is serving HTTP 200 on the expected port. Used by the
 * Executor postverify section 15 as the canonical smoke gate.
 *
 * Contract:
 *   - Imports ONLY Node built-ins (node:http). No third-party deps.
 *   - Target host/port are configurable via env (ISOLATED_WEB_HOST, ISOLATED_WEB_PORT)
 *     so the same script works for production (127.0.0.1:5173) and isolated
 *     deployment (127.0.0.1:<FREE_PORT>).
 *   - Emits a single JSON object on stdout: {status: "up"|"down", timestamp, ...}
 *   - Exits 0 on status=up, 1 on status=down, 1 on error.
 *
 * Usage:
 *   node --experimental-strip-types scripts/health-check.ts
 *   ISOLATED_WEB_HOST=127.0.0.1 ISOLATED_WEB_PORT=61723 \
 *     node --experimental-strip-types scripts/health-check.ts
 */
import http from "node:http";

const PORT = parseInt(process.env.ISOLATED_WEB_PORT || process.env.WEB_PORT || "5173", 10);
const HOST = process.env.ISOLATED_WEB_HOST || process.env.WEB_HOST || "127.0.0.1";

function check(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = http.get(`http://${HOST}:${PORT}/`, (res) => {
        const ok = res.statusCode === 200;
        res.resume();
        resolve(ok);
      });
      req.on("error", () => resolve(false));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function main() {
  const ok = await check();
  const result = {
    status: ok ? "up" : "down",
    timestamp: new Date().toISOString(),
    target: `${HOST}:${PORT}`,
    service: "book-id-search-web",
  };
  console.log(JSON.stringify(result));
  process.exit(ok ? 0 : 1);
}

main().catch(() => {
  console.log(JSON.stringify({ status: "down", error: true }));
  process.exit(1);
});