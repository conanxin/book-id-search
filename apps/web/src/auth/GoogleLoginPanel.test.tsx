// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GoogleLoginPanel } from "./GoogleLoginPanel";
import {
  __resetWebAuthStoreForTests,
  getWebAuthSnapshot,
} from "./session";
import * as googleIdentity from "./googleIdentity";

vi.mock("./googleIdentity", async importOriginal => {
  const actual = await importOriginal<typeof import("./googleIdentity")>();
  return {
    ...actual,
    initializeGoogleIdentity: vi.fn(actual.initializeGoogleIdentity),
    renderGoogleButton: vi.fn(async (parent: HTMLElement) => {
      parent.innerHTML = '<div data-testid="official-google-button"></div>';
    }),
    disableGoogleAutoSelect: vi.fn(actual.disableGoogleAutoSelect),
  };
});

vi.mock("./session", async importOriginal => {
  const actual = await importOriginal<typeof import("./session")>();
  return {
    ...actual,
    // keep real store; only spies we re-assert in specific tests
  };
});

import { initializeGoogleIdentity, renderGoogleButton, disableGoogleAutoSelect } from "./googleIdentity";

const authenticatedBody = {
  authenticated: true,
  user: { email: "owner@example.com", name: "Owner" },
  csrfToken: "csrf-1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("GoogleLoginPanel", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __resetWebAuthStoreForTests();
    vi.mocked(initializeGoogleIdentity).mockClear();
    vi.mocked(renderGoogleButton).mockClear();
    vi.mocked(disableGoogleAutoSelect).mockClear();
    // jsdom has window.google absent by default; ensure clean
    delete (window as unknown as { google?: unknown }).google;
  });
  afterEach(() => {
    cleanup();
    (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
    vi.unstubAllGlobals();
  });

  it("missing clientId → unconfigured notice, no GIS initialize; session GET still fires (restore)", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ authenticated: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GoogleLoginPanel clientId={undefined} />);
    expect(await screen.findByTestId("google-login-unconfigured")).toBeTruthy();
    expect(screen.getByText(/尚未配置/)).toBeTruthy();
    expect(initializeGoogleIdentity).not.toHaveBeenCalled();
    // Session restore no longer depends on the client id (Task 8 contract).
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it("missing clientId but valid session → authenticated view wins over unconfigured", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(authenticatedBody)));
    render(<GoogleLoginPanel clientId={undefined} />);
    expect(await screen.findByTestId("google-login-authenticated")).toBeTruthy();
    expect(screen.getByText(/owner@example\.com/)).toBeTruthy();
  });

  it("unauthenticated → loads GIS and renders official button host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ authenticated: false })));
    // fake google namespace so initialize succeeds
    (window as unknown as { google: unknown }).google = {
      accounts: { id: { initialize: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() } },
    };
    render(<GoogleLoginPanel clientId="client-a" />);
    await waitFor(() => expect(initializeGoogleIdentity).toHaveBeenCalledWith("client-a", expect.any(Function)));
    await waitFor(() => expect(renderGoogleButton).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("google-login-button-host")).toBeTruthy();
  });

  it("authenticated → shows email + logout, no button host", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(authenticatedBody)));
    (window as unknown as { google: unknown }).google = {
      accounts: { id: { initialize: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() } },
    };
    render(<GoogleLoginPanel clientId="client-a" />);
    expect(await screen.findByTestId("google-login-authenticated")).toBeTruthy();
    expect(screen.getByText(/owner@example\.com/)).toBeTruthy();
    expect(screen.queryByTestId("google-login-button-host")).toBeNull();
    expect(renderGoogleButton).not.toHaveBeenCalled();
  });

  it("logout click → signOut + disableAutoSelect, back to button state", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse(authenticatedBody))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    (window as unknown as { google: unknown }).google = {
      accounts: { id: { initialize: vi.fn(), renderButton: vi.fn(), disableAutoSelect: vi.fn() } },
    };
    render(<GoogleLoginPanel clientId="client-a" />);
    const logout = await screen.findByRole("button", { name: "退出登录" });
    await userEvent.click(logout);
    await waitFor(() => expect(disableGoogleAutoSelect).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2); // session GET + logout POST
    expect(getWebAuthSnapshot().status).toBe("unauthenticated");
  });

  it("disabled → safe status notice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    render(<GoogleLoginPanel clientId="client-a" />);
    expect(await screen.findByTestId("google-login-disabled")).toBeTruthy();
    expect(initializeGoogleIdentity).not.toHaveBeenCalled();
  });

  it("unavailable → safe status notice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    render(<GoogleLoginPanel clientId="client-a" />);
    expect(await screen.findByTestId("google-login-unavailable")).toBeTruthy();
  });

  it("error → safe status with retry button; retry refetches", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("boom", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }));
    vi.stubGlobal("fetch", fetchMock);
    render(<GoogleLoginPanel clientId="client-a" />);
    const errorBox = await screen.findByTestId("google-login-error");
    expect(errorBox.textContent).not.toContain("boom");
    const retry = screen.getByRole("button", { name: "重试" });
    await userEvent.click(retry);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("signing states show lightweight notices without button host", async () => {
    // Render unauthenticated panel first (session GET resolves immediately),
    // then drive the store to signing_in via a hanging login POST.
    let resolveLogin!: (r: Response) => void;
    const hangingLogin = new Promise<Response>(r => { resolveLogin = r; });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ authenticated: false }))
      .mockImplementationOnce(() => hangingLogin);
    vi.stubGlobal("fetch", fetchMock);
    render(<GoogleLoginPanel clientId="client-a" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const { signInWithGoogleCredential } = await import("./session");
    const loginPromise = signInWithGoogleCredential("cred");
    expect(await screen.findByTestId("google-login-signing_in")).toBeTruthy();
    expect(screen.queryByTestId("google-login-button-host")).toBeNull();
    resolveLogin(jsonResponse(authenticatedBody));
    await loginPromise;
  });

  it("JWT/credential never enters the DOM", async () => {
    // login with a fake credential that would flow through the store path
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(jsonResponse(authenticatedBody));
    vi.stubGlobal("fetch", fetchMock);
    const { signInWithGoogleCredential } = await import("./session");
    const secretCredential = "eyJhbGciOiJFUzI1NiIsImtpZCI6InNlY3JldCJ9.secret-part.signature";
    const loginPromise = signInWithGoogleCredential(secretCredential);
    render(<GoogleLoginPanel clientId="client-a" />);
    await loginPromise;
    await screen.findByTestId("google-login-authenticated");
    expect(document.body.innerHTML).not.toContain(secretCredential);
    expect(document.body.innerHTML).not.toContain("secret-part");
  });
});
