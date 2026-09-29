import type { ResearchSkill } from "./types.js";

export const sourceProvenanceInvestigationSkill: ResearchSkill = {
  schema_version: "0.1",
  skill_id: "skill:source-provenance-investigation",
  version: "0.1",
  title: "Source Provenance Investigation",
  description:
    "Reconstruct an object's identity, chronology, custody/publication trail, disputed links, negative evidence, and missing links without closing unsupported gaps.",
  triggers: {
    intents: ["provenance", "chronology", "bibliographic"],
    positive_examples: [
      "追查这件文物的来源和流转",
      "判断这张老照片究竟拍摄于哪里",
      "重建一本书的版本与收藏路径",
    ],
  },
  context_contract: {
    required_fields: ["target_object"],
    important_fields: ["known_date_range", "known_people", "known_places", "known_identifiers"],
    clarification_policy: {
      mode: "best_effort",
      max_questions: 0,
    },
  },
  research_plan: {
    query_classes: [
      "identity",
      "earliest_attestation",
      "chronology",
      "ownership_or_custody",
      "transaction",
      "publication_or_catalog",
      "contradictory_attribution",
      "missing_link",
    ],
    retrieval_order: [
      "primary",
      "reference",
      "contemporary_press",
      "scholarly_secondary",
      "later_secondary",
      "web_reference",
    ],
    mandatory_passes: ["contradiction_pass", "chronology_gap_pass", "alias_variant_pass"],
  },
  evidence_policy: {
    citation_required: true,
    counterevidence_required: true,
    minimum_distinct_sources: 2,
    no_unsurfaced_sources: true,
    expose_missing_evidence: true,
  },
  output_contract: {
    type: "evidence_map",
    required_sections: [
      "target_identity",
      "established_facts",
      "provenance_chain",
      "disputed_links",
      "negative_evidence",
      "missing_links",
      "confidence_by_link",
      "next_best_source",
    ],
  },
  epistemic_policy: {
    distinguish_fact_inference_hypothesis: true,
    unresolved_conflicts_required: true,
    model_memory_as_evidence: false,
  },
};

export const researchSkills = [sourceProvenanceInvestigationSkill] as const;
