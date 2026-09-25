#!/usr/bin/env python3
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLANNER = ROOT / "scripts" / "plan-s32-production-rollout.py"
FP = "f" * 64
SRC = "a" * 40

def write(path: Path, **fields: str) -> None:
    path.write_text("".join(f"{k}={v}\n" for k, v in fields.items()), encoding="utf-8")

def run_planner(state: Path):
    proc = subprocess.run(
        ["python3", str(PLANNER), "--state-dir", str(state), "--release-fingerprint", FP, "--release-source-sha", SRC],
        text=True, capture_output=True,
    )
    parsed = {}
    for line in proc.stdout.splitlines():
        if "=" in line:
            key, value = line.split("=", 1)
            parsed[key] = value
    return proc, parsed

def receipt_path(state: Path, stage: str, fp: str = FP) -> Path:
    if stage == "R0":
        return state / "s32-r0.env"
    if stage == "R1":
        return state / "s32-r1.env"
    return state / f"s32-rollout-{fp}-{stage}.result.env"

def start_path(state: Path, stage: str, fp: str = FP) -> Path:
    return state / f"s32-rollout-{fp}-{stage}.start.env"

def pass_receipt(state: Path, stage: str, fp: str = FP, **extra: str) -> None:
    fields = {"STATUS": "PASS", "STAGE": stage, "S32_RELEASE_FINGERPRINT": fp}
    if stage in ("R1", "R2", "R4", "R5", "R6", "R7"):
        fields["RELEASE_SOURCE_SHA"] = SRC
    fields.update(extra)
    write(receipt_path(state, stage, fp), **fields)

class RolloutPlannerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_blocks_without_r0(self):
        proc, out = run_planner(self.state)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(out["STATUS"], "BLOCKED")
        self.assertEqual(out["BLOCK_REASON"], "R0_MISSING")

    def test_real_r0_without_release_fingerprint_can_advance(self):
        write(receipt_path(self.state, "R0"), STATUS="PASS", STAGE="R0", R0_FINAL="PASS")
        pass_receipt(self.state, "R1", CAPACITY_GATE="PASS_PREFERRED")
        proc, out = run_planner(self.state)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(out["STATUS"], "READY_FOR_R2")
        self.assertEqual(out["NEXT_STAGE"], "R2")

    def test_blocks_capacity_failure(self):
        pass_receipt(self.state, "R0")
        pass_receipt(self.state, "R1", CAPACITY_GATE="BLOCKED_CAPACITY")
        proc, out = run_planner(self.state)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(out["BLOCK_REASON"], "BLOCKED_CAPACITY")

    def test_reports_incomplete_r2_attempt(self):
        pass_receipt(self.state, "R0")
        pass_receipt(self.state, "R1", CAPACITY_GATE="PASS_PREFERRED")
        write(start_path(self.state, "R2"), S32_RELEASE_FINGERPRINT=FP, STARTED="true")
        proc, out = run_planner(self.state)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(out["STATUS"], "INCOMPLETE")
        self.assertEqual(out["BLOCK_REASON"], "INCOMPLETE_R2")

    def test_rejects_r3_without_r2(self):
        pass_receipt(self.state, "R0")
        pass_receipt(self.state, "R1", CAPACITY_GATE="PASS_PREFERRED")
        pass_receipt(self.state, "R3")
        proc, out = run_planner(self.state)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(out["BLOCK_REASON"], "INVALID_RECEIPT_GRAPH")

    def test_r4_pass_is_ready_for_r5_only(self):
        for stage in ("R0", "R2", "R3", "R4"):
            pass_receipt(self.state, stage)
        pass_receipt(self.state, "R1", CAPACITY_GATE="PASS_PREFERRED")
        proc, out = run_planner(self.state)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(out["STATUS"], "READY_FOR_R5")
        self.assertEqual(out["NEXT_STAGE"], "R5")

    def test_r5_pass_is_ready_for_r6_only(self):
        for stage in ("R0", "R2", "R3", "R4", "R5"):
            pass_receipt(self.state, stage)
        pass_receipt(self.state, "R1", CAPACITY_GATE="PASS_PREFERRED")
        proc, out = run_planner(self.state)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(out["STATUS"], "READY_FOR_R6")
        self.assertEqual(out["NEXT_STAGE"], "R6")

    def test_r6_pass_is_ready_for_r7_only(self):
        for stage in ("R0", "R2", "R3", "R4", "R5", "R6"):
            pass_receipt(self.state, stage)
        pass_receipt(self.state, "R1", CAPACITY_GATE="PASS_PREFERRED")
        proc, out = run_planner(self.state)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(out["STATUS"], "READY_FOR_R7")
        self.assertEqual(out["NEXT_STAGE"], "R7")

    def test_all_pass_is_complete(self):
        for stage in ("R0", "R2", "R3", "R4", "R5", "R6", "R7"):
            pass_receipt(self.state, stage)
        pass_receipt(self.state, "R1", CAPACITY_GATE="PASS_PREFERRED")
        proc, out = run_planner(self.state)
        self.assertEqual(proc.returncode, 0)
        self.assertEqual(out["STATUS"], "ROLLOUT_COMPLETE")
        self.assertEqual(out["NEXT_STAGE"], "NONE")

    def test_legacy_simplified_receipt_names_do_not_advance_state(self):
        write(self.state / "r0.env", STATUS="PASS", STAGE="R0", R0_FINAL="PASS")
        write(self.state / "r1.env", STATUS="PASS", STAGE="R1", S32_RELEASE_FINGERPRINT=FP, CAPACITY_GATE="PASS_PREFERRED")
        proc, out = run_planner(self.state)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(out["BLOCK_REASON"], "R0_MISSING")

    def test_r1_source_mismatch_blocks(self):
        pass_receipt(self.state, "R0")
        pass_receipt(self.state, "R1", RELEASE_SOURCE_SHA="b" * 40, CAPACITY_GATE="PASS_PREFERRED")
        proc, out = run_planner(self.state)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(out["BLOCK_REASON"], "RELEASE_SOURCE_MISMATCH")

    def test_mixed_fingerprint_blocks(self):
        pass_receipt(self.state, "R0")
        pass_receipt(self.state, "R1", fp="e" * 64, CAPACITY_GATE="PASS_PREFERRED")
        proc, out = run_planner(self.state)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(out["BLOCK_REASON"], "RELEASE_FINGERPRINT_MISMATCH")

if __name__ == "__main__":
    unittest.main()
