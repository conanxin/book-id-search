import { existsSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  IssueResolutionIntegrityError,
  IssueResolutionStoreUnavailableError,
  IssueResolutionScopeNotFoundError,
  type IssueResolutionReadStore,
} from "../application/issue-resolutions.js";
import { decodeIssueResolutionCursor } from "../domain/issue-resolution.js";
import { buildEvidenceManifestDraft } from "../domain/evidence-selection.js";
const modulePath = "./issue-resolution-read-store.js";
const implementation = existsSync(
  new URL("./issue-resolution-read-store.ts", import.meta.url),
)
  ? await import(modulePath)
  : {};
function store(pool: Pool): IssueResolutionReadStore {
  expect(
    implementation.createPostgresIssueResolutionReadStore,
    "missing read-store contract",
  ).toBeTypeOf("function");
  return implementation.createPostgresIssueResolutionReadStore(pool);
}
const id = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-aaaa-4aaa-8aaa-${n.toString(16).padStart(12, "0")}`;
const P = id(1),
  I = id(2),
  C = id(3),
  R = id(4),
  OTHER = id(5),
  S = id(6),
  N = id(7),
  REV = id(8),
  ASSET = id(9);
const D = new Date("2026-09-28T00:00:00Z");
type Row = Record<string, any>;
function scope(): Row {
  return {
    project_id: P,
    project_name: "Project",
    project_state: "ACTIVE",
    project_created_at: D,
    project_updated_at: D,
    issue_id: I,
    issue_title: "Question",
    issue_question: "Why?",
    issue_state: "OPEN",
    issue_created_at: D,
    issue_updated_at: D,
    current_resolution_id: null,
    issue_binding_id: id(10),
    owner_project_id: P,
    issue_binding_role: null,
    issue_binding_metadata: {},
    issue_binding_created_at: D,
  };
}
function resolution(n = 4, extra: Row = {}): Row {
  return {
    id: id(n),
    issue_id: I,
    resolution_type: "INSUFFICIENT_EVIDENCE",
    preferred_claim_id: null,
    rationale: null,
    evidence_manifest_id: null,
    created_at: D,
    created_at_micros: (9007199254741999n - BigInt(n)).toString(),
    ...extra,
  };
}
function claim(n = 3, extra: Row = {}): Row {
  return {
    claim_id: id(n),
    relation_issue_id: I,
    relation_claim_id: id(n),
    claim_statement: "候选答案",
    claim_state: "ACTIVE",
    claim_type: null,
    subject_type: null,
    subject_id: null,
    claim_metadata: {},
    claim_created_at: D,
    claim_updated_at: D,
    ...extra,
  };
}
function basis(n = 20, extra: Row = {}): Row {
  const manifest = id(n + 1000);
  return {
    requested_id: manifest,
    manifest_id: manifest,
    evidence_manifest_id: manifest,
    assessment_id: id(n),
    claim_id: C,
    actor_id: null,
    stance: "SUPPORTS",
    confidence_level: null,
    numeric_score: null,
    score_kind: null,
    reasoning: null,
    assessment_metadata: {},
    assessment_created_at: D,
    assessment_created_at_micros: (9007199254741999n - BigInt(n)).toString(),
    schema_version: 1,
    purpose: "CLAIM_ASSESSMENT",
    manifest_metadata: {},
    manifest_created_at: D,
    manifest_sha256: buildEvidenceManifestDraft([
      { role: "SUPPORTING", targetType: "SOURCE", targetId: S, note: null },
    ]).manifestSha256,
    ...extra,
  };
}
function item(b: Row, extra: Row = {}): Row {
  return {
    item_id: id(
      3000 + Number.parseInt((b.assessment_id ?? id(20)).slice(0, 8), 16),
    ),
    manifest_id: b.manifest_id,
    ordinal: 1,
    role: "SUPPORTING",
    target_type: "SOURCE",
    target_id: S,
    locator_type: null,
    locator: null,
    excerpt: null,
    note: null,
    created_at: D,
    ...extra,
  };
}
function material(): Row {
  return {
    binding_id: id(100),
    binding_created_at: D,
    binding_metadata: { sourceId: S },
    edition_id: id(101),
    work_title: "Book",
    source_id: S,
    source_type: "DATABASE_RECORD",
    source_lifecycle: "ACTIVE",
    source_edition_id: id(101),
    source_observed_at: D,
    asset_id: ASSET,
    asset_type: "DOCUMENT",
    asset_role: "ORIGINAL",
    asset_storage_mode: "LOCAL",
    asset_created_at: D,
    note_binding_id: id(102),
    note_binding_role: "ANNOTATION",
    note_binding_metadata: {
      subjectBindingId: id(100),
      subjectType: "EDITION",
      subjectId: id(101),
    },
    note_id: N,
    note_type: "PROJECT_ITEM_NOTE",
    note_lifecycle: "ACTIVE",
    note_current_revision_id: REV,
    revision_id: REV,
    revision_no: 2,
    revision_content_format: "MARKDOWN",
    revision_created_at: D,
  };
}
type Options = {
  scope?: Row | null;
  resolutions?: Row[];
  current?: Row[];
  bases?: Row[];
  candidates?: Row[];
  claims?: Row[];
  items?: Row[];
  materials?: Row[];
  revisions?: Row[];
  actors?: Row[];
  fail?: string;
  error?: Error;
  connectError?: Error;
};
function database(o: Options = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const bases = o.bases ?? [];
  const items = o.items ?? bases.map((b) => item(b));
  const query = vi.fn(async (text: string, params: any[] = []) => {
    const sql = text.replace(/\s+/g, " ").trim();
    calls.push({ sql, params });
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
    if (o.fail && sql.includes(o.fail)) throw o.error;
    if (
      [
        "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY",
        "COMMIT",
        "ROLLBACK",
      ].includes(sql)
    )
      return { rows: [] };
    if (sql.includes("FROM core.projects p")) {
      expect(params).toEqual([P, I]);
      return { rows: o.scope === null ? [] : [{ ...scope(), ...o.scope }] };
    }
    if (sql.includes("resolution-current")) {
      expect(params).toEqual([o.scope?.current_resolution_id?.toLowerCase()]);
      return { rows: o.current ?? [] };
    }
    if (sql.includes("resolution-history")) {
      expect(sql).toContain("ORDER BY r.created_at DESC, r.id DESC");
      expect(sql).toContain("extract(epoch FROM r.created_at) * 1000000");
      expect(sql).toContain("($2::bigint, $3::uuid)");
      expect(sql).toContain("LIMIT $4");
      expect(params[0]).toBe(I);
      return {
        rows: (o.resolutions ?? [])
          .filter(
            (r) =>
              params[1] === null ||
              BigInt(r.created_at_micros) < BigInt(params[1]) ||
              (r.created_at_micros === params[1] && r.id < params[2]),
          )
          .slice(0, params[3]),
      };
    }
    if (sql.includes("resolution-detail")) {
      expect(params).toEqual([I, R]);
      return { rows: o.resolutions ?? [] };
    }
    if (sql.includes("resolution-evidence-candidates")) {
      expect(sql).toContain("FROM core.research_issue_claims ric");
      expect(sql).toContain("JOIN core.claims c");
      expect(sql).toContain("JOIN core.assessments a");
      expect(sql).toContain("ric.issue_id = $1");
      expect(sql).toContain("NOT EXISTS");
      expect(sql).toContain("target_id = ANY($2::uuid[])");
      expect(sql).toContain("nr.note_id = ANY($4::uuid[])");
      expect(sql).toContain("($5::bigint, $6::uuid)");
      expect(sql).toContain("ORDER BY a.created_at DESC, a.id DESC");
      expect(sql).toContain("LIMIT $7");
      expect(sql.indexOf("NOT EXISTS")).toBeLessThan(sql.indexOf("$5::bigint"));
      const candidates = (o.candidates ?? bases).filter((b) =>
        items
          .filter((x) => x.manifest_id === b.manifest_id)
          .every((x) =>
            x.target_type === "SOURCE"
              ? params[1].includes(x.target_id)
              : x.target_type === "SOURCE_ASSET"
                ? params[2].includes(x.target_id)
                : (o.revisions ?? [{ revision_id: REV, note_id: N }]).some(
                    (r) =>
                      r.revision_id === x.target_id &&
                      params[3].includes(r.note_id),
                  ),
          ),
      );
      const selected = candidates
        .filter(
          (b) =>
            params[4] === null ||
            BigInt(b.assessment_created_at_micros) < BigInt(params[4]) ||
            (b.assessment_created_at_micros === params[4] &&
              b.assessment_id < params[5]),
        )
        .slice(0, params[6]);
      return { rows: selected };
    }
    if (sql.includes("resolution-manifest-batch"))
      return {
        rows: bases.filter((b) =>
          params[0].includes(b.requested_id.toLowerCase()),
        ),
      };
    if (sql.includes("resolution-claim-batch")) {
      expect(params[0]).toBe(I);
      return {
        rows: (o.claims ?? [claim()]).filter((c) =>
          params[1].includes(c.relation_claim_id?.toLowerCase()),
        ),
      };
    }
    if (
      sql.includes("FROM core.evidence_manifest_items") &&
      sql.includes("ANY($1::uuid[])")
    )
      return {
        rows: items.filter((x) =>
          params[0].includes(x.manifest_id.toLowerCase()),
        ),
      };
    if (sql.includes("LEFT JOIN core.source_assets")) {
      expect(params).toEqual([P]);
      return { rows: o.materials ?? [material()] };
    }
    if (sql.includes("FROM core.note_revisions"))
      return {
        rows: o.revisions ?? [
          {
            revision_id: REV,
            note_id: N,
            revision_no: 2,
            content_format: "MARKDOWN",
            created_at: D,
          },
        ],
      };
    if (sql.includes("FROM core.actors")) return { rows: o.actors ?? [] };
    throw new Error("Unexpected SQL: " + sql);
  });
  const release = vi.fn();
  const pool = {
    connect: vi.fn(async () => {
      if (o.connectError) throw o.connectError;
      return { query, release } as unknown as PoolClient;
    }),
  } as unknown as Pool;
  return { pool, calls, release };
}
const listInput = { projectId: P, issueId: I, limit: 20, cursor: null };
async function run(d: ReturnType<typeof database>, op = "list") {
  const s = store(d.pool);
  return op === "get"
    ? s.get({ projectId: P, issueId: I, resolutionId: R })
    : op === "bases"
      ? s.listEvidenceBases(listInput)
      : s.list(listInput);
}
it.each(["list", "get", "bases"])(
  "%s uses read-only transaction and missing-scope discriminant",
  async (op) => {
    const d = database({ scope: null });
    expect(await run(d, op)).toEqual({ kind: "scope-missing" });
    expect(d.calls.map((c) => c.sql).at(0)).toBe(
      "BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    expect(d.calls.at(-1)?.sql).toBe("COMMIT");
    expect(d.release).toHaveBeenCalledOnce();
  },
);
it.each(["list", "get", "bases"])(
  "%s hides a well-formed foreign Issue as missing scope",
  async (op) => {
    const d = database({ scope: { owner_project_id: OTHER } });
    await expect(run(d, op)).resolves.toEqual({ kind: "scope-missing" });
    expect(d.calls.at(-1)?.sql).toBe("COMMIT");
    expect(d.calls.some(c => c.sql.includes("/* resolution-"))).toBe(false);
    expect(d.release).toHaveBeenCalledOnce();
  },
);
it.each(["list", "get", "bases"])(
  "%s fails closed on corrupt owner and rolls back",
  async (op) => {
    const d = database({ scope: { owner_project_id: "bad" } });
    await expect(run(d, op)).rejects.toBeInstanceOf(
      IssueResolutionIntegrityError,
    );
    expect(d.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(d.release).toHaveBeenCalledOnce();
  },
);
it("returns pointer-selected current outside page, not newer history[0]", async () => {
  const d = database({
    scope: { current_resolution_id: R },
    current: [resolution()],
    resolutions: [resolution(5)],
  });
  const r = await store(d.pool).list(listInput);
  expect(r).toMatchObject({
    kind: "ok",
    value: {
      issue: {
        id: I,
        lifecycleState: "OPEN",
        currentResolutionId: R,
        updatedAt: D.toISOString(),
      },
      currentResolution: { id: R, isCurrent: true },
      resolutions: [{ id: OTHER, isCurrent: false }],
    },
  });
  expect(
    d.calls.findIndex((c) => c.sql.includes("resolution-current")),
  ).toBeLessThan(
    d.calls.findIndex((c) => c.sql.includes("resolution-history")),
  );
});
it.each([[], [resolution()]].map((rows) => [rows] as const))(
  "null pointer never infers current, with history %j",
  async (rows) => {
    expect(
      await store(database({ resolutions: rows }).pool).list(listInput),
    ).toMatchObject({
      kind: "ok",
      value: {
        currentResolution: null,
        resolutions: rows.map((r) => ({ id: r.id, isCurrent: false })),
      },
    });
  },
);
it.each(
  [
    [],
    [resolution(5)],
    [resolution(4, { issue_id: OTHER })],
    [resolution(4, { created_at: "bad" })],
  ].map((rows) => [rows] as const),
)("rejects dangling/cross-Issue/noncanonical current %j", async (current) => {
  await expect(
    store(database({ scope: { current_resolution_id: R }, current }).pool).list(
      listInput,
    ),
  ).rejects.toBeInstanceOf(IssueResolutionIntegrityError);
});
it.each([
  { id: "bad" },
  { issue_id: OTHER },
  { resolution_type: "BAD" },
  { resolution_type: "PREFERRED_CLAIM" },
  { preferred_claim_id: C },
  { rationale: 3 },
  { evidence_manifest_id: "bad" },
  { created_at: new Date(NaN) },
  { created_at_micros: 9007199254740992 },
])("rejects corrupt Resolution row %j", async (change) => {
  await expect(
    store(database({ resolutions: [resolution(4, change)] }).pool).list(
      listInput,
    ),
  ).rejects.toBeInstanceOf(IssueResolutionIntegrityError);
});
it("reads NULL rationale and hides absent evidence without querying manifests", async () => {
  const d = database({ resolutions: [resolution()] });
  expect(
    await store(d.pool).get({ projectId: P, issueId: I, resolutionId: R }),
  ).toMatchObject({
    kind: "ok",
    value: {
      resolution: { rationale: null },
      evidenceBasisAvailable: false,
      evidenceManifest: null,
    },
  });
  expect(d.calls.some((c) => c.sql.includes("resolution-manifest-batch"))).toBe(
    false,
  );
});
it("canonicalizes UUID output and truncates excerpt by Unicode code points", async () => {
  const r = await store(
    database({
      resolutions: [
        resolution(4, {
          id: R.toUpperCase(),
          issue_id: I.toUpperCase(),
          rationale: "\n " + "😀".repeat(241) + "\t",
        }),
      ],
    }).pool,
  ).list(listInput);
  expect(r).toMatchObject({
    kind: "ok",
    value: {
      resolutions: [
        { id: R, issueId: I, rationaleExcerpt: "😀".repeat(240) + "…" },
      ],
    },
  });
});
it.each(
  [
    [],
    [claim(3, { claim_id: null })],
    [claim(3, { relation_issue_id: OTHER })],
    [claim(3, { claim_statement: "  noncanonical " })],
  ].map((rows) => [rows] as const),
)("preferred Claim membership/row integrity %j", async (claims) => {
  await expect(
    store(
      database({
        resolutions: [
          resolution(4, {
            resolution_type: "PREFERRED_CLAIM",
            preferred_claim_id: C,
          }),
        ],
        claims,
      }).pool,
    ).list(listInput),
  ).rejects.toBeInstanceOf(IssueResolutionIntegrityError);
});
it("allows canonical archived preferred Claim", async () => {
  expect(
    await store(
      database({
        resolutions: [
          resolution(4, {
            resolution_type: "PREFERRED_CLAIM",
            preferred_claim_id: C,
          }),
        ],
        claims: [claim(3, { claim_state: "ARCHIVED" })],
      }).pool,
    ).list(listInput),
  ).toMatchObject({
    kind: "ok",
    value: { resolutions: [{ preferredClaimId: C }] },
  });
});
it("history keyset preserves microseconds beyond Number safety and same-time ID tie", async () => {
  const rows = [
    resolution(6),
    resolution(5, { created_at_micros: "9007199254740993" }),
    resolution(4, { created_at_micros: "9007199254740993" }),
  ];
  const d = database({ resolutions: rows });
  const r = await store(d.pool).list({ ...listInput, limit: 2 });
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  const cursor = decodeIssueResolutionCursor(r.value.nextCursor!);
  expect(cursor).toEqual({ createdAtMicros: "9007199254740993", id: OTHER });
  const next = await store(d.pool).list({ ...listInput, limit: 2, cursor });
  expect(next).toMatchObject({
    kind: "ok",
    value: { resolutions: [{ id: R }], nextCursor: null },
  });
  expect(
    d.calls.filter((c) => c.sql.includes("resolution-history")).at(-1)?.params,
  ).toEqual([I, "9007199254740993", OTHER, 3]);
});
it.each(
  [[], [resolution(4, { issue_id: OTHER, rationale: 17 })]].map(
    (rows) => [rows] as const,
  ),
)("detail absent/cross-Issue is private not-found %j", async (rows) => {
  expect(await run(database({ resolutions: rows }), "get")).toEqual({
    kind: "not-found",
  });
});
it("visible evidence exposes canonical detail and summary only", async () => {
  const b = basis();
  const d = database({
    bases: [b],
    resolutions: [resolution(4, { evidence_manifest_id: b.manifest_id })],
  });
  const r = await run(d, "get");
  expect(r).toMatchObject({
    kind: "ok",
    value: {
      evidenceBasisAvailable: true,
      evidenceManifest: {
        id: b.manifest_id,
        schemaVersion: 1,
        purpose: "CLAIM_ASSESSMENT",
        manifestSha256: b.manifest_sha256,
        items: [{ targetId: S, ordinal: 1 }],
      },
    },
  });
  expect(JSON.stringify(r)).not.toContain("evidenceManifestId");
  expect(JSON.stringify(r)).not.toContain("assessment_metadata");
});
it.each(["SOURCE", "SOURCE_ASSET", "NOTE_REVISION"])(
  "unauthorized %s hides evidence but keeps Resolution",
  async (type) => {
    const b = basis();
    const it = item(b, { target_type: type, target_id: OTHER });
    b.manifest_sha256 = buildEvidenceManifestDraft([
      {
        role: "SUPPORTING",
        targetType: type as any,
        targetId: OTHER,
        note: null,
      },
    ]).manifestSha256;
    const d = database({
      bases: [b],
      items: [it],
      revisions: [],
      resolutions: [resolution(4, { evidence_manifest_id: b.manifest_id })],
    });
    expect(await run(d, "get")).toMatchObject({
      kind: "ok",
      value: {
        resolution: { id: R },
        evidenceBasisAvailable: false,
        evidenceManifest: null,
      },
    });
    expect(JSON.stringify(await run(d))).not.toContain(b.manifest_id);
  },
);
it.each([
  { schema_version: 2 },
  { purpose: "BAD" },
  { manifest_sha256: "0".repeat(64) },
  { manifest_metadata: { bad: 1 } },
  { manifest_id: null },
  { assessment_id: null },
  { stance: "BAD" },
  { actor_id: OTHER },
  { assessment_created_at: "bad" },
  { numeric_score: "bad" },
])("corrupt evidence fails closed even if unauthorized %j", async (change) => {
  const b = basis(20, change);
  await expect(
    run(
      database({
        bases: [b],
        materials: [],
        resolutions: [resolution(4, { evidence_manifest_id: b.requested_id })],
      }),
      "get",
    ),
  ).rejects.toBeInstanceOf(IssueResolutionIntegrityError);
});
it.each(
  [
    [],
    [
      basis(),
      basis(21, {
        requested_id: basis().manifest_id,
        manifest_id: basis().manifest_id,
      }),
    ],
  ].map((rows) => [rows] as const),
)("rejects missing/ambiguous Assessment mapping %j", async (bases) => {
  await expect(
    run(
      database({
        bases,
        resolutions: [
          resolution(4, { evidence_manifest_id: basis().manifest_id }),
        ],
      }),
      "get",
    ),
  ).rejects.toBeInstanceOf(IssueResolutionIntegrityError);
});
it.each([
  { ordinal: 2 },
  { target_type: "BAD" },
  { target_id: "bad" },
  { note: " bad " },
  { locator: {} },
  { created_at: "bad" },
])("rejects malformed manifest items %j", async (change) => {
  const b = basis();
  await expect(
    run(
      database({
        bases: [b],
        items: [item(b, change)],
        resolutions: [resolution(4, { evidence_manifest_id: b.manifest_id })],
      }),
    ),
  ).rejects.toBeInstanceOf(IssueResolutionIntegrityError);
});
it("rejects evidence Assessment outside candidate membership", async () => {
  const b = basis();
  await expect(
    run(
      database({
        bases: [b],
        claims: [],
        resolutions: [resolution(4, { evidence_manifest_id: b.manifest_id })],
      }),
    ),
  ).rejects.toBeInstanceOf(IssueResolutionIntegrityError);
});
it("historical authorized Note revision stays available", async () => {
  const b = basis();
  b.manifest_sha256 = buildEvidenceManifestDraft([
    {
      role: "SUPPORTING",
      targetType: "NOTE_REVISION",
      targetId: OTHER,
      note: null,
    },
  ]).manifestSha256;
  const d = database({
    bases: [b],
    items: [item(b, { target_type: "NOTE_REVISION", target_id: OTHER })],
    revisions: [
      {
        revision_id: OTHER,
        note_id: N,
        revision_no: 1,
        content_format: "MARKDOWN",
        created_at: D,
      },
    ],
    resolutions: [resolution(4, { evidence_manifest_id: b.manifest_id })],
  });
  expect(await run(d, "get")).toMatchObject({
    kind: "ok",
    value: { evidenceBasisAvailable: true },
  });
});
it("history evidence and preferred-Claim queries stay bounded for1 vs20 distinct rows", async () => {
  const counts = [];
  for (const n of [1, 20]) {
    const bases = Array.from({ length: n }, (_, i) =>
      basis(20 + i, { claim_id: id(100 + i) }),
    );
    const d = database({
      bases,
      claims: bases.map((_, i) => claim(100 + i)),
      resolutions: bases.map((b, i) =>
        resolution(200 + i, {
          resolution_type: "PREFERRED_CLAIM",
          preferred_claim_id: b.claim_id,
          evidence_manifest_id: b.manifest_id,
        }),
      ),
    });
    const r = await run(d);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && "resolutions" in r.value)
      expect(r.value.resolutions).toHaveLength(n);
    counts.push(d.calls.length);
  }
  expect(counts[1]).toBe(counts[0]);
  expect(counts[1]).toBeLessThanOrEqual(11);
});
it("evidence-bases filters authorization before LIMIT and emits compact microsecond page", async () => {
  const bases = [basis(20), basis(21), basis(22)];
  const items = bases.map((b) => item(b));
  items[0].target_id = OTHER;
  const d = database({ bases, items });
  const r = await store(d.pool).listEvidenceBases({ ...listInput, limit: 1 });
  expect(r.kind).toBe("ok");
  if (r.kind !== "ok") return;
  expect(r.value.issueId).toBe(I);
  expect(r.value.evidenceBases).toEqual([
    {
      assessmentId: id(21),
      claimId: C,
      claimStatementExcerpt: "候选答案",
      stance: "SUPPORTS",
      confidenceLevel: null,
      manifestId: id(1021),
      manifestSha256: bases[1].manifest_sha256,
      itemCount: 1,
      assessmentCreatedAt: D.toISOString(),
    },
  ]);
  const cursor = decodeIssueResolutionCursor(r.value.nextCursor!);
  expect(cursor).toEqual({
    id: id(21),
    createdAtMicros: bases[1].assessment_created_at_micros,
  });
  const next = await store(d.pool).listEvidenceBases({
    ...listInput,
    limit: 1,
    cursor,
  });
  expect(next).toMatchObject({
    kind: "ok",
    value: { evidenceBases: [{ assessmentId: id(22) }], nextCursor: null },
  });
  expect(JSON.stringify(r)).not.toContain(OTHER);
});
it("evidence-basis queries remain bounded across20 candidate Claims", async () => {
  const counts = [];
  for (const n of [1, 20]) {
    const bases = Array.from({ length: n }, (_, i) =>
      basis(20 + i, { claim_id: id(100 + i) }),
    );
    const d = database({ bases, claims: bases.map((_, i) => claim(100 + i)) });
    const r = await store(d.pool).listEvidenceBases(listInput);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.value.evidenceBases).toHaveLength(n);
    counts.push(d.calls.length);
  }
  expect(counts[1]).toBe(counts[0]);
  expect(counts[1]).toBeLessThanOrEqual(11);
});
it.each([
  "08006",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
  "53300",
])("classifies connection %s", async (code) => {
  const d = database({
    connectError: Object.assign(new Error("offline"), { code }),
  });
  await expect(run(d)).rejects.toEqual(
    new IssueResolutionStoreUnavailableError(
      "ISSUE_RESOLUTION_STORE_UNAVAILABLE",
    ),
  );
  expect(d.release).not.toHaveBeenCalled();
});
it.each([
  "FROM core.projects p",
  "resolution-history",
  "resolution-manifest-batch",
  "resolution-claim-batch",
  "FROM core.evidence_manifest_items",
  "LEFT JOIN core.source_assets",
  "COMMIT",
])("rolls back/releases query failure at %s", async (fail) => {
  const b = basis();
  const error = new IssueResolutionIntegrityError(
    "connection timeout integrity",
  );
  const d = database({
    bases: [b],
    resolutions: [resolution(4, { evidence_manifest_id: b.manifest_id })],
    fail,
    error,
  });
  await expect(run(d)).rejects.toBe(error);
  expect(d.calls.at(-1)?.sql).toBe("ROLLBACK");
  expect(d.release).toHaveBeenCalledOnce();
});
it("preserves semantic errors and classifies query connection loss", async () => {
  for (const error of [
    new IssueResolutionScopeNotFoundError("connection timeout semantic"),
    Object.assign(new Error("offline"), { code: "57P01" }),
  ]) {
    const d = database({ fail: "resolution-history", error });
    await expect(run(d)).rejects.toBeInstanceOf(
      error instanceof IssueResolutionScopeNotFoundError
        ? IssueResolutionScopeNotFoundError
        : IssueResolutionStoreUnavailableError,
    );
    expect(d.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(d.release).toHaveBeenCalledOnce();
  }
});
it("batches current evidence independently even when absent from history page", async () => {
  const a = basis(20),
    b = basis(21);
  const d = database({
    scope: { current_resolution_id: R },
    current: [resolution(4, { evidence_manifest_id: a.manifest_id })],
    resolutions: [resolution(5, { evidence_manifest_id: b.manifest_id })],
    bases: [a, b],
  });
  const r = await run(d);
  expect(r).toMatchObject({
    kind: "ok",
    value: {
      currentResolution: {
        id: R,
        evidenceBasisAvailable: true,
        evidenceManifest: { id: a.manifest_id },
      },
      resolutions: [{ id: OTHER, evidenceManifest: { id: b.manifest_id } }],
    },
  });
  expect(
    d.calls.filter((c) => c.sql.includes("resolution-manifest-batch")),
  ).toHaveLength(1);
  expect(
    new Set(
      d.calls.find((c) =>
        c.sql.includes("resolution-manifest-batch"),
      )!.params[0],
    ),
  ).toEqual(new Set([a.manifest_id, b.manifest_id]));
});
it.each(["SOURCE_ASSET", "NOTE_REVISION"])(
  "authorized %s is available",
  async (type) => {
    const target = type === "SOURCE_ASSET" ? ASSET : REV,
      b = basis();
    b.manifest_sha256 = buildEvidenceManifestDraft([
      {
        role: "SUPPORTING",
        targetType: type as any,
        targetId: target,
        note: null,
      },
    ]).manifestSha256;
    const d = database({
      bases: [b],
      items: [item(b, { target_type: type, target_id: target })],
      resolutions: [resolution(4, { evidence_manifest_id: b.manifest_id })],
    });
    expect(await run(d, "get")).toMatchObject({
      kind: "ok",
      value: {
        evidenceBasisAvailable: true,
        evidenceManifest: { items: [{ targetId: target }] },
      },
    });
  },
);
it("reads historical numeric-string score and Actor without exposing attribution in evidence bases", async () => {
  const b = basis(20, {
    actor_id: OTHER,
    numeric_score: "0.75",
    score_kind: "CONFIDENCE",
    reasoning: null,
  });
  const d = database({
    bases: [b],
    actors: [
      {
        id: OTHER,
        actor_type: "HUMAN",
        display_name: "Researcher",
        metadata: { private: true },
        created_at: D,
        updated_at: D,
      },
    ],
  });
  const r = await run(d, "bases");
  expect(r).toMatchObject({
    kind: "ok",
    value: { evidenceBases: [{ assessmentId: b.assessment_id }] },
  });
  expect(JSON.stringify(r)).not.toContain("Researcher");
  expect(JSON.stringify(r)).not.toContain("numericScore");
});
it.each([
  { claim_state: "BROKEN" },
  { claim_metadata: null },
  { claim_created_at: "bad" },
  { claim_type: 4 },
  { subject_type: "BAD", subject_id: OTHER },
  { subject_type: null, subject_id: OTHER },
])("preferred Claim canonical shape fails closed %j", async (change) => {
  await expect(
    run(
      database({
        claims: [claim(3, change)],
        resolutions: [
          resolution(4, {
            resolution_type: "PREFERRED_CLAIM",
            preferred_claim_id: C,
          }),
        ],
      }),
    ),
  ).rejects.toBeInstanceOf(IssueResolutionIntegrityError);
});
it("evidence-basis cursor tie uses assessment ID with no Number coercion", async () => {
  const bases = [
    basis(22, { assessment_created_at_micros: "9007199254740993" }),
    basis(21, { assessment_created_at_micros: "9007199254740993" }),
  ];
  const d = database({ bases });
  const a = await store(d.pool).listEvidenceBases({ ...listInput, limit: 1 });
  if (a.kind !== "ok") throw new Error("scope");
  const cursor = decodeIssueResolutionCursor(a.value.nextCursor!);
  expect(cursor).toEqual({ id: id(22), createdAtMicros: "9007199254740993" });
  expect(
    await store(d.pool).listEvidenceBases({ ...listInput, limit: 1, cursor }),
  ).toMatchObject({
    kind: "ok",
    value: { evidenceBases: [{ assessmentId: id(21) }], nextCursor: null },
  });
});
it("empty visible evidence list has no leaked raw identifiers", async () => {
  const b = basis();
  const d = database({ bases: [b], materials: [] });
  expect(await run(d, "bases")).toEqual({
    kind: "ok",
    value: { issueId: I, evidenceBases: [], nextCursor: null },
  });
});
it("historical Note batch stays bounded for20 distinct references", async () => {
  const counts = [];
  for (const n of [1, 20]) {
    const bases = Array.from({ length: n }, (_, i) => basis(20 + i));
    const items = bases.map((b, i) =>
      item(b, { target_type: "NOTE_REVISION", target_id: id(400 + i) }),
    );
    const revisions = items.map((it) => ({
      revision_id: it.target_id,
      note_id: N,
      revision_no: 1,
      content_format: "MARKDOWN",
      created_at: D,
    }));
    bases.forEach(
      (b, i) =>
        (b.manifest_sha256 = buildEvidenceManifestDraft([
          {
            role: "SUPPORTING",
            targetType: "NOTE_REVISION",
            targetId: items[i].target_id,
            note: null,
          },
        ]).manifestSha256),
    );
    const d = database({
      bases,
      items,
      revisions,
      resolutions: bases.map((b, i) =>
        resolution(200 + i, { evidence_manifest_id: b.manifest_id }),
      ),
    });
    const r = await run(d);
    expect(r).toMatchObject({ kind: "ok" });
    counts.push(d.calls.length);
    expect(
      d.calls.filter((c) => c.sql.includes("FROM core.note_revisions")),
    ).toHaveLength(1);
  }
  expect(counts[1]).toBe(counts[0]);
});
it("query-level unknown exception rolls back and is not masked", async () => {
  const e = new Error("unexpected parser failure"),
    d = database({ fail: "resolution-history", error: e });
  await expect(run(d)).rejects.toBe(e);
  expect(d.release).toHaveBeenCalledOnce();
  expect(d.calls.at(-1)?.sql).toBe("ROLLBACK");
});

it.each(["list", "get", "bases"])(
  "rejects duplicate Manifest target pairs with a matching SHA in %s",
  async (op) => {
    const b = basis();
    const duplicate = {
      role: "SUPPORTING" as const,
      targetType: "SOURCE" as const,
      targetId: S,
      note: null,
    };
    b.manifest_sha256 = buildEvidenceManifestDraft([
      duplicate,
      duplicate,
    ]).manifestSha256;
    const d = database({
      bases: [b],
      items: [item(b), item(b, { item_id: id(3999), ordinal: 2 })],
      resolutions: [resolution(4, { evidence_manifest_id: b.manifest_id })],
    });
    await expect(run(d, op)).rejects.toBeInstanceOf(
      IssueResolutionIntegrityError,
    );
    expect(d.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(d.release).toHaveBeenCalledOnce();
  },
);
