import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  createPostgresResearchMembershipStore,
} from "./research-membership-store.js";
import {
  ResearchMembershipIntegrityError,
  ResearchMembershipStoreUnavailableError,
} from "../application/research-memberships.js";

const sourceId = "11111111-1111-4111-8111-111111111111";
const editionId = "22222222-2222-4222-8222-222222222222";
const workId = "33333333-3333-4333-8333-333333333333";
const bindingId = "44444444-4444-4444-8444-444444444444";
const projectId = "55555555-5555-4555-8555-555555555555";
const noteId = "66666666-6666-4666-8666-666666666666";
const revisionId = "77777777-7777-4777-8777-777777777777";

type Options = {
  identities?: any[];
  memberships?: any[];
  error?: Error & { code?: string };
};

function validIdentity(bookId = "book-a") {
  return {
    book_id: bookId,
    identity_target_type: "SOURCE",
    source_id: sourceId,
    edition_id: editionId,
    work_id: workId,
  };
}

function validMembership(overrides: Record<string, unknown> = {}) {
  return {
    edition_id: editionId,
    binding_id: bindingId,
    project_id: projectId,
    project_name: "北京古道研究",
    project_lifecycle_state: "ACTIVE",
    note_binding_id: noteId,
    note_id: noteId,
    note_binding_role: "ANNOTATION",
    note_binding_metadata: {
      subjectBindingId: bindingId,
      subjectType: "EDITION",
      subjectId: editionId,
    },
    note_type: "PROJECT_ITEM_NOTE",
    note_lifecycle_state: "ACTIVE",
    current_revision_id: revisionId,
    current_revision_actual_id: revisionId,
    note_updated_at: new Date("2026-09-20T08:00:00.000Z"),
    ...overrides,
  };
}

function fake(options: Options = {}) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (options.error && !/^(BEGIN|ROLLBACK)$/.test(sql)) throw options.error;
    if (sql.startsWith("BEGIN")) return { rows: [] };
    if (sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.includes("unnest($1::text[])")) return { rows: options.identities ?? [validIdentity()] };
    if (sql.includes("FROM core.project_bindings pb")) return { rows: options.memberships ?? [validMembership()] };
    throw new Error(`unexpected SQL: ${sql}`);
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ query, release })) };
  return {
    store: createPostgresResearchMembershipStore(pool as unknown as Pool),
    query,
    release,
  };
}

describe("Postgres research membership store", () => {
  it("uses one requested-id array and a fixed membership query without writes", async () => {
    const s = fake();
    const result = await s.store.lookup(["book-a", "book-b"]);
    expect(result.get("book-a")).toEqual([{
      projectId,
      projectName: "北京古道研究",
      projectLifecycleState: "ACTIVE",
      bindingId,
      hasNote: true,
      noteUpdatedAt: "2026-09-20T08:00:00.000Z",
    }]);
    expect(result.get("book-b")).toBeUndefined();

    const identityCall = s.query.mock.calls.find(([sql]) => String(sql).includes("unnest($1::text[])"))!;
    expect(identityCall[1]).toEqual([["book-a", "book-b"]]);
    expect(s.query.mock.calls.filter(([sql]) => String(sql).includes("FROM core.project_bindings pb"))).toHaveLength(1);
    expect(s.query.mock.calls.some(([sql]) => /\b(INSERT|UPDATE|DELETE)\b/i.test(String(sql)))).toBe(false);
    expect(s.query.mock.calls[0][0]).toMatch(/BEGIN.*REPEATABLE READ.*READ ONLY/i);
    expect(s.query.mock.calls.at(-1)![0]).toBe("COMMIT");
    expect(s.release).toHaveBeenCalledOnce();
  });

  it("maps one Edition membership back to every requested catalog identity for that Edition", async () => {
    const s = fake({ identities: [validIdentity("book-a"), validIdentity("book-b")] });
    const result = await s.store.lookup(["book-a", "book-b"]);
    expect(result.get("book-a")).toEqual(result.get("book-b"));
    expect(result.get("book-a")).toHaveLength(1);
  });

  it("does not hide a matching non-SOURCE catalog identity as not researched", async () => {
    const s = fake({ identities: [{ ...validIdentity(), identity_target_type: "WORK", source_id: null, edition_id: null, work_id: null }], memberships: [] });
    await expect(s.store.lookup(["book-a"])).rejects.toBeInstanceOf(ResearchMembershipIntegrityError);
    const identitySql = String(s.query.mock.calls.find(([sql]) => String(sql).includes("unnest($1::text[])"))![0]);
    expect(identitySql).not.toMatch(/ei\.target_type\s*=\s*'SOURCE'/i);
  });

  it.each([
    [{ ...validIdentity(), source_id: null }, "source"],
    [{ ...validIdentity(), edition_id: null }, "edition"],
    [{ ...validIdentity(), work_id: null }, "work"],
  ] as const)("fails closed for a broken canonical %s chain", async (identity) => {
    await expect(fake({ identities: [identity], memberships: [] }).store.lookup(["book-a"]))
      .rejects.toBeInstanceOf(ResearchMembershipIntegrityError);
  });

  it("fails closed for duplicate or malformed NOTE relationships", async () => {
    const duplicate = fake({ memberships: [
      validMembership(),
      validMembership({ note_binding_id: "88888888-8888-4888-8888-888888888888", note_id: "88888888-8888-4888-8888-888888888888" }),
    ] });
    await expect(duplicate.store.lookup(["book-a"])).rejects.toBeInstanceOf(ResearchMembershipIntegrityError);

    const malformed = fake({ memberships: [validMembership({ note_binding_role: "REFERENCE" })] });
    await expect(malformed.store.lookup(["book-a"])).rejects.toBeInstanceOf(ResearchMembershipIntegrityError);
  });

  it("returns hasNote=false only when there is no NOTE binding", async () => {
    const s = fake({ memberships: [validMembership({
      note_binding_id: null,
      note_id: null,
      note_binding_role: null,
      note_binding_metadata: null,
      note_type: null,
      note_lifecycle_state: null,
      current_revision_id: null,
      current_revision_actual_id: null,
      note_updated_at: null,
    })] });
    expect(await s.store.lookup(["book-a"])).toEqual(new Map([["book-a", [{
      projectId,
      projectName: "北京古道研究",
      projectLifecycleState: "ACTIVE",
      bindingId,
      hasNote: false,
      noteUpdatedAt: null,
    }]]]));
  });

  it.each(["ECONNREFUSED", "08006", "57P01", "53300"])("classifies unavailable storage %s", async code => {
    const error = Object.assign(new Error("private"), { code });
    await expect(fake({ error }).store.lookup(["book-a"]))
      .rejects.toBeInstanceOf(ResearchMembershipStoreUnavailableError);
  });
});
