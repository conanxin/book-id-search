import { lookup as dnsLookup } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import net, { BlockList, isIP, type Socket } from "node:net";
import tls from "node:tls";
import { BOOK_WEB_SOURCE_LIMITS as LIMITS, BookWebSourceError, checkSourceCancelled,
  type BookWebSourceContentType, type BookWebSourceFetcher } from "./book-web-source-contract.js";

const blocked = () => new BookWebSourceError("BOOK_SOURCE_BLOCKED");
const unavailable = () => new BookWebSourceError("BOOK_SOURCE_UNAVAILABLE");
const unsupported = () => new BookWebSourceError("BOOK_SOURCE_UNSUPPORTED");
const reserved = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) reserved.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) reserved.addSubnet(address, prefix, "ipv6");

export function isPublicWebAddress(address: string): boolean {
  if (address.includes("%")) return false;
  const family = isIP(address);
  if (family === 4) return !reserved.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !reserved.check(address, "ipv6");
}

function hostnameOf(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "");
}

/** Validate again at every redirect; no target credentials or arbitrary ports. */
export function parsePublicWebUrl(value: string): URL {
  if (typeof value !== "string" || value.length > LIMITS.URL_CHARS || !/^https?:\/\//i.test(value)
    || /[\s\u0000-\u001f\u007f\\]/.test(value)
    || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(value)) throw blocked();
  let url: URL;
  try { url = new URL(value); } catch { throw blocked(); }
  const host = hostnameOf(url), port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!["http:", "https:"].includes(url.protocol) || !host || url.username || url.password
    || ![80, 443].includes(port) || host.endsWith(".")
    || /(^|\.)(localhost|local|internal|test|invalid|onion)$/.test(host)
    || (isIP(host) && !isPublicWebAddress(host))) throw blocked();
  url.hash = "";
  if (url.href.length > LIMITS.URL_CHARS) throw blocked();
  return url;
}

export interface ResolvedWebTarget { url: URL; address: string; family: 4 | 6; port: number }
export interface WebSourceTransportResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
export type WebSourceTransport = (target: ResolvedWebTarget, proxy: URL | undefined,
  signal: AbortSignal) => Promise<WebSourceTransportResponse>;
export type WebSourceLookup = (hostname: string) => Promise<LookupAddress[]>;

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  checkSourceCancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Source reading cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function resolveTarget(url: URL, lookup: WebSourceLookup, signal: AbortSignal): Promise<ResolvedWebTarget> {
  const host = hostnameOf(url), literal = isIP(host);
  const addresses = literal ? [{ address: host, family: literal }] : await abortable(lookup(host), signal);
  checkSourceCancelled(signal);
  // Reject mixed public/private answers, and bind the selected address to the
  // actual connection. The proxy never performs a second target DNS lookup.
  if (!addresses.length || addresses.some(item => !isPublicWebAddress(item.address))) throw blocked();
  const address = addresses[0].address, family = isIP(address) as 4 | 6;
  return { url, address, family, port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) };
}

/** Only trusted server environment config is consulted; never request input. */
function readProxy(env: NodeJS.ProcessEnv, protocol: string): URL | undefined {
  const value = protocol === "https:"
    ? env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
    : env.HTTP_PROXY || env.http_proxy || env.HTTPS_PROXY || env.https_proxy;
  if (!value) return undefined;
  let proxy: URL;
  try { proxy = new URL(value); } catch { throw unavailable(); }
  if (proxy.protocol !== "http:" || !proxy.hostname || !["", "/"].includes(proxy.pathname)
    || proxy.search || proxy.hash) throw unavailable();
  return proxy;
}

function watchSocket(socket: Socket, signal: AbortSignal): Socket {
  // An error can arrive between CONNECT, TLS and the target request. Each
  // awaited phase has its own error handler; keep that gap from throwing.
  socket.on("error", () => {});
  const abort = () => socket.destroy();
  signal.addEventListener("abort", abort, { once: true });
  socket.once("close", () => signal.removeEventListener("abort", abort));
  if (signal.aborted) socket.destroy();
  return socket;
}

async function connected(socket: Socket, event: "connect" | "secureConnect", signal: AbortSignal): Promise<Socket> {
  try {
    await abortable(new Promise<void>((resolve, reject) => {
      const ok = () => { cleanup(); resolve(); };
      const fail = (error: Error) => { cleanup(); reject(error); };
      const closed = () => { cleanup(); reject(unavailable()); };
      const cleanup = () => { socket.off(event, ok); socket.off("error", fail); socket.off("close", closed); };
      socket.once(event, ok); socket.once("error", fail); socket.once("close", closed);
    }), signal);
    checkSourceCancelled(signal);
    return socket;
  } catch (error) { socket.destroy(); throw error; }
}

async function proxyTunnel(target: ResolvedWebTarget, proxy: URL, signal: AbortSignal): Promise<Socket> {
  checkSourceCancelled(signal);
  const authority = `${target.family === 6 ? `[${target.address}]` : target.address}:${target.port}`;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: authority };
    if (proxy.username || proxy.password) {
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
    }
    const request = http.request({ hostname: hostnameOf(proxy), port: Number(proxy.port || 80),
      method: "CONNECT", path: authority, headers, agent: false, signal, maxHeaderSize: 16_384 });
    request.once("error", reject);
    request.once("connect", (response, socket, head) => {
      if (response.statusCode !== 200 || head.length || signal.aborted) {
        socket.destroy(); reject(unavailable()); return;
      }
      // Successful CONNECT detaches this socket and closes ClientRequest;
      // request 'close' must not destroy the newly established tunnel.
      resolve(watchSocket(socket, signal));
    });
    request.end();
  });
}

