-- P29-D4 S32-M0 Migration (FROZEN from D1+D2+P29-C+R3)
BEGIN;
CREATE SCHEMA core;
CREATE SCHEMA ops;
CREATE SCHEMA derived;

-- ===== B1 (R2 = R3 preserved) =====
CREATE TABLE core.actors (
    id uuid NOT NULL,
    actor_type text NOT NULL,
    display_name text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_actors_actor_type CHECK (actor_type IN ('HUMAN','AI_SYSTEM','SYSTEM_PROCESS','EXTERNAL_PERSON','INSTITUTION','UNKNOWN'))
);
CREATE TABLE core.works (
    id uuid NOT NULL,
    work_type text NOT NULL,
    title text NOT NULL,
    title_status text NOT NULL DEFAULT 'UNKNOWN',
    subtitle text NULL,
    original_title text NULL,
    language text NULL,
    description text NULL,
    lifecycle_state text NOT NULL DEFAULT 'ACTIVE',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (id),
    CONSTRAINT ck_works_title_status CHECK (title_status IN ('KNOWN','WORKING','UNTITLED','UNKNOWN')),
    CONSTRAINT ck_works_lifecycle CHECK (lifecycle_state IN ('ACTIVE','ARCHIVED'))
);
CREATE TABLE core.editions (
    id uuid NOT NULL,
    work_id uuid NOT NULL,
    edition_type text NOT NULL,
    edition_statement text NULL,
    publisher text NULL,
    publication_place text NULL,
    publication_date date NULL,
    publication_date_precision text NOT NULL,
    language text NULL,
    isbn text NULL,
    lifecycle_state text NOT NULL DEFAULT 'ACTIVE',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (id),
    CONSTRAINT ck_editions_date_precision CHECK (publication_date_precision IN ('YEAR','MONTH','DAY')),
    CONSTRAINT ck_editions_lifecycle CHECK (lifecycle_state IN ('ACTIVE','ARCHIVED')),
    CONSTRAINT fk_editions_work FOREIGN KEY (work_id) REFERENCES core.works(id) ON DELETE RESTRICT
);

-- ===== B2 (R3 frozen) =====
CREATE TABLE core.sources (
    id uuid NOT NULL,
    source_type text NOT NULL,
    edition_id uuid NULL,
    observed_at timestamptz NOT NULL DEFAULT now(),
    lifecycle_state text NOT NULL DEFAULT 'ACTIVE',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_sources_type CHECK (source_type IN ('PUBLICATION','WEB_PAGE','ARCHIVAL_RECORD','DATABASE_RECORD','MUSEUM_OBJECT','EXHIBITION_LABEL','EMAIL','FIELD_OBSERVATION','INTERVIEW','OTHER')),
    CONSTRAINT ck_sources_lifecycle CHECK (lifecycle_state IN ('ACTIVE','ARCHIVED')),
    CONSTRAINT fk_sources_edition FOREIGN KEY (edition_id) REFERENCES core.editions(id) ON DELETE RESTRICT
);
CREATE TABLE core.source_assets (
    id uuid NOT NULL,
    source_id uuid NOT NULL,
    asset_type text NOT NULL,
    asset_role text NOT NULL,
    storage_mode text NOT NULL,
    storage_key text NULL,
    remote_uri text NULL,
    sha256 text NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_sa_asset_type CHECK (asset_type IN ('DOCUMENT','IMAGE','AUDIO','VIDEO','WEB_SNAPSHOT','TEXT','DATA','OTHER')),
    CONSTRAINT ck_sa_asset_role CHECK (asset_role IN ('ORIGINAL','DERIVED')),
    CONSTRAINT ck_sa_storage_mode CHECK (storage_mode IN ('LOCAL','REMOTE','HYBRID')),
    CONSTRAINT ck_sa_sha256_format CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_sa_storage_local CHECK (storage_mode <> 'LOCAL' OR (storage_key IS NOT NULL AND sha256 IS NOT NULL AND remote_uri IS NULL)),
    CONSTRAINT ck_sa_storage_remote CHECK (storage_mode <> 'REMOTE' OR (remote_uri IS NOT NULL AND storage_key IS NULL)),
    CONSTRAINT ck_sa_storage_hybrid CHECK (storage_mode <> 'HYBRID' OR (storage_key IS NOT NULL AND remote_uri IS NOT NULL AND sha256 IS NOT NULL)),
    CONSTRAINT fk_sa_source FOREIGN KEY (source_id) REFERENCES core.sources(id) ON DELETE RESTRICT
);
CREATE TABLE core.source_asset_parents (
    child_asset_id uuid NOT NULL,
    parent_asset_id uuid NOT NULL,
    relation_type text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (child_asset_id, parent_asset_id, relation_type),
    CONSTRAINT ck_sap_relation CHECK (relation_type IN ('DERIVED_FROM','TRANSCRIBED_FROM','OCR_FROM','CROPPED_FROM','EXTRACTED_FROM','CONVERTED_FROM','COMPOSED_FROM')),
    CONSTRAINT ck_sap_no_self CHECK (child_asset_id <> parent_asset_id),
    CONSTRAINT fk_sap_child FOREIGN KEY (child_asset_id) REFERENCES core.source_assets(id) ON DELETE RESTRICT,
    CONSTRAINT fk_sap_parent FOREIGN KEY (parent_asset_id) REFERENCES core.source_assets(id) ON DELETE RESTRICT
);
CREATE TABLE core.external_identities (
    id uuid NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    provider text NOT NULL,
    namespace text NOT NULL,
    external_id text NOT NULL,
    external_uri text NULL,
    binding_state text NOT NULL DEFAULT 'ACTIVE',
    observed_at timestamptz NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (id),
    CONSTRAINT ck_ei_target_type CHECK (target_type IN ('WORK','EDITION','SOURCE','SOURCE_ASSET','NOTE','PROJECT','ACTOR')),
    CONSTRAINT ck_ei_binding_state CHECK (binding_state IN ('ACTIVE','UNAVAILABLE','RETIRED'))
);

