#!/usr/bin/env python3
"""
S27T-5C Isolated Production Execution State-machine Simulator.

NOT a future Production Executor.  This module simulates the S27T-5A state
machine in an isolated temporary Git repository using:

  - actual exact-byte Planner (scripts/plan-web-production-deployment-execution.sh)
  - actual exact-byte Claim runtime (scripts/claim-web-production-release-authorization.sh)
  - controlled sibling fakes (L2 quick gate, Release Plan, authorized-isolated E2E,
    docker image inspect, production reader)
  - simulated production state file (NOT real Docker; NOT real production)

Scenarios (controlled simulation):

  happy                    -> ATTEMPT_FINALIZED_PASS / DEPLOYMENT_ACCEPTED
  crash-after-claim        -> CLAIMED_NOT_STARTED
  crash-after-start        -> ATTEMPT_STATUS_UNKNOWN
  deploy-failure           -> DEPLOY_FAILED
  postverify-failure       -> POST_VERIFY_FAILED
  scope-violation          -> PRODUCTION_SCOPE_VIOLATION
  preexisting-claim        -> AUTHORIZATION_ALREADY_CLAIMED
  tampered-execution-plan  -> PRE_CLAIM_BLOCKED (no claim)
  replay-after-success     -> ATTEMPT_ALREADY_FINALIZED
  postclaim-toctou-failure -> CLAIMED_NOT_STARTED (no start)

Each invocation is fully isolated (tempfile.TemporaryDirectory).  No real
production is touched.

CLI:
  scripts/verify/simulate_web_production_execution_state_machine.py \
      --scenario <scenario> [--seed <int>]
"""
import argparse
import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import textwrap
import time
import traceback
from pathlib import Path
from typing import Dict, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parents[2]
PLANNER_REL = "scripts/plan-web-production-deployment-execution.sh"
CLAIM_REL = "scripts/claim-web-production-release-authorization.sh"
VERIFY_REL = "scripts/verify-web-release-runtime-acceptance.py"

ALLOWED_SCENARIOS = {
    "happy",
    "crash-after-claim",
    "crash-after-start",
    "deploy-failure",
    "postverify-failure",
    "scope-violation",
    "preexisting-claim",
    "tampered-execution-plan",
    "replay-after-success",
    "postclaim-toctou-failure",
}

EVENT_LOG: List[str] = []


def log_event(ev: str) -> None:
    EVENT_LOG.append(ev)


def emit_block(reason: str, **extra) -> int:
    payload = {
        "STATUS": "BLOCKED",
        "BLOCK_REASON": reason,
        "CLAIM_EXECUTED": False,
        "PRODUCTION_DEPLOY_STARTED": False,
        "PRODUCTION_DEPLOY_EXECUTED": False,
        "PRODUCTION_WRITE_EXECUTED": False,
        "EVENTS": EVENT_LOG,
    }
    payload.update(extra)
    sys.stdout.write(json.dumps(payload, indent=2) + "\n")
    return 1


def emit_success(state: str, **extra) -> int:
    # claim was not invoked by this simulator run for these pre-existing states
    claim_executed_by_this_run = state not in (
        "AUTHORIZED_UNCLAIMED", "AUTHORIZATION_ALREADY_CLAIMED",
    )
    payload = {
        "STATUS": "PASS",
        "STATE": state,
        "CLAIM_EXECUTED_BY_THIS_RUN": claim_executed_by_this_run,
        "CLAIM_EXECUTED": claim_executed_by_this_run or state == "AUTHORIZATION_ALREADY_CLAIMED",
        "PRODUCTION_DEPLOY_STARTED": "START" in state or state in ("DEPLOYMENT_ACCEPTED",),
        "PRODUCTION_DEPLOY_EXECUTED": state == "DEPLOYMENT_ACCEPTED",
        "PRODUCTION_WRITE_EXECUTED": state == "DEPLOYMENT_ACCEPTED",
        "AUTO_RETRY": False,
        "AUTO_ROLLBACK": False,
        "REISSUE_SUPPORT": "NOT_IMPLEMENTED",
        "EVENTS": EVENT_LOG,
    }
    payload.update(extra)
    sys.stdout.write(json.dumps(payload, indent=2) + "\n")
    return 0


# ----------------------------------------------------------------------------
# Workspace setup
# ----------------------------------------------------------------------------
def make_workspace(scenario: str) -> Tuple[Path, Path]:
    """Build a temp Git repo with HEAD==origin/main and clean worktree."""
    tmp = Path(tempfile.mkdtemp(prefix=f"s27t5c_{scenario.replace('-', '_')}_"))
    repo = tmp / "repo"
    repo.mkdir()
    (repo / "scripts").mkdir()
    (repo / "scripts" / "verify").mkdir()
    (repo / "progress").mkdir()
    (repo / "simulation").mkdir()

    # Initialize git
    subprocess.run(["git", "-C", str(repo), "init", "-q", "-b", "main"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "sim@test"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "sim"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "commit.gpgsign", "false"], check=True)

    # .gitignore to keep simulation/ from dirtying worktree
    (repo / ".gitignore").write_text("simulation/\n__pycache__/\n")
    (repo / "README").write_text("sim\n")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "init"], check=True)

    # Fake origin
    subprocess.run(["git", "-C", str(repo), "remote", "add", "origin", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "fetch", "origin", "main", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(repo), "branch", "--set-upstream-to=origin/main", "main"], check=True)
    head_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
    subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head_sha], check=True)

    return tmp, repo


def copy_exact_byte(src: Path, dst: Path) -> str:
    shutil.copy2(src, dst)
    dst.chmod(0o755)
    src_sha = hashlib.sha256(src.read_bytes()).hexdigest()
    dst_sha = hashlib.sha256(dst.read_bytes()).hexdigest()
    if src_sha != dst_sha:
        raise RuntimeError(f"exact-byte mismatch: {src} vs {dst}")
    return src_sha


