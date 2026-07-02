/**
 * ai-probe — MiniMax Token Plan wire API auto-detector.
 *
 * Tests each wire API (responses → anthropic → openai_chat) with a tiny request,
 * reports which one works, and outputs the recommended env vars.
 *
 * Usage:
 *   pnpm run ai-probe
 *   pnpm run ai-probe responses
 *   pnpm run ai-probe auto
 *
 * The 'auto' mode tests all three and returns the first working one.
 *
 * Never prints the API key.
 */

import "dotenv/config";
import { chatCompletion, resolveMiniMaxConfig, isAiEnabled, type WireApi } from "../apps/api/src/ai/minimax";

const TEST_PROMPT = 'Return only valid JSON: {"ok":true}';

const WIRE_ORDER: WireApi[] = ["responses", "anthropic", "openai_chat"];

type ProbeResult = {
  wire: WireApi;
  baseUrl: string;
  model: string;
  working: boolean;
  status: number;
  error?: string;
  content?: string;
};

async function probeOne(wire: WireApi): Promise<ProbeResult> {
  // Resolve base config then override wire
  const baseConfig = resolveMiniMaxConfig();
  if (!baseConfig) {
    return { wire, baseUrl: "", model: "", working: false, status: 503, error: "MINIMAX_API_KEY not configured" };
  }

  // For anthropic, use the dedicated base URL if not set
  let baseUrl = baseConfig.baseUrl;
  if (wire === "anthropic" && !baseUrl.includes("anthropic")) {
    baseUrl = "https://api.minimaxi.com/anthropic";
  }

  const config = { ...baseConfig, baseUrl, wireApi: wire };
  const messages = [
    { role: "system" as const, content: "You are a helpful assistant that returns only JSON." },
    { role: "user" as const, content: TEST_PROMPT },
  ];

  console.log(`🔍 testing ${wire.padEnd(12)} at ${baseUrl} ...`);
  const r = await chatCompletion(messages, { config });
  if (r.ok) {
    return { wire, baseUrl, model: config.model, working: true, status: 200, content: r.content.slice(0, 100) };
  }
  return { wire, baseUrl, model: config.model, working: false, status: r.status, error: r.error };
}

function printResult(r: ProbeResult) {
  const wire = r.wire.padEnd(12);
  const status = r.working ? `✅ PASS (HTTP ${r.status})` : `❌ FAIL (HTTP ${r.status})`;
  console.log(`  ${wire} ${status}`);
  if (!r.working && r.error) {
    console.log(`       ${r.error}`);
  }
  if (r.working && r.content) {
    console.log(`       content: ${r.content}`);
  }
}

async function main() {
  const mode = (process.argv[2] || "auto").toLowerCase() as "auto" | WireApi;

  console.log("=");
  console.log("📡 MiniMax Token Plan Wire API Probe");
  console.log("=");

  if (!isAiEnabled()) {
    console.log("❌ AI_FEATURES_ENABLED is not true OR MINIMAX_API_KEY is missing");
    process.exit(1);
  }

  const baseConfig = resolveMiniMaxConfig()!;
  console.log(`Model: ${baseConfig.model}`);
  console.log(`API key configured: yes (length: ${baseConfig.apiKey.length})`);
  console.log();

  if (mode === "auto") {
    console.log("🔧 Testing all three wire APIs in order: responses → anthropic → openai_chat");
    console.log();

    const results: ProbeResult[] = [];
    let firstWorking: ProbeResult | null = null;

    for (const wire of WIRE_ORDER) {
      const r = await probeOne(wire);
      results.push(r);
      if (r.working && !firstWorking) {
        firstWorking = r;
      }
    }

    console.log();
    console.log("=");
    console.log("Summary");
    console.log("=");
    results.forEach(printResult);
    console.log();

    if (firstWorking) {
      console.log(`✅ Found working wire API: ${firstWorking.wire}`);
      console.log();
      console.log("Recommended env vars:");
      console.log("  AI_FEATURES_ENABLED=true");
      console.log(`  MINIMAX_WIRE_API=${firstWorking.wire}`);
      console.log(`  MINIMAX_BASE_URL=${firstWorking.baseUrl}`);
      console.log(`  MINIMAX_MODEL=${firstWorking.model}`);
      console.log("  MINIMAX_API_KEY=... (keep as is)");
    } else {
      console.log("❌ None of the three wire APIs worked.");
      console.log();
      console.log("Troubleshooting:");
      console.log("  1. Is your MINIMAX_API_KEY correct? (paste it from Token Plan)");
      console.log("  2. Are you using the correct Token Plan model name? (MiniMax-M3 / MiniMax-M4)");
      console.log("  3. Is your subscription active and has available tokens?");
      console.log("  4. Try the exact base URLs from Token Plan docs:");
      console.log("       https://api.minimaxi.com/v1 (for responses wire)");
      console.log("       https://api.minimaxi.com/anthropic (for anthropic wire)");
      process.exit(1);
    }
  } else if (WIRE_ORDER.includes(mode as WireApi)) {
    const wire = mode as WireApi;
    console.log(`🔧 Testing single wire API: ${wire}`);
    console.log();

    const r = await probeOne(wire);
    printResult(r);

    if (r.working) {
      console.log();
      console.log("✅ This wire API works.");
      console.log();
      console.log("Recommended env vars:");
      console.log("  AI_FEATURES_ENABLED=true");
      console.log(`  MINIMAX_WIRE_API=${r.wire}`);
      console.log(`  MINIMAX_BASE_URL=${r.baseUrl}`);
      console.log(`  MINIMAX_MODEL=${r.model}`);
      console.log("  MINIMAX_API_KEY=... (keep as is)");
    } else {
      console.log();
      console.log("❌ This wire API failed. Try 'auto' to test all.");
      process.exit(1);
    }
  } else {
    console.log(`❌ Unknown mode: ${mode}`);
    console.log(`   Use: auto | responses | anthropic | openai_chat`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