-- ===== B3 (R3 frozen) =====
CREATE TABLE core.notes (
    id uuid NOT NULL,
    note_type text NOT NULL,
    lifecycle_state text NOT NULL DEFAULT 'ACTIVE',
    current_revision_id uuid NULL,
    next_revision_no bigint NOT NULL DEFAULT 1,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_notes_lifecycle CHECK (lifecycle_state IN ('ACTIVE','ARCHIVED'))
);
CREATE TABLE core.note_revisions (
    id uuid NOT NULL,
    note_id uuid NOT NULL,
    revision_no bigint NOT NULL,
    title text NULL,
    content_format text NOT NULL,
    content text NOT NULL,
    content_sha256 text NOT NULL,
    change_summary text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT uq_nr_note_id_id UNIQUE (note_id, id),
    CONSTRAINT uq_nr_note_id_revno UNIQUE (note_id, revision_no),
    CONSTRAINT ck_nr_content_format CHECK (content_format IN ('MARKDOWN','PLAIN_TEXT')),
    CONSTRAINT ck_nr_sha256_format CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT fk_nr_note FOREIGN KEY (note_id) REFERENCES core.notes(id) ON DELETE RESTRICT
);
CREATE TABLE core.note_revision_parents (
    note_id uuid NOT NULL,
    child_revision_id uuid NOT NULL,
    parent_revision_id uuid NOT NULL,
    parent_order integer NOT NULL DEFAULT 1,
    PRIMARY KEY (note_id, child_revision_id, parent_revision_id),
    CONSTRAINT ck_nrp_order_positive CHECK (parent_order > 0),
    CONSTRAINT ck_nrp_no_self CHECK (child_revision_id <> parent_revision_id),
    CONSTRAINT fk_nrp_child_same_note FOREIGN KEY (note_id, child_revision_id) REFERENCES core.note_revisions(note_id, id) ON DELETE RESTRICT,
    CONSTRAINT fk_nrp_parent_same_note FOREIGN KEY (note_id, parent_revision_id) REFERENCES core.note_revisions(note_id, id) ON DELETE RESTRICT
);

