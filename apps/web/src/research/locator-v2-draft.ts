/**
 * S32 P1-B R2: local, non-persistent locator draft contract prototype.
 *
 * IMPORTANT:
 * - A locator label is a researcher's proposal, NEVER an authenticated citation.
 * - Source/asset authorization MUST be performed by a server before constructing
 *   the witness. Passing forged witness data into this pure helper grants nothing.
 * - No storage, API, migration, URL or v1 EvidenceManifest changes are made here.
 */

export type LocatorKindV2 = "PRINTED_PAGE" | "PLATE";
export type LocatorDraftV2 = {
  schemaVersion: 2;
  projectId: string;
  editionId: string;
  sourceId: string;
  sourceAssetId: string;
  assetSha256: string;
  kind: LocatorKindV2;
  label: string;
};

export type LocatorWitnessV2 = {
  projectId: string;
  editionId: string | null;
  sourceId: string;
  sourceAssetId: string;
  assetSha256: string | null;
  sourceType: "PUBLICATION" | "OTHER";
  assetRole: "ORIGINAL" | "DERIVED";
  access: "READABLE" | "DENIED" | "REVOKED" | "UNKNOWN";
};

export type LocatorReviewV2 = {
  status: "INVALID" | "UNAVAILABLE" | "IDENTITY_CONFLICT" | "PENDING_HUMAN_VERIFICATION";
  reason: "INVALID_SHAPE" | "NO_AUTHORIZED_WITNESS" | "SOURCE_UNSUPPORTED" | "IDENTITY_MISMATCH" | "HASH_MISMATCH" | null;
  locator: { kind: LocatorKindV2; label: string } | null;
  verified: false;
  href: null;
  excerpt: null;
};

/** Strict parsing MUST reject all unknown keys, especially fabricated citations. */
export function parseLocatorDraftV2(_input: unknown): LocatorDraftV2 | null {
  return null; // Test-first RED scaffold, to be implemented after verification.
}

/** A matching original-asset witness still never confers human page verification. */
export function assessLocatorDraftV2(_draft: unknown, _authorizedWitness: LocatorWitnessV2 | null): LocatorReviewV2 {
  return { status: "INVALID", reason: "INVALID_SHAPE", locator: null, verified: false, href: null, excerpt: null };
}

/** v1 evidence locator/excerpt fields remain null; never backfill old manifests. */
export function summarizeV1EvidenceLocation(_items: unknown): "NO_EVIDENCE" | "NOT_RECORDED" | "UNSUPPORTED" {
  return "UNSUPPORTED";
}
