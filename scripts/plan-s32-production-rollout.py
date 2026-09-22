#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

STAGES = ("R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7")
FP_RE = re.compile(r"^[0-9a-f]{64}$")

def emit(**fields: str) -> int:
    for key, value in fields.items():
        print(f"{key}={value}")
    status = fields.get("STATUS", "")
    return 0 if status.startswith("READY_FOR_") or status == "ROLLOUT_COMPLETE" else 1

def read_kv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw or raw.startswith("#"):
            continue
        if "=" not in raw:
            raise ValueError(f"MALFORMED_RECEIPT:{path.name}")
        key, value = raw.split("=", 1)
        if key in values:
            raise ValueError(f"DUPLICATE_KEY:{path.name}:{key}")
        values[key] = value
    return values

def receipt_path(root: Path, stage: str) -> Path:
    return root / f"{stage.lower()}.env"

def start_path(root: Path, stage: str) -> Path:
    return root / f"{stage.lower()}.start"

def main() -> int:
    ap = argparse.ArgumentParser(description="Read-only S32 production rollout state planner")
    ap.add_argument("--state-dir", required=True)
    ap.add_argument("--release-fingerprint", required=True)
    args = ap.parse_args()

    fp = args.release_fingerprint.strip()
    if not FP_RE.fullmatch(fp):
        return emit(STATUS="BLOCKED", BLOCK_REASON="INVALID_RELEASE_FINGERPRINT")

    root = Path(args.state_dir)
    if not root.is_dir():
        return emit(STATUS="BLOCKED", BLOCK_REASON="STATE_DIR_MISSING")

    receipts: dict[str, dict[str, str]] = {}
    try:
        for stage in STAGES:
            rp = receipt_path(root, stage)
            if rp.exists():
                receipt = read_kv(rp)
                if receipt.get("STATUS") != "PASS":
                    return emit(STATUS="BLOCKED", BLOCK_REASON=f"{stage}_RECEIPT_NOT_PASS")
                if receipt.get("S32_RELEASE_FINGERPRINT") != fp:
                    return emit(STATUS="BLOCKED", BLOCK_REASON="RELEASE_FINGERPRINT_MISMATCH")
                receipts[stage] = receipt

        # A start artifact without a terminal receipt is ambiguous and must never auto-resume.
        for stage in STAGES[2:]:
            if start_path(root, stage).exists() and stage not in receipts:
                return emit(STATUS="INCOMPLETE", BLOCK_REASON=f"INCOMPLETE_{stage}")

        if "R0" not in receipts:
            return emit(STATUS="BLOCKED", BLOCK_REASON="R0_MISSING")

        # Receipt graph must be prefix-complete.
        highest = max((STAGES.index(s) for s in receipts), default=0)
        for idx in range(highest + 1):
            if STAGES[idx] not in receipts:
                return emit(STATUS="BLOCKED", BLOCK_REASON="INVALID_RECEIPT_GRAPH")

        if "R1" not in receipts:
            return emit(STATUS="READY_FOR_R1", NEXT_STAGE="R1")

        gate = receipts["R1"].get("CAPACITY_GATE", "")
        if gate == "BLOCKED_CAPACITY":
            return emit(STATUS="BLOCKED", BLOCK_REASON="BLOCKED_CAPACITY")
        if gate not in ("PASS_PREFERRED", "PASS_HARD_ONLY"):
            return emit(STATUS="BLOCKED", BLOCK_REASON="R1_CAPACITY_GATE_INVALID")
        if gate == "PASS_HARD_ONLY" and receipts["R1"].get("HARD_ONLY_ACCEPTED") != "YES":
            return emit(STATUS="BLOCKED", BLOCK_REASON="HARD_ONLY_ACCEPTANCE_REQUIRED")

        for stage in STAGES[2:]:
            if stage not in receipts:
                return emit(STATUS=f"READY_FOR_{stage}", NEXT_STAGE=stage)

        return emit(STATUS="ROLLOUT_COMPLETE", NEXT_STAGE="NONE")
    except (OSError, ValueError) as exc:
        return emit(STATUS="BLOCKED", BLOCK_REASON=str(exc))

if __name__ == "__main__":
    raise SystemExit(main())
