#!/usr/bin/env python3
"""
Self-tests for the Read-only Production Deployment Execution Planner.

Each test creates an independent temp Git repo with controlled fixtures and
runs the planner against it. The planner is invoked via subprocess and never
mutates the real repo or production state.

Python stdlib only. No legacy Shell harness reuse.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
from pathlib import Path
from typing import Tuple

PLANNER_REPO_ROOT = Path(__file__).resolve().parent.parent
PLANNER_SCRIPT = PLANNER_REPO_ROOT / "scripts/plan-web-production-deployment-execution.sh"


# ----------------------------------------------------------------------------
# Temp-repo / fake fixture helpers
# ----------------------------------------------------------------------------
def sha_file(p: Path) -> str:
    """Compute SHA256 of a file (helper used by S27T-5E-R4 tests)."""
    import hashlib
    return hashlib.sha256(p.read_bytes()).hexdigest()


def install_planner(repo: Path) -> Path:
    """Copy (overwrite) the planner into the temp repo and commit it.

    Always re-copies to pick up any edits to the real planner.
    """
    planner_dst = repo / "scripts/plan-web-production-deployment-execution.sh"
    shutil.copy2(PLANNER_SCRIPT, planner_dst)
    planner_dst.chmod(0o755)
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    # If planner was changed, amend (--no-edit); if not tracked, commit
    r = subprocess.run(
        ["git", "-C", str(repo), "commit", "-q", "--amend", "--no-edit"],
        capture_output=True,
    )
    if r.returncode != 0:
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "planner"], check=True)
    head_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
    subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head_sha], check=True)
    return planner_dst


def make_temp_repo() -> Path:
    """Create an isolated temp Git repo with branch=main and HEAD==origin/main."""
    tmp = Path(tempfile.mkdtemp(prefix="s27t5b_planner_"))
    repo = tmp / "repo"
    repo.mkdir()
    scripts_dir = repo / "scripts"
    progress_dir = repo / "progress"
    scripts_dir.mkdir()
    progress_dir.mkdir()

    subprocess.run(["git", "-C", str(repo), "init", "-q", "-b", "main"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "planner@test"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "planner-test"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "commit.gpgsign", "false"], check=True)
    (repo / "README").write_text("test\n")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "init"], check=True)
    subprocess.run(["git", "-C", str(repo), "remote", "add", "origin", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "fetch", "origin", "main", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(repo), "branch", "--set-upstream-to=origin/main", "main"], check=True)
    head_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
    subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head_sha], check=True)
    install_planner(repo)
    return repo


def cleanup_progress_artifacts(repo: Path) -> None:
    """Remove any execution plan artifacts before next run."""
    progress = repo / "progress"
    if not progress.exists():
        return
    for f in progress.glob("web-release-production-execution-plan-*.env"):
        try:
            f.unlink()
        except OSError:
            pass


def copy_runtime_scripts(repo: Path) -> None:
    """Copy real runtime scripts exact-byte into temp repo."""
    for name in [
        "authorize-web-production-release.sh",
        "claim-web-production-release-authorization.sh",
        "deploy-web-release-candidate.sh",
        "orchestrate-web-production-release.sh",
        "plan-web-production-release.sh",
        "verify-web-release-readiness.sh",
    ]:
        src = PLANNER_REPO_ROOT / "scripts" / name
        dst = repo / "scripts" / name
        if src.exists():
            shutil.copy2(src, dst)
            dst.chmod(0o755)


def make_fake_plan_script(repo: Path, image_tag: str, image_id: str,
                           manifest_sha: str, lockfile_sha: str) -> str:
    source_sha = subprocess.check_output(
        ["git", "-C", str(repo), "rev-parse", "HEAD"]
    ).decode().strip()
    payload = "\n".join([
        f"SOURCE_SHA={source_sha}",
        f"IMAGE_TAG={image_tag}",
        f"IMAGE_ID={image_id}",
        f"MANIFEST_SHA={manifest_sha}",
        f"LOCKFILE_SHA={lockfile_sha}",
        "",
    ])
    fp = hashlib.sha256(payload.encode()).hexdigest()
    plan_script = repo / "scripts/plan-web-production-release.sh"
    plan_script.write_text(f"""#!/usr/bin/env bash
cat <<'PLAN_EOF'
STATUS=PASS
RELEASE_PLAN_VERSION=1
SOURCE_SHA={source_sha}
IMAGE_TAG={image_tag}
IMAGE_ID={image_id}
MANIFEST_SHA={manifest_sha}
LOCKFILE_SHA={lockfile_sha}
RELEASE_PLAN_FINGERPRINT={fp}
READINESS_GATE=PASS
ISOLATED_E2E=PASS
PRODUCTION_UNCHANGED=PASS
RELEASE_PLAN_READY=true
DEPLOY_EXECUTED=false
PLAN_EOF
""")
    plan_script.chmod(0o755)
    return fp


def write_fake_authorization(repo: Path, source_sha: str, fingerprint: str,
                              image_tag: str, image_id: str,
                              manifest_sha: str, lockfile_sha: str) -> Path:
    auth_path = repo / f"progress/web-release-authorization-{fingerprint}.env"
    auth_path.parent.mkdir(parents=True, exist_ok=True)
    auth_path.write_text(
        f"AUTHORIZATION_VERSION=1\n"
        f"AUTHORIZED_ACTION=production-deploy\n"
        f"SOURCE_SHA={source_sha}\n"
        f"RELEASE_PLAN_FINGERPRINT={fingerprint}\n"
        f"IMAGE_TAG={image_tag}\n"
        f"IMAGE_ID={image_id}\n"
        f"MANIFEST_SHA={manifest_sha}\n"
        f"LOCKFILE_SHA={lockfile_sha}\n"
        f"EXPLICIT_APPROVAL=true\n"
        f"CONSUMABLE_ONCE=true\n"
        f"PRODUCTION_DEPLOY_AUTHORIZED=true\n"
        f"PRODUCTION_DEPLOY_EXECUTED=false\n"
    )
    auth_path.chmod(0o600)
    return auth_path


def write_fake_candidate(repo: Path, image_tag: str, image_id: str,
                          manifest_sha: str, lockfile_sha: str,
                          source_sha: str) -> Path:
    cand_dir = repo / f"progress/web-release-candidate-{source_sha}"
    cand_dir.mkdir(parents=True, exist_ok=True)
    cand_json = cand_dir / "candidate.json"
    cand_json.write_text(json.dumps({
        "tag": image_tag,
        "imageId": image_id,
        "gitSha": source_sha,
        "lockfileSha256": lockfile_sha,
        "staticManifestSha256": manifest_sha,
    }, indent=2))
    (cand_dir / "static-manifest.tsv").write_text("dummy.tsv\t1\t" + "a" * 64 + "\n")
    return cand_dir


def write_fake_orchestrator(repo: Path, mode: str, image_tag: str, image_id: str) -> None:
    orch = repo / "scripts/orchestrate-web-production-release.sh"
    orch.write_text(f"""#!/usr/bin/env bash
