import importlib.util, pathlib, tempfile, os, stat, unittest

MODULE = pathlib.Path(__file__).resolve().parent / "verify" / "s32_runtime_common.py"
spec = importlib.util.spec_from_file_location("s32_runtime_common", MODULE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

class T(unittest.TestCase):
    def test_parse_unique_kv(self):
        self.assertEqual(mod.parse_unique_kv("A=1\nB=2\n", {"A","B"}), {"A":"1","B":"2"})
        with self.assertRaisesRegex(ValueError, "DUPLICATE_KEY"):
            mod.parse_unique_kv("A=1\nA=2\n", {"A"})

    def test_secret_receipt_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError, "SECRET_FIELD_FORBIDDEN"):
                mod.write_receipt_atomic(pathlib.Path(d)/"r.env", {"TOKEN":"x"})

    def test_atomic_receipt_and_hash(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/"r.env"
            digest=mod.write_receipt_atomic(p, {"A":"1","B":"2"})
            self.assertEqual(oct(p.stat().st_mode & 0o777), "0o600")
            self.assertEqual(mod.sha256_file(p), digest)
            self.assertEqual(mod.read_receipt(p), {"A":"1","B":"2"})

    def test_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            base=pathlib.Path(d)/"x"
            base.write_text("A=1\n")
            link=pathlib.Path(d)/"l"
            link.symlink_to(base)
            with self.assertRaisesRegex(ValueError, "UNSAFE_RECEIPT_FILE"):
                mod.read_receipt(link)

    def test_attempt(self):
        with tempfile.TemporaryDirectory() as d:
            d=pathlib.Path(d); start=d/"start"; result=d/"result"
            self.assertEqual(mod.classify_attempt(start,result), "NOT_STARTED")
            start.write_text("x")
            self.assertEqual(mod.classify_attempt(start,result), "INCOMPLETE")
            result.write_text("x")
            self.assertEqual(mod.classify_attempt(start,result), "TERMINAL")

if __name__ == "__main__":
    unittest.main()
