# Agentic Engineering lessons and operating rules

This document captures reusable engineering lessons learned from BOOK-ID-SEARCH / S32 development, testing, rollout, recovery, and AI-agent collaboration.

The goal is not to memorialize one Chromium incident. The goal is to make future work safer **and simpler**.

> **Core principle:** minimize the irreversible boundary. Everything else should be observable, repeatable, diagnosable, and recoverable.

Notion skill:
https://app.notion.com/p/3e934a28189a81089645fe3bf6584e4c?pvs=204

---

## 1. Locate the failure layer before changing code

A failing test or rollout is not proof that product code is broken.

Classify first:

```text
FAILURE_LAYER=<PRODUCT|DATA|INFRA|ENVIRONMENT|TEST_HARNESS|RELEASE_TOOLING|PROTOCOL>
PRODUCT_IMPACT=<YES|NO|UNKNOWN>
RUNTIME_IMPACT=<YES|NO|UNKNOWN>
TOOLING_ONLY=<YES|NO|UNKNOWN>
```

Typical examples:

- wrong business behavior -> PRODUCT
- malformed/corrupt state -> DATA
- container/network/service failure -> INFRA
- TMPDIR/PATH/shell/binary mismatch -> ENVIRONMENT
- fake regression or fixture bug -> TEST_HARNESS
- receipt/process/signal bug -> RELEASE_TOOLING
- unnecessarily global one-shot/no-retry rule -> PROTOCOL

Only change product code when the evidence points there.

---

## 2. Freeze the execution envelope, not only the commit

`TESTED_SHA == EXECUTED_SHA` is necessary, but not sufficient.

For environment-sensitive work, capture:

```text
git_sha
os/kernel
cwd
HOME
TMPDIR
PATH
shell
node/python/pnpm versions
external executable path/version
permissions
relevant path lengths
network context
relevant env variable names
```

Never record secret values in this envelope.

Before an irreversible gate, compare qualification vs execution:

```text
SMOKE_ENVELOPE
EXECUTION_ENVELOPE
ENVELOPE_DELTA
```

If a material delta exists, that shape was not qualified.

---

## 3. Preserve diagnostics; redact instead of discarding

A safe harness still needs useful failure evidence.

For external processes, prefer mode-600 evidence for:

- stdout
- stderr
- exit code
- PID and PGID when applicable
- start/end timestamp
- executable path/version
- non-secret command shape
- non-secret environment names

Do not throw away all stderr simply because another part of the system contains secrets.

Prefer:

```text
capture -> redact/scan -> retain
```

over:

```text
discard -> guess later
```

---

## 4. Separate qualification from acceptance/mutation

A central lesson from S32 is that security strictness should not imply universal non-repeatability.

### Layer 1 — Repeatable local qualification

Examples:

- binary startup
- DevTools/CDP startup
- TMPDIR/profile topology
- signal handling
- process cleanup
- receipt mechanics

These should be safely repeatable.

### Layer 2 — Repeatable read-only production probe

Examples:

- health/status
- public HTML/static surface
- read-only runtime identity
- no secret injection
- no business data creation

These should normally be repeatable.

### Layer 3 — One-shot semantic acceptance or mutation

Examples:

- irreversible DB migration
- canonical release state creation
- acceptance that creates canonical business evidence
- destructive/forward-only production mutation

Only this layer should consume a one-shot attempt.

**Repeatability boundary != security boundary.**

---

## 5. Design recovery at the same time as the happy path

Before approving an irreversible operation, answer:

1. What if it fails before START?
2. What if it fails after START but before mutation?
3. What if mutation succeeds but receipt writing fails?
4. What if the external tool fails?
5. What if canonical evidence is partial?
6. Is recovery repeatable or exactly-once?
7. What needs new explicit authorization?

Prefer:

```text
begin
execute
verify
recover
finalize
```

instead of a single giant `execute`.

A recovery discovered only after an incident is already late.

---

## 6. Persist evidence before comparing it

Bad forensic design:

```python
pre = audit()
execute()
post = audit()
assert invariant(pre, post)
# failure raises before pre/post are saved
```

Preferred design:

```text
pre = snapshot()
persist(pre)

execute()

post = snapshot()
persist(post)

diff = compare(pre, post)
persist(diff)
```

