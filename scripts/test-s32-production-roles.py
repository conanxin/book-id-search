#!/usr/bin/env python3
import pathlib,re,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
SQL=ROOT/'deploy/s32-production-roles.sql'
class T(unittest.TestCase):
 def setUp(self): self.text=SQL.read_text() if SQL.exists() else ''
 def test_creates_separate_nonprivileged_app_role(self):
  self.assertIn('CREATE ROLE :"app_role" LOGIN PASSWORD :\'app_password\'',self.text)
  for flag in ('NOSUPERUSER','NOCREATEDB','NOCREATEROLE','NOREPLICATION'): self.assertIn(flag,self.text)
 def test_hardens_public_and_grants_only_runtime_access(self):
  self.assertIn('REVOKE CREATE ON SCHEMA public FROM PUBLIC;',self.text)
  self.assertIn('GRANT USAGE ON SCHEMA core, ops, derived TO :"app_role";',self.text)
  self.assertIn('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, ops TO :"app_role";',self.text)
  self.assertIn('REVOKE CREATE ON SCHEMA core, ops, derived FROM :"app_role";',self.text)
 def test_contains_no_embedded_secret(self):
  self.assertNotRegex(self.text,r"PASSWORD\s+'[^:][^']*'")
  self.assertNotIn('S32_APP_PASSWORD',self.text)
if __name__=='__main__': unittest.main()
