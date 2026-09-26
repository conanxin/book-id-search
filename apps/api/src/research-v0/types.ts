export type ResearchIntent =
  | "lookup"
  | "bibliographic"
  | "provenance"
  | "chronology"
  | "comparison"
  | "historiography"
  | "spatial"
  | "visual_evidence"
  | "hypothesis_test"
  | "synthesis";

export type ResearchAuthorityClass =
  | "primary"
  | "scholarly_secondary"
  | "reference"
  | "contemporary_press"
  | "later_secondary"
  | "web_reference"
  | "personal_observation";

export interface CatalogBookDocument {
  id: string;
  ssid?: string;
  dxid?: string;
  title: string;
  author?: string;
  publisher?: string;
  year?: number | null;
  pages?: number | null;
  isbn?: string;
  rawInfo?: string;
}

export interface ResearchSource {
  schema_version: "0.1";
  source_id: string;
  source_type: "book";
  identity: {
    title: string;
    creators: Array<{ name: string; role: "author" }>;
    identifiers: {
      isbn: string[];
      external_ids: Record<string, string>;
    };
    edition: {
      publication_date: string | null;
      publisher: string | null;
      language: string | null;
    };
  };
  provenance: {
    acquisition_type: "catalog_metadata" | "owned_file" | "licensed" | "public_domain";
    origin_uri: string | null;
    verification_status: "verified" | "partially_verified" | "unverified";
  };
  content_state: {
    metadata_available: boolean;
    fulltext_available: boolean;
    ocr_available: boolean;
    page_map_available: boolean;
  };
  technical_capabilities: {
    keyword_search: boolean;
    semantic_search: boolean;
    retrieve_passage: boolean;
    retrieve_page: boolean;
    citation_page: boolean;
    citation_paragraph: boolean;
  };
  research_profile: {
    authority_class: ResearchAuthorityClass;
    source_roles: string[];
    recency_class: "historical_fixed" | "foundational" | "current_dynamic";
  };
  policy_ref: {
    active_policy_id: string;
    active_policy_version: number;
  };
}

export interface KnowledgePolicy {
  schema_version: "0.1";
  policy_id: string;
  policy_version: number;
  source_id: string;
  entitlement: {
    type: "owned" | "licensed" | "subscription" | "public_domain" | "personal_copy" | "catalog_metadata";
    valid_until: string | null;
  };
  permissions: {
    read: boolean;
    search: boolean;
    ai_index: boolean;
    ai_input: boolean;
    summarize: boolean;
    compare: boolean;
    cross_source_synthesis: boolean;
    quote: boolean;
    generate_artifact: boolean;
    export_artifact: boolean;
    share_public: boolean;
    agent_execute: boolean;
    ai_train: boolean;
  };
  constraints: {
    execution_surfaces: string[];
    purposes: string[];
    citation_required: boolean;
  };
  derived_artifacts: {
    policy_mode: "inherit" | "transform" | "independent";
    public_share: boolean;
  };
  enforcement: {
    conflict_strategy: "prohibition_wins";
    revalidate_after_days: number;
  };
}

export type CapabilityAction =
  | "read"
  | "search"
  | "ai_input"
  | "retrieve_passage"
  | "generate_artifact";

export interface CapabilityDecision {
  allowed: boolean;
  code?: "TECHNICAL_CAPABILITY_MISSING" | "POLICY_DENIED" | "ENTITLEMENT_MISSING";
  reason?: string;
}

export interface ResearchEvidence {
  evidence_id: string;
  source_id: string;
  location: {
    page: number | null;
    chapter: string | null;
    paragraph: string | null;
  };
  passage_ref: string;
  evidence_role: "support" | "counterevidence" | "context" | "chronology" | "identity" | "negative_evidence";
  source_role: "primary" | "secondary";
  retrieval: {
    method: "keyword" | "semantic" | "manual";
    relevance: number | null;
    retrieved_at: string;
  };
  citation: {
    display: string;
    stable_locator: string;
  };
  policy_snapshot: {
    policy_id: string;
    policy_version: number;
  };
}

export interface EvidenceSeed {
  source_id: string;
  text: string;
  page?: number | null;
  chapter?: string | null;
  citation: string;
  stable_locator: string;
  source_role?: "primary" | "secondary";
  evidence_role?: ResearchEvidence["evidence_role"];
}

export interface ResearchSkill {
  schema_version: "0.1";
  skill_id: string;
  version: "0.1";
  title: string;
  description: string;
  triggers: {
    intents: ResearchIntent[];
    positive_examples: string[];
  };
  context_contract: {
    required_fields: string[];
    important_fields: string[];
    clarification_policy: {
      mode: "best_effort";
      max_questions: 0;
    };
  };
  research_plan: {
    query_classes: string[];
    retrieval_order: ResearchAuthorityClass[];
    mandatory_passes: string[];
  };
  evidence_policy: {
    citation_required: true;
    counterevidence_required: true;
    minimum_distinct_sources: number;
    no_unsurfaced_sources: true;
    expose_missing_evidence: true;
  };
  output_contract: {
    type: "evidence_map";
    required_sections: string[];
  };
  epistemic_policy: {
    distinguish_fact_inference_hypothesis: true;
    unresolved_conflicts_required: true;
    model_memory_as_evidence: false;
  };
}

export interface EvidenceBundle {
  schema_version: "0.1";
  bundle_id: string;
  question: string;
  intent: ResearchIntent;
  skill_ref: {
    skill_id: string;
    skill_version: "0.1";
  };
  claims: Array<{
    claim_id: string;
    text: string;
    status: "supported" | "partially_supported" | "contested" | "unsupported" | "unknown";
    confidence: "high" | "medium" | "low";
    evidence_ids: string[];
    counterevidence_ids: string[];
    unresolved_conflict_ids: string[];
  }>;
  evidence: ResearchEvidence[];
  conflicts: Array<{
    conflict_id: string;
    type: "chronology" | "identity" | "attribution" | "interpretation" | "source_disagreement";
    evidence_ids: string[];
    resolution_status: "unresolved";
  }>;
  gaps: Array<{
    gap_id: string;
    description: string;
    importance: "critical" | "important" | "nice_to_have";
    next_source_hint: string | null;
  }>;
  audit: {
    created_at: string;
    runtime_version: "research-v0.1";
    false_closure_protection: true;
  };
}

export interface CatalogAdapter {
  getDocument(id: string): Promise<CatalogBookDocument>;
  search(query: string, limit: number): Promise<CatalogBookDocument[]>;
}
