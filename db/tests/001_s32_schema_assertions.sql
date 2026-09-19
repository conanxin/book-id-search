-- S32-M0 schema assertions (fail-closed: each expected property verified via DO blocks that RAISE EXCEPTION on mismatch)
SET client_min_messages = WARNING;

\echo '=== ASSERT: schemas exact presence ==='
DO $$ BEGIN
    IF (SELECT count(*) FROM pg_namespace WHERE nspname = 'core') <> 1
       OR (SELECT count(*) FROM pg_namespace WHERE nspname = 'ops') <> 1
       OR (SELECT count(*) FROM pg_namespace WHERE nspname = 'derived') <> 1 THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: schemas (core,ops,derived) not all present';
    END IF;
END $$;

\echo '=== ASSERT: core table count = 22 ==='
DO $$ BEGIN
    IF (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'core') <> 22 THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: core table count <> 22';
    END IF;
END $$;

\echo '=== ASSERT: ops table count = 4 ==='
DO $$ BEGIN
    IF (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'ops') <> 4 THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: ops table count <> 4';
    END IF;
END $$;

\echo '=== ASSERT: derived table count = 0 ==='
DO $$ BEGIN
    IF (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'derived') <> 0 THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: derived schema must be empty in M0';
    END IF;
END $$;

\echo '=== ASSERT: exact 22 core table names (bidirectional EXCEPT set comparison, order-independent) ==='
DO $$
DECLARE
    expected text[] := ARRAY[
        'actors','assessments','claim_relations','claims','contributions','editions',
        'evidence_manifest_items','evidence_manifests','external_identities','issue_resolutions',
        'note_revision_parents','note_revisions','notes','project_bindings','projects',
        'research_issue_claims','research_issues','research_runs','source_asset_parents',
        'source_assets','sources','works'
    ];
    missing text;
    unexpected text;
BEGIN
    -- expected EXCEPT actual  =  tables in expected list but missing from DB
    SELECT string_agg(name, ', ' ORDER BY name) INTO missing
    FROM (
        (SELECT unnest(expected) AS name)
        EXCEPT
        (SELECT table_name FROM information_schema.tables WHERE table_schema = 'core')
    ) sub;
    -- actual EXCEPT expected  =  tables present in DB but not in expected list
    SELECT string_agg(table_name, ', ' ORDER BY table_name) INTO unexpected
    FROM (
        (SELECT table_name FROM information_schema.tables WHERE table_schema = 'core')
        EXCEPT
        (SELECT unnest(expected))
    ) sub;
    IF missing IS NOT NULL OR unexpected IS NOT NULL THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: core table set mismatch - missing: %; unexpected: %',
            COALESCE(missing, '(none)'),
            COALESCE(unexpected, '(none)');
    END IF;
END $$;

\echo '=== ASSERT: exact 4 ops table names (bidirectional EXCEPT set comparison, order-independent) ==='
DO $$
DECLARE
    expected text[] := ARRAY[
        'idempotency_keys','integrity_check_runs','outbox_events','projection_generations'
    ];
    missing text;
    unexpected text;
BEGIN
    -- expected EXCEPT actual  =  tables in expected list but missing from DB
    SELECT string_agg(name, ', ' ORDER BY name) INTO missing
    FROM (
        (SELECT unnest(expected) AS name)
        EXCEPT
        (SELECT table_name FROM information_schema.tables WHERE table_schema = 'ops')
    ) sub;
    -- actual EXCEPT expected  =  tables present in DB but not in expected list
    SELECT string_agg(table_name, ', ' ORDER BY table_name) INTO unexpected
    FROM (
        (SELECT table_name FROM information_schema.tables WHERE table_schema = 'ops')
        EXCEPT
        (SELECT unnest(expected))
    ) sub;
    IF missing IS NOT NULL OR unexpected IS NOT NULL THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: ops table set mismatch - missing: %; unexpected: %',
            COALESCE(missing, '(none)'),
            COALESCE(unexpected, '(none)');
    END IF;
END $$;

\echo '=== ASSERT: no core->ops FK (forbidden by architecture) ==='
DO $$ DECLARE n int; BEGIN
    SELECT count(*) INTO n FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'core'
      AND c.confrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname = 'ops'));
    IF n <> 0 THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: core→ops FK forbidden (% found)', n;
    END IF;
END $$;

\echo '=== ASSERT: no ops->core polymorphic hard FK (forbidden) ==='
DO $$ DECLARE n int; BEGIN
    SELECT count(*) INTO n FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'ops'
      AND c.confrelid IN (SELECT oid FROM pg_class WHERE relnamespace IN (SELECT oid FROM pg_namespace WHERE nspname = 'core'));
    IF n <> 0 THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: ops→core hard FK forbidden (% found)', n;
    END IF;
END $$;

\echo '=== ASSERT: no PG ENUM types in core/ops ==='
DO $$ DECLARE n int; BEGIN
    SELECT count(*) INTO n FROM pg_type t JOIN pg_namespace ns ON ns.oid = t.typnamespace
    WHERE t.typtype = 'e' AND ns.nspname IN ('core','ops');
    IF n <> 0 THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: PG ENUM found in core/ops (% types)', n;
    END IF;
