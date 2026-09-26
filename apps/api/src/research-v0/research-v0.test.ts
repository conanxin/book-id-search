import { describe, expect, it, vi } from "vitest";
import { createResearchV0Service, ResearchV0Error } from "./service.js";
import type { CatalogAdapter, ResearchSource } from "./types.js";

const catalog: CatalogAdapter = {
  getDocument: vi.fn(async (id: string) => ({
    id,
    title: "Catalog Book",
    author: "Author A",
    publisher: "Publisher",
    year: 1932,
    isbn: "9780000000000",
  })),
  search: vi.fn(async () => [
    {
      id: "123",
      title: "Catalog Book",
      author: "Author A",
      publisher: "Publisher",
      year: 1932,
      isbn: "9780000000000",
    },
  ]),
};

const seedSource: ResearchSource = {
  schema_version: "0.1",
  source_id: "seed:auction-catalog-1932",
  source_type: "book",
  identity: {
    title: "1932 Paris Sale Catalogue",
    creators: [{ name: "Auction House", role: "author" }],
    identifiers: { isbn: [], external_ids: { catalog: "sale-1932" } },
    edition: { publication_date: "1932-02-01", publisher: null, language: "fr" },
  },
  provenance: {
    acquisition_type: "owned_file",
    origin_uri: null,
    verification_status: "verified",
  },
  content_state: {
    metadata_available: true,
    fulltext_available: true,
    ocr_available: true,
    page_map_available: true,
  },
  technical_capabilities: {
    keyword_search: true,
    semantic_search: true,
    retrieve_passage: true,
    retrieve_page: true,
    citation_page: true,
    citation_paragraph: false,
  },
  research_profile: {
    authority_class: "primary",
    source_roles: ["evidence", "chronology"],
    recency_class: "historical_fixed",
  },
  policy_ref: {
    active_policy_id: "policy:seed:auction-catalog-1932",
    active_policy_version: 1,
  },
};

describe("research-v0 service", () => {
  it("maps the existing catalog into metadata-only research sources", async () => {
    const service = createResearchV0Service({ catalog });
    const source = await service.getSource("catalog:123");

    expect(source.identity.title).toBe("Catalog Book");
    expect(source.technical_capabilities.retrieve_passage).toBe(false);
    expect(source.research_profile.authority_class).toBe("reference");
  });

  it("does not invent evidence when catalog metadata has no retrievable full text", async () => {
    const service = createResearchV0Service({ catalog });

    await expect(
      service.retrieveEvidence({ source_id: "catalog:123", query: "sale lot 214" }),
    ).rejects.toMatchObject({
      code: "TECHNICAL_CAPABILITY_MISSING",
    } satisfies Partial<ResearchV0Error>);
  });

  it("returns cited evidence with a policy snapshot for an eligible seed source", async () => {
    const service = createResearchV0Service({
      catalog,
      seedSources: [seedSource],
      seedEvidence: [
        {
          source_id: seedSource.source_id,
          text: "Lot 214 records a Buddhist head offered in the 1932 Paris sale.",
          page: 47,
          citation: "1932 Paris Sale Catalogue, p. 47",
          stable_locator: "sale-1932:p47:lot214",
          source_role: "primary",
          evidence_role: "chronology",
        },
      ],
    });

    const evidence = await service.retrieveEvidence({
      source_id: seedSource.source_id,
      query: "lot 214",
    });

    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.location.page).toBe(47);
    expect(evidence[0]?.policy_snapshot.policy_id).toBe(seedSource.policy_ref.active_policy_id);
  });

  it("preserves UNKNOWN and an explicit gap instead of falsely closing an unsupported chain", async () => {
    const service = createResearchV0Service({ catalog });
    const bundle = await service.buildBundle({
      question: "重建该佛头像 1930-1949 流转",
      intent: "provenance",
      candidate_source_ids: ["catalog:123"],
    });

    expect(bundle.claims[0]?.status).toBe("unknown");
    expect(bundle.audit.false_closure_protection).toBe(true);
    expect(bundle.gaps.some((gap) => gap.description.includes("TECHNICAL_CAPABILITY_MISSING"))).toBe(true);
    expect(bundle.evidence).toHaveLength(0);
  });
});
