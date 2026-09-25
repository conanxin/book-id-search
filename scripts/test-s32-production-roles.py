#!/usr/bin/env python3
import pathlib
import subprocess
import time
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[1]
SQL = ROOT / "deploy/s32-production-roles.sql"
IMAGE = "postgres:16-alpine"

class StaticRoleTests(unittest.TestCase):
    def setUp(self):
        self.text = SQL.read_text() if SQL.exists() else ""

    def test_role_bootstrap_is_one_atomic_transaction(self):
        statements = [line.strip().upper() for line in self.text.splitlines() if line.strip() and not line.strip().startswith("--") and not line.strip().startswith("\\")]
        self.assertTrue(statements, "role bootstrap SQL missing")
        self.assertEqual(statements[0], "BEGIN;")
        self.assertEqual(statements[-1], "COMMIT;")

    def test_creates_separate_nonprivileged_app_role(self):
        self.assertIn('CREATE ROLE :"app_role" LOGIN PASSWORD :\'app_password\'', self.text)
        for flag in ("NOSUPERUSER", "NOCREATEDB", "NOCREATEROLE", "NOREPLICATION"):
            self.assertIn(flag, self.text)

    def test_hardens_public_and_grants_only_runtime_access(self):
        self.assertIn("REVOKE CREATE ON SCHEMA public FROM PUBLIC;", self.text)
        self.assertIn('GRANT USAGE ON SCHEMA core, ops, derived TO :"app_role";', self.text)
        self.assertIn('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, ops TO :"app_role";', self.text)
        self.assertIn('REVOKE CREATE ON SCHEMA core, ops, derived FROM :"app_role";', self.text)

    def test_contains_no_embedded_secret(self):
        self.assertNotIn("S32_APP_PASSWORD", self.text)

class RealPostgresRoleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.name = "s32-role-test-" + uuid.uuid4().hex[:10]
        subprocess.run([
            "docker", "run", "-d", "--rm", "--name", cls.name,
            "-e", "POSTGRES_USER=s32_admin",
            "-e", "POSTGRES_PASSWORD=admin-test-password",
            "-e", "POSTGRES_DB=book_id_search_s32",
            IMAGE,
        ], check=True, stdout=subprocess.DEVNULL)
        deadline = time.time() + 30
        while time.time() < deadline:
            p = subprocess.run([
                "docker", "exec", cls.name, "pg_isready",
                "-U", "s32_admin", "-d", "book_id_search_s32",
            ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if p.returncode == 0:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("postgres did not become ready")
        cls.psql_admin("CREATE SCHEMA core; CREATE SCHEMA ops; CREATE SCHEMA derived; CREATE TABLE core.runtime_probe(id integer);")

    @classmethod
    def tearDownClass(cls):
        subprocess.run(["docker", "rm", "-f", cls.name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    @classmethod
    def psql_admin(cls, sql, check=True):
        return subprocess.run([
            "docker", "exec", "-i", cls.name,
            "psql", "-X", "-v", "ON_ERROR_STOP=1",
            "-U", "s32_admin", "-d", "book_id_search_s32", "-Atc", sql,
        ], text=True, capture_output=True, check=check)

    @classmethod
    def apply_role_sql(cls, role, password, text=None, check=True):
        body = (
            f"\\set db_name book_id_search_s32\n"
            f"\\set app_role {role}\n"
            f"\\set app_password {password}\n"
            + (text if text is not None else SQL.read_text())
        )
        return subprocess.run([
            "docker", "exec", "-i", cls.name,
            "psql", "-X", "-v", "ON_ERROR_STOP=1",
            "-U", "s32_admin", "-d", "book_id_search_s32", "-f", "-",
        ], input=body, text=True, capture_output=True, check=check)

    def test_real_pg_app_role_is_nonprivileged_but_can_do_runtime_dml(self):
        self.apply_role_sql("s32_app", "app-test-password")
        flags = self.psql_admin(
            "SELECT rolsuper::int||','||rolcreaterole::int||','||rolcreatedb::int||','||rolreplication::int FROM pg_roles WHERE rolname='s32_app'"
        ).stdout.strip()
        self.assertEqual(flags, "0,0,0,0")

        ddl = subprocess.run([
            "docker", "exec", "-e", "PGPASSWORD=app-test-password", self.name,
            "psql", "-X", "-h", "127.0.0.1", "-U", "s32_app", "-d", "book_id_search_s32",
            "-c", "CREATE TABLE core.forbidden(id integer)",
        ], text=True, capture_output=True)
        self.assertNotEqual(ddl.returncode, 0)
        self.assertIn("permission denied", (ddl.stdout + ddl.stderr).lower())

        dml = subprocess.run([
            "docker", "exec", "-e", "PGPASSWORD=app-test-password", self.name,
            "psql", "-X", "-h", "127.0.0.1", "-U", "s32_app", "-d", "book_id_search_s32",
            "-c", "INSERT INTO core.runtime_probe(id) VALUES (1)",
        ], text=True, capture_output=True)
        self.assertEqual(dml.returncode, 0, dml.stdout + dml.stderr)

    def test_failure_after_create_role_rolls_back_role_catalog_change(self):
        broken = SQL.read_text().replace(
            'GRANT CONNECT ON DATABASE :"db_name" TO :"app_role";',
            'SELECT 1/0;\nGRANT CONNECT ON DATABASE :"db_name" TO :"app_role";',
        )
        result = self.apply_role_sql("s32_fail", "fail-test-password", broken, check=False)
        self.assertNotEqual(result.returncode, 0)
        exists = self.psql_admin("SELECT count(*) FROM pg_roles WHERE rolname='s32_fail'").stdout.strip()
        self.assertEqual(exists, "0")


if __name__ == "__main__":
    unittest.main()
