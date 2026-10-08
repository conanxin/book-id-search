/**
 * Gate 3 Task 5 — test-only synthetic owner-session issuer.
 * Uses the REAL apps/api issueWebSession under an ephemeral per-run secret.
 * Prints {"token": "...", "csrf": "..."} on stdout; never logs the secret.
 * Usage: tsx scripts/s32-m3a-gate3-browser-session.ts <sessionSecret> <ownerSub>
 */
import { issueWebSession } from "../apps/api/src/auth/web-session.js";

const [, , secret, sub] = process.argv;
if (!secret || !sub) {
  console.error("usage: s32-m3a-gate3-browser-session.ts <sessionSecret> <ownerSub>");
  process.exit(2);
}
const { token, payload } = issueWebSession(
  { sub, email: "gate3-owner@example.com", name: "Gate3 Browser Owner" },
  { secret, ttlSeconds: 8 * 60 * 60 },
);
process.stdout.write(JSON.stringify({ token, csrf: payload.csrf }));
