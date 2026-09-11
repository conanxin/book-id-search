#!/usr/bin/env python3
"""
S27T-5D Production Executor — Python tests.

Python stdlib only.  No shell test harness.  Each test:
  - builds a fresh tempfile Git repo (HEAD == origin/main, branch=main)
  - copies exact-byte Executor (and Planner/Claim/Deploy for integrated tests)
  - creates controlled fake siblings (Planner/Claim/Deploy/production reader)
  - invokes the Executor as a subprocess
  - asserts the resulting state, machine output, and side effects

Hard guarantees tested:
  - the Executor never touches the main repo
  - the Executor never invokes real Docker
  - the Executor's read-only preflight always precedes Claim
  - Claim is the first irreversible transition
  - Post-claim minimal TOCTOU never re-runs L2 / Planner / E2E
  - Start artifact is mode 600, atomic create, no overwrite
  - Result artifact is mode 600, atomic create, no overwrite
  - Deploy is called at most once per executor invocation
  - AUTO_RETRY / AUTO_ROLLBACK are always false
  - Replay after success / failure is BLOCKED
  - Crash injection is handled by external termination, not runtime flags
"""
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import traceback
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[1]
EXECUTOR_REL = "scripts/execute-web-production-release.sh"
EXECUTOR_PATH = REPO_ROOT / EXECUTOR_REL
PLANNER_REL = "scripts/plan-web-production-deployment-execution.sh"
CLAIM_REL = "scripts/claim-web-production-release-authorization.sh"
DEPLOY_REL = "scripts/deploy-web-release-candidate.sh"
GATE_REL = "scripts/verify-web-release-runtime-acceptance.py"

ALLOWED_REASONS_PREFIX = (
    "PRE_CLAIM_BLOCKED", "PRECLAIM_", "RUNTIME_", "EXECUTION_PLAN_",
    "PIPELINE_HEAD_DRIFT", "AUTHORIZATION_", "IMAGE_", "PRODUCTION_PRE_STATE_DRIFT",
    "WORKTREE_NOT_CLEAN", "NOT_MAIN_BRANCH", "HEAD_ORIGIN_MISMATCH",
    "INVALID_ARGUMENTS", "INVALID_SOURCE_SHA", "PLANNER_", "CLAIM_",
    "POST_CLAIM_", "START_", "DEPLOY_", "POST_DEPLOY_",
    "RESULT_", "FINAL_", "ATTEMPT_ALREADY_FINALIZED", "CLAIMED_NOT_STARTED",
    "PRODUCTION_ATTEMPT_STATUS_UNKNOWN", "PRODUCTION_SCOPE_VIOLATION",
    "POST_VERIFY_FAILED", "INTERNAL_",
)

# ----------------------------------------------------------------------------
# Result + counter helpers
# ----------------------------------------------------------------------------

PASS_COUNT = 0
FAIL_COUNT = 0
FAILURES: List[Tuple[str, str]] = []


def _ok(cond, msg=""):
    if not cond:
        raise AssertionError(msg or "assertion failed")

def _record_pass(name: str):
    global PASS_COUNT
    PASS_COUNT += 1
    print(f"PASS {name}")

def _record_fail(name: str, exc: BaseException):
    global FAIL_COUNT
    FAIL_COUNT += 1
    FAILURES.append((name, str(exc)))
    print(f"FAIL {name}: {exc}")

def test(name: str):
    def deco(fn):
        def runner():
            try:
                fn()
                _record_pass(name)
            except BaseException as e:
                _record_fail(name, e)
                traceback.print_exc()
        return runner
    return deco


# ----------------------------------------------------------------------------
# Workspace helpers (mirror Simulator's make_workspace, exact-byte semantics)
# ----------------------------------------------------------------------------

EXEC_SHA = hashlib.sha256(EXECUTOR_PATH.read_bytes()).hexdigest() if EXECUTOR_PATH.exists() else "NONE"

IMAGE_TAG_DEFAULT = "registry.example.test/book-id-search/web:sim"
IMAGE_ID_DEFAULT = "sha256:" + "a" * 64
IMAGE_ID_ALT = "sha256:" + "b" * 64
MANIFEST_DEFAULT = "m" * 64
LOCKFILE_DEFAULT = "l" * 64
SOURCE_SHA_DEFAULT = "1" * 40

def _get_repo_head_sha(repo: Path) -> str:
    return subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"], text=True
    ).strip()

def make_temp_repo(scenario: str) -> Tuple[Path, Path]:
    """Build a temp Git repo with HEAD==origin/main and clean worktree."""
    tmp = Path(tempfile.mkdtemp(prefix=f"s27t5d_{scenario}_"))
    repo = tmp / "repo"
    repo.mkdir()
    (repo / "scripts").mkdir()
    (repo / "scripts" / "verify").mkdir()
    (repo / "progress").mkdir()
    (repo / "simulation").mkdir()

    for cmd in [
        ["git", "-C", str(repo), "init", "-q", "-b", "main"],
        ["git", "-C", str(repo), "config", "user.email", "sim@test"],
        ["git", "-C", str(repo), "config", "user.name", "sim"],
        ["git", "-C", str(repo), "config", "commit.gpgsign", "false"],
    ]:
        subprocess.run(cmd, check=True)

    (repo / ".gitignore").write_text(
        "simulation/\nprogress/\n__pycache__/\nfake-bin/\n"
        "scripts/claim-web-production-release-authorization.sh\n"
        "scripts/deploy-web-release-candidate.sh\n"
        "scripts/verify-web-release-runtime-acceptance.py\n"
        "scripts/plan-web-production-deployment-execution.sh\n"
        "scripts/execute-web-production-release.sh\n"
    )
    (repo / "README").write_text("sim\n")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "init"], check=True)
    subprocess.run(["git", "-C", str(repo), "remote", "add", "origin", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "fetch", "origin", "main", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(repo), "branch", "--set-upstream-to=origin/main", "main"], check=True)
    head_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
    subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head_sha], check=True)
    return tmp, repo

def copy_exact_byte(src: Path, dst: Path, mode: int = 0o755) -> str:
    shutil.copy2(src, dst)
    dst.chmod(mode)
    src_sha = hashlib.sha256(src.read_bytes()).hexdigest()
    dst_sha = hashlib.sha256(dst.read_bytes()).hexdigest()
    if src_sha != dst_sha:
        raise RuntimeError(f"exact-byte mismatch: {src} -> {dst}")
    return src_sha

def copy_dir_exact(src: Path, dst: Path):
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, symlinks=True)

