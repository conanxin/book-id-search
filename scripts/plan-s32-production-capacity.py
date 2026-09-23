#!/usr/bin/env python3
from __future__ import annotations
import argparse
import importlib.util
import json
import pathlib
import sys

G=1024**3
M=1024**2
HARD=20*G
PREFERRED=21*G
PG_INIT=128*M
PG_GROWTH=1*G
LOGS=150*M
TRANSIENT=128*M

ROOT=pathlib.Path(__file__).resolve().parent
MANIFEST_MODULE=ROOT/"s32-release-manifest.py"

def block(reason,free_after=None,peak=None):
    print("STATUS=BLOCKED")
    print(f"BLOCK_REASON={reason}")
    print("CAPACITY_GATE=BLOCKED_CAPACITY")
    if peak is not None: print(f"PEAK_INCREMENT_BYTES={peak}")
    if free_after is not None: print(f"FREE_AFTER_PEAK_BYTES={free_after}")
    return 1

def load_manifest_module():
    spec=importlib.util.spec_from_file_location("s32_release_manifest",MANIFEST_MODULE)
    if spec is None or spec.loader is None: raise ValueError("RELEASE_MANIFEST_MODULE_UNAVAILABLE")
    mod=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def filesystem_values(value):
    if not isinstance(value,dict): raise ValueError("FILESYSTEM_FACTS_INVALID")
    ident=value.get("id"); total=value.get("totalBytes"); used=value.get("usedBytes"); free=value.get("freeBytes")
    if not isinstance(ident,str) or not ident: raise ValueError("FILESYSTEM_ID_INVALID")
    for name,n in (("totalBytes",total),("usedBytes",used),("freeBytes",free)):
        if not isinstance(n,int) or n<0: raise ValueError(f"FILESYSTEM_BYTES_INVALID:{name}")
    if total<=0 or used>total or free>total or used+free>total:
        raise ValueError("FILESYSTEM_BYTES_INCONSISTENT")
    return ident,total,used,free

def used_after_bps(total,used,inc):
    return ((used+inc)*10000 + total-1)//total

def candidate_bytes(value):
    for key in ("compressedBytes","tarBytes","imageBytes"):
        if not isinstance(value.get(key),int) or value[key]<0:
            raise ValueError(f"CANDIDATE_SIZE_INVALID:{key}")
    return value["compressedBytes"]+value["tarBytes"]+value["imageBytes"]

def validate_candidates(manifest, api, web):
    checks=[
        api.get("sourceSha")==manifest["sourceSha"],
        api.get("imageTag")==manifest["apiImageTag"],
        api.get("imageId")==manifest["apiImageId"],
        api.get("ociRevision")==manifest["apiOciRevision"],
        api.get("lockfileSha256")==manifest["pnpmLockSha256"],
        api.get("baseDigest")==manifest["apiBaseDigest"],
        web.get("gitSha")==manifest["sourceSha"],
        web.get("tag")==manifest["webImageTag"],
        web.get("imageId")==manifest["webImageId"],
        web.get("ociRevision")==manifest["webOciRevision"],
        web.get("lockfileSha256")==manifest["pnpmLockSha256"],
        web.get("staticManifestSha256")==manifest["webStaticManifestSha256"],
        web.get("webS32Enabled") is True and manifest["webS32Enabled"] is True,
        web.get("nodeBaseDigest")==manifest["webNodeBaseDigest"],
        web.get("nginxBaseDigest")==manifest["webNginxBaseDigest"],
    ]
    if not all(checks): raise ValueError("CANDIDATE_RELEASE_IDENTITY_MISMATCH")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--facts-json",required=True)
    ap.add_argument("--release-manifest-json",required=True)
    ap.add_argument("--api-candidate-json",required=True)
    ap.add_argument("--web-candidate-json",required=True)
    a=ap.parse_args()
    try:
        facts=json.loads(pathlib.Path(a.facts_json).read_text())
        manifest=json.loads(pathlib.Path(a.release_manifest_json).read_text())
        api=json.loads(pathlib.Path(a.api_candidate_json).read_text())
        web=json.loads(pathlib.Path(a.web_candidate_json).read_text())
        mod=load_manifest_module()
        valid=mod.validate_manifest(manifest)
        fingerprint=mod.fingerprint_manifest(valid)
        if facts.get("releaseFingerprint")!=fingerprint:
            return block("RELEASE_FINGERPRINT_MISMATCH")
        if facts.get("releaseSourceSha")!=valid["sourceSha"]:
            return block("SOURCE_SHA_MISMATCH")
        validate_candidates(valid,api,web)
        artifact=candidate_bytes(api)+candidate_bytes(web)

        fs=facts["filesystems"]
        root_id,root_total,root_used,root_free=filesystem_values(fs["docker"])
        release_id,release_total,release_used,release_free=filesystem_values(fs["release"])
        data_id,data_total,data_used,data_free=filesystem_values(fs["data"])
        if root_id!=release_id or (root_total,root_used,root_free)!=(release_total,release_used,release_free):
            return block("DOCKER_RELEASE_FILESYSTEM_MISMATCH")
        same_data=data_id==root_id
        if same_data:
            if (data_total,data_used,data_free)!=(root_total,root_used,root_free):
                return block("FILESYSTEM_FACTS_INCONSISTENT")
            peak=artifact+PG_INIT+PG_GROWTH+LOGS+TRANSIENT
            free_after=root_free-peak
            used_bps=used_after_bps(root_total,root_used,peak)
            if free_after<HARD: return block("FREE_AFTER_PEAK_BELOW_HARD_RESERVE",free_after,peak)
            if used_bps>8000: return block("USED_AFTER_PEAK_LIMIT",free_after,peak)
            gate="PASS_PREFERRED" if free_after>=PREFERRED else "PASS_HARD_ONLY"
        else:
            root_peak=artifact+LOGS+TRANSIENT
            data_peak=PG_INIT+PG_GROWTH
            root_after=root_free-root_peak
            data_after=data_free-data_peak
            data_bps=used_after_bps(data_total,data_used,data_peak)
            root_bps=used_after_bps(root_total,root_used,root_peak)
            if data_after<HARD or data_bps>8000:
                return block("DATA_FILESYSTEM_CAPACITY",data_after,root_peak+data_peak)
            if root_after<HARD or root_bps>8000:
                return block("ROOT_FILESYSTEM_CAPACITY",root_after,root_peak+data_peak)
            free_after=min(root_after,data_after)
            peak=root_peak+data_peak
            used_bps=max(root_bps,data_bps)
            gate="PASS_PREFERRED" if root_after>=PREFERRED and data_after>=PREFERRED else "PASS_HARD_ONLY"

        print("STATUS=PASS")
        print(f"CAPACITY_GATE={gate}")
        print(f"S32_RELEASE_FINGERPRINT={fingerprint}")
        print(f"RELEASE_SOURCE_SHA={valid['sourceSha']}")
        print(f"API_IMAGE_ID={valid['apiImageId']}")
        print(f"WEB_IMAGE_ID={valid['webImageId']}")
        print(f"CURRENT_FREE_BYTES={root_free}")
        print(f"PEAK_INCREMENT_BYTES={peak}")
        print(f"FREE_AFTER_PEAK_BYTES={free_after}")
        print(f"USED_AFTER_PEAK_BPS={used_bps}")
        print(f"HARD_RESERVE_BYTES={HARD}")
        print(f"PREFERRED_RESERVE_BYTES={PREFERRED}")
        return 0
    except Exception as exc:
        return block(str(exc))

if __name__=="__main__":
    raise SystemExit(main())
