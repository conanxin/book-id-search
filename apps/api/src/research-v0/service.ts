import { randomUUID } from "node:crypto";
import { catalogMetadataPolicy, evaluateCapability } from "./policy.js";
import { researchSkills } from "./skill.js";
import type {
  CatalogAdapter,
  CatalogBookDocument,
  EvidenceBundle,
  EvidenceSeed,
  KnowledgePolicy,
  ResearchEvidence,
  ResearchIntent,
  ResearchSource,
} from "./types.js";

export class ResearchV0Error extends Error {
  constructor(
    public readonly code:
      | "SOURCE_NOT_FOUND"
      | "TECHNICAL_CAPABILITY_MISSING"
      | "POLICY_DENIED"
      | "ENTITLEMENT_MISSING"
      | "INSUFFICIENT_EVIDENCE"
      | "SKILL_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "ResearchV0Error";
  }
}

function splitAuthors(author: string | undefined): Array<{ name: string; role: "author" }> {
  if (!author?.trim()) return [];
  return author
    .split(/[;,，；/]+/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => ({ name, role: "author" as const }));
}

function catalogSource(doc: CatalogBookDocument): ResearchSource {
  const sourceId = `catalog:${doc.id}`;
  const year = typeof doc.year === "number" ? String(doc.year).padStart(4, "0") : null;
  return {
    schema_version: "0.1",
    source_id: sourceId,
    source_type: "book",
    identity: {
      title: doc.title,
      creators: splitAuthors(doc.author),
      identifiers: {
        isbn: doc.isbn ? [doc.isbn] : [],
        external_ids: Object.fromEntries(
          [
            ["catalog_id", doc.id],
            ["ssid", doc.ssid],
            ["dxid", doc.dxid],
          ].filter((item): item is [string, string] => Boolean(item[1])),
        ),
      },
      edition: {
        publication_date: year ? `${year}-01-01` : null,
        publisher: doc.publisher?.trim() || null,
        language: null,
      },
    },
    provenance: {
      acquisition_type: "catalog_metadata",
      origin_uri: null,
      verification_status: "unverified",
    },
    content_state: {
      metadata_available: true,
      fulltext_available: false,
      ocr_available: false,
      page_map_available: false,
    },
    technical_capabilities: {
      keyword_search: true,
      semantic_search: false,
      retrieve_passage: false,
      retrieve_page: false,
      citation_page: false,
      citation_paragraph: false,
    },
    research_profile: {
      authority_class: "reference",
      source_roles: ["discovery", "bibliographic"],
      recency_class: "historical_fixed",
    },
    policy_ref: {
      active_policy_id: `policy:catalog-metadata:${sourceId}`,
      active_policy_version: 1,
    },
  };
}

function seedPolicy(source: ResearchSource): KnowledgePolicy {
  return {
    schema_version: "0.1",
    policy_id: source.policy_ref.active_policy_id,
    policy_version: source.policy_ref.active_policy_version,
    source_id: source.source_id,
    entitlement: { type: "personal_copy", valid_until: null },
    permissions: {
      read: true,
      search: true,
      ai_index: true,
      ai_input: true,
      summarize: true,
      compare: true,
      cross_source_synthesis: true,
      quote: true,
      generate_artifact: true,
      export_artifact: true,
      share_public: false,
      agent_execute: true,
      ai_train: false,
    },
    constraints: {
      execution_surfaces: ["personal-research-runtime"],
      purposes: ["personal_research"],
      citation_required: true,
    },
    derived_artifacts: {
      policy_mode: "inherit",
      public_share: false,
    },
    enforcement: {
      conflict_strategy: "prohibition_wins",
      revalidate_after_days: 30,
    },
  };
}