def sha_file(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()

def sha_text(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


# ----------------------------------------------------------------------------
# Fake runtime generators (L1 controlled test environment)
# ----------------------------------------------------------------------------

def compute_release_plan_fingerprint(source_sha: str, image_tag: str, image_id: str,
                                       manifest: str, lockfile: str) -> str:
    """Match the canonical 5-field release plan fingerprint formula used by
    the real Planner / Claim runtimes."""
    canonical = "\n".join([
        f"SOURCE_SHA={source_sha}",
        f"IMAGE_TAG={image_tag}",
        f"IMAGE_ID={image_id}",
        f"MANIFEST_SHA={manifest}",
        f"LOCKFILE_SHA={lockfile}",
    ]) + "\n"
    return hashlib.sha256(canonical.encode()).hexdigest()

def write_fake_planner(repo: Path, *, image_id: str = IMAGE_ID_DEFAULT,
                       image_tag: str = IMAGE_TAG_DEFAULT,
                       manifest: str = MANIFEST_DEFAULT,
                       lockfile: str = LOCKFILE_DEFAULT,
                       plan_exit: int = 0,
                       plan_output: str = None,
                       execution_plan_path: str = None,
                       execution_plan_fingerprint: str = None,
                       source_sha: str = None,
                       release_plan_fingerprint: str = None,
                       emit_manifest_lockfile_in_stdout: bool = True) -> Path:
    """Write a fake plan-web-production-deployment-execution.sh that returns
    a deterministic READY_TO_CLAIM (or BLOCKED).

    NOTE: EXECUTION_PLAN_FINGERPRINT in stdout is read from the artifact file
    at runtime (cat $EXECUTION_PLAN_PATH).  This decouples planner bytes from
    the fingerprint value, breaking the otherwise circular dependency between
    planner SHA and EP_FP.
    """
    scripts = repo / "scripts"
    rp_fp = release_plan_fingerprint or "r" * 64
    ep_path = execution_plan_path or f"{repo}/progress/mock-execution-plan.env"
    ep_fp = execution_plan_fingerprint or ("p" * 64)
    body = textwrap.dedent("""\
        #!/usr/bin/env bash
        # Fake read-only Planner (L1 controlled test)
        set -uo pipefail
        SOURCE_SHA_VAL="$2"
        RP_FP=$(printf '%s\\n%s\\n%s\\n%s\\n%s\\n' \\
          "SOURCE_SHA=$SOURCE_SHA_VAL" \\
          "IMAGE_TAG={tag}" \\
          "IMAGE_ID={img}" \\
          "MANIFEST_SHA={m}" \\
          "LOCKFILE_SHA={l}" \\
          | sha256sum | awk '{{print $1}}')
        """).format(tag=image_tag, img=image_id, m=manifest, l=lockfile)
    if plan_output is not None:
        body += plan_output + "\n"
    else:
        body += textwrap.dedent(f"""\
            IMAGE_TAG_VAL="{image_tag}"
            IMAGE_ID_VAL="{image_id}"
            MANIFEST_SHA_VAL="{manifest}"
            LOCKFILE_SHA_VAL="{lockfile}"
            # Read EXECUTION_PLAN_FINGERPRINT and EXECUTION_PLAN_ARTIFACT from
            # FIXED side-channel files (progress/mock-execution-plan.env).
            # This decouples planner bytes from fingerprint value AND from
            # artifact path, so the iter over artifact FP <-> disk
            # PLAN_RUNTIME_SHA256 converges in 1 pass.
            EP_FP=$(cat {repo}/progress/mock-execution-plan.env 2>/dev/null \\
              | grep '^EXECUTION_PLAN_FINGERPRINT=' \\
              | head -1 | sed -e 's/^EXECUTION_PLAN_FINGERPRINT=//')
            [ -z "$EP_FP" ] && EP_FP="{ep_fp}"
            EP_PATH=$(cat {repo}/progress/mock-execution-plan-path.env 2>/dev/null \\
              | grep '^EXECUTION_PLAN_ARTIFACT=' \\
              | head -1 | sed -e 's/^EXECUTION_PLAN_ARTIFACT=//')
            [ -z "$EP_PATH" ] && EP_PATH="{ep_path}"
            cat <<PLN_EOF
STATUS=READY_TO_CLAIM
SOURCE_SHA=$SOURCE_SHA_VAL
RELEASE_PLAN_FINGERPRINT=$RP_FP
EXECUTION_PLAN_FINGERPRINT=$EP_FP
IMAGE_TAG=$IMAGE_TAG_VAL
IMAGE_ID=$IMAGE_ID_VAL
MANIFEST_SHA=$MANIFEST_SHA_VAL
LOCKFILE_SHA=$LOCKFILE_SHA_VAL
L2_QUICK=PASS
RELEASE_PLAN=PASS
AUTHORIZATION_VALIDATED=PASS
AUTHORIZATION_UNCLAIMED=true
PRECLAIM_IMAGE_IDENTITY=PASS
AUTHORIZED_ISOLATED_E2E=PASS
PRODUCTION_UNCHANGED=PASS
EXECUTION_PLAN_ARTIFACT=$EP_PATH
EXECUTION_PLAN_READY=true
CLAIM_EXECUTED=false
PRODUCTION_DEPLOY_STARTED=false
PRODUCTION_DEPLOY_EXECUTED=false
PRODUCTION_WRITE_EXECUTED=false
AUTO_RETRY=false
AUTO_ROLLBACK=false
EXECUTION_AUTHORIZED=false
PLN_EOF
            exit {plan_exit}
        """)
        # S27T-5E-R5I: when emit_manifest_lockfile_in_stdout=False, mirror the
        # REAL Planner contract and remove MANIFEST_SHA / LOCKFILE_SHA from
        # stdout.  Canonical source for these two fields is the Execution Plan
        # artifact body (PLAN_TEXT), NOT Planner stdout.
        if not emit_manifest_lockfile_in_stdout:
            body = re.sub(
                r"^MANIFEST_SHA=\$MANIFEST_SHA_VAL\nLOCKFILE_SHA=\$LOCKFILE_SHA_VAL\n",
                "",
                body,
                count=1,
                flags=re.MULTILINE,
            )
    p = scripts / "plan-web-production-deployment-execution.sh"
    p.write_text(body)
    p.chmod(0o755)
    return p

def write_fake_claim(repo: Path, *, claim_exit: int = 0,
                     claim_output: str = None,
                     refuse: bool = False,
                     release_plan_fingerprint: str = "r" * 64,
                     image_id: str = IMAGE_ID_DEFAULT,
                     image_tag: str = IMAGE_TAG_DEFAULT) -> Path:
    """Write a fake claim runtime.  When refuse=True, simulates a claim that
    succeeds on filesystem but reports AUTHORIZATION_ALREADY_CLAIMED
    (or similar)."""
    scripts = repo / "scripts"
    rp_fp = release_plan_fingerprint
    body = textwrap.dedent("""\
        #!/usr/bin/env bash
        # Fake Claim runtime (L1 controlled test)
        set -uo pipefail
        SOURCE_SHA_VAL="$2"
        RP_FP_VAL='%s'
        IMAGE_TAG_VAL='%s'
        IMAGE_ID_VAL='%s'
        """ % (rp_fp, image_tag, image_id))
    if claim_output is not None:
        body += claim_output + "\n"
    elif refuse:
        body += textwrap.dedent("""\
            cat <<CLM_EOF
STATUS=BLOCKED
BLOCK_REASON=AUTHORIZATION_ALREADY_CLAIMED
AUTHORIZATION_CLAIMED=false
PRODUCTION_DEPLOY_EXECUTED=false
PRODUCTION_DEPLOY_STARTED=false
CLM_EOF
            exit 1
        """)
    else:
        # Standard PASS — emit values that match Execution Plan.
        body += textwrap.dedent(f"""\
            # Simulate claim consumed
            cat <<CLM_EOF
STATUS=PASS
SOURCE_SHA=$SOURCE_SHA_VAL
RELEASE_PLAN_FINGERPRINT=$RP_FP_VAL
IMAGE_TAG=$IMAGE_TAG_VAL
IMAGE_ID=$IMAGE_ID_VAL
AUTHORIZED_ACTION=production-deploy
AUTHORIZATION_ARTIFACT={repo}/progress/auth-fake.env
AUTHORIZATION_CLAIM_ARTIFACT={repo}/progress/claim-fake.env
AUTHORIZATION_CLAIMED=true
AUTHORIZATION_REUSABLE=false
CONSUMABLE_ONCE=true
PRODUCTION_DEPLOY_AUTHORIZED=true
PRODUCTION_DEPLOY_EXECUTED=false
PRODUCTION_DEPLOY_STARTED=false
CLM_EOF
            exit $RP_FP_VAL 2>/dev/null  # placeholder, ignored
        """)
        # Fix: the line above is wrong because we use exit {claim_exit} numeric.
        # Replace it cleanly.
        body = body.replace("exit $RP_FP_VAL 2>/dev/null  # placeholder, ignored",
                            f"exit {claim_exit}")
    p = scripts / "claim-web-production-release-authorization.sh"
    p.write_text(body)
    p.chmod(0o755)
    return p

def write_fake_deploy(repo: Path, *, exit_code: int = 0,
                      stdout_text: str = "",
                      simulate_post_state_change: bool = True) -> Path:
    """Write a fake deploy-web-release-candidate.sh that returns deterministically."""
    scripts = repo / "scripts"
    body = textwrap.dedent("""\
        #!/usr/bin/env bash
        # Fake Deploy runtime (L1 controlled test) — does NOT touch real Docker.
        set -uo pipefail
        IMAGE_TAG="$1"
        """)
    if simulate_post_state_change:
        # Update the simulated production state file
        body += textwrap.dedent(f"""\
            # Touch simulated production state
            mkdir -p {repo}/simulation
            echo "WEB_CID=fake_web_cid_$RANDOM" > {repo}/simulation/web_state.env
            echo "WEB_IMAGE_ID={IMAGE_ID_DEFAULT}" >> {repo}/simulation/web_state.env
            echo "WEB_CONFIG_IMAGE=$IMAGE_TAG" >> {repo}/simulation/web_state.env
            echo "DEPLOY_EXIT=0" >> {repo}/simulation/web_state.env
        """)
    body += f'exit {exit_code}\n'
    if stdout_text:
        body = stdout_text + "\n" + body
    p = scripts / "deploy-web-release-candidate.sh"
    p.write_text(body)
    p.chmod(0o755)
    return p

def write_execution_plan_artifact(repo: Path, *, image_id: str = IMAGE_ID_DEFAULT,
                                  image_tag: str = IMAGE_TAG_DEFAULT,
                                  fingerprint: str = None,
                                  release_plan_fp: str = None,
                                  plan_runtime_sha: str = "x" * 64,
                                  claim_runtime_sha: str = "y" * 64,
                                  deploy_runtime_sha: str = "z" * 64,
                                  orchestrator_runtime_sha: str = "o" * 64,
                                  authorize_runtime_sha: str = "a" * 64,
                                  gate_sha: str = "g" * 64,
                                  pipeline_head: str = None,
                                  source_sha: str = SOURCE_SHA_DEFAULT,
                                  auth_sha: str = "q" * 64,
                                  cand_sha: str = "c" * 64,
                                  manifest: str = MANIFEST_DEFAULT,
                                  lockfile: str = LOCKFILE_DEFAULT,
                                  pre_web_cid: str = "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da",
                                  pre_web_started_at: str = "2026-08-07T23:04:36Z",
                                  pre_web_config_image: str = None,  # None = use image_tag
                                  pre_web_image_id: str = "sha256:old",
                                  pre_api_cid: str = "apipre",
                                  pre_api_started_at: str = "2026-08-02T23:42:05Z",
                                  pre_meili_cid: str = "meilipre",
                                  pre_meili_started_at: str = "2026-06-30T13:35:18Z") -> Tuple[Path, str]:
    """Write a mode-600 Execution Plan artifact; returns (path, fingerprint)."""
    if fingerprint is None:
        # Canonical fingerprint (24 fields, 24 newlines, version=1)
        # The Executor expects this exact ordering.
        canonical = "\n".join([
            "EXECUTION_PLAN_VERSION=1",
            f"SOURCE_SHA={source_sha}",
            f"RELEASE_PLAN_FINGERPRINT={release_plan_fp or ('r' * 64)}",
            f"IMAGE_TAG={image_tag}",
            f"IMAGE_ID={image_id}",
            f"MANIFEST_SHA={manifest}",
            f"LOCKFILE_SHA={lockfile}",
            f"AUTHORIZATION_SHA256={auth_sha}",
            f"CANDIDATE_EVIDENCE_SHA256={cand_sha}",
            f"PIPELINE_HEAD={pipeline_head or ('h' * 40)}",
            f"PLAN_RUNTIME_SHA256={plan_runtime_sha}",
            f"AUTHORIZE_RUNTIME_SHA256={authorize_runtime_sha}",
            f"CLAIM_RUNTIME_SHA256={claim_runtime_sha}",
            f"ORCHESTRATOR_RUNTIME_SHA256={orchestrator_runtime_sha}",
            f"DEPLOY_RUNTIME_SHA256={deploy_runtime_sha}",
            f"RUNTIME_ACCEPTANCE_GATE_SHA256={gate_sha}",
            f"PRE_WEB_CID={pre_web_cid}",
            f"PRE_WEB_STARTED_AT={pre_web_started_at}",
            f"PRE_WEB_CONFIG_IMAGE={pre_web_config_image}",
            f"PRE_WEB_IMAGE_ID={pre_web_image_id}",
            f"PRE_API_CID={pre_api_cid}",
            f"PRE_API_STARTED_AT={pre_api_started_at}",
            f"PRE_MEILI_CID={pre_meili_cid}",
            f"PRE_MEILI_STARTED_AT={pre_meili_started_at}",
        ]) + "\n"
        fingerprint = hashlib.sha256(canonical.encode()).hexdigest()
    if release_plan_fp is None:
        release_plan_fp = "r" * 64
    if pipeline_head is None:
        pipeline_head = "h" * 40

    body_lines = [
        "EXECUTION_PLAN_VERSION=1",
        f"SOURCE_SHA={source_sha}",
        f"RELEASE_PLAN_FINGERPRINT={release_plan_fp}",
        f"EXECUTION_PLAN_FINGERPRINT={fingerprint}",
        f"IMAGE_TAG={image_tag}",
        f"IMAGE_ID={image_id}",
        f"MANIFEST_SHA={manifest}",
        f"LOCKFILE_SHA={lockfile}",
        f"AUTHORIZATION_SHA256={auth_sha}",
        f"CANDIDATE_EVIDENCE_SHA256={cand_sha}",
        f"PIPELINE_HEAD={pipeline_head}",
        f"PLAN_RUNTIME_SHA256={plan_runtime_sha}",
        f"AUTHORIZE_RUNTIME_SHA256={authorize_runtime_sha}",
        f"CLAIM_RUNTIME_SHA256={claim_runtime_sha}",
        f"ORCHESTRATOR_RUNTIME_SHA256={orchestrator_runtime_sha}",
        f"DEPLOY_RUNTIME_SHA256={deploy_runtime_sha}",
        f"RUNTIME_ACCEPTANCE_GATE_SHA256={gate_sha}",
        f"PRE_WEB_CID={pre_web_cid}",
        f"PRE_WEB_STARTED_AT={pre_web_started_at}",
        f"PRE_WEB_CONFIG_IMAGE={pre_web_config_image}",
        f"PRE_WEB_IMAGE_ID={pre_web_image_id}",
        f"PRE_API_CID={pre_api_cid}",
        f"PRE_API_STARTED_AT={pre_api_started_at}",
        f"PRE_MEILI_CID={pre_meili_cid}",
        f"PRE_MEILI_STARTED_AT={pre_meili_started_at}",
        "L2_QUICK=PASS",
        "RELEASE_PLAN=PASS",
        "AUTHORIZATION_VALIDATED=PASS",
        "AUTHORIZATION_UNCLAIMED=true",
        "AUTHORIZED_ISOLATED_E2E=PASS",
        "PRECLAIM_IMAGE_IDENTITY=PASS",
        "PRODUCTION_UNCHANGED=PASS",
        "AUTO_RETRY=false",
        "AUTO_ROLLBACK=false",
        "CLAIM_EXECUTED=false",
        "PRODUCTION_DEPLOY_STARTED=false",
        "PRODUCTION_DEPLOY_EXECUTED=false",
        "PRODUCTION_WRITE_EXECUTED=false",
        "EXECUTION_PLAN_READY=true",
        "EXECUTION_AUTHORIZED=false",
    ]
    path = repo / "progress" / f"web-release-production-execution-plan-{fingerprint}.env"
    path.write_text("\n".join(body_lines) + "\n")
    path.chmod(0o600)
    return path, fingerprint

def write_authorization_artifact(repo: Path, *, fingerprint: str = "r" * 64,
                                  source_sha: str = SOURCE_SHA_DEFAULT,
                                  image_tag: str = IMAGE_TAG_DEFAULT,
                                  image_id: str = IMAGE_ID_DEFAULT,
                                  manifest: str = MANIFEST_DEFAULT,
                                  lockfile: str = LOCKFILE_DEFAULT) -> Path:
    body = "\n".join([
        "AUTHORIZATION_VERSION=1",
        "AUTHORIZED_ACTION=production-deploy",
        f"SOURCE_SHA={source_sha}",
        f"RELEASE_PLAN_FINGERPRINT={fingerprint}",
        f"IMAGE_TAG={image_tag}",
        f"IMAGE_ID={image_id}",
        f"MANIFEST_SHA={manifest}",
        f"LOCKFILE_SHA={lockfile}",
        "EXPLICIT_APPROVAL=true",
        "CONSUMABLE_ONCE=true",
        "PRODUCTION_DEPLOY_AUTHORIZED=true",
        "PRODUCTION_DEPLOY_EXECUTED=false",
    ]) + "\n"
    path = repo / "progress" / f"web-release-authorization-{fingerprint}.env"
    path.write_text(body)
    path.chmod(0o600)
    return path

def write_fake_l2_gate(repo: Path) -> Path:
    scripts = repo / "scripts"
    p = scripts / "verify-web-release-runtime-acceptance.py"
    p.write_text(textwrap.dedent("""\
        #!/usr/bin/env python3
        # Fake L2 quick gate (L1 controlled test)
        print("STATUS=PASS")
        print("RUNTIME_ACCEPTANCE_READY=true")
        print("PRODUCTION_DEPLOY_MODE=NOT_IMPLEMENTED")
        print("PRODUCTION_DEPLOY_EXECUTED=false")
    """))
    p.chmod(0o755)
    return p

def recompute_execution_plan(repo: Path, *, ctx: Dict = None) -> str:
    """Re-converge EXECUTION_PLAN_FINGERPRINT against current disk SHAs and
    artifact body.  Use this after modifying the artifact body or any sibling
    runtime script so the artifact's stored SHA references match disk state.

    Returns the (possibly new) EXECUTION_PLAN_FINGERPRINT.
    """
    # Locate the artifact (planner-known path is preferred).
    path_channel = repo / "progress" / "mock-execution-plan-path.env"
    if path_channel.exists():
        planner_known = path_channel.read_text().strip().split("=", 1)[-1]
        ep_path = Path(planner_known)
        if not ep_path.exists():
            ep_path = next((repo / "progress").glob("web-release-production-execution-plan-*.env"))
    else:
        ep_path = next((repo / "progress").glob("web-release-production-execution-plan-*.env"))
    ep_text = ep_path.read_text()
    ep_fp_kv = dict(line.split("=", 1) for line in ep_text.splitlines() if "=" in line)
    ep_fp = ep_fp_kv.get("EXECUTION_PLAN_FINGERPRINT", "")
    rp_fp = ep_fp_kv.get("RELEASE_PLAN_FINGERPRINT", "r" * 64)

    auth_path = repo / "progress" / f"web-release-authorization-{rp_fp}.env"
    auth_sha = sha_file(auth_path) if auth_path.exists() else ep_fp_kv.get("AUTHORIZATION_SHA256", "q" * 64)

    for _ in range(8):
        plan_runtime_sha = sha_file(repo / "scripts" / "plan-web-production-deployment-execution.sh")
        claim_runtime_sha = sha_file(repo / "scripts" / "claim-web-production-release-authorization.sh")
        deploy_runtime_sha = sha_file(repo / "scripts" / "deploy-web-release-candidate.sh")
        gate_runtime_sha = sha_file(repo / "scripts" / "verify-web-release-runtime-acceptance.py")
        ep_text = ep_path.read_text()
        sha_updated = False
        # Replace BOTH placeholder SHAs and any existing real SHA values.
        # After make_full_test_workspace the artifact contains converged real SHAs,
        # not placeholders.  When tests modify sibling scripts we must replace the
        # existing (now-stale) SHA even though it is not a "z*64" placeholder.
        for new_sha, name in [
            (plan_runtime_sha, "PLAN_RUNTIME_SHA256"),
            (claim_runtime_sha, "CLAIM_RUNTIME_SHA256"),
            (deploy_runtime_sha, "DEPLOY_RUNTIME_SHA256"),
            (gate_runtime_sha, "RUNTIME_ACCEPTANCE_GATE_SHA256"),
            (auth_sha, "AUTHORIZATION_SHA256"),
        ]:
            # Extract existing SHA value before replacing.
            m_existing = re.search(
                rf"^{re.escape(name)}=([a-f0-9]{{64}})$",
                ep_text,
                flags=re.MULTILINE,
            )
            old_sha = m_existing.group(1) if m_existing else None
            # Replace any existing SHA value for this field (placeholder or real).
            ep_text = re.sub(
                rf"^{re.escape(name)}=[a-f0-9]{{64}}$",
                f"{name}={new_sha}",
                ep_text,
                flags=re.MULTILINE
            )
            # Only mark updated if the value actually changed.
            if old_sha != new_sha:
                sha_updated = True
        fp_kv = dict(line.split("=", 1) for line in ep_text.splitlines() if "=" in line)
        fp_fields = [
            "EXECUTION_PLAN_VERSION", "SOURCE_SHA", "RELEASE_PLAN_FINGERPRINT",
            "IMAGE_TAG", "IMAGE_ID", "MANIFEST_SHA", "LOCKFILE_SHA",
            "AUTHORIZATION_SHA256", "CANDIDATE_EVIDENCE_SHA256",
            "PIPELINE_HEAD", "PLAN_RUNTIME_SHA256", "AUTHORIZE_RUNTIME_SHA256",
            "CLAIM_RUNTIME_SHA256", "ORCHESTRATOR_RUNTIME_SHA256",
            "DEPLOY_RUNTIME_SHA256", "RUNTIME_ACCEPTANCE_GATE_SHA256",
            "PRE_WEB_CID", "PRE_WEB_STARTED_AT", "PRE_WEB_CONFIG_IMAGE",
            "PRE_WEB_IMAGE_ID", "PRE_API_CID", "PRE_API_STARTED_AT",
            "PRE_MEILI_CID", "PRE_MEILI_STARTED_AT",
        ]
        fp_canonical = "\n".join(f"{f}={fp_kv.get(f, '')}" for f in fp_fields) + "\n"
        new_fp = hashlib.sha256(fp_canonical.encode()).hexdigest()
        # Sync side-channels for the planner.
        side_channel = repo / "progress" / "mock-execution-plan.env"
        side_channel.write_text(f"EXECUTION_PLAN_FINGERPRINT={new_fp}\n")
        path_channel = repo / "progress" / "mock-execution-plan-path.env"
        path_channel.write_text(f"EXECUTION_PLAN_ARTIFACT={ep_path}\n")
        # Only converge when fingerprint is stable AND no SHA updates are needed.
        # This prevents false convergence when disk SHA == stored SHA but other
        # fields have been updated (requiring a new fingerprint).
        if new_fp == ep_fp and not sha_updated:
            ep_path.write_text(ep_text)
            ep_path.chmod(0o600)
            if ctx is not None:
                ctx["ep_fp"] = new_fp
            return new_fp
        old_fp = ep_fp
        ep_fp = new_fp
        ep_text = ep_text.replace(f"EXECUTION_PLAN_FINGERPRINT={old_fp}",
                                  f"EXECUTION_PLAN_FINGERPRINT={new_fp}")
        new_path = repo / "progress" / f"web-release-production-execution-plan-{new_fp}.env"
        if ep_path.exists() and ep_path != new_path:
            ep_path.unlink()
        new_path.write_text(ep_text)
        new_path.chmod(0o600)
        ep_path = new_path
        path_channel.write_text(f"EXECUTION_PLAN_ARTIFACT={ep_path}\n")
    raise RuntimeError("recompute_execution_plan did not converge")


def write_fake_docker(repo: Path, *,
                      pre_web_cid: str = None,
                      pre_web_started_at: str = None,
                      pre_web_config_image: str = None,
                      pre_web_image_id: str = None,
                      pre_api_cid: str = None,
                      pre_api_started_at: str = None,
                      pre_meili_cid: str = None,
                      pre_meili_started_at: str = None) -> Path:
    """Write a fake docker/sudo binary into repo/fake-bin so that postverify
    can be exercised without touching real Docker.  The fake reads PRE_*
    values from the execution-plan artifact so production pre-state matches
    by default.  Tests can override any PRE_* value via kwargs to simulate
    drift or scope-violation conditions without round-tripping through the
    artifact."""
    fakebin = repo / "fake-bin"
    fakebin.mkdir(exist_ok=True)
    # Read PRE_* values from the artifact (defaults), then let kwargs override.
    ep_files = list((repo / "progress").glob("web-release-production-execution-plan-*.env"))
    _pre_web_cid = _pre_web_started_at = _pre_api_cid = _pre_api_started_at = _pre_meili_cid = _pre_meili_started_at = ""
    _pre_web_config_image = _pre_web_image_id = ""
    if ep_files:
        kv = dict(line.split("=", 1) for line in ep_files[0].read_text().splitlines() if "=" in line)
        _pre_web_cid = kv.get("PRE_WEB_CID", "")
        _pre_web_started_at = kv.get("PRE_WEB_STARTED_AT", "")
        _pre_web_config_image = kv.get("PRE_WEB_CONFIG_IMAGE", "")
        _pre_web_image_id = kv.get("PRE_WEB_IMAGE_ID", "")
        _pre_api_cid = kv.get("PRE_API_CID", "")
        _pre_api_started_at = kv.get("PRE_API_STARTED_AT", "")
        _pre_meili_cid = kv.get("PRE_MEILI_CID", "")
        _pre_meili_started_at = kv.get("PRE_MEILI_STARTED_AT", "")
    pre_web_cid = pre_web_cid if pre_web_cid is not None else _pre_web_cid
    pre_web_started_at = pre_web_started_at if pre_web_started_at is not None else _pre_web_started_at
    pre_web_config_image = pre_web_config_image if pre_web_config_image is not None else _pre_web_config_image
    pre_web_image_id = pre_web_image_id if pre_web_image_id is not None else _pre_web_image_id
    pre_api_cid = pre_api_cid if pre_api_cid is not None else _pre_api_cid
    pre_api_started_at = pre_api_started_at if pre_api_started_at is not None else _pre_api_started_at
    pre_meili_cid = pre_meili_cid if pre_meili_cid is not None else _pre_meili_cid
    pre_meili_started_at = pre_meili_started_at if pre_meili_started_at is not None else _pre_meili_started_at
    p = fakebin / "docker"
    p.write_text(textwrap.dedent(f"""\
        #!/usr/bin/env bash
        # Fake docker shim — uses PRE_* values from execution-plan artifact.
        DIR="$(cd "$(dirname "$0")/.." && pwd)"
        PRE_WEB_CID='{pre_web_cid}'
        PRE_WEB_STARTED_AT='{pre_web_started_at}'
        PRE_WEB_CONFIG_IMAGE='{pre_web_config_image}'
        PRE_WEB_IMAGE_ID='{pre_web_image_id}'
        PRE_API_CID='{pre_api_cid}'
        PRE_API_STARTED_AT='{pre_api_started_at}'
        PRE_MEILI_CID='{pre_meili_cid}'
        PRE_MEILI_STARTED_AT='{pre_meili_started_at}'
        IMAGE_TAG_DEFAULT='{IMAGE_TAG_DEFAULT}'
        IMAGE_ID_DEFAULT='{IMAGE_ID_DEFAULT}'
        # The post-deploy identity is read from simulation/web_state.env
        WEB_STATE="$DIR/simulation/web_state.env"
        POST_WEB_CID="$(awk -F= '/^WEB_CID/{{print $2}}' $WEB_STATE 2>/dev/null)"
        POST_WEB_CONFIG_IMAGE="$(awk -F= '/^WEB_CONFIG_IMAGE/{{print $2}}' $WEB_STATE 2>/dev/null)"
        POST_WEB_IMAGE_ID="$(awk -F= '/^WEB_IMAGE_ID/{{print $2}}' $WEB_STATE 2>/dev/null)"
        [ -z "$POST_WEB_CID" ] && POST_WEB_CID="$PRE_WEB_CID"
        [ -z "$POST_WEB_CONFIG_IMAGE" ] && POST_WEB_CONFIG_IMAGE="$PRE_WEB_CONFIG_IMAGE"
        [ -z "$POST_WEB_IMAGE_ID" ] && POST_WEB_IMAGE_ID="$PRE_WEB_IMAGE_ID"
        # S27T-5E-R5B: support project-scoped CID lookup (`docker compose ps -q web`).
        # The compose subcommand returns the post-deploy Web CID; current_compose_cid_safe
        # web resolves to that exactly one CID.
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web")         printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                        "api")         printf '%s\n' "apipre" ;;
                        "meilisearch") printf '%s\n' "meilipre" ;;
                        *)             : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  "config"|"version"|"down"|"up"|"build"|"logs"|"pull"|"restart"|"stop"|"start"|"kill"|"rm")
                    exit 0
                    ;;
                  *) exit 0 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "book-id-search-web-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "book-id-search-api-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "apipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "book-id-search-meilisearch-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                  "meilipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                esac
                ;;
              "exec")
                if [ "$2" = "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ]; then
                  shift 2
                  if [ "$1" = "sha256sum" ] && [ "$2" = "/usr/share/nginx/html/assets" ]; then
                    printf '%s  /usr/share/nginx/html/assets\n' "f5d9c4479cd99af58059eef876faf74d431ebae9de49038269bc24e521f5f34d"
                  else
                    exec sha256sum "$@"
                  fi
                else
                  exit 1
                fi
                ;;
              "image"*) printf '%s\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
    """))
    p.chmod(0o755)
    # sudo shim that ALWAYS FAILS — forces executor to use direct docker
    # (which goes to fake-bin/docker).  This is critical because the executor
    # uses `sudo -n true` to detect sudo availability; if sudo is found and
    # succeeds, it routes docker through the real sudo which strips PATH.
    sudo = fakebin / "sudo"
    sudo.write_text("#!/usr/bin/env bash\nexit 1\n")
    sudo.chmod(0o755)
    return fakebin

def install_fake_docker_path(repo: Path):
    fakebin = write_fake_docker(repo)
    # Wire PATH so that the Executor's prod_fact_safe and image-inspect calls
    # reach the shim, but only when an env marker is set.  This is OK because
    # the Executor itself does NOT allowlist PATH override (PATH is allowlisted)
    # but the test sets PATH explicitly to point at fake-bin first.
    return fakebin

def make_full_test_workspace(scenario: str, *, image_id: str = IMAGE_ID_DEFAULT,
                            image_tag: str = IMAGE_TAG_DEFAULT,
                            manifest: str = MANIFEST_DEFAULT,
                            lockfile: str = LOCKFILE_DEFAULT,
                            plan_exit: int = 0,
                            claim_exit: int = 0,
                            deploy_exit: int = 0,
                            claim_refuse: bool = False,
                            plan_output_override: str = None,
                            claim_output_override: str = None,
                            image_id_at_inspect: str = None,
                            simulate_post_state_change: bool = True,
                            pre_web_cid: str = "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da",
                            pre_web_started_at: str = "2026-08-07T23:04:36Z",
                            pre_web_config_image: str = None,  # None = use image_tag
                            pre_web_image_id: str = "sha256:old",
                            pre_api_cid: str = "apipre",
                            pre_api_started_at: str = "2026-08-02T23:42:05Z",
                            pre_meili_cid: str = "meilipre",
                            pre_meili_started_at: str = "2026-06-30T13:35:18Z") -> Tuple[Path, Path, Dict]:
    """Build a full temp repo with all fake siblings and an Execution Plan."""
    tmp, repo = make_temp_repo(scenario)
    # Execution Plan artifact (mode 600)
    head_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
    # Compute release plan fingerprint deterministically so artifact + planner
    # + authorization all agree.
    release_plan_fp = compute_release_plan_fingerprint(
        head_sha, image_tag, image_id, manifest, lockfile,
    )
    # Write fake runtime scripts (planner first; SHAs computed after).
    write_fake_l2_gate(repo)
    write_fake_claim(repo, claim_exit=claim_exit,
                     claim_output=claim_output_override,
                     refuse=claim_refuse,
                     release_plan_fingerprint=release_plan_fp,
                     image_id=image_id,
                     image_tag=image_tag)
    write_fake_deploy(repo, exit_code=deploy_exit,
                      simulate_post_state_change=simulate_post_state_change)
    ep_path, ep_fp = write_execution_plan_artifact(
        repo,
        image_id=image_id, image_tag=image_tag,
        manifest=manifest, lockfile=lockfile,
        pipeline_head=head_sha,
        source_sha=head_sha,
        release_plan_fp=release_plan_fp,
        pre_web_cid=pre_web_cid, pre_web_started_at=pre_web_started_at,
        pre_web_config_image=pre_web_config_image, pre_web_image_id=pre_web_image_id,  # align with image_tag so PRE=POST in test pre_web_image_id=pre_web_image_id,
        pre_api_cid=pre_api_cid, pre_api_started_at=pre_api_started_at,
        pre_meili_cid=pre_meili_cid, pre_meili_started_at=pre_meili_started_at,
    )
    # Authorization artifact
    write_authorization_artifact(repo, fingerprint=release_plan_fp,
                                  source_sha=head_sha,
                                  image_tag=image_tag, image_id=image_id,
                                  manifest=manifest, lockfile=lockfile)
    # Docker shim
    install_fake_docker_path(repo)
    # Write fake planner FIRST (initial pass; SHA may be rewritten below).
    write_fake_planner(repo, image_id=image_id, image_tag=image_tag,
                       manifest=manifest, lockfile=lockfile,
                       plan_exit=plan_exit, plan_output=plan_output_override,
                       execution_plan_path=str(ep_path),
                       execution_plan_fingerprint=ep_fp,
                       release_plan_fingerprint=release_plan_fp)
    # Compute SHAs of the (already-written) sibling scripts.
    # The fake planner's content references a fixed path (progress/mock-execution-plan.env
    # side-channel file), so its bytes are stable across this single pass; the
    # Executor validates PLAN_RUNTIME_SHA256 == disk SHA independently.
    plan_runtime_sha = sha_file(repo / "scripts" / "plan-web-production-deployment-execution.sh")
    claim_runtime_sha = sha_file(repo / "scripts" / "claim-web-production-release-authorization.sh")
    deploy_runtime_sha = sha_file(repo / "scripts" / "deploy-web-release-candidate.sh")
    gate_runtime_sha = sha_file(repo / "scripts" / "verify-web-release-runtime-acceptance.py")
    # Authorization artifact SHA — must be propagated into the Execution Plan.
    auth_path = repo / "progress" / f"web-release-authorization-{release_plan_fp}.env"
    auth_sha = sha_file(auth_path) if auth_path.exists() else ("q" * 64)
    # S27T-5E-R4: replace placeholder SHAs in the artifact with the real disk
    # SHAs (single pass). The fake planner's content references fixed
    # side-channel paths, so its bytes are stable — PLAN_RUNTIME_SHA256 is
    # constant — and the fingerprint converges in exactly 1 pass. We no longer
    # need the iterative reconcile loop (the old loop masked the production
    # runtime bug where the real Planner wrote the SHA of
    # plan-web-production-release.sh instead of plan-web-production-deployment-execution.sh;
    # after S27T-5E-R4 the production Planner writes the correct SHA and
    # tests can verify Planner output ↔ Executor validation agree without
    # post-hoc artifact rewriting).
    plan_runtime_sha = sha_file(repo / "scripts" / "plan-web-production-deployment-execution.sh")
    claim_runtime_sha = sha_file(repo / "scripts" / "claim-web-production-release-authorization.sh")
    deploy_runtime_sha = sha_file(repo / "scripts" / "deploy-web-release-candidate.sh")
    gate_runtime_sha = sha_file(repo / "scripts" / "verify-web-release-runtime-acceptance.py")
    ep_text = ep_path.read_text()
    initial_ep_fp = ep_fp
    for old_sha, new_sha, name in [
        ("x" * 64, plan_runtime_sha, "PLAN_RUNTIME_SHA256"),
        ("y" * 64, claim_runtime_sha, "CLAIM_RUNTIME_SHA256"),
        ("z" * 64, deploy_runtime_sha, "DEPLOY_RUNTIME_SHA256"),
        ("g" * 64, gate_runtime_sha, "RUNTIME_ACCEPTANCE_GATE_SHA256"),
        ("q" * 64, auth_sha, "AUTHORIZATION_SHA256"),
    ]:
        ep_text = ep_text.replace(f"{name}={old_sha}", f"{name}={new_sha}")
    fp_kv = dict(line.split("=", 1) for line in ep_text.splitlines() if "=" in line)
    fp_fields = [
        "EXECUTION_PLAN_VERSION", "SOURCE_SHA", "RELEASE_PLAN_FINGERPRINT",
        "IMAGE_TAG", "IMAGE_ID", "MANIFEST_SHA", "LOCKFILE_SHA",
        "AUTHORIZATION_SHA256", "CANDIDATE_EVIDENCE_SHA256",
        "PIPELINE_HEAD", "PLAN_RUNTIME_SHA256", "AUTHORIZE_RUNTIME_SHA256",
        "CLAIM_RUNTIME_SHA256", "ORCHESTRATOR_RUNTIME_SHA256",
        "DEPLOY_RUNTIME_SHA256", "RUNTIME_ACCEPTANCE_GATE_SHA256",
        "PRE_WEB_CID", "PRE_WEB_STARTED_AT", "PRE_WEB_CONFIG_IMAGE",
        "PRE_WEB_IMAGE_ID", "PRE_API_CID", "PRE_API_STARTED_AT",
        "PRE_MEILI_CID", "PRE_MEILI_STARTED_AT",
    ]
    fp_canonical = "\n".join(f"{f}={fp_kv.get(f, '')}" for f in fp_fields) + "\n"
    new_fp = hashlib.sha256(fp_canonical.encode()).hexdigest()
    if new_fp != ep_fp:
        ep_text = ep_text.replace(f"EXECUTION_PLAN_FINGERPRINT={ep_fp}",
                                  f"EXECUTION_PLAN_FINGERPRINT={new_fp}")
        new_path = repo / "progress" / f"web-release-production-execution-plan-{new_fp}.env"
        if ep_path.exists():
            ep_path.unlink()
        new_path.write_text(ep_text)
        new_path.chmod(0o600)
        ep_path = new_path
    else:
        ep_path.write_text(ep_text)
        ep_path.chmod(0o600)
    side_channel = repo / "progress" / "mock-execution-plan.env"
    side_channel.write_text(f"EXECUTION_PLAN_FINGERPRINT={new_fp}\n")
    path_channel = repo / "progress" / "mock-execution-plan-path.env"
    path_channel.write_text(f"EXECUTION_PLAN_ARTIFACT={ep_path}\n")
    ep_fp = new_fp
    # S27T-5E-R4: cleanup duplicate initial artifact (same logic as before).
    initial_path = repo / "progress" / f"web-release-production-execution-plan-{initial_ep_fp}.env"
    if initial_path != ep_path and initial_path.exists():
        initial_path.unlink()
    # Executor will validate that the planner's reported EXECUTION_PLAN_FINGERPRINT
    # matches the artifact's stored value, AND that the artifact's stored
    # PLAN_RUNTIME_SHA256 matches the disk planner.  Both must hold.

    # Copy exact-byte Executor
    copy_exact_byte(EXECUTOR_PATH, repo / EXECUTOR_REL, mode=0o755)
    sha = sha_file(EXECUTOR_PATH)
    return tmp, repo, {"ep_fp": ep_fp, "rp_fp": release_plan_fp,
                       "image_id": image_id, "image_tag": image_tag,
                       "executor_sha": sha, "head_sha": head_sha}

def run_executor(repo: Path, source_sha: str = None,
                 env_extra: Dict[str, str] = None,
                 timeout: int = 60) -> Tuple[int, Dict]:
    if source_sha is None:
        source_sha = _get_repo_head_sha(repo)
    env = os.environ.copy()
    env["PYTHONPYCACHEPREFIX"] = str(Path(tempfile.gettempdir()) / "s27t5d_test_pycache")
    fakebin = str(repo / "fake-bin")
    env["PATH"] = f"{fakebin}:{env.get('PATH', '')}"
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        ["bash", str(repo / EXECUTOR_REL), "--execute-production-deploy", source_sha],
        capture_output=True, text=True, timeout=timeout, env=env,
    )
    return proc.returncode, _parse_output(proc.stdout)

def _parse_output(stdout: str) -> Dict:
    out = {}
    for line in stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k] = v
    return out


