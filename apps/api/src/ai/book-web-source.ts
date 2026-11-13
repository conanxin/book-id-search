import { randomBytes } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { BOOK_WEB_SOURCE_LIMITS as LIMITS, BookWebSourceError, checkSourceCancelled,
  type BookWebSourceFetcher, type BookWebSourcePage, type BookWebSourceResponse } from "./book-web-source-contract.js";
import { createPublicWebPageFetcher, parsePublicWebUrl } from "./web-source-fetch.js";
import { BOOK_WEB_SOURCE_EVIDENCE_LIMITS as EVIDENCE_LIMITS, BookWebSourceEvidenceError,
  type BookWebSourceSnapshot } from "./book-web-source-evidence-contract.js";

export { BookWebSourceError, BOOK_WEB_SOURCE_LIMITS } from "./book-web-source-contract.js";
export type { BookWebSourceFetcher, BookWebSourcePage, BookWebSourceResponse } from "./book-web-source-contract.js";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const skipped = new Set(["head", "script", "style", "noscript", "template", "iframe", "object", "embed",
  "canvas", "svg", "math", "form", "button", "input", "select", "textarea", "nav", "header", "footer", "aside"]);
const blocks = new Set(["address", "article", "blockquote", "br", "caption", "dd", "div", "dl", "dt", "figcaption",
  "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "main", "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul"]);

function children(node: Node): Node[] { return "childNodes" in node ? node.childNodes : []; }
function element(node: Node): node is Element { return "tagName" in node; }
function hidden(node: Element): boolean {
  return node.attrs.some(attr => attr.name === "hidden" || (attr.name === "aria-hidden" && attr.value.toLowerCase() === "true")
    || (attr.name === "style" && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(attr.value)));
}
function clean(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "\ufffd")
    .replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
function prefix(value: string, max: number): string {
  let end = Math.min(value.length, max);
  if (end > 0 && end < value.length && /[\ud800-\udbff]/.test(value[end - 1])) end--;
  return value.slice(0, end);
}
function collectText(root: Node): string {
  // Iterative traversal also handles deeply nested, untrusted HTML without
  // JavaScript execution, subresource requests or recursion-stack growth.
  const stack: Array<Node | string> = [root], output: string[] = [];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node === "string") { output.push(node); continue; }
    if (node.nodeName === "#text" && "value" in node) { output.push(node.value); continue; }
    if (element(node) && (skipped.has(node.tagName) || hidden(node))) continue;
    if (element(node) && node.tagName === "br") { output.push("\n"); continue; }
    const block = element(node) && blocks.has(node.tagName);
    if (block) { output.push("\n"); stack.push("\n"); }
    const nested = children(node);
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]);
  }
  return clean(output.join(""));
}

function decodePage(page: BookWebSourcePage): string {
  let charset = page.charset;
  const bytes = Buffer.from(page.body);
  if (!charset && page.contentType !== "text/plain") {
    const meta = /<meta\s+[^>]*charset\s*=\s*["']?\s*([a-z0-9._-]+)/i.exec(bytes.subarray(0, 4096).toString("latin1"));
    charset = meta?.[1];
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) charset = "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = "utf-16be";
  try { return new TextDecoder(charset || "utf-8").decode(bytes); }
  catch { throw new BookWebSourceError("BOOK_SOURCE_UNSUPPORTED"); }
}

function extract(page: BookWebSourcePage): { title: string; text: string } {
  const decoded = decodePage(page);
  if (/^\s*%PDF-/i.test(decoded)) throw new BookWebSourceError("BOOK_SOURCE_UNSUPPORTED");
  if (page.contentType === "text/plain") return { title: "", text: clean(decoded) };
  const document = parse(decoded), stack: Node[] = [document];
  let main: Node | undefined, article: Node | undefined, body: Node | undefined, title = "";
  while (stack.length) {
    const node = stack.pop()!;
    if (element(node)) {
      if (hidden(node)) continue;
      if (node.tagName === "title" && !title) title = collectText(node).replace(/\s+/g, " ");
      if (node.tagName === "main" && !main) main = node;
      if (node.tagName === "article" && !article) article = node;
      if (node.tagName === "body" && !body) body = node;
      if (["script", "style", "noscript", "template", "iframe", "svg", "math"].includes(node.tagName)) continue;
    }
    const nested = children(node);
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]);
  }
  const text = collectText(main ?? article ?? body ?? document);
  return { title, text: text || collectText(body ?? document) };
}

interface SourceGrant { bookId: string; sourceId: string; url: string; title: string; expiresAt: number }
export type BookWebSourceIdentity = { id: string; url: string; title: string };

/** Source grants are bounded, ephemeral and scoped to the chosen book/source.
 * No arbitrary client URL, database writer, provider call or persistent cache. */
