// @vitest-environment jsdom
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import * as draft from './candidate-claim-draft';
const p='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',i='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',other='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
beforeEach(()=>{vi.unstubAllGlobals();sessionStorage.clear();draft.clearPendingCandidateClaimReceipt();});
afterEach(()=>vi.unstubAllGlobals());
it('normalizes White_Space, CR/LF and enforces NUL/code-point bounds',()=>{expect(draft.normalizeCandidateClaimDraft(' \u0085a\r\nb\rc\t d ')).toBe('a b c d');expect(draft.normalizeCandidateClaimDraft('𠮷'.repeat(4000))).toHaveLength(8000);for(const s of ['\u0085','a\0b','𠮷'.repeat(4001)])expect(()=>draft.normalizeCandidateClaimDraft(s)).toThrow();});
it('matches server fixed-order Project+Issue+statement hash including NEL',async()=>{const {hashCandidateClaimCreateRequest}=await import('../../../api/src/s32/domain/candidate-claim');const s='\u0085a\r\nb\u0085c ';expect(await draft.hashCandidateClaimDraft(p,i,s)).toBe(hashCandidateClaimCreateRequest(p,i,s));});
it('rotates only for changed scope or explicit force; changed intent in same scope throws',async()=>{const a=await draft.getOrCreateCandidateClaimReceipt(p,i,' a\nb ');expect((await draft.getOrCreateCandidateClaimReceipt(p.toLowerCase(),i,'a b')).idempotencyKey).toBe(a.idempotencyKey);await expect(draft.getOrCreateCandidateClaimReceipt(p,i,'other')).rejects.toBeInstanceOf(draft.PendingCandidateClaimIntentConflictError);const c=await draft.getOrCreateCandidateClaimReceipt(other,i,'other');const d=await draft.getOrCreateCandidateClaimReceipt(other,other,'other');const e=await draft.getOrCreateCandidateClaimReceipt(other,other,'other',true);expect(new Set([a,c,d,e].map(r=>r.idempotencyKey)).size).toBe(4);});
it('persists exactly five receipt fields without statement',async()=>{await draft.getOrCreateCandidateClaimReceipt(p,i,'private text');const raw=sessionStorage.getItem(draft.CANDIDATE_CLAIM_PENDING_KEY)!;expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['createdAt','idempotencyKey','issueId','projectId','requestHash']);expect(raw).not.toContain('private text');});
it('changed intent in same scope without forceNew throws PendingCandidateClaimIntentConflictError and never rewrites the persisted receipt',async()=>{
  const a=await draft.getOrCreateCandidateClaimReceipt(p,i,'A');
  const rawA=sessionStorage.getItem(draft.CANDIDATE_CLAIM_PENDING_KEY);
  expect(rawA).toBeTruthy();
  vi.resetModules();
  const fresh=await import('./candidate-claim-draft');
  let conflict:unknown=null;
  try{await fresh.getOrCreateCandidateClaimReceipt(p,i,'B');}catch(e){conflict=e;}
  expect(conflict).toBeInstanceOf(fresh.PendingCandidateClaimIntentConflictError);
  expect(fresh.loadPendingCandidateClaimReceipt()).toEqual(a);
  expect(sessionStorage.getItem(fresh.CANDIDATE_CLAIM_PENDING_KEY)).toBe(rawA);
  const forced=await fresh.getOrCreateCandidateClaimReceipt(p,i,'B',true);
  expect(forced.idempotencyKey).not.toBe(a.idempotencyKey);
});
it('denied writes keep the guard and still preserve the explicit retry key in memory',async()=>{const a=await draft.getOrCreateCandidateClaimReceipt(p,i,'A');const raw=sessionStorage.getItem(draft.CANDIDATE_CLAIM_PENDING_KEY);vi.stubGlobal('sessionStorage',{getItem:()=>raw,setItem(){throw Error('write denied');},removeItem(){}});await expect(draft.getOrCreateCandidateClaimReceipt(p,i,'B')).rejects.toBeInstanceOf(draft.PendingCandidateClaimIntentConflictError);const b=await draft.getOrCreateCandidateClaimReceipt(p,i,'B',true);expect(b.idempotencyKey).not.toBe(a.idempotencyKey);expect((await draft.getOrCreateCandidateClaimReceipt(p,i,'B')).idempotencyKey).toBe(b.idempotencyKey);});
it('clear tombstone survives failed remove',async()=>{await draft.getOrCreateCandidateClaimReceipt(p,i,'A');const raw=sessionStorage.getItem(draft.CANDIDATE_CLAIM_PENDING_KEY);vi.stubGlobal('sessionStorage',{getItem:()=>raw,setItem(){},removeItem(){throw Error('remove denied');}});draft.clearPendingCandidateClaimReceipt();expect(draft.loadPendingCandidateClaimReceipt()).toBeNull();});
it('fresh restore caches before later read failure',async()=>{const a=await draft.getOrCreateCandidateClaimReceipt(p,i,'A');vi.resetModules();const fresh=await import('./candidate-claim-draft');expect(fresh.loadPendingCandidateClaimReceipt()).toEqual(a);vi.stubGlobal('sessionStorage',{getItem(){throw Error('read denied');},setItem(){},removeItem(){}});expect((await fresh.getOrCreateCandidateClaimReceipt(p,i,'A')).idempotencyKey).toBe(a.idempotencyKey);});
it.each(['missing','invalid','unreadable'])('initial %s storage can recover later',async kind=>{const a=await draft.getOrCreateCandidateClaimReceipt(p,i,'A');const raw=sessionStorage.getItem(draft.CANDIDATE_CLAIM_PENDING_KEY);vi.resetModules();const fresh=await import('./candidate-claim-draft');vi.stubGlobal('sessionStorage',{getItem(){if(kind==='unreadable')throw Error();return kind==='missing'?null:'{bad';}});expect(fresh.loadPendingCandidateClaimReceipt()).toBeNull();vi.stubGlobal('sessionStorage',{getItem:()=>raw});expect(fresh.loadPendingCandidateClaimReceipt()).toEqual(a);});