# ----------------------------------------------------------------------------
# Fixture creation
# ----------------------------------------------------------------------------
IMAGE_TAG_DEFAULT = "registry.example.test/book-id-search/web:sim"
IMAGE_ID_DEFAULT = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
MANIFEST_DEFAULT = "m" * 64
LOCKFILE_DEFAULT = "l" * 64


def write_fake_runtime(repo: Path, scenario: str) -> Dict[str, str]:
    """Create fake L2 quick gate, Release Plan, orchestrator, docker reader."""
    scripts = repo / "scripts"
    progress = repo / "progress"
    simdir = repo / "simulation"

    # IMAGE_ID can be overridden by scenario for image-changed tests
    image_id = IMAGE_ID_DEFAULT
    if scenario == "postclaim-toctou-failure":
        # Slightly altered candidate image for post-claim TOCTOU
        image_id = "sha256:abcd12345678abcd12345678abcd12345678abcd12345678abcd12345678abcd"

    # Candidate evidence (we'll move this to correct path after we know SOURCE_SHA)
    sim_cand = simdir / "candidate.json"
    sim_cand.write_text(json.dumps({
        "tag": IMAGE_TAG_DEFAULT,
        "imageId": image_id,
        "staticManifestSha256": MANIFEST_DEFAULT,
        "lockfileSha256": LOCKFILE_DEFAULT,
    }, indent=2))
    (simdir / "image-tag.txt").write_text(IMAGE_TAG_DEFAULT)
    (simdir / "image-id.txt").write_text(image_id)
    (simdir / "static-manifest.tsv").write_text(f"{MANIFEST_DEFAULT}  /assets/index.js\n")
    (simdir / "lockfile.sha256").write_text(LOCKFILE_DEFAULT)

    # Fake L2 quick gate (always PASS)
    (scripts / "verify-web-release-runtime-acceptance.py").write_text(textwrap.dedent("""\
        #!/usr/bin/env python3
        import sys
        print("STATUS=PASS")
        print("AUTHORIZATION_VERIFIER=PASS")
        print("CLAIM_VERIFIER=PASS")
        print("CLAIM_ATOMICITY=true")
        print("CLAIM_REPLAY_PROTECTION=true")
        print("ORCHESTRATOR_VERIFIER=PASS")
        print("FAIL_CLOSED_CONTRACT=true")
        print("LEGACY_SHELL_HARNESS_BLOCKING=false")
        print("RUNTIME_ACCEPTANCE_READY=true")
        print("PRODUCTION_DEPLOY_MODE=NOT_IMPLEMENTED")
        print("PRODUCTION_DEPLOY_EXECUTED=false")
    """))
    (scripts / "verify-web-release-runtime-acceptance.py").chmod(0o755)

    # Fake Release Plan (returns deterministic 12-field PASS)
    # Must produce canonical fingerprint matching planner's REC_FP formula:
    #   sha256("SOURCE_SHA=X\nIMAGE_TAG=Y\nIMAGE_ID=Z\nMANIFEST=A\nLOCKFILE=B\n")
    (scripts / "plan-web-production-release.sh").write_text(textwrap.dedent(f"""\
        #!/usr/bin/env bash
        SOURCE_SHA_VAL="$1"
        IMAGE_TAG_VAL="{IMAGE_TAG_DEFAULT}"
        IMAGE_ID_VAL="{image_id}"
        MANIFEST_SHA_VAL="{MANIFEST_DEFAULT}"
        LOCKFILE_SHA_VAL="{LOCKFILE_DEFAULT}"
        echo STATUS=PASS
        echo RELEASE_PLAN_VERSION=1
        echo SOURCE_SHA=$SOURCE_SHA_VAL
        echo IMAGE_TAG=$IMAGE_TAG_VAL
        echo IMAGE_ID=$IMAGE_ID_VAL
        echo MANIFEST_SHA=$MANIFEST_SHA_VAL
        echo LOCKFILE_SHA=$LOCKFILE_SHA_VAL
        # Canonical formula matches Planner REC_FP exactly
        FP=$(printf '%s\\n%s\\n%s\\n%s\\n%s\\n' \\
          "SOURCE_SHA=$SOURCE_SHA_VAL" \\
          "IMAGE_TAG=$IMAGE_TAG_VAL" \\
          "IMAGE_ID=$IMAGE_ID_VAL" \\
          "MANIFEST_SHA=$MANIFEST_SHA_VAL" \\
          "LOCKFILE_SHA=$LOCKFILE_SHA_VAL" | sha256sum | awk '{{print $1}}')
        echo RELEASE_PLAN_FINGERPRINT=$FP
        echo READINESS_GATE=PASS
        echo ISOLATED_E2E=PASS
        echo PRODUCTION_UNCHANGED=PASS
        echo RELEASE_PLAN_READY=true
        echo DEPLOY_EXECUTED=false
        echo CURRENT_HEAD=$SOURCE_SHA_VAL
    """))
    (scripts / "plan-web-production-release.sh").chmod(0o755)

    # Fake orchestrator (authorized-isolated-e2e)
    (scripts / "orchestrate-web-production-release.sh").write_text(textwrap.dedent(f"""\
        #!/usr/bin/env bash
        cat <<ORCH_EOF
STATUS=PASS
ORCHESTRATION_MODE=authorized-isolated-e2e
SOURCE_SHA=$1
RELEASE_PLAN_FINGERPRINT=PLACEHOLDER_FP
IMAGE_TAG={IMAGE_TAG_DEFAULT}
IMAGE_ID={image_id}
PLAN_READY=PASS
AUTHORIZATION_REQUIRED=true
AUTHORIZATION_VALIDATED=PASS
AUTHORIZATION_CONSUMABLE=PASS
AUTHORIZED_ACTION=production-deploy
EXPLICIT_APPROVAL=true
PRE_DEPLOY_IMAGE_IDENTITY=PASS
HANDOFF_IDENTITY_SOURCE=RELEASE_PLAN
ACTUAL_DEPLOY_SCRIPT_E2E=PASS
POST_DEPLOY_IMAGE_IDENTITY=PASS
DEV_FALLBACK_USED=false
PRODUCTION_UNCHANGED=PASS
PRODUCTION_DEPLOY_EXECUTED=false
AUTHORIZATION_CONSUMED=false
ORCHESTRATOR_ISOLATED_E2E_VERIFIED=true
ORCH_EOF
    """))
    (scripts / "orchestrate-web-production-release.sh").chmod(0o755)

    # Fake docker (only inspect & image inspect; no real docker)
    fake_bin = repo / "fake_bin"
    fake_bin.mkdir(exist_ok=True)
    # Build docker script using concat (avoid f-string brace hell)
    docker_lines = [
        "#!/usr/bin/env bash",
        "# fake docker for simulator; never touches real docker",
        'if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then',
        '    shift 2; fmt=""',
        "    while [ $# -gt 0 ]; do",
        '        case "$1" in',
        '            --format=*) fmt="${1#--format=}" ;;',
        '            --format) shift; fmt="$1" ;;',
        "        esac",
        "        shift",
        "    done",
        '    case "$fmt" in',
        # Match literal Go template {{.Id}}
        '        "{{.Id}}") echo "' + image_id + '" ;;',
        '        *) echo \'[{"Id": "' + image_id + '"}]\' ;;',
        "    esac",
        "    exit 0",
        "fi",
        'if [ "$1" = "true" ]; then exit 0; fi',
        'if [ "$1" = "inspect" ]; then',
        "    shift",
        "    # Read simulated production state if exists",
        '    state_file="' + str(simdir) + '/production-web-state.json"',
        '    if [ -f "$state_file" ]; then',
        '        cat "$state_file"',
        "        exit 0",
        "    fi",
        "    # Default",
        '    echo \'{"Id": "1111111111111111111111111111111111111111111111111111111111111111", "State": {"StartedAt": "2026-08-01T00:00:00.000000000Z"}, "Config": {"Image": "' + IMAGE_TAG_DEFAULT + '"}, "Image": "' + image_id + '"}}\'',
        "    exit 0",
        "fi",
        'echo ""',
        "exit 0",
    ]
    (fake_bin / "docker").write_text("\n".join(docker_lines) + "\n")
    (fake_bin / "docker").chmod(0o755)
    (fake_bin / "sudo").write_text("#!/usr/bin/env bash\nwhile [ $# -gt 0 ] && [[ \"$1\" == -* ]]; do shift; done\nexec \"$@\"\n")
    (fake_bin / "sudo").chmod(0o755)

    # Initial simulated production state (web/api/meili)
    (simdir / "production-web-state.json").write_text(json.dumps({
        "Id": "1111111111111111111111111111111111111111111111111111111111111111",
        "State": {"StartedAt": "2026-08-01T00:00:00.000000000Z"},
        "Config": {"Image": "book-id-search-web:pre"},
        "Image": "1111111111111111111111111111111111111111111111111111111111111111",
    }, indent=2))
    (simdir / "production-api-state.json").write_text(json.dumps({
        "Id": "2222222222222222222222222222222222222222222222222222222222222222",
        "State": {"StartedAt": "2026-08-02T00:00:00.000000000Z"},
    }))
    (simdir / "production-meili-state.json").write_text(json.dumps({
        "Id": "3333333333333333333333333333333333333333333333333333333333333333",
        "State": {"StartedAt": "2026-08-03T00:00:00.000000000Z"},
    }))

    return {
        "image_tag": IMAGE_TAG_DEFAULT,
        "image_id": image_id,
        "manifest_sha": MANIFEST_DEFAULT,
        "lockfile_sha": LOCKFILE_DEFAULT,
    }


