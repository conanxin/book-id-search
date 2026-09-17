-- P29-D4 S32-M0 Runtime Schema Assertions
\echo '=== SCHEMA_COUNT ==='
SELECT count(*)::text FROM information_schema.schemata WHERE schema_name IN ('core','ops','derived');

\echo '=== CORE_TABLE_COUNT ==='
SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'core';

\echo '=== OPS_TABLE_COUNT ==='
SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'ops';

\echo '=== DERIVED_TABLE_COUNT (must be 0) ==='
SELECT count(*)::text FROM information_schema.tables WHERE table_schema = 'derived';

\echo '=== CORE_TABLE_NAMES (must be exactly 22) ==='
SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'core';

\echo '=== OPS_TABLE_NAMES (must be exactly 4) ==='
SELECT string_agg(table_name, ',' ORDER BY table_name) FROM information_schema.tables WHERE table_schema = 'ops';

\echo '=== D2_FROZEN_INDEXES_PRESENT ==='
SELECT indexname FROM pg_indexes WHERE schemaname IN ('core','ops') AND indexname IN ('ix_editions_isbn','ix_source_assets_sha256','uq_external_identities_active_binding','ix_claim_relations_target_claim_id','ix_assessments_claim_time','ix_research_issue_claims_claim_id','ix_issue_resolutions_issue_time','ix_research_runs_issue_time','ix_evidence_manifests_sha256','ix_outbox_unpublished_dequeue','uq_projection_one_active','ix_integrity_recent_by_check','ix_integrity_recent_by_status') ORDER BY indexname;

\echo '=== DEFERRED_COMPOSITE_FK ==='
SELECT conname, condeferrable, condeferred FROM pg_constraint WHERE conname IN ('fk_notes_current_revision','fk_ri_current_resolution');

\echo '=== 5_TRIGGERS_PRESENT ==='
SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE trigger_schema IN ('core','ops') AND trigger_name IN ('trg_note_revisions_no_update','trg_note_revisions_no_delete','trg_claims_statement_no_update','trg_assessments_no_update','trg_assessments_no_delete','trg_em_no_update','trg_em_no_delete','trg_emi_no_update','trg_emi_no_delete','trg_rr_terminal_immutable') ORDER BY trigger_name;

\echo '=== FORBIDDEN_FEATURE_SCAN ==='
SELECT 'CREATE EXTENSION' AS marker, count(*)::text FROM pg_extension WHERE extname <> 'plpgsql';
SELECT 'CREATE TYPE ENUM' AS marker, count(*)::text FROM pg_type WHERE typtype = 'e';
