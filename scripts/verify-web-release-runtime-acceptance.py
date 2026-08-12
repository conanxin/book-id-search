#!/usr/bin/env python3
"""
Unified Web Release Runtime Acceptance Gate

Calls three versioned verifiers via subprocess:
- verify_authorization_runtime.py
- verify_claim_runtime.py
- verify_orchestrator_runtime.py

Aggregates results into a single machine-readable PASS/BLOCK contract.
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

# Add scripts/verify to path
sys.path.insert(0, str(Path(__file__).resolve().parent / "verify"))
from web_release_runtime_common import resolve_repo_root, parse_kv_output, finalize


VERIFIERS = [
    ("AUTHORIZATION_VERIFIER", "verify/verify_authorization_runtime.py"),
    ("CLAIM_VERIFIER", "verify/verify_claim_runtime.py"),
    ("ORCHESTRATOR_VERIFIER", "verify/verify_orchestrator_runtime.py"),
]


def _override_verifiers_from_env():
    """Allow tests to inject fake child scripts via env vars."""
    for label in ["AUTHORIZATION_VERIFIER", "CLAIM_VERIFIER", "ORCHESTRATOR_VERIFIER"]:
        env_key = f"WEB_RELEASE_VERIFIER_{label}"
        if env_key in os.environ:
            for i, (lbl, path) in enumerate(VERIFIERS):
                if lbl == label:
                    VERIFIERS[i] = (lbl, os.environ[env_key])
                    break


def run_child_verifier(script_path: Path, profile: str) -> dict:
    """Run a child verifier via subprocess, parse its output."""
    proc = subprocess.run(
        ["python3", str(script_path), "--profile", profile],
        capture_output=True,
        timeout=600,
        check=False,
    )
    try:
        text = proc.stdout.decode("utf-8")
    except UnicodeDecodeError:
        return {"STATUS": "BLOCKED", "BLOCK_REASON": "VERIFIER_OUTPUT_INCOMPLETE",
                "rc": proc.returncode, "kv": {}, "raw": "", "stderr": proc.stderr.decode("utf-8", errors="replace")}
    kv = parse_kv_output(text)
    return {
        "STATUS": kv.get("STATUS", "UNKNOWN"),
        "BLOCK_REASON": kv.get("BLOCK_REASON", ""),
        "rc": proc.returncode,
        "kv": kv,
        "raw": text,
        "stderr": proc.stderr.decode("utf-8", errors="replace"),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default="quick", choices=["quick", "certify"])
    parser.add_argument("--evidence-dir", default=None)
    args = parser.parse_args()

    repo_root = resolve_repo_root()
    scripts_verify = repo_root / "scripts" / "verify"

    if not scripts_verify.exists():
        print("STATUS=BLOCKED")
        print("BLOCK_REASON=VERIFIER_OUTPUT_INCOMPLETE")
        print("ERROR=scripts/verify directory not found")
        return 1

    t0 = time.time()
    _override_verifiers_from_env()
    child_results = {}
    all_pass = True
    failed_child = None

    for label, rel_path in VERIFIERS:
        script_path = repo_root / "scripts" / rel_path
        if not script_path.exists():
            all_pass = False
            failed_child = label
            child_results[label] = {"STATUS": "MISSING", "BLOCK_REASON": "VERIFIER_OUTPUT_INCOMPLETE"}
            continue
        r = run_child_verifier(script_path, args.profile)
        child_results[label] = r
        if r["STATUS"] != "PASS" or r["rc"] != 0:
            all_pass = False
            if failed_child is None:
                failed_child = label

    elapsed_ms = int((time.time() - t0) * 1000)

    if all_pass:
        status = "PASS"
        auth_status = "PASS"
        claim_status = "PASS"
        orch_status = "PASS"
        claim_atomicity = "PASS"
        claim_replay = "PASS"
        fail_closed = "PASS"
        block_reason = ""
    else:
        status = "BLOCKED"
        # Determine which child failed
        if failed_child:
            block_reason = f"{failed_child}_FAILED"
        else:
            block_reason = "VERIFIER_OUTPUT_INCOMPLETE"
        auth_status = child_results["AUTHORIZATION_VERIFIER"].get("STATUS", "UNKNOWN")
        claim_status = child_results["CLAIM_VERIFIER"].get("STATUS", "UNKNOWN")
        orch_status = child_results["ORCHESTRATOR_VERIFIER"].get("STATUS", "UNKNOWN")
        claim_atomicity = child_results["CLAIM_VERIFIER"].get("kv", {}).get("CLAIM_ATOMICITY", "UNKNOWN")
        claim_replay = child_results["CLAIM_VERIFIER"].get("kv", {}).get("REPLAY_PROTECTION", "UNKNOWN")
        fail_closed = child_results["ORCHESTRATOR_VERIFIER"].get("kv", {}).get("FAIL_CLOSED_CONTRACT", "UNKNOWN")

    lines = [
        f"STATUS={status}",
        f"PROFILE={args.profile}",
        f"AUTHORIZATION_VERIFIER={auth_status}",
        f"CLAIM_VERIFIER={claim_status}",
        f"CLAIM_ATOMICITY={claim_atomicity}",
        f"CLAIM_REPLAY_PROTECTION={claim_replay}",
        f"ORCHESTRATOR_VERIFIER={orch_status}",
        f"FAIL_CLOSED_CONTRACT={fail_closed}",
        f"LEGACY_SHELL_HARNESS_BLOCKING=false",
        f"RUNTIME_ACCEPTANCE_READY={'true' if status == 'PASS' else 'false'}",
        f"PRODUCTION_DEPLOY_MODE=NOT_IMPLEMENTED",
        f"PRODUCTION_DEPLOY_EXECUTED=false",
        f"ELAPSED_MS={elapsed_ms}",
    ]
    if block_reason:
        lines.append(f"BLOCK_REASON={block_reason}")
    return finalize(lines, status)


if __name__ == "__main__":
    sys.exit(main())