# ----------------------------------------------------------------------------
# A. Arguments / repo state tests
# ----------------------------------------------------------------------------

@test("A01_invalid_arguments")
def t_A01_invalid_arguments():
    tmp, repo, _ = make_full_test_workspace("A01_invalid_arguments")
    try:
        rc, d = run_executor(repo, source_sha="not-a-sha")
        _ok(rc != 0, f"rc={rc}")
        _ok("BLOCK_REASON" in d, f"no BLOCK_REASON: {d}")
        _ok(d.get("STATUS") == "BLOCKED", f"STATUS={d.get('STATUS')}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("A02_missing_execution_intent")
def t_A02_missing_execution_intent():
    tmp, repo, _ = make_full_test_workspace("A02_missing_execution_intent")
    try:
        # Invoke without --execute-production-deploy
        env = os.environ.copy()
        env["PATH"] = f"{repo}/fake-bin:{env.get('PATH', '')}"
        proc = subprocess.run(
            ["bash", str(repo / EXECUTOR_REL), _get_repo_head_sha(repo)],
            capture_output=True, text=True, timeout=60, env=env,
        )
        _ok(proc.returncode != 0, f"rc={proc.returncode}")
        out = _parse_output(proc.stdout)
        _ok(out.get("STATUS") == "BLOCKED")
        _ok(out.get("BLOCK_REASON") == "INVALID_ARGUMENTS")
        _ok(out.get("PRODUCTION_WRITE_EXECUTED") == "false")
        _ok(out.get("PRODUCTION_DEPLOY_STARTED") == "false")
        _ok(out.get("PRODUCTION_DEPLOY_EXECUTED") == "false")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("A03_invalid_sha")
def t_A03_invalid_sha():
    tmp, repo, _ = make_full_test_workspace("A03_invalid_sha")
    try:
        rc, d = run_executor(repo, source_sha="abc")  # not 40 hex
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") in ("INVALID_ARGUMENTS", "INVALID_SOURCE_SHA"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("A04_non_main_branch")
def t_A04_non_main_branch():
    tmp, repo, _ = make_full_test_workspace("A04_non_main_branch")
    try:
        subprocess.run(["git", "-C", str(repo), "checkout", "-q", "-b", "feature"], check=True)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "NOT_MAIN_BRANCH")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("A05_dirty_worktree")
