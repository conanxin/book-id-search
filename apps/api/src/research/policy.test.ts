import { describe, expect, it } from "vitest";
import { resolveEffectiveCapability } from "./policy.js";
import { getPolicy, getSource } from "./registry.js";
import type { KnowledgePolicy, Source } from "./types.js";

// A fully-capable, fully-permitted baseline; each test flips exactly one gate.
const baselineSource: Source = {
  identity: { id: "src:unit:baseline", title: "baseline", kind: "book" },
  provenance: { acquisition: "synthetic_fixture", acquiredAt: null, note: null },
  contentState: { hasRetrievableContent: true, extraction: "extracted", indexing: "full" },
  technicalCapabilities: { actions: ["read_text"] },
  researchProfile: { authorityTiers: ["primary"], aliases: [] },
  policyRef: { policyId: "pol:unit:baseline" },
  lifecycle: { state: "active" },
};

const baselinePolicy: KnowledgePolicy = {
  id: "pol:unit:baseline",
  rules: [
    {
      action: "read_text",
      effect: "allow",
      surfaces: ["api"],
      purposes: ["provenance_investigation"],
    },
  ],
};

const REQ = {
  sourceId: "src:unit:baseline",
  action: "read_text",
  surface: "api",
  purpose: "provenance_investigation",
  at: "2026-01-01",
};

function resolve(overrides: {
  source?: Partial<Source>;
  policy?: KnowledgePolicy | undefined;
  request?: typeof REQ;
}) {
  const source = { ...baselineSource, ...overrides.source };
  return resolveEffectiveCapability({
    source,
    policy: "policy" in overrides ? overrides.policy : baselinePolicy,
    request: overrides.request ?? { ...REQ, sourceId: source.identity.id },
  });
}

describe("resolveEffectiveCapability truth table", () => {
  it("allows when every gate holds", () => {
    const result = resolve({});
    expect(result).toEqual({ allowed: true, sourceId: "src:unit:baseline", action: "read_text" });
  });

  it("denies TECHNICAL_CAPABILITY_MISSING when the action is not physically available", () => {
    const result = resolve({ source: { technicalCapabilities: { actions: ["ocr"] } } });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("TECHNICAL_CAPABILITY_MISSING");
  });

  it("denies POLICY_DENIED when the policy is unknown (fail closed)", () => {
    const result = resolve({ policy: undefined });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("POLICY_DENIED");
  });

  it("denies POLICY_DENIED when no rule allows the action", () => {
    const result = resolve({ policy: { ...baselinePolicy, rules: [] } });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("POLICY_DENIED");
  });

  it("deny/prohibition wins over a simultaneous allow", () => {
    const result = resolve({
      policy: {
        ...baselinePolicy,
        rules: [
          ...baselinePolicy.rules,
          {
            action: "read_text",
            effect: "deny",
            surfaces: ["api"],
            purposes: ["provenance_investigation"],
          },
        ],
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("POLICY_DENIED");
  });

  it("a prohibition scoped to another surface does not block us", () => {
    const result = resolve({
      policy: {
        ...baselinePolicy,
        rules: [
          ...baselinePolicy.rules,
          { action: "read_text", effect: "deny", surfaces: ["batch"], purposes: ["provenance_investigation"] },
        ],
      },
    });
    expect(result.allowed).toBe(true);
  });

  it("denies SURFACE_NOT_ALLOWED when the allow rule covers other surfaces", () => {
    const result = resolve({ request: { ...REQ, surface: "batch" } });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("SURFACE_NOT_ALLOWED");
  });

  it("denies PURPOSE_NOT_ALLOWED when the allow rule covers other purposes", () => {
    const result = resolve({ request: { ...REQ, purpose: "general_reading" } });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("PURPOSE_NOT_ALLOWED");
  });

  it("denies ENTITLEMENT_EXPIRED when the required entitlement has lapsed", () => {
    const result = resolve({
      policy: {
        ...baselinePolicy,
        rules: [
          {
            action: "read_text",
            effect: "allow",
            surfaces: ["api"],
            purposes: ["provenance_investigation"],
            requiresEntitlement: { kind: "license", expiresAt: "2025-12-31" },
          },
        ],
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ENTITLEMENT_EXPIRED");
  });

  it("allows an entitlement rule before expiry (boundary date inclusive)", () => {
    const result = resolve({
      policy: {
        ...baselinePolicy,
        rules: [
          {
            action: "read_text",
            effect: "allow",
            surfaces: ["api"],
            purposes: ["provenance_investigation"],
            requiresEntitlement: { kind: "license", expiresAt: "2026-01-01" },
          },
        ],
      },
    });
    expect(result.allowed).toBe(true);
  });

  it("policy permission never conjures a missing technical capability", () => {
    // Permission present, capability absent — capability wins as blocker.
    const result = resolve({
      source: { technicalCapabilities: { actions: [] } },
      policy: {
        ...baselinePolicy,
        rules: baselinePolicy.rules.map(r => ({ ...r, action: "read_text" })),
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("TECHNICAL_CAPABILITY_MISSING");
  });
});

describe("synthetic registry four-axis visibility", () => {
  it("each fixture exposes identity / technical / rights / authority independently", () => {
    for (const id of [
      "src:test:public-book",
      "src:test:licensed-book",
      "src:test:expired-license",
      "src:test:technical-only",
    ]) {
      const source = getSource(id);
      expect(source, id).toBeDefined();
      if (!source) continue;
      expect(source.identity.id).toBe(id);
      expect(Array.isArray(source.technicalCapabilities.actions)).toBe(true);
      expect(typeof source.policyRef.policyId).toBe("string");
      expect(source.policyRef.policyId).toMatch(/^pol:test:/);
      expect(Array.isArray(source.researchProfile.authorityTiers)).toBe(true);
      expect(source.researchProfile.authorityTiers.length).toBeGreaterThan(0);
      // The axes are separate fields, not merged.
      expect(source.policyRef.policyId).not.toBe(source.identity.id);
      expect(getPolicy(source.policyRef.policyId)).toBeDefined();
    }
  });

  it("technical-only fixture has no granting policy rule", () => {
    const source = getSource("src:test:technical-only");
    const policy = source ? getPolicy(source.policyRef.policyId) : undefined;
    expect(source?.technicalCapabilities.actions).toContain("read_text");
    expect(policy?.rules).toHaveLength(0);
    const result = resolveEffectiveCapability({
      source: source!,
      policy,
      request: {
        sourceId: source!.identity.id,
        action: "read_text",
        surface: "api",
        purpose: "provenance_investigation",
        at: "2026-01-01",
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("POLICY_DENIED");
  });

  it("expired-license fixture denies with ENTITLEMENT_EXPIRED", () => {
    const source = getSource("src:test:expired-license")!;
    const result = resolveEffectiveCapability({
      source,
      policy: getPolicy(source.policyRef.policyId),
      request: {
        sourceId: source.identity.id,
        action: "read_text",
        surface: "api",
        purpose: "provenance_investigation",
        at: "2026-01-01",
      },
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ENTITLEMENT_EXPIRED");
  });
});
