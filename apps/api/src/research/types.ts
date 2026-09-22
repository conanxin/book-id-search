// P9-A Research Runtime — frozen v0.1 type contracts (EI_P9A_RESEARCH_RUNTIME_SKELETON_R1).
// Contract-only layer: no DB, no network, no LLM. Types are intentionally
// explicit about the four axes that must never collapse into one field:
// technical capability, rights (policy), and research authority.

// ---------------------------------------------------------------------------
// Deny reasons — typed, stable surface for policy evaluation results.
// ---------------------------------------------------------------------------

export type ResearchPolicyDenyReason =
  | "TECHNICAL_CAPABILITY_MISSING"
  | "POLICY_DENIED"
  | "ENTITLEMENT_MISSING"
  | "ENTITLEMENT_EXPIRED"
  | "SURFACE_NOT_ALLOWED"
  | "PURPOSE_NOT_ALLOWED";

// ---------------------------------------------------------------------------
// Registry lookup errors — typed errors surfaced by the router.
// ---------------------------------------------------------------------------

export type ResearchRegistryError =
  | "SOURCE_NOT_FOUND"
  | "POLICY_NOT_FOUND"
  | "SKILL_NOT_FOUND";

export type ResearchErrorCode =
  | ResearchRegistryError
  | ResearchPolicyDenyReason;

// ---------------------------------------------------------------------------
// Source — seven separated concerns. Do not merge axes.
// ---------------------------------------------------------------------------

export interface SourceIdentity {
  /** Stable registry id, e.g. "src:test:public-book". */
  readonly id: string;
  /** Human-readable title. Synthetic fixtures use clearly fake names. */
  readonly title: string;
  /** Kind of underlying material, e.g. "book", "archive", "catalog". */
  readonly kind: string;
}

export interface SourceProvenance {
  /** How this source entered the runtime, e.g. "synthetic_fixture". */
  readonly acquisition: string;
  /** ISO-8601 date (date only) of acquisition, or null for synthetic. */
  readonly acquiredAt: string | null;
  /** Free-form lineage note; synthetic fixtures say so explicitly. */
  readonly note: string | null;
}

export interface SourceContentState {
  /** Whether retrievable content exists behind this source. */
  readonly hasRetrievableContent: boolean;
  /** Extraction status, e.g. "not_extracted", "extracted". */
  readonly extraction: "not_extracted" | "extracted";
  /** Structured index coverage, e.g. "none", "partial", "full". */
  readonly indexing: "none" | "partial" | "full";
}

/** Axis 1: what the runtime can technically do with this source. */
export interface TechnicalCapabilities {
  /** Actions the runtime can physically execute, e.g. "read_text", "ocr". */
  readonly actions: readonly string[];
}

/** Axis 2: what rights/policy permit. Never inferred from capability. */
export interface SourceRights {
  /** id of the KnowledgePolicy that governs this source. */
  readonly policyId: string;
}

/** Axis 3: what research authority this source can carry. */
export interface ResearchProfile {
  /** Authority tiers this source can serve as, ordered strongest-first. */
  readonly authorityTiers: readonly AuthorityTier[];
  /** Canonical bibliographic identity hints, if any. */
  readonly aliases: readonly string[];
}

export interface SourcePolicyRef {
  /** Resolved policy id; must exist in the policy registry. */
  readonly policyId: string;
}

export interface SourceLifecycle {
  /** "active" | "retired" */
  readonly state: "active" | "retired";
}

export interface Source {
  readonly identity: SourceIdentity;
  readonly provenance: SourceProvenance;
  readonly contentState: SourceContentState;
  readonly technicalCapabilities: TechnicalCapabilities;
  readonly researchProfile: ResearchProfile;
  readonly policyRef: SourcePolicyRef;
  readonly lifecycle: SourceLifecycle;
}

// ---------------------------------------------------------------------------
// KnowledgePolicy — permission/prohibition/entitlement model.
// ---------------------------------------------------------------------------

export type AuthorityTier =
  | "primary"
  | "archival_catalog"
  | "contemporary_record"
  | "scholarly_secondary"
  | "later_secondary"
  | "web_reference";

export interface PolicyRule {
  /** Action name this rule governs, e.g. "read_text", "export_excerpt". */
  readonly action: string;
  /** "allow" | "deny" — deny/prohibition always wins. */
  readonly effect: "allow" | "deny";
  /** Execution surfaces where this rule applies, e.g. "api", "batch". */
  readonly surfaces: readonly string[];
  /** Research purposes this rule applies to, e.g. "provenance_investigation". */
  readonly purposes: readonly string[];
  /** Optional entitlement requirement; if present it must be valid. */
  readonly requiresEntitlement?: {
    readonly kind: string;
    /** Inclusive expiry, ISO-8601 date. Expired => deny ENTITLEMENT_EXPIRED. */
    readonly expiresAt: string;
  };
}

export interface KnowledgePolicy {
  readonly id: string;
  readonly rules: readonly PolicyRule[];
}

// ---------------------------------------------------------------------------
// Capability resolution request/result.
// ---------------------------------------------------------------------------

export interface CapabilityResolutionRequest {
  readonly sourceId: string;
  readonly action: string;
  readonly surface: string;
  readonly purpose: string;
  /** ISO-8601 date used for expiry checks. */
  readonly at: string;
}

export interface CapabilityResolutionAllowed {
  readonly allowed: true;
  readonly sourceId: string;
  readonly action: string;
}

export interface CapabilityResolutionDenied {
  readonly allowed: false;
  readonly reason: ResearchPolicyDenyReason;
  readonly sourceId: string;
  readonly action: string;
}

export type CapabilityResolution =
  | CapabilityResolutionAllowed
  | CapabilityResolutionDenied;

// ---------------------------------------------------------------------------
// ResearchSkill — contract-only; skills do not execute LLM calls in P9-A.
// ---------------------------------------------------------------------------

export type ResearchQueryClass =
  | "identity"
  | "earliest_attestation"
  | "chronology"
  | "ownership_or_custody"
  | "transaction"
  | "publication_or_catalog"
  | "contradictory_attribution"
  | "missing_link";

export interface EvidencePolicy {
  readonly citationRequired: boolean;
  readonly counterevidenceRequired: boolean;
  readonly minimumDistinctSources: number;
  readonly noUnsurfacedSources: boolean;
  readonly exposeMissingEvidence: boolean;
}

export interface ResearchSkillContract {
  readonly id: string;
  readonly version: string;
  readonly triggers: readonly string[];
  readonly researchQueryClasses: readonly ResearchQueryClass[];
  /** Strongest-first authority order this skill accepts. */
  readonly authorityOrder: readonly AuthorityTier[];
  readonly mandatoryPasses: readonly string[];
  readonly evidencePolicy: EvidencePolicy;
  readonly outputSections: readonly string[];
}

export type ResearchSkill = ResearchSkillContract;

// ---------------------------------------------------------------------------
// EvidenceBundle — public shape only; construction is P9-B.
// ---------------------------------------------------------------------------

export interface EvidenceBundleCitation {
  readonly sourceId: string;
  readonly authorityTier: AuthorityTier;
  readonly locator: string | null;
  readonly quotedText: string | null;
}

export interface EvidenceBundle {
  readonly id: string;
  readonly skillId: string;
  readonly createdAt: string;
  readonly citations: readonly EvidenceBundleCitation[];
  /** Sections required by the skill's outputSections, in order. */
  readonly sections: Readonly<Record<string, unknown>>;
}