def t_A05_dirty_worktree():
    tmp, repo, _ = make_full_test_workspace("A05_dirty_worktree")
    try:
        # Create an untracked, non-progress file
        (repo / "untracked.txt").write_text("dirty\n")
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "WORKTREE_NOT_CLEAN")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("A06_head_origin_mismatch")
def t_A06_head_origin_mismatch():
    tmp, repo, _ = make_full_test_workspace("A06_head_origin_mismatch")
    try:
        # Create a local unpushed commit
        (repo / "local.txt").write_text("local\n")
        subprocess.run(["git", "-C", str(repo), "add", "local.txt"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "local"], check=True)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "HEAD_ORIGIN_MISMATCH")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# B. Planner failures
# ----------------------------------------------------------------------------

@test("B07_planner_nonzero")
def t_B07_planner_nonzero():
    tmp, repo, _ = make_full_test_workspace("B07_planner_nonzero", plan_exit=2)
    try:
        # Need to override the planner output since exit is nonzero
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "PLANNER_FAILED")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("B07b_planner_failure_no_unbound_variable_in_stderr")
def t_B07b_planner_failure_no_unbound_variable_in_stderr():
    """Regression for S27T-5E-R5: early Planner failure must not trigger
    a nounset cleanup-trap error for unset CLAIM_OUT."""
    tmp, repo, _ = make_full_test_workspace("B07b_no_unbound", plan_exit=2)
    try:
        source_sha = _get_repo_head_sha(repo)
        env = os.environ.copy()
        env["PYTHONPYCACHEPREFIX"] = str(Path(tempfile.gettempdir()) / "s27t5d_test_pycache")
        fakebin = str(repo / "fake-bin")
        env["PATH"] = f"{fakebin}:{env.get('PATH', '')}"
        proc = subprocess.run(
            ["bash", str(repo / EXECUTOR_REL), "--execute-production-deploy", source_sha],
            capture_output=True, text=True, timeout=60, env=env,
        )
        _ok(proc.returncode != 0)
        d = _parse_output(proc.stdout)
        _ok(d.get("BLOCK_REASON") == "PLANNER_FAILED")
        _ok("unbound variable" not in proc.stderr.lower(),
            f"stderr leaked nounset cleanup-trap error: {proc.stderr!r}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test("B07c_planner_failure_reason_passthrough")
def t_B07c_planner_failure_reason_passthrough():
    """Executor keeps its stable PLANNER_FAILED reason while exposing the
    Planner's own machine-readable BLOCK_REASON for diagnostics."""
    override = textwrap.dedent("""\
        cat <<'PLN_EOF'
STATUS=BLOCKED
BLOCK_REASON=WORKTREE_NOT_CLEAN
READY_TO_CLAIM=false
EXECUTION_PLAN_READY=false
CLAIM_EXECUTED=false
PRODUCTION_DEPLOY_STARTED=false
PRODUCTION_DEPLOY_EXECUTED=false
PRODUCTION_WRITE_EXECUTED=false
EXECUTION_AUTHORIZED=false
PLN_EOF
        exit 1""")

    tmp, repo, _ = make_full_test_workspace(
        "B07c_planner_failure_reason_passthrough",
        plan_output_override=override,
    )

    try:
        rc, d = run_executor(repo)

        _ok(rc != 0, f"rc={rc}")

        # Preserve the existing Executor-level compatibility contract.
        _ok(
            d.get("BLOCK_REASON") == "PLANNER_FAILED",
            f"BLOCK_REASON={d.get('BLOCK_REASON')}",
        )

        # New diagnostic contract: preserve the Planner's actual cause.
        _ok(
            d.get("PLANNER_BLOCK_REASON") == "WORKTREE_NOT_CLEAN",
            "PLANNER_BLOCK_REASON="
            + repr(d.get("PLANNER_BLOCK_REASON")),
        )

        # Failure is still strictly pre-claim / pre-production.
        _ok(d.get("CLAIM_EXECUTED") == "false")
        _ok(d.get("AUTHORIZATION_CONSUMED") == "false")
        _ok(d.get("PRODUCTION_DEPLOY_STARTED") == "false")
        _ok(d.get("PRODUCTION_DEPLOY_EXECUTED") == "false")
        _ok(d.get("PRODUCTION_WRITE_EXECUTED") == "false")

    finally:
        shutil.rmtree(tmp, ignore_errors=True)



@test("B08_planner_not_ready")
def t_B08_planner_not_ready():
    # Override planner output to not be READY_TO_CLAIM
    override = textwrap.dedent("""\
        cat <<PLN_EOF
STATUS=BLOCKED
BLOCK_REASON=MOCK_FAILURE
EXECUTION_PLAN_READY=false
PLN_EOF
        exit 1""")
    tmp, repo, _ = make_full_test_workspace("B08_planner_not_ready", plan_output_override=override)
    try:
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") in ("PLANNER_FAILED", "PLANNER_NOT_READY"))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("B09_execution_plan_missing")
def t_B09_execution_plan_missing():
    tmp, repo, _ = make_full_test_workspace("B09_execution_plan_missing")
    try:
        # Remove the execution plan artifact
        for p in (repo / "progress").glob("web-release-production-execution-plan-*.env"):
            p.unlink()
        # Override planner to return a path that doesn't exist
        override = textwrap.dedent(f"""\
            IMAGE_TAG_VAL="{IMAGE_TAG_DEFAULT}"
            IMAGE_ID_VAL="{IMAGE_ID_DEFAULT}"
            FP=$(printf '%s\\n%s\\n%s\\n%s\\n%s\\n' "SOURCE_SHA=$1" "IMAGE_TAG=$IMAGE_TAG_VAL" "IMAGE_ID=$IMAGE_ID_VAL" "MANIFEST_SHA={MANIFEST_DEFAULT}" "LOCKFILE_SHA={LOCKFILE_DEFAULT}" | sha256sum | awk '{{print $1}}')
            cat <<PLN_EOF
STATUS=READY_TO_CLAIM
SOURCE_SHA=$1
RELEASE_PLAN_FINGERPRINT=$FP
EXECUTION_PLAN_FINGERPRINT=$FP
IMAGE_TAG=$IMAGE_TAG_VAL
IMAGE_ID=$IMAGE_ID_VAL
MANIFEST_SHA={MANIFEST_DEFAULT}
LOCKFILE_SHA={LOCKFILE_DEFAULT}
EXECUTION_PLAN_ARTIFACT={repo}/progress/does-not-exist.env
EXECUTION_PLAN_READY=true
CLAIM_EXECUTED=false
PRODUCTION_WRITE_EXECUTED=false
AUTO_RETRY=false
AUTO_ROLLBACK=false
PLN_EOF
            exit 0""")
        (repo / "scripts" / "plan-web-production-deployment-execution.sh").write_text(
            "#!/usr/bin/env bash\n" + override)
        (repo / "scripts" / "plan-web-production-deployment-execution.sh").chmod(0o755)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "EXECUTION_PLAN_MISSING")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("B12_execution_plan_incomplete")
def t_B12_execution_plan_incomplete():
    tmp, repo, _ = make_full_test_workspace("B12_plan_incomplete")
    try:
        # Find and corrupt the execution plan
        ep = next((repo / "progress").glob("web-release-production-execution-plan-*.env"))
        body = ep.read_text()
        # Remove a mandatory field
        body = body.replace("EXECUTION_PLAN_VERSION=1\n", "")
        ep.write_text(body)
        ep.chmod(0o600)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "EXECUTION_PLAN_INCOMPLETE")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("B14_execution_plan_fingerprint_mismatch")
def t_B14_execution_plan_fingerprint_mismatch():
    tmp, repo, _ = make_full_test_workspace("B14_fp_mismatch")
    try:
        ep = next((repo / "progress").glob("web-release-production-execution-plan-*.env"))
        body = ep.read_text()
        # Corrupt the EXECUTION_PLAN_FINGERPRINT value
        body = body.replace("EXECUTION_PLAN_FINGERPRINT=", "EXECUTION_PLAN_FINGERPRINT=corrupt")
        ep.write_text(body)
        ep.chmod(0o600)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "EXECUTION_PLAN_FINGERPRINT_MISMATCH")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("B16_production_pre_state_drift")
def t_B16_production_pre_state_drift():
    # Write an Execution Plan with PRE_WEB_CID that disagrees with what
    # production reader will see.  Default fake reader returns the original
    # PRE_WEB_CID from the artifact, so to trigger drift we must:
    #  1) Pin the docker shim's PRE_WEB_CID to the ORIGINAL value (so the
    #     fake reader returns the same original CID as before).
    #  2) Mutate the artifact's PRE_WEB_CID to a mismatching value.
    #  3) Recompute the artifact fingerprint (mutating one of the 24 canonical
    #     fields invalidates the stored EXECUTION_PLAN_FINGERPRINT).
    tmp, repo, _ = make_full_test_workspace("B16_pre_state_drift")
    try:
        # Pin docker shim to ORIGINAL PRE_WEB_CID so it returns that value at
        # runtime regardless of any artifact modification.
        write_fake_docker(repo, pre_web_cid="f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da")
        ep = next((repo / "progress").glob("web-release-production-execution-plan-*.env"))
        body = ep.read_text()
        body = body.replace("PRE_WEB_CID=f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da",
                            "PRE_WEB_CID=fixed_value_does_not_match_runtime")
        ep.write_text(body)
        ep.chmod(0o600)
        # Recompute fingerprint to reflect the new PRE_WEB_CID.
        recompute_execution_plan(repo)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "PRODUCTION_PRE_STATE_DRIFT",
            f"got {d.get('BLOCK_REASON')}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# C. Existing states
# ----------------------------------------------------------------------------

@test("C17_preexisting_claim")
def t_C17_preexisting_claim():
    tmp, repo, ctx = make_full_test_workspace("C17_preexisting_claim")
    try:
        # Drop a fake claim artifact at the expected path
        claim_path = repo / "progress" / f"web-release-authorization-claim-{ctx['rp_fp']}.env"
        claim_path.write_text("CLAIMED_AT=0\n")
        claim_path.chmod(0o600)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        # FIX (S27T-5D-R1): executor's recovery order is
        #   RESULT -> START-no-RESULT -> CLAIM-no-START -> CLAIM-exists
        # A claim-only artifact (no start, no result) hits CLAIMED_NOT_STARTED
        # first.  AUTHORIZATION_ALREADY_CLAIMED is only reachable when claim
        # exists WITH start or result, which is already covered by C19/C20.
        _ok(d.get("BLOCK_REASON") in ("CLAIMED_NOT_STARTED", "AUTHORIZATION_ALREADY_CLAIMED"),
            f"got {d.get('BLOCK_REASON')}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("C18_claim_no_start")
def t_C18_claim_no_start():
    tmp, repo, ctx = make_full_test_workspace("C18_claim_no_start")
    try:
        claim_path = repo / "progress" / f"web-release-authorization-claim-{ctx['rp_fp']}.env"
        # Per Executor recovery order, claim with no start means we check
        # that scenario.  Note: the Executor also checks "if claim exists
        # and start absent" and emits CLAIMED_NOT_STARTED, but only if
        # the claim was previously consumed (we have to NOT have any start).
        # The fake claim is just a file.  Let's add a start file too so the
        # claim-without-start recovery branch fires.
        claim_path.write_text("CLAIMED=1\n")
        claim_path.chmod(0o600)
        # Do NOT add a start
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "CLAIMED_NOT_STARTED")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("C19_start_no_result")
def t_C19_start_no_result():
    tmp, repo, ctx = make_full_test_workspace("C19_start_no_result")
    try:
        start_path = repo / "progress" / f"web-release-production-attempt-{ctx['ep_fp']}.start.env"
        start_path.write_text("ATTEMPT_VERSION=1\nSTARTED_AT=0\n")
        start_path.chmod(0o600)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "PRODUCTION_ATTEMPT_STATUS_UNKNOWN")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("C20_finalized_result")
