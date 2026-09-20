import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {CandidateClaimIntegrityError,CandidateClaimScopeNotFoundError,CandidateClaimStoreUnavailableError,ResearchIssueReadOnlyError,type CandidateClaimStore} from '../application/candidate-claims.js';
import {ProjectReadOnlyError,IdempotencyConflictError} from '../application/research-issues.js';
import {normalizeCandidateClaimStatement,readCandidateClaimId,type CandidateClaim} from '../domain/candidate-claim.js';
import {readResearchIssueInput,readResearchIssueId} from '../domain/research-issue.js';
import {readProjectId} from '../domain/project.js';
function bad():never{throw new CandidateClaimIntegrityError('CLAIM_INTEGRITY_ERROR');}
const object=(v:unknown)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
async function transaction<T>(pool:Pool,readOnly:boolean,run:(c:PoolClient)=>Promise<T>):Promise<T>{
 let c:PoolClient|undefined;
 try{c=await pool.connect();await c.query(readOnly?'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY':'BEGIN');const result=await run(c);await c.query('COMMIT');return result;}
 catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});const {code,message}=e as {code?:string;message?:string};if((code&&/^(08[0-9A-Z]{3}|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EPIPE|57P0[123]|53300)$/.test(code))||/connection (terminated|timeout)|timeout exceeded|query read timeout/i.test(message??''))throw new CandidateClaimStoreUnavailableError('CLAIM_STORE_UNAVAILABLE');throw e;}
 finally{c?.release();}
}
async function context(c:PoolClient,projectId:string,issueId:string,lock=false){
 const project=(await c.query(`SELECT id,name,lifecycle_state FROM core.projects WHERE id=$1${lock?' FOR UPDATE':''}`,[projectId])).rows[0];
 if(!project)return null;
 try{readProjectId(project.id);}catch{bad();}
 if(!['ACTIVE','ARCHIVED'].includes(project.lifecycle_state)||typeof project.name!=='string'||!project.name.trim())bad();
 if(lock){await c.query('SELECT id FROM core.research_issues WHERE id=$1 FOR UPDATE',[issueId]);await c.query("SELECT id FROM core.project_bindings WHERE target_type='RESEARCH_ISSUE' AND target_id=$1 ORDER BY id FOR UPDATE",[issueId]);}
 const rows=(await c.query(`SELECT ri.id AS issue_id,ri.title,ri.question,ri.lifecycle_state AS issue_lifecycle_state,
 pb.id AS binding_id,pb.project_id AS owner_project_id,pb.binding_role,pb.metadata AS binding_metadata
 FROM core.research_issues ri LEFT JOIN core.project_bindings pb ON pb.target_type='RESEARCH_ISSUE' AND pb.target_id=ri.id WHERE ri.id=$1 ORDER BY pb.id`,[issueId])).rows;
 if(!rows.length){const dangling=(await c.query("SELECT id FROM core.project_bindings WHERE target_type='RESEARCH_ISSUE' AND target_id=$1",[issueId])).rows;if(dangling.length)bad();return null;}
 if(rows.length!==1)bad();const row=rows[0];
 if(!row.binding_id||row.binding_role!==null||!object(row.binding_metadata))bad();
 try{readProjectId(row.owner_project_id);readResearchIssueId(row.issue_id);const normalized=readResearchIssueInput(row);if(normalized.title!==row.title||normalized.question!==row.question)bad();}catch{bad();}
 if(!['OPEN','RESOLVED','ARCHIVED'].includes(row.issue_lifecycle_state))bad();
 if(row.owner_project_id!==projectId)return null;
 return {projectState:project.lifecycle_state as string,issueState:row.issue_lifecycle_state as string};
}
function canonical(row:any,issueId:string,command=false):CandidateClaim{
 try{readCandidateClaimId(row.claim_id);if(normalizeCandidateClaimStatement(row.statement)!==row.statement)bad();}catch{bad();}
 if(row.issue_id!==issueId||!['ACTIVE','ARCHIVED'].includes(row.lifecycle_state)||!object(row.metadata)||!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime())||!(row.updated_at instanceof Date)||!Number.isFinite(row.updated_at.getTime()))bad();
 if(command&&(row.claim_type!==null||row.subject_type!==null||row.subject_id!==null))bad();
 if(row.claim_type!==null&&typeof row.claim_type!=='string')bad();
 if(row.subject_type===null){if(row.subject_id!==null)bad();}else{if(!['WORK','EDITION','SOURCE','SOURCE_ASSET','NOTE','ACTOR'].includes(row.subject_type))bad();try{readCandidateClaimId(row.subject_id);}catch{bad();}}
 return {id:row.claim_id,statement:row.statement,lifecycleState:row.lifecycle_state,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};
}
async function rows(c:PoolClient,issueId:string,claimId?:string){return (await c.query(`SELECT ric.issue_id,c.id AS claim_id,c.claim_type,c.statement,c.subject_type,c.subject_id,c.lifecycle_state,c.metadata,c.created_at,c.updated_at
 FROM core.research_issue_claims ric
 LEFT JOIN core.claims c ON c.id=ric.claim_id
 WHERE ric.issue_id=$1${claimId?' AND ric.claim_id=$2':''}
 ORDER BY CASE c.lifecycle_state WHEN 'ACTIVE' THEN 0 WHEN 'ARCHIVED' THEN 1 ELSE 2 END,c.created_at ASC,c.id ASC`,claimId?[issueId,claimId]:[issueId])).rows;}