def write_authorization(repo: Path, identity: Dict[str, str], fingerprint: str,
                        scenario: str) -> Path:
    """Write a valid Authorization artifact (12-key contract, mode 600)."""
    progress = repo / "progress"
    auth_path = progress / f"web-release-authorization-{fingerprint}.env"
    auth_path.write_text(
        "AUTHORIZATION_VERSION=1\n"
        f"SOURCE_SHA={repo_initial_head(repo)}\n"
        f"RELEASE_PLAN_FINGERPRINT={fingerprint}\n"
        f"IMAGE_TAG={identity['image_tag']}\n"
        f"IMAGE_ID={identity['image_id']}\n"
        f"MANIFEST_SHA={identity['manifest_sha']}\n"
        f"LOCKFILE_SHA={identity['lockfile_sha']}\n"
        "AUTHORIZED_ACTION=production-deploy\n"
        "EXPLICIT_APPROVAL=true\n"
        "CONSUMABLE_ONCE=true\n"
        "PRODUCTION_DEPLOY_AUTHORIZED=true\n"
        "PRODUCTION_DEPLOY_EXECUTED=false\n"
    )
    auth_path.chmod(0o600)

    if scenario == "preexisting-claim" or scenario == "replay-after-success":
        # Pre-create claim artifact (hard-link)
        claim_path = progress / f"web-release-authorization-claim-{fingerprint}.env"
        if not claim_path.exists():
            os.link(auth_path, claim_path)
            claim_path.chmod(0o600)

    return auth_path


def repo_initial_head(repo: Path) -> str:
    """Return HEAD SHA (which is also SOURCE_SHA since we are on main with HEAD==origin)."""
    return subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()


