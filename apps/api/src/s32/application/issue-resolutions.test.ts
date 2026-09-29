import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Application from "./issue-resolutions.js";
import {
  encodeIssueResolutionCursor,
  hashIssueResolutionCreateRequest,
  normalizeIssueResolutionCreateInput,
  InvalidIssueResolutionInputError,
  type IssueResolutionDetailResponse,
  type IssueResolutionHistoryResponse,
} from "../domain/issue-resolution.js";
import { InvalidProjectInputError } from "../domain/project.js";
import { InvalidResearchIssueInputError, InvalidIdempotencyKeyError } from "../domain/research-issue.js";

// Only randomness is replaced. Real domain parsing/hashing remains exercised.
const uuid = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", async importOriginal => ({
  ...await importOriginal<typeof import("node:crypto")>(),
  randomUUID: uuid,
}));
const modulePath = "./issue-resolutions.js";
const api = existsSync(new URL("./issue-resolutions.ts", import.meta.url))
  ? await import(modulePath) as typeof Application : {} as typeof Application;
function contract<K extends keyof typeof Application>(name: K): typeof Application[K] {
  expect(api[name], `missing application contract: ${name}`).toBeTypeOf("function");
  return api[name];
}

const P = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const I = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const M = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const R = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const NEWER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const GENERATED = "11111111-1111-4111-8111-111111111111";
const GENERATED_2 = "22222222-2222-4222-8222-222222222222";
const KEY = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const A = "aabbccdd-aabb-4cdd-8aab-ccddaabbccdd";
const TIME = "2026-09-28T00:00:00.123456Z";
const NORMALIZED = { expectedCurrentResolutionId: R, resolutionType: "PREFERRED_CLAIM" as const, preferredClaimId: C, rationale: "第一行\n第二行  保持", evidenceManifestId: M };
const BODY = { ...NORMALIZED, expectedCurrentResolutionId: R.toUpperCase(), preferredClaimId: C.toUpperCase(), evidenceManifestId: M.toUpperCase(), rationale: "\u0085 第一行\r\n第二行  保持\r\n " };
const CURSOR = { createdAtMicros: "1790000000123456", id: R };
const HISTORY: IssueResolutionHistoryResponse = {
  issue: { id: I, lifecycleState: "RESOLVED", currentResolutionId: R, updatedAt: TIME },
  currentResolution: { id: R, issueId: I, resolutionType: "PREFERRED_CLAIM", preferredClaimId: C, rationaleExcerpt: null, createdAt: TIME, isCurrent: true, evidenceBasisAvailable: false, evidenceManifest: null },
  resolutions: [{ id: NEWER, issueId: I, resolutionType: "INSUFFICIENT_EVIDENCE", preferredClaimId: null, rationaleExcerpt: "newer historical row", createdAt: "2026-09-28T00:00:01.000001Z", isCurrent: false, evidenceBasisAvailable: false, evidenceManifest: null }],
  nextCursor: encodeIssueResolutionCursor(CURSOR),
};
const DETAIL: IssueResolutionDetailResponse = {
  issue: HISTORY.issue,
  resolution: { id: R, issueId: I, resolutionType: "PREFERRED_CLAIM", preferredClaimId: C, rationale: null, createdAt: TIME, isCurrent: true },
  evidenceBasisAvailable: false,
  evidenceManifest: null,
};
const EVIDENCE: Application.IssueResolutionEvidenceBasesResponse = {
  issueId: I,
  evidenceBases: [{ assessmentId: A, claimId: C, claimStatementExcerpt: "可能答案", stance: "SUPPORTS", confidenceLevel: null, manifestId: M, manifestSha256: "a".repeat(64), itemCount: 2, assessmentCreatedAt: TIME }],
  nextCursor: encodeIssueResolutionCursor({ ...CURSOR, id: A }),
};
const ERROR_NAMES = [
  "IssueResolutionScopeNotFoundError", "IssueResolutionNotFoundError", "IssueResolutionInvalidPreferredClaimError",
  "IssueResolutionEvidenceNotAvailableError", "IssueResolutionStaleError", "IssueResolutionIdempotencyConflictError",
  "ProjectReadOnlyForResolutionError", "ResearchIssueReadOnlyForResolutionError", "IssueResolutionIntegrityError",
  "IssueResolutionStoreUnavailableError",
] as const;