Suggested evidence bundle:

```text
evidence/
  envelope.json
  command.json
  pre.json
  post.json
  diff.json
  stdout.log
  stderr.log
  receipt.env
```

If the check fails, the evidence needed to understand the failure must already exist.

---

## 7. Compare semantics, not serialization

Large raw Docker/API JSON objects often contain unstable ordering or representation.

Do not default to:

```python
pre["services"] == post["services"]
```

Instead:

1. choose the stable semantic fields;
2. canonicalize;
3. sort list/set-like structures;
4. normalize representation;
5. compare;
6. persist a field-level diff.

**Compare semantics, not serialization.**

---

## 8. Fault-injection tests must prove the fault happened

A cleanup test is invalid if the target process never started.

For fault tests, explicitly prove:

```text
ARMED=PASS
FAULT_INJECTED=PASS
FAULT_OBSERVED=PASS
RECOVERY_OBSERVED=PASS
```

Examples:

- descendant PID existed before testing cleanup;
- signal was actually delivered;
- token reload actually occurred;
- EACCES actually occurred;
- connection actually opened before testing shutdown.

Never infer successful cleanup merely from absence at the end.

---

## 9. Release tooling is a product

Once operational tooling has substantial code, tests, states, recovery paths, and safety properties, it is not “just scripts”.

Treat it as a subsystem with:

- domain model
- state machine
- evidence model
- commands
- adapters
- tests
- versioned contracts

Long-term consolidation target:

```text
s32 status
s32 qualify browser
s32 verify
s32 rollout begin
s32 rollout finalize
s32 recover
s32 evidence inspect
```

Prefer this over indefinitely adding:

```text
execute-*.sh
verify-*.py
recover-*.sh
claim-*.sh
authorize-*.sh
test-*.py
```

---

## 10. Prefer one machine-readable canonical state

Do not require a future agent to reconstruct truth by reading dozens of issue comments and logs.

A release state might look like:

```json
{
  "release": "S32",
  "stage": "R7",
  "state": "INCOMPLETE",
  "ctrl": "<sha>",
  "attempts": {
    "api": 1,
    "browser": 1
  },
  "evidence": {
    "start": "...",
    "api": "...",
    "web": null,
    "result": null
  },
  "recovery": {
    "state": "DIAGNOSTIC"
  }
}
```

GitHub Issue / Notion should present and explain this state, not become competing sources of truth.

---

## 11. Use a complexity budget

AI agents are extremely good at locally-correct complexity growth:

```text
edge case
 -> guard
 -> test
 -> state
 -> receipt field
 -> recovery
 -> another guard
```

Before adding any state/gate/receipt/script, require:

```text
RISK_REDUCED=
COMPLEXITY_ADDED=
CAN_EXISTING_MODEL_BE_SIMPLIFIED=<YES|NO>
```

Rule of thumb:

> If tooling complexity approaches or exceeds product complexity, stop adding guards and redesign the workflow.

---

## 12. Remove obsolete mechanisms

Every major phase should review cleanup, not only implementation.

Definition-of-done candidates:

```text
DEAD_PATH_REMOVAL=PASS
OBSOLETE_SCRIPT_REMOVAL=PASS
DOC_CONSOLIDATION=PASS
DUPLICATE_INVARIANT_REMOVAL=PASS
```

Recovery code and incident-specific paths should not accumulate forever.

---

## 13. A release blocker should not automatically freeze development

Separate:

```text
development
qualification
release
deployment
production mutation
```

If a release is blocked by a browser harness, unrelated local feature development does not necessarily need to stop.

Only introduce a global development gate when compatibility truly requires it, e.g. schema/API contract dependencies.

---

## 14. Agent operating contract

### Before an important task

Output:

```text
FAILURE_LAYER=
PRODUCT_IMPACT=
RUNTIME_IMPACT=
TOOLING_ONLY=
EXECUTION_ENVELOPE_DELTA=
REVERSIBILITY=<REPEATABLE|ONE_SHOT>
EVIDENCE_PLAN=
RECOVERY_PLAN=
COMPLEXITY_IMPACT=
```

### During the task

- preserve evidence;
- separate repeatable qualification from irreversible actions;
- respect current canonical/Issue checkpoint;
- do not silently retry one-shot operations;
- address review findings by simplifying the model when possible;
- do not modify product code for tooling/environment failures.