export function createResearchV0Service(args: {
  catalog: CatalogAdapter;
  seedSources?: ResearchSource[];
  seedEvidence?: EvidenceSeed[];
}) {
  const seedSources = new Map((args.seedSources ?? []).map((source) => [source.source_id, source]));
  const seedEvidence = args.seedEvidence ?? [];
  const policies = new Map<string, KnowledgePolicy>();
  for (const source of seedSources.values()) policies.set(source.source_id, seedPolicy(source));
  const bundles = new Map<string, EvidenceBundle>();

  async function getSource(sourceId: string): Promise<ResearchSource> {
    const seeded = seedSources.get(sourceId);
    if (seeded) return seeded;

    if (!sourceId.startsWith("catalog:")) {
      throw new ResearchV0Error("SOURCE_NOT_FOUND", `unknown source ${sourceId}`);
    }

    const catalogId = sourceId.slice("catalog:".length);
    try {
      return catalogSource(await args.catalog.getDocument(catalogId));
    } catch {
      throw new ResearchV0Error("SOURCE_NOT_FOUND", `catalog source ${catalogId} not found`);
    }
  }

  function policyFor(source: ResearchSource): KnowledgePolicy {
    return policies.get(source.source_id) ?? catalogMetadataPolicy(source.source_id);
  }

  async function searchSources(query: string, limit = 20): Promise<ResearchSource[]> {
    const normalizedLimit = Math.min(Math.max(limit, 1), 50);
    const catalogResults = await args.catalog.search(query, normalizedLimit);
    const mapped = catalogResults.map(catalogSource);

    const seedMatches = [...seedSources.values()].filter((source) => {
      const haystack = [
        source.identity.title,
        ...source.identity.creators.map((creator) => creator.name),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(query.toLowerCase());
    });

    const unique = new Map<string, ResearchSource>();
    for (const source of [...seedMatches, ...mapped]) unique.set(source.source_id, source);
    return [...unique.values()].slice(0, normalizedLimit);
  }

  async function retrieveEvidence(input: {
    source_id: string;
    query: string;
    purpose?: string;
    execution_surface?: string;
  }): Promise<ResearchEvidence[]> {
    const source = await getSource(input.source_id);
    const policy = policyFor(source);
    const decision = evaluateCapability({
      source,
      policy,
      action: "retrieve_passage",
      executionSurface: input.execution_surface ?? "personal-research-runtime",
      purpose: input.purpose ?? "personal_research",
    });

    if (!decision.allowed) {
      throw new ResearchV0Error(
        decision.code ?? "POLICY_DENIED",
        decision.reason ?? "evidence retrieval denied",
      );
    }

    const queryTerms = input.query
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);

    const matches = seedEvidence.filter((row) => {
      if (row.source_id !== input.source_id) return false;
      if (queryTerms.length === 0) return true;
      const text = row.text.toLowerCase();
      return queryTerms.some((term) => text.includes(term));
    });

    return matches.map((row, index) => ({
      evidence_id: `ev:${input.source_id}:${index + 1}:${randomUUID().slice(0, 8)}`,
      source_id: row.source_id,
      location: {
        page: row.page ?? null,
        chapter: row.chapter ?? null,
        paragraph: null,
      },
      passage_ref: row.text,
      evidence_role: row.evidence_role ?? "context",
      source_role: row.source_role ?? "secondary",
      retrieval: {
        method: "keyword",
        relevance: null,
        retrieved_at: new Date().toISOString(),
      },
      citation: {
        display: row.citation,
        stable_locator: row.stable_locator,
      },
      policy_snapshot: {
        policy_id: policy.policy_id,
        policy_version: policy.policy_version,
      },
    }));
  }

  async function buildBundle(input: {
    question: string;
    intent: ResearchIntent;
    skill_id?: string;
    candidate_source_ids?: string[];
  }): Promise<EvidenceBundle> {
    const skill = researchSkills.find((item) => item.skill_id === (input.skill_id ?? "skill:source-provenance-investigation"));
    if (!skill) throw new ResearchV0Error("SKILL_NOT_FOUND", "research skill not found");

    const evidence: ResearchEvidence[] = [];
    const gaps: EvidenceBundle["gaps"] = [];

    for (const sourceId of input.candidate_source_ids ?? []) {
      try {
        const rows = await retrieveEvidence({ source_id: sourceId, query: input.question });
        evidence.push(...rows);
        if (rows.length === 0) {
          gaps.push({
            gap_id: `G${gaps.length + 1}`,
            description: `No qualified evidence matched ${sourceId}`,
            importance: "important",
            next_source_hint: null,
          });
        }
      } catch (error) {
        if (error instanceof ResearchV0Error) {
          gaps.push({
            gap_id: `G${gaps.length + 1}`,
            description: `${sourceId}: ${error.code} — ${error.message}`,
            importance: error.code === "TECHNICAL_CAPABILITY_MISSING" ? "critical" : "important",
            next_source_hint:
              error.code === "TECHNICAL_CAPABILITY_MISSING"
                ? "add a source with retrievable full text and stable citation locators"
                : null,
          });
          continue;
        }
        throw error;
      }
    }

    if ((input.candidate_source_ids ?? []).length === 0) {
      gaps.push({
        gap_id: "G1",
        description: "No candidate sources were supplied; source discovery is still required.",
        importance: "critical",
        next_source_hint: "run /sources/search and select candidate sources",
      });
    }

    const bundle: EvidenceBundle = {
      schema_version: "0.1",
      bundle_id: `eb:${new Date().toISOString().slice(0, 10).replaceAll("-", "")}:${randomUUID().slice(0, 8)}`,
      question: input.question,
      intent: input.intent,
      skill_ref: {
        skill_id: skill.skill_id,
        skill_version: skill.version,
      },
      claims: [
        {
          claim_id: "C1",
          text: input.question,
          status: "unknown",
          confidence: "low",
          evidence_ids: evidence.map((item) => item.evidence_id),
          counterevidence_ids: [],
          unresolved_conflict_ids: [],
        },
      ],
      evidence,
      conflicts: [],
      gaps,
      audit: {
        created_at: new Date().toISOString(),
        runtime_version: "research-v0.1",
        false_closure_protection: true,
      },
    };

    bundles.set(bundle.bundle_id, bundle);
    return bundle;
  }

  function getBundle(bundleId: string): EvidenceBundle | null {
    return bundles.get(bundleId) ?? null;
  }

  return {
    getSource,
    searchSources,
    retrieveEvidence,
    buildBundle,
    getBundle,
    listSkills: () => [...researchSkills],
    getSkill: (skillId: string) => researchSkills.find((item) => item.skill_id === skillId) ?? null,
  };
}

export type ResearchV0Service = ReturnType<typeof createResearchV0Service>;
