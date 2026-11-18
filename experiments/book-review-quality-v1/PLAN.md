# Review quality P2 — design and implementation plan

Goal: inspect the shipped PR85 candidate guard with multiple public book-review cases; do not change the guard, merge or deploy.
Architecture: offline JSON cases, direct imports of the real clue extractor and guard, a small deterministic evaluator; source-page observations, historical search captures, and constructed stress cases are reported separately.
Tech stack: existing TypeScript, tsx, Vitest. No new dependency, provider call, or production access.
Approaches: (1) loosen the gate immediately; rejected because no quality baseline exists. (2) retry live search for many books; deferred because selection/retrieval variance obscures gate errors. (3) frozen open-source casebook plus synthetic controls; chosen for this iteration.
Labels: assistant-assessed provisional annotations, NOT human gold labels. Work-level review relevance and edition correspondence are separate. Unknown labels excluded from precision/recall. Purposeful diagnostic sample, not a population estimate or holdout.

Tasks:
1. Assemble short verbatim title/evidence inputs and exact source URLs, with dates, label reasons and source kind. Never call edited text a real search-provider snapshot.
2. Test confusion metrics (including undefined precision, unknown labels, and separate synthetic scores) before implementing evaluator. Import current application gate, do not duplicate it.
3. Reproduce suspected strict-response clipboard failure using an explicit scope; if confirmed, make a minimal client-only fix and test selected/insufficient/unselected output plus invalid scope. Preserve request/response scope matching.
4. Run offline report and relevant tests; attempt root suite once, record any failures without greenwashing or repeated reruns. Commit/push draft PR; update existing Notion current/project pages. No merge or deployment.

Review focus: a rejected candidate is not proof no reviews exist; no predicted positives means precision=null, not 100%; English reviews; subtitle/author-role mismatches; an ISBN plus review-looking title can still be a catalog. New webpage snippets are purpose-built short excerpts, not live-provider output. Exact edition status cannot be inferred from work-level similarity.