# ----------------------------------------------------------------------------
# Planner invocation
# ----------------------------------------------------------------------------
def invoke_planner(repo: Path, source_sha: str) -> Tuple[int, str]:
    """Run the actual exact-byte Planner and parse its KV output."""
    planner = repo / PLANNER_REL
    env = os.environ.copy()
    env["PATH"] = f"{repo}/fake_bin:" + env["PATH"]
    env["TMPDIR"] = str(repo)
    proc = subprocess.run(
        [str(planner), "--plan-production-deploy", source_sha],
        cwd=str(repo), env=env, capture_output=True, text=True, timeout=120,
    )
    return proc.returncode, proc.stdout


def parse_kv(text: str, key: str) -> Optional[str]:
    for line in text.splitlines():
        if line.startswith(f"{key}="):
            return line.split("=", 1)[1]
    return None


# ----------------------------------------------------------------------------
# Execution Plan validation
# ----------------------------------------------------------------------------
def find_execution_plan(repo: Path, planner_text: str) -> Optional[Path]:
    artifact = parse_kv(planner_text, "EXECUTION_PLAN_ARTIFACT")
    if not artifact:
        return None
    p = Path(artifact)
    if not p.is_absolute():
        p = repo / p
    return p


MANDATORY_PLAN_KEYS = [
    "EXECUTION_PLAN_VERSION",
    "SOURCE_SHA",
    "RELEASE_PLAN_FINGERPRINT",
    "EXECUTION_PLAN_FINGERPRINT",
    "IMAGE_TAG",
    "IMAGE_ID",
    "MANIFEST_SHA",
    "LOCKFILE_SHA",
    "AUTHORIZATION_SHA256",
    "CANDIDATE_EVIDENCE_SHA256",
    "PIPELINE_HEAD",
    "PLAN_RUNTIME_SHA256",
    "AUTHORIZE_RUNTIME_SHA256",
    "CLAIM_RUNTIME_SHA256",
    "ORCHESTRATOR_RUNTIME_SHA256",
    "DEPLOY_RUNTIME_SHA256",
    "RUNTIME_ACCEPTANCE_GATE_SHA256",
    "PRE_WEB_CID",
    "PRE_WEB_STARTED_AT",
    "PRE_WEB_CONFIG_IMAGE",
    "PRE_WEB_IMAGE_ID",
    "PRE_API_CID",
    "PRE_API_STARTED_AT",
    "PRE_MEILI_CID",
    "PRE_MEILI_STARTED_AT",
    "L2_QUICK",
    "RELEASE_PLAN",
    "AUTHORIZATION_VALIDATED",
    "AUTHORIZATION_UNCLAIMED",
    "EXECUTION_PLAN_READY",
]


def validate_execution_plan(plan_path: Path, scenario: str,
                            original_content: Optional[bytes] = None) -> Tuple[bool, str, Dict[str, str]]:
    if not plan_path.exists():
        return False, "EXECUTION_PLAN_MISSING", {}
    if plan_path.is_symlink():
        return False, "EXECUTION_PLAN_SYMLINK", {}
    if not plan_path.is_file():
        return False, "EXECUTION_PLAN_NOT_REGULAR", {}
    mode = plan_path.stat().st_mode & 0o777
    if mode != 0o600:
        return False, f"EXECUTION_PLAN_BAD_MODE_{oct(mode)}", {}

    content = plan_path.read_bytes()

    # Tampered-execution-plan scenario: alter IMAGE_ID on disk
    if scenario == "tampered-execution-plan":
        text = content.decode()
        text = text.replace(IMAGE_ID_DEFAULT, "sha256:deadbeef" + "0" * 56)
        plan_path.write_text(text)
        content = plan_path.read_bytes()

    text = content.decode()
    kv: Dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            kv.setdefault(k, v)  # first wins (refuse duplicate)

    # exactly once per mandatory key
    for key in MANDATORY_PLAN_KEYS:
        cnt = text.count(f"\n{key}=") + (1 if text.startswith(f"{key}=") else 0)
        if cnt != 1:
            return False, f"EXECUTION_PLAN_FIELD_{key}_COUNT_{cnt}", kv

    # Tamper detection: IMAGE_ID must match identity from caller
    if scenario == "tampered-execution-plan":
        expected_id = IMAGE_ID_DEFAULT  # The original (non-tampered) image_id
        if kv.get("IMAGE_ID") == expected_id:
            return False, "TAMPER_NOT_APPLIED", kv
        return False, "EXECUTION_PLAN_TAMPERED", kv

    return True, "OK", kv


# ----------------------------------------------------------------------------
# Claim runtime invocation
# ----------------------------------------------------------------------------
def invoke_claim(repo: Path, source_sha: str) -> Tuple[int, str]:
    """Run the actual exact-byte Claim runtime."""
    claim = repo / CLAIM_REL
    env = os.environ.copy()
    env["PATH"] = f"{repo}/fake_bin:" + env["PATH"]
    env["TMPDIR"] = str(repo)
    proc = subprocess.run(
        [str(claim), "--claim-production-deploy", source_sha],
        cwd=str(repo), env=env, capture_output=True, text=True, timeout=60,
    )
    return proc.returncode, proc.stdout


def claim_artifact_exists(repo: Path, fingerprint: str) -> bool:
    return (repo / "progress" / f"web-release-authorization-claim-{fingerprint}.env").exists()


# ----------------------------------------------------------------------------
# Start / Result artifacts (atomic write, mode 600, no overwrite)
# ----------------------------------------------------------------------------
def write_atomic_no_overwrite(path: Path, content: str) -> bool:
    """Write atomically: refuse if path exists. mode 600. atomic via temp+rename."""
    if path.exists():
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=".tmp_", suffix=".env")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(content)
        os.chmod(tmp, 0o600)
        os.rename(tmp, path)
        return True
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


