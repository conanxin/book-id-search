#!/usr/bin/env python3
import pathlib, subprocess, sys, tempfile, textwrap, unittest

ROOT=pathlib.Path(__file__).resolve().parent
HELPER=ROOT/"plan-s32-production-baseline-with-grace.py"

class T(unittest.TestCase):
    def test_retries_transient_failures_then_passes(self):
        with tempfile.TemporaryDirectory() as td:
            td=pathlib.Path(td)
            counter=td/"counter"
            planner=td/"planner.py"
            planner.write_text(textwrap.dedent(f"""                import pathlib,sys,json
                c=pathlib.Path({str(counter)!r})
                n=int(c.read_text())+1 if c.exists() else 1
                c.write_text(str(n))
                out=pathlib.Path(sys.argv[sys.argv.index('--json-out')+1])
                if n < 3:
                    print('STATUS=BLOCKED')
                    raise SystemExit(1)
                out.write_text(json.dumps({{'ok':True}}))
                print('STATUS=PASS')
            """))
            out=td/"out.json"
            r=subprocess.run([sys.executable,str(HELPER),"--planner",str(planner),"--json-out",str(out),"--attempts","4","--delay-seconds","0"],text=True,capture_output=True)
            self.assertEqual(r.returncode,0,r.stdout+r.stderr)
            self.assertIn("BASELINE_ATTEMPT=3",r.stdout)
            self.assertEqual(counter.read_text(),"3")
            self.assertTrue(out.exists())

    def test_exhaustion_fails_closed(self):
        with tempfile.TemporaryDirectory() as td:
            td=pathlib.Path(td)
            planner=td/"planner.py"
            planner.write_text("import sys\nprint('STATUS=BLOCKED')\nraise SystemExit(1)\n")
            out=td/"out.json"
            r=subprocess.run([sys.executable,str(HELPER),"--planner",str(planner),"--json-out",str(out),"--attempts","2","--delay-seconds","0"],text=True,capture_output=True)
            self.assertNotEqual(r.returncode,0)
            self.assertIn("BASELINE_BOOT_GRACE_EXHAUSTED",r.stdout+r.stderr)
            self.assertFalse(out.exists())

if __name__=="__main__":
    unittest.main()