-- ===== B4 (R3 frozen) =====
CREATE TABLE core.claims (
    id uuid NOT NULL,
    claim_type text NULL,
    statement text NOT NULL,
    subject_type text NULL,
    subject_id uuid NULL,
    lifecycle_state text NOT NULL DEFAULT 'ACTIVE',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_cl_subject_type CHECK (subject_type IS NULL OR subject_type IN ('WORK','EDITION','SOURCE','SOURCE_ASSET','NOTE','ACTOR')),
    CONSTRAINT ck_cl_lifecycle CHECK (lifecycle_state IN ('ACTIVE','ARCHIVED')),
    CONSTRAINT ck_cl_subject_paired CHECK ((subject_type IS NULL AND subject_id IS NULL) OR (subject_type IS NOT NULL AND subject_id IS NOT NULL))
);
CREATE TABLE core.claim_relations (
    id uuid NOT NULL,
    source_claim_id uuid NOT NULL,
    target_claim_id uuid NOT NULL,
    relation_type text NOT NULL,
    reasoning text NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT uq_cr_triple UNIQUE (source_claim_id, target_claim_id, relation_type),
    CONSTRAINT ck_cr_no_self CHECK (source_claim_id <> target_claim_id),
    CONSTRAINT fk_cr_source FOREIGN KEY (source_claim_id) REFERENCES core.claims(id) ON DELETE RESTRICT,
    CONSTRAINT fk_cr_target FOREIGN KEY (target_claim_id) REFERENCES core.claims(id) ON DELETE RESTRICT
);
CREATE TABLE core.evidence_manifests (
    id uuid NOT NULL,
    schema_version integer NOT NULL DEFAULT 1,
    purpose text NOT NULL,
    manifest_sha256 text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_em_schema_version CHECK (schema_version > 0),
    CONSTRAINT ck_em_sha256_format CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$')
);
CREATE TABLE core.evidence_manifest_items (
    id uuid NOT NULL,
    manifest_id uuid NOT NULL,
    ordinal integer NOT NULL,
    role text NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    locator_type text NULL,
    locator jsonb NULL,
    excerpt text NULL,
    note text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT uq_emi_manifest_ordinal UNIQUE (manifest_id, ordinal),
    CONSTRAINT ck_emi_ordinal_positive CHECK (ordinal > 0),
    CONSTRAINT ck_emi_role CHECK (role IN ('SUPPORTING','CONTRADICTORY','CONTEXTUAL')),
    CONSTRAINT ck_emi_target_type CHECK (target_type IN ('SOURCE','SOURCE_ASSET','NOTE_REVISION')),
    CONSTRAINT ck_emi_locator_paired CHECK ((locator_type IS NULL AND locator IS NULL) OR (locator_type IS NOT NULL AND locator IS NOT NULL)),
    CONSTRAINT ck_emi_excerpt_nonblank CHECK (excerpt IS NULL OR length(excerpt) > 0),
    CONSTRAINT ck_emi_note_nonblank CHECK (note IS NULL OR length(note) > 0),
    CONSTRAINT fk_emi_manifest FOREIGN KEY (manifest_id) REFERENCES core.evidence_manifests(id) ON DELETE RESTRICT
);
CREATE TABLE core.research_issues (
    id uuid NOT NULL,
    title text NOT NULL,
    question text NOT NULL,
    lifecycle_state text NOT NULL DEFAULT 'OPEN',
    current_resolution_id uuid NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_ri_lifecycle CHECK (lifecycle_state IN ('OPEN','RESOLVED','ARCHIVED'))
);
CREATE TABLE core.research_issue_claims (
    issue_id uuid NOT NULL,
    claim_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (issue_id, claim_id),
    CONSTRAINT fk_ric_issue FOREIGN KEY (issue_id) REFERENCES core.research_issues(id) ON DELETE RESTRICT,
    CONSTRAINT fk_ric_claim FOREIGN KEY (claim_id) REFERENCES core.claims(id) ON DELETE RESTRICT
);
CREATE TABLE core.research_runs (
    id uuid NOT NULL,
    schema_version integer NOT NULL DEFAULT 1,
    issue_id uuid NULL,
    evidence_manifest_id uuid NOT NULL,
    status text NOT NULL DEFAULT 'RUNNING',
    procedure jsonb NOT NULL DEFAULT '{}'::jsonb,
    execution_contract jsonb NOT NULL DEFAULT '{}'::jsonb,
    environment jsonb NOT NULL DEFAULT '{}'::jsonb,
    output jsonb NULL,
    knowledge_cutoff timestamptz NULL,
    replay_of uuid NULL,
    started_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_rr_schema_version CHECK (schema_version > 0),
    CONSTRAINT ck_rr_status CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
    CONSTRAINT ck_rr_no_self_replay CHECK (replay_of IS NULL OR replay_of <> id),
    CONSTRAINT ck_rr_terminal CHECK ((status = 'RUNNING' AND completed_at IS NULL) OR (status IN ('SUCCEEDED','FAILED','CANCELLED') AND completed_at IS NOT NULL)),
    CONSTRAINT fk_rr_issue FOREIGN KEY (issue_id) REFERENCES core.research_issues(id) ON DELETE RESTRICT,
    CONSTRAINT fk_rr_manifest FOREIGN KEY (evidence_manifest_id) REFERENCES core.evidence_manifests(id) ON DELETE RESTRICT,
    CONSTRAINT fk_rr_replay FOREIGN KEY (replay_of) REFERENCES core.research_runs(id) ON DELETE RESTRICT
);
CREATE TABLE core.assessments (
    id uuid NOT NULL,
    claim_id uuid NOT NULL,
    actor_id uuid NULL,
    stance text NOT NULL,
    confidence_level text NULL,
    numeric_score double precision NULL,
    score_kind text NULL,
    evidence_manifest_id uuid NULL,
    reasoning text NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_as_stance CHECK (stance IN ('SUPPORTS','CONTRADICTS','INCONCLUSIVE')),
    CONSTRAINT ck_as_confidence CHECK (confidence_level IS NULL OR confidence_level IN ('LOW','MEDIUM','HIGH')),
    CONSTRAINT ck_as_score_paired CHECK ((numeric_score IS NULL AND score_kind IS NULL) OR (numeric_score IS NOT NULL AND score_kind IS NOT NULL)),
    CONSTRAINT ck_as_score_range CHECK (numeric_score IS NULL OR (numeric_score >= 0 AND numeric_score <= 1)),
    CONSTRAINT fk_as_claim FOREIGN KEY (claim_id) REFERENCES core.claims(id) ON DELETE RESTRICT,
    CONSTRAINT fk_as_actor FOREIGN KEY (actor_id) REFERENCES core.actors(id) ON DELETE RESTRICT,
    CONSTRAINT fk_as_manifest FOREIGN KEY (evidence_manifest_id) REFERENCES core.evidence_manifests(id) ON DELETE RESTRICT
);
CREATE TABLE core.issue_resolutions (
    id uuid NOT NULL,
    issue_id uuid NOT NULL,
    resolution_type text NOT NULL,
    preferred_claim_id uuid NULL,
    rationale text NULL,
    evidence_manifest_id uuid NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT uq_ir_issue_id_id UNIQUE (issue_id, id),
    CONSTRAINT ck_ir_type CHECK (resolution_type IN ('PREFERRED_CLAIM','INSUFFICIENT_EVIDENCE','NO_WORKING_CONCLUSION')),
    CONSTRAINT ck_ir_preferred CHECK ((resolution_type = 'PREFERRED_CLAIM' AND preferred_claim_id IS NOT NULL) OR (resolution_type <> 'PREFERRED_CLAIM' AND preferred_claim_id IS NULL)),
    CONSTRAINT fk_ir_issue FOREIGN KEY (issue_id) REFERENCES core.research_issues(id) ON DELETE RESTRICT,
    CONSTRAINT fk_ir_preferred_claim FOREIGN KEY (preferred_claim_id) REFERENCES core.claims(id) ON DELETE RESTRICT,
    CONSTRAINT fk_ir_manifest FOREIGN KEY (evidence_manifest_id) REFERENCES core.evidence_manifests(id) ON DELETE RESTRICT
);

