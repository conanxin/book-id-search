#!/usr/bin/env python3
"""
Self-tests for the Unified Web Release Runtime Acceptance Gate.

Each test is run via subprocess with timeout to prevent hangs.
"""
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

GATE_SCRIPT = Path(__file__).resolve().parent / "verify-web-release-runtime-acceptance.py"


def make_fake_child(output_text: str, exit_code: int = 0) -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="test_gate_fake_"))
    script = tmp / "fake_child.py"
    script.write_text(f"""#!/usr/bin/env python3
import sys
print({output_text!r})
sys.exit({exit_code})
""")
    script.chmod(0o755)
    return script


def run_gate_with_fakes(auth_output: str, claim_output: str, orch_output: str,
                         auth_exit: int = 0, claim_exit: int = 0, orch_exit: int = 0,
                         profile: str = "quick", timeout: int = 60) -> tuple[int, str]:
    auth_fake = make_fake_child(auth_output, auth_exit)
    claim_fake = make_fake_child(claim_output, claim_exit)
    orch_fake = make_fake_child(orch_output, orch_exit)
    env = os.environ.copy()
    env["WEB_RELEASE_VERIFIER_AUTHORIZATION_VERIFIER"] = str(auth_fake)
    env["WEB_RELEASE_VERIFIER_CLAIM_VERIFIER"] = str(claim_fake)
    env["WEB_RELEASE_VERIFIER_ORCHESTRATOR_VERIFIER"] = str(orch_fake)
    try:
        proc = subprocess.run(
            ["python3", str(GATE_SCRIPT), "--profile", profile],
            env=env, capture_output=True, timeout=timeout,
        )
        return proc.returncode, proc.stdout.decode("utf-8", errors="replace")
    finally:
        for d in [auth_fake.parent, claim_fake.parent, orch_fake.parent]:
            if d and d.exists():
                shutil.rmtree(d, ignore_errors=True)


def run_test(name, fn):
    try:
        fn()
    except subprocess.TimeoutExpired:
        print(f"FAIL {name}: timeout")
        return False
    except Exception as e:
        print(f"FAIL {name}: {type(e).__name__}: {e}")
        return False
    return True


def test_invalid_profile():
    result = subprocess.run(
        ["python3", str(GATE_SCRIPT), "--profile", "bogus"],
        capture_output=True, timeout=30,
    )
    assert result.returncode != 0


def test_all_pass():
    rc, output = run_gate_with_fakes(
        "STATUS=PASS\nVERIFIER=authorization",
        "STATUS=PASS\nVERIFIER=claim\nCLAIM_ATOMICITY=true\nREPLAY_PROTECTION=true",
        "STATUS=PASS\nVERIFIER=orchestrator\nFAIL_CLOSED_CONTRACT=true",
        timeout=60,
    )
    assert rc == 0, f"rc={rc} output={output[:200]}"
    for line in [
        "STATUS=PASS", "RUNTIME_ACCEPTANCE_READY=true",
        "AUTHORIZATION_VERIFIER=PASS", "CLAIM_VERIFIER=PASS",
        "ORCHESTRATOR_VERIFIER=PASS", "PRODUCTION_DEPLOY_EXECUTED=false",
        "LEGACY_SHELL_HARNESS_BLOCKING=false",
    ]:
        assert line in output, f"missing: {line}"


def test_auth_fail():
    rc, output = run_gate_with_fakes(
        "STATUS=BLOCKED\nBLOCK_REASON=AUTH_FAIL",
        "STATUS=PASS\nVERIFIER=claim\nCLAIM_ATOMICITY=true\nREPLAY_PROTECTION=true",
        "STATUS=PASS\nVERIFIER=orchestrator\nFAIL_CLOSED_CONTRACT=true",
        auth_exit=1, timeout=60,
    )
    assert rc != 0
    assert "STATUS=BLOCKED" in output
    assert "RUNTIME_ACCEPTANCE_READY=false" in output
    assert "AUTHORIZATION_VERIFIER=BLOCKED" in output


def test_claim_fail():
    rc, output = run_gate_with_fakes(
        "STATUS=PASS\nVERIFIER=authorization",
        "STATUS=BLOCKED\nBLOCK_REASON=CLAIM_FAIL",
        "STATUS=PASS\nVERIFIER=orchestrator\nFAIL_CLOSED_CONTRACT=true",
        claim_exit=1, timeout=60,
    )
    assert rc != 0
    assert "STATUS=BLOCKED" in output
    assert "CLAIM_VERIFIER=BLOCKED" in output


