import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  CanonicalStoreUnavailableError,
  IdentityConflictError,
} from "../application/promote-catalog-book.js";
import type { PromotionCandidate } from "../domain/catalog-promotion.js";
import { createPostgresCatalogPromotionStore } from "./catalog-promotion-store.js";

const databaseUrl = process.env.S32_TEST_DATABASE_URL;
const describePg = databaseUrl ? describe : describe.skip;

function candidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  const base: PromotionCandidate = {
    catalogBookId: "100_202601010001",
    work: {
      workType: "BOOK",
      title: "Book A",
      titleStatus: "KNOWN",
    },
    edition: {
      editionType: "BOOK_EDITION",
      publisher: "Press A",
      publicationDate: "1986-01-01",
      publicationDatePrecision: "YEAR",
      isbn: "9787538455250",
    },
    source: {
      sourceType: "DATABASE_RECORD",
      observedAt: "2026-09-19T10:00:00.000Z",
      metadata: {
        provider: "BOOK_ID_SEARCH",
        catalogDocument: {
          id: "100_202601010001",
          ssid: "SSID-A",
          dxid: "DXID-A",
          title: "Book A",
          author: "Author A / Author B",
          publisher: "Press A",
          year: 1986,
          pages: 320,
          isbn: "9787538455250",
          rawInfo: "raw A",
          parseStatus: "weak",
          parseWarnings: ["w1"],
        },
      },
    },
    secondaryIdentities: [
      { namespace: "SSID", externalId: "SSID-A" },
      { namespace: "DXID", externalId: "DXID-A" },
    ],
  };
  return {
    ...base,
    ...overrides,
    work: { ...base.work, ...(overrides.work ?? {}) },
    edition: { ...base.edition, ...(overrides.edition ?? {}) },
    source: { ...base.source, ...(overrides.source ?? {}) },
    secondaryIdentities: overrides.secondaryIdentities ?? base.secondaryIdentities,
  };
}

