#!/usr/bin/env python3
from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys
import time


def main() -> int:
    ap = argparse.ArgumentParser(description="Run production baseline with bounded boot grace.")
    ap.add_argument("--json-out", required=True)
    ap.add_argument("--planner")
    ap.add_argument("--attempts", type=int, default=6)
    ap.add_argument("--delay-seconds", type=float, default=2.0)
    args = ap.parse_args()

    if args.attempts < 1 or args.attempts > 30:
        print("STATUS=BLOCKED")
        print("BLOCK_REASON=INVALID_ATTEMPTS")
        return 1
    if args.delay_seconds < 0 or args.delay_seconds > 30:
        print("STATUS=BLOCKED")
        print("BLOCK_REASON=INVALID_DELAY")
        return 1

    script_dir = pathlib.Path(__file__).resolve().parent
    planner = pathlib.Path(args.planner) if args.planner else script_dir / "plan-s32-production-baseline.py"
    if not planner.is_file():
        print("STATUS=BLOCKED")
        print("BLOCK_REASON=BASELINE_PLANNER_MISSING")
        return 1

    out = pathlib.Path(args.json_out)
    last_stdout = ""
    last_stderr = ""
    for attempt in range(1, args.attempts + 1):
        if out.exists():
            out.unlink()
        proc = subprocess.run(
            [sys.executable, str(planner), "--json-out", str(out)],
            text=True,
            capture_output=True,
        )
        last_stdout, last_stderr = proc.stdout, proc.stderr
        if proc.returncode == 0:
            if last_stdout:
                sys.stdout.write(last_stdout)
            print(f"BASELINE_ATTEMPT={attempt}")
            return 0
        if attempt < args.attempts and args.delay_seconds:
            time.sleep(args.delay_seconds)

    if last_stdout:
        sys.stdout.write(last_stdout)
    if last_stderr:
        sys.stderr.write(last_stderr)
    print("STATUS=BLOCKED")
    print("BLOCK_REASON=BASELINE_BOOT_GRACE_EXHAUSTED")
    print(f"BASELINE_ATTEMPTS={args.attempts}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