def test_orch_fail():
    rc, output = run_gate_with_fakes(
        "STATUS=PASS\nVERIFIER=authorization",
        "STATUS=PASS\nVERIFIER=claim\nCLAIM_ATOMICITY=true\nREPLAY_PROTECTION=true",
        "STATUS=BLOCKED\nBLOCK_REASON=ORCH_FAIL",
        orch_exit=1, timeout=60,
    )
    assert rc != 0
    assert "STATUS=BLOCKED" in output
    assert "ORCHESTRATOR_VERIFIER=BLOCKED" in output


def test_missing_status():
    rc, output = run_gate_with_fakes(
        "VERIFIER=authorization",
        "STATUS=PASS\nVERIFIER=claim\nCLAIM_ATOMICITY=true\nREPLAY_PROTECTION=true",
        "STATUS=PASS\nVERIFIER=orchestrator\nFAIL_CLOSED_CONTRACT=true",
        timeout=60,
    )
    assert rc != 0
    assert "STATUS=BLOCKED" in output


def test_exit_zero_but_blocked():
    rc, output = run_gate_with_fakes(
        "STATUS=BLOCKED\nBLOCK_REASON=AUTH_FAIL",
        "STATUS=PASS\nVERIFIER=claim\nCLAIM_ATOMICITY=true\nREPLAY_PROTECTION=true",
        "STATUS=PASS\nVERIFIER=orchestrator\nFAIL_CLOSED_CONTRACT=true",
        timeout=60,
    )
    assert rc != 0


def test_acceptance_ready_only_when_all_pass():
    rc1, output1 = run_gate_with_fakes(
        "STATUS=PASS\nVERIFIER=authorization",
        "STATUS=PASS\nVERIFIER=claim\nCLAIM_ATOMICITY=true\nREPLAY_PROTECTION=true",
        "STATUS=PASS\nVERIFIER=orchestrator\nFAIL_CLOSED_CONTRACT=true",
        timeout=60,
    )
    assert "RUNTIME_ACCEPTANCE_READY=true" in output1
    rc2, output2 = run_gate_with_fakes(
        "STATUS=BLOCKED",
        "STATUS=PASS\nVERIFIER=claim",
        "STATUS=PASS\nVERIFIER=orchestrator",
        auth_exit=1, timeout=60,
    )
    assert "RUNTIME_ACCEPTANCE_READY=false" in output2


def test_production_deploy_always_false():
    rc, output = run_gate_with_fakes(
        "STATUS=PASS\nVERIFIER=authorization",
        "STATUS=PASS\nVERIFIER=claim",
        "STATUS=PASS\nVERIFIER=orchestrator",
        timeout=60,
    )
    assert "PRODUCTION_DEPLOY_EXECUTED=false" in output
    assert "PRODUCTION_DEPLOY_MODE=NOT_IMPLEMENTED" in output


def test_legacy_blocking_always_false():
    rc, output = run_gate_with_fakes(
        "STATUS=PASS\nVERIFIER=authorization",
        "STATUS=PASS\nVERIFIER=claim",
        "STATUS=PASS\nVERIFIER=orchestrator",
        timeout=60,
    )
    assert "LEGACY_SHELL_HARNESS_BLOCKING=false" in output


def main():
    tests = [
        ("test_invalid_profile", test_invalid_profile),
        ("test_all_pass", test_all_pass),
        ("test_auth_fail", test_auth_fail),
        ("test_claim_fail", test_claim_fail),
        ("test_orch_fail", test_orch_fail),
        ("test_missing_status", test_missing_status),
        ("test_exit_zero_but_blocked", test_exit_zero_but_blocked),
        ("test_acceptance_ready_only_when_all_pass", test_acceptance_ready_only_when_all_pass),
        ("test_production_deploy_always_false", test_production_deploy_always_false),
        ("test_legacy_blocking_always_false", test_legacy_blocking_always_false),
    ]
    passed = 0
    failed = 0
    for name, fn in tests:
        if run_test(name, fn):
            print(f"PASS {name}")
            passed += 1
        else:
            failed += 1
    print(f"\nTOTAL: {passed + failed} PASS: {passed} FAIL: {failed}")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())