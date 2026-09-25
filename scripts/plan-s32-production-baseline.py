#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,os,pathlib,subprocess,sys,urllib.parse,urllib.request
REQ_SEARCH=('ISBN','SSID','DXID','title','author','publisher')

def block(reason):
    print('STATUS=BLOCKED'); print(f'BLOCK_REASON={reason}'); print('R0_FINAL=BLOCKED'); return 1

def validate(f):
    host=f.get('host') or {}
    if host.get('whoami')!='ubuntu' or host.get('hostname')!='VM-0-4-ubuntu': raise ValueError('HOST_IDENTITY_MISMATCH')
    if f.get('httpStatus') != 200: raise ValueError('PUBLIC_HTTP_FAILED')
    svcs=f.get('services') or {}
    for name in ('web','api','meilisearch'):
        v=svcs.get(name)
        if not isinstance(v,dict) or not all(isinstance(v.get(k),str) and v.get(k) for k in ('cid','startedAt','image','imageId','revision')):
            raise ValueError(f'SERVICE_IDENTITY_INVALID:{name}')
    stats=f.get('stats') or {}
    if not isinstance(stats.get('numberOfDocuments'),int) or stats['numberOfDocuments']<=0: raise ValueError('MEILI_DOC_COUNT_INVALID')
    if stats.get('isIndexing') is not False: raise ValueError('MEILI_INDEXING_ACTIVE')
    searches=f.get('searches') or {}
    for name in REQ_SEARCH:
        if name not in searches: raise ValueError(f'MISSING_SEARCH:{name}')
        if not isinstance(searches[name],dict) or searches[name].get('status')!='PASS': raise ValueError(f'SEARCH_FAILED:{name}')
    if not isinstance(f.get('s32EnvNames',[]),list): raise ValueError('S32_ENV_NAMES_INVALID')
    return f

def sh(*args):
    return subprocess.check_output(args,text=True,timeout=15).strip()

def fetch_json(url):
    with urllib.request.urlopen(url,timeout=15) as r:
        return r.status,json.loads(r.read().decode())

def search(public_url,q,kind):
    u=public_url.rstrip('/')+'/api/search?'+urllib.parse.urlencode({'q':q})
    status,body=fetch_json(u)
    items=body.get('items') if isinstance(body,dict) else None
    return {'status':'PASS' if status==200 and isinstance(items,list) and len(items)>0 else 'FAIL','query':q}

def live_facts(public_url):
    who=sh('whoami'); host=sh('hostname')
    repo=pathlib.Path(os.environ.get('BOOK_ID_SEARCH_REPO_ROOT','/opt/book-id-search'))
    project=os.environ.get('BOOK_ID_SEARCH_COMPOSE_PROJECT','book-id-search')
    checkout=sh('git','-C',str(repo),'rev-parse','HEAD')
    branch=sh('git','-C',str(repo),'branch','--show-current')
    status,_=fetch_json(public_url.rstrip('/')+'/api/health')
    _,stats=fetch_json(public_url.rstrip('/')+'/api/stats')

    def compose_service_ids(name, include_stopped=False):
        args=['sudo','-n','docker','ps']
        if include_stopped: args.append('-a')
        args += [
            '--filter',f'label=com.docker.compose.project={project}',
            '--filter',f'label=com.docker.compose.service={name}',
            '--format','{{.ID}}',
        ]
        out=sh(*args)
        return [line.strip() for line in out.splitlines() if line.strip()]

    services={}
    for name in ('web','api','meilisearch'):
        ids=compose_service_ids(name)
        if len(ids)!=1:
            services[name]=None
            continue
        cid=ids[0]
        vals=sh('sudo','-n','docker','inspect',cid,'--format','{{.Id}}|{{.State.StartedAt}}|{{.Config.Image}}|{{.Image}}').split('|')
        img, iid = vals[2], vals[3]
        try: rev=sh('sudo','-n','docker','image','inspect',img,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}')
        except Exception: rev=img
        services[name]={'cid':vals[0],'startedAt':vals[1],'image':img,'imageId':iid,'revision':rev or img}

    pg_ids=compose_service_ids('postgres',include_stopped=True)
    if len(pg_ids)>1: raise ValueError('SERVICE_IDENTITY_INVALID:postgres')
    pg=bool(pg_ids)

    try:
        api_ids=compose_service_ids('api')
        if len(api_ids)!=1: raise ValueError('SERVICE_IDENTITY_INVALID:api')
        env=sh('sudo','-n','docker','inspect',api_ids[0],'--format','{{range .Config.Env}}{{println .}}{{end}}').splitlines()
        s32=sorted({x.split('=',1)[0] for x in env if x.startswith('S32_')})
    except Exception: s32=[]
    qs={'ISBN':'9787538455250','SSID':'13000000','DXID':'000008232537','title':'时尚秋冬披肩','author':'鲁迅','publisher':'人民文学出版社'}
    searches={k:search(public_url,v,k) for k,v in qs.items()}
    return {'host':{'whoami':who,'hostname':host},'checkoutSha':checkout,'branch':branch,'httpStatus':status,'services':services,'postgresPresent':pg,'s32EnvNames':s32,'stats':{'numberOfDocuments':stats.get('numberOfDocuments'),'isIndexing':stats.get('isIndexing')},'searches':searches}

def emit(f):
    print('STATUS=PASS'); print('R0_RUNTIME_IDENTITY=PASS'); print('R0_LEGACY_SEARCH_SMOKE=PASS'); print('R0_FINAL=PASS')
    print(f"PRODUCTION_CHECKOUT={f['checkoutSha']}")
    print(f"PRODUCTION_BRANCH={f['branch']}")
    for name in ('web','api','meilisearch'):
      s=f['services'][name]; pre=name.upper(); print(f'{pre}_CID={s["cid"]}'); print(f'{pre}_STARTED_AT={s["startedAt"]}'); print(f'{pre}_IMAGE={s["image"]}'); print(f'{pre}_IMAGE_ID={s["imageId"]}'); print(f'{pre}_REVISION={s["revision"]}')
    print(f"POSTGRES_SERVICE_PRESENT={'YES' if f.get('postgresPresent') else 'NO'}")
    print('S32_ENV_NAMES='+(','.join(f.get('s32EnvNames') or []) or '<none>'))
    print(f"MEILI_DOCUMENTS={f['stats']['numberOfDocuments']}"); print('MEILI_INDEXING=NO'); print('PUBLIC_HTTP_STATUS=200')

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('--facts-json'); ap.add_argument('--public-url',default='https://books.conanxin.com'); ap.add_argument('--json-out'); args=ap.parse_args()
    try:
      f=json.loads(pathlib.Path(args.facts_json).read_text()) if args.facts_json else live_facts(args.public_url)
      validate(f)
      if args.json_out: pathlib.Path(args.json_out).write_text(json.dumps(f,sort_keys=True),encoding='utf-8')
      emit(f); return 0
    except Exception as e: return block(str(e))
if __name__=='__main__': raise SystemExit(main())
