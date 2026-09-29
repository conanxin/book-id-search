import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GSI_SCRIPT_ID,
  __getInitializedClientIdForTests,
  __resetGoogleIdentityForTests,
  disableGoogleAutoSelect,
  initializeGoogleIdentity,
  loadGoogleIdentityServices,
  renderGoogleButton,
} from "./googleIdentity";

interface FakeIdApi {
  initialize: ReturnType<typeof vi.fn>;
  renderButton: ReturnType<typeof vi.fn>;
  disableAutoSelect: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
}

function installFakeGoogle(idApi?: Partial<FakeIdApi>): FakeIdApi {
  const full: FakeIdApi = {
    initialize: vi.fn(),
    renderButton: vi.fn(),
    disableAutoSelect: vi.fn(),
    prompt: vi.fn(),
    ...idApi,
  };
  (globalThis as unknown as { google: unknown }).google = { accounts: { id: full } };
  return full;
}

interface FakeScriptShape {
  id: string;
  src: string;
  async: boolean;
  defer: boolean;
  listeners: Record<string, (() => void)[]>;
}

class FakeScript implements FakeScriptShape {
  id = "";
  src = "";
  async = false;
  defer = true;
  listeners: Record<string, (() => void)[]> = {};
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
}

class FakeDocument {
  public head: { appendChild: (el: unknown) => void } = { appendChild: () => {} };
  public elements = new Map<string, unknown>();
  createElement(_tag: string): FakeScript {
    return new FakeScript();
  }
  getElementById(id: string): unknown { return this.elements.get(id) ?? null; }
  get tag() { return "fake"; }
}

function fireScript(script: { listeners: Record<string, (() => void)[]> }, type: string): void {
  for (const fn of script.listeners[type] ?? []) fn();
}

describe("google identity services loader", () => {
  const originalGoogle = (globalThis as unknown as { google?: unknown }).google;
  const originalDocument = (globalThis as unknown as { document?: unknown }).document;

  beforeEach(() => {
    __resetGoogleIdentityForTests();
    delete (globalThis as unknown as { google?: unknown }).google;
    delete (globalThis as unknown as { document?: unknown }).document;
  });
  afterEach(() => {
    if (originalGoogle !== undefined) (globalThis as unknown as { google: unknown }).google = originalGoogle;
    else delete (globalThis as unknown as { google?: unknown }).google;
    if (originalDocument !== undefined) (globalThis as unknown as { document?: unknown }).document = originalDocument;
    else delete (globalThis as unknown as { document?: unknown }).document;
  });

  it("window.google already present → no script injected", async () => {
    installFakeGoogle();
    const doc = new FakeDocument();
    (globalThis as unknown as { document: unknown }).document = doc;
    const ns = await loadGoogleIdentityServices();
    expect(ns.accounts.id).toBeDefined();
    expect(doc.elements.size).toBe(0);
  });

  it("script injected once with fixed id; concurrent loads dedupe", async () => {
    const doc = new FakeDocument();
    let created: FakeScript | null = null;
    doc.head.appendChild = (el: unknown) => {
      const script = el as FakeScript;
      doc.elements.set(script.id, script);
      created = script;
    };
    (globalThis as unknown as { document: unknown }).document = doc;
    const p1 = loadGoogleIdentityServices();
    const p2 = loadGoogleIdentityServices();
    await Promise.resolve();
    expect(created).not.toBeNull();
    expect(created?.id).toBe(GSI_SCRIPT_ID);
    // simulate script load → namespace appears
    if (created) fireScript(created, "load");
    setTimeout(() => installFakeGoogle(), 0);
    await Promise.all([p1, p2]);
    // one script element only
    expect(doc.elements.size).toBe(1);
  });

  it("script error → load rejects; retry is possible", async () => {
    const doc = new FakeDocument();
    let created: FakeScript | null = null;
    doc.head.appendChild = (el: unknown) => {
      created = el as FakeScript;
    };
    (globalThis as unknown as { document: unknown }).document = doc;
    const p = loadGoogleIdentityServices();
    await Promise.resolve();
    if (created) fireScript(created, "error");
    await expect(p).rejects.toThrow("GSI_SCRIPT_ERROR");
    // retry after failure creates a fresh attempt whose script also errors
    const retry = loadGoogleIdentityServices();
    await Promise.resolve();
    // appendBody captured the second script into `created`; fire its error
    const second = created;
    if (second) fireScript(second, "error");
    await expect(retry).rejects.toThrow("GSI_SCRIPT_ERROR");
    expect(second).not.toBeNull();
  });

  it("initialize once per clientId; same id is a no-op", async () => {
    const id = installFakeGoogle();
    const onCred = vi.fn(async () => {});
    await initializeGoogleIdentity("client-a", onCred);
    await initializeGoogleIdentity("client-a", onCred);
    expect(id.initialize).toHaveBeenCalledTimes(1);
    expect(__getInitializedClientIdForTests()).toBe("client-a");
  });

  it("different clientId second initialize fails closed", async () => {
    installFakeGoogle();
    const onCred = vi.fn(async () => {});
    await initializeGoogleIdentity("client-a", onCred);
    await expect(initializeGoogleIdentity("client-b", onCred)).rejects.toThrow("GSI_CLIENT_ID_MISMATCH");
  });

  it("initialize passes auto_select=false and no prompt call", async () => {
    const id = installFakeGoogle();
    await initializeGoogleIdentity("client-a", vi.fn(async () => {}));
    const config = id.initialize.mock.calls[0][0] as { auto_select?: boolean; client_id: string };
    expect(config.client_id).toBe("client-a");
    expect(config.auto_select).toBe(false);
    expect(id.prompt).not.toHaveBeenCalled();
  });

  it("credential callback forwards to the handler", async () => {
    const id = installFakeGoogle();
    const onCred = vi.fn(async () => {});
    await initializeGoogleIdentity("client-a", onCred);
    const config = id.initialize.mock.calls[0][0] as { callback: (r: { credential?: string }) => void };
    config.callback({ credential: "jwt-xyz" });
    expect(onCred).toHaveBeenCalledWith("jwt-xyz");
  });

  it("malformed credential response is safely ignored", async () => {
    const id = installFakeGoogle();
    const onCred = vi.fn(async () => {});
    await initializeGoogleIdentity("client-a", onCred);
    const config = id.initialize.mock.calls[0][0] as { callback: (r: { credential?: string }) => void };
    config.callback({});
    config.callback({ credential: "" });
    config.callback({ credential: 42 } as unknown as { credential?: string });
    expect(onCred).not.toHaveBeenCalled();
  });

  it("renderButton renders into multiple containers", async () => {
    const id = installFakeGoogle();
    const a = {} as HTMLElement;
    const b = {} as HTMLElement;
    await renderGoogleButton(a);
    await renderGoogleButton(b, { width: 300 });
    expect(id.renderButton).toHaveBeenCalledTimes(2);
    expect(id.renderButton.mock.calls[0][0]).toBe(a);
    expect(id.renderButton.mock.calls[1][1]).toMatchObject({ width: 300 });
  });

  it("disableAutoSelect calls through when google is loaded", () => {
    const id = installFakeGoogle();
    disableGoogleAutoSelect();
    expect(id.disableAutoSelect).toHaveBeenCalledTimes(1);
  });

  it("disableAutoSelect is a safe no-op without google", () => {
    expect(() => disableGoogleAutoSelect()).not.toThrow();
  });
});
