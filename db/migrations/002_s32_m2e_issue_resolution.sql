BEGIN;

-- Keep the compatibility preflight and new constraints in one transaction.
-- Block concurrent Resolution/membership writes between preflight and DDL.
LOCK TABLE core.issue_resolutions, core.research_issue_claims IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM core.issue_resolutions r
    WHERE r.preferred_claim_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM core.research_issue_claims c
        WHERE c.issue_id = r.issue_id AND c.claim_id = r.preferred_claim_id
      )
  ) THEN
    RAISE EXCEPTION 'S32_M2E_LEGACY_PREFERRED_CLAIM_NOT_MEMBER';
  END IF;
END $$;

ALTER TABLE core.issue_resolutions
  ADD CONSTRAINT fk_ir_preferred_claim_same_issue
  FOREIGN KEY (issue_id, preferred_claim_id)
  REFERENCES core.research_issue_claims(issue_id, claim_id)
  ON DELETE RESTRICT;

CREATE FUNCTION core.fn_issue_resolutions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'S32_M2E_ISSUE_RESOLUTION_IMMUTABLE';
END $$;

CREATE TRIGGER trg_issue_resolutions_no_update
  BEFORE UPDATE ON core.issue_resolutions
  FOR EACH ROW EXECUTE FUNCTION core.fn_issue_resolutions_immutable();
CREATE TRIGGER trg_issue_resolutions_no_delete
  BEFORE DELETE ON core.issue_resolutions
  FOR EACH ROW EXECUTE FUNCTION core.fn_issue_resolutions_immutable();

COMMIT;
