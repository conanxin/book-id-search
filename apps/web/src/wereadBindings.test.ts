import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetWebAuthStoreForTests, __setWebAuthSnapshotForTests } from "./auth/session";
import {
  getWereadBinding, listWereadBindings, searchWereadBindingCatalog, updateWereadBinding,
  type WereadBindingCatalog, type WereadBindingItem, type WereadBindingMutation,
  type WereadBindingsQuery,
} from "./wereadBindings";
import { clearWereadStatusCache, fetchWereadStatusesForBooks } from "./wereadPrivate";

const A = "13000000_000000000001";
const B = "13000001_000000000002";
const KEY = "a".repeat(64);
const OTHER = "b".repeat(64);
const AT = "2026-10-11T03:00:00.000Z";
const fetchMock = vi.fn<typeof fetch>();

function login(token = "synthetic-csrf") {
  __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: "owner@example.test", name: "合成用户" }, csrfToken: token, error: null });
}
function logout() {
  __setWebAuthSnapshotForTests({ status: "unauthenticated", user: null, csrfToken: null, error: null });
}
function catalog(id = A): WereadBindingCatalog {
  return { id, title: "合成目录书", author: "合成作者", publisher: "合成出版社", year: 2020, isbn: "9780000000000", available: true };
}
function item(patch: Partial<WereadBindingItem> = {}): WereadBindingItem {
  return { sourceKey: KEY, title: "合成来源书", author: "合成来源作者", isbn: null, notesCount: 27,
    effectiveCatalog: catalog(), importedCatalogId: A, origin: "imported", revision: 0, updatedAt: null, ...patch };
}
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
function page(items: unknown[] = [item()], overrides: Record<string, unknown> = {}) {
  return json({ ok: true, items, pageInfo: { limit: 20, offset: 0, total: items.length, hasMore: false }, writable: true, ...overrides });
}
function ack(value = item({ origin: "manual", revision: 1, updatedAt: AT })) {
  return json({ ok: true, item: value, writable: true });
}
function statusResponse(matched: boolean) {
  return json({ ok: true, results: { [A]: { ok: true, catalogId: A, matched } } });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  __resetWebAuthStoreForTests(); login(); clearWereadStatusCache();
  fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); __resetWebAuthStoreForTests(); clearWereadStatusCache(); });

