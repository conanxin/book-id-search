#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,pathlib
G=1024**3; M=1024**2
HARD=20*G; PREFERRED=21*G
PG_INIT=128*M; PG_GROWTH=1*G; LOGS=150*M; TRANSIENT=128*M

def block(reason,free_after=None,peak=None):
 print('STATUS=BLOCKED'); print(f'BLOCK_REASON={reason}'); print('CAPACITY_GATE=BLOCKED_CAPACITY')
 if peak is not None: print(f'PEAK_INCREMENT_BYTES={peak}')
 if free_after is not None: print(f'FREE_AFTER_PEAK_BYTES={free_after}')
 return 1

def infer_total(free,used_pct):
 if not (0<=used_pct<100): raise ValueError('USED_PERCENT_INVALID')
 return (free*100)//(100-used_pct) if used_pct<100 else 0

def used_after_pct(free,used_pct,inc):
 total=infer_total(free,used_pct); used=total-free+inc
 return (used*10000 + total-1)//total/100.0

def candidate_bytes(c):
 for k in ('compressedBytes','tarBytes','imageBytes'):
  if not isinstance(c.get(k),int) or c[k]<0: raise ValueError(f'CANDIDATE_SIZE_INVALID:{k}')
 return c['compressedBytes']+c['tarBytes']+c['imageBytes']

def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--facts-json',required=True); a=ap.parse_args()
 try:
  f=json.loads(pathlib.Path(a.facts_json).read_text()); src=f['releaseSourceSha']
  if f['api'].get('sourceSha')!=src or f['web'].get('sourceSha')!=src: return block('SOURCE_SHA_MISMATCH')
  if not isinstance(f.get('releaseFingerprint'),str) or len(f['releaseFingerprint'])!=64: return block('RELEASE_FINGERPRINT_INVALID')
  api=candidate_bytes(f['api']); web=candidate_bytes(f['web']); artifact=api+web
  fs=f['filesystems']; root=fs['docker']; release=fs['release']; data=fs['data']
  if root['id']!=release['id']: return block('DOCKER_RELEASE_FILESYSTEM_MISMATCH')
  same_data=data['id']==root['id']
  if same_data:
   peak=artifact+PG_INIT+PG_GROWTH+LOGS+TRANSIENT; free_after=root['freeBytes']-peak
   ua=used_after_pct(root['freeBytes'],root['usedPercent'],peak)
   if free_after<HARD: return block('FREE_AFTER_PEAK_BELOW_HARD_RESERVE',free_after,peak)
   if ua>80: return block('USED_AFTER_PEAK_LIMIT',free_after,peak)
   gate='PASS_PREFERRED' if free_after>=PREFERRED else 'PASS_HARD_ONLY'
  else:
   root_peak=artifact+LOGS+TRANSIENT; data_peak=PG_INIT+PG_GROWTH
   root_after=root['freeBytes']-root_peak; data_after=data['freeBytes']-data_peak
   if data_after<HARD or used_after_pct(data['freeBytes'],data['usedPercent'],data_peak)>80: return block('DATA_FILESYSTEM_CAPACITY',data_after,root_peak+data_peak)
   if root_after<HARD or used_after_pct(root['freeBytes'],root['usedPercent'],root_peak)>80: return block('ROOT_FILESYSTEM_CAPACITY',root_after,root_peak+data_peak)
   free_after=min(root_after,data_after); peak=root_peak+data_peak
   gate='PASS_PREFERRED' if root_after>=PREFERRED and data_after>=PREFERRED else 'PASS_HARD_ONLY'
  print('STATUS=PASS'); print(f'CAPACITY_GATE={gate}'); print(f'CURRENT_FREE_BYTES={root["freeBytes"]}'); print(f'PEAK_INCREMENT_BYTES={peak}'); print(f'FREE_AFTER_PEAK_BYTES={free_after}'); print('HARD_RESERVE_BYTES='+str(HARD)); print('PREFERRED_RESERVE_BYTES='+str(PREFERRED)); return 0
 except Exception as e: return block(str(e))
if __name__=='__main__': raise SystemExit(main())
