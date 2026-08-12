#!/usr/bin/env python3
"""
Verify Claim Runtime

Independent Python verifier for scripts/claim-web-production-release-authorization.sh.
Tests first claim, replay, atomicity, and parallel.
"""
import argparse
import concurrent.futures
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from web_release_runtime_common import (
    resolve_repo_root, sha256_file, parse_kv_output, verify_exact_once_keys,
    build_clean_env, setup_temp_git_repo, run_subprocess, compute_plan_fingerprint,
    build_fake_plan_script, build_authorization_artifact, finalize,
    CANDIDATE_IMAGE_TAG, CANDIDATE_IMAGE_ID, CANDIDATE_MANIFEST_SHA, CANDIDATE_LOCKFILE_SHA,
)


PROFILES = {
    "quick": {
        "sequential": 10, "replay": 10, "concurrency": 10,
        "parallel": 4, "parallel_workers": 4,
    },
    "certify": {
        "sequential": 100, "replay": 100, "concurrency": 100,
        "parallel": 40, "parallel_workers": 4,
    },
}


def setup_iteration(repo_root: Path, work_root: Path, with_authorization: bool = True, with_claim: bool = False) -> dict:
    """Setup iteration with claim/plan/runtime exact-byte copy + fake Plan + auth fixture."""
    claim_src = repo_root / "scripts/claim-web-production-release-authorization.sh"
    plan_src = repo_root / "scripts/plan-web-production-release.sh"
    repo, source_sha = setup_temp_git_repo(repo_root, [claim_src, plan_src])
    fp = compute_plan_fingerprint(
        source_sha, CANDIDATE_IMAGE_TAG, CANDIDATE_IMAGE_ID,
        CANDIDATE_MANIFEST_SHA, CANDIDATE_LOCKFILE_SHA,
    )
    plan_dst = repo / "scripts" / "plan-web-production-release.sh"
    plan_dst.write_text(build_fake_plan_script(source_sha, fp))
    plan_dst.chmod(0o755)

    progress_dir = repo / "progress"
    auth_path = progress_dir / f"web-release-authorization-{fp}.env"
    claim_path = progress_dir / f"web-release-authorization-claim-{fp}.env"

    if with_authorization:
        auth_path.write_text(build_authorization_artifact(source_sha, fp))
        auth_path.chmod(0o600)
        if with_claim:
            shutil.copy2(auth_path, claim_path)
            claim_path.chmod(0o600)

    return {
        "repo": repo,
        "claim_path": repo / "scripts" / "claim-web-production-release-authorization.sh",
        "auth_path": auth_path,
        "claim_artifact_path": claim_path,
        "source_sha": source_sha,
        "fingerprint": fp,
    }


def run_sequential(repo_root: Path, work_root: Path) -> dict:
    """Run sequential iteration: first claim PASS + replay BLOCK."""
    fx = setup_iteration(repo_root, work_root, with_authorization=True, with_claim=False)
    env = build_clean_env()
    # First claim
    out1, err1, rc1 = run_subprocess(
        [str(fx["claim_path"]), "--claim-production-deploy", fx["source_sha"]],
        cwd=fx["repo"], env=env, timeout=30,
    )
    try:
        kv1 = parse_kv_output(out1.decode("utf-8"))
    except UnicodeDecodeError:
        return {"ok": False, "reason": "first stdout not UTF-8"}
    if rc1 != 0 or kv1.get("STATUS") != "PASS":
        return {"ok": False, "reason": f"first claim failed rc={rc1}"}
    # Verify inode identity
    auth_stat = fx["auth_path"].stat()
    claim_stat = fx["claim_artifact_path"].stat()
    if f"{auth_stat.st_dev}:{auth_stat.st_ino}" != f"{claim_stat.st_dev}:{claim_stat.st_ino}":
        return {"ok": False, "reason": "inode mismatch"}
    if hashlib.sha256(fx["auth_path"].read_bytes()).hexdigest() != hashlib.sha256(fx["claim_artifact_path"].read_bytes()).hexdigest():
        return {"ok": False, "reason": "SHA mismatch"}
    if auth_stat.st_nlink < 2:
        return {"ok": False, "reason": f"auth nlink={auth_stat.st_nlink}"}
    # Replay
    out2, err2, rc2 = run_subprocess(
        [str(fx["claim_path"]), "--claim-production-deploy", fx["source_sha"]],
        cwd=fx["repo"], env=env, timeout=30,
    )
    kv2 = parse_kv_output(out2.decode("utf-8"))
    if rc2 == 0:
        return {"ok": False, "reason": "replay rc=0"}
    if kv2.get("BLOCK_REASON") != "AUTHORIZATION_ALREADY_CLAIMED":
        return {"ok": False, "reason": f"replay reason={kv2.get('BLOCK_REASON')}"}
    # Verify auth byte unchanged
    if hashlib.sha256(fx["auth_path"].read_bytes()).hexdigest() != hashlib.sha256(fx["claim_artifact_path"].read_bytes()).hexdigest():
        return {"ok": False, "reason": "auth changed after replay"}
    return {"ok": True}


