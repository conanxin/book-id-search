#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from pathlib import Path

GIB = 1024**3
HARD = 20 * GIB
PREFERRED = 21 * GIB
MAX_USED_PERCENT = 80.0


def validate_candidate_sources(release_source: str, candidates: list[str]) -> None:
    if any(source != release_source for source in candidates):
        raise ValueError("SOURCE_IDENTITY_MISMATCH")


def evaluate_capacity(*, current_free: int, total_bytes: int, peak: int) -> dict[str, object]:
    if min(current_free, total_bytes, peak) < 0 or total_bytes <= 0:
        raise ValueError("INVALID_CAPACITY_INPUT")

    free_after = current_free - peak
    used_after = ((total_bytes - free_after) * 100.0 / total_bytes)

    if free_after < HARD or used_after > MAX_USED_PERCENT:
        gate = "BLOCKED_CAPACITY"
    elif free_after >= PREFERRED:
        gate = "PASS_PREFERRED"
    else:
        gate = "PASS_HARD_ONLY"

    return {
        "CAPACITY_GATE": gate,
        "CURRENT_FREE_BYTES": current_free,
        "PEAK_INCREMENT_BYTES": peak,
        "FREE_AFTER_PEAK_BYTES": free_after,
        "USED_AFTER_PEAK_PERCENT": round(used_after, 4),
        "HARD_RESERVE_BYTES": HARD,
        "PREFERRED_RESERVE_BYTES": PREFERRED,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    args = parser.parse_args(argv)

    data = json.loads(Path(args.input).read_text(encoding="utf-8"))
    validate_candidate_sources(data["releaseSourceSha"], data["candidateSourceShas"])
    result = evaluate_capacity(
        current_free=int(data["currentFreeBytes"]),
        total_bytes=int(data["totalBytes"]),
        peak=int(data["peakIncrementBytes"]),
    )
    for key, value in result.items():
        print(f"{key}={value}")
    return 0 if str(result["CAPACITY_GATE"]).startswith("PASS_") else 1


if __name__ == "__main__":
    raise SystemExit(main())
