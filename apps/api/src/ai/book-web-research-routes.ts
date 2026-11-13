import { Router, json, type ErrorRequestHandler } from "express";
import type { S32RequestAuthorizer } from "../s32/routes/private-auth.js";
import { BookWebResearchError, type BookWebResearchService } from "./book-web-research.js";
import { BookWebSourceError, type BookWebSourceReader } from "./book-web-source.js";
import { BookWebSourceEvidenceError, type BookWebSourceEvidenceService } from "./book-web-source-evidence.js";
import { BookWebSourceComparisonError, type BookWebSourceComparisonService } from "./book-web-source-comparison.js";

/** Mount at /api/ai/books/:bookId/research before the assistant/global parser. */
export function createBookWebResearchRouter(deps: {
  service: BookWebResearchService;
  sourceReader?: BookWebSourceReader;
  sourceEvidence?: BookWebSourceEvidenceService;
  sourceComparison?: BookWebSourceComparisonService;
  requestAuthorizer?: S32RequestAuthorizer;
}) {
  const router = Router({ mergeParams: true });
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.vary("Cookie");
    if (!deps.requestAuthorizer) {
      res.status(503).json({ error: { code: "BOOK_RESEARCH_AUTH_UNAVAILABLE", message: "Google 登录尚未配置。" } }); return;
    }
    const auth = deps.requestAuthorizer(req);
    if (!auth.ok) {
      res.status(auth.status).json({ error: { code: "BOOK_RESEARCH_AUTH_REQUIRED", message: auth.message } }); return;
    }
    next();
  });
  router.use(json({ limit: "16kb" }));
  const invalidJson: ErrorRequestHandler = (_error, req, res, _next) => {
    res.status(400).json({ error: { code: req.path === "/sources/evidence" ? "BOOK_COMPARISON_INVALID_INPUT"
      : req.path === "/source/evidence" ? "BOOK_EVIDENCE_INVALID_INPUT"
      : req.path === "/source" ? "BOOK_SOURCE_INVALID_INPUT" : "BOOK_RESEARCH_INVALID_INPUT",
      message: "请求内容必须是有效的 JSON，且不能超过 16 KiB。" } });
  };
  router.use(invalidJson);
  router.post<{ bookId: string }>("/sources/evidence", async (req, res) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableFinished) controller.abort(); };
    const usable = () => !controller.signal.aborted && !res.destroyed && !res.writableEnded;
    res.once("close", cancel);
    if (res.destroyed) controller.abort();
    try {
      if (!deps.sourceComparison) throw new BookWebSourceComparisonError("BOOK_COMPARISON_UNAVAILABLE");
      const result = await deps.sourceComparison.compare(req.params.bookId, req.body, { signal: controller.signal });
      if (usable()) res.json(result);
    } catch (error) {
      if (usable()) {
        const safe = error instanceof BookWebSourceComparisonError ? error : new BookWebSourceComparisonError("BOOK_COMPARISON_UNAVAILABLE");
        res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
      }
    } finally { res.off("close", cancel); }
  });
  router.post<{ bookId: string }>("/source/evidence", async (req, res) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableFinished) controller.abort(); };
    const usable = () => !controller.signal.aborted && !res.destroyed && !res.writableEnded;
    res.once("close", cancel);
    if (res.destroyed) controller.abort();
    try {
      if (!deps.sourceEvidence) throw new BookWebSourceEvidenceError("BOOK_EVIDENCE_UNAVAILABLE");
      const result = await deps.sourceEvidence.find(req.params.bookId, req.body, { signal: controller.signal });
      if (usable()) res.json(result);
    } catch (error) {
      if (usable()) {
        const safe = error instanceof BookWebSourceEvidenceError ? error : new BookWebSourceEvidenceError("BOOK_EVIDENCE_UNAVAILABLE");
        res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
      }
    } finally { res.off("close", cancel); }
  });
  router.post<{ bookId: string }>("/source", async (req, res) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableFinished) controller.abort(); };
    const usable = () => !controller.signal.aborted && !res.destroyed && !res.writableEnded;
    res.once("close", cancel);
    if (res.destroyed) controller.abort();
    try {
      if (!deps.sourceReader) throw new BookWebSourceError("BOOK_SOURCE_UNAVAILABLE");
      const result = await deps.sourceReader.read(req.params.bookId, req.body, { signal: controller.signal });
      if (usable()) res.json(result);
    } catch (error) {
      if (usable()) {
        const safe = error instanceof BookWebSourceError ? error : new BookWebSourceError("BOOK_SOURCE_UNAVAILABLE");
        res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
      }
    } finally { res.off("close", cancel); }
  });
  router.post<{ bookId: string }>("/", async (req, res) => {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableFinished) controller.abort(); };
    const usable = () => !controller.signal.aborted && !res.destroyed && !res.writableEnded;
    res.once("close", cancel);
    if (res.destroyed) controller.abort();
    try {
      const result = await deps.service.research(req.params.bookId, req.body, { signal: controller.signal });
      if (usable()) res.json(result);
    } catch (error) {
      if (usable()) {
        const safe = error instanceof BookWebResearchError ? error : new BookWebResearchError("BOOK_RESEARCH_UNAVAILABLE");
        res.status(safe.status).json({ error: { code: safe.code, message: safe.message } });
      }
    } finally { res.off("close", cancel); }
  });
  return router;
}
