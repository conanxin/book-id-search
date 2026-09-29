import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetWebAuthStoreForTests,
  ensureAuthSessionLoaded,
  getWebAuthSnapshot,
  signInWithGoogleCredential,
  signOut,
} from "./session";

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
  removeItem(key: string): void { this.data.delete(key); }
  clear(): void { this.data.clear(); }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  get length(): number { return this.data.size; }
}

const memoryLocalStorage = new MemoryStorage();
const memorySessionStorage = new MemoryStorage();
(globalThis as unknown as { localStorage: Storage }).localStorage = memoryLocalStorage;
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = memorySessionStorage;

const AUTHENTICATED_BODY = {
  authenticated: true,
  user: { email: "owner@example.com", name: "Owner" },
  csrfToken: "csrf-abc-123",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("web auth session store", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __resetWebAuthStoreForTests();
    memoryLocalStorage.clear();
    memorySessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
  });

  it("initial snapshot is idle with no user/csrf/error", () => {
    expect(getWebAuthSnapshot()).toEqual({ status: "idle", user: null, csrfToken: null, error: null });
  });

  it("200 authenticated:true with valid user + csrf → authenticated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(AUTHENTICATED_BODY)));
    await ensureAuthSessionLoaded();
    const s = getWebAuthSnapshot();
    expect(s.status).toBe("authenticated");
    expect(s.user).toEqual({ email: "owner@example.com", name: "Owner" });
    expect(s.csrfToken).toBe("csrf-abc-123");
  });

  it("200 authenticated:false → unauthenticated", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ authenticated: false })));
    await ensureAuthSessionLoaded();
    expect(getWebAuthSnapshot().status).toBe("unauthenticated");
  });

  it("404 → disabled", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    await ensureAuthSessionLoaded();
    expect(getWebAuthSnapshot().status).toBe("disabled");
  });

  it("503 → unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    await ensureAuthSessionLoaded();
    expect(getWebAuthSnapshot().status).toBe("unavailable");
  });

  it("malformed body → generic error, no raw backend detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{\"oops", { status: 200 })));
    await ensureAuthSessionLoaded();
    const s = getWebAuthSnapshot();
    expect(s.status).toBe("error");
    expect(s.error).not.toContain("oops");
    expect(s.error).toContain("失败");
  });

  it("authenticated:true with missing csrfToken → strict error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ authenticated: true, user: AUTHENTICATED_BODY.user })));
    await ensureAuthSessionLoaded();
    expect(getWebAuthSnapshot().status).toBe("error");
  });

  it("authenticated:true with non-string user.email → strict error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      authenticated: true,
      user: { email: 42, name: null },
      csrfToken: "csrf",
    })));
    await ensureAuthSessionLoaded();
    expect(getWebAuthSnapshot().status).toBe("error");
  });

  it("non-2xx network-ish status → generic error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
    await ensureAuthSessionLoaded();
    const s = getWebAuthSnapshot();
    expect(s.status).toBe("error");
    expect(s.error).not.toContain("boom");
  });

  it("network throw → generic error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
    await ensureAuthSessionLoaded();
    expect(getWebAuthSnapshot().status).toBe("error");
    expect(getWebAuthSnapshot().error).not.toContain("network");
  });

  it("concurrent ensureAuthSessionLoaded dedupes to one GET", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(AUTHENTICATED_BODY));
    vi.stubGlobal("fetch", fetchMock);
    await Promise.all([ensureAuthSessionLoaded(), ensureAuthSessionLoaded(), ensureAuthSessionLoaded()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("login POST uses exact shape and then authoritative refresh", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(AUTHENTICATED_BODY));
    vi.stubGlobal("fetch", fetchMock);
    await signInWithGoogleCredential("fake-jwt-credential");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const post = fetchMock.mock.calls[0];
    expect(post[0]).toBe("/api/auth/google");
    expect(post[1]).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
    });
    expect(JSON.parse(post[1].body)).toEqual({ credential: "fake-jwt-credential" });
    expect(post[1].headers).not.toHaveProperty("origin");
    expect(getWebAuthSnapshot().status).toBe("authenticated");
  });

  it("login refresh landing on non-authenticated → controlled error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }));
    vi.stubGlobal("fetch", fetchMock);
    await signInWithGoogleCredential("fake-jwt");
    expect(getWebAuthSnapshot().status).toBe("error");
  });

  it("login 401 → safe credential error, no raw detail, no credential in message", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: "id_token exp 全是内部细节" } }, 401));
    vi.stubGlobal("fetch", fetchMock);
    await signInWithGoogleCredential("fake-jwt");
    const s = getWebAuthSnapshot();
    expect(s.status).toBe("unauthenticated");
    expect(s.error).toContain("凭据");
    expect(s.error).not.toContain("id_token");
    expect(s.error).not.toContain("fake-jwt");
  });

  it("login 403 → not-authorized message; 404 → disabled message; 503 → unavailable message", async () => {
    for (const [status, fragment] of [[403, "未被授权"], [404, "尚未启用"], [503, "暂不可用"]] as const) {
      __resetWebAuthStoreForTests();
      vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));
      await signInWithGoogleCredential("fake-jwt");
      expect(getWebAuthSnapshot().error).toContain(fragment);
    }
  });

  it("login empty credential → controlled error without any POST", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await signInWithGoogleCredential("");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getWebAuthSnapshot().status).toBe("error");
  });

  it("logout sends CSRF header, 204 clears user+csrf", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(AUTHENTICATED_BODY)));
    await ensureAuthSessionLoaded();
    const logoutMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", logoutMock);
    await signOut();
    expect(logoutMock).toHaveBeenCalledTimes(1);
    const call = logoutMock.mock.calls[0];
    expect(call[0]).toBe("/api/auth/logout");
    expect(call[1]).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(call[1].headers).toMatchObject({ "x-csrf-token": "csrf-abc-123" });
    expect(call[1].headers).not.toHaveProperty("origin");
    const s = getWebAuthSnapshot();
    expect(s).toEqual({ status: "unauthenticated", user: null, csrfToken: null, error: null });
  });

  it("logout failure keeps session + error (never fakes success)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(AUTHENTICATED_BODY)));
    await ensureAuthSessionLoaded();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await signOut();
    const s = getWebAuthSnapshot();
    expect(s.status).toBe("authenticated");
    expect(s.user).toEqual({ email: "owner@example.com", name: "Owner" });
    expect(s.csrfToken).toBe("csrf-abc-123");
    expect(s.error).toContain("退出登录失败");
  });

  it("logout while unauthenticated is a no-op (no POST)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await signOut();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("zero localStorage/sessionStorage writes across the full lifecycle", async () => {
    const setSpy = vi.spyOn(memoryLocalStorage, "setItem");
    const sessionSpy = vi.spyOn(memorySessionStorage, "setItem");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(AUTHENTICATED_BODY)));
    await ensureAuthSessionLoaded();
    await signInWithGoogleCredential("fake-jwt");
    await signOut();
    expect(setSpy).not.toHaveBeenCalled();
    expect(sessionSpy).not.toHaveBeenCalled();
  });
});
