# BOOK-ID-SEARCH agent bootstrap

This repository is developed with Codex, Hermes, OpenClaw, and other AI agents. Before changing code, read this file and `docs/AGENTIC_ENGINEERING.md`.

## 1. Start by locating the failure layer

For every non-trivial bug, failing test, rollout issue, or recovery task, classify the failure before changing product code:

```text
FAILURE_LAYER=<PRODUCT|DATA|INFRA|ENVIRONMENT|TEST_HARNESS|RELEASE_TOOLING|PROTOCOL>
PRODUCT_IMPACT=<YES|NO|UNKNOWN>
RUNTIME_IMPACT=<YES|NO|UNKNOWN>
TOOLING_ONLY=<YES|NO|UNKNOWN>
EXECUTION_ENVELOPE_DELTA=<NONE|description>
REVERSIBILITY=<REPEATABLE|ONE_SHOT>
EVIDENCE_PLAN=<short plan>
RECOVERY_PLAN=<short plan>
COMPLEXITY_IMPACT=<LOW|MEDIUM|HIGH>
```

Only modify product code when evidence points to the product layer.

## 2. Read current project state before acting

- GitHub Issue #2 is the phase/status ledger. Read the latest relevant checkpoint before rollout, recovery, schema, or S32 work.
- Treat older task packets as historical if a newer checkpoint rebinds a SHA, stage, or recovery boundary.
- Do not infer current rollout state from an old prompt, old worktree, or an earlier receipt.
- GitHub/Notion are evidence and presentation layers. Prefer machine-readable local/canonical state where available.

## 3. Execution-envelope parity is part of correctness

Freeze more than the Git SHA. Important qualification must record the relevant execution envelope, including:

- OS/kernel, cwd, HOME, TMPDIR, PATH and shell
- Node/Python/pnpm versions
- external binary path/version (for example Chromium)
- permissions and relevant path lengths
- network context
- names of relevant environment variables, without secret values

A smoke test does not cover a production execution if the material envelope differs. Record the delta and re-qualify it.

## 4. Preserve diagnostics

For external processes, preserve redacted/mode-600 diagnostic evidence when useful:

- stdout/stderr
- exit code
- PID/PGID
- timestamps
- command shape
- executable path/version

Redact secrets; do not discard all diagnostics merely because secrets exist elsewhere.

## 5. Keep repeatable qualification separate from one-shot actions

Local/environment/tool qualification should be repeatable. Read-only production probes should normally be repeatable. Only genuinely irreversible production mutation or semantic acceptance should be one-shot.

If Issue #2 reports an incomplete one-shot stage, its no-retry/no-rollback boundary overrides generic continuous-execution instructions. Never silently convert a recovery into a retry.

## 6. Design recovery before irreversible execution

For any new irreversible operation, define the behavior for:

1. failure before START;
2. failure after START but before mutation;
3. failure after mutation but before receipt;
4. partial/missing receipt;
5. external-tool failure;
6. allowed recovery count and authorization boundary.

Prefer an explicit lifecycle such as `begin -> execute -> verify -> recover -> finalize`.

## 7. Evidence must survive failure

Persist evidence before comparing it:

```text
snapshot(pre) -> persist(pre)
execute
snapshot(post) -> persist(post)
compare -> persist(diff)
```

Never make the only copy of pre/post evidence in-memory if failure analysis may need it.

## 8. Compare canonical semantics

Do not compare large raw Docker/API objects when order or representation is unstable. Select stable fields, normalize/sort them, then compare.

**Compare semantics, not serialization.**

## 9. Fault-injection tests must prove the fault occurred

A cleanup test is invalid if the target process/event was never created. Prefer explicit gates:

```text
ARMED=PASS
FAULT_INJECTED=PASS
FAULT_OBSERVED=PASS
RECOVERY_OBSERVED=PASS
```

## 10. Complexity budget

Release/verification tooling is production software, not disposable shell glue.

Before adding a new state, receipt, guard, recovery stage, or script, report:

```text
RISK_REDUCED=
COMPLEXITY_ADDED=
CAN_EXISTING_MODEL_BE_SIMPLIFIED=<YES|NO>
```

If tooling complexity approaches or exceeds product complexity, stop adding guards and propose workflow consolidation.

## 11. Worktree and production discipline

- One writer per worktree. Preserve unrelated uncommitted work.
- Use native execution; do not use another agent only as a command relay.
- Use `pnpm install --frozen-lockfile` for dependency installation.
- Development/integration data stays disposable/non-production unless a stage explicitly authorizes otherwise.
- Production access is `ssh tencent`. Read `/home/conanxin/codex-ops/tencent/AGENTS.md` when available.
- Before any explicitly authorized remote write, verify `whoami=ubuntu` and `hostname=VM-0-4-ubuntu`; otherwise stop.
- Try `sudo -n` only. Stop if interaction is required.
- Production writes, merges, container changes, env changes, persistent DB/schema/data changes, cleanup, or rollback require the relevant explicit authorization.
- Never commit credentials, private datasets, tokens, DB URLs/passwords, or secret-derived hashes that project rules forbid exposing.

## 12. Do not game the gates

Never obtain green status by:

- skipping or deleting a relevant failing test;
- weakening fail-closed behavior without an explicit design decision;
- deleting failure evidence;
- relabeling an historical failure as PASS;
- claiming a test covered an execution envelope it did not cover.

## 13. Development and deployment are different tracks

A rollout blocker should not automatically block unrelated non-production development. Freeze the release track when required, not the whole repository, unless schema/API compatibility requires a global gate.

## 14. End-of-task receipt

For important tasks, report:

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

## 15. Project references

- Full engineering lessons and reusable agent prompt: `docs/AGENTIC_ENGINEERING.md`
- Notion skill: https://app.notion.com/p/3e934a28189a81089645fe3bf6584e4c?pvs=204
- GitHub Issue #2: current rollout/recovery/phase checkpoints
- Production operations guidance: `docs/operations/`

If existing project instructions conflict with the engineering rules, report the conflict before adding more rules. Do not silently stack another protocol on top.
