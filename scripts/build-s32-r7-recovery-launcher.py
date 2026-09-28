#!/usr/bin/env python3
"""Credential-free local build in an already-trusted development process.

The output is the only supported recovery entrypoint. Keep the output outside
the reviewed checkout and verify its printed hash at the authorization gate.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

os.umask(0o077)
ROOT = Path(__file__).resolve().parent


def git(*args):
    env = {k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null')
    return subprocess.check_output(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false',
                                    '-C', str(ROOT.parent), *args], env=env)


def capsule(head):
    producer = git('show', head + ':scripts/s32-r7-browser-receipt-producer.cjs').decode()
    helper = git('show', head + ':scripts/s32-r7-browser-recovery.cjs').decode()
    root = json.dumps(str(ROOT.parent))
    # Compile only committed, embedded modules. Restrict their imports to Node
    # builtins plus the embedded helper; never resolve a mutable checkout module.
    return f'''"use strict";
const Module=require('module');
const root={root};
const helperPath=root+'/scripts/s32-r7-browser-recovery.cjs';
const producerPath=root+'/scripts/s32-r7-browser-receipt-producer.cjs';
const builtins=(name)=>{{if(!Module.isBuiltin(name))throw new Error('CAPSULE_IMPORT_REJECTED');return require(name);}};
const helper=new Module(helperPath);helper.filename=helperPath;helper.paths=[];helper.require=builtins;
helper._compile({json.dumps(helper)},helperPath);
const producer=new Module(producerPath);producer.filename=producerPath;producer.paths=[];
producer.require=(name)=>name==='./s32-r7-browser-recovery.cjs'?helper.exports:builtins(name);
Object.defineProperty(globalThis,Symbol.for('s32.r7.recovery.capsule'),{{value:Object.freeze({{toolSha:{json.dumps(head)}}})}});
process.argv.splice(1,0,producerPath);
producer._compile({json.dumps(producer)},producerPath);
'''


def build(out):
    if os.environ.get('S32_R7_BROWSER_TOKEN') or os.environ.get('S32_PRIVATE_API_TOKEN'):
        raise RuntimeError('BUILD_REQUIRES_CREDENTIAL_FREE_ENVIRONMENT')
    if out.exists() or out.is_symlink():
        raise RuntimeError('OUTPUT_ALREADY_EXISTS')
    if git('status', '--porcelain', '--untracked-files=normal').strip():
        raise RuntimeError('BUILD_REQUIRES_CLEAN_CHECKOUT')
    head = git('rev-parse', 'HEAD').decode().strip()
    bootstrap = capsule(head)
    if len(bootstrap.encode()) > 100000:
        raise RuntimeError('CAPSULE_ARG_SIZE_LIMIT')
    node = shutil.which('node')
    if not node or not Path(node).is_absolute():
        raise RuntimeError('TRUSTED_NODE_REQUIRED')
    # Building requires a trusted compiler/parent process; this is deliberately
    # separate from, and completed before, any real one-shot recovery attempt.
    with tempfile.TemporaryDirectory(prefix='.s32-static-build-', dir=out.parent) as tmp:
        binary = Path(tmp) / 'launcher'
        source = Path(tmp) / 'launcher.c'
        source.write_bytes(git('show', head + ':scripts/s32-r7-recovery-launcher.c'))
        (Path(tmp) / 'recovery-payload.h').write_text(
            '#define RECOVERY_TOOL_SHA ' + json.dumps(head) + '\n'
            '#define RECOVERY_NODE ' + json.dumps(node) + '\n'
            '#define RECOVERY_BOOTSTRAP ' + json.dumps(bootstrap) + '\n')
        subprocess.run(['/usr/bin/cc', '-static', '-no-pie', '-O2', '-Wall', '-Wextra', '-Werror',
                        str(source), '-o', str(binary)], check=True)
        program = subprocess.check_output(['/usr/bin/readelf', '-lW', str(binary)], text=True)
        dynamic = subprocess.check_output(['/usr/bin/readelf', '-dW', str(binary)], text=True)
        if binary.read_bytes()[:4] != b'\x7fELF' or 'INTERP' in program or 'NEEDED' in dynamic:
            raise RuntimeError('STATIC_LAUNCHER_REQUIRED')
        if git('rev-parse', 'HEAD').decode().strip() != head or git('status', '--porcelain').strip():
            raise RuntimeError('BUILD_CHECKOUT_CHANGED')
        binary.chmod(0o700)
        os.link(binary, out)  # exclusive publication, never replace an existing binary
    print('STATUS=PASS\nSTATIC_ELF=PASS\nEMBEDDED_TOOL_SHA=' + head +
          '\nLAUNCHER_SHA256=' + hashlib.sha256(out.read_bytes()).hexdigest())


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise RuntimeError('USAGE_EXPECTS_FRESH_ABSOLUTE_OUTPUT_PATH')
        output = Path(sys.argv[1])
        if not output.is_absolute():
            raise RuntimeError('ABSOLUTE_OUTPUT_REQUIRED')
        build(output)
    except Exception as error:
        print('STATUS=FAIL\nREASON=' + type(error).__name__)
        sys.exit(1)
