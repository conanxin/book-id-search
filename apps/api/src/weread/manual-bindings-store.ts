import type { Pool } from "pg";

export type WereadBindingMode = "bind" | "unbind" | "inherit";

/** Internal persistence shape. The raw source id never enters management DTOs. */
export interface WereadBindingOverride {
  wereadBookId: string;
  mode: WereadBindingMode;
  catalogId: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface WereadBindingWrite {
  wereadBookId: string;
  mode: WereadBindingMode;
  catalogId: string | null;
  expectedRevision: number;
}

export interface WereadBindingStore {
  list(): Promise<WereadBindingOverride[]>;
  write(input: WereadBindingWrite): Promise<WereadBindingOverride>;
}

export class WereadBindingConflictError extends Error {
  constructor() { super("WeRead binding revision changed"); }
}

type Row = {
  weread_book_id: string;
  mode: WereadBindingMode;
  catalog_id: string | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
};

function fromRow(row: Row): WereadBindingOverride {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid binding revision");
  return { wereadBookId: row.weread_book_id, mode: row.mode, catalogId: row.catalog_id,
    revision, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

export function createPostgresWereadBindingStore(pool: Pool): WereadBindingStore {
  return {
    async list() {
      const result = await pool.query<Row>("SELECT * FROM core.weread_binding_overrides ORDER BY weread_book_id");
      return result.rows.map(fromRow);
    },
    async write(input) {
      // Each statement performs the revision check and mutation atomically.
      // In particular two first writers cannot both succeed with revision 0.
      const result = input.expectedRevision === 0
        ? await pool.query<Row>(`INSERT INTO core.weread_binding_overrides (weread_book_id, mode, catalog_id)
            VALUES ($1, $2, $3) ON CONFLICT (weread_book_id) DO NOTHING RETURNING *`,
          [input.wereadBookId, input.mode, input.catalogId])
        : await pool.query<Row>(`UPDATE core.weread_binding_overrides
            SET mode = $2, catalog_id = $3, revision = revision + 1, updated_at = now()
            WHERE weread_book_id = $1 AND revision = $4 AND revision < 9007199254740991 RETURNING *`,
          [input.wereadBookId, input.mode, input.catalogId, input.expectedRevision]);
      if (!result.rows[0]) throw new WereadBindingConflictError();
      return fromRow(result.rows[0]);
    },
  };
}
