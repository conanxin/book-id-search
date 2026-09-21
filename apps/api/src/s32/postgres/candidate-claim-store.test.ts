import {it,expect,vi} from 'vitest';
import type {Pool} from 'pg';
import {createPostgresCandidateClaimStore} from './candidate-claim-store.js';
import {CandidateClaimIntegrityError,CandidateClaimScopeNotFoundError,CandidateClaimStoreUnavailableError,ResearchIssueReadOnlyError} from '../application/candidate-claims.js';
import {ProjectReadOnlyError,IdempotencyConflictError} from '../application/research-issues.js';
const p='11111111-1111-4111-8111-111111111111',i='22222222-2222-4222-8222-222222222222',c='33333333-3333-4333-8333-333333333333';
const input={projectId:p,issueId:i,claimId:c,idempotencyKey:c,requestHash:'a'.repeat(64),statement:'statement'};
const claim={issue_id:i,claim_id:c,statement:'statement',claim_type:null,subject_type:null,subject_id:null,lifecycle_state:'ACTIVE',metadata:{},created_at:new Date(),updated_at:new Date()};
function setup(o:any={}){const query=vi.fn(async(sql:string,args?:any[])=>{
 if(o.fail && sql.includes(o.fail))throw Object.assign(new Error('SECRET'),{code:o.code});
 if(sql.includes('INSERT INTO ops.idempotency_keys'))return {rows:o.replay?[]:[{id:c}]};
 if(sql.includes('FROM ops.idempotency_keys'))return {rows:[{id:c,request_hash:o.hash??input.requestHash,status:o.status??'COMPLETED',resource_type:'CLAIM',resource_id:c}]};
 if(sql.includes('FROM core.projects'))return {rows:o.noProject?[]:[{id:p,name:'project',lifecycle_state:o.projectState??'ACTIVE'}]};
 if(sql.includes('FROM core.research_issues ri'))return {rows:o.owners??[{issue_id:i,title:'title',question:'question',issue_lifecycle_state:o.issueState??'OPEN',binding_id:c,owner_project_id:p,binding_role:null,binding_metadata:{}}]};
 if(sql.includes('FROM core.research_issue_claims ric'))return {rows:o.claims??[claim]};
 return {rows:[]};}); const release=vi.fn();return {query,release,store:createPostgresCandidateClaimStore({connect:async()=>({query,release})} as unknown as Pool)};}
it('lists snapshot with relation-first LEFT JOIN and fixed query count',async()=>{const s=setup();expect((await s.store.list(p,i))?.claims).toHaveLength(1);expect(s.query.mock.calls[0][0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY');expect(s.query.mock.calls.map(x=>x[0]).join('\n')).toMatch(/FROM core.research_issue_claims ric\s+LEFT JOIN core.claims/);expect(s.query).toHaveBeenCalledTimes(5);expect(s.release).toHaveBeenCalledOnce();});
it('reads historical typed subject Claims',async()=>{const s=setup({claims:[{...claim,claim_type:'HISTORICAL',subject_type:'EDITION',subject_id:c}]});expect((await s.store.list(p,i))?.claims[0].id).toBe(c);});
it.each([{claim_id:null},{statement:'  bad '},{metadata:[]},{lifecycle_state:'TRUE'},{created_at:new Date('bad')}])('fails closed on invalid/dangling claim %j',async patch=>{const s=setup({claims:[{...claim,...patch}]});await expect(s.store.list(p,i)).rejects.toBeInstanceOf(CandidateClaimIntegrityError);expect(s.query).toHaveBeenCalledWith('ROLLBACK');});
it('missing Project is null',async()=>{expect(await setup({noProject:true}).store.list(p,i)).toBeNull();});
it.each([[],[{issue_id:i,binding_id:null}],[{},{}],[{issue_id:i,binding_id:c,owner_project_id:p,binding_role:'BAD',binding_metadata:{}}]].map(owners=>[owners]))('rejects missing or corrupt ownership %j',async owners=>{const s=setup({owners});if(!owners.length)expect(await s.store.list(p,i)).toBeNull();else await expect(s.store.list(p,i)).rejects.toBeInstanceOf(CandidateClaimIntegrityError);});
it('creates null shape and relation in transaction with exact namespace',async()=>{const s=setup();expect((await s.store.create(input)).status).toBe('created');const calls=s.query.mock.calls;expect(calls.find(x=>x[0].includes('INSERT INTO ops.'))?.[1]?.[1]).toBe(`S32:M2B:PROJECT_ISSUE_CLAIM_CREATE:${p}:${i}`);expect(calls.map(x=>x[0]).join('\n')).toMatch(/VALUES \(\$1, NULL, \$2, NULL, NULL, 'ACTIVE'/);expect(calls.some(x=>x[0].includes('INSERT INTO core.research_issue_claims'))).toBe(true);expect(calls.at(-1)?.[0]).toBe('COMMIT');});
it.each(['RESOLVED','ARCHIVED'])('new %s Issue rejected',async issueState=>{await expect(setup({issueState}).store.create(input)).rejects.toBeInstanceOf(ResearchIssueReadOnlyError);});
it('new archived project rejected',async()=>{await expect(setup({projectState:'ARCHIVED'}).store.create(input)).rejects.toBeInstanceOf(ProjectReadOnlyError);});
it.each(['OPEN','RESOLVED','ARCHIVED'])('completed replay ignores new-write lifecycle %s',async issueState=>{const s=setup({replay:true,projectState:'ARCHIVED',issueState});expect((await s.store.create(input)).status).toBe('replayed');expect(s.query.mock.calls.some(x=>x[0].includes('INSERT INTO core.claims'))).toBe(false);});
it('replay validates relation and command null shape',async()=>{await expect(setup({replay:true,claims:[]}).store.create(input)).rejects.toBeInstanceOf(CandidateClaimIntegrityError);await expect(setup({replay:true,claims:[{...claim,claim_type:'OTHER'}]}).store.create(input)).rejects.toBeInstanceOf(CandidateClaimIntegrityError);});
it('hash conflict and durable incomplete fail closed',async()=>{await expect(setup({replay:true,hash:'b'}).store.create(input)).rejects.toBeInstanceOf(IdempotencyConflictError);await expect(setup({replay:true,status:'IN_PROGRESS'}).store.create(input)).rejects.toBeInstanceOf(CandidateClaimIntegrityError);});
it('relation failure rolls back',async()=>{const s=setup({fail:'INSERT INTO core.research_issue_claims'});await expect(s.store.create(input)).rejects.toThrow();expect(s.query).toHaveBeenCalledWith('ROLLBACK');});
it('connection failures become typed unavailable',async()=>{await expect(setup({fail:'FROM core.projects',code:'ECONNREFUSED'}).store.list(p,i)).rejects.toBeInstanceOf(CandidateClaimStoreUnavailableError);});
