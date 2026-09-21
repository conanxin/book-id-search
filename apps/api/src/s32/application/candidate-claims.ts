import { randomUUID } from 'node:crypto';
import { readProjectId } from '../domain/project.js';
import { readResearchIssueId, readIdempotencyKey } from '../domain/research-issue.js';
import { normalizeCandidateClaimStatement, hashCandidateClaimCreateRequest, InvalidCandidateClaimInputError, type CandidateClaim } from '../domain/candidate-claim.js';
export class ResearchIssueReadOnlyError extends Error {}
export class CandidateClaimScopeNotFoundError extends Error {}
export class CandidateClaimIntegrityError extends Error {}
export class CandidateClaimStoreUnavailableError extends Error {}
export interface CandidateClaimStore {
 list(projectId:string,issueId:string):Promise<{claims:CandidateClaim[]}|null>;
 create(input:{projectId:string;issueId:string;claimId:string;idempotencyKey:string;requestHash:string;statement:string}):Promise<{status:'created'|'replayed';claim:CandidateClaim}>;
}
export function createCandidateClaimsService(store:CandidateClaimStore){return {
 async list(project:unknown,issue:unknown){return store.list(readProjectId(project).toLowerCase(),readResearchIssueId(issue));},
 async create(project:unknown,issue:unknown,key:unknown,body:unknown){
  const projectId=readProjectId(project).toLowerCase(),issueId=readResearchIssueId(issue),idempotencyKey=readIdempotencyKey(key);
  if(!body||typeof body!=='object'||Array.isArray(body)) throw new InvalidCandidateClaimInputError('可能答案输入必须是对象。');
  const statement=normalizeCandidateClaimStatement((body as Record<string,unknown>).statement);
  return store.create({projectId,issueId,idempotencyKey,claimId:randomUUID(),statement,requestHash:hashCandidateClaimCreateRequest(projectId,issueId,statement)});
 }
};}
export type CandidateClaimsService=ReturnType<typeof createCandidateClaimsService>;
