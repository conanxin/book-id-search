#!/usr/bin/env python3
"""
Web Release Runtime Common Module

Shared helpers for independent runtime verifiers.
Python stdlib only. No legacy harness reuse.
"""
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Optional, Tuple, List


def resolve_repo_root() -> Path:
    """Resolve repo root from this file's location.

    scripts/verify/web_release_runtime_common.py -> scripts/verify/ -> scripts/ -> repo
    """
    return Path(__file__).resolve().parent.parent.parent


def sha256_file(path: Path) -> str:
    """SHA256 of file bytes."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha256_bytes(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


def parse_kv_output(text: str) -> dict:
    """Parse KEY=VALUE lines using str.partition. No grep/sed/awk."""
    out = {}
    for line in text.splitlines():
        if "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip()
        if k:
            out[k] = v
    return out


def verify_exact_once_keys(kv: dict, required: dict) -> Optional[str]:
    """Verify each required key appears with the expected value.

    required: {key: expected_value}
    Returns None on success, error message string on failure.
    """
    for k, expected in required.items():
        if k not in kv:
            return f"missing key {k}"
        if kv[k] != expected:
            return f"key {k}={kv[k]} expected={expected}"
    return None


def build_clean_env() -> dict:
    """Build clean env: strip FAKE_*, ORCHESTRATOR_*, AUTHORIZATION_*, CLAIM_*, PLAN_*, DEPLOY_*, RUN_SINGLE_TEST."""
    env = os.environ.copy()
    keys_to_remove = []
    for k in env:
        kl = k.upper()
        if kl.startswith("FAKE_") or kl.startswith("ORCHESTRATOR_") \
            or kl.startswith("CLAIM_") or kl.startswith("PLAN_") \
            or kl.startswith("DEPLOY_") or kl == "RUN_SINGLE_TEST" \
            or kl.startswith("AUTHORIZATION_OUTPUT_DIR") \
            or kl.startswith("AUTHORIZATION_"):
            keys_to_remove.append(k)
    for k in keys_to_remove:
        env.pop(k, None)
    keep = {"PATH", "HOME", "USER", "LANG", "TMPDIR"}
    env = {k: v for k, v in env.items() if k in keep or k.startswith("LC_")}
    return env


def setup_temp_git_repo(repo_root: Path, scripts_to_copy: List[Path]) -> Tuple[Path, str]:
    """Create a fresh temp git repo with specified scripts exact-byte copied.

    Returns (repo_path, source_sha).
    """
    work = Path(tempfile.mkdtemp(prefix="web_release_verify_"))
    repo = work / "repo"
    repo.mkdir(parents=True, exist_ok=True)
    scripts_dir = repo / "scripts"
    scripts_dir.mkdir(exist_ok=True)
    progress_dir = repo / "progress"
    progress_dir.mkdir(exist_ok=True)

    # Copy each script exactly as-is
    for src in scripts_to_copy:
        dst = scripts_dir / src.name
        shutil.copy2(src, dst)
        dst.chmod(0o755)

    # git init + commit
    subprocess.run(["git", "-C", str(repo), "init", "-q"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "verify@test"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "verify"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "commit.gpgsign", "false"], check=True)
    (repo / "README").write_text("verify\n")
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True, capture_output=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-q", "-m", "init"], check=True, capture_output=True)

    source_sha = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True
    ).stdout.strip()

    return repo, source_sha


def run_subprocess(cmd: List[str], cwd: Path, env: dict, timeout: int = 30) -> Tuple[bytes, bytes, int]:
    """Run subprocess with raw byte capture. Returns (stdout, stderr, rc)."""
    proc = subprocess.run(
        cmd,
        cwd=str(cwd),
        env=env,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    return proc.stdout, proc.stderr, proc.returncode


def compute_plan_fingerprint(source_sha: str, image_tag: str, image_id: str,
                             manifest_sha: str, lockfile_sha: str) -> str:
    """Compute Plan fingerprint exactly as runtime does."""
    payload = "\n".join([
        f"SOURCE_SHA={source_sha}",
        f"IMAGE_TAG={image_tag}",
        f"IMAGE_ID={image_id}",
        f"MANIFEST_SHA={manifest_sha}",
        f"LOCKFILE_SHA={lockfile_sha}",
        "",
    ])
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


# Deterministic candidate identity (fixed for cross-iteration reproducibility)
CANDIDATE_IMAGE_TAG = "registry.example.test/book-id-search/web:versioned-gate"
CANDIDATE_IMAGE_ID = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
CANDIDATE_MANIFEST_SHA = "2222222222222222222222222222222222222222222222222222222222222222"
CANDIDATE_LOCKFILE_SHA = "3333333333333333333333333333333333333333333333333333333333333333"


def build_fake_plan_script(source_sha: str, fingerprint: str) -> str:
    """Build fake Plan script that outputs all 13 required fields."""
    return f"""#!/usr/bin/env bash
cat <<'PLAN_EOF'
STATUS=PASS
RELEASE_PLAN_VERSION=1
SOURCE_SHA={source_sha}
IMAGE_TAG={CANDIDATE_IMAGE_TAG}
IMAGE_ID={CANDIDATE_IMAGE_ID}
MANIFEST_SHA={CANDIDATE_MANIFEST_SHA}
LOCKFILE_SHA={CANDIDATE_LOCKFILE_SHA}
RELEASE_PLAN_FINGERPRINT={fingerprint}
READINESS_GATE=PASS
ISOLATED_E2E=PASS
PRODUCTION_UNCHANGED=PASS
RELEASE_PLAN_READY=true
DEPLOY_EXECUTED=false
PLAN_EOF
"""


def build_authorization_artifact(source_sha: str, fingerprint: str) -> str:
    """Build valid authorization artifact (12 keys)."""
    return (
        f"AUTHORIZATION_VERSION=1\n"
        f"AUTHORIZED_ACTION=production-deploy\n"
        f"SOURCE_SHA={source_sha}\n"
        f"RELEASE_PLAN_FINGERPRINT={fingerprint}\n"
        f"IMAGE_TAG={CANDIDATE_IMAGE_TAG}\n"
        f"IMAGE_ID={CANDIDATE_IMAGE_ID}\n"
        f"MANIFEST_SHA={CANDIDATE_MANIFEST_SHA}\n"
        f"LOCKFILE_SHA={CANDIDATE_LOCKFILE_SHA}\n"
        f"EXPLICIT_APPROVAL=true\n"
        f"CONSUMABLE_ONCE=true\n"
        f"PRODUCTION_DEPLOY_AUTHORIZED=true\n"
        f"PRODUCTION_DEPLOY_EXECUTED=false\n"
    )


def emit_result(result_lines: List[str]) -> None:
    """Emit final machine-readable result lines to stdout."""
    for line in result_lines:
        print(line)


def finalize(result_lines: List[str], status: str) -> int:
    """Print result lines and exit with appropriate code."""
    emit_result(result_lines)
    return 0 if status == "PASS" else 1