describe("WeRead manual binding client", () => {
  it("requires the current Google session before private management or its catalog search", async () => {
    logout();
    const calls = [listWereadBindings(), getWereadBinding(KEY),
      updateWereadBinding(KEY, { action: "unbind", expectedRevision: 0 }), searchWereadBindingCatalog("合成书")];
    for (const call of calls) await expect(call).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an explicit book scope, active filters, pagination and the actual AbortSignal", async () => {
    const controller = new AbortController();
    const manual = item({ origin: "manual", revision: 2, updatedAt: AT });
    fetchMock.mockResolvedValue(page([manual], { pageInfo: { limit: 10, offset: 20, total: 21, hasMore: false } }));
    const result = await listWereadBindings({ q: "  合成作者  ", status: "manual", catalogId: ` ${A} `, limit: 10, offset: 20 }, { signal: controller.signal });
    expect(result.items).toEqual([manual]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(Object.fromEntries(new URL(String(url), "https://books.example.test").searchParams)).toEqual({ status: "manual", q: "合成作者", catalogId: A, limit: "10", offset: "20" });
    expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    expect(new Headers(init?.headers).has("x-csrf-token")).toBe(false);
  });

  it.each([
    { catalogId: "" }, { catalogId: undefined }, { catalogId: "wrong" },
    { limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1_000_001 },
    { status: "unknown" }, { q: "字".repeat(201) },
  ])("rejects malformed explicit query %j before fetch", async query => {
    await expect(listWereadBindings(query as WereadBindingsQuery)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads an unconfigured persistence service as a read-only source list", async () => {
    fetchMock.mockResolvedValue(page([item()], { writable: false }));
    expect((await listWereadBindings()).writable).toBe(false);
  });

  it.each([
    ["wrong catalog", item({ effectiveCatalog: catalog(B), importedCatalogId: B })],
    ["inconsistent origin", item({ origin: "unlinked" })],
    ["bad revision", item({ revision: -1 })],
  ])("rejects a scoped list containing %s", async (_name, invalid) => {
    fetchMock.mockResolvedValue(page([invalid]));
    await expect(listWereadBindings({ catalogId: A })).rejects.toMatchObject({ status: 502 });
  });

  it("rejects duplicate source rows and wrong pagination envelopes", async () => {
    fetchMock.mockResolvedValueOnce(page([item(), item()]));
    await expect(listWereadBindings()).rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(page([item()], { pageInfo: { limit: 20, offset: 20, total: 21, hasMore: false } }));
    await expect(listWereadBindings()).rejects.toMatchObject({ status: 502 });
  });

  it("retrieves a single source for conflict recovery and rejects a different source", async () => {
    const latest = item({ revision: 3, updatedAt: AT, origin: "manual", effectiveCatalog: catalog(B) });
    fetchMock.mockResolvedValueOnce(ack(latest));
    expect(await getWereadBinding(KEY)).toEqual(latest);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(new RegExp(`/bindings/${KEY}$`));
    fetchMock.mockResolvedValueOnce(ack(item({ sourceKey: OTHER })));
    await expect(getWereadBinding(KEY)).rejects.toMatchObject({ status: 502 });
  });

  it("writes only the explicitly chosen target with a revision and current CSRF token", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(ack());
    const updated = await updateWereadBinding(KEY, { action: "bind", catalogId: ` ${A} `, expectedRevision: 0 }, { signal: controller.signal });
    expect(updated.origin).toBe("manual");
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ method: "PUT", credentials: "same-origin", cache: "no-store", signal: controller.signal });
    expect(JSON.parse(String(init?.body))).toEqual({ action: "bind", catalogId: A, expectedRevision: 0 });
    const headers = new Headers(init?.headers);
    expect(headers.get("x-csrf-token")).toBe("synthetic-csrf");
    expect(headers.has("authorization")).toBe(false);
  });

  it("keeps manual unlink and restore-to-import as different commands", async () => {
    const unlinked = item({ effectiveCatalog: null, origin: "unlinked", revision: 1, updatedAt: AT });
    fetchMock.mockResolvedValueOnce(ack(unlinked)).mockResolvedValueOnce(ack(item({ revision: 2, updatedAt: AT })));
    expect((await updateWereadBinding(KEY, { action: "unbind", expectedRevision: 0 })).origin).toBe("unlinked");
    expect((await updateWereadBinding(KEY, { action: "restore", expectedRevision: 1 })).origin).toBe("imported");
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { action: "unbind", expectedRevision: 0 }, { action: "restore", expectedRevision: 1 },
    ]);
  });

  it.each([
    { action: "bind", expectedRevision: 0 }, { action: "bind", catalogId: "bad", expectedRevision: 0 },
    { action: "unbind", catalogId: A, expectedRevision: 0 }, { action: "restore", expectedRevision: -1 },
    { action: "erase", expectedRevision: 0 }, { action: "unbind", expectedRevision: 0, privatePath: "/tmp/private" },
  ])("rejects an invalid mutation %j before fetch", async mutation => {
    await expect(updateWereadBinding(KEY, mutation as WereadBindingMutation)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid source keys and missing write credentials without fetch", async () => {
    await expect(getWereadBinding("raw-weread-id")).rejects.toMatchObject({ status: 400 });
    await expect(updateWereadBinding("../private", { action: "unbind", expectedRevision: 0 })).rejects.toMatchObject({ status: 400 });
    __setWebAuthSnapshotForTests({ status: "authenticated", user: { email: null, name: null }, csrfToken: null, error: null });
    await expect(updateWereadBinding(KEY, { action: "unbind", expectedRevision: 0 })).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    item({ origin: "manual", revision: 1, updatedAt: AT, sourceKey: OTHER }),
    item({ origin: "manual", revision: 1, updatedAt: AT, effectiveCatalog: catalog(B) }),
    item(),
  ])("does not claim success from a mutation acknowledgement for the wrong source, target or revision", async value => {
    fetchMock.mockResolvedValueOnce(ack(value));
    await expect(updateWereadBinding(KEY, { action: "bind", catalogId: A, expectedRevision: 0 })).rejects.toMatchObject({ status: 502 });
  });

  it("does not retry conflicts or expose server details", async () => {
    fetchMock.mockResolvedValueOnce(json({ ok: false, error: { code: "VERSION_CONFLICT", message: "PRIVATE_DATABASE_DETAILS" } }, 409));
    const mutation = { action: "bind", catalogId: A, expectedRevision: 0 } as const;
    await expect(updateWereadBinding(KEY, mutation)).rejects.toMatchObject({ status: 409, message: expect.stringContaining("已保留你的候选") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mutation.expectedRevision).toBe(0);
  });

  it("uses the public catalog endpoint for explicit search and strips unrelated catalog fields", async () => {
    const controller = new AbortController();
    fetchMock.mockResolvedValueOnce(json({ items: [{ ...catalog(), rawInfo: "not needed", ssid: "13000000", dxid: "000000000001" }], total: 1, page: 1, limit: 10 }));
    const result = await searchWereadBindingCatalog("  合成目录  ", 1, 10, { signal: controller.signal });
    expect(result).toEqual({ items: [catalog()], total: 1, page: 1, limit: 10 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(new URL(String(url), "https://books.example.test").pathname).toBe("/api/search");
    expect(new URL(String(url), "https://books.example.test").searchParams.get("q")).toBe("合成目录");
    expect(init?.signal).toBe(controller.signal);
    expect(new Headers(init?.headers).has("x-csrf-token")).toBe(false);
  });

  it("does not run a blank catalog search or accept unusable candidate identifiers", async () => {
    await expect(searchWereadBindingCatalog(" ")).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ items: [{ ...catalog(), id: "private-source" }], total: 1, page: 1, limit: 10 }));
    await expect(searchWereadBindingCatalog("合成")).rejects.toMatchObject({ status: 502 });
  });

  it("rejects an already cancelled request before fetch", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(listWereadBindings({}, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards a response arriving after the Google session changes", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const result = listWereadBindings();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    login("different-synthetic-csrf"); pending.resolve(page());
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });

  it("also discards a response when logout happens during JSON decoding", async () => {
    const body = deferred<unknown>();
    const decoding = vi.fn(() => body.promise);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: decoding } as unknown as Response);
    const result = getWereadBinding(KEY);
    await vi.waitFor(() => expect(decoding).toHaveBeenCalledTimes(1));
    logout(); body.resolve({ ok: true, item: item(), writable: true });
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("association changes invalidate old status responses", () => {
  const unlinked = () => item({ effectiveCatalog: null, origin: "unlinked", revision: 1, updatedAt: AT });

  it("a late pre-update batch cannot repopulate the cache after a successful unlink", async () => {
    const oldResponse = deferred<Response>();
    fetchMock.mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(ack(unlinked())).mockResolvedValueOnce(statusResponse(false));
    const oldResult = fetchWereadStatusesForBooks([A]).catch(error => error);
    await updateWereadBinding(KEY, { action: "unbind", expectedRevision: 0 });
    oldResponse.resolve(statusResponse(true));
    expect(await oldResult).toMatchObject({ name: "AbortError" });
    expect((await fetchWereadStatusesForBooks([A]))[A].matched).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a late fallback response also cannot restore a cleared association", async () => {
    const oldResponse = deferred<Response>();
    fetchMock.mockResolvedValueOnce(json({ error: "try fallback" }, 500))
      .mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(ack(unlinked())).mockResolvedValueOnce(statusResponse(false));
    const oldResult = fetchWereadStatusesForBooks([A]).catch(error => error);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await updateWereadBinding(KEY, { action: "unbind", expectedRevision: 0 });
    oldResponse.resolve(json({ ok: true, catalogId: A, matched: true }));
    expect(await oldResult).toMatchObject({ name: "AbortError" });
    expect((await fetchWereadStatusesForBooks([A]))[A].matched).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("invalidates cached status even when the server accepted the write but its acknowledgement is unusable", async () => {
    fetchMock.mockResolvedValueOnce(statusResponse(true)).mockResolvedValueOnce(json({ broken: true })).mockResolvedValueOnce(statusResponse(false));
    expect((await fetchWereadStatusesForBooks([A]))[A].matched).toBe(true);
    await expect(updateWereadBinding(KEY, { action: "unbind", expectedRevision: 0 })).rejects.toMatchObject({ status: 502 });
    expect((await fetchWereadStatusesForBooks([A]))[A].matched).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("also invalidates when a committed write arrives after its editor request was cancelled", async () => {
    const pending = deferred<Response>();
    const controller = new AbortController();
    fetchMock.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(statusResponse(true)).mockResolvedValueOnce(statusResponse(false));
    const update = updateWereadBinding(KEY, { action: "unbind", expectedRevision: 0 }, { signal: controller.signal });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // A read completed while the write was still in flight.
    expect((await fetchWereadStatusesForBooks([A]))[A].matched).toBe(true);
    controller.abort(); pending.resolve(ack(unlinked()));
    await expect(update).rejects.toMatchObject({ name: "AbortError" });
    expect((await fetchWereadStatusesForBooks([A]))[A].matched).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