-- ===== B5 (R3 frozen) =====
CREATE TABLE core.projects (
    id uuid NOT NULL,
    name text NOT NULL,
    lifecycle_state text NOT NULL DEFAULT 'ACTIVE',
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_pr_lifecycle CHECK (lifecycle_state IN ('ACTIVE','ARCHIVED'))
);
CREATE TABLE core.project_bindings (
    id uuid NOT NULL,
    project_id uuid NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    binding_role text NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT uq_pb_triple UNIQUE (project_id, target_type, target_id),
    CONSTRAINT ck_pb_target_type CHECK (target_type IN ('WORK','EDITION','SOURCE','SOURCE_ASSET','NOTE','CLAIM','RESEARCH_ISSUE')),
    CONSTRAINT fk_pb_project FOREIGN KEY (project_id) REFERENCES core.projects(id) ON DELETE RESTRICT
);
CREATE TABLE core.contributions (
    id uuid NOT NULL,
    actor_id uuid NOT NULL,
    target_type text NOT NULL,
    target_id uuid NOT NULL,
    contribution_type text NOT NULL,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_ct_target_type CHECK (target_type IN ('WORK','EDITION','SOURCE','SOURCE_ASSET','NOTE','NOTE_REVISION','CLAIM','ASSESSMENT','RESEARCH_ISSUE','RESEARCH_RUN','PROJECT')),
    CONSTRAINT ck_ct_type_nonblank CHECK (length(contribution_type) > 0),
    CONSTRAINT fk_ct_actor FOREIGN KEY (actor_id) REFERENCES core.actors(id) ON DELETE RESTRICT
);

