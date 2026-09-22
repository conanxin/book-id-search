#!/usr/bin/env python3
from __future__ import annotations
import argparse,pathlib,subprocess

def sh(repo,*args): return subprocess.check_output(['git','-C',str(repo),*args],text=True,stderr=subprocess.STDOUT).strip()
def block(reason): print('STATUS=BLOCKED'); print(f'BLOCK_REASON={reason}'); print('PRODUCTION_WRITE_EXECUTED=false'); return 1

def dirty_outside_runtime(repo):
 status=subprocess.check_output(
  ['git','-C',str(repo),'status','--porcelain=v1','--untracked-files=all'],
  text=True,stderr=subprocess.STDOUT,
 )
 for line in status.splitlines():
  if not line:
   continue
  code=line[:2]
  path=line[3:]
  if code=='??' and (path.startswith('progress/') or path.startswith('logs/')):
   continue
  return True
 return False

def main():
 ap=argparse.ArgumentParser(); ap.add_argument('--repo',required=True); ap.add_argument('--target',required=True); a=ap.parse_args(); repo=pathlib.Path(a.repo)
 try:
  if sh(repo,'branch','--show-current')!='main': return block('NOT_MAIN_BRANCH')
  if dirty_outside_runtime(repo): return block('WORKTREE_NOT_CLEAN')
  target=sh(repo,'rev-parse',a.target+'^{commit}')
  current=sh(repo,'rev-parse','HEAD')
  origin=sh(repo,'rev-parse','origin/main')
  ok=subprocess.run(['git','-C',str(repo),'merge-base','--is-ancestor',target,origin]).returncode==0
  if not ok: return block('TARGET_NOT_REACHABLE_FROM_ORIGIN_MAIN')
  print('STATUS=READY'); print(f'CURRENT_CONTROL_PLANE_SHA={current}'); print(f'TARGET_CONTROL_PLANE_SHA={target}'); print('TARGET_REACHABLE_FROM_ORIGIN_MAIN=YES'); print('PRODUCTION_WRITE_EXECUTED=false'); return 0
 except Exception as e: return block('PLAN_FAILED:'+str(e))
if __name__=='__main__': raise SystemExit(main())