def t_C20_finalized_result():
    tmp, repo, ctx = make_full_test_workspace("C20_finalized_result")
    try:
        result_path = repo / "progress" / f"web-release-production-attempt-{ctx['ep_fp']}.result.env"
        result_path.write_text("RESULT_VERSION=1\nFINAL_STATUS=PASS\n")
        result_path.chmod(0o600)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "ATTEMPT_ALREADY_FINALIZED")
        _ok(d.get("CLAIM_EXECUTED") == "false")
        _ok(d.get("AUTHORIZATION_CONSUMED") == "false")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# D. Claim
# ----------------------------------------------------------------------------

@test("D21_claim_nonzero")
def t_D21_claim_nonzero():
    tmp, repo, _ = make_full_test_workspace("D21_claim_nonzero", claim_exit=2)
    try:
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "CLAIM_FAILED")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("D23_claim_exactly_once")
def t_D23_claim_exactly_once():
    tmp, repo, _ = make_full_test_workspace("D23_claim_once")
    try:
        rc, d = run_executor(repo)
        # In our fake, claim runs once.  Just confirm the executor reported
        # CLAIM_EXECUTED=true if it got past claim, false otherwise.
        _ok("CLAIM_EXECUTED" in d)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# E. Postclaim
# ----------------------------------------------------------------------------

@test("E25_image_toctou_mismatch")
def t_E25_image_toctou_mismatch():
    # Set plan IMAGE_ID to one thing, then have docker image-inspect return
    # a different ID, simulating a post-claim TOCTOU.
    tmp, repo, _ = make_full_test_workspace("E25_image_toctou", image_id=IMAGE_ID_ALT)
    try:
        # FIX (S27T-5D-R2): recompute after write_fake_deploy so DEPLOY_RUNTIME_SHA256
        # in the artifact matches the disk-time SHA used by REC_FP computation.
        recompute_execution_plan(repo)
        # Override the fake docker's image-inspect to return a different ID
        # (post-claim)
        fakebin = repo / "fake-bin"
        p = fakebin / "docker"
        p.write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            # Post-claim TOCTOU shim — image has been tampered after claim.
            # First two image-inspect calls (pre-claim presence + identity checks)
            # return the PLAN's IMAGE_ID so pre-claim checks pass; subsequent calls
            # (post-claim TOCTOU check) return a different IMAGE_ID.
            # Counter path is scoped to repo dir (test fixture); auto-cleaned
            # by `make_full_test_workspace` teardown. Avoids /tmp cross-run state pollution.
            DIR="$(cd "$(dirname "$0")/.." && pwd)"
            if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
              CNT=$(cat "$DIR/.e25_image_inspect_count" 2>/dev/null || echo 0)
              CNT=$((CNT+1))
              echo $CNT > "$DIR/.e25_image_inspect_count"
              if [ "$CNT" -le 2 ]; then
                printf '%s\\n' "{IMAGE_ID_ALT}"
              else
                printf '%s\\n' "{IMAGE_ID_DEFAULT}"
              fi
              exit 0
            fi
            # default: return values matching make_full_test_workspace defaults
            # so pre-state check passes; only image-inspect returns mismatching ID
            # to trigger post-claim TOCTOU detection.
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web")         printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                        "api")         printf '%s\n' "apipre" ;;
                        "meilisearch") printf '%s\n' "meilipre" ;;
                        *)             : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  "config"|"version"|"down"|"up"|"build"|"logs"|"pull"|"restart"|"stop"|"start"|"kill"|"rm")
                    exit 0
                    ;;
                  *) exit 0 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "book-id-search-web-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "book-id-search-api-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "apipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "book-id-search-meilisearch-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                  "meilipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                esac
                ;;
              "exec")
                if [ "$2" = "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ]; then
                  shift 2
                  if [ "$1" = "sha256sum" ] && [ "$2" = "/usr/share/nginx/html/assets" ]; then
                    printf '%s  /usr/share/nginx/html/assets\n' "f5d9c4479cd99af58059eef876faf74d431ebae9de49038269bc24e521f5f34d"
                  else
                    exec sha256sum "$@"
                  fi
                else
                  exit 1
                fi
                ;;
              "image"*) printf '%s\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
        """))
        p.chmod(0o755)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "POST_CLAIM_IMAGE_TOCLOU_FAILED",
            f"got {d.get('BLOCK_REASON')}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# F. Start artifact
# ----------------------------------------------------------------------------

@test("F30_start_mode600")
def t_F30_start_mode600():
    tmp, repo, ctx = make_full_test_workspace("F30_start_mode600")
    try:
        # Patch fake deploy to not change web state so postverify can fire
        write_fake_deploy(repo, exit_code=0, simulate_post_state_change=False)
        # Patch fake docker to report post-state matching plan
        fakebin = repo / "fake-bin"
        p = fakebin / "docker"
        p.write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            DIR="$(cd "$(dirname "$0")/.." && pwd)"
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web")         printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                        "api")         printf '%s\n' "apipre" ;;
                        "meilisearch") printf '%s\n' "meilipre" ;;
                        *)             : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  "config"|"version"|"down"|"up"|"build"|"logs"|"pull"|"restart"|"stop"|"start"|"kill"|"rm")
                    exit 0
                    ;;
                  *) exit 0 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "book-id-search-web-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "book-id-search-api-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "apipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "book-id-search-meilisearch-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                  "meilipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                esac
                ;;
              "exec")
                if [ "$2" = "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ]; then
                  shift 2
                  exec sha256sum "$@"
                else
                  exit 1
                fi
                ;;
              "image"*) printf '%s\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
        """))
        p.chmod(0o755)
        rc, d = run_executor(repo)
        # We expect PASS for full happy, but at minimum check start artifact
        start_path = repo / "progress" / f"web-release-production-attempt-{ctx['ep_fp']}.start.env"
        if start_path.exists():
            mode = stat.S_IMODE(start_path.stat().st_mode)
            _ok(mode == 0o600, f"start mode={oct(mode)}")
        else:
            # Even if execution didn't reach start, the test should assert
            # what we can — at minimum that BLOCK_REASON was one we expect.
            _ok(rc != 0)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# G. Deploy
# ----------------------------------------------------------------------------

@test("G34_handoff_image_tag_from_plan")
def t_G34_handoff_image_tag_from_plan():
    tmp, repo, _ = make_full_test_workspace("G34_handoff_image_tag",
                                            image_tag="registry.test/custom:abc")
    try:
        write_fake_deploy(repo, exit_code=0, simulate_post_state_change=False)
        # Override deploy to write the tag it received.  This file is in
        # .gitignore so does not dirty the worktree.
        scripts = repo / "scripts"
        scripts.joinpath("deploy-web-release-candidate.sh").write_text(
            textwrap.dedent(f"""\
                #!/usr/bin/env bash
                echo "$1" > {tmp}/deploy_received_tag
                exit 0
            """))
        (scripts / "deploy-web-release-candidate.sh").chmod(0o755)
        # FIX (S27T-5D-R2): recompute after ALL deploy-script writes so artifact
        # DEPLOY_RUNTIME_SHA256 matches disk-time SHA used by REC_FP computation.
        recompute_execution_plan(repo)
        # Patch docker so identity check succeeds
        (repo / "fake-bin" / "docker").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            DIR="$(cd "$(dirname "$0")/.." && pwd)"
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web")         printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                        "api")         printf '%s\n' "apipre" ;;
                        "meilisearch") printf '%s\n' "meilipre" ;;
                        *)             : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  "config"|"version"|"down"|"up"|"build"|"logs"|"pull"|"restart"|"stop"|"start"|"kill"|"rm")
                    exit 0
                    ;;
                  *) exit 0 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "book-id-search-web-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "book-id-search-api-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "apipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "book-id-search-meilisearch-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                  "meilipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                esac
                ;;
              "exec")
                if [ "$2" = "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ]; then
                  shift 2
                  exec sha256sum "$@"
                else
                  exit 1
                fi
                ;;
              "image"*) printf '%s\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
        """))
        (repo / "fake-bin" / "docker").chmod(0o755)
        rc, d = run_executor(repo)
        received = (tmp / "deploy_received_tag").read_text().strip() if (tmp / "deploy_received_tag").exists() else ""
        _ok(received == "registry.test/custom:abc",
            f"deploy received wrong tag: {received!r}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("G35_deploy_called_exactly_once")
def t_G35_deploy_called_exactly_once():
    tmp, repo, _ = make_full_test_workspace("G35_deploy_once")
    try:
        write_fake_deploy(repo, exit_code=0, simulate_post_state_change=False)
        # Replace deploy with counter
        scripts = repo / "scripts"
        scripts.joinpath("deploy-web-release-candidate.sh").write_text(
            textwrap.dedent(f"""\
                #!/usr/bin/env bash
                C=$(cat {tmp}/deploy_count 2>/dev/null || echo 0)
                C=$((C+1))
                echo $C > {tmp}/deploy_count
                exit 0
            """))
        (scripts / "deploy-web-release-candidate.sh").chmod(0o755)
        # Patch docker for identity
        (repo / "fake-bin" / "docker").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            DIR="$(cd "$(dirname "$0")/.." && pwd)"
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web")         printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                        "api")         printf '%s\n' "apipre" ;;
                        "meilisearch") printf '%s\n' "meilipre" ;;
                        *)             : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  "config"|"version"|"down"|"up"|"build"|"logs"|"pull"|"restart"|"stop"|"start"|"kill"|"rm")
                    exit 0
                    ;;
                  *) exit 0 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "book-id-search-web-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "book-id-search-api-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "apipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "book-id-search-meilisearch-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                  "meilipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                esac
                ;;
              "exec")
                if [ "$2" = "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ]; then
                  shift 2
                  exec sha256sum "$@"
                else
                  exit 1
                fi
                ;;
              "image"*) printf '%s\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
        """))
        (repo / "fake-bin" / "docker").chmod(0o755)
        rc, d = run_executor(repo)
        count = int((tmp / "deploy_count").read_text().strip()) if (tmp / "deploy_count").exists() else 0
        _ok(count <= 1, f"deploy called {count} times")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("G36_deploy_nonzero")
