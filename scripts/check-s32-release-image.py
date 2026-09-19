#!/usr/bin/env python3
"""Smoke-test a built image without networks, host mounts, ports, or a database."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("image")
parser.add_argument("source_commit")
args = parser.parse_args()

def docker(*arguments):
    return subprocess.check_output(["docker", *arguments], text=True).strip()

info = json.loads(docker("image", "inspect", args.image))[0]
assert info["Config"]["Labels"]["org.opencontainers.image.revision"] == args.source_commit
# Deliberately drift a manifest in a disposable container. The frozen installer
# must reject it, using only the package manager already installed in the image.
drift = subprocess.run(["docker", "run", "--rm", "--network", "none", "--pull", "never",
                        "--entrypoint", "sh", args.image, "-c",
                        "node -e 'const fs=require(\"fs\"); const f=\"apps/api/package.json\"; "
                        "const p=JSON.parse(fs.readFileSync(f)); p.dependencies.pg=\"0.0.0\"; "
                        "fs.writeFileSync(f,JSON.stringify(p));' && pnpm install --offline --frozen-lockfile"],
                       text=True, capture_output=True)
assert drift.returncode != 0 and "ERR_PNPM_OUTDATED_LOCKFILE" in drift.stdout + drift.stderr
print("LOCKFILE_DRIFT_REJECTED=PASS")
cid = None
try:
    cid = docker("run", "-d", "--network", "none", "--pull", "never", args.image)
    probe = r'''
const res = await fetch('http://127.0.0.1:3001/api/private/s32/promotions/catalog-book', {
  method: 'POST', headers: {'content-type': 'application/json'}, body: '{"bookId":"smoke"}'
});
const body = await res.json();
if (res.status !== 404 || body.error?.message !== 'Not Found') throw Error(JSON.stringify({status:res.status,body}));
console.log('DEFAULT_DISABLED=PASS');
'''
    for attempt in range(30):
        result = subprocess.run(["docker", "exec", cid, "node", "--input-type=module", "-e", probe],
                                text=True, capture_output=True)
        if result.returncode == 0:
            print(result.stdout.strip())
            break
        if attempt == 29:
            raise RuntimeError(result.stderr)
        time.sleep(1)
    dependency_probe = r'''
const {createRequire} = await import('node:module');
const require = createRequire('/app/apps/api/package.json');
for (const name of ['pg','express','cors','dotenv','meilisearch']) {
  require.resolve(name); console.log('DEPENDENCY='+name);
}
const fs = await import('node:fs');
const crypto = await import('node:crypto');
console.log('LOCK_SHA256='+crypto.createHash('sha256').update(fs.readFileSync('/app/pnpm-lock.yaml')).digest('hex'));
'''
    output = docker("exec", cid, "node", "--input-type=module", "-e", dependency_probe)
    assert "LOCK_SHA256=" + hashlib.sha256((ROOT / "pnpm-lock.yaml").read_bytes()).hexdigest() in output
    print(output)
finally:
    if cid:
        docker("rm", "-f", cid)
        assert subprocess.run(["docker", "inspect", cid], capture_output=True).returncode != 0

# Enabled-but-unconfigured must start and fail safely after auth, without any PG connection.
try:
    cid = docker("run", "-d", "--network", "none", "--pull", "never",
                 "-e", "S32_FEATURES_ENABLED=true", "-e", "S32_PRIVATE_API_TOKEN=smoke-only", args.image)
    probe = r'''
const url = 'http://127.0.0.1:3001/api/private/s32/promotions/catalog-book';
for (const [token,status,message] of [[null,401,'Missing token.'],['smoke-only',503,'S32 database not configured.']]) {
  const headers = {'content-type':'application/json'};
  if (token) headers.authorization='Bearer '+token;
  const r = await fetch(url, {method:'POST',headers,body:'{"bookId":"smoke"}'});
  const b = await r.json();
  if (r.status!==status || b.error?.message!==message) throw Error(JSON.stringify({status:r.status,body:b}));
}
console.log('AUTH_AND_MISSING_DB=PASS');
'''
    for attempt in range(30):
        result = subprocess.run(["docker", "exec", cid, "node", "--input-type=module", "-e", probe],
                                text=True, capture_output=True)
        if result.returncode == 0:
            print(result.stdout.strip())
            break
        if attempt == 29:
            raise RuntimeError(result.stderr)
        time.sleep(1)
finally:
    if cid:
        docker("rm", "-f", cid)
        assert subprocess.run(["docker", "inspect", cid], capture_output=True).returncode != 0
print(json.dumps({"source_commit": args.source_commit, "image_id": info["Id"],
                  "image_size_bytes": info["Size"], "repo_digests": info.get("RepoDigests", []),
                  "architecture": info["Architecture"], "os": info["Os"]}, indent=2))
print("S32_IMAGE_SMOKE=PASS; TEST_CONTAINERS_REMOVED=YES")
