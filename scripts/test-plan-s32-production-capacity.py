#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT=pathlib.Path(__file__).resolve().parent
S=ROOT/"plan-s32-production-capacity.py"
MAN=ROOT/"s32-release-manifest.py"
G=1024**3
SRC="b"*40

def manifest():
    return {
        "version":1,
        "sourceSha":SRC,
        "pnpmLockSha256":"1"*64,
        "apiImageTag":"book-id-search-api:s32-"+SRC,
        "apiImageId":"sha256:"+"2"*64,
        "apiOciRevision":SRC,
        "apiBaseDigest":"node@sha256:"+"3"*64,
        "webImageTag":"book-id-search-web:"+SRC,
        "webImageId":"sha256:"+"4"*64,
        "webOciRevision":SRC,
        "webStaticManifestSha256":"5"*64,
        "webS32Enabled":True,
        "webNodeBaseDigest":"node@sha256:"+"6"*64,
        "webNginxBaseDigest":"nginx@sha256:"+"7"*64,
        "pgImageRef":"postgres@sha256:"+"8"*64,
        "pgImageId":"sha256:"+"9"*64,
        "migrationPath":"db/migrations/001_s32_core_schema.sql",
        "migrationSha256":"a1"*32,
        "roleBootstrapPath":"deploy/s32-production-roles.sql",
        "roleBootstrapSha256":"b2"*32,
        "s32OverridePath":"deploy/s32-production.override.yml",
        "s32OverrideSha256":"c3"*32,
    }

def fingerprint(path):
    out=subprocess.check_output([sys.executable,str(MAN),str(path)],text=True)
    return next(line.split("=",1)[1] for line in out.splitlines() if line.startswith("S32_RELEASE_FINGERPRINT="))

def api_candidate(size=100_000_000):
    return {
        "sourceSha":SRC,
        "imageTag":"book-id-search-api:s32-"+SRC,
        "imageId":"sha256:"+"2"*64,
        "ociRevision":SRC,
        "lockfileSha256":"1"*64,
        "baseDigest":"node@sha256:"+"3"*64,
        "imageBytes":size,
        "tarBytes":size,
        "compressedBytes":size,
    }

def web_candidate(size=100_000_000):
    return {
        "tag":"book-id-search-web:"+SRC,
        "imageId":"sha256:"+"4"*64,
        "gitSha":SRC,
        "ociRevision":SRC,
        "webS32Enabled":True,
        "lockfileSha256":"1"*64,
        "staticManifestSha256":"5"*64,
        "nodeBaseDigest":"node@sha256:"+"6"*64,
        "nginxBaseDigest":"nginx@sha256:"+"7"*64,
        "imageBytes":size,
        "tarBytes":size,
        "compressedBytes":size,
    }

def fs(ident,total,free):
    return {"id":ident,"totalBytes":total,"usedBytes":total-free,"freeBytes":free}

def base_filesystems(free,*,total=50*G,separate=False,data_free=None,data_total=100*G):
    root=fs("root",total,free)
    data=fs("data",data_total,data_free if data_free is not None else 30*G) if separate else dict(root)
    return {"docker":dict(root),"release":dict(root),"data":data}

def run(*,free,total=50*G,separate=False,data_free=None,data_total=100*G,mutate=None,api_size=100_000_000,web_size=100_000_000):
    with tempfile.TemporaryDirectory() as d:
        root=pathlib.Path(d)
        man=root/"manifest.json"
        man.write_text(json.dumps(manifest()))
        fp=fingerprint(man)
        api=api_candidate(api_size)
        web=web_candidate(web_size)
        facts={
            "releaseFingerprint":fp,
            "releaseSourceSha":SRC,
            "filesystems":base_filesystems(free,total=total,separate=separate,data_free=data_free,data_total=data_total),
        }
        if mutate:
            mutate(facts,api,web)
        fp_path=root/"facts.json"; api_path=root/"api.json"; web_path=root/"web.json"
        fp_path.write_text(json.dumps(facts)); api_path.write_text(json.dumps(api)); web_path.write_text(json.dumps(web))
        return subprocess.run([
            sys.executable,str(S),
            "--facts-json",str(fp_path),
            "--release-manifest-json",str(man),
            "--api-candidate-json",str(api_path),
            "--web-candidate-json",str(web_path),
        ],text=True,capture_output=True)

