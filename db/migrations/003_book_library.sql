-- Book-centered personal library. Existing research Notes, Projects and frozen
-- revisions keep their original ownership and semantics. Google owner access
-- is enforced by the /library API; this installation has one owner.
BEGIN;

CREATE TABLE core.library_books (
    catalog_book_id text PRIMARY KEY,
    edition_id uuid NOT NULL REFERENCES core.editions(id) ON DELETE RESTRICT,
    catalog_source_id uuid NOT NULL REFERENCES core.sources(id) ON DELETE RESTRICT,
    introduction text NOT NULL DEFAULT '',
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_library_book_id CHECK (char_length(catalog_book_id) BETWEEN 1 AND 500),
    CONSTRAINT ck_library_introduction CHECK (char_length(introduction) <= 50000),
    CONSTRAINT ck_library_version CHECK (version >= 1)
);
CREATE INDEX ix_library_books_updated ON core.library_books (updated_at DESC, catalog_book_id);

-- A book may have many independent Notes; each Note has exactly one book.
-- A deleted library Note is archived in core.notes so its immutable history
-- remains available to any existing references.
CREATE TABLE core.library_book_notes (
    note_id uuid PRIMARY KEY REFERENCES core.notes(id) ON DELETE RESTRICT,
    catalog_book_id text NOT NULL REFERENCES core.library_books(catalog_book_id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_library_book_notes_book ON core.library_book_notes (catalog_book_id);

-- URLs are stored in the canonical REMOTE SourceAsset. Resource presentation
-- fields belong to this registration and do not overwrite catalog metadata.
CREATE TABLE core.library_book_resources (
    resource_id uuid PRIMARY KEY REFERENCES core.source_assets(id) ON DELETE RESTRICT,
    catalog_book_id text NOT NULL REFERENCES core.library_books(catalog_book_id) ON DELETE RESTRICT,
    label text NOT NULL,
    format text NOT NULL DEFAULT '',
    version_label text NOT NULL DEFAULT '',
    notes text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz NULL,
    CONSTRAINT ck_library_resource_label CHECK (char_length(btrim(label)) BETWEEN 1 AND 200),
    CONSTRAINT ck_library_resource_format CHECK (char_length(format) <= 100),
    CONSTRAINT ck_library_resource_version CHECK (char_length(version_label) <= 200),
    CONSTRAINT ck_library_resource_notes CHECK (char_length(notes) <= 4000)
);
CREATE INDEX ix_library_book_resources_book ON core.library_book_resources (catalog_book_id) WHERE removed_at IS NULL;

-- The original role bootstrap grants only the tables present at bootstrap.
-- Grant these additions to already-existing runtime roles without recreating
-- roles, changing passwords or expanding their schema privileges.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's32_app') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON core.library_books, core.library_book_notes, core.library_book_resources TO s32_app;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 's32_readonly') THEN
        GRANT SELECT ON core.library_books, core.library_book_notes, core.library_book_resources TO s32_readonly;
    END IF;
END;
$$;

COMMIT;