END $$;

\echo '=== ASSERT: no CREATE EXTENSION beyond plpgsql ==='
DO $$ DECLARE n int; BEGIN
    SELECT count(*) INTO n FROM pg_extension WHERE extname <> 'plpgsql';
    IF n <> 0 THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: unexpected extensions (%)', n;
    END IF;
END $$;

\echo '=== ASSERT: D2 frozen indexes present ==='
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_editions_isbn')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_source_assets_sha256')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_external_identities_active_binding')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_claim_relations_target_claim_id')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_assessments_claim_time')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_research_issue_claims_claim_id')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_issue_resolutions_issue_time')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_research_runs_issue_time')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_evidence_manifests_sha256')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_outbox_unpublished_dequeue')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'uq_projection_one_active')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_integrity_recent_by_check')
       OR NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'ix_integrity_recent_by_status') THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: one or more D2 frozen indexes missing';
    END IF;
END $$;

\echo '=== ASSERT: notes deferred composite current-pointer FK ==='
DO $$ DECLARE conname text; v_is_deferrable bool; v_initially_deferred bool; BEGIN
    SELECT c.conname, c.condeferrable, c.condeferred INTO conname, v_is_deferrable, v_initially_deferred
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace
    WHERE ns.nspname = 'core' AND t.relname = 'notes' AND pg_get_constraintdef(c.oid) LIKE '%FOREIGN KEY (id, current_revision_id)%';
    IF conname IS NULL THEN RAISE EXCEPTION 'S32_ASSERT_FAIL: notes deferred composite FK missing'; END IF;
    IF NOT v_is_deferrable THEN RAISE EXCEPTION 'S32_ASSERT_FAIL: notes FK not DEFERRABLE'; END IF;
    IF NOT v_initially_deferred THEN RAISE EXCEPTION 'S32_ASSERT_FAIL: notes FK not INITIALLY DEFERRED'; END IF;
END $$;

\echo '=== ASSERT: research_issues deferred composite current-resolution FK ==='
DO $$ DECLARE conname text; v_is_deferrable bool; v_initially_deferred bool; BEGIN
    SELECT c.conname, c.condeferrable, c.condeferred INTO conname, v_is_deferrable, v_initially_deferred
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace
    WHERE ns.nspname = 'core' AND t.relname = 'research_issues' AND pg_get_constraintdef(c.oid) LIKE '%FOREIGN KEY (id, current_resolution_id)%';
    IF conname IS NULL THEN RAISE EXCEPTION 'S32_ASSERT_FAIL: research_issues deferred composite FK missing'; END IF;
    IF NOT v_is_deferrable THEN RAISE EXCEPTION 'S32_ASSERT_FAIL: research_issues FK not DEFERRABLE'; END IF;
    IF NOT v_initially_deferred THEN RAISE EXCEPTION 'S32_ASSERT_FAIL: research_issues FK not INITIALLY DEFERRED'; END IF;
END $$;

\echo '=== ASSERT: note_revision_parents has same-note composite FK (child) ==='
DO $$ DECLARE n int; BEGIN
    SELECT count(*) INTO n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace
    WHERE ns.nspname = 'core' AND t.relname = 'note_revision_parents'
      AND pg_get_constraintdef(c.oid) LIKE '%FOREIGN KEY (note_id, child_revision_id)%';
    IF n <> 1 THEN RAISE EXCEPTION 'S32_ASSERT_FAIL: note_revision_parents same-note child composite FK missing (% found)', n; END IF;
END $$;

\echo '=== ASSERT: note_revision_parents has same-note composite FK (parent) ==='
DO $$ DECLARE n int; BEGIN
    SELECT count(*) INTO n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace ns ON ns.oid = t.relnamespace
    WHERE ns.nspname = 'core' AND t.relname = 'note_revision_parents'
      AND pg_get_constraintdef(c.oid) LIKE '%FOREIGN KEY (note_id, parent_revision_id)%';
    IF n <> 1 THEN RAISE EXCEPTION 'S32_ASSERT_FAIL: note_revision_parents same-note parent composite FK missing (% found)', n; END IF;
END $$;

\echo '=== ASSERT: 5 frozen trigger contracts present ==='
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_note_revisions_no_update')
       OR NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_note_revisions_no_delete')
       OR NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_claims_statement_no_update')
       OR NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_assessments_no_update')
       OR NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_assessments_no_delete')
       OR NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_em_no_update')
       OR NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_em_no_delete')
       OR NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_emi_no_update')
       OR NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_emi_no_delete')
       OR NOT EXISTS (SELECT 1 FROM information_schema.triggers WHERE trigger_name = 'trg_rr_terminal_immutable') THEN
        RAISE EXCEPTION 'S32_ASSERT_FAIL: one or more frozen triggers missing';
    END IF;
END $$;

\echo '=== S32_SCHEMA_ASSERTIONS PASS ==='
