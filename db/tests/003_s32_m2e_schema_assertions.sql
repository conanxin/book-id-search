-- Catalog proof complements the real write/rejection tests in 004.
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM pg_constraint c
  WHERE c.conrelid = 'core.issue_resolutions'::regclass
    AND c.conname = 'fk_ir_preferred_claim_same_issue'
    AND c.contype = 'f' AND c.convalidated AND c.confdeltype = 'r'
    AND c.confmatchtype = 's' AND NOT c.condeferrable
    AND pg_get_constraintdef(c.oid) = 'FOREIGN KEY (issue_id, preferred_claim_id) REFERENCES core.research_issue_claims(issue_id, claim_id) ON DELETE RESTRICT';
  IF n <> 1 THEN RAISE EXCEPTION 'S32_M2E_ASSERT_FAIL: preferred Claim composite FK'; END IF;

  SELECT count(*) INTO n FROM pg_trigger
  WHERE tgrelid = 'core.issue_resolutions'::regclass AND NOT tgisinternal
    AND tgenabled = 'O' AND tgfoid = 'core.fn_issue_resolutions_immutable()'::regprocedure
    AND ((tgname = 'trg_issue_resolutions_no_update' AND tgtype = 19)
      OR (tgname = 'trg_issue_resolutions_no_delete' AND tgtype = 11));
  IF n <> 2 THEN RAISE EXCEPTION 'S32_M2E_ASSERT_FAIL: UPDATE/DELETE row triggers'; END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'core' AND table_name = 'issue_resolutions'
      AND column_name = 'rationale' AND is_nullable = 'YES') THEN
    RAISE EXCEPTION 'S32_M2E_ASSERT_FAIL: legacy nullable rationale';
  END IF;
END $$;
\echo 'S32_M2E_SCHEMA_ASSERTIONS=PASS'