describePg("PostgreSQL catalog promotion store", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM core.external_identities");
    await pool.query("DELETE FROM core.sources");
    await pool.query("DELETE FROM core.editions");
    await pool.query("DELETE FROM core.works");
  });

  it("creates one canonical Work -> Edition -> Source chain with source identities", async () => {
    const store = createPostgresCatalogPromotionStore(pool);
    const result = await store.promote(candidate());

    expect(result.status).toBe("created");
    const counts = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM core.works) works,
        (SELECT count(*)::int FROM core.editions) editions,
        (SELECT count(*)::int FROM core.sources) sources,
        (SELECT count(*)::int FROM core.external_identities
          WHERE provider='BOOK_ID_SEARCH' AND namespace='CATALOG_DOCUMENT'
            AND binding_state <> 'RETIRED') catalog_ids,
        (SELECT count(*)::int FROM core.external_identities
          WHERE provider='BOOK_ID_SEARCH' AND namespace='SSID'
            AND binding_state <> 'RETIRED') ssids,
        (SELECT count(*)::int FROM core.external_identities
          WHERE provider='BOOK_ID_SEARCH' AND namespace='DXID'
            AND binding_state <> 'RETIRED') dxids
    `);
    expect(counts.rows[0]).toEqual({
      works: 1, editions: 1, sources: 1, catalog_ids: 1, ssids: 1, dxids: 1,
    });

    const chain = await pool.query(`
      SELECT s.id source_id, s.edition_id, e.work_id, s.metadata
      FROM core.sources s
      JOIN core.editions e ON e.id=s.edition_id
      WHERE s.id=$1
    `, [result.sourceId]);
    expect(chain.rows[0].source_id).toBe(result.sourceId);
    expect(chain.rows[0].edition_id).toBe(result.editionId);
    expect(chain.rows[0].work_id).toBe(result.workId);
    expect(chain.rows[0].metadata.catalogDocument.author).toBe("Author A / Author B");
    expect(chain.rows[0].metadata.catalogDocument.rawInfo).toBe("raw A");
    expect(chain.rows[0].metadata.catalogDocument.parseStatus).toBe("weak");
    expect(chain.rows[0].metadata.catalogDocument.parseWarnings).toEqual(["w1"]);

    const identities = await pool.query(`
      SELECT namespace, target_type, target_id
      FROM core.external_identities
      ORDER BY namespace
    `);
    expect(identities.rows).toHaveLength(3);
    for (const row of identities.rows) {
      expect(row.target_type).toBe("SOURCE");
      expect(row.target_id).toBe(result.sourceId);
    }
    console.log("M1A_CREATED=PASS");
  });

  it("is sequentially idempotent and does not overwrite canonical fields after catalog drift", async () => {
    const store = createPostgresCatalogPromotionStore(pool);
    const first = await store.promote(candidate());
    const drifted = candidate({
      work: { workType: "BOOK", title: "Changed Title", titleStatus: "KNOWN" },
      edition: {
        editionType: "BOOK_EDITION",
        publisher: "Changed Press",
        publicationDate: "2001-01-01",
        publicationDatePrecision: "YEAR",
        isbn: "9780000000000",
      },
    });
    const second = await store.promote(drifted);

    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
    expect(second.workId).toBe(first.workId);
    expect(second.editionId).toBe(first.editionId);
    expect(second.sourceId).toBe(first.sourceId);

    const rows = await pool.query(`
      SELECT w.title, e.publisher, e.publication_date::text, e.isbn,
        (SELECT count(*)::int FROM core.works) works,
        (SELECT count(*)::int FROM core.editions) editions,
        (SELECT count(*)::int FROM core.sources) sources
      FROM core.works w
      JOIN core.editions e ON e.work_id=w.id
      WHERE w.id=$1
    `, [first.workId]);
    expect(rows.rows[0]).toMatchObject({
      title: "Book A",
      publisher: "Press A",
      publication_date: "1986-01-01",
      isbn: "9787538455250",
      works: 1,
      editions: 1,
      sources: 1,
    });
    console.log("M1A_IDEMPOTENT=PASS");
  });

  it("handles concurrent duplicate promotion with one created and one existing chain", async () => {
    const store = createPostgresCatalogPromotionStore(pool);
    const [a, b] = await Promise.all([
      store.promote(candidate()),
      store.promote(candidate()),
    ]);

    expect([a.status, b.status].sort()).toEqual(["created", "existing"]);
    expect(a.workId).toBe(b.workId);
    expect(a.editionId).toBe(b.editionId);
    expect(a.sourceId).toBe(b.sourceId);

    const counts = await pool.query(`
      SELECT
        (SELECT count(*)::int FROM core.works) works,
        (SELECT count(*)::int FROM core.editions) editions,
        (SELECT count(*)::int FROM core.sources) sources,
        (SELECT count(*)::int FROM core.external_identities
         WHERE provider='BOOK_ID_SEARCH' AND namespace='CATALOG_DOCUMENT'
           AND binding_state <> 'RETIRED') catalog_ids
    `);
    expect(counts.rows[0]).toEqual({ works: 1, editions: 1, sources: 1, catalog_ids: 1 });
    console.log("M1A_CONCURRENT_IDEMPOTENT=PASS");
  });

  it("fails closed on SSID collision and rolls back the second candidate", async () => {
    const store = createPostgresCatalogPromotionStore(pool);
    const first = await store.promote(candidate());
    const secondCandidate = candidate({
      catalogBookId: "200_202601010002",
      work: { workType: "BOOK", title: "Book B", titleStatus: "KNOWN" },
      source: {
        sourceType: "DATABASE_RECORD",
        observedAt: "2026-09-19T10:01:00.000Z",
        metadata: {
          provider: "BOOK_ID_SEARCH",
          catalogDocument: {
            ...candidate().source.metadata.catalogDocument,
            id: "200_202601010002",
            title: "Book B",
            dxid: "DXID-B",
          },
        },
      },
      secondaryIdentities: [
        { namespace: "SSID", externalId: "SSID-A" },
        { namespace: "DXID", externalId: "DXID-B" },
      ],
    });

    await expect(store.promote(secondCandidate)).rejects.toMatchObject({
      name: "IdentityConflictError",
      code: "SECONDARY_IDENTITY_CONFLICT:SSID",
    });

    expect((await pool.query("SELECT count(*)::int n FROM core.works")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int n FROM core.sources")).rows[0].n).toBe(1);
    expect((await pool.query(
      "SELECT count(*)::int n FROM core.external_identities WHERE namespace='CATALOG_DOCUMENT' AND external_id=$1",
      [secondCandidate.catalogBookId],
    )).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM core.sources WHERE id=$1", [first.sourceId])).rows[0].n).toBe(1);
    console.log("M1A_SSID_CONFLICT=PASS");
  });

  it("fails closed on DXID collision and rolls back the second candidate", async () => {
    const store = createPostgresCatalogPromotionStore(pool);
    await store.promote(candidate());
    const secondCandidate = candidate({
      catalogBookId: "300_202601010003",
      work: { workType: "BOOK", title: "Book C", titleStatus: "KNOWN" },
      secondaryIdentities: [
        { namespace: "SSID", externalId: "SSID-C" },
        { namespace: "DXID", externalId: "DXID-A" },
      ],
    });

    await expect(store.promote(secondCandidate)).rejects.toMatchObject({
      name: "IdentityConflictError",
      code: "SECONDARY_IDENTITY_CONFLICT:DXID",
    });
    expect((await pool.query("SELECT count(*)::int n FROM core.works")).rows[0].n).toBe(1);
    expect((await pool.query(
      "SELECT count(*)::int n FROM core.external_identities WHERE namespace='CATALOG_DOCUMENT' AND external_id=$1",
      [secondCandidate.catalogBookId],
    )).rows[0].n).toBe(0);
    console.log("M1A_DXID_CONFLICT=PASS");
  });

  it("rolls back identities and canonical rows when a later SQL write fails", async () => {
    const store = createPostgresCatalogPromotionStore(pool);
    const broken = candidate({
      catalogBookId: "400_202601010004",
      edition: {
        editionType: "BOOK_EDITION",
        publisher: "Broken Press",
        publicationDate: "not-a-date",
        publicationDatePrecision: "YEAR",
        isbn: null,
      } as PromotionCandidate["edition"],
      secondaryIdentities: [
        { namespace: "SSID", externalId: "SSID-BROKEN" },
        { namespace: "DXID", externalId: "DXID-BROKEN" },
      ],
    });

    await expect(store.promote(broken)).rejects.toBeTruthy();

    for (const table of ["works", "editions", "sources", "external_identities"]) {
      const count = await pool.query(`SELECT count(*)::int n FROM core.${table}`);
      expect(count.rows[0].n).toBe(0);
    }
    console.log("M1A_ROLLBACK=PASS");
  });

  it("classifies connection failures without hiding programming errors", async () => {
    const fakePool = {
      connect: async () => {
        throw Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
      },
    } as unknown as Pool;
    const store = createPostgresCatalogPromotionStore(fakePool);
    await expect(store.promote(candidate())).rejects.toBeInstanceOf(CanonicalStoreUnavailableError);
  });
});