cat <<'ORCH_EOF'
STATUS=PASS
ORCHESTRATION_MODE={mode}
SOURCE_SHA=$1
RELEASE_PLAN_FINGERPRINT=fakefingerprint
IMAGE_TAG={image_tag}
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
""")
    orch.chmod(0o755)


def write_fake_l2_quick(repo: Path, fail: bool = False) -> None:
    (repo / "scripts/verify-web-release-runtime-acceptance.py").write_text(textwrap.dedent(f"""\
        #!/usr/bin/env python3
        import sys
        if {fail}:
            print("STATUS=BLOCKED")
            sys.exit(1)
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
    (repo / "scripts/verify-web-release-runtime-acceptance.py").chmod(0o755)


def stub_docker(repo: Path, prod_changes: bool = False) -> None:
    """Override PATH so a fake 'docker' returns stable production facts.

    S27T-5E-R5B-P: extended to satisfy the project-aware Web identity
    contract. Planner Runtime now calls:
      docker compose ps -q web      → TEMP_WEB_CID  (via current_compose_cid_safe)
      docker inspect <TEMP_WEB_CID> --format=...  (via prod_fact_safe)
    The fake must answer both call patterns with the SAME TEMP_WEB_CID so
    PRE_WEB_* facts are non-empty and PRODUCTION_SNAPSHOT doesn't trigger.
    API/Meili still use literal container names (Planner Runtime did not
    change those); the fake keeps that contract.
    """
    fake_docker = repo / "fake_bin/docker"
    fake_docker.parent.mkdir(parents=True, exist_ok=True)
    fake_docker.write_text(textwrap.dedent("""\
        #!/usr/bin/env bash
        # S27T-5E-R5B-P: project-aware fake docker.
        TEMP_WEB_CID="f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da"
        TEMP_API_CID="aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899"
        TEMP_MEILI_CID="00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
        FAKE_IMAGE_ID="sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        FAKE_WEB_IMAGE="book-id-search-web:fakeimage"
        FAKE_WEB_STARTED_AT="2026-08-01T00:00:00.000000000Z"

        # Image inspect: handles JSON array, --format=value and --format value
        if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
            shift 2
            fmt=""
            while [ $# -gt 0 ]; do
                case "$1" in
                    --format=*) fmt="${1#--format=}" ;;
                    --format) shift; fmt="$1" ;;
                esac
                shift
            done
            case "$fmt" in
                '{{.Id}}') echo "$FAKE_IMAGE_ID" ;;
                *) echo '[{"Id": "'"$FAKE_IMAGE_ID"'"}]' ;;
            esac
            exit 0
        fi

        # docker compose ps -q <service>  (S27T-5E-R5B-P project-aware contract).
        # Returns the project's CID for the requested service.  Unknown
        # services return empty (so current_compose_cid_safe count=0 -> fail closed).
        if [ "$1" = "compose" ]; then
            if [ "$2" = "ps" ] && [ "$3" = "-q" ]; then
                case "$4" in
                    web)         printf '%s\\n' "$TEMP_WEB_CID" ;;
                    api)         printf '%s\\n' "$TEMP_API_CID" ;;
                    meilisearch) printf '%s\\n' "$TEMP_MEILI_CID" ;;
                    *) : ;;
                esac
            fi
            exit 0
        fi

        # Container inspect: handles --format=value and --format value
        # S27T-5E-R5B-P: also accepts TEMP_WEB_CID (returned by compose ps -q)
        # and TEMP_API_CID / TEMP_MEILI_CID.  For PRE-snapshot stability
        # inspects return the same web facts whether called via
        # book-id-search-web-1 (legacy literal) or TEMP_WEB_CID (project-aware).
        if [ "$1" = "inspect" ]; then
            name="$2"
            fmt=""
            shift 2
            while [ $# -gt 0 ]; do
                case "$1" in
                    --format=*) fmt="${1#--format=}" ;;
                    --format) shift; fmt="$1" ;;
                esac
                shift
            done
            case "$fmt" in
                '{{.Id}}')
                    if [ "$name" = "$TEMP_WEB_CID" ]; then
                        echo "$TEMP_WEB_CID"
                    elif [ "$PROD_CHANGES" = "1" ]; then
                        echo "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
                    else
                        echo "$TEMP_API_CID"
                    fi
                    ;;
                '{{.State.StartedAt}}') echo "$FAKE_WEB_STARTED_AT" ;;
                '{{.Config.Image}}') echo "$FAKE_WEB_IMAGE" ;;
                '{{.Image}}') echo "$FAKE_IMAGE_ID" ;;
                *) echo "" ;;
            esac
            exit 0
        fi

        if [ "$1" = "true" ]; then exit 0; fi
        # S27T-5E-R5B-P: unknown argv -> fail closed (no fallthrough to real docker).
        echo "ERROR: stub_docker unknown argv: $*" >&2
        exit 1
    """))
    fake_docker.chmod(0o755)
    fake_sudo = fake_docker.parent / "sudo"
    fake_sudo.write_text("#!/usr/bin/env bash\n# strip sudo flags (-n, etc) and exec the command\nwhile [ $# -gt 0 ]; do\n  case \"$1\" in\n    -*) shift ;;\n    *) break ;;\n  esac\ndone\nexec \"$@\"\n")
    fake_sudo.chmod(0o755)


