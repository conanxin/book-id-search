#!/usr/bin/env python3
"""Credential-free local build in an already-trusted development process.

The output is the only supported recovery entrypoint. Keep the output outside
the reviewed checkout and verify its printed hash at the authorization gate.
"""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

os.umask(0o077)
ROOT = Path(__file__).resolve().parent


def build(out):
    if os.environ.get('S32_R7_BROWSER_TOKEN') or os.environ.get('S32_PRIVATE_API_TOKEN'):
        raise RuntimeError('BUILD_REQUIRES_CREDENTIAL_FREE_ENVIRONMENT')
    if out.exists() or out.is_symlink():
        raise RuntimeError('OUTPUT_ALREADY_EXISTS')
    # Building requires a trusted compiler/parent process; this is deliberately
    # separate from, and completed before, any real one-shot recovery attempt.
    with tempfile.TemporaryDirectory(prefix='.s32-static-build-', dir=out.parent) as tmp:
        binary = Path(tmp) / 'launcher'
        subprocess.run(['/usr/bin/cc', '-static', '-no-pie', '-O2', '-Wall', '-Wextra', '-Werror',
                        '-DRECOVERY_SCRIPT=' + json.dumps(str(ROOT / 'recover-s32-r7-browser-acceptance.sh')),
                        str(ROOT / 's32-r7-recovery-launcher.c'), '-o', str(binary)], check=True)
        program = subprocess.check_output(['/usr/bin/readelf', '-lW', str(binary)], text=True)
        dynamic = subprocess.check_output(['/usr/bin/readelf', '-dW', str(binary)], text=True)
        if binary.read_bytes()[:4] != b'\x7fELF' or 'INTERP' in program or 'NEEDED' in dynamic:
            raise RuntimeError('STATIC_LAUNCHER_REQUIRED')
        binary.chmod(0o700)
        os.link(binary, out)  # exclusive publication, never replace an existing binary
    print('STATUS=PASS\nSTATIC_ELF=PASS\nLAUNCHER_SHA256=' + hashlib.sha256(out.read_bytes()).hexdigest())


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
