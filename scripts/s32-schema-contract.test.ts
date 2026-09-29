import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
const ROOT = process.env.S32_ROOT_OVERRIDE
  ? resolve(process.env.S32_ROOT_OVERRIDE)
  : resolve(__dirname, "..");
const MIG = resolve(ROOT, "db/migrations/001_s32_core_schema.sql");
const ASSERTIONS = resolve(ROOT, "db/tests/001_s32_schema_assertions.sql");
const NEG = resolve(ROOT, "db/tests/002_s32_negative_invariants.sql");
const HARNESS = resolve(ROOT, "scripts/s32-schema-check.ts");

describe("S32-M0 schema static contract (frozen artifact chain D1+D2+P29-C+R2+R3)", () => {
  // Phase 1 additions: verifier defect contract
  it("note_revision_parents uses composite same-note FK (note_id, child_revision_id)→(note_id,id)", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s).toMatch(/FOREIGN\s+KEY\s*\(\s*note_id\s*,\s*child_revision_id\s*\)\s*REFERENCES\s+core\.note_revisions\s*\(\s*note_id\s*,\s*id\s*\)/);
  });
  it("note_revision_parents uses composite same-note FK (note_id, parent_revision_id)→(note_id,id)", () => {
    const s = readFileSync(MIG, "utf8");
    expect(s).toMatch(/FOREIGN\s+KEY\s*\(\s*note_id\s*,\s*parent_revision_id\s*\)\s*REFERENCES\s+core\.note_revisions\s*\(\s*note_id\s*,\s*id\s*\)/);
  });
  it("schema assertions SQL uses fail-closed mechanism (RAISE EXCEPTION or deterministic failure)", () => {
    expect(existsSync(ASSERTIONS)).toBe(true);
    const s = readFileSync(ASSERTIONS, "utf8");
    expect(s).toMatch(/RAISE\s+EXCEPTION/);
    expect(s.toLowerCase()).toMatch(/assert|raise|exception/);
  });
  it("negative invariants SQL has explicit missing-rejection failure (EXPECTED_REJECTION_MISSING)", () => {
    expect(existsSync(NEG)).toBe(true);
    const s = readFileSync(NEG, "utf8");
    expect(s).toMatch(/EXPECTED_REJECTION_MISSING/);
  });
  it("integration harness uses psql ON_ERROR_STOP=1", () => {
    expect(existsSync(HARNESS)).toBe(true);
    const s = readFileSync(HARNESS, "utf8");
    expect(s).toMatch(/ON_ERROR_STOP\s*=\s*1/);
  });
  it("integration harness does NOT use docker(...).catch() (docker() is synchronous)", () => {
    const s = readFileSync(HARNESS, "utf8");
    expect(s).not.toMatch(/docker\([^)]*\)\.catch\(/);
  });
  it("integration harness uses process.exit(2) for unexpected cleanup failure (new contract: non-zero exit, no SCHEMA_OK)", () => {
    const s = readFileSync(HARNESS, "utf8");
    // New contract: process.exit(2) IS used for unexpected cleanup failure.
    expect(s).toMatch(/process\.exit\s*\(\s*2\s*\)/);
  });
  it("integration harness has readiness gate (after pg_isready loop, must throw if not ready)", () => {
    const s = readFileSync(HARNESS, "utf8");
    expect(s).toMatch(/PG_READY/);
  });
  it("integration harness uses deterministic UUID literals (no gen_random_uuid() in negative invariants)", () => {
    const s = readFileSync(NEG, "utf8");
    expect(s).not.toMatch(/gen_random_uuid\s*\(\s*\)/);
  });
  // Original 14 tests
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
    for (const ix of ["ix_editions_isbn","ix_source_assets_sha256","uq_external_identities_active_binding","ix_claim_relations_target_claim_id","ix_assessments_claim_time","ix_research_issue_claims_claim_id","ix_issue_resolutions_issue_time","ix_research_runs_issue_time","ix_evidence_manifests_sha256","ix_outbox_unpublished_dequeue","uq_projection_one_active","ix_integrity_recent_by_check","ix_integrity_recent_by_status"])
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


describe("M2-E additive schema contract", () => {
  const path = resolve(ROOT, "db/migrations/002_s32_m2e_issue_resolution.sql");
  function migration() { expect(existsSync(path), "002 additive migration exists").toBe(true); return readFileSync(path, "utf8"); }
  it("preserves the three frozen v1 SQL artifacts byte for byte", () => {
    for (const [p, hash] of [
      [MIG, "f016197c1a4f0b89a85713ae9de6547305b12501da2163f1423751dfc5c621c6"],
      [ASSERTIONS, "adea011da6dfa0020bfa0fe8f65b295104bcde61cd60cd3f56a11dbe95b733e4"],
      [NEG, "ba6de881fe7ef806f19c61a23cae04bae38b1906984b1a3d9d956a516aa2da06"],
    ]) expect(createHash("sha256").update(readFileSync(p!)).digest("hex")).toBe(hash);
  });
  it("adds a validated same-Issue preferred Claim foreign key", () => {
    expect(migration()).toMatch(/FOREIGN KEY\s*\(issue_id, preferred_claim_id\)\s*REFERENCES core\.research_issue_claims\s*\(issue_id, claim_id\)\s*ON DELETE RESTRICT/);
    expect(migration()).not.toMatch(/NOT VALID/i);
  });
  it("rejects incompatible legacy data before DDL without repairing it", () => {
    const s = migration();
    expect(s).toContain("S32_M2E_LEGACY_PREFERRED_CLAIM_NOT_MEMBER");
    expect(s.indexOf("S32_M2E_LEGACY_PREFERRED_CLAIM_NOT_MEMBER")).toBeLessThan(s.indexOf("ADD CONSTRAINT"));
    expect(s).not.toMatch(/(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+core\./i);
    expect(s.trim()).toMatch(/^BEGIN;[\s\S]*COMMIT;$/);
  });
  it("adds both row-level immutability triggers", () => {
    const s = migration();
    for (const action of ["UPDATE", "DELETE"]) expect(s).toMatch(new RegExp(`BEFORE ${action} ON core\\.issue_resolutions[\\s\\S]*?FOR EACH ROW EXECUTE FUNCTION core\\.fn_issue_resolutions_immutable`));
    expect(s).toContain("S32_M2E_ISSUE_RESOLUTION_IMMUTABLE");
  });
  it("does not add tables, columns, indexes or redesign enum/check semantics", () => {
    expect(migration()).not.toMatch(/CREATE\s+(?:TABLE|TYPE|(?:UNIQUE\s+)?INDEX)|ADD\s+COLUMN|DROP\s+CONSTRAINT|supersedes_resolution_id/i);
  });
  it("schema runner includes both new assertion suites and upgrade gates", () => {
    const s = readFileSync(HARNESS, "utf8");
    for (const name of ["003_s32_m2e_schema_assertions.sql", "004_s32_m2e_negative_invariants.sql", "VALID_001_TO_002_UPGRADE_PG16", "INVALID_LEGACY_PREFLIGHT_FAIL_CLOSED_PG16"]) expect(s).toContain(name);
  });
});