def setup_clean_success_repo() -> Tuple[Path, dict]:
    """Build a fully valid temp repo for success path."""
    repo = make_temp_repo()
    cleanup_progress_artifacts(repo)
    copy_runtime_scripts(repo)

    image_tag = "registry.example.test/book-id-search/web:planner-test"
    image_id = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    manifest = "m" * 64
    lockfile = "l" * 64

    source_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
    fingerprint = make_fake_plan_script(repo, image_tag, image_id, manifest, lockfile)
    write_fake_authorization(repo, source_sha, fingerprint, image_tag, image_id, manifest, lockfile)
    write_fake_candidate(repo, image_tag, image_id, manifest, lockfile, source_sha)
    write_fake_orchestrator(repo, "authorized-isolated-e2e", image_tag, image_id)
    write_fake_l2_quick(repo, fail=False)
    stub_docker(repo, prod_changes=False)

    shutil.copy2(PLANNER_SCRIPT, repo / "scripts/plan-web-production-deployment-execution.sh")
    (repo / "scripts/plan-web-production-deployment-execution.sh").chmod(0o755)

    # Ensure fake_bin/ is gitignored so test fixtures don't dirty the worktree
    gi = repo / ".gitignore"
    existing = gi.read_text() if gi.exists() else ""
    if "fake_bin/" not in existing:
        gi.write_text(existing + ("\n" if existing and not existing.endswith("\n") else "") + "fake_bin/\n")
    # Also ignore __pycache__ from the L2 quick gate's python invocation
    if "__pycache__/" not in existing and "__pycache__/" not in (gi.read_text() if gi.exists() else ""):
        with gi.open("a") as f:
            f.write("__pycache__/\n")
    # Ignore test temp files
    if ".isolated_deploy_started" not in (gi.read_text() if gi.exists() else ""):
        with gi.open("a") as f:
            f.write(".isolated_deploy_started\n")
    if ".docker_inspect_counter" not in (gi.read_text() if gi.exists() else ""):
        with gi.open("a") as f:
            f.write(".docker_inspect_counter\n")

    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "fixture"], check=True)
    head_sha = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
    subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head_sha], check=True)

    return repo, {
        "source_sha": source_sha,
        "fingerprint": fingerprint,
        "image_tag": image_tag,
        "image_id": image_id,
        "manifest": manifest,
        "lockfile": lockfile,
    }


def run_planner(repo: Path, source_sha: str, timeout: int = 60) -> Tuple[int, str]:
    env = os.environ.copy()
    env["PATH"] = f"{repo}/fake_bin:" + env["PATH"]
    env["TMPDIR"] = str(repo)
    proc = subprocess.run(
        [str(repo / "scripts/plan-web-production-deployment-execution.sh"),
         "--plan-production-deploy", source_sha],
        cwd=str(repo), env=env, capture_output=True, timeout=timeout,
    )
    return proc.returncode, proc.stdout.decode("utf-8", errors="replace")


# ----------------------------------------------------------------------------
# Test runner
# ----------------------------------------------------------------------------
TESTS = []
def test(name):
    def deco(fn):
        TESTS.append((name, fn))
        return fn
    return deco


@test("01_invalid_arguments")
def t01():
    repo = make_temp_repo()
    try:
        proc = subprocess.run(
            [str(repo / "scripts/plan-web-production-deployment-execution.sh")], cwd=str(repo),
            env={**os.environ, "PATH": f"{repo}/fake_bin:{os.environ['PATH']}"},
            capture_output=True, timeout=30,
        )
        assert proc.returncode != 0
        assert "INVALID_ARGUMENTS" in proc.stdout.decode()
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("02_invalid_sha_format")
def t02():
    repo = make_temp_repo()
    try:
        proc = subprocess.run(
            [str(repo / "scripts/plan-web-production-deployment-execution.sh"), "--plan-production-deploy", "notahex"],
            cwd=str(repo), env=os.environ.copy(),
            capture_output=True, timeout=30,
        )
        assert proc.returncode != 0
        assert "INVALID_SOURCE_SHA" in proc.stdout.decode()
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("03_forbidden_identity_flag_blocked")
def t03():
    repo = make_temp_repo()
    try:
        proc = subprocess.run(
            [str(repo / "scripts/plan-web-production-deployment-execution.sh"), "--execute-production-deploy", "1" * 40],
            cwd=str(repo), env=os.environ.copy(),
            capture_output=True, timeout=30,
        )
        assert proc.returncode != 0
        assert "INVALID_ARGUMENTS" in proc.stdout.decode()
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("04_not_main_branch")
def t04():
    repo = make_temp_repo()
    try:
        subprocess.run(["git", "-C", str(repo), "checkout", "-q", "-b", "feature"], check=True)
        env = os.environ.copy()
        env["PATH"] = f"{repo}/fake_bin:{env['PATH']}"
        proc = subprocess.run(
            [str(repo / "scripts/plan-web-production-deployment-execution.sh"), "--plan-production-deploy", "1" * 40],
            cwd=str(repo), env=env, capture_output=True, timeout=30,
        )
        assert proc.returncode != 0
        assert "NOT_MAIN_BRANCH" in proc.stdout.decode()
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("05_dirty_worktree")
def t05():
    repo = make_temp_repo()
    try:
        (repo / "untracked.txt").write_text("dirty")
        env = os.environ.copy()
        env["PATH"] = f"{repo}/fake_bin:{env['PATH']}"
        proc = subprocess.run(
            [str(repo / "scripts/plan-web-production-deployment-execution.sh"), "--plan-production-deploy", "1" * 40],
            cwd=str(repo), env=env, capture_output=True, timeout=30,
        )
        assert proc.returncode != 0
        assert "WORKTREE_NOT_CLEAN" in proc.stdout.decode()
    finally:
        shutil.rmtree(repo, ignore_errors=True)



