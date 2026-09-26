// P9-A Research Runtime — read-only in-memory synthetic registry.
// No real/private research data. All fixtures are clearly synthetic.

import type { KnowledgePolicy, ResearchSkill, Source } from "./types.js";
import { sourceProvenanceInvestigationSkill } from "./source-provenance-investigation.js";

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

const publicBookPolicy: KnowledgePolicy = {
  id: "pol:test:public-domain-book",
  rules: [
    {
      action: "read_text",
      effect: "allow",
      surfaces: ["api", "batch"],
      purposes: ["provenance_investigation", "general_reading"],
    },
    {
      action: "export_excerpt",
      effect: "allow",
      surfaces: ["api"],
      purposes: ["provenance_investigation"],
    },
  ],
};

const licensedBookPolicy: KnowledgePolicy = {
  id: "pol:test:licensed-book",
  rules: [
    {
      action: "read_text",
      effect: "allow",
      surfaces: ["api", "batch"],
      purposes: ["provenance_investigation"],
      requiresEntitlement: { kind: "license", expiresAt: "2099-12-31" },
    },
  ],
};

const expiredLicensePolicy: KnowledgePolicy = {
  id: "pol:test:expired-license",
  rules: [
    {
      action: "read_text",
      effect: "allow",
      surfaces: ["api", "batch"],
      purposes: ["provenance_investigation"],
      requiresEntitlement: { kind: "license", expiresAt: "2020-01-01" },
    },
  ],
};

const technicalOnlyPolicy: KnowledgePolicy = {
  id: "pol:test:technical-only",
  // Capable technically, but no policy grants research use.
  rules: [],
};

// ---------------------------------------------------------------------------
// Sources — four axes visible independently:
// identity / technicalCapabilities / policyRef(rights) / researchProfile.
// ---------------------------------------------------------------------------

const publicBook: Source = {
  identity: { id: "src:test:public-book", title: "合成公共领域书籍（Synthetic Public Book）", kind: "book" },
  provenance: { acquisition: "synthetic_fixture", acquiredAt: null, note: "P9-A synthetic fixture; not real data." },
  contentState: { hasRetrievableContent: true, extraction: "extracted", indexing: "full" },
  technicalCapabilities: { actions: ["read_text", "export_excerpt"] },
  researchProfile: { authorityTiers: ["primary", "scholarly_secondary"], aliases: [] },
  policyRef: { policyId: "pol:test:public-domain-book" },
  lifecycle: { state: "active" },
};

const licensedBook: Source = {
  identity: { id: "src:test:licensed-book", title: "合成授权书籍（Synthetic Licensed Book）", kind: "book" },
  provenance: { acquisition: "synthetic_fixture", acquiredAt: null, note: "P9-A synthetic fixture; not real data." },
  contentState: { hasRetrievableContent: true, extraction: "extracted", indexing: "partial" },
  technicalCapabilities: { actions: ["read_text"] },
  researchProfile: { authorityTiers: ["primary"], aliases: [] },
  policyRef: { policyId: "pol:test:licensed-book" },
  lifecycle: { state: "active" },
};

const expiredLicense: Source = {
  identity: { id: "src:test:expired-license", title: "合成过期授权书籍（Synthetic Expired-License Book）", kind: "book" },
  provenance: { acquisition: "synthetic_fixture", acquiredAt: null, note: "P9-A synthetic fixture; not real data." },
  contentState: { hasRetrievableContent: true, extraction: "extracted", indexing: "partial" },
  technicalCapabilities: { actions: ["read_text"] },
  researchProfile: { authorityTiers: ["scholarly_secondary"], aliases: [] },
  policyRef: { policyId: "pol:test:expired-license" },
  lifecycle: { state: "active" },
};

const technicalOnly: Source = {
  identity: { id: "src:test:technical-only", title: "合成纯技术能力来源（Synthetic Technical-Only Source）", kind: "catalog" },
  provenance: { acquisition: "synthetic_fixture", acquiredAt: null, note: "P9-A synthetic fixture; not real data." },
  contentState: { hasRetrievableContent: true, extraction: "not_extracted", indexing: "none" },
  technicalCapabilities: { actions: ["read_text", "ocr"] },
  researchProfile: { authorityTiers: ["web_reference"], aliases: [] },
  policyRef: { policyId: "pol:test:technical-only" },
  lifecycle: { state: "active" },
};

// ---------------------------------------------------------------------------
// Registries
// ---------------------------------------------------------------------------

const sources: ReadonlyMap<string, Source> = new Map(
  [publicBook, licensedBook, expiredLicense, technicalOnly].map(s => [s.identity.id, s]),
);

const policies: ReadonlyMap<string, KnowledgePolicy> = new Map(
  [publicBookPolicy, licensedBookPolicy, expiredLicensePolicy, technicalOnlyPolicy].map(p => [p.id, p]),
);

const skills: ReadonlyMap<string, ResearchSkill> = new Map(
  [sourceProvenanceInvestigationSkill].map(s => [s.id, s]),
);

export function listSources(): readonly Source[] {
  return [...sources.values()];
}

export function getSource(sourceId: string): Source | undefined {
  return sources.get(sourceId);
}

export function getPolicy(policyId: string): KnowledgePolicy | undefined {
  return policies.get(policyId);
}

export function listSkills(): readonly ResearchSkill[] {
  return [...skills.values()];
}

export function getSkill(skillId: string): ResearchSkill | undefined {
  return skills.get(skillId);
}
