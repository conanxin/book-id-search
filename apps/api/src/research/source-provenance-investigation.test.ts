import { describe, expect, it } from "vitest";
import { getSkill } from "./registry.js";
import { sourceProvenanceInvestigationSkill } from "./source-provenance-investigation.js";

describe("skill:source-provenance-investigation contract", () => {
  it("exposes the frozen v0.1 identity", () => {
    expect(sourceProvenanceInvestigationSkill.id).toBe("skill:source-provenance-investigation");
    expect(sourceProvenanceInvestigationSkill.version).toBe("0.1");
    expect(getSkill("skill:source-provenance-investigation")).toBe(sourceProvenanceInvestigationSkill);
  });

  it("declares the required triggers", () => {
    expect(sourceProvenanceInvestigationSkill.triggers).toEqual(
      expect.arrayContaining(["provenance", "chronology", "bibliographic"]),
    );
  });

  it("declares all eight research query classes", () => {
    expect(sourceProvenanceInvestigationSkill.researchQueryClasses).toEqual([
      "identity",
      "earliest_attestation",
      "chronology",
      "ownership_or_custody",
      "transaction",
      "publication_or_catalog",
      "contradictory_attribution",
      "missing_link",
    ]);
  });

  it("declares strongest-first authority order", () => {
    expect(sourceProvenanceInvestigationSkill.authorityOrder).toEqual([
      "primary",
      "archival_catalog",
      "contemporary_record",
      "scholarly_secondary",
      "later_secondary",
      "web_reference",
    ]);
  });

  it("declares the three mandatory passes", () => {
    expect(sourceProvenanceInvestigationSkill.mandatoryPasses).toEqual([
      "contradiction_pass",
      "chronology_gap_pass",
      "alias_variant_pass",
    ]);
  });

  it("declares a strict evidence policy", () => {
    expect(sourceProvenanceInvestigationSkill.evidencePolicy).toEqual({
      citationRequired: true,
      counterevidenceRequired: true,
      minimumDistinctSources: 2,
      noUnsurfacedSources: true,
      exposeMissingEvidence: true,
    });
  });

  it("declares all eight output sections in order", () => {
    expect(sourceProvenanceInvestigationSkill.outputSections).toEqual([
      "target_identity",
      "established_facts",
      "provenance_chain",
      "disputed_links",
      "negative_evidence",
      "missing_links",
      "confidence_by_link",
      "next_best_source",
    ]);
  });
});