export function createPostgresCandidateClaimStore(pool:Pool):CandidateClaimStore{return {
 list(projectId,issueId){return transaction(pool,true,async c=>{if(!await context(c,projectId,issueId))return null;return {claims:(await rows(c,issueId)).map(r=>canonical(r,issueId))};});},
 create(input){return transaction(pool,false,async c=>{
 const scope=`S32:M2B:PROJECT_ISSUE_CLAIM_CREATE:${input.projectId}:${input.issueId}`;
 const inserted=(await c.query(`INSERT INTO ops.idempotency_keys (id,scope,idempotency_key,request_hash,status) VALUES ($1,$2,$3,$4,'IN_PROGRESS') ON CONFLICT(scope,idempotency_key) DO NOTHING RETURNING id`,[randomUUID(),scope,input.idempotencyKey,input.requestHash])).rows;
 if(!inserted.length){
  const receipt=(await c.query('SELECT id,request_hash,status,resource_type,resource_id FROM ops.idempotency_keys WHERE scope=$1 AND idempotency_key=$2 FOR UPDATE',[scope,input.idempotencyKey])).rows[0];
  if(!receipt)bad();if(receipt.request_hash.trim()!==input.requestHash)throw new IdempotencyConflictError('IDEMPOTENCY_CONFLICT');
  if(receipt.status!=='COMPLETED'||receipt.resource_type!=='CLAIM'||!receipt.resource_id)bad();
  if(!await context(c,input.projectId,input.issueId))throw new CandidateClaimScopeNotFoundError();
  const found=await rows(c,input.issueId,receipt.resource_id);if(found.length!==1)bad();
  return {status:'replayed',claim:canonical(found[0],input.issueId,true)};
 }
 const ctx=await context(c,input.projectId,input.issueId,true);if(!ctx)throw new CandidateClaimScopeNotFoundError();
 if(ctx.projectState!=='ACTIVE')throw new ProjectReadOnlyError();if(ctx.issueState!=='OPEN')throw new ResearchIssueReadOnlyError();
 await c.query("INSERT INTO core.claims (id,claim_type,statement,subject_type,subject_id,lifecycle_state,metadata) VALUES ($1, NULL, $2, NULL, NULL, 'ACTIVE', '{}'::jsonb)",[input.claimId,input.statement]);
 await c.query('INSERT INTO core.research_issue_claims (issue_id,claim_id) VALUES ($1,$2)',[input.issueId,input.claimId]);
 await c.query("UPDATE ops.idempotency_keys SET status='COMPLETED',resource_type='CLAIM',resource_id=$2,completed_at=now(),updated_at=now() WHERE id=$1",[inserted[0].id,input.claimId]);
 const found=await rows(c,input.issueId,input.claimId);if(found.length!==1)bad();const claim=canonical(found[0],input.issueId,true);if(claim.lifecycleState!=='ACTIVE')bad();
 return {status:'created',claim};
 });}
};}
