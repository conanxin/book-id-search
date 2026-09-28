#!/usr/bin/env python3
"""Recovery contract tests use disposable local receipts/pages, never production."""
import hashlib
import importlib.util
import os
from pathlib import Path
import socket
import shutil
import sys
sys.dont_write_bytecode = True
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CONTRACT = HERE / 's32-r7-browser-recovery.cjs'
PRODUCER = HERE / 's32-r7-browser-receipt-producer.cjs'
PID = '11111111-1111-4111-8111-111111111111'

def load(name, file):
    spec = importlib.util.spec_from_file_location(name, file)
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
    return mod

executor = load('executor_fixtures', HERE / 'test-execute-s32-r7-acceptance.py')
browser = load('browser_fixtures', HERE / 'test-s32-r7-browser-receipt-producer.py')

def digest(p): return hashlib.sha256(p.read_bytes()).hexdigest()
def write(p, body): p.write_text(body); p.chmod(0o600)
def body(fields): return ''.join(f'{k}={v}\n' for k,v in fields.items())

class RecoveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.launcher_dir = tempfile.TemporaryDirectory(prefix='s32-static-test-')
        cls.addClassCleanup(cls.launcher_dir.cleanup)
        cls.launcher = Path(cls.launcher_dir.name) / 'recover-browser'
        env = dict(os.environ)
        env.pop('S32_R7_BROWSER_TOKEN', None); env.pop('S32_PRIVATE_API_TOKEN', None)
        subprocess.run([sys.executable, str(HERE / 'build-s32-r7-recovery-launcher.py'), str(cls.launcher)],
                       env=env, check=True, capture_output=True, text=True)

    def setUp(self):
        self.x = executor.Env(); self.addCleanup(self.x.close)
        self.state = self.x.root / 'progress'; self.state.chmod(0o700)
        self.head = subprocess.check_output(['git','rev-parse','HEAD'], cwd=ROOT, text=True).strip()
        self.start = self.state / f's32-rollout-{self.x.fp}-R7.start.env'
        self.api = self.state / f's32-rollout-{self.x.fp}-R7.api.env'
        self.web = self.state / f's32-rollout-{self.x.fp}-R7.web.env'
        self.result = self.state / f's32-rollout-{self.x.fp}-R7.result.env'
        self.incident = self.state / 'R7.browser-incident.env'
        self.auth = self.state / 'R7.browser-recovery.authorization.env'
        self.claim = self.state / 'R7.browser-recovery.claim.env'
        self.out = self.x.root / 'local-recovery.web.env'
        write(self.start, body(dict(STATUS='STARTED',STAGE='R7',S32_RELEASE_FINGERPRINT=self.x.fp,
              RELEASE_SOURCE_SHA=executor.SRC,CONTROL_PLANE_SHA=executor.CTRL)))
        write(self.api, self.x.acceptance.read_text() + body(dict(STAGE='R7_API',R7_API_ACCEPTANCE='PASS',
              S32_RELEASE_FINGERPRINT=self.x.fp,RELEASE_SOURCE_SHA=executor.SRC,IDEMPOTENCY_RECEIPT_DB_PROOF='PASS')))
        self.fields = dict(R7_STATE='INCOMPLETE',S32_RELEASE_FINGERPRINT=self.x.fp,
              RELEASE_SOURCE_SHA=executor.SRC,CONTROL_PLANE_SHA=executor.CTRL,PROJECT_ID=PID,
              R7_BEGIN_INVOCATIONS='1',R7_API_INVOCATIONS='1',R7_BROWSER_INVOCATIONS='1',
              FAILED_BROWSER_REASON='DEVTOOLS_ENDPOINT_TIMEOUT',SEMANTIC_WEB_ACCEPTANCE='NOT_REACHED',
              R7_START_SHA256=digest(self.start),R7_API_SHA256=digest(self.api))
        self.write_incident()
        self.before = {self.start:digest(self.start),self.api:digest(self.api)}

    def write_incident(self): write(self.incident,body(self.fields))
    def authorize_fixture(self):
        write(self.auth, body(dict(AUTHORIZED_ACTION='S32_R7_BROWSER_STARTUP_RECOVERY',
              EXPLICIT_APPROVAL='true',CONSUMABLE_ONCE='true',RECOVERY_TOOL_SHA=self.head,
              INCIDENT_SHA256=digest(self.incident),RECOVERY_BROWSER_INVOCATIONS='1')))

    def check(self):
        return subprocess.run(['node',str(CONTRACT),'--check',str(self.state),self.x.fp,PID,executor.CTRL,self.head],
                              capture_output=True,text=True,timeout=10)

    def produce(self, *, mode='recovery-fixture', url=None, **extra):
        env = dict(os.environ, TMPDIR=str(self.x.root), S32_R7_RECOVERY_STATE_DIR=str(self.state),
                   S32_R7_RECOVERY_TOOL_SHA=self.head)
        env.pop('S32_R7_BROWSER_TOKEN',None); env.pop('S32_PRIVATE_API_TOKEN',None)
        if url: env.update(S32_R7_BROWSER_URL=url+'/research/projects',S32_R7_BROWSER_TOKEN='LOCAL_RECOVERY_SENTINEL')
        with socket.socket() as s:
            s.bind(('127.0.0.1',0));env['S32_R7_FIXTURE_PORT']=str(s.getsockname()[1])
        env.update(extra)
        entry=[str(self.launcher),'--local-browser-fixture'] if mode=='recovery-browser' else ['node',str(PRODUCER),mode]
        return subprocess.run([*entry,str(self.out),self.x.fp,PID,executor.CTRL],
                              env=env,capture_output=True,text=True,timeout=120)

    def assert_unchanged(self):
        for p,h in self.before.items(): self.assertEqual(digest(p),h)

    def test_incident_shape_check_is_read_only_and_requires_new_authorization(self):
        r=self.check();self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('RECOVERY_STATE=READY_AUTHORIZATION_REQUIRED',r.stdout)
        self.assertFalse(self.claim.exists());self.assertFalse(self.web.exists());self.assertFalse(self.result.exists())
        self.assert_unchanged()

    def test_absent_start_or_api_and_present_web_or_result_block(self):
        for p in [self.start,self.api,self.web,self.result]:
            with self.subTest(artifact=p.name):
                original=p.read_bytes() if p.exists() else None
                if original is None: write(p,'STATUS=PASS\n')
                else: p.unlink()
                r=self.check();self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
                if original is None:p.unlink()
                else:p.write_bytes(original);p.chmod(0o600)

    def test_unconsumed_normal_invocation_or_changed_start_api_block(self):
        for k in ['R7_BEGIN_INVOCATIONS','R7_API_INVOCATIONS','R7_BROWSER_INVOCATIONS']:
            with self.subTest(k=k):
                self.fields[k]='0';self.write_incident()
                self.assertNotEqual(self.check().returncode,0)
                self.fields[k]='1';self.write_incident()
        for p in [self.start,self.api]:
            with self.subTest(file=p.name):
                original=p.read_bytes();p.write_bytes(original+b'UNREVIEWED=YES\n')
                self.assertNotEqual(self.check().returncode,0)
                p.write_bytes(original)

    def test_symlink_or_unsafe_evidence_fails_closed(self):
        self.start.chmod(0o644);self.assertNotEqual(self.check().returncode,0)
        self.start.chmod(0o600)
        link=self.state/'saved-start';self.start.rename(link);self.start.symlink_to(link)
        self.assertNotEqual(self.check().returncode,0)

    def test_wrong_tool_sha_and_duplicate_incident_fields_block(self):
        write(self.incident,self.incident.read_text()+'R7_STATE=INCOMPLETE\n')
        self.assertNotEqual(self.check().returncode,0)
        self.write_incident()
        r=self.produce(S32_R7_RECOVERY_TOOL_SHA='a'*40)
        self.assertNotEqual(r.returncode,0);self.assertFalse(self.out.exists())

    def test_node_preload_is_rejected_before_it_can_execute(self):
        marker=self.x.root/'preload-executed'
        preload=self.x.root/'unreviewed.cjs'
        preload.write_text(f"require('fs').writeFileSync({str(marker)!r}, 'unreviewed code ran');")
        self.authorize_fixture()
        with browser.production_like_server() as url:
            r=self.produce(mode='recovery-browser',url=url,NODE_OPTIONS=f'--require={preload}')
        self.assertFalse(marker.exists(), 'unreviewed preload executed before provenance check')
        self.assertNotEqual(r.returncode,0)
        self.assertIn('RECOVERY_RUNTIME_INJECTION_REJECTED',r.stdout)
        self.assertFalse(self.claim.exists());self.assertFalse(self.out.exists());self.assert_unchanged()

    def test_static_launcher_blocks_real_loader_constructor_before_shell(self):
        source=self.x.root/'hook.c';library=self.x.root/'hook.so';marker=self.x.root/'loader-ran'
        source.write_text('#include <stdlib.h>\n#include <stdio.h>\n'
            '__attribute__((constructor)) static void hook(void){const char *p=getenv("LOADER_MARKER");'
            'if(p){FILE *f=fopen(p,"w");if(f){fputs("executed",f);fclose(f);}}}\n')
        subprocess.run(['/usr/bin/cc','-shared','-fPIC',str(source),'-o',str(library)],check=True)
        self.authorize_fixture()
        for key in ['LD_PRELOAD','LD_AUDIT']:
            with self.subTest(loader=key):
                r=self.produce(mode='recovery-browser',url='http://127.0.0.1:1',
                               LOADER_MARKER=str(marker),**{key:str(library)})
                self.assertFalse(marker.exists(), 'loader constructor ran before entrypoint guard')
                self.assertNotEqual(r.returncode,0)
                self.assertIn('RECOVERY_RUNTIME_INJECTION_REJECTED',r.stdout)
                self.assertFalse(self.claim.exists());self.assertFalse(self.out.exists())
        self.assert_unchanged()

    def test_supported_launcher_is_static_without_mutable_shell_entry(self):
        program=subprocess.check_output(['/usr/bin/readelf','-lW',str(self.launcher)],text=True)
        dynamic=subprocess.check_output(['/usr/bin/readelf','-dW',str(self.launcher)],text=True)
        self.assertNotIn('INTERP',program);self.assertNotIn('NEEDED',dynamic)
        self.assertFalse((HERE/'recover-s32-r7-browser-acceptance.sh').exists())

    def test_static_builder_requires_fresh_output_and_no_credential(self):
        before=digest(self.launcher)
        builder=[sys.executable,str(HERE/'build-s32-r7-recovery-launcher.py')]
        r=subprocess.run([*builder,str(self.launcher)],capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0);self.assertEqual(digest(self.launcher),before)
        out=self.x.root/'must-not-build'
        r=subprocess.run([*builder,str(out)],env=dict(os.environ,S32_R7_BROWSER_TOKEN='LOCAL_BUILD_SENTINEL'),
                         capture_output=True,text=True)
        self.assertNotEqual(r.returncode,0);self.assertFalse(out.exists())
        self.assertNotIn('LOCAL_BUILD_SENTINEL',r.stdout+r.stderr)

    def test_other_runtime_injection_settings_fail_before_claim(self):
        self.authorize_fixture()
        with browser.production_like_server() as url:
            for key in ['NODE_PATH','NODE_EXTRA_CA_CERTS','NODE_TLS_REJECT_UNAUTHORIZED',
                        'NODE_ICU_DATA','NODE_REPL_EXTERNAL_MODULE','NODE_USE_ENV_PROXY',
                        'LD_PRELOAD','LD_LIBRARY_PATH','LD_AUDIT','DYLD_INSERT_LIBRARIES',
                        'DYLD_LIBRARY_PATH','BASH_ENV','ENV','OPENSSL_CONF','OPENSSL_MODULES']:
                with self.subTest(variable=key):
                    r=self.produce(mode='recovery-browser',url=url,**{key:'/nonexistent-test-injection'})
                    self.assertNotEqual(r.returncode,0)
                    self.assertIn('RECOVERY_RUNTIME_INJECTION_REJECTED',r.stdout)
                    self.assertFalse(self.claim.exists());self.assertFalse(self.out.exists())
        self.assert_unchanged()

    def test_direct_node_recovery_requires_non_node_launcher(self):
        env=dict(os.environ,S32_R7_BROWSER_URL='https://books.conanxin.com/research/projects',
                 S32_R7_BROWSER_TOKEN='LOCAL_RECOVERY_SENTINEL')
        env.pop('S32_R7_RECOVERY_LAUNCHER',None)
        r=subprocess.run(['node',str(PRODUCER),'recovery-browser',str(self.out),self.x.fp,PID,executor.CTRL],
                         env=env,capture_output=True,text=True,timeout=10)
        self.assertNotEqual(r.returncode,0)
        self.assertIn('RECOVERY_LAUNCHER_REQUIRED',r.stdout)
        self.assertFalse(self.claim.exists());self.assertFalse(self.out.exists())

    def test_browser_recovery_requires_separate_authorization_before_spawn(self):
        with browser.production_like_server() as url:
            r=self.produce(mode='recovery-browser',url=url)
        self.assertNotEqual(r.returncode,0)
        self.assertIn('RECOVERY_AUTHORIZATION_REQUIRED',r.stdout)
        self.assertFalse(self.out.exists());self.assertFalse(self.claim.exists());self.assert_unchanged()

    def test_authorization_precedes_chromium_discovery_without_login_shell(self):
        marker=self.x.root/'lookup-shell-ran'
        fakebin=self.x.root/'fake-bin';fakebin.mkdir()
        lookup=fakebin/'sh'
        lookup.write_text(f'#!/bin/sh\nprintf invoked > {marker}\nprintf /bin/true\\n')
        lookup.chmod(0o700)
        env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
        env.update(HOME=str(self.x.root),PATH=str(fakebin)+':/usr/bin:/bin',
                   S32_R7_BROWSER_URL='http://127.0.0.1:1/research/projects',
                   S32_R7_BROWSER_TOKEN='LOCAL_RECOVERY_SENTINEL',
                   S32_R7_RECOVERY_STATE_DIR=str(self.state),S32_R7_RECOVERY_TOOL_SHA=self.head)
        env.pop('S32_R7_CHROMIUM',None)
        r=subprocess.run([str(self.launcher),'--local-browser-fixture',
                          str(self.out),self.x.fp,PID,executor.CTRL],env=env,capture_output=True,text=True,timeout=10)
        self.assertFalse(marker.exists(), 'lookup shell executed before authorization')
        self.assertIn('RECOVERY_AUTHORIZATION_REQUIRED',r.stdout)
        self.assertFalse(self.claim.exists());self.assertFalse(self.out.exists())

    def test_modified_checkout_code_cannot_execute_before_dirty_rejection(self):
        clone=self.x.root/'checkout'
        subprocess.run(['git','clone','--quiet','--shared','--no-checkout',str(ROOT),str(clone)],check=True)
        subprocess.run(['git','-C',str(clone),'checkout','--quiet','--detach',self.head],check=True)
        binary=self.x.root/'bound-launcher'
        subprocess.run([sys.executable,str(clone/'scripts/build-s32-r7-recovery-launcher.py'),str(binary)],
                       check=True,capture_output=True,text=True)
        self.authorize_fixture()
        env=dict(os.environ,S32_R7_BROWSER_URL='http://127.0.0.1:1/research/projects',
                 S32_R7_BROWSER_TOKEN='LOCAL_MUTATION_SENTINEL',S32_R7_RECOVERY_STATE_DIR=str(self.state),
                 S32_R7_RECOVERY_TOOL_SHA=self.head)
        for name in ['s32-r7-browser-receipt-producer.cjs','s32-r7-browser-recovery.cjs']:
            with self.subTest(module=name):
                target=clone/'scripts'/name;original=target.read_text();marker=self.x.root/'unreviewed-ran'
                target.write_text(original.replace('"use strict";',
                    '"use strict";require("fs").writeFileSync('+repr(str(marker))+',"executed");',1))
                try:
                    r=subprocess.run([str(binary),'--local-browser-fixture',str(self.out),self.x.fp,PID,executor.CTRL],
                                     env=env,capture_output=True,text=True,timeout=20)
                    self.assertFalse(marker.exists(),'modified source executed before dirty check')
                    self.assertNotEqual(r.returncode,0)
                    self.assertIn('RECOVERY_TOOL_CHECKOUT_DIRTY',r.stdout)
                    self.assertFalse(self.claim.exists());self.assertFalse(self.out.exists())
                finally: target.write_text(original)
        self.assert_unchanged()

    def test_path_discovery_executes_chromium_without_lookup_shell(self):
        fakebin=self.x.root/'path-bin';fakebin.mkdir()
        shell_marker=self.x.root/'shell-ran';chrome_marker=self.x.root/'chrome-ran'
        for name,marker in [('sh',shell_marker),('chromium',chrome_marker)]:
            file=fakebin/name
            file.write_text(f'#!/bin/sh\nprintf invoked > {marker}\nexit 0\n')
            file.chmod(0o700)
        env=dict(os.environ,HOME=str(self.x.root),PATH=str(fakebin)+':/usr/bin:/bin',S32_R7_CHROMIUM='')
        env.pop('S32_R7_BROWSER_TOKEN',None);env.pop('S32_PRIVATE_API_TOKEN',None)
        with socket.socket() as s:
            s.bind(('127.0.0.1',0));env['S32_R7_FIXTURE_PORT']=str(s.getsockname()[1])
        r=subprocess.run([shutil.which('node'),str(PRODUCER),'fixture',str(self.out),self.x.fp,PID,executor.CTRL],
                         env=env,capture_output=True,text=True,timeout=40)
        self.assertTrue(chrome_marker.exists());self.assertFalse(shell_marker.exists())
        self.assertIn('DEVTOOLS_ENDPOINT_TIMEOUT',r.stdout)
        self.assertFalse(self.out.exists())

    def test_git_repository_overrides_are_rejected_before_claim(self):
        self.authorize_fixture()
        with browser.production_like_server() as url:
            for key in ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE',
                        'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
                        'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_GLOBAL',
                        'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM']:
                with self.subTest(variable=key):
                    r = self.produce(mode='recovery-browser', url=url, **{key: str(self.x.root)})
                    self.assertNotEqual(r.returncode, 0)
                    self.assertIn('RECOVERY_GIT_ENVIRONMENT_REJECTED', r.stdout)
                    self.assertFalse(self.claim.exists()); self.assertFalse(self.out.exists())

    def test_production_entrypoint_rejects_loopback_before_claim(self):
        self.authorize_fixture()
        with browser.production_like_server() as url:
            env = dict(os.environ, S32_R7_BROWSER_URL=url+'/research/projects',
                       S32_R7_BROWSER_TOKEN='LOCAL_RECOVERY_SENTINEL',
                       S32_R7_RECOVERY_STATE_DIR=str(self.state), S32_R7_RECOVERY_TOOL_SHA=self.head)
            r = subprocess.run([str(self.launcher), '--recover-browser', str(self.out),
                                self.x.fp, PID, executor.CTRL], env=env, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('RECOVERY_PRODUCTION_URL_REQUIRED', r.stdout)
        self.assertFalse(self.claim.exists()); self.assertFalse(self.out.exists()); self.assert_unchanged()

    def test_local_browser_fixture_rejects_non_loopback_before_claim(self):
        self.authorize_fixture()
        r=self.produce(mode='recovery-browser',url='https://example.invalid')
        self.assertNotEqual(r.returncode,0)
        self.assertIn('RECOVERY_FIXTURE_LOOPBACK_REQUIRED',r.stdout)
        self.assertFalse(self.claim.exists());self.assertFalse(self.out.exists())

    def test_recovery_fixture_binds_incident_and_tool_provenance(self):
        r=self.produce();self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        self.assertIn('RUNNER_MODE=fixture',r.stdout)
        text=self.out.read_text()
        self.assertIn('R7_BROWSER_RECOVERY=STARTUP_RECOVERY\n',text)
        self.assertIn(f'RECOVERY_TOOL_SHA={self.head}\n',text)
        self.assertIn(f'RUNNER_SOURCE_SHA={executor.CTRL}\n',text)
        self.assertNotIn('LOCAL_RECOVERY_SENTINEL',text)
        self.assertFalse(self.claim.exists());self.assert_unchanged()

    def test_authorized_local_browser_fixture_cannot_record_as_production(self):
        self.authorize_fixture()
        oldfp=browser.FP;browser.FP=self.x.fp
        try:
            with browser.production_like_server() as url:
                r=self.produce(mode='recovery-browser',url=url)
                self.assertEqual(r.returncode,0,r.stdout+r.stderr)
                self.assertTrue(self.claim.exists())
                self.assertEqual(self.claim.stat().st_ino,self.auth.stat().st_ino)
                self.out=self.x.root/'second-recovery.web.env'
                retry=self.produce(mode='recovery-browser',url=url)
                self.assertNotEqual(retry.returncode,0)
                self.assertIn('RECOVERY_ALREADY_RECORDED_OR_CONSUMED',retry.stdout)
                self.out=self.x.root/'local-recovery.web.env'
        finally: browser.FP=oldfp
        self.assert_unchanged()
        self.assertIn('RUNNER_MODE=fixture\n', self.out.read_text())
        recorded=self.x.record_web_external(self.out)
        self.assertNotEqual(recorded.returncode,0)
        self.assertFalse(self.web.exists()); self.assertFalse(self.result.exists())

    def test_failed_recovery_spawn_consumes_local_claim_without_mutating_incident(self):
        self.authorize_fixture()
        fake=self.x.root/'executable-directory';fake.mkdir(mode=0o700)
        with browser.production_like_server() as url:
            r=self.produce(mode='recovery-browser',url=url,S32_R7_CHROMIUM=str(fake))
            self.assertNotEqual(r.returncode,0,r.stdout+r.stderr)
            self.assertIn('CHROMIUM_SPAWN_FAILED:EACCES',r.stdout)
            self.assertTrue(self.claim.exists());self.assertFalse(self.out.exists())
            retry=self.produce(mode='recovery-browser',url=url)
            self.assertNotEqual(retry.returncode,0)
            self.assertIn('RECOVERY_ALREADY_RECORDED_OR_CONSUMED',retry.stdout)
        self.assert_unchanged();self.assertFalse(self.web.exists());self.assertFalse(self.result.exists())

    def test_authorization_cannot_rebind_tool_or_incident_or_allow_multiple_invocations(self):
        self.authorize_fixture();valid=self.auth.read_text()
        cases=[valid.replace(self.head,'a'*40),valid.replace(digest(self.incident),'a'*64),
               valid.replace('RECOVERY_BROWSER_INVOCATIONS=1','RECOVERY_BROWSER_INVOCATIONS=2')]
        with browser.production_like_server() as url:
            for text in cases:
                with self.subTest(authorization=text):
                    write(self.auth,text)
                    r=self.produce(mode='recovery-browser',url=url)
                    self.assertNotEqual(r.returncode,0)
                    self.assertFalse(self.claim.exists());self.assertFalse(self.out.exists())
        self.assert_unchanged()

    def test_original_recorder_rejects_tampered_provenance_and_wrong_ctrl(self):
        # Exercise the unchanged incident recorder with synthetic browser evidence.
        receipt=self.x.write_web_receipt(out=self.out)
        text=receipt.read_text().replace('RUNNER_MODE=fixture','RUNNER_MODE=browser')
        base=''.join(l+'\n' for l in text.splitlines() if not l.startswith('RECEIPT_SHA256='))
        base+=f'R7_BROWSER_RECOVERY=STARTUP_RECOVERY\nRECOVERY_TOOL_SHA={self.head}\n'
        write(receipt,base+'RECEIPT_SHA256='+hashlib.sha256(base.encode()).hexdigest()+'\n')
        valid=receipt.read_text()
        wrong_ctrl_body=base.replace(executor.CTRL,'d'*40)
        wrong_ctrl=wrong_ctrl_body+'RECEIPT_SHA256='+hashlib.sha256(wrong_ctrl_body.encode()).hexdigest()+'\n'
        for change in [valid.replace(self.head,'a'*40),wrong_ctrl]:
            with self.subTest(change=change[-80:]):
                write(receipt,change)
                r=self.x.record_web_external(receipt)
                self.assertNotEqual(r.returncode,0);self.assertFalse(self.web.exists())
        # Deterministic synthetic browser-contract evidence, never a fixture
        # receipt passed off as a real production acceptance result.
        write(receipt,valid)
        recorded=self.x.record_web_external(receipt)
        self.assertEqual(recorded.returncode,0,recorded.stdout+recorded.stderr)
        self.assertEqual(self.web.read_bytes(),receipt.read_bytes())
        write(self.web,valid.replace(self.head,'a'*40))
        tampered=self.x.complete()
        self.assertNotEqual(tampered.returncode,0);self.assertFalse(self.result.exists())
        write(self.web,valid)
        done=self.x.complete();self.assertEqual(done.returncode,0,done.stdout+done.stderr)
        self.assertIn('R7_ACCEPTANCE=PASS',done.stdout);self.assert_unchanged()

if __name__=='__main__': unittest.main()
