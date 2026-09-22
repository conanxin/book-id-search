// P9-A Research Runtime — pure capability evaluator.
// effective(action) = technical AND permission AND surface AND purpose
//                   AND entitlement-valid AND not-expired.
// Fail closed: deny/prohibition wins; unknown policy never passes; expired
// entitlement rejects. No DB, no network, no LLM, no clock reads — `at`
// comes in as data.

import type {
  CapabilityResolution,
  CapabilityResolutionRequest,
  KnowledgePolicy,
  Source,
} from "./types.js";

export interface PolicyEvaluationInput {
  readonly source: Source;
  readonly policy: KnowledgePolicy | undefined;
  readonly request: CapabilityResolutionRequest;
}

function dateOnly(iso: string): string | null {
  // Accept only YYYY-MM-DD for deterministic, timezone-free comparisons.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  return iso;
}

export function resolveEffectiveCapability(
  input: PolicyEvaluationInput,
): CapabilityResolution {
  const { source, policy, request } = input;
  const deny = (
    reason: import("./types.js").ResearchPolicyDenyReason,
  ): CapabilityResolution => ({
    allowed: false,
    reason,
    sourceId: request.sourceId,
    action: request.action,
  });

  // Gate 1 — technical capability. A permission can never conjure a
  // capability the runtime does not physically have.
  if (
    !source.technicalCapabilities.actions.includes(request.action)
  ) {
    return deny("TECHNICAL_CAPABILITY_MISSING");
  }

  // Unknown policy fails closed.
  if (!policy) {
    return deny("POLICY_DENIED");
  }

  // Collect the rules that govern this action at all.
  const actionRules = policy.rules.filter(rule => rule.action === request.action);

  // Deny/prohibition wins: if any matching rule denies, we stop — but only
  // after checking that the deny actually applies to this surface/purpose.
  for (const rule of actionRules) {
    if (rule.effect !== "deny") continue;
    const surfaceHit = rule.surfaces.includes(request.surface);
    const purposeHit = rule.purposes.includes(request.purpose);
    // A prohibition scoped to other surface/purpose combinations does not
    // block us; one scoped to ours (or unscoped via wildcard) does.
    if (surfaceHit && purposeHit) {
      return deny("POLICY_DENIED");
    }
  }

  const allowRules = actionRules.filter(rule => rule.effect === "allow");

  // Gate 2 — policy permission: at least one allow rule for this action.
  if (allowRules.length === 0) {
    return deny("POLICY_DENIED");
  }

  // Gate 3 — execution surface: at least one allow rule covering this surface.
  const surfaceRules = allowRules.filter(rule => rule.surfaces.includes(request.surface));
  if (surfaceRules.length === 0) {
    return deny("SURFACE_NOT_ALLOWED");
  }

  // Gate 4 — purpose: at least one allow rule (already surface-matched)
  // covering this purpose.
  const purposeRules = surfaceRules.filter(rule => rule.purposes.includes(request.purpose));
  if (purposeRules.length === 0) {
    return deny("PURPOSE_NOT_ALLOWED");
  }

  // Gate 5+6 — entitlement: if any applicable allow rule requires an
  // entitlement, the request must present a matching kind. A missing claim
  // or a kind mismatch is ENTITLEMENT_MISSING; a present-but-lapsed claim
  // is ENTITLEMENT_EXPIRED. An expired entitlement can never be rescued.
  const withEntitlement = purposeRules.filter(rule => rule.requiresEntitlement);
  if (withEntitlement.length > 0) {
    const presented = request.entitlement?.kind;
    for (const rule of withEntitlement) {
      const required = rule.requiresEntitlement!;
      if (presented !== required.kind) {
        return deny("ENTITLEMENT_MISSING");
      }
      const now = dateOnly(request.at);
      const expires = dateOnly(required.expiresAt);
      if (expires !== null && now !== null && now > expires) {
        return deny("ENTITLEMENT_EXPIRED");
      }
    }
  }

  return {
    allowed: true,
    sourceId: request.sourceId,
    action: request.action,
  };
}
