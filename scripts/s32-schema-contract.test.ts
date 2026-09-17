import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const ROOT = resolve(__dirname, "..");
const MIG = resolve(ROOT, "db/migrations/001_s32_core_schema.sql");
describe("S32-M0 schema static contract", () => {
  it("migration file exists", () => { expect(existsSync(MIG)).toBe(true); });
  it("declares core/ops/derived schemas", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s).toMatch(/CREATE\s+SCHEMA\s+core/i);
    expect(s).toMatch(/CREATE\s+SCHEMA\s+ops/i);
    expect(s).toMatch(/CREATE\s+SCHEMA\s+derived/i);
  });
  it("forbids CREATE EXTENSION / TYPE / gen_random_uuid / uuid_generate", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s).not.toMatch(/CREATE\s+EXTENSION/i);
    expect(s).not.toMatch(/CREATE\s+TYPE\s/i);
    expect(s).not.toMatch(/gen_random_uuid/i);
    expect(s).not.toMatch(/uuid_generate/i);
  });
  it("forbids Meili/vector/embedding/FTS/trigram in v1 core", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s).not.toMatch(/meilisearch/i);
    expect(s).not.toMatch(/\bvector\b/i);
    expect(s).not.toMatch(/embedding/i);
    expect(s).not.toMatch(/to_tsvector/i);
    expect(s).not.toMatch(/gin_trgm_ops/i);
  });
  it("core schema has exactly 22 tables", () => {
    const s = readFileSync(MIG, "utf8");
    const core = ["actors","works","editions","sources","source_assets","source_asset_parents","external_identities","notes","note_revisions","note_revision_parents","claims","claim_relations","evidence_manifests","evidence_manifest_items","research_issues","research_issue_claims","research_runs","assessments","issue_resolutions","projects","project_bindings","contributions"];
    expect(core.length).toBe(22);
    for (const t of core) expect(s).toMatch(new RegExp(`CREATE\\s+TABLE\\s+core\\.${t}\\b`, "i"));
  });
  it("ops schema has exactly 4 tables", () => {
    const s = readFileSync(MIG, "utf8");
    for (const t of ["outbox_events","idempotency_keys","integrity_check_runs","projection_generations"])
      expect(s).toMatch(new RegExp(`CREATE\\s+TABLE\\s+ops\\.${t}\\b`, "i"));
  });
  it("derived schema has NO concrete table in M0", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s).not.toMatch(/CREATE\s+TABLE\s+derived\./i);
  });
  it("core MUST NOT FK to ops", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s.match(/core\.\w+[^\n]*REFERENCES\s+ops\./gi)).toBeNull();
  });
  it("deferred composite current-pointer FK for notes", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s).toMatch(/ALTER\s+TABLE\s+core\.notes[\s\S]*?FOREIGN\s+KEY\s*\(\s*id\s*,\s*current_revision_id\s*\)\s*REFERENCES\s+core\.note_revisions\s*\(\s*note_id\s*,\s*id\s*\)/i);
    expect(s).toMatch(/DEFERRABLE\s+INITIALLY\s+DEFERRED/i);
  });
  it("deferred composite current-pointer FK for research_issues", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s).toMatch(/ALTER\s+TABLE\s+core\.research_issues[\s\S]*?FOREIGN\s+KEY\s*\(\s*id\s*,\s*current_resolution_id\s*\)\s*REFERENCES\s+core\.issue_resolutions\s*\(\s*issue_id\s*,\s*id\s*\)/i);
  });
  it("contains D2 frozen indexes (9)", () => {
    const s = readFileSync(MIG, "utf8");
    for (const ix of ["ix_editions_isbn","ix_source_assets_sha256","uq_external_identities_active_binding","ix_claim_relations_target_claim_id","ix_assessments_claim_time","ix_research_issue_claims_claim_id","ix_issue_resolutions_issue_time","ix_research_runs_issue_time","ix_evidence_manifests_sha256","ix_outbox_unpublished_dequeue","uq_projection_one_active"])
      expect(s).toMatch(new RegExp(`(INDEX|CREATE\\s+UNIQUE\\s+INDEX)\\s+${ix}\\b`, "i"));
  });
  it("contains 5 frozen trigger contracts", () => {
    const s = readFileSync(MIG, "utf8");
    for (const t of ["NOTE_REVISION_IMMUTABILITY","CLAIM_STATEMENT_IMMUTABLE","ASSESSMENT_APPEND_ONLY","MANIFEST_IMMUTABLE","TERMINAL_RUN_IMMUTABILITY"])
      expect(s).toMatch(new RegExp(t));
  });
  it("uses TEXT+CHECK for allowlists (no PG ENUM)", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s).toMatch(/actor_type\s+TEXT/i);
    expect(s).toMatch(/title_status\s+TEXT/i);
    expect(s).toMatch(/lifecycle_state\s+TEXT/i);
  });
  it("UUID type used for canonical IDs", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s).toMatch(/\bid\s+UUID\b/i);
  });
});
