#!/usr/bin/env python3
"""
Verify Authorization Runtime

Independent Python verifier for scripts/authorize-web-production-release.sh.
Python stdlib only. No legacy shell harness reuse.
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Tuple

# Add scripts/verify to path so we can import the common module
sys.path.insert(0, str(Path(__file__).resolve().parent))
from web_release_runtime_common import (
    resolve_repo_root, sha256_file, parse_kv_output, verify_exact_once_keys,
    build_clean_env, setup_temp_git_repo, run_subprocess, compute_plan_fingerprint,
    build_fake_plan_script, build_authorization_artifact, finalize,
    CANDIDATE_IMAGE_TAG, CANDIDATE_IMAGE_ID, CANDIDATE_MANIFEST_SHA, CANDIDATE_LOCKFILE_SHA,
)


# Profile iteration counts (derived from A1 evidence)
PROFILES = {
    "quick": {"sequential": 10, "parallel": 4, "parallel_workers": 4},
    "certify": {"sequential": 100, "parallel": 40, "parallel_workers": 4},
}


def setup_iteration(repo_root: Path, work_root: Path) -> Tuple[Path, Path, str]:
    """Create fresh iteration with exact-byte runtime copy + fake Plan."""
    auth_src = repo_root / "scripts/authorize-web-production-release.sh"
    plan_src = repo_root / "scripts/plan-web-production-release.sh"
    repo, source_sha = setup_temp_git_repo(repo_root, [auth_src, plan_src])
    fp = compute_plan_fingerprint(
        source_sha, CANDIDATE_IMAGE_TAG, CANDIDATE_IMAGE_ID,
        CANDIDATE_MANIFEST_SHA, CANDIDATE_LOCKFILE_SHA,
    )
    # Overwrite plan with fake
    plan_dst = repo / "scripts" / "plan-web-production-release.sh"
    plan_dst.write_text(build_fake_plan_script(source_sha, fp))
    plan_dst.chmod(0o755)
    return repo, repo / "scripts" / "authorize-web-production-release.sh", source_sha


def run_one_sequential(repo_root: Path, work_root: Path) -> dict:
    repo, auth_path, source_sha = setup_iteration(repo_root, work_root)
    env = build_clean_env()
    stdout, stderr, rc = run_subprocess(
        [str(auth_path), "--approve-production-deploy", source_sha],
        cwd=repo, env=env, timeout=30,
    )
    result = {
        "rc": rc,
        "stdout_len": len(stdout),
        "stdout_sha": hashlib.sha256(stdout).hexdigest(),
        "utf8": True,
    }
    try:
        text = stdout.decode("utf-8")
    except UnicodeDecodeError:
        result["utf8"] = False
        return result
    kv = parse_kv_output(text)
    result["kv"] = kv
    result["STATUS"] = kv.get("STATUS")
    result["AUTH_ARTIFACT"] = kv.get("AUTHORIZATION_ARTIFACT")
    return result


def run_one_parallel(repo_root: Path, work_root: Path) -> dict:
    return run_one_sequential(repo_root, work_root)


def verify_success_contract(result: dict, source_sha: str) -> Tuple[bool, str]:
    """Verify a sequential iteration result."""
    if not result["utf8"]:
        return False, "stdout not UTF-8"
    if result["rc"] != 0:
        return False, f"rc={result['rc']}"
    kv = result["kv"]
    required = {
        "STATUS": "PASS",
        "AUTHORIZATION_VERSION": "1",
        "AUTHORIZED_ACTION": "production-deploy",
        "EXPLICIT_APPROVAL": "true",
        "CONSUMABLE_ONCE": "true",
        "PRODUCTION_DEPLOY_AUTHORIZED": "true",
        "PRODUCTION_DEPLOY_EXECUTED": "false",
        "SOURCE_SHA": source_sha,
    }
    err = verify_exact_once_keys(kv, required)
    if err:
        return False, err
    # Verify artifact
    ap = result.get("AUTH_ARTIFACT", "")
    if not ap:
        return False, "missing AUTHORIZATION_ARTIFACT"
    path = Path(ap)
    if not path.exists() or path.is_symlink() or not path.is_file():
        return False, "artifact invalid"
    if (path.stat().st_mode & 0o777) != 0o600:
        return False, f"artifact mode={oct(path.stat().st_mode & 0o777)}"
    return True, ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="quick", choices=list(PROFILES.keys()))
    parser.add_argument("--evidence-dir", default=None)
    args = parser.parse_args()

    repo_root = resolve_repo_root()
    runtime_path = repo_root / "scripts/authorize-web-production-release.sh"
    runtime_sha = sha256_file(runtime_path)

    profile = PROFILES[args.profile]
    n_seq = profile["sequential"]
    n_par = profile["parallel"]

    t0 = time.time()
    seq_pass = 0
    seq_fail = 0
    seq_failures = []

    # Sequential
    for i in range(1, n_seq + 1):
        work = Path(tempfile.mkdtemp(prefix=f"verify_auth_seq_{i:03d}_"))
        try:
            r = run_one_sequential(repo_root, work)
            ok, reason = verify_success_contract(r, r.get("kv", {}).get("SOURCE_SHA", ""))
            if ok:
                seq_pass += 1
            else:
                seq_fail += 1
                seq_failures.append({"iteration": i, "reason": reason})
        finally:
            shutil.rmtree(work, ignore_errors=True)

    par_pass = 0
    par_fail = 0
    # Parallel (workers)
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=profile["parallel_workers"]) as ex:
        futures = {}
        for i in range(1, n_par + 1):
            work = Path(tempfile.mkdtemp(prefix=f"verify_auth_par_{i:03d}_"))
            fut = ex.submit(run_one_parallel, repo_root, work)
            futures[fut] = (work, i)
        for fut in concurrent.futures.as_completed(futures):
            work, i = futures[fut]
            try:
                r = fut.result()
                ok, reason = verify_success_contract(r, r.get("kv", {}).get("SOURCE_SHA", ""))
                if ok:
                    par_pass += 1
                else:
                    par_fail += 1
            finally:
                shutil.rmtree(work, ignore_errors=True)

    elapsed_ms = int((time.time() - t0) * 1000)

    status = "PASS" if (seq_fail == 0 and par_fail == 0) else "BLOCKED"
    lines = [
        f"STATUS={status}",
        f"VERIFIER=authorization",
        f"PROFILE={args.profile}",
        f"RUNTIME_SHA256={runtime_sha}",
        f"SEQUENTIAL_PASS={seq_pass}",
        f"SEQUENTIAL_FAIL={seq_fail}",
        f"PARALLEL_PASS={par_pass}",
        f"PARALLEL_FAIL={par_fail}",
        f"RUNTIME_DETERMINISTIC={'true' if status == 'PASS' else 'false'}",
        f"ELAPSED_MS={elapsed_ms}",
    ]
    if seq_failures:
        lines.append(f"BLOCK_REASON=AUTHORIZATION_VERIFIER_FAILED")
        for f in seq_failures[:3]:
            lines.append(f"FAILURE_DETAIL=iter{f['iteration']}:{f['reason']}")
    return finalize(lines, status)


if __name__ == "__main__":
    sys.exit(main())