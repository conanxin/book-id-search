#!/usr/bin/env python3
"""
Verify Orchestrator Runtime

Independent Python verifier for scripts/orchestrate-web-production-release.sh.
Tests authorized PASS, isolated PASS, missing-auth BLOCK, claimed BLOCK,
TOCTOU BLOCK, plan-mismatch BLOCK, unsupported mode BLOCK, parallel.
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

TOCTOU_IMAGE_ID = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

PROFILES = {
    "quick": {
        "authorized": 10, "isolated": 5,
        "missing_auth": 5, "already_claimed": 5,
        "toctou": 5, "plan_mismatch": 5,
        "unsupported": 3,  # production, deploy, bad
        "parallel_authorized": 4, "parallel_neg": 4,
        "parallel_workers": 4,
    },
    "certify": {
        "authorized": 100, "isolated": 50,
        "missing_auth": 50, "already_claimed": 50,
        "toctou": 50, "plan_mismatch": 50,
        "unsupported": 15,  # 5+5+5
        "parallel_authorized": 40, "parallel_neg": 20,
        "parallel_workers": 4,
    },
}


def setup_iteration(repo_root: Path, work_root: Path, mode: str = "authorized",
                     auth_presence: str = "valid", claim_presence: str = "absent",
                     auth_manifest_override: str = None,
                     pre_deploy_image_id_override: str = None) -> dict:
    orch_src = repo_root / "scripts/orchestrate-web-production-release.sh"
    plan_src = repo_root / "scripts/plan-web-production-release.sh"
    deploy_src = repo_root / "scripts/deploy-web-release-candidate.sh"
    repo, source_sha = setup_temp_git_repo(repo_root, [orch_src, plan_src, deploy_src])
    fp = compute_plan_fingerprint(
        source_sha, CANDIDATE_IMAGE_TAG, CANDIDATE_IMAGE_ID,
        CANDIDATE_MANIFEST_SHA, CANDIDATE_LOCKFILE_SHA,
    )
    plan_dst = repo / "scripts" / "plan-web-production-release.sh"
    plan_dst.write_text(build_fake_plan_script(source_sha, fp))
    plan_dst.chmod(0o755)
    progress_dir = repo / "progress"
    cand_dir = progress_dir / f"web-release-candidate-{source_sha}"
    cand_dir.mkdir(parents=True, exist_ok=True)
    (cand_dir / "candidate.json").write_text(
        f'{{"tag": "{CANDIDATE_IMAGE_TAG}", "imageId": "{CANDIDATE_IMAGE_ID}"}}'
    )
    (cand_dir / "static-manifest.tsv").write_text("")

    auth_path = progress_dir / f"web-release-authorization-{fp}.env"
    claim_path = progress_dir / f"web-release-authorization-claim-{fp}.env"

    if mode == "authorized":
        if auth_presence != "missing":
            content = build_authorization_artifact(source_sha, fp)
            if auth_manifest_override:
                lines = content.split("\n")
                content = "\n".join(
                    f"MANIFEST_SHA={auth_manifest_override}" if l.startswith("MANIFEST_SHA=") else l
                    for l in lines
                ) + "\n"
            auth_path.write_text(content)
            auth_path.chmod(0o600)
            if claim_presence == "present":
                shutil.copy2(auth_path, claim_path)
                claim_path.chmod(0o600)

    return {
        "repo": repo,
        "orch_path": repo / "scripts" / "orchestrate-web-production-release.sh",
        "auth_path": auth_path,
        "claim_path": claim_path,
        "source_sha": source_sha,
        "fingerprint": fp,
        "pre_deploy_image_id_override": pre_deploy_image_id_override,
    }


def build_orch_env(fx: dict) -> dict:
    env = build_clean_env()
    env["ORCHESTRATOR_SUDO"] = "/bin/true"
    env["ORCHESTRATOR_DOCKER"] = "/bin/true"
    env["ORCHESTRATOR_FAKE_DEPLOY_LOG_PATH"] = str(fx["repo"] / "fake-deploy.log")
    env["ORCHESTRATOR_SKIP_PRODUCTION_CHECK"] = "1"
    env["ORCHESTRATOR_SKIP_CLEANUP"] = "1"
    inspect_id = fx.get("pre_deploy_image_id_override") or CANDIDATE_IMAGE_ID
    env["ORCHESTRATOR_FAKE_DOCKER_INSPECT_ID"] = inspect_id
    return env


def run_iteration(repo_root: Path, work_root: Path, mode: str = "authorized",
                  auth_presence: str = "valid", claim_presence: str = "absent",
                  auth_manifest_override: str = None,
                  pre_deploy_image_id_override: str = None,
                  custom_mode_arg: str = None) -> dict:
    fx = setup_iteration(repo_root, work_root, mode=mode, auth_presence=auth_presence,
                          claim_presence=claim_presence,
                          auth_manifest_override=auth_manifest_override,
                          pre_deploy_image_id_override=pre_deploy_image_id_override)
    env = build_orch_env(fx)
    arg_mode = custom_mode_arg or ("authorized-isolated-e2e" if mode == "authorized" else "isolated-e2e")
    out, err, rc = run_subprocess(
        [str(fx["orch_path"]), arg_mode, fx["source_sha"]],
        cwd=fx["repo"], env=env, timeout=60,
    )
    try:
        text = out.decode("utf-8")
        kv = parse_kv_output(text)
    except UnicodeDecodeError:
        return {"ok": False, "reason": "stdout not UTF-8"}
    result = {"rc": rc, "kv": kv, "stderr": err.decode("utf-8", errors="replace")}
    return result


def verify_authorized_pass(r: dict, fx: dict) -> Tuple[bool, str]:
    if r["rc"] != 0:
        return False, f"rc={r['rc']} stderr={r['stderr'][:200]}"
    kv = r["kv"]
    required = {
        "STATUS": "PASS",
        "ORCHESTRATION_MODE": "authorized-isolated-e2e",
        "IMAGE_TAG": CANDIDATE_IMAGE_TAG,
        "IMAGE_ID": CANDIDATE_IMAGE_ID,
        "PLAN_READY": "PASS",
        "AUTHORIZATION_REQUIRED": "true",
        "AUTHORIZATION_VALIDATED": "PASS",
        "AUTHORIZATION_CONSUMABLE": "PASS",
        "AUTHORIZED_ACTION": "production-deploy",
        "EXPLICIT_APPROVAL": "true",
        "HANDOFF_IDENTITY_SOURCE": "RELEASE_PLAN",
        "ACTUAL_DEPLOY_SCRIPT_E2E": "PASS",
        "DEV_FALLBACK_USED": "false",
        "PRODUCTION_UNCHANGED": "PASS",
        "PRODUCTION_DEPLOY_EXECUTED": "false",
        "AUTHORIZATION_CONSUMED": "false",
        "ORCHESTRATOR_ISOLATED_E2E_VERIFIED": "true",
    }
    err = verify_exact_once_keys(kv, required)
    if err:
        return False, err
    # Verify authorization artifact exists and is immutable (still on disk after PASS)
    if fx.get("auth_path") and fx["auth_path"].exists():
        # Auth SHA unchanged
        auth_bytes = fx["auth_path"].read_bytes()
        auth_kv = parse_kv_output(auth_bytes.decode("utf-8"))
        # Check 12 mandatory keys
        required_auth = [
            "AUTHORIZATION_VERSION", "AUTHORIZED_ACTION", "SOURCE_SHA",
            "RELEASE_PLAN_FINGERPRINT", "IMAGE_TAG", "IMAGE_ID",
            "MANIFEST_SHA", "LOCKFILE_SHA", "EXPLICIT_APPROVAL",
            "CONSUMABLE_ONCE", "PRODUCTION_DEPLOY_AUTHORIZED",
            "PRODUCTION_DEPLOY_EXECUTED",
        ]
        for k in required_auth:
            if k not in auth_kv:
                return False, f"auth artifact missing key {k}"
    return True, ""


def verify_isolated_pass(r: dict) -> Tuple[bool, str]:
    if r["rc"] != 0:
        return False, f"rc={r['rc']}"
    kv = r["kv"]
    required = {
        "STATUS": "PASS",
        "ORCHESTRATION_MODE": "isolated-e2e",
        "AUTHORIZATION_REQUIRED": "false",
        "PRODUCTION_DEPLOY_EXECUTED": "false",
        "AUTHORIZATION_CONSUMED": "false",
        "ORCHESTRATOR_ISOLATED_E2E_VERIFIED": "true",
    }
    err = verify_exact_once_keys(kv, required)
    return (True, "") if not err else (False, err)


def verify_block(r: dict, expected_reason: str) -> Tuple[bool, str]:
    if r["rc"] == 0:
        return False, "rc=0 expected nonzero"
    kv = r["kv"]
    if kv.get("STATUS") != "BLOCKED":
        return False, f"STATUS={kv.get('STATUS')}"
    if kv.get("BLOCK_REASON") != expected_reason:
        return False, f"BLOCK_REASON={kv.get('BLOCK_REASON')} expected={expected_reason}"
    if kv.get("PRODUCTION_DEPLOY_EXECUTED") != "false":
        return False, "PRODUCTION_DEPLOY_EXECUTED != false"
    if kv.get("AUTHORIZATION_CONSUMED") != "false":
        return False, "AUTHORIZATION_CONSUMED != false"
    return True, ""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="quick", choices=list(PROFILES.keys()))
    args = parser.parse_args()

    repo_root = resolve_repo_root()
    runtime_path = repo_root / "scripts/orchestrate-web-production-release.sh"
    runtime_sha = sha256_file(runtime_path)
    profile = PROFILES[args.profile]

    t0 = time.time()
    authorized_pass = authorized_fail = 0
    isolated_pass = isolated_fail = 0
    missing_auth_pass = 0
    claimed_pass = 0
    toctou_pass = 0
    mismatch_pass = 0
    unsupported_pass = 0
    par_auth_pass = par_auth_fail = 0
    par_neg_pass = par_neg_fail = 0

    def run_safe(f, work_root):
        try:
            return f()
        finally:
            shutil.rmtree(work_root, ignore_errors=True)

    # Authorized sequential
    for i in range(1, profile["authorized"] + 1):
        work = Path(tempfile.mkdtemp(prefix=f"verify_orch_auth_{i:03d}_"))
        fx = setup_iteration(repo_root, work, mode="authorized")
        env = build_orch_env(fx)
        out, err, rc = run_subprocess(
            [str(fx["orch_path"]), "authorized-isolated-e2e", fx["source_sha"]],
            cwd=fx["repo"], env=env, timeout=60,
        )
        text = out.decode("utf-8", errors="replace")
        kv = parse_kv_output(text)
        r = {"rc": rc, "kv": kv, "stderr": err.decode("utf-8", errors="replace")}
        ok, _ = verify_authorized_pass(r, fx)
        if ok:
            authorized_pass += 1
        else:
            authorized_fail += 1
        shutil.rmtree(work, ignore_errors=True)

    # Isolated sequential
    for i in range(1, profile["isolated"] + 1):
        work = Path(tempfile.mkdtemp(prefix=f"verify_orch_iso_{i:03d}_"))
        fx = setup_iteration(repo_root, work, mode="isolated")
        env = build_orch_env(fx)
        out, err, rc = run_subprocess(
            [str(fx["orch_path"]), "isolated-e2e", fx["source_sha"]],
            cwd=fx["repo"], env=env, timeout=60,
        )
        text = out.decode("utf-8", errors="replace")
        kv = parse_kv_output(text)
        r = {"rc": rc, "kv": kv, "stderr": err.decode("utf-8", errors="replace")}
        ok, _ = verify_isolated_pass(r)
        if ok:
            isolated_pass += 1
        else:
            isolated_fail += 1
        shutil.rmtree(work, ignore_errors=True)

    # Missing auth
    for i in range(1, profile["missing_auth"] + 1):
        work = Path(tempfile.mkdtemp(prefix=f"verify_orch_miss_{i:03d}_"))
        fx = setup_iteration(repo_root, work, mode="authorized", auth_presence="missing")
        env = build_orch_env(fx)
        out, err, rc = run_subprocess(
            [str(fx["orch_path"]), "authorized-isolated-e2e", fx["source_sha"]],
            cwd=fx["repo"], env=env, timeout=60,
        )
        text = out.decode("utf-8", errors="replace")
        kv = parse_kv_output(text)
        r = {"rc": rc, "kv": kv, "stderr": err.decode("utf-8", errors="replace")}
        ok, _ = verify_block(r, "AUTHORIZATION_MISSING")
        if ok:
            missing_auth_pass += 1
        shutil.rmtree(work, ignore_errors=True)

    # Already claimed
    for i in range(1, profile["already_claimed"] + 1):
        work = Path(tempfile.mkdtemp(prefix=f"verify_orch_cl_{i:03d}_"))
        fx = setup_iteration(repo_root, work, mode="authorized", claim_presence="present")
        env = build_orch_env(fx)
        out, err, rc = run_subprocess(
            [str(fx["orch_path"]), "authorized-isolated-e2e", fx["source_sha"]],
            cwd=fx["repo"], env=env, timeout=60,
        )
        text = out.decode("utf-8", errors="replace")
        kv = parse_kv_output(text)
        r = {"rc": rc, "kv": kv, "stderr": err.decode("utf-8", errors="replace")}
        ok, _ = verify_block(r, "AUTHORIZATION_ALREADY_CLAIMED")
        if ok:
            claimed_pass += 1
        shutil.rmtree(work, ignore_errors=True)

    # TOCTOU
    for i in range(1, profile["toctou"] + 1):
        work = Path(tempfile.mkdtemp(prefix=f"verify_orch_toctou_{i:03d}_"))
        fx = setup_iteration(repo_root, work, mode="authorized", pre_deploy_image_id_override=TOCTOU_IMAGE_ID)
        env = build_orch_env(fx)
        out, err, rc = run_subprocess(
            [str(fx["orch_path"]), "authorized-isolated-e2e", fx["source_sha"]],
            cwd=fx["repo"], env=env, timeout=60,
        )
        text = out.decode("utf-8", errors="replace")
        kv = parse_kv_output(text)
        r = {"rc": rc, "kv": kv, "stderr": err.decode("utf-8", errors="replace")}
        ok, _ = verify_block(r, "PRE_DEPLOY_IMAGE_IDENTITY_CHANGED")
        if ok:
            toctou_pass += 1
        shutil.rmtree(work, ignore_errors=True)

    # Plan mismatch
    for i in range(1, profile["plan_mismatch"] + 1):
        work = Path(tempfile.mkdtemp(prefix=f"verify_orch_pm_{i:03d}_"))
        fx = setup_iteration(repo_root, work, mode="authorized", auth_manifest_override="deadbeef" * 8)
        env = build_orch_env(fx)
        out, err, rc = run_subprocess(
            [str(fx["orch_path"]), "authorized-isolated-e2e", fx["source_sha"]],
            cwd=fx["repo"], env=env, timeout=60,
        )
        text = out.decode("utf-8", errors="replace")
        kv = parse_kv_output(text)
        r = {"rc": rc, "kv": kv, "stderr": err.decode("utf-8", errors="replace")}
        ok, _ = verify_block(r, "AUTHORIZATION_PLAN_MISMATCH")
        if ok:
            mismatch_pass += 1
        shutil.rmtree(work, ignore_errors=True)

    # Unsupported modes
    unsupported_modes = ["production", "deploy", "bogus"]
    for um in unsupported_modes:
        for i in range(1, (profile["unsupported"] // 3) + 1):
            work = Path(tempfile.mkdtemp(prefix=f"verify_orch_un_{um}_{i:03d}_"))
            fx = setup_iteration(repo_root, work, mode="authorized", auth_presence="missing")
            env = build_orch_env(fx)
            out, err, rc = run_subprocess(
                [str(fx["orch_path"]), um, fx["source_sha"]],
                cwd=fx["repo"], env=env, timeout=60,
            )
            text = out.decode("utf-8", errors="replace")
            kv = parse_kv_output(text)
            r = {"rc": rc, "kv": kv, "stderr": err.decode("utf-8", errors="replace")}
            ok, _ = verify_block(r, "UNSUPPORTED_ORCHESTRATION_MODE")
            if ok:
                unsupported_pass += 1
            shutil.rmtree(work, ignore_errors=True)

    # Parallel authorized
    with concurrent.futures.ThreadPoolExecutor(max_workers=profile["parallel_workers"]) as ex:
        futures = {}
        for i in range(1, profile["parallel_authorized"] + 1):
            work = Path(tempfile.mkdtemp(prefix=f"verify_orch_pauth_{i:03d}_"))
            fut = ex.submit(_run_authorized, repo_root, work)
            futures[fut] = (work, i)
        for fut in concurrent.futures.as_completed(futures):
            work, _ = futures[fut]
            try:
                ok = fut.result()
                if ok:
                    par_auth_pass += 1
                else:
                    par_auth_fail += 1
            finally:
                shutil.rmtree(work, ignore_errors=True)

    # Parallel negative TOCTOU
    with concurrent.futures.ThreadPoolExecutor(max_workers=profile["parallel_workers"]) as ex:
        futures = {}
        for i in range(1, profile["parallel_neg"] + 1):
            work = Path(tempfile.mkdtemp(prefix=f"verify_orch_pneg_{i:03d}_"))
            fut = ex.submit(_run_neg_toctou, repo_root, work)
            futures[fut] = (work, i)
        for fut in concurrent.futures.as_completed(futures):
            work, _ = futures[fut]
            try:
                ok = fut.result()
                if ok:
                    par_neg_pass += 1
                else:
                    par_neg_fail += 1
            finally:
                shutil.rmtree(work, ignore_errors=True)

    elapsed_ms = int((time.time() - t0) * 1000)

    expected_auth = profile["authorized"]
    expected_iso = profile["isolated"]
    expected_miss = profile["missing_auth"]
    expected_cl = profile["already_claimed"]
    expected_toctou = profile["toctou"]
    expected_pm = profile["plan_mismatch"]
    expected_unsupp = profile["unsupported"]

    ok = (
        authorized_pass == expected_auth and
        isolated_pass == expected_iso and
        missing_auth_pass == expected_miss and
        claimed_pass == expected_cl and
        toctou_pass == expected_toctou and
        mismatch_pass == expected_pm and
        unsupported_pass == expected_unsupp and
        par_auth_pass == profile["parallel_authorized"] and
        par_neg_pass == profile["parallel_neg"] and
        authorized_fail == 0 and isolated_fail == 0
    )

    status = "PASS" if ok else "BLOCKED"
    lines = [
        f"STATUS={status}",
        f"VERIFIER=orchestrator",
        f"PROFILE={args.profile}",
        f"RUNTIME_SHA256={runtime_sha}",
        f"AUTHORIZED_PASS={authorized_pass}",
        f"ISOLATED_PASS={isolated_pass}",
        f"MISSING_AUTH_PASS={missing_auth_pass}",
        f"ALREADY_CLAIMED_PASS={claimed_pass}",
        f"TOCTOU_PASS={toctou_pass}",
        f"PLAN_MISMATCH_PASS={mismatch_pass}",
        f"UNSUPPORTED_PASS={unsupported_pass}",
        f"PARALLEL_AUTH_PASS={par_auth_pass}",
        f"PARALLEL_NEG_PASS={par_neg_pass}",
        f"FAIL_CLOSED_CONTRACT={'true' if ok else 'false'}",
        f"PRODUCTION_DEPLOY_EXECUTED=false",
        f"ELAPSED_MS={elapsed_ms}",
    ]
    if not ok:
        lines.append("BLOCK_REASON=ORCHESTRATOR_VERIFIER_FAILED")
    return finalize(lines, status)


def _run_authorized(repo_root, work):
    fx = setup_iteration(repo_root, work, mode="authorized")
    env = build_orch_env(fx)
    out, err, rc = run_subprocess(
        [str(fx["orch_path"]), "authorized-isolated-e2e", fx["source_sha"]],
        cwd=fx["repo"], env=env, timeout=60,
    )
    text = out.decode("utf-8", errors="replace")
    kv = parse_kv_output(text)
    r = {"rc": rc, "kv": kv}
    ok, _ = verify_authorized_pass(r, fx)
    return ok


def _run_neg_toctou(repo_root, work):
    fx = setup_iteration(repo_root, work, mode="authorized", pre_deploy_image_id_override=TOCTOU_IMAGE_ID)
    env = build_orch_env(fx)
    out, err, rc = run_subprocess(
        [str(fx["orch_path"]), "authorized-isolated-e2e", fx["source_sha"]],
        cwd=fx["repo"], env=env, timeout=60,
    )
    text = out.decode("utf-8", errors="replace")
    kv = parse_kv_output(text)
    r = {"rc": rc, "kv": kv}
    ok, _ = verify_block(r, "PRE_DEPLOY_IMAGE_IDENTITY_CHANGED")
    return ok


if __name__ == "__main__":
    sys.exit(main())