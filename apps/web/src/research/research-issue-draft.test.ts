// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RESEARCH_ISSUE_PENDING_KEY,
  clearPendingResearchIssueReceipt,
  getOrCreateResearchIssueReceipt,
  hashResearchIssueDraft,
  loadPendingResearchIssueReceipt,
  normalizeResearchIssueDraft,
  savePendingResearchIssueReceipt,
} from "./research-issue-draft";

const projectId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";

beforeEach(() => {
  sessionStorage.clear();
  clearPendingResearchIssueReceipt();
  vi.restoreAllMocks();
});

describe("research issue draft normalization", () => {
  it("matches server canonical normalization", () => {
    expect(normalizeResearchIssueDraft({ title: "  刘祥店迁出时间  ", question: "  第一行\r\n第二行\r第三行  " }))
      .toEqual({ title: "刘祥店迁出时间", question: "第一行\n第二行\n第三行" });
  });

  it("enforces single-line and Unicode code-point limits", () => {
    expect(normalizeResearchIssueDraft({ title: "𠮷".repeat(160), question: "𠮷".repeat(4000) })).toBeTruthy();
    expect(() => normalizeResearchIssueDraft({ title: "𠮷".repeat(161), question: "q" })).toThrow();
    expect(() => normalizeResearchIssueDraft({ title: "a\nb", question: "q" })).toThrow();
    expect(() => normalizeResearchIssueDraft({ title: "t", question: "𠮷".repeat(4001) })).toThrow();
  });

  it("hashes the lowercase Project and fixed-order canonical payload", async () => {
    const normalized = normalizeResearchIssueDraft({ title: " 刘祥店迁出时间 ", question: " 第一行\r\n第二行 " });
    const hash = await hashResearchIssueDraft(projectId, normalized);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await hashResearchIssueDraft(projectId.toLowerCase(), { title: "刘祥店迁出时间", question: "第一行\n第二行" }));
  });
});

describe("pending research issue receipt", () => {
  it("reuses same Project and normalized payload but rotates for changed intent", async () => {
    const a = normalizeResearchIssueDraft({ title: " title ", question: " q\r\n " });
    const first = await getOrCreateResearchIssueReceipt(projectId, a);
    const equivalent = await getOrCreateResearchIssueReceipt(projectId.toLowerCase(), normalizeResearchIssueDraft({ title: "title", question: "q" }));
    expect(equivalent.idempotencyKey).toBe(first.idempotencyKey);
    const changed = await getOrCreateResearchIssueReceipt(projectId, { title: "title 2", question: "q" });
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    const otherProject = await getOrCreateResearchIssueReceipt("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { title: "title 2", question: "q" });
    expect(otherProject.idempotencyKey).not.toBe(changed.idempotencyKey);
    const forced = await getOrCreateResearchIssueReceipt("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", { title: "title 2", question: "q" }, true);
    expect(forced.idempotencyKey).not.toBe(otherProject.idempotencyKey);
  });

  it("stores only the four receipt fields and validates storage input", async () => {
    const receipt = await getOrCreateResearchIssueReceipt(projectId, { title: "title", question: "question" });
    expect(Object.keys(JSON.parse(sessionStorage.getItem(RESEARCH_ISSUE_PENDING_KEY)!)).sort())
      .toEqual(["createdAt", "idempotencyKey", "projectId", "requestHash"]);
    expect(JSON.stringify(receipt)).not.toMatch(/title|question/);
    sessionStorage.setItem(RESEARCH_ISSUE_PENDING_KEY, "{bad");
    expect(loadPendingResearchIssueReceipt()).toBeNull();
    sessionStorage.setItem(RESEARCH_ISSUE_PENDING_KEY, JSON.stringify({ ...receipt, requestHash: "bad" }));
    expect(loadPendingResearchIssueReceipt()).toBeNull();
  });

  it("falls back to memory when sessionStorage is unavailable", () => {
    const broken = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
    vi.stubGlobal("sessionStorage", broken);
    const receipt = { projectId: projectId.toLowerCase(), requestHash: "a".repeat(64), idempotencyKey: "11111111-1111-4111-8111-111111111111", createdAt: new Date().toISOString() };
    savePendingResearchIssueReceipt(receipt);
    expect(loadPendingResearchIssueReceipt()).toEqual(receipt);
    clearPendingResearchIssueReceipt();
    expect(loadPendingResearchIssueReceipt()).toBeNull();
  });
});