@test("05b_pycache_side_effect_not_dirty")
def t05b():
    """Python bytecode cache is an expected verifier side effect and must not
    make Planner disagree with Executor about worktree cleanliness."""
    repo = make_temp_repo()
    try:
        # The normal success fixture ignores __pycache__, which masked the
        # production bug.  Remove any such fixture ignore here so this test
        # exercises Planner's own worktree policy.
        gi = repo / ".gitignore"
        if gi.exists():
            original = gi.read_text()
            kept = []
            for line in original.splitlines():
                stripped = line.strip()
                if stripped in (
                    "__pycache__/",
                    "/__pycache__/",
                    "scripts/__pycache__/",
                    "/scripts/__pycache__/",
                    "scripts/verify/__pycache__/",
                    "/scripts/verify/__pycache__/",
                ):
                    continue
                kept.append(line)

            rewritten = "\n".join(kept)
            if original.endswith("\n") and rewritten:
                rewritten += "\n"

            if rewritten != original:
                gi.write_text(rewritten)
                subprocess.run(
                    ["git", "-C", str(repo), "add", ".gitignore"],
                    check=True,
                )
                subprocess.run(
                    [
                        "git", "-C", str(repo),
                        "commit", "-q",
                        "-m", "fixture: expose pycache to git status",
                    ],
                    check=True,
                )

        # Production already has tracked files under scripts/verify/.
        # Reproduce that topology explicitly; otherwise porcelain status may
        # collapse the whole new parent as "?? scripts/verify/" instead of
        # exposing only its __pycache__ child.
        verify_parent = repo / "scripts/verify"
        verify_parent.mkdir(parents=True, exist_ok=True)

        tracked_verify_file = verify_parent / "fixture_tracked_runtime.py"
        tracked_verify_file.write_text("# tracked fixture parent\n")

        subprocess.run(
            [
                "git", "-C", str(repo),
                "add",
                "scripts/verify/fixture_tracked_runtime.py",
            ],
            check=True,
        )

        subprocess.run(
            [
                "git", "-C", str(repo),
                "commit", "-q",
                "-m", "fixture: track scripts verify parent",
            ],
            check=True,
        )

        # Keep HEAD == origin/main so a successful worktree-policy check can
        # proceed to a later gate instead of failing for repository drift.
        head = subprocess.check_output(
            ["git", "-C", str(repo), "rev-parse", "HEAD"]
        ).decode().strip()

        subprocess.run(
            [
                "git", "-C", str(repo),
                "update-ref",
                "refs/remotes/origin/main",
                head,
            ],
            check=True,
        )

        cache_a = repo / "scripts/__pycache__"
        cache_b = repo / "scripts/verify/__pycache__"

        cache_a.mkdir(parents=True, exist_ok=True)
        cache_b.mkdir(parents=True, exist_ok=True)

        probe_a = cache_a / "planner_probe.pyc"
        probe_b = cache_b / "runtime_probe.pyc"

        probe_a.write_bytes(b"synthetic-planner-pyc")
        probe_b.write_bytes(b"synthetic-runtime-pyc")

        raw_status = subprocess.check_output(
            [
                "git", "-C", str(repo),
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ]
        ).decode()

        assert "scripts/__pycache__/planner_probe.pyc" in raw_status, (
            "RED1_FIXTURE_INVALID: scripts/__pycache__ probe is not visible "
            "to git status"
        )
        assert "scripts/verify/__pycache__/runtime_probe.pyc" in raw_status, (
            "RED1_FIXTURE_INVALID: scripts/verify/__pycache__ probe is not "
            "visible to git status"
        )

        # Planner uses default porcelain mode rather than --untracked-files=all.
        # Assert that its actual input surface sees the two cache directories
        # and does not collapse scripts/verify/ as a wholly-untracked parent.
        planner_status = subprocess.check_output(
            [
                "git", "-C", str(repo),
                "status",
                "--porcelain=v1",
            ]
        ).decode()

        assert "?? scripts/__pycache__/" in planner_status, (
            "RED1_FIXTURE_INVALID: default porcelain did not expose "
            "scripts/__pycache__; status=" + repr(planner_status)
        )

        assert "?? scripts/verify/__pycache__/" in planner_status, (
            "RED1_FIXTURE_INVALID: default porcelain did not expose "
            "scripts/verify/__pycache__; status=" + repr(planner_status)
        )

        assert "?? scripts/verify/" not in [
            line
            for line in planner_status.splitlines()
            if line == "?? scripts/verify/"
        ], (
            "RED1_FIXTURE_INVALID: scripts/verify parent is wholly untracked; "
            "status=" + repr(planner_status)
        )

        env = os.environ.copy()
        env["PATH"] = f"{repo}/fake_bin:{env['PATH']}"

        proc = subprocess.run(
            [
                str(repo / "scripts/plan-web-production-deployment-execution.sh"),
                "--plan-production-deploy",
                head,
            ],
            cwd=str(repo),
            env=env,
            capture_output=True,
            timeout=30,
        )

        out = proc.stdout.decode("utf-8", errors="replace")

        assert "WORKTREE_NOT_CLEAN" not in out, (
            "PYCACHE_POLICY_BUG: Planner treated expected Python bytecode "
            "cache as a dirty worktree; output=" + repr(out)
        )

    finally:
        shutil.rmtree(repo, ignore_errors=True)