class CapacityGateTests(unittest.TestCase):
    def test_preferred(self):
        r=run(free=25*G)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn("CAPACITY_GATE=PASS_PREFERRED",r.stdout)
        self.assertIn("API_IMAGE_ID=sha256:"+"2"*64,r.stdout)
        self.assertIn("WEB_IMAGE_ID=sha256:"+"4"*64,r.stdout)

    def test_hard_only(self):
        r=run(free=int(22.5*G))
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn("CAPACITY_GATE=PASS_HARD_ONLY",r.stdout)

    def test_below_reserve_blocks(self):
        r=run(free=int(20.3*G))
        self.assertNotEqual(r.returncode,0)
        self.assertIn("CAPACITY_GATE=BLOCKED_CAPACITY",r.stdout)

    def test_exact_used_bytes_over_80_percent_blocks_even_with_large_free_space(self):
        r=run(free=40*G,total=200*G)
        self.assertNotEqual(r.returncode,0)
        self.assertIn("USED_AFTER_PEAK_LIMIT",r.stdout+r.stderr)

    def test_near_80_percent_uses_exact_bytes_not_rounded_percent(self):
        r=run(free=22*G,total=100*G)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn("CAPACITY_GATE=PASS_HARD_ONLY",r.stdout)
        bps=int(next(x.split("=",1)[1] for x in r.stdout.splitlines() if x.startswith("USED_AFTER_PEAK_BPS=")))
        self.assertLessEqual(bps,8000)

    def test_separate_data_requires_its_own_headroom(self):
        r=run(free=30*G,total=100*G,separate=True,data_free=19*G,data_total=100*G)
        self.assertNotEqual(r.returncode,0)
        self.assertIn("DATA_FILESYSTEM_CAPACITY",r.stdout+r.stderr)

    def test_exact_filesystem_bytes_are_required(self):
        def mutate(facts,api,web):
            del facts["filesystems"]["docker"]["usedBytes"]
            facts["filesystems"]["docker"]["usedPercent"]=40
        r=run(free=30*G,mutate=mutate)
        self.assertNotEqual(r.returncode,0)
        self.assertIn("FILESYSTEM_BYTES_INVALID:usedBytes",r.stdout+r.stderr)

    def test_same_filesystem_facts_must_match_exactly(self):
        def mutate(facts,api,web):
            facts["filesystems"]["release"]["freeBytes"]-=1
            facts["filesystems"]["release"]["usedBytes"]+=1
        r=run(free=30*G,mutate=mutate)
        self.assertNotEqual(r.returncode,0)
        self.assertIn("DOCKER_RELEASE_FILESYSTEM_MISMATCH",r.stdout+r.stderr)

    def test_candidate_identity_mismatch_blocks_before_capacity(self):
        def mutate(facts,api,web):
            web["imageId"]="sha256:"+"f"*64
        r=run(free=30*G,mutate=mutate)
        self.assertNotEqual(r.returncode,0)
        self.assertIn("CANDIDATE_RELEASE_IDENTITY_MISMATCH",r.stdout+r.stderr)

    def test_release_fingerprint_mismatch_blocks(self):
        def mutate(facts,api,web):
            facts["releaseFingerprint"]="f"*64
        r=run(free=30*G,mutate=mutate)
        self.assertNotEqual(r.returncode,0)
        self.assertIn("RELEASE_FINGERPRINT_MISMATCH",r.stdout+r.stderr)

    def test_candidate_sizes_are_taken_from_exact_candidate_files(self):
        r=run(free=23*G,api_size=400_000_000,web_size=400_000_000)
        self.assertNotEqual(r.returncode,0)
        self.assertIn("CAPACITY_GATE=BLOCKED_CAPACITY",r.stdout)

if __name__=="__main__":
    unittest.main()
