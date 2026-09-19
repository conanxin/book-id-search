-- S32-M0 Negative Invariant Tests (fail-closed: each test proves the invalid operation WAS rejected)
-- Uses deterministic UUID literals — no '11111111-1111-1111-1111-111111111dd1'::uuid
SET client_min_messages = WARNING;

-- Helper macro: each test below follows the same structure:
--   DO $$ DECLARE rejected boolean := false; BEGIN
--     BEGIN <invalid op> EXCEPTION WHEN <expected> THEN rejected := true; END;
--     IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:<name>'; END IF;
--   END $$;
-- Positive tests raise on success-of-invalid-op, but must commit their fixture first.

-- ============================================================================
-- SHA / TEXT allowlist
-- ============================================================================
\echo '=== TEST 1: SOURCE_ASSET_SHA256_FORMAT_REJECTED ==='
DO $$
DECLARE
    sid uuid;
    good_id uuid := '11111111-1111-1111-1111-111111111101';
    bad_id  uuid := '11111111-1111-1111-1111-111111111102';
    inserted int;
    caught_sqlstate text;
    caught_constraint text;
    rejected boolean := false;
BEGIN
    -- Positive control: legal SHA on otherwise-legal fields MUST insert
    INSERT INTO core.sources (id, source_type, lifecycle_state)
        VALUES ('11111111-1111-1111-1111-1111111110a1', 'PUBLICATION', 'ACTIVE');
    SELECT id INTO sid FROM core.sources WHERE id = '11111111-1111-1111-1111-1111111110a1';
    INSERT INTO core.source_assets (id, source_id, asset_type, asset_role, storage_mode, storage_key, sha256)
        VALUES (good_id, sid, 'DOCUMENT', 'ORIGINAL', 'LOCAL', 'k',
                'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted <> 1 THEN
        RAISE EXCEPTION 'TEST_FAIL:POSITIVE_CONTROL: legal SHA insert did not affect 1 row (got %)', inserted;
    END IF;

    -- Negative: illegal SHA on same legal fields MUST be rejected by ck_sa_sha256_format (SQLSTATE 23514)
    BEGIN
        INSERT INTO core.source_assets (id, source_id, asset_type, asset_role, storage_mode, storage_key, sha256)
            VALUES (bad_id, sid, 'DOCUMENT', 'ORIGINAL', 'LOCAL', 'k', 'INVALID_NOT_LOWERCASE_HEX');
    EXCEPTION WHEN SQLSTATE '23514' THEN
        GET STACKED DIAGNOSTICS caught_sqlstate = RETURNED_SQLSTATE, caught_constraint = CONSTRAINT_NAME;
        IF caught_sqlstate IS DISTINCT FROM '23514' THEN
            RAISE EXCEPTION 'TEST_FAIL:SQLSTATE_MISMATCH: expected 23514, got %', caught_sqlstate;
        END IF;
        IF caught_constraint IS DISTINCT FROM 'ck_sa_sha256_format' THEN
            RAISE EXCEPTION 'TEST_FAIL:CONSTRAINT_MISMATCH: expected ck_sa_sha256_format, got %', caught_constraint;
        END IF;
        rejected := true;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:INVALID_SHA'; END IF;
END $$;

\echo '=== TEST 2: INVALID_ACTOR_TYPE_REJECTED ==='
DO $$ DECLARE rejected boolean := false; BEGIN
    BEGIN
        INSERT INTO core.actors (id, actor_type, display_name)
            VALUES ('11111111-1111-1111-1111-111111111102', 'BOGUS_NOT_IN_LIST', 't');
    EXCEPTION WHEN check_violation THEN rejected := true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:INVALID_ACTOR_TYPE'; END IF;
END $$;

-- ============================================================================
-- SourceAsset storage mode
-- ============================================================================
\echo '=== TEST 3: STORAGE_MODE_BOGUS_REJECTED ==='
DO $$
DECLARE sid uuid; rejected boolean := false;
BEGIN
    INSERT INTO core.sources (id, source_type, lifecycle_state) VALUES ('11111111-1111-1111-1111-111111111211', 'PUBLICATION', 'ACTIVE');
    SELECT id INTO sid FROM core.sources WHERE id = '11111111-1111-1111-1111-111111111211';
    BEGIN
        INSERT INTO core.source_assets (id, source_id, asset_type, asset_role, storage_mode, storage_key, remote_uri)
            VALUES ('11111111-1111-1111-1111-111111111203', sid, 'DOCUMENT', 'ORIGINAL', 'BOGUS_NOT_IN_LIST', 'k', 'u');
    EXCEPTION WHEN check_violation THEN rejected := true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:STORAGE_MODE_BOGUS'; END IF;
END $$;

\echo '=== TEST 4: LOCAL_MISSING_KEYS_REJECTED ==='
DO $$
DECLARE sid uuid; rejected boolean := false;
BEGIN
    INSERT INTO core.sources (id, source_type, lifecycle_state) VALUES ('11111111-1111-1111-1111-111111111212', 'PUBLICATION', 'ACTIVE');
    SELECT id INTO sid FROM core.sources WHERE id = '11111111-1111-1111-1111-111111111212';
    BEGIN
        INSERT INTO core.source_assets (id, source_id, asset_type, asset_role, storage_mode, storage_key, remote_uri, sha256)
            VALUES ('11111111-1111-1111-1111-111111111204', sid, 'DOCUMENT', 'ORIGINAL', 'LOCAL', NULL, NULL, NULL);
    EXCEPTION WHEN check_violation THEN rejected := true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:LOCAL_MISSING_KEYS'; END IF;
END $$;

-- ============================================================================
-- Note ownership (same-note)
-- ============================================================================
\echo '=== TEST 5: NOTE_CURRENT_REVISION_OTHER_NOTE_REJECTED ==='
DO $$
DECLARE nid1 uuid; nid2 uuid; rid uuid;
      caught_sqlstate text; caught_constraint text;
      rejected boolean := false;
BEGIN
    nid1 := '11111111-1111-1111-1111-111111111501';
    nid2 := '11111111-1111-1111-1111-111111111502';
    INSERT INTO core.notes (id, note_type) VALUES (nid1, 'GENERAL');
    INSERT INTO core.notes (id, note_type) VALUES (nid2, 'GENERAL');
    INSERT INTO core.note_revisions (id, note_id, revision_no, title, content_format, content, content_sha256)
        VALUES ('11111111-1111-1111-1111-111111111511', nid1, 1, 't', 'PLAIN_TEXT', 'c', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    rid := '11111111-1111-1111-1111-111111111511';
    BEGIN
        UPDATE core.notes SET current_revision_id = rid WHERE id = nid2;
        SET CONSTRAINTS core.fk_notes_current_revision IMMEDIATE;
    EXCEPTION WHEN SQLSTATE '23503' THEN
        GET STACKED DIAGNOSTICS caught_sqlstate = RETURNED_SQLSTATE, caught_constraint = CONSTRAINT_NAME;
        IF caught_constraint IS DISTINCT FROM 'fk_notes_current_revision' THEN
            RAISE EXCEPTION 'TEST_FAIL:CONSTRAINT_MISMATCH: expected fk_notes_current_revision, got %', caught_constraint;
        END IF;
        rejected := true;
    END;
    SET CONSTRAINTS core.fk_notes_current_revision DEFERRED;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:NOTE_CURRENT_REVISION_OTHER_NOTE'; END IF;
END $$;

\echo '=== TEST 6: NOTE_PARENT_CHILD_OTHER_NOTE_REJECTED ==='
DO $$
DECLARE nid1 uuid; nid2 uuid; rid1 uuid; rid2 uuid; rejected boolean := false;
BEGIN
    nid1 := '11111111-1111-1111-1111-111111111601';
    nid2 := '11111111-1111-1111-1111-111111111602';
    INSERT INTO core.notes (id, note_type) VALUES (nid1, 'GENERAL');
    INSERT INTO core.notes (id, note_type) VALUES (nid2, 'GENERAL');
    INSERT INTO core.note_revisions (id, note_id, revision_no, title, content_format, content, content_sha256)
        VALUES ('11111111-1111-1111-1111-111111111611', nid1, 1, 't', 'PLAIN_TEXT', 'c', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    INSERT INTO core.note_revisions (id, note_id, revision_no, title, content_format, content, content_sha256)
        VALUES ('11111111-1111-1111-1111-111111111612', nid2, 1, 't', 'PLAIN_TEXT', 'c', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    rid1 := '11111111-1111-1111-1111-111111111611';
    rid2 := '11111111-1111-1111-1111-111111111612';
    BEGIN
        INSERT INTO core.note_revision_parents (note_id, child_revision_id, parent_revision_id, parent_order)
            VALUES (nid1, rid2, rid1, 1);
    EXCEPTION WHEN foreign_key_violation OR check_violation THEN rejected := true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:NOTE_PARENT_CHILD_OTHER_NOTE'; END IF;
END $$;

\echo '=== TEST 7: NOTE_PARENT_PARENT_OTHER_NOTE_REJECTED ==='
DO $$
DECLARE nid1 uuid; nid2 uuid; rid1 uuid; rid2 uuid; rejected boolean := false;
BEGIN
    nid1 := '11111111-1111-1111-1111-111111111701';
    nid2 := '11111111-1111-1111-1111-111111111702';
    INSERT INTO core.notes (id, note_type) VALUES (nid1, 'GENERAL');
    INSERT INTO core.notes (id, note_type) VALUES (nid2, 'GENERAL');
    INSERT INTO core.note_revisions (id, note_id, revision_no, title, content_format, content, content_sha256)
        VALUES ('11111111-1111-1111-1111-111111111711', nid1, 1, 't', 'PLAIN_TEXT', 'c', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    INSERT INTO core.note_revisions (id, note_id, revision_no, title, content_format, content, content_sha256)
        VALUES ('11111111-1111-1111-1111-111111111712', nid2, 1, 't', 'PLAIN_TEXT', 'c', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    rid1 := '11111111-1111-1111-1111-111111111711';
    rid2 := '11111111-1111-1111-1111-111111111712';
    BEGIN
        INSERT INTO core.note_revision_parents (note_id, child_revision_id, parent_revision_id, parent_order)
            VALUES (nid2, rid2, rid1, 1);
    EXCEPTION WHEN foreign_key_violation OR check_violation THEN rejected := true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:NOTE_PARENT_PARENT_OTHER_NOTE'; END IF;
END $$;

\echo '=== TEST 8: NOTE_PARENT_SELF_EDGE_REJECTED ==='
DO $$
DECLARE nid uuid; rid uuid; rejected boolean := false;
BEGIN
    nid := '11111111-1111-1111-1111-111111111801';
    INSERT INTO core.notes (id, note_type) VALUES (nid, 'GENERAL');
    INSERT INTO core.note_revisions (id, note_id, revision_no, title, content_format, content, content_sha256)
        VALUES ('11111111-1111-1111-1111-111111111811', nid, 1, 't', 'PLAIN_TEXT', 'c', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    rid := '11111111-1111-1111-1111-111111111811';
    BEGIN
        INSERT INTO core.note_revision_parents (note_id, child_revision_id, parent_revision_id, parent_order)
            VALUES (nid, rid, rid, 1);
    EXCEPTION WHEN check_violation THEN rejected := true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:NOTE_PARENT_SELF_EDGE'; END IF;
END $$;

-- ============================================================================
-- NoteRevision trigger
-- ============================================================================
\echo '=== TEST 9: NOTE_REVISION_UPDATE_REJECTED ==='
DO $$
DECLARE nid uuid; rid uuid; v_msg text; rejected boolean := false;
BEGIN
    nid := '11111111-1111-1111-1111-111111111901';
    INSERT INTO core.notes (id, note_type) VALUES (nid, 'GENERAL');
    INSERT INTO core.note_revisions (id, note_id, revision_no, title, content_format, content, content_sha256)
        VALUES ('11111111-1111-1111-1111-111111111911', nid, 1, 't', 'PLAIN_TEXT', 'c', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    rid := '11111111-1111-1111-1111-111111111911';
    BEGIN
        UPDATE core.note_revisions SET title = 'new' WHERE id = rid;
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%NOTE_REVISION_IMMUTABILITY%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:NOTE_REVISION_UPDATE'; END IF;
END $$;

\echo '=== TEST 10: NOTE_REVISION_DELETE_REJECTED ==='
DO $$
DECLARE nid uuid; rid uuid; v_msg text; rejected boolean := false;
BEGIN
    nid := '11111111-1111-1111-1111-111111111a01';
    INSERT INTO core.notes (id, note_type) VALUES (nid, 'GENERAL');
    INSERT INTO core.note_revisions (id, note_id, revision_no, title, content_format, content, content_sha256)
        VALUES ('11111111-1111-1111-1111-111111111a11', nid, 1, 't', 'PLAIN_TEXT', 'c', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    rid := '11111111-1111-1111-1111-111111111a11';
    BEGIN
        DELETE FROM core.note_revisions WHERE id = rid;
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%NOTE_REVISION_IMMUTABILITY%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:NOTE_REVISION_DELETE'; END IF;
END $$;

-- ============================================================================
-- Claim trigger
-- ============================================================================
\echo '=== TEST 11: CLAIM_IMMUTABLE_FIELD_UPDATE_REJECTED ==='
DO $$
DECLARE cid uuid; v_msg text; rejected boolean := false;
BEGIN
    INSERT INTO core.claims (id, claim_type, statement, lifecycle_state)
        VALUES ('11111111-1111-1111-1111-111111111b01', 'T', 'original statement', 'ACTIVE');
    cid := '11111111-1111-1111-1111-111111111b01';
    BEGIN
        UPDATE core.claims SET statement = 'changed statement' WHERE id = cid;
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%CLAIM_STATEMENT_IMMUTABLE%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:CLAIM_IMMUTABLE_UPDATE'; END IF;
END $$;

\echo '=== TEST 12: CLAIM_METADATA_UPDATE_ALLOWED ==='
DO $$
DECLARE cid uuid;
BEGIN
    INSERT INTO core.claims (id, claim_type, statement, lifecycle_state)
        VALUES ('11111111-1111-1111-1111-111111111b02', 'T', 'original', 'ACTIVE');
    cid := '11111111-1111-1111-1111-111111111b02';
    UPDATE core.claims SET metadata = '{"updated":true}'::jsonb, lifecycle_state = 'ARCHIVED' WHERE id = cid;
    IF NOT FOUND THEN RAISE EXCEPTION 'TEST_FAIL:CLAIM_METADATA_UPDATE_ALLOWED: row not updated'; END IF;
END $$;

-- ============================================================================
-- Assessment trigger
-- ============================================================================
\echo '=== TEST 13: ASSESSMENT_UPDATE_REJECTED ==='
DO $$
DECLARE cl uuid; v_msg text; rejected boolean := false;
BEGIN
    INSERT INTO core.claims (id, claim_type, statement, lifecycle_state)
        VALUES ('11111111-1111-1111-1111-111111111c01', 'T', 'orig', 'ACTIVE');
    cl := '11111111-1111-1111-1111-111111111c01';
    INSERT INTO core.assessments (id, claim_id, stance) VALUES ('11111111-1111-1111-1111-111111111c11', cl, 'SUPPORTS');
    BEGIN
        UPDATE core.assessments SET stance = 'CONTRADICTS' WHERE id = '11111111-1111-1111-1111-111111111c11';
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%ASSESSMENT_APPEND_ONLY%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:ASSESSMENT_UPDATE'; END IF;
END $$;

\echo '=== TEST 14: ASSESSMENT_DELETE_REJECTED ==='
DO $$
DECLARE cl uuid; v_msg text; rejected boolean := false;
BEGIN
    INSERT INTO core.claims (id, claim_type, statement, lifecycle_state)
        VALUES ('11111111-1111-1111-1111-111111111c02', 'T', 'orig', 'ACTIVE');
    cl := '11111111-1111-1111-1111-111111111c02';
    INSERT INTO core.assessments (id, claim_id, stance) VALUES ('11111111-1111-1111-1111-111111111c12', cl, 'SUPPORTS');
    BEGIN
        DELETE FROM core.assessments WHERE id = '11111111-1111-1111-1111-111111111c12';
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%ASSESSMENT_APPEND_ONLY%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:ASSESSMENT_DELETE'; END IF;
END $$;

-- ============================================================================
-- Manifest trigger
-- ============================================================================
\echo '=== TEST 15: MANIFEST_UPDATE_REJECTED ==='
DO $$
DECLARE mid uuid; v_msg text; rejected boolean := false;
BEGIN
    INSERT INTO core.evidence_manifests (id, schema_version, purpose, manifest_sha256)
        VALUES ('11111111-1111-1111-1111-111111111d01', 1, 'p', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    mid := '11111111-1111-1111-1111-111111111d01';
    BEGIN
        UPDATE core.evidence_manifests SET purpose = 'changed' WHERE id = mid;
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%MANIFEST_IMMUTABLE%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:MANIFEST_UPDATE'; END IF;
END $$;

\echo '=== TEST 16: MANIFEST_DELETE_REJECTED ==='
DO $$
DECLARE mid uuid; v_msg text; rejected boolean := false;
BEGIN
    INSERT INTO core.evidence_manifests (id, schema_version, purpose, manifest_sha256)
        VALUES ('11111111-1111-1111-1111-111111111d02', 1, 'p', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    mid := '11111111-1111-1111-1111-111111111d02';
    BEGIN
        DELETE FROM core.evidence_manifests WHERE id = mid;
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%MANIFEST_IMMUTABLE%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:MANIFEST_DELETE'; END IF;
END $$;

\echo '=== TEST 17: MANIFEST_ITEM_UPDATE_REJECTED ==='
DO $$
DECLARE mid uuid; v_msg text; rejected boolean := false;
BEGIN
    INSERT INTO core.evidence_manifests (id, schema_version, purpose, manifest_sha256)
        VALUES ('11111111-1111-1111-1111-111111111d03', 1, 'p', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    mid := '11111111-1111-1111-1111-111111111d03';
    INSERT INTO core.evidence_manifest_items (id, manifest_id, ordinal, role, target_type, target_id)
        VALUES ('11111111-1111-1111-1111-111111111d13', mid, 1, 'SUPPORTING', 'SOURCE', '11111111-1111-1111-1111-111111111dd1');
    BEGIN
        UPDATE core.evidence_manifest_items SET role = 'CONTRADICTORY' WHERE manifest_id = mid;
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%MANIFEST_IMMUTABLE%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:MANIFEST_ITEM_UPDATE'; END IF;
END $$;

\echo '=== TEST 18: MANIFEST_ITEM_DELETE_REJECTED ==='
DO $$
DECLARE mid uuid; v_msg text; rejected boolean := false;
BEGIN
    INSERT INTO core.evidence_manifests (id, schema_version, purpose, manifest_sha256)
        VALUES ('11111111-1111-1111-1111-111111111d04', 1, 'p', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    mid := '11111111-1111-1111-1111-111111111d04';
    INSERT INTO core.evidence_manifest_items (id, manifest_id, ordinal, role, target_type, target_id)
        VALUES ('11111111-1111-1111-1111-111111111d14', mid, 1, 'SUPPORTING', 'SOURCE', '11111111-1111-1111-1111-111111111de1');
    BEGIN
        DELETE FROM core.evidence_manifest_items WHERE manifest_id = mid;
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%MANIFEST_IMMUTABLE%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:MANIFEST_ITEM_DELETE'; END IF;
END $$;

-- ============================================================================
-- ResearchIssue deferred FK
-- ============================================================================
\echo '=== TEST 19: ISSUE_CURRENT_RESOLUTION_OTHER_ISSUE_REJECTED ==='
DO $$
DECLARE iid1 uuid; iid2 uuid; ires uuid;
      caught_sqlstate text; caught_constraint text;
      rejected boolean := false;
BEGIN
    iid1 := '11111111-1111-1111-1111-111111111e01';
    iid2 := '11111111-1111-1111-1111-111111111e02';
    INSERT INTO core.research_issues (id, title, question) VALUES (iid1, 't1', 'q1');
    INSERT INTO core.research_issues (id, title, question) VALUES (iid2, 't2', 'q2');
    INSERT INTO core.issue_resolutions (id, issue_id, resolution_type, rationale) VALUES ('11111111-1111-1111-1111-111111111e11', iid1, 'NO_WORKING_CONCLUSION', 'r');
    ires := '11111111-1111-1111-1111-111111111e11';
    BEGIN
        UPDATE core.research_issues SET current_resolution_id = ires WHERE id = iid2;
        SET CONSTRAINTS core.fk_ri_current_resolution IMMEDIATE;
    EXCEPTION WHEN SQLSTATE '23503' THEN
        GET STACKED DIAGNOSTICS caught_sqlstate = RETURNED_SQLSTATE, caught_constraint = CONSTRAINT_NAME;
        IF caught_constraint IS DISTINCT FROM 'fk_ri_current_resolution' THEN
            RAISE EXCEPTION 'TEST_FAIL:CONSTRAINT_MISMATCH: expected fk_ri_current_resolution, got %', caught_constraint;
        END IF;
        rejected := true;
    END;
    SET CONSTRAINTS core.fk_ri_current_resolution DEFERRED;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:ISSUE_CURRENT_RESOLUTION_OTHER_ISSUE'; END IF;
END $$;

-- ============================================================================
-- ExternalIdentity
-- ============================================================================
\echo '=== TEST 20: DUP_ACTIVE_REJECTED ==='
DO $$
DECLARE sid uuid; rejected boolean := false;
BEGIN
    INSERT INTO core.sources (id, source_type, lifecycle_state) VALUES ('11111111-1111-1111-1111-111111111f01', 'PUBLICATION', 'ACTIVE');
    sid := '11111111-1111-1111-1111-111111111f01';
    INSERT INTO core.external_identities (id, target_type, target_id, provider, namespace, external_id, binding_state)
        VALUES ('11111111-1111-1111-1111-111111111f11', 'SOURCE', sid, 'p', 'n', 'dup_key_20', 'ACTIVE');
    BEGIN
        INSERT INTO core.external_identities (id, target_type, target_id, provider, namespace, external_id, binding_state)
            VALUES ('11111111-1111-1111-1111-111111111f12', 'SOURCE', sid, 'p', 'n', 'dup_key_20', 'ACTIVE');
    EXCEPTION WHEN unique_violation THEN rejected := true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:DUP_ACTIVE'; END IF;
END $$;

\echo '=== TEST 21: RETIRED_HISTORY_ALLOWED ==='
DO $$
DECLARE sid uuid; active_count int; retired_count int;
BEGIN
    INSERT INTO core.sources (id, source_type, lifecycle_state) VALUES ('11111111-1111-1111-1111-111111111f02', 'PUBLICATION', 'ACTIVE');
    sid := '11111111-1111-1111-1111-111111111f02';
    INSERT INTO core.external_identities (id, target_type, target_id, provider, namespace, external_id, binding_state)
        VALUES ('11111111-1111-1111-1111-111111111f21', 'SOURCE', sid, 'p', 'n', 'history_key_21', 'RETIRED');
    INSERT INTO core.external_identities (id, target_type, target_id, provider, namespace, external_id, binding_state)
        VALUES ('11111111-1111-1111-1111-111111111f22', 'SOURCE', sid, 'p', 'n', 'history_key_21', 'ACTIVE');
    SELECT count(*) INTO active_count FROM core.external_identities WHERE external_id = 'history_key_21' AND binding_state = 'ACTIVE';
    SELECT count(*) INTO retired_count FROM core.external_identities WHERE external_id = 'history_key_21' AND binding_state = 'RETIRED';
    IF active_count <> 1 THEN RAISE EXCEPTION 'TEST_FAIL:RETIRED_HISTORY_ALLOWED: expected 1 ACTIVE, got %', active_count; END IF;
    IF retired_count <> 1 THEN RAISE EXCEPTION 'TEST_FAIL:RETIRED_HISTORY_ALLOWED: expected 1 RETIRED, got %', retired_count; END IF;
END $$;

-- ============================================================================
-- Idempotency
-- ============================================================================
\echo '=== TEST 22: DUP_SCOPE_KEY_REJECTED ==='
DO $$ DECLARE rejected boolean := false; BEGIN
    INSERT INTO ops.idempotency_keys (id, scope, idempotency_key, request_hash, status)
        VALUES ('11111111-1111-1111-1111-111111112201', 's', 'k22', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'IN_PROGRESS');
    BEGIN
        INSERT INTO ops.idempotency_keys (id, scope, idempotency_key, request_hash, status)
            VALUES ('11111111-1111-1111-1111-111111112202', 's', 'k22', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'IN_PROGRESS');
    EXCEPTION WHEN unique_violation THEN rejected := true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:DUP_SCOPE_KEY'; END IF;
END $$;

\echo '=== TEST 23: INVALID_REQUEST_HASH_REJECTED ==='
DO $$ DECLARE rejected boolean := false; BEGIN
    BEGIN
        INSERT INTO ops.idempotency_keys (id, scope, idempotency_key, request_hash, status)
            VALUES ('11111111-1111-1111-1111-111111112301', 's', 'k23', 'NOT_VALID_HEX', 'IN_PROGRESS');
    EXCEPTION WHEN check_violation THEN rejected := true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:INVALID_REQUEST_HASH'; END IF;
END $$;

-- ============================================================================
-- Projection
-- ============================================================================
\echo '=== TEST 24: TWO_ACTIVE_SAME_NAME_REJECTED ==='
DO $$
DECLARE inserted int;
      caught_sqlstate text; caught_constraint text;
      rejected boolean := false;
BEGIN
    -- First row: legal ACTIVE with full lifecycle timestamps; must succeed
    INSERT INTO ops.projection_generations (id, projection_name, status, build_started_at, ready_at, activated_at)
        VALUES ('11111111-1111-1111-1111-111111112401', 'proj_24', 'ACTIVE', now(), now(), now());
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted <> 1 THEN
        RAISE EXCEPTION 'TEST_FAIL:POSITIVE_CONTROL: legal ACTIVE insert did not affect 1 row (got %)', inserted;
    END IF;
    -- Second row: same projection_name + ACTIVE, full timestamps; must FAIL with uq_projection_one_active (SQLSTATE 23505)
    BEGIN
        INSERT INTO ops.projection_generations (id, projection_name, status, build_started_at, ready_at, activated_at)
            VALUES ('11111111-1111-1111-1111-111111112402', 'proj_24', 'ACTIVE', now(), now(), now());
    EXCEPTION WHEN SQLSTATE '23505' THEN
        GET STACKED DIAGNOSTICS caught_sqlstate = RETURNED_SQLSTATE, caught_constraint = CONSTRAINT_NAME;
        IF caught_constraint IS DISTINCT FROM 'uq_projection_one_active' THEN
            RAISE EXCEPTION 'TEST_FAIL:CONSTRAINT_MISMATCH: expected uq_projection_one_active, got %', caught_constraint;
        END IF;
        rejected := true;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:TWO_ACTIVE_SAME_NAME'; END IF;
END $$;

-- ============================================================================
-- Outbox
-- ============================================================================
\echo '=== TEST 25: NEGATIVE_ATTEMPT_REJECTED ==='
DO $$ DECLARE rejected boolean := false; BEGIN
    BEGIN
        INSERT INTO ops.outbox_events (id, event_type, payload, attempt_count) VALUES ('11111111-1111-1111-1111-111111112501', 't', '{}'::jsonb, -1);
    EXCEPTION WHEN check_violation THEN rejected := true; END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:NEGATIVE_ATTEMPT'; END IF;
END $$;

-- ============================================================================
-- ResearchRun terminal immutability
-- ============================================================================
\echo '=== TEST 26: TERMINAL_RUN_UPDATE_REJECTED ==='
DO $$
DECLARE rid uuid; v_msg text; rejected boolean := false;
BEGIN
    INSERT INTO core.evidence_manifests (id, schema_version, purpose, manifest_sha256)
        VALUES ('11111111-1111-1111-1111-111111112601', 1, 'p', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    INSERT INTO core.research_runs (id, evidence_manifest_id, status, completed_at) VALUES ('11111111-1111-1111-1111-111111112611', '11111111-1111-1111-1111-111111112601', 'SUCCEEDED', now());
    rid := '11111111-1111-1111-1111-111111112611';
    BEGIN
        UPDATE core.research_runs SET output = '{"changed":true}'::jsonb WHERE id = rid;
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%TERMINAL_RUN_IMMUTABILITY%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:TERMINAL_RUN_UPDATE'; END IF;
END $$;

\echo '=== TEST 27: TERMINAL_RUN_DELETE_REJECTED ==='
DO $$
DECLARE rid uuid; v_msg text; rejected boolean := false;
BEGIN
    INSERT INTO core.evidence_manifests (id, schema_version, purpose, manifest_sha256)
        VALUES ('11111111-1111-1111-1111-111111112701', 1, 'p', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    INSERT INTO core.research_runs (id, evidence_manifest_id, status, completed_at) VALUES ('11111111-1111-1111-1111-111111112711', '11111111-1111-1111-1111-111111112701', 'SUCCEEDED', now());
    rid := '11111111-1111-1111-1111-111111112711';
    BEGIN
        DELETE FROM core.research_runs WHERE id = rid;
    EXCEPTION WHEN SQLSTATE '23001' THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        IF v_msg LIKE '%TERMINAL_RUN_IMMUTABILITY%' THEN rejected := true; ELSE RAISE; END IF;
    END;
    IF NOT rejected THEN RAISE EXCEPTION 'EXPECTED_REJECTION_MISSING:TERMINAL_RUN_DELETE'; END IF;
END $$;

\echo '=== TEST 28: RUNNING_RUN_ALLOWED_FIELD_UPDATE_ACCEPTED ==='
DO $$
DECLARE rid uuid; updated int;
BEGIN
    INSERT INTO core.evidence_manifests (id, schema_version, purpose, manifest_sha256)
        VALUES ('11111111-1111-1111-1111-111111112801', 1, 'p', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    INSERT INTO core.research_runs (id, evidence_manifest_id, status)
        VALUES ('11111111-1111-1111-1111-111111112811', '11111111-1111-1111-1111-111111112801', 'RUNNING');
    rid := '11111111-1111-1111-1111-111111112811';
    UPDATE core.research_runs SET status = 'SUCCEEDED', completed_at = now(), output = '{"ok":true}'::jsonb, environment = '{"k":"v"}'::jsonb WHERE id = rid;
    GET DIAGNOSTICS updated = ROW_COUNT;
    IF updated <> 1 THEN RAISE EXCEPTION 'TEST_FAIL:RUNNING_RUN_ALLOWED_UPDATE: row not updated'; END IF;
END $$;