-- ===== OPS (D3 = R3 preserved) =====
CREATE TABLE ops.outbox_events (
    id uuid NOT NULL,
    event_type text NOT NULL,
    subject_type text NULL,
    subject_id uuid NULL,
    payload jsonb NOT NULL,
    available_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz NULL,
    attempt_count integer NOT NULL DEFAULT 0,
    last_error text NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_oe_payload_object CHECK (jsonb_typeof(payload) = 'object'),
    CONSTRAINT ck_oe_event_type_nonempty CHECK (length(event_type) > 0),
    CONSTRAINT ck_oe_attempt_nonneg CHECK (attempt_count >= 0),
    CONSTRAINT ck_oe_available_after_created CHECK (available_at >= created_at),
    CONSTRAINT ck_oe_published_after_available CHECK (published_at IS NULL OR published_at >= available_at)
);
CREATE TABLE ops.idempotency_keys (
    id uuid NOT NULL,
    scope text NOT NULL,
    idempotency_key text NOT NULL,
    request_hash char(64) NOT NULL,
    status text NOT NULL DEFAULT 'IN_PROGRESS',
    resource_type text NULL,
    resource_id uuid NULL,
    result_payload jsonb NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz NULL,
    expires_at timestamptz NULL,
    PRIMARY KEY (id),
    CONSTRAINT uq_ik_scope_key UNIQUE (scope, idempotency_key),
    CONSTRAINT ck_ik_request_hash CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_ik_status CHECK (status IN ('IN_PROGRESS','COMPLETED','FAILED')),
    CONSTRAINT ck_ik_completed_at CHECK ((status = 'IN_PROGRESS' AND completed_at IS NULL) OR (status IN ('COMPLETED','FAILED') AND completed_at IS NOT NULL))
);
CREATE TABLE ops.integrity_check_runs (
    id uuid NOT NULL,
    check_name text NOT NULL,
    scope_type text NULL,
    scope_id uuid NULL,
    status text NOT NULL,
    started_at timestamptz NOT NULL,
    completed_at timestamptz NULL,
    code_version text NOT NULL,
    details jsonb NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_icr_status CHECK (status IN ('PASS','WARN','FAIL','ERROR')),
    CONSTRAINT ck_icr_completed CHECK ((status IN ('PASS','WARN','FAIL') AND completed_at IS NOT NULL) OR (status = 'ERROR' AND completed_at IS NULL)),
    CONSTRAINT ck_icr_code_version CHECK (length(code_version) > 0),
    CONSTRAINT ck_icr_details_irregular CHECK (details IS NULL OR jsonb_typeof(details) IN ('object','array'))
);
CREATE TABLE ops.projection_generations (
    id uuid NOT NULL,
    projection_name text NOT NULL,
    status text NOT NULL,
    source_watermark jsonb NULL,
    build_started_at timestamptz NULL,
    ready_at timestamptz NULL,
    activated_at timestamptz NULL,
    retired_at timestamptz NULL,
    failed_at timestamptz NULL,
    metadata jsonb NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id),
    CONSTRAINT ck_pg_status CHECK (status IN ('BUILDING','READY','ACTIVE','RETIRED','FAILED')),
    CONSTRAINT ck_pg_lifecycle_timestamps CHECK (
        (status='BUILDING' AND build_started_at IS NOT NULL AND ready_at IS NULL AND activated_at IS NULL AND retired_at IS NULL AND failed_at IS NULL)
        OR (status='READY'    AND build_started_at IS NOT NULL AND ready_at IS NOT NULL AND activated_at IS NULL AND retired_at IS NULL AND failed_at IS NULL)
        OR (status='ACTIVE'   AND build_started_at IS NOT NULL AND ready_at IS NOT NULL AND activated_at IS NOT NULL AND retired_at IS NULL AND failed_at IS NULL)
        OR (status='RETIRED'  AND build_started_at IS NOT NULL AND ready_at IS NOT NULL AND activated_at IS NOT NULL AND retired_at IS NOT NULL AND failed_at IS NULL)
        OR (status='FAILED'   AND build_started_at IS NOT NULL AND ready_at IS NULL AND activated_at IS NULL AND retired_at IS NULL AND failed_at IS NOT NULL)
    ),
    CONSTRAINT ck_pg_metadata_irregular CHECK (metadata IS NULL OR jsonb_typeof(metadata) IN ('object','array')),
    CONSTRAINT ck_pg_watermark_irregular CHECK (source_watermark IS NULL OR jsonb_typeof(source_watermark) = 'object')
);

