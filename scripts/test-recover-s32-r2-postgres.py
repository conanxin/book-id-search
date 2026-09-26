#!/usr/bin/env python3
"""Dynamic regressions for INCOMPLETE-R2 verify-only recovery.

Everything is repository-contained: the release manifest is generated in
the temporary test repo, the normal R2 root-cause contract is exercised
through its real executor test, and fake Docker/host-read helpers drive the
real recovery script through success and fail-closed paths.
"""
import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = REPO / "scripts" / "recover-s32-r2-postgres.sh"
EXEC_TEST = REPO / "scripts" / "test-execute-s32-r2-postgres.py"
PLANNER = REPO / "scripts" / "plan-s32-production-rollout.py"
MAN_TOOL = REPO / "scripts" / "s32-release-manifest.py"

SRC = "1" * 40
TOOL = "d" * 40
PG_REF = "postgres@sha256:" + "8" * 64
PG_ID = "sha256:" + "9" * 64
PG_DIGEST = "sha256:" + "8" * 64


def sh(args, cwd, env=None):
    return subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)


def manifest():
    return {
        "version": 1,
        "sourceSha": SRC,
        "pnpmLockSha256": "a" * 64,
        "apiImageTag": "book-id-search-api:s32-" + SRC,
        "apiImageId": "sha256:" + "2" * 64,
        "apiOciRevision": SRC,
        "apiBaseDigest": "node@sha256:" + "3" * 64,
        "webImageTag": "book-id-search-web:" + SRC,
        "webImageId": "sha256:" + "4" * 64,
        "webOciRevision": SRC,
        "webStaticManifestSha256": "5" * 64,
        "webS32Enabled": True,
        "webNodeBaseDigest": "node@sha256:" + "6" * 64,
        "webNginxBaseDigest": "nginx@sha256:" + "7" * 64,
        "pgImageRef": PG_REF,
        "pgImageId": PG_ID,
        "migrationPath": "db/migrations/001_s32_core_schema.sql",
        "migrationSha256": "b" * 64,
        "roleBootstrapPath": "deploy/s32-production-roles.sql",
        "roleBootstrapSha256": "c" * 64,
        "s32OverridePath": "deploy/s32-production.override.yml",
        "s32OverrideSha256": "e" * 64,
    }


FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
a=sys.argv[1:]
if a[:2] == ["image","inspect"]:
    fmt=a[a.index("--format")+1] if "--format" in a else ""
    if fmt == "{{.Id}}":
        sys.stdout.write(os.environ.get("FAKE_IMAGE_ID", os.environ["TEST_PG_ID"]))
    elif "RepoDigests" in fmt:
        sys.stdout.write(os.environ.get("FAKE_REPODIGESTS", "postgres@"+os.environ["TEST_PG_DIGEST"]))
    raise SystemExit(0)
if a and a[0] == "ps":
    sys.stdout.write(os.environ.get("FAKE_CID","cid-postgres"))
    raise SystemExit(0)
if a and a[0] == "inspect":
    fmt=a[a.index("--format")+1] if "--format" in a else ""
    if ".State.Health" in fmt:
        sys.stdout.write(os.environ.get("FAKE_HEALTH","healthy"))
    elif fmt == "{{.Image}}":
        sys.stdout.write(os.environ.get("FAKE_CONTAINER_IMAGE", os.environ.get("FAKE_IMAGE_ID", os.environ["TEST_PG_ID"])))
    elif ".Mounts" in fmt:
        mounts=[{"Type":"bind","Source":os.environ["TEST_PGDATA"],"Destination":"/var/lib/postgresql/data","RW":True}]
        sys.stdout.write(os.environ.get("FAKE_MOUNTS_JSON", json.dumps(mounts)))
    else:
        sys.stdout.write("{}")
    raise SystemExit(0)
if a and a[0] == "port":
    sys.stdout.write(os.environ.get("FAKE_PORTS",""))
    raise SystemExit(0)
