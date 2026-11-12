import http from "node:http";
import https from "node:https";
import net, { type AddressInfo, type Socket, type Server } from "node:net";
import tls from "node:tls";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BOOK_WEB_SOURCE_LIMITS as LIMITS } from "./book-web-source-contract.js";
import { createPublicWebPageFetcher, isPublicWebAddress, openPinnedWebResponse, parsePublicWebUrl,
  type ResolvedWebTarget, type WebSourceTransport, type WebSourceTransportResponse } from "./web-source-fetch.js";

const URL_1 = "https://example.org/book";
const PUBLIC = [{ address: "8.8.8.8", family: 4 }];
function response(text = "<main>正文</main>", status = 200, headers: Record<string, string> = {}): WebSourceTransportResponse {
  return { status, headers: { "content-type": "text/html; charset=utf-8", ...headers },
    body: (async function* () { yield Buffer.from(text); })(), close: vi.fn() };
}
const servers: Server[] = [], sockets = new Set<Socket>();
async function listen(server: Server): Promise<number> {
  servers.push(server);
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  return (server.address() as AddressInfo).port;
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

describe("public webpage URL and DNS boundary", () => {
  it.each(["0.0.0.0", "10.2.3.4", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.31.0.1",
    "192.0.0.1", "192.0.2.2", "192.168.1.1", "198.18.0.1", "198.51.100.2", "203.0.113.2", "224.0.0.1",
    "255.255.255.255", "::1", "::", "fe80::1", "fc00::1", "::ffff:8.8.8.8", "64:ff9b::808:808",
    "2001::1", "2001:db8::1", "2002:7f00:1::", "3fff::1", "2001:4860::1%eth0"])("rejects non-public address %s", address => {
    expect(isPublicWebAddress(address)).toBe(false);
  });

  it("accepts public v4/v6 and normalizes URL before literal-address checks", () => {
    expect(isPublicWebAddress("8.8.8.8")).toBe(true);
    expect(isPublicWebAddress("2606:4700:4700::1111")).toBe(true);
    expect(parsePublicWebUrl("https://example.org:443/book#section").href).toBe(URL_1);
    for (const url of ["http://2130706433/", "http://0x7f000001/", "http://127.1/", "http://[::ffff:127.0.0.1]/",
      "http://user:secret@example.org/", "http://localhost/", "https://example.org:8080/", "file:///etc/passwd",
      "https://example.org\\@127.0.0.1", "https://example.org/\r\nprivate", "http://[fe80::1%25eth0]/"]) {
      expect(() => parsePublicWebUrl(url)).toThrowError(expect.objectContaining({ code: "BOOK_SOURCE_BLOCKED" }));
    }
  });

  it("pins a public IP, rejects mixed DNS answers before transport, and never trusts DNS family metadata", async () => {
    const openResponse = vi.fn<WebSourceTransport>().mockResolvedValue(response());
    const lookup = vi.fn().mockResolvedValue(PUBLIC);
    const fetchPage = createPublicWebPageFetcher({ env: {}, lookup, openResponse });
    await fetchPage(URL_1, {});
    expect(lookup).toHaveBeenCalledExactlyOnceWith("example.org");
    expect(openResponse).toHaveBeenCalledWith(expect.objectContaining({ address: "8.8.8.8", family: 4, port: 443 }), undefined, expect.any(AbortSignal));
    openResponse.mockClear();
    for (const addresses of [[...PUBLIC, { address: "127.0.0.1", family: 6 }], [{ address: "not-an-ip", family: 4 }], []]) {
      lookup.mockResolvedValueOnce(addresses);
      await expect(fetchPage(URL_1, {})).rejects.toMatchObject({ code: "BOOK_SOURCE_BLOCKED" });
    }
    expect(openResponse).not.toHaveBeenCalled();
  });

  it("checks every redirect and closes responses before a prohibited second hop", async () => {
    const first = response("", 302, { location: "https://other.example.org/next" });
    const lookup = vi.fn().mockResolvedValueOnce(PUBLIC).mockResolvedValueOnce([{ address: "10.0.0.3", family: 4 }]);
    const openResponse = vi.fn<WebSourceTransport>().mockResolvedValue(first);
    const fetchPage = createPublicWebPageFetcher({ env: {}, lookup, openResponse });
    await expect(fetchPage(URL_1, {})).rejects.toMatchObject({ code: "BOOK_SOURCE_BLOCKED" });
    expect(lookup).toHaveBeenCalledTimes(2); expect(openResponse).toHaveBeenCalledOnce(); expect(first.close).toHaveBeenCalledOnce();
  });

  it("limits redirects to three and reports the final normalized URL", async () => {
    const first = response("", 301, { location: "/final#anchor" }), final = response();
    const openResponse = vi.fn<WebSourceTransport>().mockResolvedValueOnce(first).mockResolvedValueOnce(final);
    const fetchPage = createPublicWebPageFetcher({ env: {}, lookup: async () => PUBLIC, openResponse });
    expect((await fetchPage(URL_1, {})).finalUrl).toBe("https://example.org/final");
    expect(first.close).toHaveBeenCalledOnce(); expect(final.close).toHaveBeenCalledOnce();
    openResponse.mockReset().mockImplementation(async () => response("", 302, { location: "/again" }));
    await expect(fetchPage(URL_1, {})).rejects.toMatchObject({ code: "BOOK_SOURCE_UNAVAILABLE" });
    expect(openResponse).toHaveBeenCalledTimes(4);
  });

  it("uses only the explicit trusted HTTP proxy and refuses unsupported proxy config", async () => {
    const openResponse = vi.fn<WebSourceTransport>().mockImplementation(async () => response());
    const fetchPage = createPublicWebPageFetcher({ env: { HTTPS_PROXY: "http://172.18.0.1:18080", ALL_PROXY: "socks5://ignored" },
      lookup: async () => PUBLIC, openResponse });
    await fetchPage(URL_1, {});
    expect(openResponse.mock.calls[0][1]?.href).toBe("http://172.18.0.1:18080/");
    const invalid = createPublicWebPageFetcher({ env: { HTTPS_PROXY: "socks5://172.18.0.1:1080" }, lookup: async () => PUBLIC, openResponse });
    await expect(invalid(URL_1, {})).rejects.toMatchObject({ code: "BOOK_SOURCE_UNAVAILABLE" });
    expect(openResponse).toHaveBeenCalledOnce();
  });
});

describe("bounded webpage response and cancellation", () => {
  it("accepts exactly 2 MiB and rejects declared or actual oversized bodies with cleanup", async () => {
    for (const [size, declared, ok] of [[LIMITS.BODY_BYTES, false, true], [LIMITS.BODY_BYTES + 1, false, false], [5, true, false]] as const) {
      const page = response("x".repeat(size), 200, { "content-type": "text/plain", ...(declared ? { "content-length": String(LIMITS.BODY_BYTES + 1) } : {}) });
      const fetchPage = createPublicWebPageFetcher({ env: {}, lookup: async () => PUBLIC, openResponse: async () => page });
      if (ok) expect((await fetchPage(URL_1, {})).body.byteLength).toBe(size);
      else await expect(fetchPage(URL_1, {})).rejects.toMatchObject({ code: "BOOK_SOURCE_TOO_LARGE" });
      expect(page.close).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ["application/pdf", "", "%PDF-1.7"], ["image/png", "", "PNG"], ["text/html", "gzip", "compressed"],
    ["text/html", "", "%PDF-1.7 disguised"], ["", "", "missing MIME"],
  ])("rejects unsupported response %s/%s", async (type, encoding, body) => {
    const page = response(body, 200, { "content-type": type, "content-encoding": encoding });
    const fetchPage = createPublicWebPageFetcher({ env: {}, lookup: async () => PUBLIC, openResponse: async () => page });
    await expect(fetchPage(URL_1, {})).rejects.toMatchObject({ code: "BOOK_SOURCE_UNSUPPORTED" });
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("maps HTTP errors and unexpected network details to a fixed error", async () => {
    const page = response("PRIVATE_UPSTREAM_DETAILS", 403);
    const openResponse = vi.fn<WebSourceTransport>().mockResolvedValueOnce(page).mockRejectedValueOnce(new Error("PRIVATE_PROXY_PASSWORD"));
    const fetchPage = createPublicWebPageFetcher({ env: {}, lookup: async () => PUBLIC, openResponse });
    for (let i = 0; i < 2; i++) {
      try { await fetchPage(URL_1, {}); throw new Error("expected failure"); }
      catch (error) { expect(error).toMatchObject({ code: "BOOK_SOURCE_UNAVAILABLE" }); expect(String(error)).not.toContain("PRIVATE_"); }
    }
    expect(page.close).toHaveBeenCalledOnce();
  });

  it("times out pending DNS and prevents a late DNS answer from connecting", async () => {
    let resolveDns!: (value: typeof PUBLIC) => void;
    const lookup = () => new Promise<typeof PUBLIC>(resolve => { resolveDns = resolve; });
    const openResponse = vi.fn<WebSourceTransport>();
    const fetchPage = createPublicWebPageFetcher({ env: {}, lookup, openResponse, timeoutMs: 15 });
    await expect(fetchPage(URL_1, {})).rejects.toMatchObject({ code: "BOOK_SOURCE_TIMEOUT" });
    resolveDns(PUBLIC); await Promise.resolve(); expect(openResponse).not.toHaveBeenCalled();
  });

  it("aborts a stalled body and closes its response", async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const reading = new Promise<void>(resolve => { ready = resolve; });
    const page = response();
    page.body = (async function* () { ready(); await new Promise(() => {}); yield Buffer.from("late"); })();
    const fetchPage = createPublicWebPageFetcher({ env: {}, lookup: async () => PUBLIC, openResponse: async () => page });
    const pending = fetchPage(URL_1, { signal: controller.signal });
    const result = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await reading; controller.abort(); await result;
    expect(page.close).toHaveBeenCalledOnce();
  });
});

describe("real pinned socket and HTTP CONNECT transport", () => {
  it("uses the exact direct socket while preserving Host, without second target DNS or client headers", async () => {
    let received: http.IncomingHttpHeaders | undefined;
    const port = await listen(http.createServer((req, res) => { received = req.headers; res.end("direct-pinned"); }));
    // Only this transport test constructs a private target. The public URL and
    // DNS policy above rejects loopback before this production transport.
    const target: ResolvedWebTarget = { url: new URL(`http://must-not-resolve.invalid:${port}/book?q=1`), address: "127.0.0.1", family: 4, port };
    const page = await openPinnedWebResponse(target, undefined, new AbortController().signal);
    try {
      const chunks: Buffer[] = []; for await (const chunk of page.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("direct-pinned");
      expect(received?.host).toBe(`must-not-resolve.invalid:${port}`);
      expect(received?.["accept-encoding"]).toBe("identity");
      expect(received?.cookie).toBeUndefined(); expect(received?.authorization).toBeUndefined();
    } finally { page.close(); }
  });

  it("CONNECTs to the pinned IP, survives CONNECT close, and does not forward proxy authorization", async () => {
    let originHeaders: http.IncomingHttpHeaders | undefined, connectPath = "", connectHost = "", proxyAuth = "";
    const port = await listen(http.createServer((req, res) => { originHeaders = req.headers; res.end("through-tunnel"); }));
    const proxy = http.createServer();
    proxy.on("connect", (req, downstream, head) => {
      connectPath = req.url || ""; connectHost = req.headers.host || ""; proxyAuth = req.headers["proxy-authorization"] || "";
      const upstream = net.connect({ host: "127.0.0.1", port }, () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        downstream.pipe(upstream); upstream.pipe(downstream);
      });
      sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
      upstream.on("error", () => downstream.destroy()); downstream.on("error", () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    const target: ResolvedWebTarget = { url: new URL(`http://must-not-resolve.invalid:${port}/book`), address: "8.8.8.8", family: 4, port };
    const page = await openPinnedWebResponse(target, new URL(`http://fixture:credential@127.0.0.1:${proxyPort}`), new AbortController().signal);
    try {
      const chunks: Buffer[] = []; for await (const chunk of page.body) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe("through-tunnel");
      expect(connectPath).toBe(`8.8.8.8:${port}`); expect(connectHost).toBe(connectPath);
      expect(proxyAuth).toBe(`Basic ${Buffer.from("fixture:credential").toString("base64")}`);
      expect(originHeaders?.host).toBe(`must-not-resolve.invalid:${port}`);
      expect(originHeaders?.["proxy-authorization"]).toBeUndefined(); expect(originHeaders?.authorization).toBeUndefined();
    } finally { page.close(); }
  });

  it("keeps TLS verification, SNI and Host for the original domain over an IP CONNECT tunnel", async () => {
    const directory = mkdtempSync(join(tmpdir(), "book-source-tls-"));
    let key: Buffer, cert: Buffer;
    try {
      // This certificate is a disposable local test CA only. No production
      // trust, environment variables or TLS verification settings are changed.
      execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
        "-subj", "/CN=source.example.org", "-addext", "subjectAltName=DNS:source.example.org",
        "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "ignore" });
      key = readFileSync(join(directory, "key.pem")); cert = readFileSync(join(directory, "cert.pem"));
    } finally { rmSync(directory, { recursive: true, force: true }); }
    let host = "", sni = "", authority = "";
    const origin = https.createServer({ key, cert }, (req, res) => {
      host = req.headers.host || ""; sni = (req.socket as tls.TLSSocket).servername || ""; res.end("tls-through-tunnel");
    });
    const originPort = await listen(origin);
    const proxy = http.createServer();
    proxy.on("connect", (req, downstream) => {
      authority = req.url || "";
      const upstream = net.connect({ host: "127.0.0.1", port: originPort }, () => {
        downstream.write("HTTP/1.1 200 Connection Established\r\n\r\n"); downstream.pipe(upstream); upstream.pipe(downstream);
      });
      sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
      upstream.on("error", () => downstream.destroy()); downstream.on("error", () => upstream.destroy());
    });
    const proxyPort = await listen(proxy), originalConnect = tls.connect;
    const connect = vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions) =>
      originalConnect({ ...options, ca: cert })) as typeof tls.connect);
    try {
      const page = await openPinnedWebResponse({ url: new URL("https://source.example.org/book"), address: "8.8.8.8", family: 4, port: 443 },
        new URL(`http://127.0.0.1:${proxyPort}`), new AbortController().signal);
      try {
        const chunks: Buffer[] = []; for await (const chunk of page.body) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).toString()).toBe("tls-through-tunnel");
        expect(authority).toBe("8.8.8.8:443"); expect(host).toBe("source.example.org"); expect(sni).toBe("source.example.org");
        expect(connect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ host: "source.example.org", servername: "source.example.org",
          rejectUnauthorized: true, ALPNProtocols: ["http/1.1"], socket: expect.any(net.Socket) }));
      } finally { page.close(); }
    } finally { connect.mockRestore(); }
  });

  it("closes a stalled CONNECT socket when the caller cancels", async () => {
    const proxy = http.createServer();
    let accepted!: () => void, closed!: () => void;
    const beginning = new Promise<void>(resolve => { accepted = resolve; });
    const ending = new Promise<void>(resolve => { closed = resolve; });
    proxy.on("connect", (_req, socket) => {
      socket.once("end", () => { closed(); socket.destroy(); }); socket.once("close", closed);
      socket.resume(); accepted();
    });
    const proxyPort = await listen(proxy), controller = new AbortController();
    const pending = openPinnedWebResponse({ url: new URL(URL_1), address: "8.8.8.8", family: 4, port: 443 },
      new URL(`http://127.0.0.1:${proxyPort}`), controller.signal);
    const outcome = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await beginning; controller.abort(); await outcome; await ending;
  });

  it("rejects unsuccessful or malformed CONNECT and unexpected target upgrades", async () => {
    for (const reply of ["HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n", "HTTP/1.1 200 OK\r\n\r\nUNEXPECTED_HEAD"]) {
      const proxy = http.createServer();
      proxy.on("connect", (_req, socket) => socket.end(reply));
      const proxyPort = await listen(proxy);
      const target: ResolvedWebTarget = { url: new URL(URL_1), address: "8.8.8.8", family: 4, port: 443 };
      await expect(openPinnedWebResponse(target, new URL(`http://127.0.0.1:${proxyPort}`), new AbortController().signal))
        .rejects.toMatchObject({ code: "BOOK_SOURCE_UNAVAILABLE" });
    }
    const port = await listen(http.createServer((_req, res) => { res.writeHead(101, { Upgrade: "custom", Connection: "Upgrade" }); res.end(); }));
    await expect(openPinnedWebResponse({ url: new URL(`http://must-not-resolve.invalid:${port}`), address: "127.0.0.1", family: 4, port },
      undefined, new AbortController().signal)).rejects.toMatchObject({ code: "BOOK_SOURCE_UNAVAILABLE" });
  });
});
