/**
 * S32 P1-B R2: non-persistent, contract-only locator-draft prototype.
 *
 * Trust model:
 * - A draft label is NEVER a verified source page, plate or quotation.
 * - A witness must be constructed only AFTER backend project authorization
 *   and original SourceAsset retrieval. This pure module authenticates nobody.
 * - SourceAsset.sha256 is the original asset-byte digest, NOT Manifest SHA-256.
 * - Historical schemaVersion=1 manifests stay frozen with null locators.
 * - No URL, quote, asset path, DB/API write or success claim is generated here.
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const EXPECTED_FIELDS = [
  "schemaVersion", "projectId", "editionId", "sourceId",
  "sourceAssetId", "assetSha256", "kind", "label",
] as const;

// Deliberately excludes line breaks, bidi controls and markup-like syntax;
// a page label is a human-supplied name, not a URL, JS fragment or HTML anchor.
const INVALID_LABEL_CHARS = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069<>\\]/u;
const LINK_LIKE_LABEL = /https?:\/\/|javascript:|www\.|\/\//i;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
function isSafePrintedLabel(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  if ([...value].length > 32 || INVALID_LABEL_CHARS.test(value) || LINK_LIKE_LABEL.test(value)) return false;
  return value.length > 0;
}

/** Parse only the exact, independently versioned v2 proposal; no v1 backfill. */
export function parseLocatorDraftV2(input: unknown): LocatorDraftV2 | null {
  if (!plainRecord(input) || !hasExactFields(input, EXPECTED_FIELDS)) return null;
  if (input.schemaVersion !== 2 || !isUuid(input.projectId) ||
      !isUuid(input.editionId) || !isUuid(input.sourceId) ||
      !isUuid(input.sourceAssetId) || !isHash(input.assetSha256)) return null;
  if (input.kind !== "PRINTED_PAGE" && input.kind !== "PLATE") return null;
  if (!isSafePrintedLabel(input.label)) return null;
  // Make a clean projection instead of returning caller-owned objects.
  return {
    schemaVersion: 2,
    projectId: input.projectId,
    editionId: input.editionId,
    sourceId: input.sourceId,
    sourceAssetId: input.sourceAssetId,
    assetSha256: input.assetSha256,
    kind: input.kind,
    label: input.label,
  };
}

function result(
  status: LocatorReviewV2["status"], reason: LocatorReviewV2["reason"] = null,
  locator: LocatorReviewV2["locator"] = null,
): LocatorReviewV2 {
  return { status, reason, locator, verified: false, href: null, excerpt: null };
}

function normalizedUuidEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Structural compatibility ONLY. An exact authorized asset witness does not
 * prove that page 87 was actually seen by a human. Authorization, original
 * asset-byte checks and human verification require separate future Gates.
 */
export function assessLocatorDraftV2(
  proposal: unknown, authorizedWitness: LocatorWitnessV2 | null,
): LocatorReviewV2 {
  const draft = parseLocatorDraftV2(proposal);
  if (!draft) return result("INVALID", "INVALID_SHAPE");
  if (!authorizedWitness || !plainRecord(authorizedWitness) ||
      authorizedWitness.access !== "READABLE") return result("UNAVAILABLE", "NO_AUTHORIZED_WITNESS");

  if (authorizedWitness.sourceType !== "PUBLICATION" ||
      authorizedWitness.assetRole !== "ORIGINAL" ||
      !isUuid(authorizedWitness.editionId) ||
      !isHash(authorizedWitness.assetSha256)) {
    return result("UNAVAILABLE", "SOURCE_UNSUPPORTED");
  }
  if (![authorizedWitness.projectId, authorizedWitness.sourceId, authorizedWitness.sourceAssetId]
    .every(isUuid)) return result("UNAVAILABLE", "NO_AUTHORIZED_WITNESS");

  if (!normalizedUuidEqual(draft.projectId, authorizedWitness.projectId) ||
      !normalizedUuidEqual(draft.editionId, authorizedWitness.editionId) ||
      !normalizedUuidEqual(draft.sourceId, authorizedWitness.sourceId) ||
      !normalizedUuidEqual(draft.sourceAssetId, authorizedWitness.sourceAssetId)) {
    return result("IDENTITY_CONFLICT", "IDENTITY_MISMATCH");
  }
  if (draft.assetSha256 !== authorizedWitness.assetSha256) {
    return result("IDENTITY_CONFLICT", "HASH_MISMATCH");
  }
  // Deliberately no VERIFIED status, URL or source quotation even on a match.
  return result("PENDING_HUMAN_VERIFICATION", null, { kind: draft.kind, label: draft.label });
}

/**
 * Legacy v1 EvidenceManifest items must still have null locator/excerpt;
 * this helper is for read-only disclosure and never mutates old evidence.
 */
export function summarizeV1EvidenceLocation(
  items: unknown,
): "NO_EVIDENCE" | "NOT_RECORDED" | "UNSUPPORTED" {
  if (!Array.isArray(items)) return "UNSUPPORTED";
  if (items.length === 0) return "NO_EVIDENCE";
  if (items.every(item => plainRecord(item) &&
    Object.hasOwn(item, "locatorType") && Object.hasOwn(item, "locator") &&
    Object.hasOwn(item, "excerpt") && item.locatorType === null &&
    item.locator === null && item.excerpt === null)) return "NOT_RECORDED";
  return "UNSUPPORTED";
}
