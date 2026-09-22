import importlib.util, pathlib, unittest

MODULE = pathlib.Path(__file__).resolve().parent / "plan-s32-production-capacity.py"
spec = importlib.util.spec_from_file_location("plan_s32_production_capacity", MODULE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

GiB = 1024**3

class T(unittest.TestCase):
    def test_preferred(self):
        result = mod.evaluate_capacity(current_free=25*GiB, total_bytes=100*GiB, peak=2*GiB)
        self.assertEqual(result["CAPACITY_GATE"], "PASS_PREFERRED")

    def test_hard_only(self):
        result = mod.evaluate_capacity(current_free=22*GiB, total_bytes=100*GiB, peak=int(1.5*GiB))
        self.assertEqual(result["CAPACITY_GATE"], "PASS_HARD_ONLY")

    def test_historical_case_is_blocked(self):
        result = mod.evaluate_capacity(current_free=int(20.2888*GiB), total_bytes=100*GiB, peak=int(1.9412*GiB))
        self.assertEqual(result["CAPACITY_GATE"], "BLOCKED_CAPACITY")

    def test_used_percent_above_80_blocks(self):
        result = mod.evaluate_capacity(current_free=22*GiB, total_bytes=110*GiB, peak=2*GiB)
        self.assertEqual(result["CAPACITY_GATE"], "BLOCKED_CAPACITY")

    def test_source_mismatch(self):
        with self.assertRaisesRegex(ValueError, "SOURCE_IDENTITY_MISMATCH"):
            mod.validate_candidate_sources("1"*40, ["1"*40, "2"*40])

if __name__ == "__main__":
    unittest.main()
