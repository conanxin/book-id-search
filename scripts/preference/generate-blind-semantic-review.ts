import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type Lane = "CORE" | "ADJACENT" | "DISTANT" | "SURPRISE";

interface Intent {
  code: string;
  lane: Lane;
  seedId: string;
  seed: string;
  description: string;
}

interface SearchItem {
  id?: unknown;
  title?: unknown;
  author?: unknown;
  publisher?: unknown;
  year?: unknown;
}

interface SearchResponse {
  items?: SearchItem[];
}

const baseUrl = (process.env.PREF_SMOKE_BASE_URL ?? "https://books.conanxin.com").replace(/\/$/, "");
const outputDir = path.resolve("reports/preference-sovereignty");
const sampleIndexes = [0, 4, 9, 14];

const intents: Intent[] = [
  {
    code: "I1",
    lane: "CORE",
    seedId: "core-ancient-road",
    seed: "古道",
    description: "历史道路、古道网络、路线演变及可用于田野/历史地理研究的资料。",
  },
  {
    code: "I2",
    lane: "CORE",
    seedId: "core-transport-gazetteer",
    seed: "交通志",
    description: "地方交通志、交通基础设施沿革及可用于道路史/区域史研究的资料。",
  },
  {
    code: "I3",
    lane: "CORE",
    seedId: "core-temple",
    seed: "寺庙",
    description: "寺庙的建筑、地方社会、历史沿革、调查或物质遗存研究，而非仅泛文化/奇观读物。",
  },
  {
    code: "I4",
    lane: "ADJACENT",
    seedId: "adj-environmental-history",
    seed: "环境史",
    description: "以历史方法研究人—自然关系、环境变迁、灾害、资源或生态社会史。",
  },
  {
    code: "I5",
    lane: "ADJACENT",
    seedId: "adj-infrastructure-history",
    seed: "基础设施史",
    description: "把基础设施、工程或技术系统作为历史对象，关注其形成、演化和空间/社会影响；不等同于当代融资或管理。",
  },
  {
    code: "I6",
    lane: "DISTANT",
    seedId: "dist-material-culture",
    seed: "物质文化",
    description: "物质文化、器物、materiality、物的社会生命等研究；单纯“非物质文化遗产”不自动算符合。",
  },
  {
    code: "I7",
    lane: "DISTANT",
    seedId: "dist-social-memory",
    seed: "社会记忆",
    description: "社会/集体记忆、记忆的传承与建构，以及相关历史社会研究。",
  },
  {
    code: "I8",
    lane: "SURPRISE",
    seedId: "surprise-meteorological-history",
    seed: "气象史",
    description: "气象、天气知识、观测、制度与科学实践的历史。",
  },
];

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function year(value: unknown): string | number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function search(seed: string): Promise<SearchItem[]> {
  const url = new URL("/api/search", baseUrl);
  url.searchParams.set("q", seed);
  url.searchParams.set("limit", "20");
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET /api/search failed with HTTP ${response.status}`);
  const body = (await response.json()) as SearchResponse;
  return Array.isArray(body.items) ? body.items : [];
}

async function main() {
  const blindRows: Array<{
    reviewId: string;
    intentCode: string;
    title: string;
    author: string | null;
    publisher: string | null;
    year: string | number | null;
  }> = [];
  const answerKey: Array<{
    reviewId: string;
    intentCode: string;
    lane: Lane;
    seedId: string;
    seed: string;
    originalRank: number;
    catalogId: string;
  }> = [];

  for (const intent of intents) {
    const items = await search(intent.seed);
    if (items.length < 15) {
      throw new Error(`${intent.code} returned only ${items.length} items; need at least 15`);
    }

    for (const index of sampleIndexes) {
      const item = items[index];
      const catalogId = asText(item.id);
      if (!/^[0-9]+_[0-9]{12}$/.test(catalogId)) {
        throw new Error(`invalid catalogId for ${intent.code} rank ${index + 1}`);
      }
      const reviewId = "R-" + hash(`${intent.seedId}|${catalogId}|pref-exp-1d3-v0.1`).slice(0, 10).toUpperCase();
      blindRows.push({
        reviewId,
        intentCode: intent.code,
        title: asText(item.title),
        author: asText(item.author) || null,
        publisher: asText(item.publisher) || null,
        year: year(item.year),
      });
      answerKey.push({
        reviewId,
        intentCode: intent.code,
        lane: intent.lane,
        seedId: intent.seedId,
        seed: intent.seed,
        originalRank: index + 1,
        catalogId,
      });
    }
  }

  blindRows.sort((a, b) =>
    hash(`blind-order-v0.1|${a.reviewId}`).localeCompare(hash(`blind-order-v0.1|${b.reviewId}`))
  );

  await mkdir(outputDir, { recursive: true });

  const reviewPackage = {
    protocol: "PREF-EXP-1D3-v0.1",
    source: baseUrl,
    generatedAt: new Date().toISOString(),
    sampling: {
      intents: intents.length,
      samplesPerIntent: sampleIndexes.length,
      originalRanksSampled: sampleIndexes.map((x) => x + 1),
      total: blindRows.length,
      ordering: "deterministic SHA-256 shuffle",
    },
    rubric: {
      FIT: "3 — 明确符合该研究意图，可直接作为候选。",
      ADJACENT_FIT: "2 — 不完全直接，但对该研究意图有明显方法或材料价值。",
      LEXICAL_ONLY: "1 — 主要是词面命中，概念/研究对象不符合。",
      WRONG_SENSE: "0 — 明显属于错误语义或无关方向。",
      UNSURE: "? — 仅凭书目元数据不足以判断。",
      actionable: "YES / NO / UNSURE — 是否值得进入查目录/找页/获取全书的下一步。",
    },
    intents: intents.map(({ code, description }) => ({ code, description })),
    candidates: blindRows,
    boundaries: {
      originalSeedHiddenFromReviewRows: true,
      originalRankHiddenFromReviewRows: true,
      productionWrites: false,
      privateData: false,
      llmCalls: false,
    },
  };

  const md: string[] = [];
  md.push("# PREF-EXP-1D3 Blind Semantic Fit Review");
  md.push("");
  md.push("## Rubric");
  md.push("- **3 / FIT**：明确符合研究意图，可直接作为候选。");
  md.push("- **2 / ADJACENT_FIT**：不完全直接，但有明显方法或材料价值。");
  md.push("- **1 / LEXICAL_ONLY**：主要是词面命中，概念/研究对象不符合。");
  md.push("- **0 / WRONG_SENSE**：明显属于错误语义或无关方向。");
  md.push("- **? / UNSURE**：仅凭书目元数据不足以判断。");
  md.push("- **Actionable**：YES / NO / UNSURE，是否值得查目录/找页/获取全书。");
  md.push("");
  md.push("## Intent legend");
  for (const intent of intents) md.push(`- **${intent.code}**：${intent.description}`);
  md.push("");
  md.push("## Review sheet");
  md.push("| Review ID | Intent | Title | Author | Publisher / Year | Fit (3/2/1/0/?) | Actionable | Notes |");
  md.push("|---|---|---|---|---|---|---|---|");
  for (const row of blindRows) {
    const pubYear = [row.publisher, row.year].filter((x) => x !== null && x !== "").join("｜");
    md.push(
      `| ${row.reviewId} | ${row.intentCode} | ${row.title.replace(/\|/g, "／")} | ${(row.author ?? "").replace(/\|/g, "／")} | ${String(pubYear).replace(/\|/g, "／")} |  |  |  |`
    );
  }

  await writeFile(
    path.join(outputDir, "pref-exp-1d3-blind-review.json"),
    JSON.stringify(reviewPackage, null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(outputDir, "pref-exp-1d3-blind-review.md"),
    md.join("\n") + "\n",
    "utf8"
  );
  await writeFile(
    path.join(outputDir, "pref-exp-1d3-answer-key.json"),
    JSON.stringify(
      {
        protocol: "PREF-EXP-1D3-v0.1",
        warning: "Do not open before semantic review is completed.",
        key: answerKey,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(
    JSON.stringify(
      {
        status: blindRows.length === 32 ? "PASS" : "FAIL",
        totalCandidates: blindRows.length,
        intents: intents.length,
        samplesPerIntent: sampleIndexes.length,
        reviewPath: "reports/preference-sovereignty/pref-exp-1d3-blind-review.md",
        answerKeyPath: "reports/preference-sovereignty/pref-exp-1d3-answer-key.json",
        productionWrites: false,
        privateData: false,
      },
      null,
      2
    )
  );

  if (blindRows.length !== 32) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "ERROR", message: error instanceof Error ? error.message : "unknown" }, null, 2));
  process.exitCode = 1;
});
