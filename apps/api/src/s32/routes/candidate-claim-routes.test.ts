import {IdempotencyConflictError,ProjectReadOnlyError} from "../application/research-issues.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { S32Config } from "../config.js";
import {
  createCandidateClaimsService,
  ResearchIssueReadOnlyError,
  CandidateClaimIntegrityError,
  CandidateClaimScopeNotFoundError,
  CandidateClaimStoreUnavailableError,
  type CandidateClaimStore,
} from "../application/candidate-claims.js";
import { createCandidateClaimRouter } from "./candidate-claim-routes.js";
import { createS32Router } from "../register.js";
import * as issueStoreModule from "../postgres/candidate-claim-store.js";
import * as projectStoreModule from "../postgres/project-store.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const key = "33333333-3333-4333-8333-333333333333";
const claim = {id:key,statement:"可能答案",lifecycleState:"ACTIVE" as const,createdAt:"2026-09-21T00:00:00Z",updatedAt:"2026-09-21T00:00:00Z"};
const path=`/${projectId}/issues/${issueId}/claims`;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); })));
  vi.restoreAllMocks();
});

function fakeStore(): CandidateClaimStore {
  return {
    create: vi.fn().mockResolvedValue({ status: "created", claim }),
    list: vi.fn().mockResolvedValue({ claims: [claim] }),
  };
}

async function setup(overrides: Partial<S32Config> = {}, missingService = false) {
  const store = fakeStore();
  const config: S32Config = { enabled: true, privateToken: "test-token", databaseUrl: "postgresql://local/test", ...overrides };
  const app = express();
  app.use(express.json());
  app.use("/api/private/s32/projects", createCandidateClaimRouter(config, missingService ? null : createCandidateClaimsService(store)));
  const server = await new Promise<Server>((resolve) => { const listening = app.listen(0, "127.0.0.1", () => resolve(listening)); });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/private/s32/projects`;
  const request = (method: string, path: string, options: { token?: string; body?: unknown; key?: string } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.token === "" ? {} : { Authorization: `Bearer ${options.token ?? "test-token"}` }),
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.key === undefined ? {} : { "Idempotency-Key": options.key }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { store, request };
}

it.each([[{enabled:false},"",404],[{privateToken:null},"",503],[{},"",401],[{},"wrong",403],[{databaseUrl:null},"test-token",503]])("auth fails before storage",async(config,token,status)=>{const s=await setup(config as Partial<S32Config>);for(const method of ["GET","POST"]){const r=await s.request(method,path,{token:token as string,key,body:method==="POST"?{statement:"s"}:undefined});expect(r.status).toBe(status);expect(r.headers.get("cache-control")).toBe("no-store");}expect(s.store.create).not.toHaveBeenCalled();expect(s.store.list).not.toHaveBeenCalled();});
it("creates 201, replays 200 and lists direct claims",async()=>{const s=await setup();expect((await s.request("POST",path,{key,body:{statement:"x"}})).status).toBe(201);vi.mocked(s.store.create).mockResolvedValue({status:"replayed",claim});const r=await s.request("POST",path,{key,body:{statement:"x"}});expect(r.status).toBe(200);expect(await r.json()).toEqual({claim});expect(await (await s.request("GET",path)).json()).toEqual({claims:[claim]});});
it.each([{}, {statement:""},{statement:"a\u0000b"}])("invalid input before store",async body=>{const s=await setup();const r=await s.request("POST",path,{key,body});expect(r.status).toBe(400);expect(await r.json()).toMatchObject({error:{code:"CLAIM_INVALID_INPUT"}});expect(s.store.create).not.toHaveBeenCalled();});
it.each([[new ProjectReadOnlyError("SECRET"),409,"PROJECT_READ_ONLY"],[new ResearchIssueReadOnlyError("SECRET"),409,"RESEARCH_ISSUE_READ_ONLY"],[new IdempotencyConflictError("SECRET"),409,"IDEMPOTENCY_CONFLICT"],[new CandidateClaimScopeNotFoundError("SECRET"),404,"PROJECT_OR_ISSUE_NOT_FOUND"],[new CandidateClaimIntegrityError("SECRET"),500,undefined],[new CandidateClaimStoreUnavailableError("SECRET"),503,undefined],[new Error("SQL SECRET"),500,undefined]])("safe errors",async(error,status,code)=>{const s=await setup();vi.mocked(s.store.create).mockRejectedValue(error);const r=await s.request("POST",path,{key,body:{statement:"x"}});expect(r.status).toBe(status);const b=await r.json() as any;expect(b.error.code).toBe(code);expect(JSON.stringify(b)).not.toContain("SECRET");if(code==="IDEMPOTENCY_CONFLICT")expect(b.error.message).toBe("创建请求标识与当前可能答案内容不一致。");});
it("missing scope and absent service fail closed",async()=>{const s=await setup();vi.mocked(s.store.list).mockResolvedValue(null);expect((await s.request("GET",path)).status).toBe(404);expect((await (await setup({},true)).request("GET",path)).status).toBe(503);});
it("registers with the existing shared Pool",()=>{const f=vi.spyOn(issueStoreModule,"createPostgresCandidateClaimStore").mockReturnValue(fakeStore());const p=vi.spyOn(projectStoreModule,"createPostgresProjectStore");createS32Router({env:{S32_FEATURES_ENABLED:"true",S32_PRIVATE_API_TOKEN:"test-token",S32_DATABASE_URL:"postgresql://local/test"},getCatalogDocument:vi.fn()});expect(f).toHaveBeenCalledOnce();expect(f.mock.calls[0][0]).toBe(p.mock.calls[0][0]);void f.mock.calls[0][0].end();});