if a and a[0] == "exec":
    rest=a[2:]
    if rest == ["id","-u","postgres"]:
        sys.stdout.write(os.environ["TEST_PG_UID"]); raise SystemExit(0)
    if rest == ["id","-g","postgres"]:
        sys.stdout.write(os.environ["TEST_PG_GID"]); raise SystemExit(0)
    if rest and rest[0] == "psql":
        sql=rest[-1]
        if "pg_namespace" in sql:
            sys.stdout.write(os.environ.get("FAKE_SCHEMA_COUNT","0")+"\n")
        elif "pg_roles" in sql:
            sys.stdout.write(os.environ.get("FAKE_ROLE_COUNT","0")+"\n")
        else:
            raise SystemExit(71)
        raise SystemExit(0)
raise SystemExit(72)
'''

HOST_HELPER = r'''#!/usr/bin/env python3
import os, subprocess, sys
a=sys.argv[1:]
if a and a[0] == "find" and os.environ.get("FAKE_PRIV_FIND") == "1":
    sys.stdout.write(a[1]+"/PG_VERSION\n")
    raise SystemExit(0)
raise SystemExit(subprocess.run(a).returncode)
'''


class Env:
    def __init__(self, meili="5115734"):
        self.td = tempfile.TemporaryDirectory()
        self.base = pathlib.Path(self.td.name)
        self.root = self.base / "repo"
        self.root.mkdir()
        self.p = self.root / "progress"
        self.p.mkdir()

        subprocess.check_call(["git", "init", "-b", "main"], cwd=self.root, stdout=subprocess.DEVNULL)
        subprocess.check_call(["git", "-C", str(self.root), "config", "user.email", "t@t"], stdout=subprocess.DEVNULL)
        subprocess.check_call(["git", "-C", str(self.root), "config", "user.name", "t"], stdout=subprocess.DEVNULL)
        (self.root / "x").write_text("1")
        subprocess.check_call(["git", "-C", str(self.root), "add", "-A"], stdout=subprocess.DEVNULL)
        subprocess.check_call(["git", "-C", str(self.root), "commit", "-m", "one"], stdout=subprocess.DEVNULL)
        self.head = subprocess.check_output(["git", "-C", str(self.root), "rev-parse", "HEAD"], text=True).strip()

        self.man = self.p / "s32-release-manifest.json"
        self.man.write_text(json.dumps(manifest()))
        self.man.chmod(0o600)
        out = subprocess.check_output([sys.executable, str(MAN_TOOL), str(self.man)], text=True)
        self.fp = [x.split("=", 1)[1] for x in out.splitlines() if x.startswith("S32_RELEASE_FINGERPRINT=")][0]

        self.r0 = self.p / "s32-r0.env"
        self.r0.write_text(
            "STATUS=PASS\nR0_FINAL=PASS\n"
            "WEB_CID=w1\nWEB_STARTED_AT=t1\nWEB_IMAGE_ID=i1\n"
            "API_CID=a1\nAPI_STARTED_AT=t2\nAPI_IMAGE_ID=i2\n"
            "MEILISEARCH_CID=m1\nMEILISEARCH_STARTED_AT=t3\nMEILISEARCH_IMAGE_ID=i3\n"
            f"MEILI_DOCUMENTS={meili}\n"
        )
        self.r0.chmod(0o600)

        self.r1 = self.p / "s32-r1.env"
        self.r1.write_text(
            "STATUS=PASS\nCAPACITY_GATE=PASS_PREFERRED\n"
            f"S32_RELEASE_FINGERPRINT={self.fp}\nRELEASE_SOURCE_SHA={SRC}\n"
        )
        self.r1.chmod(0o600)

        self.pgenv = self.base / "postgres.env"
        self.pgenv.write_text(
            "S32_POSTGRES_DB=book_id_search_s32\n"
            "S32_POSTGRES_USER=s32_admin\n"
            "S32_POSTGRES_PASSWORD=x\n"
            "S32_APP_PASSWORD=y\n"
        )
        self.pgenv.chmod(0o600)

        self.pgdata = self.base / "pgdata"
        self.pgdata.mkdir()
        (self.pgdata / "PG_VERSION").write_text("16\n")
        self.pgdata.chmod(0o700)

        self.baseline = self.base / "baseline.json"
        self.baseline.write_text(json.dumps({
            "httpStatus": 200,
            "stats": {"numberOfDocuments": int(meili)},
            "services": {
                "web": {"cid": "w1", "startedAt": "t1", "imageId": "i1"},
                "api": {"cid": "a1", "startedAt": "t2", "imageId": "i2"},
                "meilisearch": {"cid": "m1", "startedAt": "t3", "imageId": "i3"},
            },
        }))

        self.docker = self.base / "fake-docker.py"
        self.docker.write_text(FAKE_DOCKER)
        self.docker.chmod(0o755)
        self.host = self.base / "host-read.py"
        self.host.write_text(HOST_HELPER)
        self.host.chmod(0o755)

    def close(self):
        self.td.cleanup()

    def make_start(self, fp=None, src=SRC, ctrl=None):
        f = self.p / f"s32-rollout-{fp or self.fp}-R2.start.env"
        f.write_text(
            "STATUS=STARTED\nSTAGE=R2\n"
            f"S32_RELEASE_FINGERPRINT={fp or self.fp}\n"
            f"RELEASE_SOURCE_SHA={src}\nCONTROL_PLANE_SHA={ctrl or self.head}\n"
        )
        f.chmod(0o600)
        return f

    def make_claim(self, ctrl=None):
        f = self.p / f"s32-rollout-authorization-{self.fp}-R2_R3-claim.env"
        f.write_text(
            "AUTHORIZATION_VERSION=1\nAUTHORIZED_ACTION=S32_PRODUCTION_ROLLOUT\n"
            "STAGE_GROUP=R2_R3\n"
            f"S32_RELEASE_FINGERPRINT={self.fp}\nRELEASE_SOURCE_SHA={SRC}\n"
            f"CONTROL_PLANE_SHA={ctrl or self.head}\n"
            "EXPLICIT_APPROVAL=true\nCONSUMABLE_ONCE=true\n"
            "CAPACITY_HARD_ONLY_ACCEPTED=false\nPRODUCTION_WRITE_EXECUTED=false\n"
        )
        f.chmod(0o600)
        return f

    def setup_ok(self):
        self.make_start()
        self.make_claim()
        return self

    def env(self, baseline=None, extra=None):
        e = os.environ.copy()
        e.update(
            BOOK_ID_SEARCH_REPO_ROOT=str(self.root),
            S32_POSTGRES_ENV_PATH=str(self.pgenv),
            S32_RECOVERY_BASELINE_JSON=str(baseline or self.baseline),
            S32_PGDATA_PATH=str(self.pgdata),
            S32_RECOVERY_DOCKER=str(self.docker),
            S32_RECOVERY_HOST_HELPER=str(self.host),
            TEST_PG_ID=PG_ID,
            TEST_PG_DIGEST=PG_DIGEST,
            TEST_PGDATA=str(self.pgdata),
            TEST_PG_UID=str(os.getuid()),
            TEST_PG_GID=str(os.getgid()),
        )
        if extra:
            e.update(extra)
        return e

    def run(self, baseline=None, extra=None, fp=None, src=SRC, ctrl=None):
        return sh(
            ["bash", str(SCRIPT), "--recover-r2-verify-only",
             fp or self.fp, src, ctrl or self.head, TOOL],
            self.base,
            self.env(baseline, extra),
        )


class T(unittest.TestCase):
    def e(self, meili="5115734"):
        x = Env(meili)
        self.addCleanup(x.close)
        return x

    def test_case_A_normal_r2_compose_root_cause_is_dynamic(self):
        r = sh(
            [sys.executable, str(EXEC_TEST),
             "T.test_compose_interpolation_vars_reach_both_up_and_ps_dynamically"],
            REPO,
        )
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

    def test_case_B_success_and_receipt_provenance(self):
        e = self.e("42").setup_ok()
        r = e.run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        res = e.p / f"s32-rollout-{e.fp}-R2.result.env"
        self.assertEqual(res.stat().st_mode & 0o777, 0o600)
        body = res.read_text()
        for field in (
            "STATUS=PASS",
            "R2_POSTGRES=PASS",
            "R2_RECOVERY_MODE=VERIFY_ONLY",
            "MEILI_DOCUMENTS=42",
            "PG_MANIFEST_DIGEST=" + PG_DIGEST,
            "PG_IMAGE_ID=" + PG_ID,
            "RECOVERY_TOOL_SHA=" + TOOL,
        ):
            self.assertIn(field, body)
        start = e.p / f"s32-rollout-{e.fp}-R2.start.env"
        self.assertIn("R2_START_SHA256=" + hashlib.sha256(start.read_bytes()).hexdigest(), body)

    def test_case_C_terminal_or_r3_artifact_blocks(self):
        e = self.e().setup_ok()
        res = e.p / f"s32-rollout-{e.fp}-R2.result.env"
        res.write_text("x"); res.chmod(0o600)
        r = e.run(); self.assertNotEqual(r.returncode, 0)
        self.assertIn("R2_ALREADY_TERMINAL", r.stdout + r.stderr)

        e2 = self.e().setup_ok()
        f = e2.p / f"s32-rollout-{e2.fp}-R3.start.env"
        f.write_text("x"); f.chmod(0o600)
        r = e2.run(); self.assertNotEqual(r.returncode, 0)
        self.assertIn("R3_ARTIFACT_PRESENT", r.stdout + r.stderr)

    def test_case_D_start_identity_and_head_blocks(self):
        e = self.e(); e.make_claim()
        r = e.run(); self.assertIn("R2_RECOVERY_START_MISSING", r.stdout + r.stderr)
        e2 = self.e().setup_ok()
        r = e2.run(ctrl="7" * 40); self.assertIn("PRODUCTION_HEAD_MISMATCH", r.stdout + r.stderr)
        e3 = self.e(); e3.make_claim(); e3.make_start(fp="0" * 64)
        r = e3.run(); self.assertIn("R2_RECOVERY_START_MISSING", r.stdout + r.stderr)

    def test_case_E_backend_compatible_image_ids_and_repodigest(self):
        e = self.e().setup_ok()
        r = e.run(extra={"FAKE_IMAGE_ID": PG_DIGEST, "FAKE_CONTAINER_IMAGE": PG_DIGEST})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

        e2 = self.e().setup_ok()
        r = e2.run(extra={"FAKE_IMAGE_ID": "sha256:" + "1" * 64})
        self.assertIn("PG_IMAGE_ID_MISMATCH", r.stdout + r.stderr)

        e3 = self.e().setup_ok()
        r = e3.run(extra={"FAKE_REPODIGESTS": "postgres@sha256:" + "0" * 64})
        self.assertIn("PG_IMAGE_REPODIGEST_MISMATCH", r.stdout + r.stderr)

    def test_case_F_health_port_and_container_image_block(self):
        for extra, reason in [
            ({"FAKE_HEALTH": "starting"}, "POSTGRES_NOT_HEALTHY"),
            ({"FAKE_PORTS": "5432/tcp -> 0.0.0.0:5432"}, "POSTGRES_PUBLIC_PORT_PRESENT"),
            ({"FAKE_CONTAINER_IMAGE": "sha256:" + "1" * 64}, "POSTGRES_IMAGE_BINDING_MISMATCH"),
        ]:
            e = self.e().setup_ok()
            r = e.run(extra=extra)
            self.assertIn(reason, r.stdout + r.stderr)
            self.assertFalse((e.p / f"s32-rollout-{e.fp}-R2.result.env").exists())

    def test_case_G_r1_identity_and_postgres_env_contract_block(self):
        e = self.e().setup_ok()
        e.r1.write_text(
            "STATUS=PASS\nCAPACITY_GATE=PASS_PREFERRED\n"
            f"S32_RELEASE_FINGERPRINT={'f'*64}\nRELEASE_SOURCE_SHA={SRC}\n"
        ); e.r1.chmod(0o600)
        r = e.run(); self.assertIn("R1_RELEASE_IDENTITY_MISMATCH", r.stdout + r.stderr)

        e2 = self.e().setup_ok()
        e2.pgenv.write_text(
            "S32_POSTGRES_DB=wrong\nS32_POSTGRES_USER=s32_admin\n"
            "S32_POSTGRES_PASSWORD=x\nS32_APP_PASSWORD=y\n"
        ); e2.pgenv.chmod(0o600)
        r = e2.run(); self.assertIn("POSTGRES_ENV_CONTRACT_INVALID", r.stdout + r.stderr)

        e3 = self.e().setup_ok()
        e3.pgenv.write_text(e3.pgenv.read_text() + "S32_POSTGRES_USER=s32_admin\n")
        e3.pgenv.chmod(0o600)
        r = e3.run(); self.assertIn("POSTGRES_ENV_CONTRACT_INVALID", r.stdout + r.stderr)

    def test_case_H_pgdata_privileged_probe_owner_and_mount(self):
        e = self.e().setup_ok()
        e.pgdata.chmod(0o000)
        r = e.run(extra={"FAKE_PRIV_FIND": "1"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)

        e2 = self.e().setup_ok()
        r = e2.run(extra={"TEST_PG_UID": str(os.getuid() + 1)})
        self.assertIn("PGDATA_OWNER_MISMATCH", r.stdout + r.stderr)

        e3 = self.e().setup_ok()
        bad = json.dumps([{
            "Type": "volume", "Source": str(e3.pgdata),
            "Destination": "/var/lib/postgresql/data", "RW": True,
        }])
        r = e3.run(extra={"FAKE_MOUNTS_JSON": bad})
        self.assertIn("POSTGRES_PGDATA_BIND_MISMATCH", r.stdout + r.stderr)

    def test_case_I_runtime_and_meili_drift_block(self):
        e = self.e().setup_ok()
        d = json.loads(e.baseline.read_text()); d["services"]["web"]["cid"] = "changed"
        p = e.base / "drift.json"; p.write_text(json.dumps(d))
        r = e.run(baseline=p); self.assertIn("LEGACY_RUNTIME_DRIFT", r.stdout + r.stderr)

        e2 = self.e("42").setup_ok()
        d = json.loads(e2.baseline.read_text()); d["stats"]["numberOfDocuments"] = 43
        p = e2.base / "meili.json"; p.write_text(json.dumps(d))
        r = e2.run(baseline=p); self.assertIn("LEGACY_RUNTIME_DRIFT", r.stdout + r.stderr)

    def test_case_J_schema_or_role_present_blocks(self):
        e = self.e().setup_ok()
        r = e.run(extra={"FAKE_SCHEMA_COUNT": "1"})
        self.assertIn("S32_SCHEMA_NAMESPACE_PRESENT", r.stdout + r.stderr)
        e2 = self.e().setup_ok()
        r = e2.run(extra={"FAKE_ROLE_COUNT": "1"})
        self.assertIn("S32_APP_ROLE_PRESENT", r.stdout + r.stderr)

    def test_case_K_receipt_is_consumable_by_planner(self):
        e = self.e().setup_ok()
        r = e.run(); self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        pr = sh(
            [sys.executable, str(PLANNER), "--state-dir", str(e.p),
             "--release-fingerprint", e.fp, "--release-source-sha", SRC],
            e.base,
        )
        self.assertEqual(pr.returncode, 0, pr.stdout + pr.stderr)
        self.assertIn("STATUS=READY_FOR_R3", pr.stdout)
        self.assertIn("NEXT_STAGE=R3", pr.stdout)

    def test_case_L_planner_is_incomplete_before_recovery(self):
        e = self.e().setup_ok()
        pr = sh(
            [sys.executable, str(PLANNER), "--state-dir", str(e.p),
             "--release-fingerprint", e.fp, "--release-source-sha", SRC],
            e.base,
        )
        self.assertIn("STATUS=INCOMPLETE", pr.stdout)
        self.assertIn("INCOMPLETE_R2", pr.stdout)

    def test_case_M_static_verify_only_audit(self):
        text = SCRIPT.read_text()
        for bad in (
            "docker compose up", "compose down", "docker compose restart",
            "docker restart", "docker run", "docker pull", "docker load",
            "docker build", "docker rm", 'mkdir -p "$PGDATA"',
            'chmod 700 "$PGDATA"', "chown ",
        ):
            self.assertNotIn(bad, text, bad)
        for needed in (
            "R2_RECOVERY_MODE=VERIFY_ONLY", "R2_START_SHA256",
            "RECOVERY_TOOL_SHA", "POSTGRES_PGDATA_BIND_MISMATCH",
            "PGDATA_OWNER_MISMATCH",
        ):
            self.assertIn(needed, text)


if __name__ == "__main__":
    unittest.main()
