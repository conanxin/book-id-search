import "dotenv/config";
import process from "node:process";
import { MeiliSearch } from "meilisearch";

interface BookDocument {
  id: string;
  ssid: string;
  dxid: string;
  title: string;
  author: string;
  publisher: string;
  isbn: string;
}

const host = process.env.MEILI_HOST ?? "http://127.0.0.1:7700";
const apiKey = process.env.MEILI_MASTER_KEY;
const indexName = process.env.MEILI_INDEX ?? "books";

async function verify() {
  const client = new MeiliSearch({ host, apiKey });
  const health = await client.health();
  if (health.status !== "available") throw new Error(`Meilisearch 不可用：${JSON.stringify(health)}`);

  const index = client.index<BookDocument>(indexName);
  const stats = await index.getStats();
  if (!stats.numberOfDocuments) throw new Error(`索引 ${indexName} 没有文档，请先导入样例或真实数据`);

  const seed = await index.search("", { limit: 20 });
  const first = seed.hits.find((book) => book.ssid && book.dxid && book.title) ?? seed.hits[0];
  if (!first) throw new Error(`索引 ${indexName} 没有可验证的样本文档`);

  const checks = [
    { label: "SSID", q: first.ssid },
    { label: "DXID", q: first.dxid },
    ...(first.isbn ? [{ label: "ISBN", q: first.isbn }] : []),
    { label: "书名", q: first.title.slice(0, 12) },
    ...(first.author ? [{ label: "作者", q: first.author.slice(0, 12) }] : []),
    ...(first.publisher ? [{ label: "出版社", q: first.publisher.replace(/^.*：/, "").slice(0, 12) }] : [])
  ].filter((check) => check.q);

  const results = [];
  for (const check of checks) {
    const result = await index.search(check.q, { limit: 5 });
    results.push({ ...check, hits: result.hits.length });
    if (!result.hits.length) throw new Error(`搜索验证失败：${check.label} ${check.q}`);
  }

  console.log(
    JSON.stringify(
      {
        status: "PASS",
        meili: host,
        index: indexName,
        numberOfDocuments: stats.numberOfDocuments,
        checks: results
      },
      null,
      2
    )
  );
}

verify().catch((error) => {
  console.error(`[verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
