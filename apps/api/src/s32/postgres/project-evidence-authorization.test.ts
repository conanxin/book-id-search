import { expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import {
  ProjectEvidenceTargetUnavailableError,
  authorizeEvidenceItems,
  evidenceCandidatesFromAuthorization,
  loadProjectEvidenceAuthorization,
} from "./project-evidence-authorization.js";

const P = "11111111-1111-4111-8111-111111111111";
const BINDING = "22222222-2222-4222-8222-222222222222";
const EDITION = "33333333-3333-4333-8333-333333333333";
const SOURCE = "44444444-4444-4444-8444-444444444444";
const ASSET = "55555555-5555-4555-8555-555555555555";
const NOTE_BINDING = "66666666-6666-4666-8666-666666666666";
const NOTE = "77777777-7777-4777-8777-777777777777";
const CURRENT_REVISION = "88888888-8888-4888-8888-888888888888";
const OLD_REVISION = "99999999-9999-4999-8999-999999999999";

function materialRow() {
  return {
    binding_id: BINDING,
    binding_created_at: new Date("2026-01-01T00:00:00.000Z"),
    binding_metadata: { sourceId: SOURCE },
    edition_id: EDITION,
    work_title: "北京古道志",
    source_id: SOURCE,
    source_type: "DATABASE_RECORD",
    source_lifecycle: "ACTIVE",
    source_edition_id: EDITION,
    source_observed_at: new Date("2026-01-02T00:00:00.000Z"),
    asset_id: ASSET,
    asset_type: "DOCUMENT",
    asset_role: "ORIGINAL",
    asset_storage_mode: "LOCAL",
    asset_created_at: new Date("2026-01-03T00:00:00.000Z"),
    note_binding_id: NOTE_BINDING,
    note_binding_role: "ANNOTATION",
    note_binding_metadata: {
      subjectBindingId: BINDING,
      subjectType: "EDITION",
      subjectId: EDITION,
    },
    note_id: NOTE,
    note_type: "PROJECT_ITEM_NOTE",
    note_lifecycle: "ACTIVE",
    note_current_revision_id: CURRENT_REVISION,
    revision_id: CURRENT_REVISION,
    revision_no: 2,
    revision_content_format: "MARKDOWN",
    revision_created_at: new Date("2026-01-04T00:00:00.000Z"),
  };
}

function client(oldRows: unknown[] = []) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("LEFT JOIN core.source_assets")) return { rows: [materialRow()] };
    if (sql.includes("FROM core.note_revisions nr") && sql.includes("ANY(")) {
      return { rows: oldRows };
    }
    return { rows: [] };
  });
  return { query } as unknown as PoolClient;
}

it("builds one authorization index used for candidates and target checks", async () => {
  const auth = await loadProjectEvidenceAuthorization(client(), P);
  expect(auth.sourceIds.has(SOURCE)).toBe(true);
  expect(auth.sourceAssetIds.has(ASSET)).toBe(true);
  expect(auth.noteIds.has(NOTE)).toBe(true);
  expect(auth.currentRevisionNoteByRevision.get(CURRENT_REVISION)).toBe(NOTE);
  expect(evidenceCandidatesFromAuthorization(auth).map(x => x.targetType)).toEqual([
    "SOURCE",
    "SOURCE_ASSET",
    "NOTE_REVISION",
  ]);
});

it("authorizes an older immutable revision only when it belongs to an authorized Note", async () => {
  const c = client([{
    revision_id: OLD_REVISION,
    note_id: NOTE,
    revision_no: 1,
    content_format: "MARKDOWN",
    created_at: new Date("2025-12-31T00:00:00.000Z"),
  }]);
  const auth = await loadProjectEvidenceAuthorization(c, P);
  await expect(authorizeEvidenceItems(c, auth, [{
    role: "SUPPORTING",
    targetType: "NOTE_REVISION",
    targetId: OLD_REVISION,
    note: null,
  }])).resolves.toBeUndefined();
});

it("rejects a target absent from the current Project authorization graph", async () => {
  const c = client();
  const auth = await loadProjectEvidenceAuthorization(c, P);
  await expect(authorizeEvidenceItems(c, auth, [{
    role: "SUPPORTING",
    targetType: "SOURCE",
    targetId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    note: null,
  }])).rejects.toBeInstanceOf(ProjectEvidenceTargetUnavailableError);
});
