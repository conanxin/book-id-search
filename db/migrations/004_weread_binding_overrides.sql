-- Owner-managed WeRead relationships override the read-only imported matches.
-- Unbind is an explicit tombstone. Restore keeps the row/revision and changes
-- mode to inherit, so stale clients cannot overwrite a later decision.
BEGIN;

CREATE TABLE core.weread_binding_overrides (
    weread_book_id text PRIMARY KEY,
    mode text NOT NULL,
    catalog_id text NULL,
    revision bigint NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_weread_binding_source CHECK (char_length(btrim(weread_book_id)) BETWEEN 1 AND 500),
    CONSTRAINT ck_weread_binding_mode CHECK (mode IN ('bind', 'unbind', 'inherit')),
    CONSTRAINT ck_weread_binding_target CHECK (
        (mode = 'bind' AND catalog_id IS NOT NULL AND char_length(catalog_id) <= 128
            AND catalog_id ~ '^[0-9]+_[0-9]{12}$')
        OR (mode IN ('unbind', 'inherit') AND catalog_id IS NULL)
    ),
    CONSTRAINT ck_weread_binding_revision CHECK (revision BETWEEN 1 AND 9007199254740991)
);
CREATE INDEX ix_weread_binding_catalog ON core.weread_binding_overrides (catalog_id) WHERE mode = 'bind';

-- Reuse the existing runtime roles and PostgreSQL volume. Imported snapshot
-- directories remain read-only; these grants do not add schema privileges.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's32_app') THEN
        GRANT SELECT, INSERT, UPDATE ON core.weread_binding_overrides TO s32_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's32_readonly') THEN
        GRANT SELECT ON core.weread_binding_overrides TO s32_readonly;
    END IF;
END;
$$;

COMMIT;