def run_concurrency(repo_root: Path, work_root: Path) -> dict:
    """Run concurrent iteration: 2 simultaneous claims."""
    fx = setup_iteration(repo_root, work_root, with_authorization=True, with_claim=False)
    env = build_clean_env()
    proc1 = subprocess.Popen(
        [str(fx["claim_path"]), "--claim-production-deploy", fx["source_sha"]],
        cwd=fx["repo"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    proc2 = subprocess.Popen(
        [str(fx["claim_path"]), "--claim-production-deploy", fx["source_sha"]],
        cwd=fx["repo"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    out1, err1 = proc1.communicate(timeout=30)
    out2, err2 = proc2.communicate(timeout=30)
    rc1, rc2 = proc1.returncode, proc2.returncode
    kv1 = parse_kv_output(out1.decode("utf-8"))
    kv2 = parse_kv_output(out2.decode("utf-8"))
    winners = [(rc1, kv1), (rc2, kv2)]
    wcount = sum(1 for rc, _ in winners if rc == 0)
    lcount = sum(1 for rc, _ in winners if rc != 0)
    if wcount != 1 or lcount != 1:
        return {"ok": False, "reason": f"winners={wcount} losers={lcount}"}
    # Find winner/loser
    winner_kv = kv1 if rc1 == 0 else kv2
    loser_kv = kv2 if rc1 == 0 else kv1
    if winner_kv.get("AUTHORIZATION_CLAIMED") != "true":
        return {"ok": False, "reason": "winner not claimed"}
    if loser_kv.get("BLOCK_REASON") != "AUTHORIZATION_ALREADY_CLAIMED":
        return {"ok": False, "reason": "loser not already_claimed"}
    # Verify single claim artifact
    if not fx["claim_artifact_path"].exists():
        return {"ok": False, "reason": "claim missing"}
    auth_stat = fx["auth_path"].stat()
    claim_stat = fx["claim_artifact_path"].stat()
    if f"{auth_stat.st_dev}:{auth_stat.st_ino}" != f"{claim_stat.st_dev}:{claim_stat.st_ino}":
        return {"ok": False, "reason": "inode mismatch"}
    return {"ok": True}


def run_parallel(repo_root: Path, work_root: Path) -> dict:
    return run_sequential(repo_root, work_root)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="quick", choices=list(PROFILES.keys()))
    args = parser.parse_args()

    repo_root = resolve_repo_root()
    runtime_path = repo_root / "scripts/claim-web-production-release-authorization.sh"
    runtime_sha = sha256_file(runtime_path)

    profile = PROFILES[args.profile]

    t0 = time.time()
    seq_pass = seq_fail = 0
    replay_pass = 0  # counted as part of sequential
    atomicity_pass = 0
    double_winner = 0
    double_loser = 0
    par_pass = par_fail = 0

    # Sequential (includes first claim + replay)
    for i in range(1, profile["sequential"] + 1):
        work = Path(tempfile.mkdtemp(prefix=f"verify_claim_seq_{i:03d}_"))
        try:
            r = run_sequential(repo_root, work)
            if r["ok"]:
                seq_pass += 1
            else:
                seq_fail += 1
        finally:
            shutil.rmtree(work, ignore_errors=True)
    replay_pass = seq_pass  # both must pass for sequential to pass

    # Concurrency
    for i in range(1, profile["concurrency"] + 1):
        work = Path(tempfile.mkdtemp(prefix=f"verify_claim_conc_{i:03d}_"))
        try:
            r = run_concurrency(repo_root, work)
            if r["ok"]:
                atomicity_pass += 1
            else:
                # Detect double-winner / double-loser patterns
                if "winners=" in r.get("reason", ""):
                    parts = r["reason"].split()
                    for p in parts:
                        if p.startswith("winners="):
                            if int(p.split("=")[1]) == 2:
                                double_winner += 1
                        if p.startswith("losers="):
                            if int(p.split("=")[1]) == 2:
                                double_loser += 1
        finally:
            shutil.rmtree(work, ignore_errors=True)

    # Parallel independent
    with concurrent.futures.ThreadPoolExecutor(max_workers=profile["parallel_workers"]) as ex:
        futures = {}
        for i in range(1, profile["parallel"] + 1):
            work = Path(tempfile.mkdtemp(prefix=f"verify_claim_par_{i:03d}_"))
            fut = ex.submit(run_parallel, repo_root, work)
            futures[fut] = (work, i)
        for fut in concurrent.futures.as_completed(futures):
            work, _ = futures[fut]
            try:
                r = fut.result()
                if r["ok"]:
                    par_pass += 1
                else:
                    par_fail += 1
            finally:
                shutil.rmtree(work, ignore_errors=True)

    elapsed_ms = int((time.time() - t0) * 1000)

    ok = (seq_fail == 0 and double_winner == 0 and double_loser == 0 and par_fail == 0)
    status = "PASS" if ok else "BLOCKED"
    lines = [
        f"STATUS={status}",
        f"VERIFIER=claim",
        f"PROFILE={args.profile}",
        f"RUNTIME_SHA256={runtime_sha}",
        f"SEQUENTIAL_PASS={seq_pass}",
        f"SEQUENTIAL_FAIL={seq_fail}",
        f"REPLAY_PASS={replay_pass}",
        f"ATOMICITY_PASS={atomicity_pass}",
        f"DOUBLE_WINNER={double_winner}",
        f"DOUBLE_LOSER={double_loser}",
        f"PARALLEL_PASS={par_pass}",
        f"PARALLEL_FAIL={par_fail}",
        f"RUNTIME_DETERMINISTIC={'true' if ok else 'false'}",
        f"CLAIM_ATOMICITY={'true' if (atomicity_pass == profile['concurrency'] and double_winner == 0) else 'false'}",
        f"REPLAY_PROTECTION={'true' if seq_fail == 0 else 'false'}",
        f"ELAPSED_MS={elapsed_ms}",
    ]
    if not ok:
        lines.append("BLOCK_REASON=CLAIM_VERIFIER_FAILED")
    return finalize(lines, status)


if __name__ == "__main__":
    sys.exit(main())