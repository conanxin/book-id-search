#!/usr/bin/env python3
from __future__ import annotations
import hashlib, os, pathlib, re, tempfile
SECRET_KEY=re.compile(r'(PASSWORD|TOKEN|SECRET|DATABASE_URL)',re.I)

def parse_unique_kv(text:str, required:set[str]|None=None)->dict[str,str]:
    out={}
    for raw in text.splitlines():
        if not raw or raw.startswith('#'): continue
        if '=' not in raw: raise ValueError('MALFORMED_KV')
        k,v=raw.split('=',1)
        if k in out: raise ValueError(f'DUPLICATE_KEY:{k}')
        out[k]=v
    if required:
        miss=required-set(out)
        if miss: raise ValueError(f'MISSING_KEY:{sorted(miss)}')
    return out

def sha256_file(path:pathlib.Path)->str:
    h=hashlib.sha256()
    with pathlib.Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''): h.update(chunk)
    return h.hexdigest()

def _canonical(fields:dict[str,str])->str:
    for k in fields:
        if SECRET_KEY.search(k): raise ValueError(f'SECRET_KEY_FORBIDDEN:{k}')
        if '\n' in k or '\n' in str(fields[k]): raise ValueError('NEWLINE_FORBIDDEN')
    return ''.join(f'{k}={fields[k]}\n' for k in sorted(fields))

def write_receipt_atomic(path:pathlib.Path, fields:dict[str,str])->str:
    path=pathlib.Path(path); path.parent.mkdir(parents=True,exist_ok=True)
    if path.exists() or path.is_symlink(): raise FileExistsError(path)
    text=_canonical(fields)
    fd,tmp=tempfile.mkstemp(prefix=path.name+'.',dir=path.parent)
    try:
        os.fchmod(fd,0o600)
        with os.fdopen(fd,'w',encoding='utf-8') as f:
            f.write(text); f.flush(); os.fsync(f.fileno())
        os.link(tmp,path)
    finally:
        try: os.unlink(tmp)
        except FileNotFoundError: pass
    return sha256_file(path)

def read_receipt(path:pathlib.Path)->dict[str,str]:
    p=pathlib.Path(path)
    if p.is_symlink() or not p.is_file(): raise ValueError('UNSAFE_RECEIPT')
    if p.stat().st_mode & 0o777 != 0o600: raise ValueError('UNSAFE_RECEIPT_MODE')
    return parse_unique_kv(p.read_text(encoding='utf-8'))

def classify_attempt(start_path:pathlib.Path,result_path:pathlib.Path)->str:
    start,result=pathlib.Path(start_path),pathlib.Path(result_path)
    if result.exists() and not start.exists(): return 'INVALID_TERMINAL_WITHOUT_START'
    if result.exists(): return 'TERMINAL'
    if start.exists(): return 'INCOMPLETE'
    return 'NOT_STARTED'

def require_same_identity(expected:dict[str,str],actual:dict[str,str],keys:tuple[str,...])->None:
    for k in keys:
        if expected.get(k)!=actual.get(k): raise ValueError(f'IDENTITY_DRIFT:{k}')