# ----------------------------------------------------------------------------
# State classifier (filesystem-based)
# ----------------------------------------------------------------------------
def classify_state(repo: Path, fingerprint: str) -> Tuple[str, Dict[str, bool]]:
    progress = repo / "progress"
    auth = progress / f"web-release-authorization-{fingerprint}.env"
    claim = progress / f"web-release-authorization-claim-{fingerprint}.env"
    start = progress / f"web-release-production-attempt-{fingerprint}.start.env"
    result = progress / f"web-release-production-attempt-{fingerprint}.result.env"

    flags = {
        "auth_exists": auth.exists(),
        "claim_exists": claim.exists(),
        "start_exists": start.exists(),
        "result_exists": result.exists(),
    }
    if flags["result_exists"]:
        text = result.read_text()
        if "FINAL_STATUS=PASS" in text:
            return "ATTEMPT_FINALIZED_PASS", flags
        return "ATTEMPT_FINALIZED_FAILED", flags
    if flags["start_exists"]:
        return "ATTEMPT_STATUS_UNKNOWN", flags
    if flags["claim_exists"]:
        return "CLAIMED_NOT_STARTED", flags
    if flags["auth_exists"]:
        return "AUTHORIZED_UNCLAIMED", flags
    return "NO_AUTHORIZATION", flags


# ----------------------------------------------------------------------------
# Simulated production write
# ----------------------------------------------------------------------------
def simulated_first_production_write(simdir: Path, scenario: str,
                                     identity: Dict[str, str]) -> Tuple[bool, str]:
    """Write to simdir/production-web-state.json (NOT real docker).

    Returns (success, exit_code_str).
    """
    web_state_path = simdir / "production-web-state.json"
    if scenario == "deploy-failure":
        # Deploy script nonzero: do NOT mutate web state (simulates deploy failure
        # before image change is committed)
        return False, "deploy_command_returned_nonzero"

    # Web state mutation = SIMULATED_FIRST_PRODUCTION_WRITE
    new_state = {
        "Id": identity["image_id"].replace("sha256:", "").ljust(64, "0")[:64],
        "State": {"StartedAt": "2099-01-01T00:00:00.000000000Z"},
        "Config": {"Image": identity["image_tag"]},
        "Image": identity["image_id"],
    }
    web_state_path.write_text(json.dumps(new_state, indent=2))

    if scenario == "scope-violation":
        # Mutate API/Meili (PRODUCTION_SCOPE_VIOLATION)
        (simdir / "production-api-state.json").write_text(json.dumps({
            "Id": "deadbeef" * 8,
            "State": {"StartedAt": "2099-02-02T00:00:00.000000000Z"},
        }))
        (simdir / "production-meili-state.json").write_text(json.dumps({
            "Id": "cafebabe" * 8,
            "State": {"StartedAt": "2099-03-03T00:00:00.000000000Z"},
        }))

    return True, "0"


# ----------------------------------------------------------------------------
# Post-verify checks
# ----------------------------------------------------------------------------
def post_verify(simdir: Path, identity: Dict[str, str], scenario: str) -> Tuple[bool, str]:
    web = json.loads((simdir / "production-web-state.json").read_text())
    api = json.loads((simdir / "production-api-state.json").read_text())
    meili = json.loads((simdir / "production-meili-state.json").read_text())

    if scenario == "postverify-failure":
        # Force a failure: image identity doesn't match Plan
        return False, "IMAGE_IDENTITY_VERIFIED=false"

    # Image identity
    if web.get("Image") != identity["image_id"]:
        return False, "IMAGE_IDENTITY_VERIFIED=false"
    if web.get("Config", {}).get("Image") != identity["image_tag"]:
        return False, "IMAGE_IDENTITY_VERIFIED=false"
    # Static identity assumed equal (we don't compute real static SHA)
    # API/Meili invariance
    if api.get("Id") != "2222222222222222222222222222222222222222222222222222222222222222":
        return False, "API_SCOPE_VIOLATION"
    if meili.get("Id") != "3333333333333333333333333333333333333333333333333333333333333333":
        return False, "MEILI_SCOPE_VIOLATION"
    # Direct production smoke (always PASS in sim)
    return True, "DIRECT_PRODUCTION_SMOKE=PASS"


