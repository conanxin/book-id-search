# Book review evidence P4

**Task:** BOOK_REVIEW_EVIDENCE_P4. Development candidate, not merged or deployed.
Built on PR #87 (7138bc7c248365a6c00c435d060d12cc023b95c5), including the still-unmerged PR #86 parent.
The latest known release remains PR #85 / ce420a3. This phase made no production changes.

## Product result: ask about a named work when reading a webpage

The existing strict search question said "this book". The subsequent webpage evidence service receives the question and the extracted webpage, but it does not independently receive the catalog identity. A webpage discussing multiple works therefore lacked an explicit target in that follow-up question.

The Web now passes only the displayed public title, author and ISBN, captures them when a strict search is submitted, and fills the page-evidence editor with an explicit target. It offers three editable questions:

- **作品身份:** locate the original wording identifying the work and author, retaining qualifications and other work names.
- **评论内容:** locate passages evaluating that work's argument, materials, method or writing.
- **版本线索:** locate ISBN, publisher, translator, year or edition wording while retaining uncertainty and competing versions.

The target catalog block is labelled as the target for checking, not as webpage quotation. Clicking a preset only fills/focuses the editor and clears obsolete evidence, highlighting and clipboard fallback. It cancels any pending evidence request and ignores late completion. The existing explicit Find button still starts the model request. Returned passages, their source and read time can be located and copied through the existing interface.

Selected and unselected sources have the same access. General research and calls without a usable target title keep their prior behavior. Long public fields show explicit truncation, and questions stay within the existing 1,000-character limit. Private introductions, notes and unfinished editors remain separate.

This improves the manual verification entry point. It does not classify the read webpage, promote a source, verify an edition, automatically fetch a page, or add a model call on opening/selecting a question. Cross-source comparison still uses its existing question and is outside this change.

## Observation tooling

The existing scripts/book-web-research-live-trial.ts now accepts optional --scope direct_book_review and --read-first 0..3. General scope and no-page-reading remain the defaults. Both CLI and exported capture entry enforce the reading budget before IO.

Version-2 receipts separate:

1. the actual search client's parsed/deduplicated result, before application source limiting;
2. the exact public source snapshots sent to the selector;
3. the selector reply, including an invalid reply if one is returned;
4. the service's final sources and retained IDs;
5. each explicitly requested webpage read and its independent success/failure summary.

The first layer is **not raw HTTP**, and the existing client has already parsed, normalized and deduplicated it. The service still keeps at most 12 source snapshots, as before. Capturing these layers changes no application rule.

The read policy is a fixed prefix of returned application sources, regardless of the selector or guard outcome. Failure never substitutes a later result. Search/selection/page failure is retained without automatic retry. Transient read and snapshot bearer tokens are removed from receipts; provider error text is not recorded. Search status and page-reading status must be assessed separately.

Full public search and extracted-page receipts stay in ignored progress/review-evidence-p4/. Public reports retain metadata, URLs, hashes, diagnostic output and provisional labels, without republishing the full captured page text.

## Frozen task selection and actual catalog limitations

An independent helper proposed five new works from public publisher/library records before provider calls. Seventeen bounded public catalog requests all returned HTTP 200. These requests are discovery, not evidence that a missing title is absent from the entire database.

| Proposed work | Catalog decision before live search |
| --- | --- |
| 枢纽：3000年的中国 | Reference ISBN 9787549586080 matched; actual title uses spaces and author includes 著. |
| 祥瑞：王莽和他的时代 | Not located in the bounded title/ISBN/author checks; retained as a missing task. |
| The Great Divergence | Requested 2021 reference ISBN not located. Explicitly included the existing English catalog record with ISBN 0691090106 as an alternative record. |
| A Little History of the World | English original not located; available Chinese translations were not substituted. |
| Why Nations Fail | Requested 2013 reference ISBN not located. Explicitly included the existing English catalog record with ISBN 0307719219 as an alternative record. |

Both included English records have subtitle, author, publisher and year text concatenated into the author field; the structured year is null. Their exact existing fields were retained, not cleaned in the trial. They are not matches for the initially proposed reference editions.

The fixed three-task list, exact public fields, question, budgets and runtime hashes are in protocol.json, committed before the first provider request. The actual trial catalog fields matched those frozen fields for all three tasks.

## Actual provider outcomes

Capture/runtime commit: **d690f86650d2a488e9ec0932e85ec393a7db70e2**.
Native execution reused the application's existing MiniMax-M3 configuration through one read-only SSH configuration read; credentials stayed in process memory. An earlier read-only SSH check confirmed the expected host/user and application container. No remote filesystem, environment, container, database or deployment configuration was changed.

| Actual catalog task | Search-client snapshots | Application sources | Model-selected IDs | Guard-eligible IDs among all sources | Final recommended IDs | First-source read |
| --- | ---: | ---: | --- | --- | --- | --- |
| 枢纽 | 81 | 12 | W4, W10, W9, W6 | W11, W12 | none | Read succeeded |
| The Great Divergence | 69 | 12 | W4, W6, W9, W12 | none | none | BOOK_SOURCE_TIMEOUT |
| Why Nations Fail | 92 | 12 | W5, W3, W10, W11 | none | none | BOOK_SOURCE_UNAVAILABLE |

Exactly **3 search requests + 3 selector requests** occurred. Each search contained 10 completed web_search calls and returned the existing limited-search flag; no automatic continuation or retry occurred. The 242 client snapshots are the sum of within-request results, not a claim of 242 globally distinct webpages.

