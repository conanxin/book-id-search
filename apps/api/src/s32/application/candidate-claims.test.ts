import { expect,it,vi } from 'vitest';
import { createCandidateClaimsService } from './candidate-claims.js';
import { hashCandidateClaimCreateRequest } from '../domain/candidate-claim.js';
const p='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',i='BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',k='CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC';
function setup(){const store={create:vi.fn(),list:vi.fn()};return {store,s:createCandidateClaimsService(store)};}
it('canonicalizes IDs and statement, generates Claim id and own hash',async()=>{const {store,s}=setup();await s.create(p,i,k,{statement:'\u0085 A\r\nB ',requestHash:'forged'});const input=store.create.mock.calls[0][0];expect(input).toMatchObject({projectId:p.toLowerCase(),issueId:i.toLowerCase(),idempotencyKey:k.toLowerCase(),statement:'A B',requestHash:hashCandidateClaimCreateRequest(p,i,'A B')});expect(input.claimId).toMatch(/^[a-f0-9-]{36}$/);});
it.each([['bad',i,k,{statement:'x'}],[p,'bad',k,{statement:'x'}],[p,i,'bad',{statement:'x'}],[p,i,k,null],[p,i,k,[]],[p,i,k,{statement:'\u0000'}],[p,i,k,{statement:' '}],[p,i,k,{statement:42}]])('rejects before store %j',async(a,b,c,d)=>{const {store,s}=setup();await expect(s.create(a,b,c,d)).rejects.toThrow();expect(store.create).not.toHaveBeenCalled();});
it('normalizes list IDs',async()=>{const {store,s}=setup();await s.list(p,i);expect(store.list).toHaveBeenCalledWith(p.toLowerCase(),i.toLowerCase());});