-- ===== D2 frozen indexes =====
CREATE INDEX ix_editions_isbn ON core.editions (isbn);
CREATE INDEX ix_source_assets_sha256 ON core.source_assets (sha256);
CREATE UNIQUE INDEX uq_external_identities_active_binding ON core.external_identities (provider, namespace, external_id) WHERE binding_state <> 'RETIRED';
CREATE INDEX ix_claim_relations_target_claim_id ON core.claim_relations (target_claim_id);
CREATE INDEX ix_assessments_claim_time ON core.assessments (claim_id, created_at DESC);
CREATE INDEX ix_research_issue_claims_claim_id ON core.research_issue_claims (claim_id);
CREATE INDEX ix_issue_resolutions_issue_time ON core.issue_resolutions (issue_id, created_at DESC);
CREATE INDEX ix_research_runs_issue_time ON core.research_runs (issue_id, created_at DESC) WHERE issue_id IS NOT NULL;
CREATE INDEX ix_evidence_manifests_sha256 ON core.evidence_manifests (manifest_sha256);
CREATE INDEX ix_outbox_unpublished_dequeue ON ops.outbox_events (available_at, created_at) WHERE published_at IS NULL;
CREATE UNIQUE INDEX uq_projection_one_active ON ops.projection_generations (projection_name) WHERE status = 'ACTIVE';
CREATE INDEX ix_integrity_recent_by_check ON ops.integrity_check_runs (check_name, started_at DESC);
CREATE INDEX ix_integrity_recent_by_status ON ops.integrity_check_runs (status, started_at DESC);