Each response preserved all 12 application sources even though the final state was insufficient_sources. The three fixed first-source reads produced one extracted-text response and two retained failures. No later URL replaced either failed read. A successful extraction is not proof of a complete article.

The observed all-empty recommendation outcome is a remaining limitation, **not a successful quality result**. P3 policy stayed byte-identical:

- The four model-selected Chinese sources had no frozen explicit review-genre cue; two also lacked the required title anchor in the headline. The two sources that did satisfy the guard were not chosen by the model.
- Both English catalog records have corrupted field boundaries, affecting literal author/title matching. Some selected snippets had explicit review wording, but no selected source passed all P3 conditions.
- An exact replay with the actual title/excerpt cut flags reproduced every final retained-ID list.

These observations identify different losses in the existing pipeline; they do not establish that the web has no reviews or that unselected/filtered sources are poor.

## Independent evidence annotations

The evaluator receives all 36 application source title/excerpt inputs without model or guard outcomes, freezes those provisional snippet labels, then separately receives only the three fixed first-source reader outcomes. It does not browse around reader failures or replace unavailable text.

Labels distinguish work identity, review-text support and literal edition wording. Uncertain evidence is not a negative. They are **assistant-provisional / human-review-pending**, not independent human gold labels. Model/guard outcomes are withheld for this annotation step; no claim is made that the evaluator has never encountered the broader P3 methodology.

The labels and input hashes are now frozen in snippet-labels-frozen.json and reader-labels-frozen.json; annotation-receipt.json binds both, and pipeline-results.json joins them to the actual outcomes.

| Task | Snippet yes / no / uncertain | Model-selected labels | Guard-eligible labels | Final retained |
| --- | --- | --- | --- | ---: |
| 枢纽 | 7 / 2 / 3 | 4 yes | 2 no | 0 |
| The Great Divergence | 7 / 1 / 4 | 4 yes | none | 0 |
| Why Nations Fail | 8 / 2 / 2 | 4 yes | none | 0 |

On these provisional input-only labels, 22 sources have sufficient review-candidate support, 5 conflict with independent-review genre, and 9 remain uncertain. All 12 model-selected sources are labelled yes. The guard's only two eligible sources are labelled no: a metadata/download/user-review aggregator and a book-metadata/rating/synopsis page. They were not model-selected, so neither reached final recommendations. This is evidence against treating the P3 guard as sufficient quality verification.

If the 9 uncertain cases are excluded, the guard alone has TP=0, FP=2, TN=3, FN=22; the combined final output has TP=0, FP=0, TN=5, FN=22. Final precision is undefined because it recommended nothing. These are descriptions of these 27 provisionally labelled inputs, not an online rate or an estimate of all relevant webpages.

The only successfully extracted first page (枢纽 W1) was provisionally classified as new-book promotion and the author's own explanation. Its frozen snippet label was uncertain; the extracted text added launch/sales and author-self-description context, changing only the separate page label to no. The two failed reads remain unavailable, preserving their prior snippet labels; neither failure is evidence of a negative article. No positive review body was successfully obtained in this fixed read sample.

The raw snippet label file mistakenly used task_id BOOK_REVIEW_READER_P4. Its exact frozen bytes and all 36 labels are retained; annotation-receipt.json records this metadata alias. All phase tracking and the later body-label file use BOOK_REVIEW_EVIDENCE_P4. This is a deliberately selected three-query observation with only one usable page extraction, not an online recall estimate or a controlled estimate of the new question presets' semantic effect. There were no new real-provider passage-selection requests in this phase.

## Verification

The integrated candidate passed **250 tests in 6 files**: Web research 73, evidence React 37, assistant 33, evidence client 55, reader React 23, and capture harness 29. API TypeScript and Web TypeScript/Vite builds passed. Existing bundle-size and session mixed-import warnings remain.

An independent harness review reproduced the initial exported read-budget bypass using injected fixtures; out-of-range and noninteger budgets now reject before any IO. Missing-catalog fixtures and the CLI now follow the existing document_not_found contract. A first harness run had one wrong fixture expectation; two Web runs had incorrect button-label/clipboard-format expectations. Those failed logs are retained, and the final integrated run passes. Application readers/copiers were not altered to satisfy those expectations.

The harness joins the existing library workflow; new Web cases are in test files already covered there. Final-head remote CI evidence belongs in the PR.

The full root suite was not rerun. PR #86's 16 failures and one unhandled error remain unresolved and cannot be described as a green repository. Frozen SQL, dependencies, schemas, API policy/response contracts, authentication and production settings were not changed. No human Google-login production UI flow was exercised.

## Run the bounded capture

Use the already-configured local provider environment:

~~~bash
node --import tsx scripts/book-web-research-live-trial.ts \
  --book-id 14322052_000016990400 \
  --query 枢纽 \
  --question '查找直接评论这本书的书评或研究，并提供可核对的网页来源。' \
  --scope direct_book_review \
  --read-first 1
~~~

The command makes real external requests only when explicitly invoked and configured. Each invocation writes a new receipt; it does not overwrite a previous failed trial. Exit 1 for insufficient_sources is retained from the previous CLI; inspect the separate page-read summary, not the exit code alone.

The next useful development target is catalog field/identity handling plus the interface between model selection and the conservative guard. Any policy revision should have new independent samples; this phase's returned inputs are now observed development data.