export function createBookWebSourceReader(deps: { fetchPage?: BookWebSourceFetcher; now?: () => Date } = {}) {
  const grants = new Map<string, SourceGrant>();
  const snapshots = new Map<string, { value: BookWebSourceSnapshot; expiresAt: number }>();
  const fetchPage = deps.fetchPage ?? createPublicWebPageFetcher();
  const now = deps.now ?? (() => new Date());
  function prune(time: number): void {
    for (const [token, grant] of grants) if (grant.expiresAt <= time) grants.delete(token);
  }
  function pruneSnapshots(time: number): void {
    for (const [token, snapshot] of snapshots) if (snapshot.expiresAt <= time) snapshots.delete(token);
  }
  function rememberSnapshot(source: BookWebSourceResponse): string {
    const time = now().getTime();
    pruneSnapshots(time);
    while (snapshots.size >= EVIDENCE_LIMITS.SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
    let token: string;
    do { token = randomBytes(24).toString("base64url"); } while (snapshots.has(token));
    snapshots.set(token, { value: Object.freeze({ ...source, snapshotToken: token }),
      expiresAt: time + EVIDENCE_LIMITS.SNAPSHOT_TTL_MS });
    return token;
  }
  return {
    /** A request captures this immutable snapshot while its token is valid. */
    getSnapshot(bookId: unknown, snapshotToken: unknown): BookWebSourceSnapshot {
      if (typeof bookId !== "string" || bookId.length > 128 || !/^[0-9]+_[0-9]{12}$/.test(bookId)
        || typeof snapshotToken !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(snapshotToken)) {
        throw new BookWebSourceEvidenceError("BOOK_EVIDENCE_INVALID_INPUT");
      }
      pruneSnapshots(now().getTime());
      const snapshot = snapshots.get(snapshotToken);
      if (!snapshot) throw new BookWebSourceEvidenceError("BOOK_EVIDENCE_EXPIRED");
      if (snapshot.value.bookId !== bookId) throw new BookWebSourceEvidenceError("BOOK_EVIDENCE_INVALID_INPUT");
      return snapshot.value;
    },
    issueToken(bookId: string, source: BookWebSourceIdentity): string | undefined {
      if (!/^[0-9]+_[0-9]{12}$/.test(bookId) || bookId.length > 128 || !/^W(?:[1-9]|1[0-2])$/.test(source.id)
        || typeof source.title !== "string" || !source.title.trim()) return undefined;
      // A prohibited search link remains visible as an excerpt/link; it never
      // becomes an accepted fetch target or breaks the original search.
      const title = prefix(clean(source.title), LIMITS.TITLE_CHARS);
      if (!title) return undefined;
      let url: string;
      try { url = parsePublicWebUrl(source.url).href; } catch { return undefined; }
      const time = now().getTime();
      prune(time);
      while (grants.size >= LIMITS.TOKENS) grants.delete(grants.keys().next().value!);
      let token: string;
      do { token = randomBytes(24).toString("base64url"); } while (grants.has(token));
      grants.set(token, { bookId, sourceId: source.id, url, title,
        expiresAt: time + LIMITS.TOKEN_TTL_MS });
      return token;
    },
    async read(bookId: unknown, body: unknown, options: { signal?: AbortSignal } = {}): Promise<BookWebSourceResponse> {
      checkSourceCancelled(options.signal);
      if (typeof bookId !== "string" || bookId.length > 128 || !/^[0-9]+_[0-9]{12}$/.test(bookId)
        || !body || typeof body !== "object" || Array.isArray(body)
        || Object.keys(body).some(key => key !== "sourceToken")
        || !("sourceToken" in body) || typeof body.sourceToken !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(body.sourceToken)) {
        throw new BookWebSourceError("BOOK_SOURCE_INVALID_INPUT");
      }
      prune(now().getTime());
      const grant = grants.get(body.sourceToken);
      if (!grant) throw new BookWebSourceError("BOOK_SOURCE_EXPIRED");
      if (grant.bookId !== bookId) throw new BookWebSourceError("BOOK_SOURCE_INVALID_INPUT");
      let page: BookWebSourcePage;
      try { page = await fetchPage(grant.url, options); }
      catch (error) {
        checkSourceCancelled(options.signal);
        if (error instanceof BookWebSourceError) throw error;
        throw new BookWebSourceError("BOOK_SOURCE_UNAVAILABLE");
      }
      checkSourceCancelled(options.signal);
      if (page.body.byteLength > LIMITS.BODY_BYTES) throw new BookWebSourceError("BOOK_SOURCE_TOO_LARGE");
      if (!["text/html", "application/xhtml+xml", "text/plain"].includes(page.contentType)) throw new BookWebSourceError("BOOK_SOURCE_UNSUPPORTED");
      const finalUrl = parsePublicWebUrl(page.finalUrl).href;
      const extracted = extract(page);
      checkSourceCancelled(options.signal);
      if (!extracted.text) throw new BookWebSourceError("BOOK_SOURCE_UNREADABLE");
      const text = prefix(extracted.text, LIMITS.TEXT_CHARS);
      const result: BookWebSourceResponse = { bookId, sourceId: grant.sourceId, requestedUrl: grant.url, finalUrl,
        title: prefix(extracted.title || grant.title, LIMITS.TITLE_CHARS), text, contentType: page.contentType,
        extraction: page.contentType === "text/plain" ? "plain_text" : "html_readable_text",
        truncated: text.length < extracted.text.length, fetchedAt: now().toISOString() };
      return { ...result, snapshotToken: rememberSnapshot(result) };
    },
  };
}

export type BookWebSourceReader = ReturnType<typeof createBookWebSourceReader>;