/** Node 22: omit `agent` when supplying createConnection. `agent:false`
 * installs a new Agent that can ignore our preconnected, pinned socket. */
export const openPinnedWebResponse: WebSourceTransport = async (target, proxy, signal) => {
  checkSourceCancelled(signal);
  const raw = proxy ? await proxyTunnel(target, proxy, signal)
    : await connected(watchSocket(net.connect({ host: target.address, port: target.port, family: target.family }), signal), "connect", signal);
  let socket = raw;
  try {
    if (target.url.protocol === "https:") {
      const host = hostnameOf(target.url);
      socket = watchSocket(tls.connect({ socket: raw, host, servername: isIP(host) ? undefined : host,
        rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] }), signal);
      await connected(socket, "secureConnect", signal);
    }
    checkSourceCancelled(signal);
    return await new Promise<WebSourceTransportResponse>((resolve, reject) => {
      const request = (target.url.protocol === "https:" ? https : http).request({
        hostname: hostnameOf(target.url), port: target.port, method: "GET", path: target.url.pathname + target.url.search,
        headers: { Host: target.url.host, Accept: "text/html, application/xhtml+xml, text/plain", "Accept-Encoding": "identity",
          "User-Agent": "BookIdSearch-WebSource/1.0", Connection: "close" },
        createConnection: () => socket, signal, maxHeaderSize: 16_384,
      }, response => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response,
        close: () => { response.destroy(); request.destroy(); socket.destroy(); raw.destroy(); } }));
      request.once("error", reject);
      request.once("upgrade", (_response, upgraded) => { upgraded.destroy(); reject(unavailable()); });
      request.end();
    });
  } catch (error) { socket.destroy(); raw.destroy(); throw error; }
};

function header(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  return typeof value === "string" ? value : "";
}

function contentFormat(headers: IncomingHttpHeaders): { contentType: BookWebSourceContentType; charset?: string } {
  const encoding = header(headers, "content-encoding").trim().toLowerCase();
  if (encoding && encoding !== "identity") throw unsupported();
  const type = header(headers, "content-type"), mime = type.split(";", 1)[0].trim().toLowerCase();
  if (!["text/html", "application/xhtml+xml", "text/plain"].includes(mime)) throw unsupported();
  const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(type);
  return { contentType: mime as BookWebSourceContentType,
    ...(charset ? { charset: (charset[1] || charset[2] || charset[3]).trim() } : {}) };
}

async function readBody(body: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    checkSourceCancelled(signal);
    size += chunk.byteLength;
    if (size > LIMITS.BODY_BYTES) throw new BookWebSourceError("BOOK_SOURCE_TOO_LARGE");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

/** Injection is for tests at construction, never an environment fake mode. */
export function createPublicWebPageFetcher(deps: {
  env?: NodeJS.ProcessEnv;
  lookup?: WebSourceLookup;
  openResponse?: WebSourceTransport;
  timeoutMs?: number;
} = {}): BookWebSourceFetcher {
  return async (requestedUrl, options) => {
    checkSourceCancelled(options.signal);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    options.signal?.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, deps.timeoutMs ?? LIMITS.TIMEOUT_MS);
    timeout.unref();
    const { signal } = controller;
    try {
      let url = parsePublicWebUrl(requestedUrl);
      for (let redirects = 0; ; redirects++) {
        const target = await resolveTarget(url, deps.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true })), signal);
        checkSourceCancelled(signal);
        const response = await (deps.openResponse ?? openPinnedWebResponse)(target, readProxy(deps.env ?? process.env, url.protocol), signal);
        try {
          checkSourceCancelled(signal);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (redirects >= LIMITS.REDIRECTS) throw unavailable();
            const location = header(response.headers, "location");
            if (!location) throw unavailable();
            let redirect: URL;
            try { redirect = new URL(location, url); } catch { throw blocked(); }
            url = parsePublicWebUrl(redirect.href);
            continue;
          }
          if (response.status < 200 || response.status >= 300) throw unavailable();
          const format = contentFormat(response.headers), size = header(response.headers, "content-length");
          if (/^\d+$/.test(size) && Number(size) > LIMITS.BODY_BYTES) throw new BookWebSourceError("BOOK_SOURCE_TOO_LARGE");
          const body = await abortable(readBody(response.body, signal), signal);
          if (/^\s*%PDF-/i.test(body.subarray(0, 1024).toString("latin1"))) throw unsupported();
          return { finalUrl: url.href, ...format, body };
        } finally { response.close(); }
      }
    } catch (error) {
      checkSourceCancelled(options.signal);
      if (timedOut) throw new BookWebSourceError("BOOK_SOURCE_TIMEOUT");
      if (error instanceof BookWebSourceError) throw error;
      throw unavailable();
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", cancel);
    }
  };
}