### At task completion

Output:

```text
PRODUCT_CHANGED=
TOOLING_CHANGED=
TESTS=
EVIDENCE_PRESERVED=
CANONICAL_STATE_UPDATED=
COMPLEXITY_DELTA=
DEAD_PATHS_CREATED_OR_REMOVED=
NEXT_ACTION=
```

---

## 15. Things an agent must not do to get green

Do not:

- skip/delete a relevant failing test;
- weaken fail-closed behavior without an explicit design decision;
- delete failure evidence;
- rewrite an historical failure as PASS;
- claim a smoke covered an environment it did not cover;
- rerun a consumed one-shot operation unless a reviewed recovery explicitly authorizes a distinct recovery action.

---

## 16. Portable bootstrap prompt for Codex / Hermes / OpenClaw

Use this at the start of a project or session:

```text
Before doing any development, debugging, testing, rollout, or recovery work:

1. Read the repository's AGENTS.md.
2. Read docs/AGENTIC_ENGINEERING.md completely.
3. Read the latest relevant project/rollout checkpoint before acting.
4. Do not treat “make tests green” as the objective. The objective is to complete the task inside a finite, understandable, auditable state model.

For every important task first report:
FAILURE_LAYER=
PRODUCT_IMPACT=
RUNTIME_IMPACT=
TOOLING_ONLY=
EXECUTION_ENVELOPE_DELTA=
REVERSIBILITY=<REPEATABLE|ONE_SHOT>
EVIDENCE_PLAN=
RECOVERY_PLAN=
COMPLEXITY_IMPACT=

Rules:
- modify product code only when evidence identifies a product failure;
- qualification should be repeatable;
- only irreversible semantic/mutation boundaries should be one-shot;
- persist pre/post evidence before comparison;
- retain redacted external-process diagnostics;
- prove fault injection occurred before claiming recovery passed;
- compare canonical semantics, not raw representations;
- never silently retry a consumed one-shot operation;
- never obtain green by skipping tests, deleting evidence, weakening fail-closed, or relabeling historical failure;
- before adding another guard/state/receipt/script, report RISK_REDUCED and COMPLEXITY_ADDED;
- if tooling complexity approaches product complexity, propose workflow simplification instead of adding more guards;
- treat release and development as separate tracks unless compatibility forces a shared gate.

If an existing project instruction conflicts with these rules, explicitly report the conflict before continuing. Do not silently stack another protocol.
```

This prompt is intentionally agent-neutral. Codex may auto-load `AGENTS.md`; Hermes/OpenClaw can be explicitly told to read the same two repository files.

---

## 17. BOOK-ID-SEARCH / S32 application

For the current project:

- R7 INCOMPLETE remains fail-closed according to the latest Issue #2 checkpoint.
- A normal R7 browser retry is not equivalent to a reviewed recovery.
- Browser startup/runtime qualification should be local-only and repeatable.
- Recovery tooling must be reviewed and explicitly authorized before another production semantic browser proof.
- After closing the current incident, schedule a release-tooling consolidation pass.
- M2-E should use:
  - repeatable qualification,
  - durable evidence,
  - minimum one-shot deployment boundary,
  - development/release decoupling where possible.
- Prefer consolidating S32 scripts into a coherent CLI/state model rather than adding more isolated scripts.

---

## 18. Definition of Done for agent-heavy engineering

For a meaningful phase, consider:

```text
PRODUCT_BEHAVIOR=PASS
TESTS=PASS
FAILURE_LAYER_CLASSIFIED=PASS
EXECUTION_ENVELOPE_CAPTURED=PASS
DIAGNOSTIC_EVIDENCE_PRESERVED=PASS
RECOVERY_PATH_DEFINED=PASS_OR_NOT_APPLICABLE
CANONICAL_STATE_UPDATED=PASS
DEAD_PATH_REVIEWED=PASS
COMPLEXITY_BUDGET_REVIEWED=PASS
```

---

## Final lesson

The most important lesson from BOOK-ID-SEARCH is not that Chromium is difficult.

It is:

> **High reliability does not require maximizing the number of states, scripts, and non-retry rules. Mature engineering minimizes the irreversible boundary and makes everything around it observable, repeatable, and recoverable.**