@test("06_HEAD_origin_mismatch")
def t06():
    repo = make_temp_repo()
    try:
        (repo / "extra.txt").write_text("extra")
        subprocess.run(["git", "-C", str(repo), "add", "extra.txt"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "extra"], check=True)
        env = os.environ.copy()
        env["PATH"] = f"{repo}/fake_bin:{env['PATH']}"
        proc = subprocess.run(
            [str(repo / "scripts/plan-web-production-deployment-execution.sh"), "--plan-production-deploy", "1" * 40],
            cwd=str(repo), env=env, capture_output=True, timeout=30,
        )
        assert proc.returncode != 0
        assert "HEAD_ORIGIN_MISMATCH" in proc.stdout.decode()
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("07_l2_quick_failure")
def t07():
    repo, info = setup_clean_success_repo()
    try:
        write_fake_l2_quick(repo, fail=True)
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "fail-l2"], check=True)
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head], check=True)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0
        assert "RUNTIME_ACCEPTANCE_QUICK_FAILED" in out
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("08_plan_failed")
def t08():
    repo, info = setup_clean_success_repo()
    try:
        plan = repo / "scripts/plan-web-production-release.sh"
        plan.write_text("#!/usr/bin/env bash\necho STATUS=BLOCKED\necho BLOCK_REASON=INVALID\necho RELEASE_PLAN_READY=false\necho DEPLOY_EXECUTED=false\nexit 1\n")
        plan.chmod(0o755)
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "fail-plan"], check=True)
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head], check=True)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0
        assert "RELEASE_PLAN_FAILED" in out
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("09_authorization_missing")
def t09():
    repo, info = setup_clean_success_repo()
    try:
        auth_path = repo / f"progress/web-release-authorization-{info['fingerprint']}.env"
        auth_path.unlink()
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "no-auth"], check=True)
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head], check=True)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0
        assert "AUTHORIZATION_MISSING" in out
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("10_authorization_wrong_mode")
def t10():
    repo, info = setup_clean_success_repo()
    try:
        auth_path = repo / f"progress/web-release-authorization-{info['fingerprint']}.env"
        auth_path.chmod(0o644)
        # Configure git to track mode changes explicitly
        subprocess.run(["git", "-C", str(repo), "config", "core.fileMode", "true"], check=True)
        # Stage the mode change explicitly via update-index
        rel = str(auth_path.relative_to(repo))
        subprocess.run(["git", "-C", str(repo), "update-index", "--chmod=+x", rel], check=False)
        # Add a comment to force content change
        with open(auth_path, "a") as f:
            f.write("# mode changed for test\n")
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "wrong-mode"], check=True)
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head], check=True)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0
        assert "AUTHORIZATION_UNSAFE_PERMISSIONS" in out
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("11_authorization_symlink")
def t11():
    repo, info = setup_clean_success_repo()
    try:
        auth_path = repo / f"progress/web-release-authorization-{info['fingerprint']}.env"
        real_path = repo / "progress/_real_auth.env"
        real_path.write_text(auth_path.read_text())
        auth_path.unlink()
        auth_path.symlink_to(real_path)
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "symlink-auth"], check=True)
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head], check=True)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0
        assert "AUTHORIZATION_UNSAFE_FILE" in out
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("12_authorization_plan_mismatch")
def t12():
    repo, info = setup_clean_success_repo()
    try:
        auth_path = repo / f"progress/web-release-authorization-{info['fingerprint']}.env"
        text = auth_path.read_text()
        text = text.replace(info["image_tag"], "registry.example.test/different/web:wrong")
        auth_path.write_text(text)
        auth_path.chmod(0o600)
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "mismatch"], check=True)
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head], check=True)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0
        assert "AUTHORIZATION_PLAN_MISMATCH" in out
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("13_preexisting_claim")
def t13():
    repo, info = setup_clean_success_repo()
    try:
        auth_path = repo / f"progress/web-release-authorization-{info['fingerprint']}.env"
        claim_path = repo / f"progress/web-release-authorization-claim-{info['fingerprint']}.env"
        claim_path.write_text(auth_path.read_text())
        claim_path.chmod(0o600)
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "preclaim"], check=True)
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head], check=True)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0
        assert "AUTHORIZATION_ALREADY_CLAIMED" in out
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("14_image_identity_changed")
def t14():
    repo, info = setup_clean_success_repo()
    try:
        # Patch fake docker: replace BOTH JSON and --format= branches
        # (fake_bin/ is gitignored in temp repo, so no commit needed)
        docker = repo / "fake_bin/docker"
        text = docker.read_text()
        wrong = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
        text = text.replace(
            "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            wrong,
        )
        docker.write_text(text)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0
        assert "PRECLAIM_IMAGE_IDENTITY_CHANGED" in out
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("15_authorized_isolated_failed")
def t15():
    repo, info = setup_clean_success_repo()
    try:
        orch = repo / "scripts/orchestrate-web-production-release.sh"
        orch.write_text("#!/usr/bin/env bash\necho STATUS=BLOCKED\necho BLOCK_REASON=BLAH\nexit 1\n")
        orch.chmod(0o755)
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "fail-orch"], check=True)
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head], check=True)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0
        assert "AUTHORIZED_ISOLATED_E2E_FAILED" in out
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("16_production_changed_during_preflight")
def t16():
    """Planner BLOCKs when production differs between PRE and POST snapshots.

    Strategy: fake docker counts inspect calls. PRE snapshot uses first N
    inspect calls (project-aware Web + literal API/Meili -> correct
    metadata). After PRE snapshot is done, return WRONG metadata -> POST
    mismatch -> BLOCK.

    S27T-5E-R5B-P: extended to handle the project-aware `docker compose ps -q`
    call (which runs BEFORE any inspect and does NOT increment the counter),
    and the new TEMP_WEB_CID target for web inspects.
    """
    repo, info = setup_clean_success_repo()
    try:
        docker = repo / "fake_bin/docker"
        docker.write_text(textwrap.dedent("""\
            #!/usr/bin/env bash
            # S27T-5E-R5B-P: project-aware fake docker with inspect counter.
            TEMP_WEB_CID="f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da"
            PROD_INSPECT_COUNT_FILE="${TMPDIR:-/tmp}/.prod_inspect_count"
            if [ ! -f "$PROD_INSPECT_COUNT_FILE" ]; then
                echo 0 > "$PROD_INSPECT_COUNT_FILE"
            fi

            # S27T-5E-R5B-P: docker compose ps -q <service> -> TEMP_WEB_CID
            # (no counter increment; compose lookup is not an inspect)
            if [ "$1" = "compose" ]; then
                if [ "$2" = "ps" ] && [ "$3" = "-q" ]; then
                    case "$4" in
                        web)         printf '%s\\n' "$TEMP_WEB_CID" ;;
                        api)         printf '%s\\n' "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899" ;;
                        meilisearch) printf '%s\\n' "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" ;;
                        *) : ;;
                    esac
                fi
                exit 0
            fi

            # Container inspect: count and return based on count
            if [ "$1" = "inspect" ] && [ -n "$2" ] && [[ "$2" != --* ]]; then
                CNT=$(cat "$PROD_INSPECT_COUNT_FILE")
                CNT=$((CNT + 1))
                echo "$CNT" > "$PROD_INSPECT_COUNT_FILE"
                fmt=""
                shift 2
                while [ $# -gt 0 ]; do
                    case "$1" in
                        --format=*) fmt="${1#--format=}" ;;
                        --format) shift; fmt="$1" ;;
                    esac
                    shift
                done
                # S27T-5E-R5B-P: PRE snapshot now consists of 4 web inspects
                # (CID/STARTED_AT/CONFIG_IMAGE/IMAGE_ID via TEMP_WEB_CID) +
                # 2 api inspects + 2 meili inspects = 8 calls.
                # After 8 inspect calls (PRE snapshot done), return WRONG metadata
                # so POST snapshot mismatch triggers PRODUCTION_CHANGED_DURING_PREFLIGHT.
                if [ "$CNT" -gt 8 ]; then
                    case "$fmt" in
                        '{{.Id}}') echo "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" ;;
                        '{{.State.StartedAt}}') echo "2099-01-01T00:00:00.000000000Z" ;;
                        '{{.Config.Image}}') echo "book-id-search-web:CHANGED" ;;
                        '{{.Image}}') echo "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" ;;
                        *) echo "" ;;
                    esac
                else
                    case "$fmt" in
                        '{{.Id}}')
                            # S27T-5E-R5B-P: for TEMP_WEB_CID, return the CID itself
                            if [ "$2" = "$TEMP_WEB_CID" ]; then
                                echo "$TEMP_WEB_CID"
                            else
                                echo "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                            fi
                            ;;
                        '{{.State.StartedAt}}') echo "2026-08-01T00:00:00.000000000Z" ;;
                        '{{.Config.Image}}') echo "book-id-search-web:planner-test" ;;
                        '{{.Image}}') echo "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ;;
                        *) echo "" ;;
                    esac
                fi
                exit 0
            fi

            # Image inspect: always correct
            if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
                shift 2; fmt=""
                while [ $# -gt 0 ]; do
                    case "$1" in
                        --format=*) fmt="${1#--format=}" ;;
                        --format) shift; fmt="$1" ;;
                    esac
                    shift
                done
                case "$fmt" in
                    '{{.Id}}') echo "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ;;
                    *) echo '[{"Id": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}]' ;;
                esac
                exit 0
            fi

            # other commands: pass through
            if [ "$1" = "true" ]; then exit 0; fi
            # S27T-5E-R5B-P: unknown argv -> fail closed
            echo "ERROR: t16 fake docker unknown argv: $*" >&2
            exit 1
        """))
        docker.chmod(0o755)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0, f"expected BLOCK; got RC={rc}"
        assert "PRODUCTION_CHANGED_DURING_PREFLIGHT" in out, f"missing reason: {out[:300]}"
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("17_success_path_ready_to_claim")
def t17():
    repo, info = setup_clean_success_repo()
    try:
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc == 0, f"rc={rc}\nout={out}"
        for line in [
            "STATUS=READY_TO_CLAIM",
            "L2_QUICK=PASS",
            "RELEASE_PLAN=PASS",
            "AUTHORIZATION_VALIDATED=PASS",
            "AUTHORIZATION_UNCLAIMED=true",
            "PRECLAIM_IMAGE_IDENTITY=PASS",
            "AUTHORIZED_ISOLATED_E2E=PASS",
            "PRODUCTION_UNCHANGED=PASS",
            "EXECUTION_PLAN_READY=true",
            "CLAIM_EXECUTED=false",
            "PRODUCTION_DEPLOY_EXECUTED=false",
            "PRODUCTION_WRITE_EXECUTED=false",
            "AUTO_RETRY=false",
            "AUTO_ROLLBACK=false",
            "EXECUTION_AUTHORIZED=false",
        ]:
            assert line in out, f"missing: {line}\nfull out:\n{out}"
        for line in out.splitlines():
            if line.startswith("EXECUTION_PLAN_ARTIFACT="):
                artifact = Path(line.split("=", 1)[1])
                assert artifact.exists()
                assert (artifact.stat().st_mode & 0o777) == 0o600
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("17b_plan_runtime_sha256_canonical_semantic")
def t17b():
    """PLAN_RUNTIME_SHA256 in the artifact MUST equal SHA256 of THIS script
    (plan-web-production-deployment-execution.sh), not the SHA of any other
    sibling. S27T-5E-R4 canonical semantic: PLAN_RUNTIME_SHA256 =
    EXECUTION_PLANNER_RUNTIME."""
    repo, info = setup_clean_success_repo()
    try:
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc == 0, f"rc={rc}\nout={out}"
        # Find the Execution Plan artifact path from stdout
        artifact_path = None
        for line in out.splitlines():
            if line.startswith("EXECUTION_PLAN_ARTIFACT="):
                artifact_path = Path(line.split("=", 1)[1])
                break
        assert artifact_path is not None, "missing EXECUTION_PLAN_ARTIFACT in planner stdout"
        assert artifact_path.exists()
        artifact_text = artifact_path.read_text()
        # Parse PLAN_RUNTIME_SHA256 from artifact
        stored_sha = None
        for line in artifact_text.splitlines():
            if line.startswith("PLAN_RUNTIME_SHA256="):
                stored_sha = line.split("=", 1)[1]
                break
        assert stored_sha is not None, "missing PLAN_RUNTIME_SHA256 in artifact"
        # Compute the canonical expected value (SHA of THIS Planner script
        # installed in the temp repo).
        expected_sha = sha_file(repo / "scripts" / "plan-web-production-deployment-execution.sh")
        assert stored_sha == expected_sha, (
            f"PLAN_RUNTIME_SHA256 mismatch:\n"
            f"  stored:   {stored_sha}\n"
            f"  expected: {expected_sha}\n"
            f"  (must equal SHA of plan-web-production-deployment-execution.sh per S27T-5E-R4)"
        )
        # Also assert it does NOT equal the SHA of plan-web-production-release.sh
        # (the bug that was fixed).
        wrong_sha = sha_file(repo / "scripts" / "plan-web-production-release.sh")
        assert stored_sha != wrong_sha, (
            "PLAN_RUNTIME_SHA256 equals SHA of plan-web-production-release.sh "
            "— this is the pre-S27T-5E-R4 bug. Canonical semantic is Planner."
        )
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("17c_executor_recomputes_fingerprint_matches_plan")
def t17c():
    """Static contract test (S27T-5E-R4 Section 15):
    Planner writes artifact → Executor recomputes fingerprint → MUST match.
    This is the bug that was masked by test-side iterative reconciliation.

    We compute the fingerprint the same way the Executor does (line 380 of
    execute-web-production-release.sh): SHA256 over the canonical 24-field
    newline-joined string. The artifact's stored PLAN_RUNTIME_SHA256 must
    match the disk SHA of the Planner script (set in t17b). Therefore the
    Executor recomputation MUST equal the artifact's stored
    EXECUTION_PLAN_FINGERPRINT."""
    import hashlib
    repo, info = setup_clean_success_repo()
    try:
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc == 0, f"rc={rc}\nout={out}"
        artifact_path = None
        for line in out.splitlines():
            if line.startswith("EXECUTION_PLAN_ARTIFACT="):
                artifact_path = Path(line.split("=", 1)[1])
                break
        assert artifact_path is not None
        artifact_text = artifact_path.read_text()
        # Parse all 24 canonical fields
        canonical_fields = [
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
        kv = {}
        for line in artifact_text.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                kv[k] = v
        canonical = "\n".join(f"{f}={kv.get(f, '')}" for f in canonical_fields) + "\n"
        recomputed_fp = hashlib.sha256(canonical.encode()).hexdigest()
        assert recomputed_fp == kv["EXECUTION_PLAN_FINGERPRINT"], (
            f"Fingerprint mismatch:\n"
            f"  stored:      {kv['EXECUTION_PLAN_FINGERPRINT']}\n"
            f"  recomputed:  {recomputed_fp}\n"
            f"  This is the bug that previously caused EXECUTION_PLAN_FINGERPRINT_MISMATCH."
        )
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("17d_plan_runtime_sha256_wrong_other_script_blocks")
def t17d():
    """S27T-5E-R4 Section 16 regression: if a test or future regression were to
    set PLAN_RUNTIME_SHA256 to the SHA of a different script (e.g. the Release
    Plan), then the Executor's fingerprint recomputation MUST mismatch."""
    import hashlib
    repo, info = setup_clean_success_repo()
    try:
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc == 0, f"rc={rc}\nout={out}"
        artifact_path = None
        for line in out.splitlines():
            if line.startswith("EXECUTION_PLAN_ARTIFACT="):
                artifact_path = Path(line.split("=", 1)[1])
                break
        assert artifact_path is not None
        # Tamper the artifact body: replace PLAN_RUNTIME_SHA256 with SHA of
        # plan-web-production-release.sh (the old/wrong value).
        artifact_text = artifact_path.read_text()
        wrong_sha = sha_file(repo / "scripts" / "plan-web-production-release.sh")
        # Find the actual PLAN_RUNTIME_SHA256 line
        actual = None
        for line in artifact_text.splitlines():
            if line.startswith("PLAN_RUNTIME_SHA256="):
                actual = line.split("=", 1)[1]
                break
        artifact_text_tampered = artifact_text.replace(
            f"PLAN_RUNTIME_SHA256={actual}",
            f"PLAN_RUNTIME_SHA256={wrong_sha}",
            1,
        )
        artifact_path.write_text(artifact_text_tampered)
        # Recompute the fingerprint the Executor way and confirm mismatch.
        kv = {}
        for line in artifact_text_tampered.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                kv[k] = v
        canonical_fields = [
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
        canonical = "\n".join(f"{f}={kv.get(f, '')}" for f in canonical_fields) + "\n"
        recomputed_fp = hashlib.sha256(canonical.encode()).hexdigest()
        # Mismatch expected — this proves the fingerprint is bound to the
        # canonical semantic and would catch a regression.
        assert recomputed_fp != kv["EXECUTION_PLAN_FINGERPRINT"], (
            "Tampered artifact's recomputed FP unexpectedly matched — test setup invalid"
        )
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("18_execution_plan_already_exists")
def t18():
    """Second run must BLOCK with EXECUTION_PLAN_ALREADY_EXISTS (plan artifact persists)."""
    repo, info = setup_clean_success_repo()
    try:
        cleanup_progress_artifacts(repo)
        rc1, out1 = run_planner(repo, info["source_sha"])
        assert rc1 == 0, f"first run should PASS: {out1[:200]}"
        rc2, out2 = run_planner(repo, info["source_sha"])
        assert rc2 != 0, f"second run should BLOCK: {out2[:200]}"
        assert "EXECUTION_PLAN_ALREADY_EXISTS" in out2, f"wrong reason: {out2[:200]}"
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("19_no_claim_or_deploy_invocation_in_source")
def t19():
    """Static check: planner source MUST NOT invoke claim/deploy runtimes.

    Skips comment-only mentions; only flags actual code lines.
    """
    src_lines = PLANNER_SCRIPT.read_text().splitlines()
    forbidden_exec_substrings = [
        "bash $REPO_ROOT/scripts/claim-web-production-release-authorization.sh",
        "exec $REPO_ROOT/scripts/claim-web-production-release-authorization.sh",
        "bash $REPO_ROOT/scripts/deploy-web-release-candidate.sh",
        "exec $REPO_ROOT/scripts/deploy-web-release-candidate.sh",
    ]
    forbidden_exec_patterns = [
        re.compile(r"^[^#]*\bdocker\s+compose\s+up\b"),
        re.compile(r"^[^#]*\bdocker\s+compose\s+build\b"),
        re.compile(r"^[^#]*\bdocker\s+build\b"),
        re.compile(r"^[^#]*\bdocker\s+pull\b"),
    ]
    for i, line in enumerate(src_lines, 1):
        # Skip pure comment lines and lines starting with # (mid-line # is OK to scan)
        if line.lstrip().startswith("#"):
            continue
        for sub in forbidden_exec_substrings:
            if sub in line:
                raise AssertionError(f"planner line {i} contains forbidden exec: {sub}")
        for pat in forbidden_exec_patterns:
            if pat.search(line):
                raise AssertionError(f"planner line {i} matches forbidden pattern: {pat.pattern}")

@test("20_50_independent_success_repos")
def t20():
    successes = 0
    for _ in range(50):
        repo, info = setup_clean_success_repo()
        try:
            cleanup_progress_artifacts(repo)
            rc, out = run_planner(repo, info["source_sha"])
            if rc == 0 and "STATUS=READY_TO_CLAIM" in out:
                successes += 1
        finally:
            shutil.rmtree(repo, ignore_errors=True)
    assert successes == 50, f"only {successes}/50 PASS"


@test("21_parallel_4_workers_20_repos")
def t21():
    import concurrent.futures
    def run_one(_):
        repo, info = setup_clean_success_repo()
        try:
            cleanup_progress_artifacts(repo)
            rc, out = run_planner(repo, info["source_sha"])
            return rc == 0 and "STATUS=READY_TO_CLAIM" in out
        finally:
            shutil.rmtree(repo, ignore_errors=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(run_one, range(20)))
    assert sum(results) == 20, f"only {sum(results)}/20 PASS"


@test("22_candidate_evidence_missing")
def t22():
    repo, info = setup_clean_success_repo()
    try:
        cand_dir = repo / f"progress/web-release-candidate-{info['source_sha']}"
        shutil.rmtree(cand_dir)
        subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
        subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "no-cand"], check=True)
        head = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
        subprocess.run(["git", "-C", str(repo), "update-ref", "refs/remotes/origin/main", head], check=True)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc != 0
        assert "CANDIDATE_EVIDENCE_MISSING" in out
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("23_relocated_root")
def t23():
    repo, info = setup_clean_success_repo()
    try:
        cleanup_progress_artifacts(repo)
        new_parent = Path(tempfile.mkdtemp(prefix="s27t5b_relocate_"))
        new_repo = new_parent / "relocated_repo"
        shutil.copytree(repo, new_repo)
        rc, out = run_planner(new_repo, info["source_sha"])
        assert rc == 0, f"rc={rc}\nout={out}"
        shutil.rmtree(new_parent, ignore_errors=True)
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("24_path_with_spaces")
def t24():
    repo, info = setup_clean_success_repo()
    try:
        cleanup_progress_artifacts(repo)
        new_parent = Path(tempfile.mkdtemp(prefix="s27t5b spaces "))
        new_repo = new_parent / "repo with space"
        shutil.copytree(repo, new_repo)
        rc, out = run_planner(new_repo, info["source_sha"])
        assert rc == 0, f"rc={rc}\nout={out}"
        shutil.rmtree(new_parent, ignore_errors=True)
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("25_caller_cwd_independence")
def t25():
    repo, info = setup_clean_success_repo()
    try:
        cleanup_progress_artifacts(repo)
        env = os.environ.copy()
        env["PATH"] = f"{repo}/fake_bin:{env['PATH']}"
        env["TMPDIR"] = str(repo)
        proc = subprocess.run(
            [str(repo / "scripts/plan-web-production-deployment-execution.sh"),
             "--plan-production-deploy", info["source_sha"]],
            cwd="/tmp", env=env, capture_output=True, timeout=60,
        )
        assert proc.returncode == 0, proc.stdout.decode() + "\n" + proc.stderr.decode()
        assert "STATUS=READY_TO_CLAIM" in proc.stdout.decode()
    finally:
        shutil.rmtree(repo, ignore_errors=True)


