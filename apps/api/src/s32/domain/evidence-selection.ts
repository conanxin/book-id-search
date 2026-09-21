import { createHash } from "node:crypto";

export class InvalidEvidenceDraftError extends Error {}

export type EvidenceRole = "SUPPORTING" | "CONTRADICTORY" | "CONTEXTUAL";
export type EvidenceTargetType = "SOURCE" | "SOURCE_ASSET" | "NOTE_REVISION";

export interface EvidenceDraftInputItem {
  role: EvidenceRole;
  targetType: EvidenceTargetType;
  targetId: string;
  note: string | null;
}

export interface CanonicalEvidenceDraftItem extends EvidenceDraftInputItem {
  ordinal: number;
  locatorType: null;
  locator: null;
  excerpt: null;
}

export interface EvidenceManifestDraft {
  schemaVersion: 1;
  purpose: "CLAIM_ASSESSMENT";
  manifestSha256: string;
  items: CanonicalEvidenceDraftItem[];
}

const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const roles: ReadonlySet<string> = new Set(["SUPPORTING", "CONTRADICTORY", "CONTEXTUAL"]);
const targetTypes: ReadonlySet<string> = new Set(["SOURCE", "SOURCE_ASSET", "NOTE_REVISION"]);

export function readEvidenceRole(value: unknown): EvidenceRole {
  if (typeof value !== "string" || !roles.has(value)) throw new InvalidEvidenceDraftError("证据角色不正确。");
  return value as EvidenceRole;
}

export function readEvidenceTargetType(value: unknown): EvidenceTargetType {
  if (typeof value !== "string" || !targetTypes.has(value)) throw new InvalidEvidenceDraftError("证据对象类型不正确。");
  return value as EvidenceTargetType;
}

export function normalizeEvidenceItemNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new InvalidEvidenceDraftError("证据说明必须是文本。");
  if (value.includes("\u0000")) throw new InvalidEvidenceDraftError("证据说明包含不支持的字符。");
  const trimmed = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^[\p{White_Space}]+|[\p{White_Space}]+$/gu, "");
  if (!trimmed) return null;
  if (Array.from(trimmed).length > 2000) throw new InvalidEvidenceDraftError("证据说明最多 2000 个字符。");
  return trimmed;
}

function readTargetId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new InvalidEvidenceDraftError("证据对象 ID 格式不正确。");
  return value.toLowerCase();
}

export function normalizeEvidencePreviewInput(value: unknown): EvidenceDraftInputItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidEvidenceDraftError("证据草稿请求格式不正确。");
  const allowed = new Set(["items"]);
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (!allowed.has(key)) throw new InvalidEvidenceDraftError("证据草稿包含不支持的字段。");
  }
  const items = (value as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length === 0) throw new InvalidEvidenceDraftError("证据草稿不能为空。");
  const itemKeys = new Set(["role", "targetType", "targetId", "note"]);
  const seen = new Set<string>();
  const normalized: EvidenceDraftInputItem[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new InvalidEvidenceDraftError("证据草稿条目格式不正确。");
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (!itemKeys.has(key)) throw new InvalidEvidenceDraftError("证据草稿条目包含不支持的字段。");
    }
    const record = raw as Record<string, unknown>;
    const item: EvidenceDraftInputItem = {
      role: readEvidenceRole(record.role),
      targetType: readEvidenceTargetType(record.targetType),
      targetId: readTargetId(record.targetId),
      note: normalizeEvidenceItemNote(record.note),
    };
    const pair = `${item.targetType}:${item.targetId}`;
    if (seen.has(pair)) throw new InvalidEvidenceDraftError("同一证据对象不能在草稿中出现两次。");
    seen.add(pair);
    normalized.push(item);
  }
  return normalized;
}

export function canonicalEvidencePayload(items: EvidenceDraftInputItem[]): {
  schemaVersion: 1;
  purpose: "CLAIM_ASSESSMENT";
  items: CanonicalEvidenceDraftItem[];
} {
  return {
    schemaVersion: 1,
    purpose: "CLAIM_ASSESSMENT",
    items: items.map((item, index) => ({
      ordinal: index + 1,
      role: item.role,
      targetType: item.targetType,
      targetId: item.targetId,
      locatorType: null,
      locator: null,
      excerpt: null,
      note: item.note,
    })),
  };
}

export function serializeCanonicalEvidencePayload(payload: ReturnType<typeof canonicalEvidencePayload>): string {
  return JSON.stringify(payload);
}

export function buildEvidenceManifestDraft(items: EvidenceDraftInputItem[]): EvidenceManifestDraft {
  const payload = canonicalEvidencePayload(items);
  return {
    schemaVersion: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifestSha256: createHash("sha256").update(serializeCanonicalEvidencePayload(payload), "utf8").digest("hex"),
    items: payload.items,
  };
}