function setup() {
  const history = structuredClone(HISTORY), detail = structuredClone(DETAIL), evidence = structuredClone(EVIDENCE);
  const commandStore = {
    create: vi.fn<Application.IssueResolutionCommandStore["create"]>(async command => ({ status: "created", resolutionId: command.resolutionId })),
  };
  const readStore = {
    list: vi.fn<Application.IssueResolutionReadStore["list"]>().mockResolvedValue({ kind: "ok", value: history }),
    get: vi.fn<Application.IssueResolutionReadStore["get"]>().mockResolvedValue({ kind: "ok", value: detail }),
    listEvidenceBases: vi.fn<Application.IssueResolutionReadStore["listEvidenceBases"]>().mockResolvedValue({ kind: "ok", value: evidence }),
  };
  const service = contract("createIssueResolutionsService")(commandStore, readStore);
  return { service, commandStore, readStore, history, detail, evidence };
}
beforeEach(() => { uuid.mockReset().mockReturnValue(GENERATED); });

describe("IssueResolution application error contracts", () => {
  it.each(ERROR_NAMES)("exports distinct Error class %s for later store/route classification", name => {
    const ErrorType = contract(name);
    const error = new ErrorType("failure");
    expect(error).toBeInstanceOf(Error);
    for (const other of ERROR_NAMES.filter(x => x !== name)) expect(error).not.toBeInstanceOf(contract(other));
  });
});

describe("IssueResolution create composition", () => {
  it("canonicalizes scope/key/body and forwards the exact domain request hash", async () => {
    const { service, commandStore } = setup();
    await service.create(P.toUpperCase(), I.toUpperCase(), KEY.toUpperCase(), BODY);
    expect(normalizeIssueResolutionCreateInput(BODY)).toEqual(NORMALIZED);
    expect(commandStore.create).toHaveBeenCalledExactlyOnceWith({
      projectId: P, issueId: I, idempotencyKey: KEY, resolutionId: GENERATED,
      requestHash: hashIssueResolutionCreateRequest(P, I, NORMALIZED),
      ...NORMALIZED,
    });
  });
  it("generates exactly one Resolution ID per create and forwards that same ID", async () => {
    const { service, commandStore } = setup();
    uuid.mockReturnValueOnce(GENERATED).mockReturnValueOnce(GENERATED_2);
    expect(await service.create(P, I, KEY, BODY)).toEqual({ status: "created", resolutionId: GENERATED });
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(commandStore.create.mock.calls[0]![0].resolutionId).toBe(GENERATED);
    expect(await service.create(P, I, M, BODY)).toEqual({ status: "created", resolutionId: GENERATED_2 });
    expect(uuid).toHaveBeenCalledTimes(2);
    expect(commandStore.create).toHaveBeenCalledTimes(2);
    expect(commandStore.create.mock.calls[1]![0].resolutionId).toBe(GENERATED_2);
  });
  it("returns the created store result unchanged without an extra lookup", async () => {
    const { service, commandStore, readStore } = setup();
    const created: Application.IssueResolutionCommandResult = { status: "created", resolutionId: GENERATED };
    commandStore.create.mockResolvedValueOnce(created);
    expect(await service.create(P, I, KEY, BODY)).toBe(created);
    for (const method of Object.values(readStore)) expect(method).not.toHaveBeenCalled();
  });
  it("preserves the original replayed Resolution identity without a second ID, lookup or command", async () => {
    const { service, commandStore, readStore } = setup();
    const replayed: Application.IssueResolutionCommandResult = { status: "replayed", resolutionId: R };
    commandStore.create.mockResolvedValueOnce(replayed);
    expect(await service.create(P, I, KEY, { ...BODY, expectedCurrentResolutionId: null })).toBe(replayed);
    expect(uuid).toHaveBeenCalledTimes(1);
    expect(commandStore.create).toHaveBeenCalledTimes(1);
    expect(commandStore.create.mock.calls[0]![0]).toMatchObject({ resolutionId: GENERATED, expectedCurrentResolutionId: null });
    expect(replayed.resolutionId).not.toBe(GENERATED);
    for (const method of Object.values(readStore)) expect(method).not.toHaveBeenCalled();
  });
  it.each([
    ["project", "bad", I, KEY, BODY, InvalidProjectInputError],
    ["issue", P, "bad", KEY, BODY, InvalidResearchIssueInputError],
    ["key", P, I, "bad", BODY, InvalidIdempotencyKeyError],
    ["body", P, I, KEY, { ...BODY, rationale: " " }, InvalidIssueResolutionInputError],
  ] as const)("rejects invalid %s before ID generation or store access", async (_label, project, issue, key, body, ErrorType) => {
    const { service, commandStore, readStore } = setup();
    await expect(service.create(project, issue, key, body)).rejects.toBeInstanceOf(ErrorType);
    expect(uuid).not.toHaveBeenCalled();
    expect(commandStore.create).not.toHaveBeenCalled();
    for (const method of Object.values(readStore)) expect(method).not.toHaveBeenCalled();
  });
  it.each(["resolutionId", "createdAt", "updatedAt", "actorId", "contributionId", "requestHash"])("rejects client-supplied %s", async field => {
    const { service, commandStore } = setup();
    await expect(service.create(P, I, KEY, { ...BODY, [field]: GENERATED })).rejects.toBeInstanceOf(InvalidIssueResolutionInputError);
    expect(uuid).not.toHaveBeenCalled();
    expect(commandStore.create).not.toHaveBeenCalled();
  });
  it.each(ERROR_NAMES)("preserves command-store %s without guessing DB state or retrying", async name => {
    const { service, commandStore, readStore } = setup();
    const error = new (contract(name))("store responsibility");
    commandStore.create.mockRejectedValueOnce(error);
    await expect(service.create(P, I, KEY, BODY)).rejects.toBe(error);
    expect(commandStore.create).toHaveBeenCalledTimes(1);
    expect(uuid).toHaveBeenCalledTimes(1);
    for (const method of Object.values(readStore)) expect(method).not.toHaveBeenCalled();
  });
});