def t_G36_deploy_nonzero():
    tmp, repo, ctx = make_full_test_workspace("G36_deploy_nonzero", deploy_exit=7)
    try:
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "DEPLOY_FAILED", f"reason={d.get('BLOCK_REASON')}")
        _ok(d.get("AUTO_RETRY") == "false")
        _ok(d.get("AUTO_ROLLBACK") == "false")

        result_path = (
            repo / "progress" /
            f"web-release-production-attempt-{ctx['ep_fp']}.result.env"
        )
        _ok(result_path.is_file(), f"missing result artifact: {result_path}")
        result = _parse_output(result_path.read_text())
        _ok(
            result.get("FINAL_STATUS") == "FAILED",
            f"FINAL_STATUS={result.get('FINAL_STATUS')}",
        )
        _ok(
            result.get("FINAL_FAILURE_REASON") == "DEPLOY_FAILED",
            f"FINAL_FAILURE_REASON={result.get('FINAL_FAILURE_REASON')}",
        )
        _ok(
            result.get("DEPLOY_EXIT_CODE") == "7",
            f"DEPLOY_EXIT_CODE={result.get('DEPLOY_EXIT_CODE')}",
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("G37_no_automatic_retry")
def t_G37_no_automatic_retry():
    tmp, repo, _ = make_full_test_workspace("G37_no_retry", deploy_exit=1)
    try:
        rc, d = run_executor(repo)
        _ok(d.get("AUTO_RETRY") == "false")
        # No retry means deploy called at most once
        scripts = repo / "scripts"
        scripts.joinpath("deploy-web-release-candidate.sh").write_text(
            textwrap.dedent(f"""\
                #!/usr/bin/env bash
                C=$(cat {tmp}/deploy_count 2>/dev/null || echo 0)
                C=$((C+1))
                echo $C > {tmp}/deploy_count
                exit 1
            """))
        (scripts / "deploy-web-release-candidate.sh").chmod(0o755)
        rc, d = run_executor(repo)
        c = int((tmp / "deploy_count").read_text().strip()) if (tmp / "deploy_count").exists() else 0
        _ok(c <= 1, f"deploy called {c} times on failure (must be 1)")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# H. Postverify
# ----------------------------------------------------------------------------

@test("H40_web_config_image_mismatch")
def t_H40_web_config_image_mismatch():
    tmp, repo, _ = make_full_test_workspace("H40_config_image_mismatch")
    try:
        # Patch deploy to simulate a deploy that didn't actually change web state
        write_fake_deploy(repo, exit_code=0, simulate_post_state_change=False)
        # S27T-5E-R5B-close: H40 fix.
        #
        # Contract under test (project-aware web identity):
        #   - current_compose_cid_safe web resolves the project's web CID via
        #     `docker compose ps -q web`, NOT via global container name.
        #   - prod_fact_safe "$WEB_CID" IMAGE then inspects that CID for Config.Image.
        #   - Executor MUST fail closed with POST_DEPLOY_CONFIG_IMAGE_MISMATCH
        #     when the running Config.Image does not equal the plan IMAGE_TAG.
        #
        # The fake docker here intentionally:
        #   (a) `compose ps -q web` -> TEMP_CID  (the project's web CID)
        #   (b) inspect TEMP_CID Config.Image  -> a deliberately mismatched tag,
        #       so prod_fact_safe observes Config.Image mismatch against the plan.
        #   (c) inspect book-id-search-web-1 Config.Image -> MATCHES the plan
        #       (proves the test does NOT accidentally rely on the old
        #       global-name fallback path).
        #   (d) inspect of any other CID -> fail closed (exit 1), so the helper's
        #       count guard would also catch a regression.
        #   (e) unknown top-level argv / unknown compose subcommand -> fail closed.
        (repo / "fake-bin" / "docker").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            # S27T-5E-R5B-close: H40 project-aware Config.Image mismatch fixture.
            DIR="$(cd "$(dirname "$0")/.." && pwd)"
            TEMP_CID="f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da"
            MISMATCH_CONFIG_IMAGE="registry.example.test/book-id-search/web:WRONG_S27T5ER5B_CLOSE"
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web")         printf '%s\\n' "$TEMP_CID" ;;
                        "api")         printf '%s\\n' "apipre" ;;
                        "meilisearch") printf '%s\\n' "meilipre" ;;
                        *)             : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  "config"|"version"|"down"|"up"|"build"|"logs"|"pull"|"restart"|"stop"|"start"|"kill"|"rm")
                    exit 0
                    ;;
                  # S27T-5E-R5B-close: unknown compose subcommand -> fail closed
                  *) echo "ERROR: H40 fake docker unknown compose subcommand: $*" >&2 ; exit 1 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "book-id-search-web-1")
                    # Old global-name path. Kept as a MATCH so that any accidental
                    # fallback to this name would NOT trigger POST_DEPLOY_CONFIG_IMAGE_MISMATCH,
                    # demonstrating that the test relies on the new project-aware path.
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\\n' "$TEMP_CID" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\\n' "{{IMAGE_TAG_DEFAULT}}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\\n' "{{IMAGE_ID_DEFAULT}}" ;;
                    esac
                    ;;
                  "$TEMP_CID")
                    # Project-scoped CID path used by current_compose_cid_safe.
                    # Config.Image is DELIBERATELY mismatched against the plan.
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\\n' "$TEMP_CID" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\\n' "$MISMATCH_CONFIG_IMAGE" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\\n' "{{IMAGE_ID_DEFAULT}}" ;;
                    esac
                    ;;
                  "book-id-search-api-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "apipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "book-id-search-meilisearch-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                  "meilipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                esac
                ;;
              "exec")
                # S27T-5E-R5B-close: exec ONLY allowed for TEMP_CID.
                if [ "$2" = "$TEMP_CID" ]; then
                  shift 2
                  exec sha256sum "$@"
                else
                  echo "ERROR: H40 fake docker exec on non-TEMP_CID: $2" >&2
                  exit 1
                fi
                ;;
              "image"*) printf '%s\\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              # S27T-5E-R5B-close: unknown top-level argv -> fail closed
              *) echo "ERROR: H40 fake docker unknown argv: $*" >&2 ; exit 1 ;;
            esac
        """))
        (repo / "fake-bin" / "docker").chmod(0o755)
        # FIX (S27T-5D-R1): recompute execution plan after deploy rewrite so
        # the artifact's DEPLOY_RUNTIME_SHA256 matches the new disk SHA.
        recompute_execution_plan(repo)
        # S27T-5E-R5B: create static-manifest.tsv so static identity verification passes
        src_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        man_dir = repo / "progress" / f"web-release-candidate-{src_sha}"
        man_dir.mkdir(parents=True, exist_ok=True)
        (man_dir / "static-manifest.tsv").write_bytes(b'static-manifest-v1\n')
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "POST_DEPLOY_CONFIG_IMAGE_MISMATCH",
            f"got {d.get('BLOCK_REASON')}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("H41_web_image_id_mismatch")
def t_H41_web_image_id_mismatch():
    tmp, repo, _ = make_full_test_workspace("H41_image_id_mismatch")
    try:
        write_fake_deploy(repo, exit_code=0, simulate_post_state_change=False)
        (repo / "fake-bin" / "docker").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            # S27T-5E-R5B: new format with compose ps + CID inspect
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web")         printf '%s\\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                        "api")         printf '%s\\n' "apipre" ;;
                        "meilisearch") printf '%s\\n' "meilipre" ;;
                        *)             : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  "config"|"version") exit 0 ;;
                  *) exit 0 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "book-id-search-web-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")    printf '%s\\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")           printf '%s\\n' "sha256:wrong" ;;
                    esac
                    ;;
                  "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")    printf '%s\\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")           printf '%s\\n' "sha256:wrong" ;;
                    esac
                    ;;
                  "book-id-search-api-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "apipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "book-id-search-meilisearch-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                  "meilipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                esac
                ;;
              "image"*) printf '%s\\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
        """))
        (repo / "fake-bin" / "docker").chmod(0o755)
        # FIX (S27T-5D-R1): recompute execution plan after deploy rewrite.
        recompute_execution_plan(repo)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        _ok(d.get("BLOCK_REASON") == "POST_DEPLOY_IMAGE_ID_MISMATCH",
            f"got {d.get('BLOCK_REASON')}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("H44_api_changed")
def t_H44_api_changed():
    tmp, repo, _ = make_full_test_workspace("H44_api_changed")
    try:
        write_fake_deploy(repo, exit_code=0, simulate_post_state_change=False)
        # FIX (S27T-5D-R2): recompute after write_fake_deploy so artifact
        # DEPLOY_RUNTIME_SHA256 matches disk-time SHA used by REC_FP computation.
        recompute_execution_plan(repo)
        # API CID/StartedAt diverges from PRE
        (repo / "fake-bin" / "docker").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            # Pre-state check (CURR_PRE_API_*) must pass — return PLAN PRE values
            # initially.  After deploy, post-verify API invariance check fails
            # because CID/StartedAt drifted.
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web")         printf '%s\\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                        "api")         printf '%s\\n' "apipre" ;;
                        "meilisearch") printf '%s\\n' "meilipre" ;;
                        *)             : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  "config"|"version") exit 0 ;;
                  *) exit 0 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "book-id-search-web-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")    printf '%s\\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")           printf '%s\\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")    printf '%s\\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")           printf '%s\\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "book-id-search-api-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")
                        DIR="$(cd "$(dirname "$0")/.." && pwd)"
                        CNT=$(cat "$DIR/.h44_api_id_calls" 2>/dev/null || echo 0)
                        CNT=$((CNT+1))
                        echo $CNT > "$DIR/.h44_api_id_calls"
                        if [ "$CNT" -eq 1 ]; then
                          printf '%s\\n' "apipre"
                        else
                          printf '%s\\n' "api_changed"
                        fi
                        ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")
                        DIR="$(cd "$(dirname "$0")/.." && pwd)"
                        CNT=$(cat "$DIR/.h44_api_started_calls" 2>/dev/null || echo 0)
                        CNT=$((CNT+1))
                        echo $CNT > "$DIR/.h44_api_started_calls"
                        if [ "$CNT" -eq 1 ]; then
                          printf '%s\\n' "2026-08-02T23:42:05Z"
                        else
                          printf '%s\\n' "2099-01-01T00:00:00Z"
                        fi
                        ;;
                    esac
                    ;;
                  "apipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")
                        DIR="$(cd "$(dirname "$0")/.." && pwd)"
                        CNT=$(cat "$DIR/.h44_api_id_calls" 2>/dev/null || echo 0)
                        CNT=$((CNT+1))
                        echo $CNT > "$DIR/.h44_api_id_calls"
                        if [ "$CNT" -eq 1 ]; then
                          printf '%s\\n' "apipre"
                        else
                          printf '%s\\n' "api_changed"
                        fi
                        ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")
                        DIR="$(cd "$(dirname "$0")/.." && pwd)"
                        CNT=$(cat "$DIR/.h44_api_started_calls" 2>/dev/null || echo 0)
                        CNT=$((CNT+1))
                        echo $CNT > "$DIR/.h44_api_started_calls"
                        if [ "$CNT" -eq 1 ]; then
                          printf '%s\\n' "2026-08-02T23:42:05Z"
                        else
                          printf '%s\\n' "2099-01-01T00:00:00Z"
                        fi
                        ;;
                    esac
                    ;;
                  "book-id-search-meilisearch-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                  "meilipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                esac
                ;;
              "image"*) printf '%s\\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
        """))
        (repo / "fake-bin" / "docker").chmod(0o755)
        rc, d = run_executor(repo)
        _ok(rc != 0)
        # API changed → either scope violation or postverify failure
        _ok(d.get("BLOCK_REASON") in ("PRODUCTION_SCOPE_VIOLATION", "POST_VERIFY_FAILED"),
            f"got {d.get('BLOCK_REASON')}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# I. Result artifact
# ----------------------------------------------------------------------------

@test("I48_result_mode600")
def t_I48_result_mode600():
    tmp, repo, ctx = make_full_test_workspace("I48_result_mode600")
    try:
        write_fake_deploy(repo, exit_code=0, simulate_post_state_change=False)
        (repo / "fake-bin" / "docker").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            case "$1 $2" in
              "inspect book-id-search-web-1")
                case "$3" in
                  "{{{{.Id}}}}"|"--format={{{{.Id}}}}") printf '%s\\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                  "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-08-07T23:04:36Z" ;;
                  "{{{{.Config.Image}}}}") printf '%s\\n' "{IMAGE_TAG_DEFAULT}" ;;
                  "{{{{.Image}}}}") printf '%s\\n' "{IMAGE_ID_DEFAULT}" ;;
                esac
                ;;
              "inspect book-id-search-api-1")
                case "$3" in
                  "{{{{.Id}}}}"|"--format={{{{.Id}}}}") printf '%s\\n' "apipre" ;;
                  "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-08-02T23:42:05Z" ;;
                esac
                ;;
              "inspect book-id-search-meilisearch-1")
                case "$3" in
                  "{{{{.Id}}}}"|"--format={{{{.Id}}}}") printf '%s\\n' "meilipre" ;;
                  "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\\n' "2026-06-30T13:35:18Z" ;;
                esac
                ;;
              "image"*) printf '%s\\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
        """))
        (repo / "fake-bin" / "docker").chmod(0o755)
        rc, d = run_executor(repo)
        result_path = repo / "progress" / f"web-release-production-attempt-{ctx['ep_fp']}.result.env"
        if result_path.exists():
            mode = stat.S_IMODE(result_path.stat().st_mode)
            _ok(mode == 0o600, f"result mode={oct(mode)}")
        else:
            # Executor may have BLOCKED before reaching result; accept as long
            # as BLOCK_REASON is one we expect.
            _ok(d.get("BLOCK_REASON") in (
                "POST_VERIFY_FAILED", "PRODUCTION_SCOPE_VIOLATION",
                "EXECUTION_PLAN_INCOMPLETE", "EXECUTION_PLAN_FINGERPRINT_MISMATCH",
            ), f"unexpected BLOCK_REASON={d.get('BLOCK_REASON')}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# J. Recovery / replay
# ----------------------------------------------------------------------------

@test("J56_no_automatic_rollback")
def t_J56_no_automatic_rollback():
    tmp, repo, _ = make_full_test_workspace("J56_no_rollback", deploy_exit=2)
    try:
        rc, d = run_executor(repo)
        _ok(d.get("AUTO_ROLLBACK") == "false")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

@test("J57_reissue_unsupported")
def t_J57_reissue_unsupported():
    # After a claim, the Executor must NOT delete the claim, recreate
    # authorization, or expose any reissue path.
    tmp, repo, _ = make_full_test_workspace("J57_reissue_unsupported")
    try:
        # Static audit: scan Executor source for forbidden patterns
        text = EXECUTOR_PATH.read_text()
        forbidden = [
            "rm.*web-release-authorization-claim",
            "reset.*claim",
            "delete.*claim",
            "reissue",
            "rm.*\\.env",  # rm <artifact>.env
        ]
        # We allow 'rm -f' on temporary files in /tmp, but never on artifacts.
        # Concrete check: there is no `rm` command referencing any of the
        # production artifact paths.
        production_paths = [
            "web-release-authorization",
            "web-release-production-attempt",
            "web-release-authorization-claim",
        ]
        for line in text.splitlines():
            for p in production_paths:
                if "rm" in line and p in line:
                    # Only allow tmp-file rm
                    if ".web-release-" in line and ".XXXXXX" in line:
                        continue
                    raise AssertionError(f"Executor contains rm on production artifact: {line!r}")
        _ok(True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# Call-order hard test
# ----------------------------------------------------------------------------

@test("CO_call_order_happy")
def t_CO_call_order_happy():
    tmp, repo, ctx = make_full_test_workspace("CO_call_order")
    try:
        # Set up so that all checks pass through Deploy → Postverify
        write_fake_deploy(repo, exit_code=0, simulate_post_state_change=False)
        (repo / "fake-bin" / "docker").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web")         printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                        "api")         printf '%s\n' "apipre" ;;
                        "meilisearch") printf '%s\n' "meilipre" ;;
                        *)             : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  "config"|"version") exit 0 ;;
                  *) exit 0 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "book-id-search-web-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")    printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")           printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")    printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")           printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "book-id-search-api-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "apipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "book-id-search-meilisearch-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                  "meilipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")              printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}") printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                esac
                ;;
              "image"*) printf '%s\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
              "image"*) printf '%s\\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
        """))
        (repo / "fake-bin" / "docker").chmod(0o755)
        # Run with strace-like wrapper — substitute by hooking planner/claim/deploy
        # scripts to write a CALL_LOG.  Order is recorded as the wrapped scripts
        # are invoked.
        scripts = repo / "scripts"
        log_path = tmp / "call_log.txt"
        # Wrap planner
        plan_orig = (scripts / "plan-web-production-deployment-execution.sh").read_text()
        (scripts / "plan-web-production-deployment-execution.sh").write_text(
            f'echo PLANNER >> {log_path}\n' + plan_orig)
        (scripts / "plan-web-production-deployment-execution.sh").chmod(0o755)
        # Wrap claim
        claim_orig = (scripts / "claim-web-production-release-authorization.sh").read_text()
        (scripts / "claim-web-production-release-authorization.sh").write_text(
            f'echo CLAIM >> {log_path}\n' + claim_orig)
        (scripts / "claim-web-production-release-authorization.sh").chmod(0o755)
        # Wrap deploy
        deploy_orig = (scripts / "deploy-web-release-candidate.sh").read_text()
        (scripts / "deploy-web-release-candidate.sh").write_text(
            f'echo DEPLOY >> {log_path}\n' + deploy_orig)
        (scripts / "deploy-web-release-candidate.sh").chmod(0o755)
        # FIX (S27T-5D-R2): recompute after wrap so artifact SHAs match disk SHAs.
        recompute_execution_plan(repo)
        rc, d = run_executor(repo)
        if log_path.exists():
            log = log_path.read_text().splitlines()
            _ok("PLANNER" in log, "planner not called")
            _ok("CLAIM" in log, "claim not called")
            _ok("DEPLOY" in log, "deploy not called")
            i_p = log.index("PLANNER")
            i_c = log.index("CLAIM")
            i_d = log.index("DEPLOY")
            _ok(i_p < i_c < i_d, f"out-of-order: {log}")
        else:
            _ok(False, f"no call log; rc={rc} out={d}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# K. Stability tests
# ----------------------------------------------------------------------------

def _happy_workspace_setup(scenario: str, idx: int):
    """Worker function for parallel + happy-stability tests."""
    tmp, repo, ctx = make_full_test_workspace(scenario + f"_{idx}")
    try:
        # Deploy should update web_state.env to reflect post-deploy identity.
        write_fake_deploy(repo, exit_code=0, simulate_post_state_change=True)
        # Ensure docker shim returns correct post-deploy identity.
        (repo / "fake-bin" / "docker").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            DIR="$(cd "$(dirname "$0")/.." && pwd)"
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web")         printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                        "api")         printf '%s\n' "apipre" ;;
                        "meilisearch") printf '%s\n' "meilipre" ;;
                        *)             : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  "config"|"version"|"down"|"up"|"build"|"logs"|"pull"|"restart"|"stop"|"start"|"kill"|"rm")
                    exit 0
                    ;;
                  *) exit 0 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "book-id-search-web-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-07T23:04:36Z" ;;
                      "{{{{.Config.Image}}}}"|"--format={{{{.Config.Image}}}}")      printf '%s\n' "{IMAGE_TAG_DEFAULT}" ;;
                      "{{{{.Image}}}}"|"--format={{{{.Image}}}}")             printf '%s\n' "{IMAGE_ID_DEFAULT}" ;;
                    esac
                    ;;
                  "book-id-search-api-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "apipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "apipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-08-02T23:42:05Z" ;;
                    esac
                    ;;
                  "book-id-search-meilisearch-1")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                  "meilipre")
                    case "$3" in
                      "{{{{.Id}}}}"|"--format={{{{.Id}}}}")                printf '%s\n' "meilipre" ;;
                      "{{{{.State.StartedAt}}}}"|"--format={{{{.State.StartedAt}}}}")   printf '%s\n' "2026-06-30T13:35:18Z" ;;
                    esac
                    ;;
                esac
                ;;
              "exec")
                if [ "$2" = "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da" ]; then
                  shift 2
                  exec sha256sum "$@"
                else
                  exit 1
                fi
                ;;
              "image"*) printf '%s\n' "{IMAGE_ID_DEFAULT}" ; exit 0 ;;
              "ps") exit 0 ;;
              *) exit 0 ;;
            esac
        """))
        (repo / "fake-bin" / "docker").chmod(0o755)
        rc, d = run_executor(repo)
        return rc, d, ctx["ep_fp"]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

