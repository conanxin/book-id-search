// P9-A Research Runtime — first active skill contract v0.1.
// Contract only: this skill does NOT execute LLM calls. It declares triggers,
// query classes, authority order, mandatory passes, evidence policy, and
// output sections. Execution (evidence retrieval/bundles) is P9-B.

import type { ResearchSkill } from "./types.js";

export const sourceProvenanceInvestigationSkill: ResearchSkill = {
  id: "skill:source-provenance-investigation",
  version: "0.1",
  triggers: ["provenance", "chronology", "bibliographic"],
  researchQueryClasses: [
    "identity",
    "earliest_attestation",
    "chronology",
    "ownership_or_custody",
    "transaction",
    "publication_or_catalog",
    "contradictory_attribution",
    "missing_link",
  ],
  authorityOrder: [
    "primary",
    "archival_catalog",
    "contemporary_record",
    "scholarly_secondary",
    "later_secondary",
    "web_reference",
  ],
  mandatoryPasses: [
    "contradiction_pass",
    "chronology_gap_pass",
    "alias_variant_pass",
  ],
  evidencePolicy: {
    citationRequired: true,
    counterevidenceRequired: true,
    minimumDistinctSources: 2,
    noUnsurfacedSources: true,
    exposeMissingEvidence: true,
  },
  outputSections: [
    "target_identity",
    "established_facts",
    "provenance_chain",
    "disputed_links",
    "negative_evidence",
    "missing_links",
    "confidence_by_link",
    "next_best_source",
  ],
};
