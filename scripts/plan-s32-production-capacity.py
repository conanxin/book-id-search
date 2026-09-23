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

def filesystem_values(value):
 if not isinstance(value,dict): raise ValueError('FILESYSTEM_FACTS_INVALID')
 ident=value.get('id'); total=value.get('totalBytes'); used=value.get('usedBytes'); free=value.get('freeBytes')
 if not isinstance(ident,str) or not ident: raise ValueError('FILESYSTEM_ID_INVALID')
 for name,n in (('totalBytes',total),('usedBytes',used),('freeBytes',free)):
  if not isinstance(n,int) or n<0: raise ValueError(f'FILESYSTEM_BYTES_INVALID:{name}')
 if total<=0 or used>total or free>total or used+free>total:
  raise ValueError('FILESYSTEM_BYTES_INCONSISTENT')
 return ident,total,used,free

def used_after_bps(total,used,inc):
 return ((used+inc)*10000 + total-1)//total

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
  fs=f['filesystems']
  root_id,root_total,root_used,root_free=filesystem_values(fs['docker'])
  release_id,release_total,release_used,release_free=filesystem_values(fs['release'])
  data_id,data_total,data_used,data_free=filesystem_values(fs['data'])
  if root_id!=release_id or (root_total,root_used,root_free)!=(release_total,release_used,release_free):
   return block('DOCKER_RELEASE_FILESYSTEM_MISMATCH')
  same_data=data_id==root_id
  if same_data:
   if (data_total,data_used,data_free)!=(root_total,root_used,root_free): return block('FILESYSTEM_FACTS_INCONSISTENT')
   peak=artifact+PG_INIT+PG_GROWTH+LOGS+TRANSIENT; free_after=root_free-peak
   used_bps=used_after_bps(root_total,root_used,peak)
   if free_after<HARD: return block('FREE_AFTER_PEAK_BELOW_HARD_RESERVE',free_after,peak)
   if used_bps>8000: return block('USED_AFTER_PEAK_LIMIT',free_after,peak)
   gate='PASS_PREFERRED' if free_after>=PREFERRED else 'PASS_HARD_ONLY'
  else:
   root_peak=artifact+LOGS+TRANSIENT; data_peak=PG_INIT+PG_GROWTH
   root_after=root_free-root_peak; data_after=data_free-data_peak
   data_bps=used_after_bps(data_total,data_used,data_peak)
   root_bps=used_after_bps(root_total,root_used,root_peak)
   if data_after<HARD or data_bps>8000: return block('DATA_FILESYSTEM_CAPACITY',data_after,root_peak+data_peak)
   if root_after<HARD or root_bps>8000: return block('ROOT_FILESYSTEM_CAPACITY',root_after,root_peak+data_peak)
   free_after=min(root_after,data_after); peak=root_peak+data_peak; used_bps=max(root_bps,data_bps)
   gate='PASS_PREFERRED' if root_after>=PREFERRED and data_after>=PREFERRED else 'PASS_HARD_ONLY'
  print('STATUS=PASS'); print(f'CAPACITY_GATE={gate}'); print(f'S32_RELEASE_FINGERPRINT={f["releaseFingerprint"]}'); print(f'CURRENT_FREE_BYTES={root_free}'); print(f'PEAK_INCREMENT_BYTES={peak}'); print(f'FREE_AFTER_PEAK_BYTES={free_after}'); print(f'USED_AFTER_PEAK_BPS={used_bps}'); print('HARD_RESERVE_BYTES='+str(HARD)); print('PREFERRED_RESERVE_BYTES='+str(PREFERRED)); return 0
 except Exception as e: return block(str(e))
if __name__=='__main__': raise SystemExit(main())