describe("IssueResolution history/current and detail composition", () => {
  it("forwards canonical history scope, limit and exact microsecond cursor", async () => {
    const { service, readStore, history } = setup();
    expect(await service.list(P.toUpperCase(), I.toUpperCase(), { limit: "50", cursor: encodeIssueResolutionCursor(CURSOR) })).toBe(history);
    expect(readStore.list).toHaveBeenCalledExactlyOnceWith({ projectId: P, issueId: I, limit: 50, cursor: CURSOR });
    expect(uuid).not.toHaveBeenCalled();
  });
  it("does not infer current resolution from newest history row", async () => {
    const { service, readStore, history } = setup();
    const before = structuredClone(history);
    expect(history.resolutions[0]!.id).not.toBe(history.issue.currentResolutionId);
    expect(history.currentResolution!.id).toBe(history.issue.currentResolutionId);
    const result = await service.list(P, I, {});
    expect(result).toBe(history);
    expect(result).toEqual(before);
    expect(result.issue.currentResolutionId).toBe(R);
    expect(result.currentResolution!.id).toBe(R);
    expect(result.resolutions[0]!.id).toBe(NEWER);
    expect(readStore.get).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
  });
  it.each([false, true])("accepts null authoritative current with nonempty history=%s", async nonempty => {
    const { service, readStore, history } = setup();
    const value: IssueResolutionHistoryResponse = { ...history, issue: { ...history.issue, currentResolutionId: null }, currentResolution: null, resolutions: nonempty ? history.resolutions : [], nextCursor: null };
    readStore.list.mockResolvedValueOnce({ kind: "ok", value });
    expect(await service.list(P, I, undefined)).toBe(value);
    expect(readStore.list).toHaveBeenCalledExactlyOnceWith({ projectId: P, issueId: I, limit: 20, cursor: null });
  });
  it("canonicalizes detail lookup and returns the read value including historical null rationale", async () => {
    const { service, readStore, detail } = setup();
    expect(await service.get(P.toUpperCase(), I.toUpperCase(), R.toUpperCase())).toBe(detail);
    expect(readStore.get).toHaveBeenCalledExactlyOnceWith({ projectId: P, issueId: I, resolutionId: R });
    expect(detail.resolution.rationale).toBeNull();
    expect(uuid).not.toHaveBeenCalled();
  });
  it("maps scope-missing detail to the scope error", async () => {
    const { service, readStore } = setup();
    readStore.get.mockResolvedValueOnce({ kind: "scope-missing" });
    await expect(service.get(P, I, R)).rejects.toBeInstanceOf(contract("IssueResolutionScopeNotFoundError"));
  });
  it.each(["not-visible", "not-found"] as const)("maps %s detail to Resolution not-found", async kind => {
    const { service, readStore } = setup();
    readStore.get.mockResolvedValueOnce({ kind });
    await expect(service.get(P, I, R)).rejects.toBeInstanceOf(contract("IssueResolutionNotFoundError"));
  });
});

