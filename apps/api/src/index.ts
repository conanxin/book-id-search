import cors from "cors";
import dotenv from "dotenv";
import express, { type Request, type Response } from "express";
import { MeiliSearch } from "meilisearch";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "../../../");
dotenv.config({ path: path.join(projectRoot, ".env") });
dotenv.config();

interface BookDocument {
  id: string;
  ssid: string;
  dxid: string;
  title: string;
  author: string;
  publisher: string;
  year: number | null;
  pages: number | null;
  isbn: string;
  rawInfo: string;
  parseStatus: "ok" | "weak" | "failed";
  parseWarnings: string[];
}

const port = Number.parseInt(process.env.API_PORT ?? "3001", 10);
const host = process.env.MEILI_HOST ?? "http://127.0.0.1:7700";
const apiKey = process.env.MEILI_MASTER_KEY;
const indexName = process.env.MEILI_INDEX ?? "books";

const app = express();
const client = new MeiliSearch({ host, apiKey });
const index = client.index<BookDocument>(indexName);

app.use(cors());
app.use(express.json());

function normalizeToken(value: string) {
  return value.replace(/[\s-]+/g, "").toUpperCase();
}

function isExactLike(value: string) {
  const normalized = normalizeToken(value);
  return /^[0-9X]{7,20}$/.test(normalized);
}

function readPagination(req: Request) {
  const page = Math.max(Number.parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
  const requestedLimit = Number.parseInt(String(req.query.limit ?? "20"), 10) || 20;
  const limit = Math.min(Math.max(requestedLimit, 1), 100);
  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

function sendError(res: Response, status: number, message: string, detail?: unknown) {
  res.status(status).json({
    error: {
      message,
      detail: detail instanceof Error ? detail.message : detail
    }
  });
}

function readJsonReport<T>(relativePath: string): T | null {
  const fullPath = path.join(projectRoot, relativePath);
  if (!existsSync(fullPath)) return null;
  try {
    return JSON.parse(readFileSync(fullPath, "utf8")) as T;
  } catch {
    return null;
  }
}

async function exactSearch(q: string, limit: number) {
  const normalized = normalizeToken(q);
  const result = await index.search(q, {
    limit: Math.max(limit, 100),
    attributesToSearchOn: ["ssid", "dxid", "isbn"]
  });

  return result.hits.filter((book) => {
    return (
      normalizeToken(book.ssid) === normalized ||
      normalizeToken(book.dxid) === normalized ||
      normalizeToken(book.isbn) === normalized
    );
  });
}

app.get("/api/health", async (_req, res) => {
  try {
    const health = await client.health();
    res.json({ ok: health.status === "available", meili: health, index: indexName });
  } catch (error) {
    sendError(res, 503, "Meilisearch 暂不可用，请确认服务已启动。", error);
  }
});

app.get("/api/search", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const { page, limit, offset } = readPagination(req);

  try {
    if (!q) {
      const result = await index.search("", { limit, offset, sort: ["year:desc"] });
      return res.json({
        total: result.estimatedTotalHits ?? result.hits.length,
        page,
        limit,
        items: result.hits
      });
    }

    if (isExactLike(q)) {
      const exactHits = await exactSearch(q, limit);
      if (exactHits.length) {
        return res.json({
          total: exactHits.length,
          page,
          limit,
          items: exactHits.slice(offset, offset + limit)
        });
      }
    }

    const result = await index.search(q, { limit, offset });
    return res.json({
      total: result.estimatedTotalHits ?? result.hits.length,
      page,
      limit,
      items: result.hits
    });
  } catch (error) {
    return sendError(res, 500, "搜索失败，请检查关键词或稍后重试。", error);
  }
});

app.get("/api/books/:id", async (req, res) => {
  try {
    const book = await index.getDocument(req.params.id);
    res.json({ item: book });
  } catch (error) {
    sendError(res, 404, "未找到这本书。", error);
  }
});

async function addRelated(
  target: BookDocument[],
  seen: Set<string>,
  source: BookDocument,
  query: string,
  attributesToSearchOn: string[],
  maxItems: number
) {
  if (!query || target.length >= maxItems) return;
  const result = await index.search(query, { limit: maxItems * 4, attributesToSearchOn });
  for (const hit of result.hits) {
    if (hit.id === source.id || seen.has(hit.id)) continue;
    target.push(hit);
    seen.add(hit.id);
    if (target.length >= maxItems) return;
  }
}

app.get("/api/books/:id/related", async (req, res) => {
  try {
    const book = await index.getDocument(req.params.id);
    const related: BookDocument[] = [];
    const seen = new Set<string>();

    if (book.isbn) {
      const isbnHits = await exactSearch(book.isbn, 20);
      for (const hit of isbnHits) {
        if (hit.id === book.id || seen.has(hit.id)) continue;
        related.push(hit);
        seen.add(hit.id);
      }
    }

    await addRelated(related, seen, book, book.author, ["author"], 10);
    await addRelated(related, seen, book, book.publisher, ["publisher"], 10);
    await addRelated(related, seen, book, book.title.slice(0, 18), ["title"], 10);

    res.json({ total: related.length, items: related.slice(0, 10) });
  } catch (error) {
    sendError(res, 404, "获取相关图书失败。", error);
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    const stats = await index.getStats();
    res.json({
      index: indexName,
      indexName,
      numberOfDocuments: stats.numberOfDocuments,
      isIndexing: stats.isIndexing,
      stats,
      lastImportReport: readJsonReport("reports/latest-import-report.json"),
      parseQualityReport: readJsonReport("reports/parse-quality-audit.json")
    });
  } catch (error) {
    sendError(res, 500, "读取统计信息失败，请确认 Meilisearch 和报告文件状态。", error);
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