-- ===== Post-create composite circular FKs (deferred) =====
ALTER TABLE core.notes ADD CONSTRAINT fk_notes_current_revision FOREIGN KEY (id, current_revision_id) REFERENCES core.note_revisions (note_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE core.research_issues ADD CONSTRAINT fk_ri_current_resolution FOREIGN KEY (id, current_resolution_id) REFERENCES core.issue_resolutions (issue_id, id) ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

-- ===== 5 frozen trigger contracts =====
-- 1. NOTE_REVISION_IMMUTABILITY
CREATE OR REPLACE FUNCTION core.fn_note_revisions_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'NOTE_REVISION_IMMUTABILITY: note_revisions rows are immutable (op=%)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER trg_note_revisions_no_update BEFORE UPDATE ON core.note_revisions FOR EACH ROW EXECUTE FUNCTION core.fn_note_revisions_immutable();
CREATE TRIGGER trg_note_revisions_no_delete BEFORE DELETE ON core.note_revisions FOR EACH ROW EXECUTE FUNCTION core.fn_note_revisions_immutable();

-- 2. CLAIM_STATEMENT_IMMUTABLE
CREATE OR REPLACE FUNCTION core.fn_claims_statement_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.claim_type IS DISTINCT FROM OLD.claim_type
       OR NEW.statement IS DISTINCT FROM OLD.statement
       OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
       OR NEW.subject_id IS DISTINCT FROM OLD.subject_id THEN
        RAISE EXCEPTION 'CLAIM_STATEMENT_IMMUTABLE: claim proposition identity fields cannot change (op=%)', TG_OP USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_claims_statement_no_update BEFORE UPDATE ON core.claims FOR EACH ROW EXECUTE FUNCTION core.fn_claims_statement_immutable();

-- 3. ASSESSMENT_APPEND_ONLY
CREATE OR REPLACE FUNCTION core.fn_assessments_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'ASSESSMENT_APPEND_ONLY: assessments are append-only (op=%)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER trg_assessments_no_update BEFORE UPDATE ON core.assessments FOR EACH ROW EXECUTE FUNCTION core.fn_assessments_append_only();
CREATE TRIGGER trg_assessments_no_delete BEFORE DELETE ON core.assessments FOR EACH ROW EXECUTE FUNCTION core.fn_assessments_append_only();

-- 4. MANIFEST_IMMUTABLE
CREATE OR REPLACE FUNCTION core.fn_evidence_manifests_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'MANIFEST_IMMUTABLE: evidence_manifests rows are immutable (op=%)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER trg_em_no_update BEFORE UPDATE ON core.evidence_manifests FOR EACH ROW EXECUTE FUNCTION core.fn_evidence_manifests_immutable();
CREATE TRIGGER trg_em_no_delete BEFORE DELETE ON core.evidence_manifests FOR EACH ROW EXECUTE FUNCTION core.fn_evidence_manifests_immutable();

CREATE OR REPLACE FUNCTION core.fn_evidence_manifest_items_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'MANIFEST_IMMUTABLE: evidence_manifest_items rows are immutable (op=%)', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER trg_emi_no_update BEFORE UPDATE ON core.evidence_manifest_items FOR EACH ROW EXECUTE FUNCTION core.fn_evidence_manifest_items_immutable();
CREATE TRIGGER trg_emi_no_delete BEFORE DELETE ON core.evidence_manifest_items FOR EACH ROW EXECUTE FUNCTION core.fn_evidence_manifest_items_immutable();

-- 5. TERMINAL_RUN_IMMUTABILITY
CREATE OR REPLACE FUNCTION core.fn_research_runs_terminal_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    violating_field text;
BEGIN
    IF OLD.status IN ('SUCCEEDED','FAILED','CANCELLED') THEN
        RAISE EXCEPTION 'TERMINAL_RUN_IMMUTABILITY: terminal research_runs row cannot be modified or deleted (op=%, status=%)', TG_OP, OLD.status USING ERRCODE = 'restrict_violation';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
           OR NEW.issue_id IS DISTINCT FROM OLD.issue_id
           OR NEW.evidence_manifest_id IS DISTINCT FROM OLD.evidence_manifest_id
           OR NEW.procedure IS DISTINCT FROM OLD.procedure
           OR NEW.execution_contract IS DISTINCT FROM OLD.execution_contract
           OR NEW.knowledge_cutoff IS DISTINCT FROM OLD.knowledge_cutoff
           OR NEW.replay_of IS DISTINCT FROM OLD.replay_of
           OR NEW.started_at IS DISTINCT FROM OLD.started_at
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION 'TERMINAL_RUN_IMMUTABILITY: while RUNNING, only status/completed_at/output/environment are mutable';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER trg_rr_terminal_immutable BEFORE UPDATE OR DELETE ON core.research_runs FOR EACH ROW EXECUTE FUNCTION core.fn_research_runs_terminal_immutable();

COMMIT;