describe("issue-wide evidence basis application contract", () => {
  it("forwards canonical project/issue/query and returns compact evidence values unchanged", async () => {
    const { service, readStore, evidence } = setup();
    const cursor = { createdAtMicros: "999999999999999999", id: A };
    expect(await service.listEvidenceBases(P.toUpperCase(), I.toUpperCase(), { limit: "1", cursor: encodeIssueResolutionCursor(cursor) })).toBe(evidence);
    expect(readStore.listEvidenceBases).toHaveBeenCalledExactlyOnceWith({ projectId: P, issueId: I, limit: 1, cursor });
    expect(evidence).toEqual(EVIDENCE);
    expect(readStore.list).not.toHaveBeenCalled();
    expect(readStore.get).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
  });
  it("passes default evidence history query without inventing filters or eligibility logic", async () => {
    const { service, readStore, evidence } = setup();
    expect(await service.listEvidenceBases(P, I, undefined)).toBe(evidence);
    expect(readStore.listEvidenceBases).toHaveBeenCalledExactlyOnceWith({ projectId: P, issueId: I, limit: 20, cursor: null });
  });
});

describe("read lookup boundaries", () => {
  it.each(["list", "listEvidenceBases"] as const)("maps missing scope for %s", async method => {
    const { service, readStore } = setup();
    readStore[method].mockResolvedValueOnce({ kind: "scope-missing" });
    await expect(service[method](P, I, {})).rejects.toBeInstanceOf(contract("IssueResolutionScopeNotFoundError"));
  });
  it.each(["list", "get", "listEvidenceBases"] as const)("rejects invalid scope for %s before any store/ID access", async method => {
    const { service, commandStore, readStore } = setup();
    const third = method === "get" ? R : {};
    await expect(service[method]("bad", I, third)).rejects.toBeInstanceOf(InvalidProjectInputError);
    await expect(service[method](P, "bad", third)).rejects.toBeInstanceOf(InvalidResearchIssueInputError);
    for (const store of [commandStore.create, ...Object.values(readStore)]) expect(store).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
  });
  it("rejects invalid Resolution ID before detail lookup", async () => {
    const { service, readStore } = setup();
    await expect(service.get(P, I, "bad")).rejects.toBeInstanceOf(InvalidIssueResolutionInputError);
    expect(readStore.get).not.toHaveBeenCalled();
  });
  it.each(["list", "listEvidenceBases"] as const)("rejects invalid %s query before store lookup", async method => {
    const { service, readStore } = setup();
    for (const query of [{ limit: "51" }, { cursor: "bad" }, { extra: "x" }]) await expect(service[method](P, I, query)).rejects.toThrow();
    expect(readStore[method]).not.toHaveBeenCalled();
  });
  it.each(["list", "get", "listEvidenceBases"] as const)("does not disguise integrity/unavailable/unexpected errors as not-found in %s", async method => {
    const { service, readStore } = setup();
    for (const error of [new (contract("IssueResolutionIntegrityError"))("integrity"), new (contract("IssueResolutionStoreUnavailableError"))("unavailable"), new Error("unexpected")]) {
      readStore[method].mockRejectedValueOnce(error);
      await expect(service[method](P, I, method === "get" ? R : {})).rejects.toBe(error);
    }
    expect(readStore[method]).toHaveBeenCalledTimes(3);
    expect(uuid).not.toHaveBeenCalled();
  });
});
