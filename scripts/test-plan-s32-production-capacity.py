#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

S = pathlib.Path(__file__).resolve().parent / "plan-s32-production-capacity.py"
G = 1024**3

def fs(ident, total, free):
    return {
        "id": ident,
        "totalBytes": total,
        "usedBytes": total - free,
        "freeBytes": free,
    }

def facts(
    free,
    *,
    total=50 * G,
    api=100_000_000,
    web=100_000_000,
    separate=False,
    data_free=None,
    data_total=100 * G,
):
    root = fs("root", total, free)
    data = fs("data", data_total, data_free if data_free is not None else 30 * G) if separate else dict(root)
    return {
        "releaseFingerprint": "a" * 64,
        "releaseSourceSha": "b" * 40,
        "api": {
            "sourceSha": "b" * 40,
            "compressedBytes": api,
            "tarBytes": api,
            "imageBytes": api,
        },
        "web": {
            "sourceSha": "b" * 40,
            "compressedBytes": web,
            "tarBytes": web,
            "imageBytes": web,
        },
        "filesystems": {
            "docker": dict(root),
            "release": dict(root),
            "data": data,
        },
    }

def run(value):
    with tempfile.TemporaryDirectory() as d:
        p = pathlib.Path(d) / "facts.json"
        p.write_text(json.dumps(value))
        return subprocess.run(
            [sys.executable, str(S), "--facts-json", str(p)],
            text=True,
            capture_output=True,
        )

class CapacityGateTests(unittest.TestCase):
    def test_preferred(self):
        r = run(facts(25 * G))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("CAPACITY_GATE=PASS_PREFERRED", r.stdout)
        self.assertIn("S32_RELEASE_FINGERPRINT=" + "a" * 64, r.stdout)
        self.assertIn("USED_AFTER_PEAK_BPS=", r.stdout)

    def test_hard_only(self):
        r = run(facts(int(22.5 * G)))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("CAPACITY_GATE=PASS_HARD_ONLY", r.stdout)

    def test_below_reserve_blocks(self):
        r = run(facts(int(20.3 * G)))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("CAPACITY_GATE=BLOCKED_CAPACITY", r.stdout)

    def test_exact_used_bytes_over_80_percent_blocks_even_with_large_free_space(self):
        # 200 GiB filesystem, 40 GiB free => exactly 80% used before rollout.
        # Any positive rollout increment therefore exceeds the 80% ceiling.
        r = run(facts(40 * G, total=200 * G))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("USED_AFTER_PEAK_LIMIT", r.stdout + r.stderr)

    def test_near_80_percent_uses_exact_bytes_not_rounded_percent(self):
        # 100 GiB filesystem with 22 GiB free is exactly 78% used.
        # The modeled peak leaves just above the 20 GiB hard reserve and
        # remains below 80% using exact byte arithmetic.
        r = run(facts(22 * G, total=100 * G))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("CAPACITY_GATE=PASS_HARD_ONLY", r.stdout)
        line = next(x for x in r.stdout.splitlines() if x.startswith("USED_AFTER_PEAK_BPS="))
        self.assertLessEqual(int(line.split("=", 1)[1]), 8000)

    def test_separate_data_requires_its_own_headroom(self):
        r = run(
            facts(
                30 * G,
                total=100 * G,
                separate=True,
                data_free=19 * G,
                data_total=100 * G,
            )
        )
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("DATA_FILESYSTEM_CAPACITY", r.stdout + r.stderr)

    def test_source_mismatch_blocks(self):
        value = facts(30 * G)
        value["web"]["sourceSha"] = "c" * 40
        r = run(value)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("SOURCE_SHA_MISMATCH", r.stdout + r.stderr)

    def test_exact_filesystem_bytes_are_required(self):
        value = facts(30 * G)
        del value["filesystems"]["docker"]["usedBytes"]
        value["filesystems"]["docker"]["usedPercent"] = 40
        r = run(value)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("FILESYSTEM_BYTES_INVALID:usedBytes", r.stdout + r.stderr)

    def test_same_filesystem_facts_must_match_exactly(self):
        value = facts(30 * G)
        value["filesystems"]["release"]["freeBytes"] -= 1
        value["filesystems"]["release"]["usedBytes"] += 1
        r = run(value)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("DOCKER_RELEASE_FILESYSTEM_MISMATCH", r.stdout + r.stderr)

if __name__ == "__main__":
    unittest.main()
