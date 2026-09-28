# S32 R7 browser startup recovery — preparation only

Task: `S32_R7_BROWSER_STARTUP_RECOVERY_PREP_R1`.

This unmerged tooling head is for review. R7 remains INCOMPLETE. It does not
permit a normal browser retry, begin/API rerun, recording Web evidence,
completion, production checkout update, or runtime/schema/env changes.
A separate explicit recovery authorization must name the final reviewed tool
SHA before one recovery browser process can be considered. Never merge this
branch before resolving the incident: existing START/API bind incident CTRL.

## Incident and local diagnosis

Incident CTRL: `20e1b8dee2e77c5df0566f305f7d5a5b1745041c`.
Canonical auth/claim/START/API exist; Web/result do not. Normal begin, API and
browser invocation counts are each one. The browser failed before a DevTools
target existed, with `DEVTOOLS_ENDPOINT_TIMEOUT`; semantic Web acceptance was
not reached. See Issue #2 comments 5863076504 and 5863141093.

Chrome for Testing 145.0.7632.6 on Linux/WSL reproduced failure with a fresh
65-byte inherited TMPDIR and 94-byte profile. Identical launch flags with a
30-byte TMPDIR and 59-byte profile reached DevTools. The exact incident
producer similarly failed with the long parent and passed with the short one.
Long Chrome exited with SIGTRAP. Captured stderr reported crashpad CPU-frequency
file lookup errors, not an explicit socket-path error. Adding stderr logging
in a separate diagnostic pair did not identify the failing syscall. Therefore
classification is **TMPDIR_STRONGLY_CORRELATED**, not confirmed AF_UNIX overflow.
The local system header defines `sun_path[108]`; this alone proves no causality.
No production URL, production credential or retained project ID was used.

## Temp ownership

Both normal and recovery modes now create `/tmp/s32-r7-XXXXXX` privately (0700).
The profile and Chrome child TMPDIR/TMP/TEMP are short children of that root.
Chrome does not inherit the orchestration TMPDIR. The root is removed after
live process-group termination, including Chrome's internal temp directories.
Profile/root removal failure blocks canonical publication. Existing receipt,
signal and process-group semantics remain in force.

## Recovery contract and provenance

`recovery-fixture` exercises the state/provenance contract against a synthetic
loopback page. Its receipt retains `RUNNER_MODE=fixture`, which the production
external Web recorder rejects. It consumes no recovery authorization.

`recovery-browser` uses the existing browser semantics and additionally requires
separate local authorization. Both modes retain `RUNNER_SOURCE_SHA=incident CTRL`
and add `R7_BROWSER_RECOVERY=STARTUP_RECOVERY` and `RECOVERY_TOOL_SHA=<tool HEAD>`
inside the receipt hash. Tool HEAD must equal the supplied exact reviewed SHA.
Browser recovery also requires a clean checkout. The two identities have
separate meanings: incident release/control-plane binding and executing tooling.

The helper `scripts/s32-r7-browser-recovery.cjs --check STATE_DIR FP PROJECT_ID
CTRL TOOL_SHA` reads local evidence and reports `READY_AUTHORIZATION_REQUIRED`.
It performs no SSH, HTTP, API, DB, recorder or completion action. This check is
not an authorization and does not prove production copies are fresh.

The operator must establish one retained local state directory (0700) through
a fresh read-only production audit at the future authorization gate. Preserve
regular, non-symlink, mode600 copies of canonical `s32-rollout-<FP>-R7.start.env`
and `.api.env`. Neither `.web.env` nor `.result.env` may exist (including dangling
symlinks). Add `R7.browser-incident.env` containing:

- R7_STATE=INCOMPLETE; exact S32_RELEASE_FINGERPRINT, RELEASE_SOURCE_SHA,
  CONTROL_PLANE_SHA and PROJECT_ID;
- R7_BEGIN_INVOCATIONS=1, R7_API_INVOCATIONS=1, R7_BROWSER_INVOCATIONS=1;
- FAILED_BROWSER_REASON=DEVTOOLS_ENDPOINT_TIMEOUT;
- SEMANTIC_WEB_ACCEPTANCE=NOT_REACHED;
- R7_START_SHA256 and R7_API_SHA256 from the unchanged canonical receipts.

The helper checks both receipt identities and their hashes. API proof must be
PASS, including retained project, assessment UUID and DB idempotency proof.

Only after new explicit authorization may an operator create mode600
`R7.browser-recovery.authorization.env` in that same directory with exactly:
AUTHORIZED_ACTION=S32_R7_BROWSER_STARTUP_RECOVERY, EXPLICIT_APPROVAL=true,
CONSUMABLE_ONCE=true, RECOVERY_TOOL_SHA=<approved SHA>,
INCIDENT_SHA256=<incident file hash>, RECOVERY_BROWSER_INVOCATIONS=1.
Set `S32_R7_RECOVERY_STATE_DIR` and `S32_R7_RECOVERY_TOOL_SHA` when invoking the
reviewed producer's recovery mode. Production credential handling remains
process memory/sessionStorage only; unset shell tracing and injection/debug
environment such as NODE_OPTIONS. Never persist credentials in state files.

Before Chrome starts, browser recovery hard-links that authorization to the
exclusive **local** `R7.browser-recovery.claim.env`. Keep this claim on success
or failure, including spawn failure. Do not copy/reset the state directory,
replace authorization, remove the claim or retry after a consumed attempt.
This operational ledger is not a defense against a malicious local operator.
No real recovery authorization or claim is created by preparation/tests; tests
use invented identities/authorization in disposable local directories.

## Existing recorder compatibility and future boundary

The incident executor remains byte-identical. Its Web validator permits extra
non-secret fields and hashes all of them. Deterministic local tests run a real
loopback browser recovery, then the unchanged external Web recorder and
complete-r7 with disposable test-mode receipts; tampering is rejected.
The existing production recorder does **not** independently require the new
provenance keys. Before any future upload, the authorized operator must validate
both keys, their exact values, receipt hash/mode, producer exit zero and cleanup,
in addition to all normal fields. Canonical Web preserves the full recovery
receipt; the existing final result retains its original fields.

Preparation ends at `EXPLICIT_R7_BROWSER_STARTUP_RECOVERY_AUTHORIZATION`.
No production Web recorder or complete-r7 invocation is authorized here.
Any future authorized recovery failure returns immediately to HARD STOP.