@test("P01_planner_project_aware_web_isolation")
def tP01():
    """S27T-5E-R5B-P: prove the Planner Runtime uses the project-aware
    Compose Web CID path, NOT the legacy global-name path.

    Setup:
      - docker compose ps -q web  -> TEMP_CID
      - docker inspect TEMP_CID   -> returns TEMP_CID facts
      - docker inspect book-id-search-web-1 -> returns PROD_CID (DIFFERENT)

    If the Planner Runtime used the legacy global-name fallback
    (inspect book-id-search-web-1), it would write PROD_CID into the
    artifact's PRE_WEB_CID. If it uses the new project-aware path,
    it must write TEMP_CID.

    This test asserts TEMP_CID ends up in PRE_WEB_CID, proving the
    project-aware contract is enforced.
    """
    repo, info = setup_clean_success_repo()
    try:
        # S27T-5E-R5B-P: override fake docker so TEMP_CID != PROD_CID.
        # TEMP_CID comes from `docker compose ps -q web` (project-aware path).
        # PROD_CID comes from `docker inspect book-id-search-web-1` (legacy path).
        TEMP_CID = "f5901063b9562044c6f6e7b04a16b46bbc1fb1080fb9e43a58510ee3114552da"
        PROD_CID = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
        assert TEMP_CID != PROD_CID, "test setup invariant: TEMP_CID must differ from PROD_CID"

        docker = repo / "fake_bin/docker"
        docker.write_text(textwrap.dedent(f"""\
            #!/usr/bin/env bash
            TEMP_CID="{TEMP_CID}"
            PROD_CID="{PROD_CID}"
            if [ "$1" = "compose" ]; then
                if [ "$2" = "ps" ] && [ "$3" = "-q" ]; then
                    case "$4" in
                        web)         printf '%s\\n' "$TEMP_CID" ;;
                        api)         printf '%s\\n' "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899" ;;
                        meilisearch) printf '%s\\n' "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff" ;;
                        *) : ;;
                    esac
                fi
                exit 0
            fi
            if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
                shift 2; fmt=""
                while [ $# -gt 0 ]; do
                    case "$1" in
                        --format=*) fmt="${{1#--format=}}" ;;
                        --format) shift; fmt="$1" ;;
                    esac
                    shift
                done
                case "$fmt" in
                    '{{{{.Id}}}}') echo "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ;;
                    *) echo '[{{"Id": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"}}]' ;;
                esac
                exit 0
            fi
            if [ "$1" = "inspect" ]; then
                name="$2"
                fmt=""
                shift 2
                while [ $# -gt 0 ]; do
                    case "$1" in
                        --format=*) fmt="${{1#--format=}}" ;;
                        --format) shift; fmt="$1" ;;
                    esac
                    shift
                done
                # S27T-5E-R5B-P: TEMP_CID path returns TEMP_CID as its CID.
                #                  PROD_CID path returns PROD_CID as its CID.
                # If Planner Runtime reads TEMP_CID (project-aware), it gets TEMP_CID.
                # If Planner Runtime falls back to book-id-search-web-1, it gets PROD_CID.
                if [ "$name" = "$TEMP_CID" ]; then
                    case "$fmt" in
                        '{{{{.Id}}}}') echo "$TEMP_CID" ;;
                        '{{{{.State.StartedAt}}}}') echo "2026-08-01T00:00:00.000000000Z" ;;
                        '{{{{.Config.Image}}}}') echo "book-id-search-web:TEMP" ;;
                        '{{{{.Image}}}}') echo "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ;;
                        *) echo "" ;;
                    esac
                elif [ "$name" = "book-id-search-web-1" ]; then
                    case "$fmt" in
                        '{{{{.Id}}}}') echo "$PROD_CID" ;;
                        '{{{{.State.StartedAt}}}}') echo "2025-01-01T00:00:00.000000000Z" ;;
                        '{{{{.Config.Image}}}}') echo "book-id-search-web:PROD" ;;
                        '{{{{.Image}}}}') echo "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" ;;
                        *) echo "" ;;
                    esac
                else
                    case "$fmt" in
                        '{{{{.Id}}}}') echo "$PROD_CID" ;;
                        '{{{{.State.StartedAt}}}}') echo "2025-01-01T00:00:00.000000000Z" ;;
                        '{{{{.Config.Image}}}}') echo "book-id-search-api:api" ;;
                        '{{{{.Image}}}}') echo "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ;;
                        *) echo "" ;;
                    esac
                fi
                exit 0
            fi
            if [ "$1" = "true" ]; then exit 0; fi
            echo "ERROR: P01 fake docker unknown argv: $*" >&2
            exit 1
        """))
        docker.chmod(0o755)
        cleanup_progress_artifacts(repo)
        rc, out = run_planner(repo, info["source_sha"])
        assert rc == 0, f"Planner must PASS; rc={rc}\nout={out}"
        # Find artifact path
        artifact_path = None
        for line in out.splitlines():
            if line.startswith("EXECUTION_PLAN_ARTIFACT="):
                artifact_path = Path(line.split("=", 1)[1])
                break
        assert artifact_path is not None and artifact_path.exists(), \
            f"missing artifact; out={out[:500]}"
        # Parse PRE_WEB_CID
        kv = {}
        for line in artifact_path.read_text().splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                kv[k] = v
        assert kv.get("PRE_WEB_CID") == TEMP_CID, (
            f"PRE_WEB_CID must be TEMP_CID (project-aware path).\n"
            f"  expected: {TEMP_CID}\n"
            f"  got:      {kv.get('PRE_WEB_CID')}\n"
            f"  (if equal to PROD_CID {PROD_CID[:16]}..., Planner fell back to "
            f"book-id-search-web-1 global-name path)"
        )
        # Additional sanity: PRE_WEB_CID must NOT be PROD_CID
        assert kv.get("PRE_WEB_CID") != PROD_CID, (
            f"PRE_WEB_CID unexpectedly equals PROD_CID ({PROD_CID[:16]}...); "
            f"this means Planner used the legacy global-name fallback."
        )
    finally:
        shutil.rmtree(repo, ignore_errors=True)


# ----------------------------------------------------------------------------
def main():
    passed = 0
    failed = 0
    # S27T-5E-R5B-P: support single-test selector like `python3 test-plan...py P01`
    import sys as _sys
    selector = _sys.argv[1] if len(_sys.argv) > 1 else None
    for name, fn in TESTS:
        if selector and selector not in name:
            continue
        try:
            fn()
            print(f"PASS {name}")
            passed += 1
        except subprocess.TimeoutExpired:
            print(f"FAIL {name}: timeout")
            failed += 1
        except AssertionError as e:
            print(f"FAIL {name}: assertion: {e}")
            failed += 1
        except Exception as e:
            print(f"FAIL {name}: {type(e).__name__}: {e}")
            failed += 1
    print(f"\nTOTAL: {passed + failed}  PASS: {passed}  FAIL: {failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
