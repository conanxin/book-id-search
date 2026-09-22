#!/usr/bin/env python3
import importlib.util, pathlib, tempfile, unittest
P=pathlib.Path(__file__).resolve().parent/'verify'/'s32_runtime_common.py'
def load():
    s=importlib.util.spec_from_file_location('m',P); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
class T(unittest.TestCase):
    def setUp(self): self.m=load()
    def test_unique_kv(self):
        self.assertEqual(self.m.parse_unique_kv('A=1\nB=2\n',{'A','B'}),{'A':'1','B':'2'})
        with self.assertRaisesRegex(ValueError,'DUPLICATE_KEY'): self.m.parse_unique_kv('A=1\nA=2\n',{'A'})
    def test_receipt_rejects_secret_and_is_0600(self):
        with tempfile.TemporaryDirectory() as d:
            p=pathlib.Path(d)/'r.env'; h=self.m.write_receipt_atomic(p,{'STATUS':'PASS','X':'1'})
            self.assertEqual(len(h),64); self.assertEqual(p.stat().st_mode & 0o777,0o600)
            with self.assertRaisesRegex(ValueError,'SECRET_KEY_FORBIDDEN'):
                self.m.write_receipt_atomic(pathlib.Path(d)/'secret.env',{'TOKEN':'x'})
    def test_attempt_state(self):
        with tempfile.TemporaryDirectory() as d:
            d=pathlib.Path(d); s=d/'start'; r=d/'result'
            self.assertEqual(self.m.classify_attempt(s,r),'NOT_STARTED')
            s.write_text('x'); self.assertEqual(self.m.classify_attempt(s,r),'INCOMPLETE')
            r.write_text('x'); self.assertEqual(self.m.classify_attempt(s,r),'TERMINAL')
if __name__=='__main__': unittest.main()