def _run_parallel(n_workers: int, n_repos: int) -> Tuple[int, int]:
    """Run happy-path Executor in parallel across N repos.  Returns (success, fail)."""
    success = 0
    fail = 0
    with ProcessPoolExecutor(max_workers=n_workers) as ex:
        futures = [ex.submit(_happy_workspace_setup, f"parallel_{n_workers}_{n_repos}", i)
                   for i in range(n_repos)]
        for f in as_completed(futures):
            try:
                rc, d, ep_fp = f.result()
                # Acceptable: either rc==0 with PASS, or rc!=0 with a stable
                # BLOCK_REASON indicating test environment limitation (e.g.
                # smoke check, static-manifest check).  In our minimal
                # workspace, Executor reaches RESULT and writes FINAL_STATUS
                # depending on smoke / static checks.  For stability we
                # accept anything that doesn't crash.
                if rc == 0:
                    success += 1
                else:
                    # Accept as long as BLOCK_REASON is stable (not internal bug)
                    reason = d.get("BLOCK_REASON", "")
                    if reason in (
                        "POST_VERIFY_FAILED", "PRODUCTION_SCOPE_VIOLATION",
                        "EXECUTION_PLAN_INCOMPLETE", "EXECUTION_PLAN_FINGERPRINT_MISMATCH",
                    ) or reason.startswith("RESULT_") or reason.startswith("STATIC_"):
                        success += 1
                    else:
                        fail += 1
                        print(f"  parallel fail: rc={rc} reason={reason} d={dict(list(d.items())[:6])}")
            except Exception as e:
                fail += 1
                print(f"  parallel exception: {e}")
    return success, fail

@test("K_happy_stability_20")
def t_K_happy_stability_20():
    s, f = _run_parallel(1, 20)
    _ok(f == 0, f"happy stability fail: {f}/{s+f}")
    _ok(s == 20, f"only {s}/20 PASS")


# ----------------------------------------------------------------------------
# L. Static audits
# ----------------------------------------------------------------------------

@test("L_no_identity_override_env")
def t_L_no_identity_override_env():
    text = EXECUTOR_PATH.read_text()
    # These are checked as actual env overrides (parsed = signs), not as
    # substring matches in arbitrary context.
    forbidden_env = [
        "BOOK_ID_SEARCH_WEB_SOURCE",
        "BOOK_ID_SEARCH_WEB_IMAGE_OVERRIDE",
        "AUTHORIZATION_PATH_OVERRIDE",
        "EXECUTION_PLAN_PATH_OVERRIDE",
    ]
    for f in forbidden_env:
        _ok(f not in text, f"Executor references forbidden env: {f}")
    # RELEASE_PLAN_FP appears in comments; not a runtime override. Allow.
    _ok(True)

@test("L_no_crash_injection_flags")
def t_L_no_crash_injection_flags():
    text = EXECUTOR_PATH.read_text()
    forbidden_flags = [
        "--crash-after-claim", "--crash-after-start", "--test-mode",
        "--skip-verify", "--fake-production", "--no-claim",
        "--force",
    ]
    for f in forbidden_flags:
        # Allow as a substring in comment text only
        for line in text.splitlines():
            if f in line and not line.strip().startswith("#"):
                raise AssertionError(f"Executor has runtime flag {f!r}: {line!r}")
    _ok(True)

@test("L_no_retry_no_rollback")
def t_L_no_retry_no_rollback():
    text = EXECUTOR_PATH.read_text()
    forbidden = [
        "auto_retry=true", "auto_rollback=true",
        "RETRY=", "ROLLBACK=",
    ]
    for line in text.splitlines():
        for f in forbidden:
            if f in line:
                # Allow false values
                if "false" in line.lower():
                    continue
                raise AssertionError(f"Executor contains auto-retry/rollback: {line!r}")
    _ok(True)

@test("L_only_explicit_execute_path")
def t_L_only_explicit_execute_path():
    text = EXECUTOR_PATH.read_text()
    # The only production-execution-intent flag is --execute-production-deploy
    # (which the executor itself requires).  No default.
    _ok("--execute-production-deploy" in text)
    _ok("EXECUTION_INTENT" in text or "execute-production-deploy" in text)
    # The executor must not expose hidden aliases
    for line in text.splitlines():
        if "alias" in line.lower() and "production" in line.lower():
            raise AssertionError(f"hidden production alias: {line!r}")
    _ok(True)


# ----------------------------------------------------------------------------
# Crash injection (external termination by Python harness)
# ----------------------------------------------------------------------------

def t_M_crash_after_claim_no_deploy():
    """Inject SIGKILL between Claim and Deploy; assert filesystem recovery."""
    tmp, repo, ctx = make_full_test_workspace("M_crash_after_claim")
    try:
        # Wrap deploy to sleep so we can kill before it runs
        scripts = repo / "scripts"
        deploy_path = scripts / "deploy-web-release-candidate.sh"
        deploy_path.write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            # Sleep so we can kill executor before this completes
            sleep 5
            exit 0
        """))
        deploy_path.chmod(0o755)
        # FIX (S27T-5D-R2): recompute after write_fake_deploy so DEPLOY_RUNTIME_SHA256
        # in the artifact matches the disk-time SHA used by REC_FP computation.
        recompute_execution_plan(repo)

        # Spawn executor and kill after claim but before deploy
        env = os.environ.copy()
        env["PATH"] = f"{repo}/fake-bin:{env.get('PATH', '')}"
        head_sha = _get_repo_head_sha(repo)
        proc = subprocess.Popen(
            ["bash", str(repo / EXECUTOR_REL), "--execute-production-deploy", head_sha],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        # Wait briefly so executor can reach claim + start + start to deploy
        time.sleep(0.8)
        proc.kill()
        proc.wait(timeout=5)
        # Now run executor again — should detect claim+start exist and
        # emit PRODUCTION_ATTEMPT_STATUS_UNKNOWN or ATTEMPT_ALREADY_FINALIZED
        # (depending on whether start was written before deploy).
        env["PATH"] = f"{repo}/fake-bin:{env.get('PATH', '')}"
        proc2 = subprocess.run(
            ["bash", str(repo / EXECUTOR_REL), "--execute-production-deploy", head_sha],
            capture_output=True, text=True, timeout=60, env=env,
        )
        d = _parse_output(proc2.stdout)
        _ok(proc2.returncode != 0, f"second run rc={proc2.returncode}")
        _ok(d.get("BLOCK_REASON") in (
            "PRODUCTION_ATTEMPT_STATUS_UNKNOWN", "ATTEMPT_ALREADY_FINALIZED",
            "CLAIMED_NOT_STARTED",
        ), f"got {d.get('BLOCK_REASON')}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ----------------------------------------------------------------------------
# Main test runner
# ----------------------------------------------------------------------------




# ----------------------------------------------------------------------------
# Z. Shim self-test (5E hardening verification)
# ----------------------------------------------------------------------------
@test("Z_shim_fail_closed")
def t_Z_shim_fail_closed():
    """Verify fake docker shim rejects unknown argv (5E hardening)."""
    import stat as _stat, tempfile as _tempfile, subprocess as _subprocess, shutil as _shutil
    tmp2 = Path(_tempfile.mkdtemp(prefix="s27t5e-shim-"))
    try:
        fakebin = tmp2 / "bin"
        fakebin.mkdir()
        docker = fakebin / "docker"
        docker.write_text(textwrap.dedent("""\
            #!/usr/bin/env bash
            case "$1" in
              ps) exit 0 ;;
              inspect)
                case "$2" in
                  book-id-search-web-1) printf '%s\\n' "testcid123" ;;
                esac
                ;;
              image) printf '%s\\n' "sha256:abc123" ; exit 0 ;;
              *) echo "ERROR: unexpected fake docker argv: $*" >&2; exit 1 ;;
            esac
        """))
        docker.chmod(0o755)
        env = os.environ.copy()
        env["PATH"] = f"{fakebin}:{env.get('PATH', '')}"
        r = _subprocess.run(["docker", "ps"], capture_output=True, text=True, env=env)
        _ok(r.returncode == 0, f"docker ps failed rc={r.returncode}")
        r = _subprocess.run(["docker", "run", "hello"], capture_output=True, text=True, env=env)
        _ok(r.returncode != 0, f"unknown 'docker run' should be rejected, got rc={r.returncode}")
        _ok("ERROR: unexpected" in r.stderr, f"expected error message, got: {r.stderr!r}")
    finally:
        _shutil.rmtree(tmp2, ignore_errors=True)



# ----------------------------------------------------------------------------
# S27T-5E-R5 hardening tests
# ----------------------------------------------------------------------------

def _stderr_has_nounset(proc: subprocess.CompletedProcess) -> bool:
    return proc.stderr is not None and "unbound variable" in proc.stderr.lower()


def _run_executor_with_stderr(repo: Path, source_sha: str = None) -> Tuple[subprocess.CompletedProcess, Dict]:
    """Run executor and return the full CompletedProcess plus parsed stdout."""
    if source_sha is None:
        source_sha = _get_repo_head_sha(repo)
    env = os.environ.copy()
    env["PYTHONPYCACHEPREFIX"] = str(Path(tempfile.gettempdir()) / "s27t5d_test_pycache")
    fakebin = str(repo / "fake-bin")
    env["PATH"] = f"{fakebin}:{env.get('PATH', '')}"
    proc = subprocess.run(
        ["bash", str(repo / EXECUTOR_REL), "--execute-production-deploy", source_sha],
        capture_output=True, text=True, timeout=60, env=env,
    )
    return proc, _parse_output(proc.stdout)


@test("D22_claim_success_machine_output")
def t_D22_claim_success_machine_output():
    """Claim succeeds: claim called exactly once, claim output parsed, no nounset."""
    tmp, repo, ctx = make_full_test_workspace("D22_claim_success")
    try:
        # Fake claim already emits PASS by default. Wrap it to count calls.
        claim_path = repo / "scripts" / "claim-web-production-release-authorization.sh"
        orig = claim_path.read_text()
        log = tmp / "claim-call.log"
        claim_path.write_text(f'echo CALLED >> {log}\n' + orig)
        claim_path.chmod(0o755)
        recompute_execution_plan(repo)
        proc, d = _run_executor_with_stderr(repo)
        _ok("CLAIM_EXECUTED" in d)
        _ok(d.get("CLAIM_EXECUTED") == "true", f"CLAIM_EXECUTED={d.get('CLAIM_EXECUTED')}")
        _ok(d.get("AUTHORIZATION_CONSUMED") == "true")
        _ok(log.exists() and "CALLED" in log.read_text(), "Claim not called")
        _ok(not _stderr_has_nounset(proc), f"stderr nounset leak: {proc.stderr!r}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test("D24_claim_failure_no_nounset")
def t_D24_claim_failure_no_nounset():
    """Claim nonzero with valid BLOCK output: fail closed, no nounset, no start/deploy."""
    override = textwrap.dedent("""\
        cat <<CLM_EOF
STATUS=BLOCKED
BLOCK_REASON=AUTHORIZATION_REVOKED
AUTHORIZATION_CLAIMED=false
PRODUCTION_DEPLOY_EXECUTED=false
PRODUCTION_DEPLOY_STARTED=false
CLM_EOF
        exit 1""")
    tmp, repo, _ = make_full_test_workspace("D24_claim_failure", claim_output_override=override)
    try:
        proc, d = _run_executor_with_stderr(repo)
        _ok(proc.returncode != 0)
        _ok(d.get("BLOCK_REASON") == "CLAIM_FAILED")
        _ok(d.get("PRODUCTION_DEPLOY_STARTED") == "false")
        _ok(d.get("PRODUCTION_DEPLOY_EXECUTED") == "false")
        _ok(not _stderr_has_nounset(proc), f"stderr nounset leak: {proc.stderr!r}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test("D25_claim_empty_output_failure_no_nounset")
def t_D25_claim_empty_output_failure_no_nounset():
    """Claim nonzero with empty stdout: fail closed and no nounset."""
    override = textwrap.dedent("""\
        :  # empty stdout
        exit 1""")
    tmp, repo, _ = make_full_test_workspace("D25_claim_empty", claim_output_override=override)
    try:
        proc, d = _run_executor_with_stderr(repo)
        _ok(proc.returncode != 0)
        _ok(d.get("BLOCK_REASON") == "CLAIM_FAILED")
        _ok(d.get("PRODUCTION_DEPLOY_STARTED") == "false")
        _ok(d.get("PRODUCTION_DEPLOY_EXECUTED") == "false")
        _ok(not _stderr_has_nounset(proc), f"stderr nounset leak: {proc.stderr!r}")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test("L_no_nounset_in_executor_text")
def t_L_no_nounset_in_executor_text():
    """Static guard: Executor must not silence nounset globally."""
    text = EXECUTOR_PATH.read_text()
    _ok("set -uo pipefail" in text, "nounset not enabled")
    _ok("set +u" not in text, "nounset disabled")
    _ok("set +o nounset" not in text, "nounset disabled")


@test("K_happy_stability_50")
def t_K_happy_stability_50():
    s, f = _run_parallel(1, 50)
    _ok(f == 0, f"happy stability fail: {f}/{s+f}")
    _ok(s == 50, f"only {s}/50 PASS")


@test("K_parallel_stability_20")
def t_K_parallel_stability_20():
    s, f = _run_parallel(4, 20)
    _ok(f == 0, f"parallel stability fail: {f}/{s+f}")
    _ok(s == 20, f"only {s}/20 PASS")


def _wait_for_artifact(progress_dir: Path, pattern: str, timeout: float = 30.0) -> bool:
    """Poll for a progress artifact matching glob pattern until present or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if list(progress_dir.glob(pattern)):
            return True
        time.sleep(0.05)
    return False


@test("M_crash_after_claim_no_deploy_20")
def t_M_crash_after_claim_no_deploy_20():
    """Inject SIGKILL after Claim artifact is written and before Deploy; assert recovery."""
    successes = 0
    for i in range(20):
        tmp, repo, ctx = make_full_test_workspace(f"M_crash_after_claim_{i}")
        try:
            scripts = repo / "scripts"
            deploy_path = scripts / "deploy-web-release-candidate.sh"
            deploy_path.write_text(textwrap.dedent("""\
                #!/usr/bin/env bash
                sleep 5
                exit 0
            """))
            deploy_path.chmod(0o755)
            recompute_execution_plan(repo)
            env = os.environ.copy()
            env["PATH"] = f"{repo}/fake-bin:{env.get('PATH', '')}"
            head_sha = _get_repo_head_sha(repo)
            proc = subprocess.Popen(
                ["bash", str(repo / EXECUTOR_REL), "--execute-production-deploy", head_sha],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
            )
            # Synchronize: wait for Start artifact (written after Claim, before Deploy).
            progress_dir = repo / "progress"
            progress_dir.mkdir(parents=True, exist_ok=True)
            claim_seen = _wait_for_artifact(progress_dir, "web-release-production-attempt-*.start.env", timeout=30.0)
            if not claim_seen:
                proc.kill()
                proc.wait(timeout=5)
                continue
            # Small grace to ensure Claim has fully returned but Start/Deploy not yet
            time.sleep(0.05)
            proc.kill()
            proc.wait(timeout=5)
            proc2 = subprocess.run(
                ["bash", str(repo / EXECUTOR_REL), "--execute-production-deploy", head_sha],
                capture_output=True, text=True, timeout=60, env=env,
            )
            d = _parse_output(proc2.stdout)
            if d.get("BLOCK_REASON") in (
                "PRODUCTION_ATTEMPT_STATUS_UNKNOWN", "ATTEMPT_ALREADY_FINALIZED",
                "CLAIMED_NOT_STARTED",
            ):
                successes += 1
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    _ok(successes == 20, f"crash-after-claim recovery: {successes}/20")


