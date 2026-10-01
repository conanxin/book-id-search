# Preference Sovereignty Research Harness

This directory contains the experimental sidecar harness for PREF-EXP-1.

Current scope:
- synthetic-only validation;
- no production mutation;
- no S32 schema changes;
- no Meilisearch writes;
- no WeRead private-data reads;
- no LLM dependency;
- no online learning.

Validation gate:

```bash
pnpm test -- scripts/preference/harness.test.ts
pnpm build
```

The research branch remains draft-only until both commands have a real passing runtime receipt.