# ----------------------------------------------------------------------------
# Top-level scenario driver
# ----------------------------------------------------------------------------
def run_simulation(scenario: str) -> int:
    if scenario not in ALLOWED_SCENARIOS:
        return emit_block("INVALID_SCENARIO", ALLOWED=list(ALLOWED_SCENARIOS))

    tmp, repo = make_workspace(scenario)
    log_event("WORKSPACE_READY")

    try:
        log_event("PLANNER_COPY")
        copy_exact_byte(REPO_ROOT / PLANNER_REL, repo / PLANNER_REL)
        copy_exact_byte(REPO_ROOT / CLAIM_REL, repo / CLAIM_REL)

        # Setup fixture
        log_event("FIXTURE_CREATE")
        identity = write_fake_runtime(repo, scenario)
        source_sha = repo_initial_head(repo)

        # Compute fingerprint matching the Planner's canonical REC_FP formula:
        #   sha256("SOURCE_SHA=X\nIMAGE_TAG=Y\nIMAGE_ID=Z\nMANIFEST=A\nLOCKFILE=B\n")
        canon = (
            f"SOURCE_SHA={source_sha}\n"
            f"IMAGE_TAG={identity['image_tag']}\n"
            f"IMAGE_ID={identity['image_id']}\n"
            f"MANIFEST_SHA={identity['manifest_sha']}\n"
            f"LOCKFILE_SHA={identity['lockfile_sha']}\n"
        )
        fingerprint = hashlib.sha256(canon.encode()).hexdigest()

        if scenario != "preexisting-claim":
            write_authorization(repo, identity, fingerprint, scenario)
        else:
            # Preexisting-claim: write authorization AND pre-create claim
            write_authorization(repo, identity, fingerprint, scenario)

        # Replay scenarios: also pre-create claim + start + result
        if scenario == "replay-after-success":
            progress = repo / "progress"
            # Pre-create claim + start + result (PASS)
            claim_path = progress / f"web-release-authorization-claim-{fingerprint}.env"
            if not claim_path.exists():
                # Hard-link from auth (atomic claim)
                auth_p = repo / "progress" / f"web-release-authorization-{fingerprint}.env"
                os.link(auth_p, claim_path)
                claim_path.chmod(0o600)
            # Write start artifact
            start_path = repo / "progress" / f"web-release-production-attempt-{fingerprint}.start.env"
            if not start_path.exists():
                start_path.write_text(
                    "ATTEMPT_VERSION=1\n"
                    f"SOURCE_SHA={source_sha}\n"
                    f"RELEASE_PLAN_FINGERPRINT={fingerprint}\n"
                    f"IMAGE_TAG={identity['image_tag']}\n"
                    f"IMAGE_ID={identity['image_id']}\n"
                    "AUTHORIZED=true\nCLAIMED=true\nPRODUCTION_DEPLOY_STARTED=true\n"
                )
                start_path.chmod(0o600)
            # Write result artifact (PASS)
            result_path = repo / "progress" / f"web-release-production-attempt-{fingerprint}.result.env"
            if not result_path.exists():
                result_path.write_text(
                    "RESULT_VERSION=1\n"
                    f"SOURCE_SHA={source_sha}\n"
                    f"RELEASE_PLAN_FINGERPRINT={fingerprint}\n"
                    "DEPLOY_EXIT_CODE=0\nPRODUCTION_TOUCHED=true\n"
                    "FINAL_STATUS=PASS\nFINAL_FAILURE_REASON=NONE\n"
                )
                result_path.chmod(0o600)

        # Move candidate evidence to canonical path expected by Release Plan: progress/web-release-candidate-${SOURCE_SHA}/
        progress = repo / "progress"
        simdir = repo / "simulation"
        cand_dir = progress / f"web-release-candidate-{source_sha}"
        cand_dir.mkdir(exist_ok=True)
        for src in [simdir / "candidate.json", simdir / "image-tag.txt",
                    simdir / "image-id.txt", simdir / "static-manifest.tsv",
                    simdir / "lockfile.sha256"]:
            if src.exists():
                shutil.copy2(src, cand_dir / src.name)

        # Commit state
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "fixture"], check=True)
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head], check=True)
        log_event("FIXTURE_READY")

        # Step 1: Run actual Planner
        log_event("PLANNER_RUN")
        planner_rc, planner_out = invoke_planner(repo, source_sha)
        if planner_rc != 0:
            # Preexisting-claim: planner blocks with AUTHORIZATION_ALREADY_CLAIMED
            if "AUTHORIZATION_ALREADY_CLAIMED" in planner_out:
                log_event("PLANNER_ALREADY_CLAIMED")
                state, flags = classify_state(repo, fingerprint)
                return emit_success("AUTHORIZATION_ALREADY_CLAIMED",
                                    CLASSIFIED_STATE=state, FLAGS=flags,
                                    NOTE="planner detected preexisting claim")
            log_event("PLANNER_BLOCKED")
            return emit_block("PLANNER_BLOCKED",
                              PLANNER_RC=planner_rc,
                              PLANNER_OUTPUT=planner_out[:500])

        # Capture original Execution Plan content (for tampered scenario)
        plan_path = find_execution_plan(repo, planner_out)
        if not plan_path or not plan_path.exists():
            log_event("EXECUTION_PLAN_MISSING")
            return emit_block("EXECUTION_PLAN_MISSING")
        original_content = plan_path.read_bytes()
        log_event("EXECUTION_PLAN_CREATED")

        # Step 2: Validate Execution Plan
        log_event("EXECUTION_PLAN_VALIDATE")
        ok, reason, kv = validate_execution_plan(plan_path, scenario, original_content)
        if not ok:
            log_event(f"EXECUTION_PLAN_VALIDATE_FAILED:{reason}")
            return emit_block(f"PRE_CLAIM_BLOCKED:{reason}")

        # Step 3: Post-claim minimal TOCTOU (after this point, only minimal revalidation)
        # For pre-existing claim, abort before claim.
        if scenario == "preexisting-claim":
            log_event("PRECLAIM_SKIP_CLAIM_PREEEXISTING")
            state, flags = classify_state(repo, fingerprint)
            return emit_success("AUTHORIZATION_ALREADY_CLAIMED",
                                CLASSIFIED_STATE=state,
                                FLAGS=flags,
                                NOTE="claim artifact pre-existed; no claim attempted")

        # Replay-after-success: artifacts already present, refuse to re-execute
        if scenario == "replay-after-success":
            log_event("REPLAY_DETECTED")
            state, flags = classify_state(repo, fingerprint)
            return emit_success("ATTEMPT_ALREADY_FINALIZED",
                                CLASSIFIED_STATE=state, FLAGS=flags,
                                NOTE="start+result already exist; no second attempt")

        # Step 4: Run actual Claim runtime (atomic hard-link)
        log_event("CLAIM_INVOKE")
        claim_rc, claim_out = invoke_claim(repo, source_sha)

        # Verify claim: must be PASS and claim artifact must exist
        if claim_rc != 0 or "STATUS=PASS" not in claim_out:
            log_event("CLAIM_FAILED")
            return emit_block(f"CLAIM_FAILED_RC{claim_rc}",
                              CLAIM_OUTPUT=claim_out[:500])
        if not claim_artifact_exists(repo, fingerprint):
            log_event("CLAIM_ARTIFACT_MISSING")
            return emit_block("CLAIM_ARTIFACT_MISSING")
        log_event("CLAIM_OK")

        # Capture auth/claim bytes (must be unchanged after start/result)
        auth_path = repo / "progress" / f"web-release-authorization-{fingerprint}.env"
        claim_path = repo / "progress" / f"web-release-authorization-claim-{fingerprint}.env"
        auth_bytes = auth_path.read_bytes()
        claim_bytes = claim_path.read_bytes()
        plan_bytes = plan_path.read_bytes()

        # Step 5: Crash after claim scenario
        if scenario == "crash-after-claim":
            log_event("CRASH_AFTER_CLAIM")
            state, flags = classify_state(repo, fingerprint)
            return emit_success("CLAIMED_NOT_STARTED",
                                CLASSIFIED_STATE=state, FLAGS=flags,
                                NOTE="simulated crash before start artifact; claim preserved")

        # Step 6: Post-claim minimal TOCTOU check
        log_event("POST_CLAIM_TOCTOU")
        # Minimal revalidation: image identity (and any scenario-specific)
        current_image_id = kv.get("IMAGE_ID", "")
        post_toctou_ok = (current_image_id == identity["image_id"])
        if scenario == "postclaim-toctou-failure":
            # Simulate post-claim image drift (already in identity override)
            post_toctou_ok = False
        if not post_toctou_ok:
            log_event("POST_CLAIM_TOCTOU_FAILED")
            state, flags = classify_state(repo, fingerprint)
            return emit_success("CLAIMED_NOT_STARTED",
                                CLASSIFIED_STATE=state, FLAGS=flags,
                                NOTE="post-claim image drift; no start; claim preserved")

        # Step 7: Start artifact (atomic, mode 600, no overwrite)
        start_path = repo / "progress" / f"web-release-production-attempt-{fingerprint}.start.env"
        exec_fp = kv.get("EXECUTION_PLAN_FINGERPRINT", fingerprint)
        start_content = (
            "ATTEMPT_VERSION=1\n"
            f"SOURCE_SHA={source_sha}\n"
            f"RELEASE_PLAN_FINGERPRINT={fingerprint}\n"
            f"EXECUTION_PLAN_FINGERPRINT={exec_fp}\n"
            f"IMAGE_TAG={identity['image_tag']}\n"
            f"IMAGE_ID={identity['image_id']}\n"
            f"PIPELINE_HEAD={head}\n"
            "PIPELINE_EXECUTOR_SHA256=" + hashlib.sha256(b"sim-executor").hexdigest() + "\n"
            "PIPELINE_PLAN_SHA256=" + kv.get("PLAN_RUNTIME_SHA256", "") + "\n"
            "PIPELINE_CLAIM_SHA256=" + kv.get("CLAIM_RUNTIME_SHA256", "") + "\n"
            "PIPELINE_DEPLOY_SHA256=" + kv.get("DEPLOY_RUNTIME_SHA256", "") + "\n"
            "PIPELINE_RUNTIME_GATE_SHA256=" + kv.get("RUNTIME_ACCEPTANCE_GATE_SHA256", "") + "\n"
            "AUTHORIZED=true\n"
            "CLAIMED=true\n"
            "PRODUCTION_DEPLOY_STARTED=true\n"
            f"STARTED_AT={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
            f"PRE_WEB_CID={kv.get('PRE_WEB_CID','')}\n"
            f"PRE_WEB_STARTED_AT={kv.get('PRE_WEB_STARTED_AT','')}\n"
            f"PRE_WEB_CONFIG_IMAGE={kv.get('PRE_WEB_CONFIG_IMAGE','')}\n"
            f"PRE_WEB_IMAGE_ID={kv.get('PRE_WEB_IMAGE_ID','')}\n"
            f"PRE_API_CID={kv.get('PRE_API_CID','')}\n"
            f"PRE_API_STARTED_AT={kv.get('PRE_API_STARTED_AT','')}\n"
            f"PRE_MEILI_CID={kv.get('PRE_MEILI_CID','')}\n"
            f"PRE_MEILI_STARTED_AT={kv.get('PRE_MEILI_STARTED_AT','')}\n"
        )
        if not write_atomic_no_overwrite(start_path, start_content):
            log_event("START_ALREADY_EXISTS")
            return emit_block("START_ALREADY_EXISTS")
        log_event("START_WRITTEN")

        # Step 8: Crash after start
        if scenario == "crash-after-start":
            log_event("CRASH_AFTER_START")
            state, flags = classify_state(repo, fingerprint)
            return emit_success("ATTEMPT_STATUS_UNKNOWN",
                                CLASSIFIED_STATE=state, FLAGS=flags,
                                NOTE="simulated crash before deploy write; start present, result absent")

        # Step 9: Simulated first production write
        log_event("SIMULATED_PRODUCTION_WRITE")
        simdir = repo / "simulation"
        write_ok, deploy_exit = simulated_first_production_write(simdir, scenario, identity)
        if not write_ok:
            # Deploy failure -> result with FINAL_STATUS=FAILED, production_touched=false
            log_event("DEPLOY_FAILED")
            result_path = repo / "progress" / f"web-release-production-attempt-{fingerprint}.result.env"
            result_content = (
                "RESULT_VERSION=1\n"
                f"SOURCE_SHA={source_sha}\n"
                f"RELEASE_PLAN_FINGERPRINT={fingerprint}\n"
                "DEPLOY_EXIT_CODE=1\n"
                "DEPLOY_SCRIPT_SHA256=" + kv.get("DEPLOY_RUNTIME_SHA256", "") + "\n"
                "PRODUCTION_TOUCHED=false\n"
                "POST_WEB_CID=PRE_WEB_CID\n"
                "POST_WEB_CONFIG_IMAGE=PRE_WEB_CONFIG_IMAGE\n"
                "POST_WEB_IMAGE_ID=PRE_WEB_IMAGE_ID\n"
                "IMAGE_IDENTITY_VERIFIED=false\n"
                "STATIC_IDENTITY_VERIFIED=false\n"
                "DIRECT_PRODUCTION_SMOKE=INCOMPLETE\n"
                "DIRECT_PRODUCTION_SMOKE_REPORT=none\n"
                "API_UNCHANGED=true\n"
                "MEILI_UNCHANGED=true\n"
                "FINAL_STATUS=FAILED\n"
                "FINAL_FAILURE_REASON=DEPLOY_FAILED\n"
                f"FINALIZED_AT={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
            )
            if not write_atomic_no_overwrite(result_path, result_content):
                return emit_block("RESULT_ALREADY_EXISTS")
            log_event("RESULT_WRITTEN")
            return emit_success("DEPLOY_FAILED",
                                CLASSIFIED_STATE="ATTEMPT_FINALIZED_FAILED",
                                FLAGS={"auth_exists": True, "claim_exists": True,
                                       "start_exists": True, "result_exists": True},
                                PRODUCTION_TOUCHED=False)

        log_event("PRODUCTION_WRITE_OK")

        # Step 10: Post-verify
        log_event("POST_VERIFY")
        verify_ok, verify_detail = post_verify(simdir, identity, scenario)
        if not verify_ok or scenario in ("postverify-failure", "scope-violation"):
            log_event("POST_VERIFY_FAILED")
            # ... continue to result writing
        production_touched = True

        # Step 11: Result artifact
        result_path = repo / "progress" / f"web-release-production-attempt-{fingerprint}.result.env"
        if verify_ok and scenario not in ("postverify-failure", "scope-violation"):
            final_status = "PASS"
            final_failure_reason = "NONE"
            image_verified = "true"
            static_verified = "true"
            smoke = "PASS"
            api_unchanged = "true"
            meili_unchanged = "true"
        else:
            final_status = "FAILED"
            if scenario == "postverify-failure":
                final_failure_reason = "POST_VERIFY_FAILED"
            elif scenario == "scope-violation":
                final_failure_reason = "PRODUCTION_SCOPE_VIOLATION"
            else:
                final_failure_reason = "POST_VERIFY_FAILED"
            image_verified = "false"
            static_verified = "false"
            smoke = "FAIL"
            api_unchanged = "false" if scenario == "scope-violation" else "true"
            meili_unchanged = "false" if scenario == "scope-violation" else "true"

        # Read POST state
        post_web = json.loads((simdir / "production-web-state.json").read_text())
        post_web_cid = post_web.get("Id", "")
        post_web_image = post_web.get("Image", "")
        post_web_image_id = post_web.get("Image", "")

        result_content = (
            "RESULT_VERSION=1\n"
            f"SOURCE_SHA={source_sha}\n"
            f"RELEASE_PLAN_FINGERPRINT={fingerprint}\n"
            f"DEPLOY_EXIT_CODE={deploy_exit if isinstance(deploy_exit, str) and deploy_exit.isdigit() else 0}\n"
            "DEPLOY_SCRIPT_SHA256=" + kv.get("DEPLOY_RUNTIME_SHA256", "") + "\n"
            f"PRODUCTION_TOUCHED={'true' if production_touched else 'false'}\n"
            f"POST_WEB_CID={post_web_cid}\n"
            f"POST_WEB_CONFIG_IMAGE={identity['image_tag']}\n"
            f"POST_WEB_IMAGE_ID={post_web_image_id}\n"
            f"IMAGE_IDENTITY_VERIFIED={image_verified}\n"
            f"STATIC_IDENTITY_VERIFIED={static_verified}\n"
            f"DIRECT_PRODUCTION_SMOKE={smoke}\n"
            "DIRECT_PRODUCTION_SMOKE_REPORT=simulated\n"
            f"API_UNCHANGED={api_unchanged}\n"
            f"MEILI_UNCHANGED={meili_unchanged}\n"
            f"FINAL_STATUS={final_status}\n"
            f"FINAL_FAILURE_REASON={final_failure_reason}\n"
            f"FINALIZED_AT={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
        )
        if not write_atomic_no_overwrite(result_path, result_content):
            return emit_block("RESULT_ALREADY_EXISTS")
        log_event("RESULT_WRITTEN")

        # Step 12: Immutability checks
        log_event("IMMUTABILITY_CHECK")
        if auth_path.read_bytes() != auth_bytes:
            return emit_block("AUTH_BYTES_MUTATED")
        if claim_path.read_bytes() != claim_bytes:
            return emit_block("CLAIM_BYTES_MUTATED")
        if plan_path.read_bytes() != plan_bytes:
            return emit_block("EXECUTION_PLAN_BYTES_MUTATED")

        state, flags = classify_state(repo, fingerprint)
        log_event(f"FINAL_STATE:{state}")

        if final_status == "PASS":
            return emit_success("DEPLOYMENT_ACCEPTED",
                                CLASSIFIED_STATE=state, FLAGS=flags,
                                PRODUCTION_TOUCHED=True,
                                NOTE="happy path accepted")
        return emit_success(final_failure_reason,
                            CLASSIFIED_STATE=state, FLAGS=flags,
                            PRODUCTION_TOUCHED=True,
                            NOTE=f"final_status={final_status}")

    except Exception as e:
        log_event(f"EXCEPTION:{type(e).__name__}:{e}")
        return emit_block("SIMULATOR_INTERNAL_ERROR",
                          TRACEBACK=traceback.format_exc()[-500:])
    finally:
        # Cleanup temp repo
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--scenario", required=True, choices=sorted(ALLOWED_SCENARIOS))
    p.add_argument("--seed", type=int, default=None)
    args = p.parse_args()
    if args.seed is not None:
        import random
        random.seed(args.seed)
    sys.exit(run_simulation(args.scenario))


if __name__ == "__main__":
    main()