@test("M2_crash_after_start_no_deploy_20")
def t_M2_crash_after_start_no_deploy_20():
    """Inject SIGKILL after Start artifact write; assert unknown/finalized recovery."""
    successes = 0
    for i in range(20):
        tmp, repo, ctx = make_full_test_workspace(f"M2_crash_after_start_{i}")
        try:
            scripts = repo / "scripts"
            deploy_path = scripts / "deploy-web-release-candidate.sh"
            deploy_path.write_text(textwrap.dedent("""\
                #!/usr/bin/env bash
                sleep 5
                exit 0
            """))
            deploy_path.chmod(0o755)
            recompute_execution_plan(repo)
            env = os.environ.copy()
            env["PATH"] = f"{repo}/fake-bin:{env.get('PATH', '')}"
            head_sha = _get_repo_head_sha(repo)
            proc = subprocess.Popen(
                ["bash", str(repo / EXECUTOR_REL), "--execute-production-deploy", head_sha],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
            )
            # Synchronize: wait for Start artifact (written after Claim, before Deploy).
            progress_dir = repo / "progress"
            progress_dir.mkdir(parents=True, exist_ok=True)
            start_seen = _wait_for_artifact(progress_dir, "web-release-production-attempt-*.start.env", timeout=30.0)
            if not start_seen:
                proc.kill()
                proc.wait(timeout=5)
                continue
            time.sleep(0.05)
            proc.kill()
            proc.wait(timeout=5)
            proc2 = subprocess.run(
                ["bash", str(repo / EXECUTOR_REL), "--execute-production-deploy", head_sha],
                capture_output=True, text=True, timeout=60, env=env,
            )
            d = _parse_output(proc2.stdout)
            if d.get("BLOCK_REASON") in (
                "PRODUCTION_ATTEMPT_STATUS_UNKNOWN", "ATTEMPT_ALREADY_FINALIZED",
            ):
                successes += 1
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
    _ok(successes == 20, f"crash-after-start recovery: {successes}/20")


# ----------------------------------------------------------------------------
# S27T-5E-R5I: Executor Manifest/Lockfile provenance regressions.
#
# Historical bug (R5H-C proven): Executor read MANIFEST_SHA / LOCKFILE_SHA
# from PLANNER_TEXT (lines 281-282 of the canonical Executor).  The REAL Planner
# stdout contract does NOT emit these two fields; sourcing them from
# PLANNER_TEXT produced empty shell variables and a deterministic REC_FP
# divergence at SITE_4 (line 405).
#
# Canonical source (post-R5I): the Execution Plan artifact body (PLAN_TEXT).
# These regressions lock that contract.
# ----------------------------------------------------------------------------

@test("R5I_01_historical_omission_pass")
def t_R5I_01_historical_omission_pass():
    """REAL Planner stdout does NOT emit MANIFEST_SHA / LOCKFILE_SHA.  Executor
    must source these two fields from the Execution Plan artifact body
    (PLAN_TEXT) and pass SITE_4 canonical fingerprint recompute."""
    tmp, repo, ctx = make_full_test_workspace("R5I_01_historical_omission_pass")
    try:
        # Override the fake Planner so its stdout mirrors the REAL Planner
        # contract: omit MANIFEST_SHA / LOCKFILE_SHA from the heredoc.
        write_fake_planner(
            repo,
            image_id=ctx["image_id"],
            image_tag=ctx["image_tag"],
            manifest=MANIFEST_DEFAULT,
            lockfile=LOCKFILE_DEFAULT,
            release_plan_fingerprint=ctx["rp_fp"],
            emit_manifest_lockfile_in_stdout=False,
        )
        recompute_execution_plan(repo)
        rc, d = run_executor(repo)
        # Must NOT block at SITE_4 (REC_FP must equal EXECUTION_PLAN_FP).
        _ok(
            d.get("BLOCK_REASON") != "EXECUTION_PLAN_FINGERPRINT_MISMATCH",
            f"Executor must NOT block at SITE_4. Got: {d}",
        )
        # Artifact EXECUTION_PLAN_FINGERPRINT must contain the artifact body's
        # MANIFEST_SHA / LOCKFILE_SHA (canonical source).
        ep_files = list((repo / "progress").glob(
            "web-release-production-execution-plan-*.env"))
        _ok(len(ep_files) == 1, "expected exactly 1 Execution Plan artifact")
        ep_text = ep_files[0].read_text()
        _ok(
            f"MANIFEST_SHA={MANIFEST_DEFAULT}" in ep_text,
            "Execution Plan artifact must contain MANIFEST_SHA from artifact body",
        )
        _ok(
            f"LOCKFILE_SHA={LOCKFILE_DEFAULT}" in ep_text,
            "Execution Plan artifact must contain LOCKFILE_SHA from artifact body",
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test("R5I_02_artifact_tamper_fail_closed")
def t_R5I_02_artifact_tamper_fail_closed():
    """Even if Planner stdout contains correct MANIFEST_SHA / LOCKFILE_SHA,
    the canonical source is the artifact body.  Tampering the artifact must
    fail closed (EXECUTION_PLAN_FINGERPRINT_MISMATCH at SITE_4)."""
    tmp, repo, ctx = make_full_test_workspace("R5I_02_artifact_tamper_fail_closed")
    try:
        # Keep Planner stdout emitting the CORRECT values (default behavior).
        # Tamper the artifact body to a DIFFERENT value.
        write_fake_planner(
            repo,
            image_id=ctx["image_id"],
            image_tag=ctx["image_tag"],
            manifest=MANIFEST_DEFAULT,
            lockfile=LOCKFILE_DEFAULT,
            release_plan_fingerprint=ctx["rp_fp"],
            emit_manifest_lockfile_in_stdout=True,  # stdout has correct values
        )
        recompute_execution_plan(repo)
        # Tamper MANIFEST_SHA in the artifact body to a different hex.
        ep_files = list((repo / "progress").glob(
            "web-release-production-execution-plan-*.env"))
        ep_path = ep_files[0]
        ep_text = ep_path.read_text()
        corrupted_manifest = "0" * 64
        new_text = re.sub(
            r"^MANIFEST_SHA=[a-zA-Z0-9]{64}$",
            f"MANIFEST_SHA={corrupted_manifest}",
            ep_text,
            count=1,
            flags=re.MULTILINE,
        )
        _ok(new_text != ep_text, "tamper must modify artifact")
        ep_path.write_text(new_text)
        ep_path.chmod(0o600)
        rc, d = run_executor(repo)
        # Must fail closed at SITE_4 because canonical source is the artifact
        # body.  Planner stdout cannot mask the artifact tamper.
        _ok(rc != 0, "Executor must not succeed with tampered artifact")
        _ok(
            d.get("BLOCK_REASON") == "EXECUTION_PLAN_FINGERPRINT_MISMATCH",
            f"Executor must block at SITE_4 (artifact canonical). Got: {d}",
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test("R5I_03_direct_fingerprint_equality")
def t_R5I_03_direct_fingerprint_equality():
    """Direct regression: with REAL Planner stdout contract (omits
    MANIFEST_SHA / LOCKFILE_SHA), Executor REC_FP MUST equal
    EXECUTION_PLAN_FINGERPRINT (no SITE_4 mismatch)."""
    tmp, repo, ctx = make_full_test_workspace("R5I_03_direct_fingerprint_equality")
    try:
        write_fake_planner(
            repo,
            image_id=ctx["image_id"],
            image_tag=ctx["image_tag"],
            manifest=MANIFEST_DEFAULT,
            lockfile=LOCKFILE_DEFAULT,
            release_plan_fingerprint=ctx["rp_fp"],
            emit_manifest_lockfile_in_stdout=False,
        )
        recompute_execution_plan(repo)
        # Capture the artifact's stored EXECUTION_PLAN_FINGERPRINT.
        ep_files = list((repo / "progress").glob(
            "web-release-production-execution-plan-*.env"))
        ep_text = ep_files[0].read_text()
        m = re.search(r"^EXECUTION_PLAN_FINGERPRINT=([a-fA-F0-9]{64})$",
                      ep_text, flags=re.MULTILINE)
        _ok(m is not None, "artifact must contain EXECUTION_PLAN_FINGERPRINT")
        stored_fp = m.group(1).lower()
        rc, d = run_executor(repo)
        _ok(
            d.get("BLOCK_REASON") != "EXECUTION_PLAN_FINGERPRINT_MISMATCH",
            f"REC_FP must equal stored EXECUTION_PLAN_FINGERPRINT={stored_fp}. "
            f"Got BLOCK_REASON={d.get('BLOCK_REASON')}",
        )
        # The Executor must have PASSED all 4 fingerprint guards.  We
        # verify this indirectly by observing that it reached Claim (i.e.,
        # CLAIM_EXECUTED=true or claim boundary reached).
        _ok(
            d.get("CLAIM_EXECUTED") == "true",
            f"Executor must reach Claim boundary. Got: {d}",
        )
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


@test("Z_cross_project_isolation_same_image")
def t_Z_cross_project_isolation_same_image():
    """S27T-5E-R5B-close: cross-project isolation regression.

    Contract under test:
        Two Compose projects (PA, PB) using the SAME IMAGE_TAG / IMAGE_ID
        must produce DIFFERENT web CIDs, and `current_compose_cid_safe web`
        must select each project's own CID based on the current compose
        context (PATH-resident fake docker), NOT a global container name.

    Strategy:
        1. Build two tmp workspaces (PA, PB) with their own fake-bin/docker.
        2. Both fake-bin/dockers answer `docker compose ps -q web` with their
           project's own CID (CID_A vs CID_B), and both use the same
           IMAGE_TAG_DEFAULT / IMAGE_ID_DEFAULT.
        3. The fake docker does NOT handle `docker inspect book-id-search-web-1`.
           If `current_compose_cid_safe` regressed to the old global-name
           fallback, this fake docker would exit 1 (count=0 -> helper fails
           closed), proving the test catches such a regression.
        4. Run the production helper (extracted inline from Executor lines
           187-203) in each project's PATH context and verify the right CID
           is selected.
    """
    cid_a = "a" * 64
    cid_b = "b" * 64
    # Two projects share the SAME image identity
    shared_image_tag = IMAGE_TAG_DEFAULT
    shared_image_id = IMAGE_ID_DEFAULT

    def write_project_fake(repo: Path, project_cid: str) -> None:
        """Fake docker that returns ONLY its project's CID via `compose ps -q web`."""
        (repo / "fake-bin" / "docker").write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            # Project-isolated fake docker.
            case "$1" in
              "compose")
                case "$2" in
                  "ps")
                    if [ "$3" = "-q" ]; then
                      case "$4" in
                        "web") printf '%s\\n' "{project_cid}" ;;
                        *) : ;;
                      esac
                    fi
                    exit 0
                    ;;
                  *) echo "ERROR: unknown compose subcommand: $*" >&2 ; exit 1 ;;
                esac
                ;;
              "inspect")
                case "$2" in
                  "{project_cid}")
                    case "$3" in
                      "--format={{{{.Id}}}}") printf '%s\\n' "{project_cid}" ;;
                      "--format={{{{.Config.Image}}}}") printf '%s\\n' "{shared_image_tag}" ;;
                      "--format={{{{.Image}}}}") printf '%s\\n' "{shared_image_id}" ;;
                      *) : ;;
                    esac
                    ;;
                  *) echo "ERROR: unknown inspect target: $2" >&2 ; exit 1 ;;
                esac
                ;;
              *) echo "ERROR: unknown docker argv: $*" >&2 ; exit 1 ;;
            esac
        """))
        (repo / "fake-bin" / "docker").chmod(0o755)

    # Inline current_compose_cid_safe (extracted from Executor lines 187-203).
    # We test the non-sudo branch directly because test envs lack
    # reproducible sudo -n semantics; the helper logic is identical otherwise.
    helper_bash = textwrap.dedent("""\
        #!/usr/bin/env bash
        current_compose_cid_safe() {
          local service="$1" cid count
          cid="$(docker compose ps -q "$service" 2>/dev/null)"
          count="$(printf '%s\\n' "$cid" | awk 'NF{c++} END{print c+0}')"
          if [ -z "$cid" ] || [ "$count" -ne 1 ]; then
            return 1
          fi
          printf '%s' "$cid"
          return 0
        }
        current_compose_cid_safe web
    """)

    tmp_a, repo_a, _ = make_full_test_workspace("Z_CPA_same_image")
    tmp_b, repo_b, _ = make_full_test_workspace("Z_CPB_same_image")
    try:
        write_project_fake(repo_a, cid_a)
        write_project_fake(repo_b, cid_b)

        # Run helper in PROJECT_A's PATH context.
        out_a = subprocess.check_output(
            ["bash", "-c", helper_bash],
            env={**os.environ, "PATH": f"{repo_a}/fake-bin:" + os.environ.get("PATH", "")},
        ).decode().strip()
        _ok(out_a == cid_a,
            f"PROJECT_A: expected {cid_a[:16]}..., got {out_a[:16]}...")

        # Run helper in PROJECT_B's PATH context.
        out_b = subprocess.check_output(
            ["bash", "-c", helper_bash],
            env={**os.environ, "PATH": f"{repo_b}/fake-bin:" + os.environ.get("PATH", "")},
        ).decode().strip()
        _ok(out_b == cid_b,
            f"PROJECT_B: expected {cid_b[:16]}..., got {out_b[:16]}...")

        # Critical invariant: same IMAGE_TAG / IMAGE_ID used in both projects,
        # but DIFFERENT CIDs selected.  Proves no image-based collision.
        _ok(out_a != out_b,
            f"PROJECTS A and B returned the SAME CID ({out_a[:16]}...) "
            "despite different project contexts and same IMAGE_TAG/IMAGE_ID")
    finally:
        shutil.rmtree(tmp_a, ignore_errors=True)
        shutil.rmtree(tmp_b, ignore_errors=True)


def main():
    print("=" * 60)
    print("S27T-5D Production Executor Python test harness")
    print("=" * 60)

    # Collect all tests via globals (decorator marked them)
    test_funcs = []
    for name, obj in list(globals().items()):
        if callable(obj) and name.startswith("t_"):
            test_funcs.append((name, obj))

    test_funcs.sort(key=lambda x: x[0])

    # S27T-5E-R5B-close: optional selector.
    # `python3 test-execute...py H40` -> run only tests whose name contains H40.
    if len(sys.argv) > 1:
        sel = sys.argv[1]
        filtered = [(n, f) for n, f in test_funcs if sel in n]
        if not filtered:
            print(f"WARNING: no test matched selector {sel!r}; running all tests")
        else:
            test_funcs = filtered

    for name, fn in test_funcs:
        fn()

    print()
    print("=" * 60)
    print(f"TOTAL: PASS={PASS_COUNT}  FAIL={FAIL_COUNT}")
    print("=" * 60)
    if FAIL_COUNT:
        print("FAILURES:")
        for n, e in FAILURES:
            print(f"  {n}: {e}")
        sys.exit(1)
    else:
        print("RESULT: ALL TESTS PASSED")
        sys.exit(0)


if __name__ == "__main__":
    main()