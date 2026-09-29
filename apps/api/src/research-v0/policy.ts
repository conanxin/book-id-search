import type {
  CapabilityAction,
  CapabilityDecision,
  KnowledgePolicy,
  ResearchSource,
} from "./types.js";

function permissionFor(policy: KnowledgePolicy, action: CapabilityAction): boolean {
  if (action === "retrieve_passage") return policy.permissions.ai_input;
  return policy.permissions[action];
}

function technicalFor(source: ResearchSource, action: CapabilityAction): boolean {
  switch (action) {
    case "read":
      return source.content_state.metadata_available;
    case "search":
      return source.technical_capabilities.keyword_search || source.technical_capabilities.semantic_search;
    case "ai_input":
      return source.content_state.metadata_available || source.content_state.fulltext_available;
    case "retrieve_passage":
      return source.technical_capabilities.retrieve_passage;
    case "generate_artifact":
      return true;
  }
}

export function evaluateCapability(args: {
  source: ResearchSource;
  policy: KnowledgePolicy;
  action: CapabilityAction;
  executionSurface: string;
  purpose: string;
  now?: Date;
}): CapabilityDecision {
  const { source, policy, action, executionSurface, purpose } = args;
  const now = args.now ?? new Date();

  if (!technicalFor(source, action)) {
    return {
      allowed: false,
      code: "TECHNICAL_CAPABILITY_MISSING",
      reason: `source does not technically support ${action}`,
    };
  }

  if (!permissionFor(policy, action)) {
    return {
      allowed: false,
      code: "POLICY_DENIED",
      reason: `policy denies ${action}`,
    };
  }

  if (!policy.constraints.execution_surfaces.includes(executionSurface)) {
    return {
      allowed: false,
      code: "POLICY_DENIED",
      reason: `execution surface ${executionSurface} is not allowed`,
    };
  }

  if (!policy.constraints.purposes.includes(purpose)) {
    return {
      allowed: false,
      code: "POLICY_DENIED",
      reason: `purpose ${purpose} is not allowed`,
    };
  }

  if (policy.entitlement.valid_until && new Date(policy.entitlement.valid_until) < now) {
    return {
      allowed: false,
      code: "ENTITLEMENT_MISSING",
      reason: "entitlement expired",
    };
  }

  return { allowed: true };
}

export function catalogMetadataPolicy(sourceId: string): KnowledgePolicy {
  return {
    schema_version: "0.1",
    policy_id: `policy:catalog-metadata:${sourceId}`,
    policy_version: 1,
    source_id: sourceId,
    entitlement: {
      type: "catalog_metadata",
      valid_until: null,
    },
    permissions: {
      read: true,
      search: true,
      ai_index: true,
      ai_input: true,
      summarize: false,
      compare: true,
      cross_source_synthesis: true,
      quote: false,
      generate_artifact: false,
      export_artifact: false,
      share_public: true,
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
      public_share: true,
    },
    enforcement: {
      conflict_strategy: "prohibition_wins",
      revalidate_after_days: 30,
    },
  };
}
