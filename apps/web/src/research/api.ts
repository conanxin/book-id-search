import { normalizeCandidateClaimDraft } from "./candidate-claim-draft";
export interface Project {
  id: string;
  name: string;
  description: string | null;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}
import { ensureAuthSessionLoaded, getWebAuthSnapshot } from "../auth/session";

export class ProjectApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
const errorCodes: Record<string, { status: number; message: string }> = {
  CLAIM_INVALID_INPUT: { status: 400, message: "可能答案输入不正确。" },
  RESEARCH_ISSUE_READ_ONLY: { status: 409, message: "这个研究问题已经只读，不能添加新的可能答案。" },
  STALE_NOTE_REVISION: { status: 409, message: "笔记已经发生变化。请重新加载最新版本后，再决定如何处理当前草稿。" },
  PROJECT_ITEM_HAS_NOTE: { status: 409, message: "这项资料已有研究笔记，暂不能直接移出项目。" },
  NOTE_ALREADY_EXISTS: { status: 409, message: "这项资料已有研究笔记，请重新加载。" },
  NOTE_INVALID_INPUT: { status: 400, message: "笔记输入不正确，正文不能为空且不能超过 65536 UTF-8 字节。" },
  PROJECT_READ_ONLY: { status: 409, message: "这个项目已归档，只能查看。" },
  IDEMPOTENCY_CONFLICT: { status: 409, message: "创建请求标识与当前研究问题内容不一致。" },
  EVIDENCE_DRAFT_INVALID: { status: 400, message: "证据草稿输入不正确。" },
  PROJECT_ISSUE_OR_CLAIM_NOT_FOUND: { status: 404, message: "研究问题或可能答案不存在。" },
  EVIDENCE_TARGET_NOT_AVAILABLE: { status: 404, message: "所选证据不可用于当前研究项目。" },
  ASSESSMENT_INVALID: { status: 400, message: "评价输入不正确。" },
  ASSESSMENT_CURSOR_INVALID: { status: 400, message: "评价历史游标不正确。" },
  ASSESSMENT_NOT_FOUND: { status: 404, message: "该评价当前不可用。" },
  EVIDENCE_PREVIEW_STALE: { status: 409, message: "证据集自上次预览后已发生变化，请重新预览。" },
  ASSESSMENT_STORE_UNAVAILABLE: { status: 503, message: "评价服务暂不可用。" },
  ISSUE_RESOLUTION_INVALID: { status: 400, message: "工作结论输入不正确。" },
  ISSUE_RESOLUTION_NOT_FOUND: { status: 404, message: "该工作结论当前不可用。" },
  PREFERRED_CLAIM_NOT_AVAILABLE: { status: 404, message: "所选可能答案当前不可用。" },
  EVIDENCE_MANIFEST_NOT_AVAILABLE: { status: 404, message: "所选证据依据当前不可用。" },
  ISSUE_RESOLUTION_STALE: { status: 409, message: "当前工作结论已发生变化，请刷新后再提交。" },
  ISSUE_RESOLUTION_STORE_UNAVAILABLE: { status: 503, message: "工作结论服务暂不可用。" },
};
const statusMessages: Record<number, string> = {
  400: "请检查项目或书目输入。",
  409: "项目或书目状态冲突，请刷新后再试。",
  422: "书目元数据无法加入研究。",
  401: "登录已失效，请重新登录。",
  403: "登录安全校验失败，请刷新后重试。",
  404: "项目不存在，或研究项目功能尚未开启。",
  503: "研究项目服务暂不可用，请稍后再试。",
};
export interface ProjectResearchItem {
  bindingId: string;
  projectId: string;
  workId: string;
  editionId: string;
  sourceId: string | null;
  catalogBookId: string | null;
  title: string;
  publisher: string | null;
  publicationDate: string | null;
  publicationDatePrecision: "YEAR" | "MONTH" | "DAY";
  isbn: string | null;
  addedAt: string;
}

const S32_ROOT = "/api/private/s32";
type SafeErrorMap = Record<string, { status: number; message: string }>;
type RequestOptions = { method?: "GET" | "POST" | "DELETE"; input?: unknown; signal?: AbortSignal; idempotencyKey?: string; contextualErrorCodes?: SafeErrorMap };
async function request<T>(path: string, options: RequestOptions, valid: (body: any, status: number) => boolean): Promise<T> {
  const { method = "GET", input, signal, idempotencyKey, contextualErrorCodes } = options;
  const snapshot = getWebAuthSnapshot();
  if (snapshot.status !== "authenticated") {
    // No private request leaves the browser without an authenticated session.
    throw new ProjectApiError(401, "请先使用 Google 登录。");
  }
  if (method !== "GET" && snapshot.csrfToken === null) {
    // Unsafe method without an in-memory CSRF token: fail before any fetch.
    throw new ProjectApiError(403, "登录安全校验失败，请刷新后重试。");
  }
  const headers: Record<string, string> = {
    ...(input !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    ...(method !== "GET" ? { "X-CSRF-Token": snapshot.csrfToken as string } : {}),
  };
  const response = await fetch(`${S32_ROOT}${path}`, {
    method, cache: "no-store", credentials: "same-origin", signal, headers,
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const code = typeof body?.error?.code === "string" ? body.error.code : undefined;
    const contextual = code && contextualErrorCodes && Object.hasOwn(contextualErrorCodes, code)
      ? contextualErrorCodes[code]
      : undefined;
    const known = contextual ?? (code && Object.hasOwn(errorCodes, code) ? errorCodes[code] : undefined);
    if (response.status === 401 || response.status === 403) {
      // Align global session state with the server once; the safe message below
      // never echoes the raw response body.
      void ensureAuthSessionLoaded();
    }
    if (known?.status === response.status) throw new ProjectApiError(response.status, known.message, code);
    throw new ProjectApiError(response.status, statusMessages[response.status] ?? "项目请求失败，请稍后再试。");
  }
  if (method === "DELETE") {
    if (response.status !== 204) throw new ProjectApiError(502, "项目服务响应异常，请稍后再试。");
    return undefined as T;
  }
  const body = await response.json().catch(() => null);
  if (!body || !valid(body, response.status)) throw new ProjectApiError(502, "项目服务响应异常，请稍后再试。");
  return body as T;
}
export const listProjects = (signal?: AbortSignal) => request<{ projects: Project[] }>("/projects", { signal }, b => Array.isArray(b.projects));
export const getProject = (id: string, signal?: AbortSignal) => request<{ project: Project }>(`/projects/${encodeURIComponent(id)}`, { signal }, b => !!b.project);
export const createProject = (input: { name: string; description: string | null }, signal?: AbortSignal) => request<{ project: Project }>("/projects", { method: "POST", input: { name: input.name, description: input.description }, signal }, b => !!b.project);

export interface AddProjectItemResult {
  promotionStatus: "created" | "existing";
  bindingStatus: "created" | "existing";
  item: ProjectResearchItem;
}
function isItem(value: any): value is ProjectResearchItem {
  if (!value || typeof value !== "object") return false;
  return ["bindingId", "projectId", "workId", "editionId", "title", "addedAt"].every(k => typeof value[k] === "string" && value[k].length > 0)
    && ["sourceId", "catalogBookId", "publisher", "publicationDate", "isbn"].every(k => value[k] === null || typeof value[k] === "string")
    && ["YEAR", "MONTH", "DAY"].includes(value.publicationDatePrecision);
}
export const addCatalogBookToProject = (projectId: string, bookId: string, signal?: AbortSignal) =>
  request<AddProjectItemResult>(`/projects/${encodeURIComponent(projectId)}/catalog-books`, { method: "POST", input: { bookId }, signal },
    b => ["created", "existing"].includes(b.promotionStatus) && ["created", "existing"].includes(b.bindingStatus) && isItem(b.item));
export const listProjectItems = (projectId: string, signal?: AbortSignal) =>
  request<{ items: ProjectResearchItem[] }>(`/projects/${encodeURIComponent(projectId)}/items`, { signal }, b => Array.isArray(b.items) && b.items.every(isItem));
export const removeProjectItem = (projectId: string, bindingId: string, signal?: AbortSignal) =>
  request<void>(`/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(bindingId)}`, { method: "DELETE", signal }, () => false);

export interface ProjectItemNoteRevisionSummary {
  revisionId: string;
  revisionNo: number;
  createdAt: string;
}
export interface ProjectItemNoteRevision extends ProjectItemNoteRevisionSummary {
  contentFormat: "MARKDOWN";
  content: string;
  contentSha256: string;
}
export interface ProjectItemNote {
  noteId: string;
  projectId: string;
  subjectBindingId: string;
  subjectId: string;
  createdAt: string;
  updatedAt: string;
  currentRevision: ProjectItemNoteRevision;
  revisions: ProjectItemNoteRevisionSummary[];
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function isDate(value: unknown) { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function isRevisionSummary(value: any): boolean {
  return !!value && isUuid(value.revisionId) && Number.isSafeInteger(value.revisionNo) && value.revisionNo > 0 && isDate(value.createdAt);
}
function isRevision(value: any): value is ProjectItemNoteRevision {
  return isRevisionSummary(value) && value.contentFormat === "MARKDOWN" && typeof value.content === "string"
    && typeof value.contentSha256 === "string" && /^[0-9a-f]{64}$/.test(value.contentSha256);
}
function isNote(value: any): value is ProjectItemNote {
  return !!value && ["noteId", "projectId", "subjectBindingId", "subjectId"].every(k => isUuid(value[k]))
    && isDate(value.createdAt) && isDate(value.updatedAt) && isRevision(value.currentRevision)
    && Array.isArray(value.revisions) && value.revisions.length > 0 && value.revisions.every(isRevisionSummary)
    && value.revisions[0].revisionId === value.currentRevision.revisionId && value.revisions[0].revisionNo === value.currentRevision.revisionNo;
}
const notePath = (projectId: string, bindingId: string) => `/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(bindingId)}/note`;
export const getProjectItemNote = (projectId: string, bindingId: string, signal?: AbortSignal) =>
  request<{ note: ProjectItemNote | null }>(notePath(projectId, bindingId), { signal }, b => b.note === null || isNote(b.note));
export const createProjectItemNote = (projectId: string, bindingId: string, content: string, signal?: AbortSignal) =>
  request<{ note: ProjectItemNote }>(notePath(projectId, bindingId), { method: "POST", input: { content }, signal }, b => isNote(b.note));
export const appendProjectItemNoteRevision = (projectId: string, bindingId: string, baseRevisionId: string, content: string, signal?: AbortSignal) =>
  request<{ note: ProjectItemNote }>(`${notePath(projectId, bindingId)}/revisions`, { method: "POST", input: { baseRevisionId, content }, signal }, b => isNote(b.note));
export const getProjectItemNoteRevision = (projectId: string, bindingId: string, revisionId: string, signal?: AbortSignal) =>
  request<{ revision: ProjectItemNoteRevision }>(`${notePath(projectId, bindingId)}/revisions/${encodeURIComponent(revisionId)}`, { signal }, b => isRevision(b.revision));

export interface ResearchMembership {
  projectId: string;
  projectName: string;
  projectLifecycleState: "ACTIVE" | "ARCHIVED";
  bindingId: string;
  hasNote: boolean;
  noteUpdatedAt: string | null;
}

export type MembershipResponse = {
  memberships: Record<string, ResearchMembership[]>;
};

export interface ProjectOverviewNoteSummary {
  noteId: string;
  currentRevisionId: string;
  currentRevisionNo: number;
  excerpt: string;
  updatedAt: string;
}

export interface ProjectOverviewItem {
  bindingId: string;
  workId: string;
  editionId: string;
  sourceId: string | null;
  catalogBookId: string | null;
  title: string;
  publisher: string | null;
  publicationDate: string | null;
  publicationDatePrecision: "YEAR" | "MONTH" | "DAY";
  isbn: string | null;
  addedAt: string;
  activityAt: string;
  noteSummary: ProjectOverviewNoteSummary | null;
}

export interface ProjectOverview {
  project: Project & { readOnly: boolean };
  summary: {
    itemCount: number;
    noteCount: number;
    lastActivityAt: string | null;
  };
  items: ProjectOverviewItem[];
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isMembership(value: any): value is ResearchMembership {
  return !!value && typeof value === "object"
    && isUuid(value.projectId)
    && typeof value.projectName === "string" && value.projectName.length > 0
    && ["ACTIVE", "ARCHIVED"].includes(value.projectLifecycleState)
    && isUuid(value.bindingId)
    && typeof value.hasNote === "boolean"
    && (value.noteUpdatedAt === null || isDate(value.noteUpdatedAt));
}

function isMembershipResponse(value: any, bookIds: string[]): value is MembershipResponse {
  if (!value || typeof value !== "object" || !value.memberships || typeof value.memberships !== "object" || Array.isArray(value.memberships)) return false;
  return bookIds.every(bookId => Object.hasOwn(value.memberships, bookId)
    && Array.isArray(value.memberships[bookId])
    && value.memberships[bookId].every(isMembership));
}

function isProject(value: any): value is Project {
  return !!value && typeof value === "object"
    && isUuid(value.id)
    && typeof value.name === "string" && value.name.length > 0
    && isNullableString(value.description)
    && ["ACTIVE", "ARCHIVED"].includes(value.lifecycleState)
    && isDate(value.createdAt)
    && isDate(value.updatedAt);
}

function isOverviewNoteSummary(value: any): value is ProjectOverviewNoteSummary {
  return !!value && typeof value === "object"
    && isUuid(value.noteId)
    && isUuid(value.currentRevisionId)
    && Number.isSafeInteger(value.currentRevisionNo) && value.currentRevisionNo > 0
    && typeof value.excerpt === "string"
    && isDate(value.updatedAt);
}

function isOverviewItem(value: any): value is ProjectOverviewItem {
  return !!value && typeof value === "object"
    && ["bindingId", "workId", "editionId"].every(key => isUuid(value[key]))
    && (value.sourceId === null || isUuid(value.sourceId))
    && isNullableString(value.catalogBookId)
    && typeof value.title === "string" && value.title.length > 0
    && ["publisher", "publicationDate", "isbn"].every(key => isNullableString(value[key]))
    && ["YEAR", "MONTH", "DAY"].includes(value.publicationDatePrecision)
    && isDate(value.addedAt)
    && isDate(value.activityAt)
    && (value.noteSummary === null || isOverviewNoteSummary(value.noteSummary));
}

function isProjectOverview(value: any): value is ProjectOverview {
  if (!value || typeof value !== "object" || !isProject(value.project)) return false;
  if (typeof value.project.readOnly !== "boolean"
    || value.project.readOnly !== (value.project.lifecycleState === "ARCHIVED")) return false;
  if (!value.summary || typeof value.summary !== "object"
    || !Number.isSafeInteger(value.summary.itemCount) || value.summary.itemCount < 0
    || !Number.isSafeInteger(value.summary.noteCount) || value.summary.noteCount < 0
    || !(value.summary.lastActivityAt === null || isDate(value.summary.lastActivityAt))) return false;
  return Array.isArray(value.items) && value.items.every(isOverviewItem);
}

export const getResearchMemberships = (bookIds: string[], signal?: AbortSignal) =>
  request<MembershipResponse>("/research-memberships/catalog-books", { method: "POST", input: { bookIds }, signal },
    body => isMembershipResponse(body, bookIds));

export const getProjectOverview = (projectId: string, signal?: AbortSignal) =>
  request<ProjectOverview>(`/projects/${encodeURIComponent(projectId)}/overview`, { signal }, isProjectOverview);

export interface ResearchIssueProjectContext {
  id: string;
  name: string;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  readOnly: boolean;
}

export interface ResearchIssue {
  id: string;
  projectId: string;
  title: string;
  question: string;
  lifecycleState: "OPEN" | "RESOLVED" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}

export interface ResearchIssueSummary {
  id: string;
  projectId: string;
  title: string;
  questionExcerpt: string;
  lifecycleState: "OPEN" | "RESOLVED" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}

export interface ResearchIssueListResponse {
  project: ResearchIssueProjectContext;
  issues: ResearchIssueSummary[];
}

export interface ResearchIssueDetailResponse {
  project: ResearchIssueProjectContext;
  issue: ResearchIssue;
}

function isResearchIssueProject(value: any): value is ResearchIssueProjectContext {
  return !!value && typeof value === "object"
    && isUuid(value.id)
    && typeof value.name === "string" && value.name.length > 0
    && ["ACTIVE", "ARCHIVED"].includes(value.lifecycleState)
    && typeof value.readOnly === "boolean"
    && value.readOnly === (value.lifecycleState === "ARCHIVED");
}

function isResearchIssueBase(value: any): boolean {
  return !!value && typeof value === "object"
    && isUuid(value.id)
    && isUuid(value.projectId)
    && typeof value.title === "string" && value.title.length > 0
    && ["OPEN", "RESOLVED", "ARCHIVED"].includes(value.lifecycleState)
    && isDate(value.createdAt)
    && isDate(value.updatedAt);
}

function isResearchIssue(value: any): value is ResearchIssue {
  return isResearchIssueBase(value) && typeof value.question === "string" && value.question.length > 0;
}

function isResearchIssueSummary(value: any): value is ResearchIssueSummary {
  return isResearchIssueBase(value) && typeof value.questionExcerpt === "string";
}

function isResearchIssueListResponse(value: any): value is ResearchIssueListResponse {
  return !!value && isResearchIssueProject(value.project)
    && Array.isArray(value.issues)
    && value.issues.every((issue: unknown) => isResearchIssueSummary(issue) && issue.projectId === value.project.id);
}

function isResearchIssueDetailResponse(value: any): value is ResearchIssueDetailResponse {
  return !!value && isResearchIssueProject(value.project)
    && isResearchIssue(value.issue)
    && value.issue.projectId === value.project.id;
}

export const createResearchIssue = (
  projectId: string,
  idempotencyKey: string,
  input: { title: string; question: string },
  signal?: AbortSignal,
) => request<ResearchIssueDetailResponse>(
  `/projects/${encodeURIComponent(projectId)}/issues`,
  { method: "POST", input: { title: input.title, question: input.question }, signal, idempotencyKey },
  isResearchIssueDetailResponse,
);

export const listResearchIssues = (projectId: string, signal?: AbortSignal) =>
  request<ResearchIssueListResponse>(`/projects/${encodeURIComponent(projectId)}/issues`, { signal }, isResearchIssueListResponse);

export const getResearchIssue = (projectId: string, issueId: string, signal?: AbortSignal) =>
  request<ResearchIssueDetailResponse>(`/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`, { signal }, isResearchIssueDetailResponse);

export interface CandidateClaim {
  id: string;
  statement: string;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}
function isCandidateClaim(value: any): value is CandidateClaim {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.id)) return false;
  try { if (normalizeCandidateClaimDraft(value.statement) !== value.statement) return false; } catch { return false; }
  return ["ACTIVE", "ARCHIVED"].includes(value.lifecycleState)
    && [value.createdAt, value.updatedAt].every(v => typeof v === "string" && Number.isFinite(Date.parse(v)));
}
export const listCandidateClaims = (projectId: string, issueId: string, signal?: AbortSignal) =>
  request<{ claims: CandidateClaim[] }>(`/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims`, { signal }, b => Array.isArray(b.claims) && b.claims.every(isCandidateClaim));
export async function createCandidateClaim(projectId: string, issueId: string, idempotencyKey: string, statement: string, signal?: AbortSignal): Promise<{ claim: CandidateClaim }> {
  try {
    return await request<{ claim: CandidateClaim }>(`/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims`, { method: "POST", input: { statement }, signal, idempotencyKey }, b => isCandidateClaim(b.claim));
  } catch (error) {
    if (error instanceof ProjectApiError && error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT") throw new ProjectApiError(409, "创建请求标识与当前可能答案内容不一致。", error.code);
    throw error;
  }
}

// ===== S32 M2-C Evidence Selection =====
export type EvidenceRole = "SUPPORTING" | "CONTRADICTORY" | "CONTEXTUAL";
export type EvidenceTargetType = "SOURCE" | "SOURCE_ASSET" | "NOTE_REVISION";
export type EvidenceSourceType =
  | "PUBLICATION" | "WEB_PAGE" | "ARCHIVAL_RECORD" | "DATABASE_RECORD"
  | "MUSEUM_OBJECT" | "EXHIBITION_LABEL" | "EMAIL"
  | "FIELD_OBSERVATION" | "INTERVIEW" | "OTHER";
export type EvidenceAssetType =
  | "DOCUMENT" | "IMAGE" | "AUDIO" | "VIDEO"
  | "WEB_SNAPSHOT" | "TEXT" | "DATA" | "OTHER";
export type EvidenceCandidate =
  | {
      targetType: "SOURCE";
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      sourceType: EvidenceSourceType;
      sourceLifecycleState: "ACTIVE" | "ARCHIVED";
      observedAt: string;
    }
  | {
      targetType: "SOURCE_ASSET";
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      sourceId: string;
      assetType: EvidenceAssetType;
      assetRole: "ORIGINAL" | "DERIVED";
      storageMode: "LOCAL" | "REMOTE" | "HYBRID";
      createdAt: string;
    }
  | {
      targetType: "NOTE_REVISION";
      targetId: string;
      materialBindingId: string;
      materialTitle: string;
      noteId: string;
      revisionNo: number;
      contentFormat: "MARKDOWN" | "PLAIN_TEXT";
      createdAt: string;
    };
export interface EvidenceClaimContext {
  id: string;
  statement: string;
  lifecycleState: "ACTIVE" | "ARCHIVED";
}
export interface EvidenceManifestDraftPreview {
  schemaVersion: 1;
  purpose: "CLAIM_ASSESSMENT";
  manifestSha256: string;
  items: Array<{
    ordinal: number;
    role: EvidenceRole;
    targetType: EvidenceTargetType;
    targetId: string;
    locatorType: null;
    locator: null;
    excerpt: null;
    note: string | null;
  }>;
}
export interface EvidencePreviewResponse {
  claim: { id: string; statement: string };
  draft: EvidenceManifestDraftPreview;
  persisted: false;
}
const evidenceRoles: ReadonlySet<string> = new Set(["SUPPORTING", "CONTRADICTORY", "CONTEXTUAL"]);
const evidenceTargetTypes: ReadonlySet<string> = new Set(["SOURCE", "SOURCE_ASSET", "NOTE_REVISION"]);
const evidenceSourceTypes: ReadonlySet<string> = new Set(["PUBLICATION", "WEB_PAGE", "ARCHIVAL_RECORD", "DATABASE_RECORD", "MUSEUM_OBJECT", "EXHIBITION_LABEL", "EMAIL", "FIELD_OBSERVATION", "INTERVIEW", "OTHER"]);
const evidenceAssetTypes: ReadonlySet<string> = new Set(["DOCUMENT", "IMAGE", "AUDIO", "VIDEO", "WEB_SNAPSHOT", "TEXT", "DATA", "OTHER"]);
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validTimestamp(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isEvidenceClaimContext(value: unknown): value is EvidenceClaimContext {
  return isPlainObject(value) && typeof value.id === "string" && uuidRe.test(value.id)
    && typeof value.statement === "string" && value.statement.length > 0
    && ["ACTIVE", "ARCHIVED"].includes(value.lifecycleState as string);
}
function isEvidenceCandidate(value: unknown): value is EvidenceCandidate {
  if (!isPlainObject(value)) return false;
  if (typeof value.targetId !== "string" || !uuidRe.test(value.targetId)) return false;
  if (typeof value.materialBindingId !== "string" || !uuidRe.test(value.materialBindingId)) return false;
  if (typeof value.materialTitle !== "string") return false;
  if (value.targetType === "SOURCE") {
    return evidenceSourceTypes.has(value.sourceType as string)
      && ["ACTIVE", "ARCHIVED"].includes(value.sourceLifecycleState as string)
      && validTimestamp(value.observedAt);
  }
  if (value.targetType === "SOURCE_ASSET") {
    return typeof value.sourceId === "string" && uuidRe.test(value.sourceId)
      && evidenceAssetTypes.has(value.assetType as string)
      && ["ORIGINAL", "DERIVED"].includes(value.assetRole as string)
      && ["LOCAL", "REMOTE", "HYBRID"].includes(value.storageMode as string)
      && validTimestamp(value.createdAt);
  }
  if (value.targetType === "NOTE_REVISION") {
    return typeof value.noteId === "string" && uuidRe.test(value.noteId)
      && typeof value.revisionNo === "number" && Number.isInteger(value.revisionNo) && value.revisionNo > 0
      && ["MARKDOWN", "PLAIN_TEXT"].includes(value.contentFormat as string)
      && validTimestamp(value.createdAt);
  }
  return false;
}
function isEvidenceDraft(value: unknown): value is EvidenceManifestDraftPreview {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== 1 || value.purpose !== "CLAIM_ASSESSMENT") return false;
  if (typeof value.manifestSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.manifestSha256)) return false;
  if (!Array.isArray(value.items) || value.items.length === 0) return false;
  const seen = new Set<string>();
  for (let index = 0; index < value.items.length; index += 1) {
    const item = value.items[index];
    if (!isPlainObject(item)) return false;
    if (item.ordinal !== index + 1) return false;
    if (!evidenceRoles.has(item.role as string)) return false;
    if (!evidenceTargetTypes.has(item.targetType as string)) return false;
    if (typeof item.targetId !== "string" || !uuidRe.test(item.targetId)) return false;
    if (item.locatorType !== null || item.locator !== null || item.excerpt !== null) return false;
    if (item.note !== null && typeof item.note !== "string") return false;
    const pair = `${item.targetType}:${item.targetId}`;
    if (seen.has(pair)) return false;
    seen.add(pair);
  }
  return true;
}
export const listEvidenceCandidates = (projectId: string, issueId: string, claimId: string, signal?: AbortSignal) =>
  request<{ claim: EvidenceClaimContext; candidates: EvidenceCandidate[] }>(
    `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims/${encodeURIComponent(claimId)}/evidence-candidates`,
    { signal },
    b => isPlainObject(b) && isEvidenceClaimContext(b.claim) && Array.isArray(b.candidates) && b.candidates.every(isEvidenceCandidate),
  );
export async function previewEvidenceManifest(
  projectId: string,
  issueId: string,
  claimId: string,
  items: Array<{ role: EvidenceRole; targetType: EvidenceTargetType; targetId: string; note: string | null }>,
  signal?: AbortSignal,
): Promise<EvidencePreviewResponse> {
  try {
    return await request<EvidencePreviewResponse>(
      `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims/${encodeURIComponent(claimId)}/evidence-manifest-preview`,
      { method: "POST", input: { items }, signal },
      b => isPlainObject(b) && Object.keys(b).length === 3 && isPlainObject(b.claim) && typeof b.claim.id === "string" && uuidRe.test(b.claim.id) && typeof b.claim.statement === "string"
        && b.persisted === false && isEvidenceDraft(b.draft),
    );
  } catch (error) {
    if (error instanceof ProjectApiError) {
      if (error.status === 400 && error.code === "EVIDENCE_DRAFT_INVALID") throw new ProjectApiError(400, "证据草稿输入不正确。", error.code);
      if (error.status === 404 && error.code === "PROJECT_ISSUE_OR_CLAIM_NOT_FOUND") throw new ProjectApiError(404, "研究问题或可能答案不存在。", error.code);
      if (error.status === 404 && error.code === "EVIDENCE_TARGET_NOT_AVAILABLE") throw new ProjectApiError(404, "所选证据不可用于当前研究项目。", error.code);
    }
    throw error;
  }
}


// ===== S32 M2-D Assessment =====
export type AssessmentStance = "SUPPORTS" | "CONTRADICTS" | "INCONCLUSIVE";
export type AssessmentConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

export interface AssessmentRecord {
  id: string;
  claimId: string;
  stance: AssessmentStance;
  confidenceLevel: AssessmentConfidenceLevel | null;
  actorId: string | null;
  numericScore: number | null;
  scoreKind: string | null;
  reasoning: string | null;
  createdAt: string;
}

export interface AssessmentManifestSummary {
  id: string;
  schemaVersion: 1;
  purpose: "CLAIM_ASSESSMENT";
  manifestSha256: string;
  itemCount: number;
}

export interface AssessmentSummary {
  id: string;
  stance: AssessmentStance;
  confidenceLevel: AssessmentConfidenceLevel | null;
  actorId: string | null;
  numericScore: number | null;
  scoreKind: string | null;
  reasoningExcerpt: string | null;
  createdAt: string;
  evidenceManifest: AssessmentManifestSummary;
}

export interface AssessmentHistoryResponse {
  claim: EvidenceClaimContext;
  assessments: AssessmentSummary[];
  nextCursor: string | null;
}

export interface AssessmentDetailResponse {
  claim: EvidenceClaimContext;
  assessment: AssessmentRecord;
  evidenceManifest: {
    id: string;
    schemaVersion: 1;
    purpose: "CLAIM_ASSESSMENT";
    manifestSha256: string;
    createdAt: string;
    items: Array<{
      ordinal: number;
      role: EvidenceRole;
      targetType: EvidenceTargetType;
      targetId: string;
      locatorType: null;
      locator: null;
      excerpt: null;
      note: string | null;
    }>;
  };
}

export interface CreateAssessmentInput {
  stance: AssessmentStance;
  confidenceLevel: AssessmentConfidenceLevel | null;
  reasoning: string;
  expectedManifestSha256: string;
  items: Array<{
    role: EvidenceRole;
    targetType: EvidenceTargetType;
    targetId: string;
    note: string | null;
  }>;
}

export type AssessmentCreateResponse =
  | {
      status: "created" | "replayed";
      visible: true;
      assessment: AssessmentRecord;
      evidenceManifest: AssessmentManifestSummary;
    }
  | {
      status: "replayed";
      visible: false;
      assessmentId: string;
    };

const assessmentStances: ReadonlySet<string> = new Set(["SUPPORTS", "CONTRADICTS", "INCONCLUSIVE"]);
const assessmentConfidences: ReadonlySet<string> = new Set(["LOW", "MEDIUM", "HIGH"]);

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isAssessmentScorePair(numericScore: unknown, scoreKind: unknown): boolean {
  if (numericScore === null && scoreKind === null) return true;
  return typeof numericScore === "number"
    && Number.isFinite(numericScore)
    && numericScore >= 0
    && numericScore <= 1
    && typeof scoreKind === "string"
    && scoreKind.trim().length > 0;
}

function isAssessmentRecord(value: unknown): value is AssessmentRecord {
  if (!isPlainObject(value) || !exactKeys(value, [
    "id", "claimId", "stance", "confidenceLevel", "actorId",
    "numericScore", "scoreKind", "reasoning", "createdAt",
  ])) return false;
  return isUuid(value.id)
    && isUuid(value.claimId)
    && assessmentStances.has(value.stance as string)
    && (value.confidenceLevel === null || assessmentConfidences.has(value.confidenceLevel as string))
    && (value.actorId === null || isUuid(value.actorId))
    && isAssessmentScorePair(value.numericScore, value.scoreKind)
    && (value.reasoning === null || typeof value.reasoning === "string")
    && validTimestamp(value.createdAt);
}

function isAssessmentManifestSummary(value: unknown): value is AssessmentManifestSummary {
  if (!isPlainObject(value) || !exactKeys(value, [
    "id", "schemaVersion", "purpose", "manifestSha256", "itemCount",
  ])) return false;
  return isUuid(value.id)
    && value.schemaVersion === 1
    && value.purpose === "CLAIM_ASSESSMENT"
    && typeof value.manifestSha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.manifestSha256)
    && Number.isSafeInteger(value.itemCount)
    && (value.itemCount as number) >= 1
    && (value.itemCount as number) <= 100;
}

function isAssessmentSummary(value: unknown): value is AssessmentSummary {
  if (!isPlainObject(value) || !exactKeys(value, [
    "id", "stance", "confidenceLevel", "actorId", "numericScore", "scoreKind",
    "reasoningExcerpt", "createdAt", "evidenceManifest",
  ])) return false;
  return isUuid(value.id)
    && assessmentStances.has(value.stance as string)
    && (value.confidenceLevel === null || assessmentConfidences.has(value.confidenceLevel as string))
    && (value.actorId === null || isUuid(value.actorId))
    && isAssessmentScorePair(value.numericScore, value.scoreKind)
    && (value.reasoningExcerpt === null || typeof value.reasoningExcerpt === "string")
    && validTimestamp(value.createdAt)
    && isAssessmentManifestSummary(value.evidenceManifest);
}

function isAssessmentHistoryResponse(value: unknown): value is AssessmentHistoryResponse {
  if (!isPlainObject(value) || !exactKeys(value, ["claim", "assessments", "nextCursor"])) return false;
  return isEvidenceClaimContext(value.claim)
    && Array.isArray(value.assessments)
    && value.assessments.every(isAssessmentSummary)
    && (value.nextCursor === null || typeof value.nextCursor === "string");
}

function isAssessmentManifestItem(value: unknown, index: number): boolean {
  if (!isPlainObject(value) || !exactKeys(value, [
    "ordinal", "role", "targetType", "targetId",
    "locatorType", "locator", "excerpt", "note",
  ])) return false;
  return value.ordinal === index + 1
    && evidenceRoles.has(value.role as string)
    && evidenceTargetTypes.has(value.targetType as string)
    && isUuid(value.targetId)
    && value.locatorType === null
    && value.locator === null
    && value.excerpt === null
    && (value.note === null || typeof value.note === "string");
}

function isAssessmentDetailResponse(value: unknown): value is AssessmentDetailResponse {
  if (!isPlainObject(value) || !exactKeys(value, ["claim", "assessment", "evidenceManifest"])) return false;
  if (!isEvidenceClaimContext(value.claim) || !isAssessmentRecord(value.assessment)) return false;
  const manifest = value.evidenceManifest;
  if (!isPlainObject(manifest) || !exactKeys(manifest, [
    "id", "schemaVersion", "purpose", "manifestSha256", "createdAt", "items",
  ])) return false;
  if (!isUuid(manifest.id)
    || manifest.schemaVersion !== 1
    || manifest.purpose !== "CLAIM_ASSESSMENT"
    || typeof manifest.manifestSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(manifest.manifestSha256)
    || !validTimestamp(manifest.createdAt)
    || !Array.isArray(manifest.items)
    || manifest.items.length < 1
    || manifest.items.length > 100) return false;
  return manifest.items.every((item, index) => isAssessmentManifestItem(item, index));
}

function isAssessmentCreateResponse(value: unknown): value is AssessmentCreateResponse {
  if (!isPlainObject(value)) return false;
  if (value.visible === false) {
    return exactKeys(value, ["status", "visible", "assessmentId"])
      && value.status === "replayed"
      && isUuid(value.assessmentId);
  }
  if (value.visible === true) {
    return exactKeys(value, ["status", "visible", "assessment", "evidenceManifest"])
      && ["created", "replayed"].includes(value.status as string)
      && isAssessmentRecord(value.assessment)
      && isAssessmentManifestSummary(value.evidenceManifest);
  }
  return false;
}

function assessmentPath(projectId: string, issueId: string, claimId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims/${encodeURIComponent(claimId)}/assessments`;
}

export async function createAssessment(
  projectId: string,
  issueId: string,
  claimId: string,
  idempotencyKey: string,
  input: CreateAssessmentInput,
  signal?: AbortSignal,
): Promise<AssessmentCreateResponse> {
  try {
    return await request<AssessmentCreateResponse>(
      assessmentPath(projectId, issueId, claimId),
      { method: "POST", input, signal, idempotencyKey },
      isAssessmentCreateResponse,
    );
  } catch (error) {
    if (error instanceof ProjectApiError && error.status === 409 && error.code === "IDEMPOTENCY_CONFLICT") {
      throw new ProjectApiError(409, "提交标识与当前评价内容不一致。", error.code);
    }
    throw error;
  }
}

export function listAssessments(
  projectId: string,
  issueId: string,
  claimId: string,
  query: { limit?: number; cursor?: string | null } = {},
  signal?: AbortSignal,
): Promise<AssessmentHistoryResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  const suffix = params.size ? `?${params.toString()}` : "";
  return request<AssessmentHistoryResponse>(
    assessmentPath(projectId, issueId, claimId) + suffix,
    { signal },
    isAssessmentHistoryResponse,
  );
}

export function getAssessment(
  projectId: string,
  issueId: string,
  claimId: string,
  assessmentId: string,
  signal?: AbortSignal,
): Promise<AssessmentDetailResponse> {
  return request<AssessmentDetailResponse>(
    assessmentPath(projectId, issueId, claimId) + `/${encodeURIComponent(assessmentId)}`,
    { signal },
    isAssessmentDetailResponse,
  );
}


// ===== S32 M2-E Issue Resolution =====
function validIssueResolutionTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export type IssueResolutionType = "PREFERRED_CLAIM" | "INSUFFICIENT_EVIDENCE" | "NO_WORKING_CONCLUSION";

export interface IssueResolutionIssueState {
  id: string;
  lifecycleState: "OPEN" | "RESOLVED" | "ARCHIVED";
  currentResolutionId: string | null;
  updatedAt: string;
}

export interface IssueResolutionSummary {
  id: string;
  issueId: string;
  resolutionType: IssueResolutionType;
  preferredClaimId: string | null;
  rationaleExcerpt: string | null;
  createdAt: string;
  isCurrent: boolean;
  evidenceBasisAvailable: boolean;
  evidenceManifest: AssessmentManifestSummary | null;
}

export interface IssueResolutionRecord {
  id: string;
  issueId: string;
  resolutionType: IssueResolutionType;
  preferredClaimId: string | null;
  rationale: string | null;
  createdAt: string;
  isCurrent: boolean;
}

export interface IssueResolutionHistoryResponse {
  issue: IssueResolutionIssueState;
  currentResolution: IssueResolutionSummary | null;
  resolutions: IssueResolutionSummary[];
  nextCursor: string | null;
}

export interface IssueResolutionDetailResponse {
  issue: IssueResolutionIssueState;
  resolution: IssueResolutionRecord;
  evidenceBasisAvailable: boolean;
  evidenceManifest: AssessmentDetailResponse["evidenceManifest"] | null;
}

export interface IssueResolutionEvidenceBasisSummary {
  assessmentId: string;
  claimId: string;
  claimStatementExcerpt: string;
  stance: AssessmentStance;
  confidenceLevel: AssessmentConfidenceLevel | null;
  manifestId: string;
  manifestSha256: string;
  itemCount: number;
  assessmentCreatedAt: string;
}

export interface IssueResolutionEvidenceBasesResponse {
  issueId: string;
  evidenceBases: IssueResolutionEvidenceBasisSummary[];
  nextCursor: string | null;
}

export interface CreateIssueResolutionInput {
  expectedCurrentResolutionId: string | null;
  resolutionType: IssueResolutionType;
  preferredClaimId: string | null;
  rationale: string;
  evidenceManifestId: string | null;
}

export interface IssueResolutionCreateResponse {
  status: "created" | "replayed";
  resolutionId: string;
}

const issueResolutionTypes: ReadonlySet<string> = new Set([
  "PREFERRED_CLAIM",
  "INSUFFICIENT_EVIDENCE",
  "NO_WORKING_CONCLUSION",
]);

function isIssueResolutionType(value: unknown): value is IssueResolutionType {
  return typeof value === "string" && issueResolutionTypes.has(value);
}

function hasValidIssueResolutionPreferredClaim(
  resolutionType: unknown,
  preferredClaimId: unknown,
): boolean {
  if (!isIssueResolutionType(resolutionType)) return false;
  return resolutionType === "PREFERRED_CLAIM"
    ? isUuid(preferredClaimId)
    : preferredClaimId === null;
}

function isIssueResolutionIssueState(value: unknown): value is IssueResolutionIssueState {
  if (!isPlainObject(value) || !exactKeys(value, [
    "id", "lifecycleState", "currentResolutionId", "updatedAt",
  ])) return false;
  return isUuid(value.id)
    && ["OPEN", "RESOLVED", "ARCHIVED"].includes(value.lifecycleState as string)
    && (value.currentResolutionId === null || isUuid(value.currentResolutionId))
    && validIssueResolutionTimestamp(value.updatedAt);
}

function hasIssueResolutionEvidence(
  value: Record<string, unknown>,
  validateManifest: (manifest: unknown) => boolean,
): boolean {
  if (typeof value.evidenceBasisAvailable !== "boolean") return false;
  return value.evidenceBasisAvailable
    ? validateManifest(value.evidenceManifest)
    : value.evidenceManifest === null;
}

function isIssueResolutionSummary(value: unknown): value is IssueResolutionSummary {
  if (!isPlainObject(value) || !exactKeys(value, [
    "id", "issueId", "resolutionType", "preferredClaimId", "rationaleExcerpt",
    "createdAt", "isCurrent", "evidenceBasisAvailable", "evidenceManifest",
  ])) return false;
  return isUuid(value.id)
    && isUuid(value.issueId)
    && hasValidIssueResolutionPreferredClaim(value.resolutionType, value.preferredClaimId)
    && (value.rationaleExcerpt === null || typeof value.rationaleExcerpt === "string")
    && validIssueResolutionTimestamp(value.createdAt)
    && typeof value.isCurrent === "boolean"
    && hasIssueResolutionEvidence(value, isAssessmentManifestSummary);
}

function isIssueResolutionRecord(value: unknown): value is IssueResolutionRecord {
  if (!isPlainObject(value) || !exactKeys(value, [
    "id", "issueId", "resolutionType", "preferredClaimId", "rationale", "createdAt", "isCurrent",
  ])) return false;
  return isUuid(value.id)
    && isUuid(value.issueId)
    && hasValidIssueResolutionPreferredClaim(value.resolutionType, value.preferredClaimId)
    && (value.rationale === null || typeof value.rationale === "string")
    && validIssueResolutionTimestamp(value.createdAt)
    && typeof value.isCurrent === "boolean";
}

function isIssueResolutionEvidenceManifestDetail(
  value: unknown,
): value is AssessmentDetailResponse["evidenceManifest"] {
  if (!isPlainObject(value) || !exactKeys(value, [
    "id", "schemaVersion", "purpose", "manifestSha256", "createdAt", "items",
  ])) return false;
  if (!isUuid(value.id)
    || value.schemaVersion !== 1
    || value.purpose !== "CLAIM_ASSESSMENT"
    || typeof value.manifestSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(value.manifestSha256)
    || !validIssueResolutionTimestamp(value.createdAt)
    || !Array.isArray(value.items)
    || value.items.length < 1
    || value.items.length > 100) return false;
  return value.items.every((item, index) => isAssessmentManifestItem(item, index));
}

function isIssueResolutionHistoryResponse(value: unknown): value is IssueResolutionHistoryResponse {
  if (!isPlainObject(value) || !exactKeys(value, [
    "issue", "currentResolution", "resolutions", "nextCursor",
  ])) return false;
  if (!isIssueResolutionIssueState(value.issue)
    || !Array.isArray(value.resolutions)
    || !(value.nextCursor === null || (typeof value.nextCursor === "string" && value.nextCursor.length > 0))) return false;

  const issue = value.issue;
  if (issue.currentResolutionId === null) {
    if (value.currentResolution !== null) return false;
  } else {
    if (!isIssueResolutionSummary(value.currentResolution)
      || value.currentResolution.id !== issue.currentResolutionId
      || value.currentResolution.issueId !== issue.id
      || value.currentResolution.isCurrent !== true) return false;
  }

  const seen = new Set<string>();
  for (const resolution of value.resolutions) {
    if (!isIssueResolutionSummary(resolution)
      || resolution.issueId !== issue.id
      || resolution.isCurrent !== (
        issue.currentResolutionId !== null && resolution.id === issue.currentResolutionId
      )
      || seen.has(resolution.id)) return false;
    seen.add(resolution.id);
  }
  return true;
}

function isIssueResolutionDetailResponse(value: unknown): value is IssueResolutionDetailResponse {
  if (!isPlainObject(value) || !exactKeys(value, [
    "issue", "resolution", "evidenceBasisAvailable", "evidenceManifest",
  ])) return false;
  if (!isIssueResolutionIssueState(value.issue) || !isIssueResolutionRecord(value.resolution)) return false;
  if (value.resolution.issueId !== value.issue.id
    || value.resolution.isCurrent !== (
      value.issue.currentResolutionId !== null
      && value.resolution.id === value.issue.currentResolutionId
    )) return false;
  return hasIssueResolutionEvidence(value, isIssueResolutionEvidenceManifestDetail);
}

function isIssueResolutionEvidenceBasisSummary(
  value: unknown,
): value is IssueResolutionEvidenceBasisSummary {
  if (!isPlainObject(value) || !exactKeys(value, [
    "assessmentId", "claimId", "claimStatementExcerpt", "stance", "confidenceLevel",
    "manifestId", "manifestSha256", "itemCount", "assessmentCreatedAt",
  ])) return false;
  return isUuid(value.assessmentId)
    && isUuid(value.claimId)
    && typeof value.claimStatementExcerpt === "string"
    && assessmentStances.has(value.stance as string)
    && (value.confidenceLevel === null || assessmentConfidences.has(value.confidenceLevel as string))
    && isUuid(value.manifestId)
    && typeof value.manifestSha256 === "string"
    && /^[0-9a-f]{64}$/.test(value.manifestSha256)
    && Number.isSafeInteger(value.itemCount)
    && (value.itemCount as number) >= 1
    && (value.itemCount as number) <= 100
    && validIssueResolutionTimestamp(value.assessmentCreatedAt);
}

function isIssueResolutionEvidenceBasesResponse(
  value: unknown,
): value is IssueResolutionEvidenceBasesResponse {
  if (!isPlainObject(value) || !exactKeys(value, ["issueId", "evidenceBases", "nextCursor"])) return false;
  return isUuid(value.issueId)
    && Array.isArray(value.evidenceBases)
    && value.evidenceBases.every(isIssueResolutionEvidenceBasisSummary)
    && (value.nextCursor === null
      || (typeof value.nextCursor === "string" && value.nextCursor.length > 0));
}

function isIssueResolutionCreateResponse(value: unknown): value is IssueResolutionCreateResponse {
  return isPlainObject(value)
    && exactKeys(value, ["status", "resolutionId"])
    && ["created", "replayed"].includes(value.status as string)
    && isUuid(value.resolutionId);
}

const issueResolutionErrorMessages: Record<string, { status: number; message: string }> = {
  ISSUE_RESOLUTION_INVALID: { status: 400, message: "工作结论输入不正确。" },
  PROJECT_OR_ISSUE_NOT_FOUND: { status: 404, message: "研究项目或研究问题不存在。" },
  ISSUE_RESOLUTION_NOT_FOUND: { status: 404, message: "该工作结论当前不可用。" },
  PREFERRED_CLAIM_NOT_AVAILABLE: { status: 404, message: "所选可能答案当前不可用。" },
  EVIDENCE_MANIFEST_NOT_AVAILABLE: { status: 404, message: "所选证据依据当前不可用。" },
  PROJECT_READ_ONLY: { status: 409, message: "当前研究项目已归档，不能新增工作结论。" },
  RESEARCH_ISSUE_READ_ONLY: { status: 409, message: "当前研究问题已归档，不能新增工作结论。" },
  ISSUE_RESOLUTION_STALE: { status: 409, message: "当前工作结论已发生变化，请刷新后再提交。" },
  IDEMPOTENCY_CONFLICT: { status: 409, message: "提交标识与当前工作结论内容不一致。" },
  ISSUE_RESOLUTION_STORE_UNAVAILABLE: { status: 503, message: "工作结论服务暂不可用。" },
};

async function issueResolutionRequest<T>(
  path: string,
  options: RequestOptions,
  valid: (body: any, status: number) => boolean,
): Promise<T> {
  try {
    const contextualErrorCodes: SafeErrorMap = options.method === "POST"
      ? issueResolutionErrorMessages
      : { PROJECT_OR_ISSUE_NOT_FOUND: issueResolutionErrorMessages.PROJECT_OR_ISSUE_NOT_FOUND };
    return await request<T>(path, { ...options, contextualErrorCodes }, valid);
  } catch (error) {
    if (error instanceof ProjectApiError) {
      if (options.method === "POST" && error.code) {
        const mapped = issueResolutionErrorMessages[error.code];
        if (mapped?.status === error.status) {
          throw new ProjectApiError(error.status, mapped.message, error.code);
        }
      }
      if (error.status === 500) {
        throw new ProjectApiError(500, "工作结论请求失败，请稍后再试。");
      }
      if (error.status === 502) {
        throw new ProjectApiError(502, "工作结论服务响应异常，请稍后再试。");
      }
    }
    throw error;
  }
}

function issueResolutionPath(projectId: string, issueId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/resolutions`;
}

export function createIssueResolution(
  projectId: string,
  issueId: string,
  idempotencyKey: string,
  input: CreateIssueResolutionInput,
  signal?: AbortSignal,
): Promise<IssueResolutionCreateResponse> {
  return issueResolutionRequest<IssueResolutionCreateResponse>(
    issueResolutionPath(projectId, issueId),
    {
      method: "POST",
      input,
      signal,
      idempotencyKey,
    },
    (body, status) => isIssueResolutionCreateResponse(body)
      && ((status === 201 && body.status === "created")
        || (status === 200 && body.status === "replayed")),
  );
}

export function listIssueResolutions(
  projectId: string,
  issueId: string,
  query: { limit?: number; cursor?: string | null } = {},
  signal?: AbortSignal,
): Promise<IssueResolutionHistoryResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined && query.cursor !== null) params.set("cursor", query.cursor);
  const suffix = params.size ? `?${params.toString()}` : "";
  return issueResolutionRequest<IssueResolutionHistoryResponse>(
    issueResolutionPath(projectId, issueId) + suffix,
    { signal },
    body => isIssueResolutionHistoryResponse(body)
      && body.issue.id.toLowerCase() === issueId.toLowerCase(),
  );
}

export function getIssueResolution(
  projectId: string,
  issueId: string,
  resolutionId: string,
  signal?: AbortSignal,
): Promise<IssueResolutionDetailResponse> {
  return issueResolutionRequest<IssueResolutionDetailResponse>(
    issueResolutionPath(projectId, issueId) + `/${encodeURIComponent(resolutionId)}`,
    { signal },
    body => isIssueResolutionDetailResponse(body)
      && body.issue.id.toLowerCase() === issueId.toLowerCase()
      && body.resolution.id.toLowerCase() === resolutionId.toLowerCase(),
  );
}

export function listIssueResolutionEvidenceBases(
  projectId: string,
  issueId: string,
  query: { limit?: number; cursor?: string | null } = {},
  signal?: AbortSignal,
): Promise<IssueResolutionEvidenceBasesResponse> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.cursor !== undefined && query.cursor !== null) params.set("cursor", query.cursor);
  const suffix = params.size ? `?${params.toString()}` : "";
  return issueResolutionRequest<IssueResolutionEvidenceBasesResponse>(
    `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/resolution-evidence-bases${suffix}`,
    { signal },
    body => isIssueResolutionEvidenceBasesResponse(body)
      && body.issueId.toLowerCase() === issueId.toLowerCase(),
  );
}

// ===== S32 M3-A Gate 3 ResearchRun API client =====

export type ResearchRunStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";

export interface ResearchRunProcedureStep {
  kind: "SEARCH" | "READ" | "COMPARE" | "FIELDWORK" | "MAP_ANALYSIS" | "IMAGE_ANALYSIS" | "OTHER";
  description: string;
}
export interface ResearchRunProcedure {
  version: 1;
  objective: string;
  method: string;
  steps: ResearchRunProcedureStep[];
}
export interface ResearchRunTool {
  name: string;
  version: string | null;
}
export interface ResearchRunExecutionContract {
  version: 1;
  mode: "HUMAN" | "HUMAN_AI" | "AUTOMATED";
  reproducibilityLevel: "EXACT" | "PROCEDURE" | "AUDIT";
  tools: ResearchRunTool[];
}
export interface ResearchRunOutputGap {
  description: string;
  status: "OPEN" | "BLOCKED" | "DEFERRED";
}
export interface ResearchRunOutput {
  version: 1;
  summary: string;
  produced: {
    claimIds: string[];
    assessmentIds: string[];
    resolutionIds: string[];
    noteRevisionIds: string[];
  };
  gaps: ResearchRunOutputGap[];
}
/** JSON-safe nested value tree (read-side shape check only). */
export type ResearchRunEnvironment = Record<string, unknown>;

export interface ResearchRunEvidenceSnapshotSummary {
  id: string;
  manifestSha256: string;
  itemCount: number;
  available: false;
}
export interface ResearchRunEvidenceSnapshotItem {
  ordinal: number;
  role: EvidenceRole;
  targetType: EvidenceTargetType;
  note: string | null;
}
export interface ResearchRunEvidenceSnapshotDetail {
  id: string;
  manifestSha256: string;
  itemCount: number;
  available: true;
  items: ResearchRunEvidenceSnapshotItem[];
}
export type ResearchRunEvidenceSnapshot = ResearchRunEvidenceSnapshotSummary | ResearchRunEvidenceSnapshotDetail;

export interface ResearchRunSummary {
  runId: string;
  issueId: string;
  status: ResearchRunStatus;
  replayOf: string | null;
  startedAtMicros: string;
  startedAt: string;
  completedAt: string | null;
  evidenceManifest: ResearchRunEvidenceSnapshotSummary | ResearchRunEvidenceSnapshotDetail;
}
export interface ResearchRunListResponse {
  runs: ResearchRunSummary[];
  nextCursor: string | null;
}

export interface ResearchRunRecord {
  runId: string;
  projectId: string;
  issueId: string;
  status: ResearchRunStatus;
  evidenceManifestId: string;
  replayOf: string | null;
  procedure: ResearchRunProcedure;
  executionContract: ResearchRunExecutionContract;
  environment: ResearchRunEnvironment;
  output: ResearchRunOutput | null;
  knowledgeCutoff: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}
export interface ResearchRunDetailResponse {
  run: ResearchRunRecord;
  evidenceManifest: ResearchRunEvidenceSnapshot;
  ancestors: ResearchRunSummary[];
}

export interface StartResearchRunInput {
  procedure: ResearchRunProcedure;
  executionContract: ResearchRunExecutionContract;
  environment: ResearchRunEnvironment;
  evidenceManifestId: string;
  replayOf: string | null;
}
export interface ReplayResearchRunInput {
  procedure: ResearchRunProcedure;
  executionContract: ResearchRunExecutionContract;
  environment: ResearchRunEnvironment;
  evidenceManifestId: string;
}
export interface ResearchRunCommandResponse {
  status: "created" | "replayed";
  runId: string;
}

const researchRunErrorMessages: Record<string, { status: number; message: string }> = {
  RESEARCH_RUN_INVALID: { status: 400, message: "研究执行记录输入不正确。" },
  PROJECT_OR_ISSUE_NOT_FOUND: { status: 404, message: "研究项目或研究问题不存在。" },
  RESEARCH_RUN_NOT_FOUND: { status: 404, message: "该研究执行记录当前不可用。" },
  EVIDENCE_MANIFEST_NOT_AVAILABLE: { status: 404, message: "所选证据依据当前不可用。" },
  PROJECT_READ_ONLY: { status: 409, message: "当前研究项目已归档，不能变更研究执行记录。" },
  RESEARCH_ISSUE_READ_ONLY: { status: 409, message: "当前研究问题已归档，不能变更研究执行记录。" },
  RESEARCH_RUN_ALREADY_TERMINAL: { status: 409, message: "该研究执行记录已结束，不能再变更。" },
  RESEARCH_RUN_REPLAY_INVALID: { status: 409, message: "重放条件不满足，请刷新后重试。" },
  IDEMPOTENCY_CONFLICT: { status: 409, message: "提交标识与当前研究执行记录内容不一致。" },
  RESEARCH_RUN_STORE_UNAVAILABLE: { status: 503, message: "研究执行服务暂不可用。" },
};

async function researchRunRequest<T>(
  path: string,
  options: RequestOptions,
  valid: (body: any, status: number) => boolean,
): Promise<T> {
  try {
    const contextualErrorCodes: SafeErrorMap = options.method === "POST"
      ? researchRunErrorMessages
      : { PROJECT_OR_ISSUE_NOT_FOUND: researchRunErrorMessages.PROJECT_OR_ISSUE_NOT_FOUND, RESEARCH_RUN_NOT_FOUND: researchRunErrorMessages.RESEARCH_RUN_NOT_FOUND };
    return await request<T>(path, { ...options, contextualErrorCodes }, valid);
  } catch (error) {
    if (error instanceof ProjectApiError) {
      if (options.method === "POST" && error.code) {
        const mapped = researchRunErrorMessages[error.code];
        if (mapped?.status === error.status) {
          throw new ProjectApiError(error.status, mapped.message, error.code);
        }
      }
      if (error.status === 500) {
        throw new ProjectApiError(500, "研究执行记录请求失败，请稍后再试。");
      }
      if (error.status === 502) {
        throw new ProjectApiError(502, "研究执行记录服务响应异常，请稍后再试。");
      }
    }
    throw error;
  }
}

function researchRunPath(projectId: string, issueId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/runs`;
}

// --- validators ---------------------------------------------------------

const RESEARCH_RUN_STATUSES: readonly string[] = ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"];
const PROCEDURE_STEP_KINDS: readonly string[] = ["SEARCH", "READ", "COMPARE", "FIELDWORK", "MAP_ANALYSIS", "IMAGE_ANALYSIS", "OTHER"];
const CONTRACT_MODES: readonly string[] = ["HUMAN", "HUMAN_AI", "AUTOMATED"];
const REPRO_LEVELS: readonly string[] = ["EXACT", "PROCEDURE", "AUDIT"];
const OUTPUT_GAP_STATUSES: readonly string[] = ["OPEN", "BLOCKED", "DEFERRED"];
const EVIDENCE_ROLES: readonly string[] = ["SUPPORTING", "CONTRADICTORY", "CONTEXTUAL"];
const EVIDENCE_TARGET_TYPES: readonly string[] = ["SOURCE", "SOURCE_ASSET", "NOTE_REVISION"];
const SHA256_RE = /^[0-9a-f]{64}$/;
const MICROS_RE = /^[0-9]+$/;
const MAX_LINEAGE_DEPTH = 100;

function isIsoOrNull(value: unknown, orNull: boolean): boolean {
  if (value === null) return orNull;
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isJsonSafe(value: unknown): boolean {
  if (value === null) return true;
  const t = typeof value;
  if (t === "string") return true;
  if (t === "number") return Number.isFinite(value);
  if (t === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonSafe);
  if (t === "object") return Object.values(value as Record<string, unknown>).every(isJsonSafe);
  return false;
}

function isResearchRunProcedure(value: any): value is ResearchRunProcedure {
  if (!value || typeof value !== "object" || !exactKeys(value, ["version", "objective", "method", "steps"])) return false;
  if (value.version !== 1 || typeof value.objective !== "string" || typeof value.method !== "string") return false;
  if (!Array.isArray(value.steps)) return false;
  return value.steps.every((step: any) =>
    step && typeof step === "object" && exactKeys(step, ["kind", "description"])
    && PROCEDURE_STEP_KINDS.includes(step.kind) && typeof step.description === "string");
}

function isResearchRunExecutionContract(value: any): value is ResearchRunExecutionContract {
  if (!value || typeof value !== "object" || !exactKeys(value, ["version", "mode", "reproducibilityLevel", "tools"])) return false;
  if (value.version !== 1 || !CONTRACT_MODES.includes(value.mode) || !REPRO_LEVELS.includes(value.reproducibilityLevel)) return false;
  if (!Array.isArray(value.tools)) return false;
  return value.tools.every((tool: any) =>
    tool && typeof tool === "object" && exactKeys(tool, ["name", "version"])
    && typeof tool.name === "string" && (tool.version === null || typeof tool.version === "string"));
}

function isResearchRunOutput(value: any): value is ResearchRunOutput {
  if (!value || typeof value !== "object" || !exactKeys(value, ["version", "summary", "produced", "gaps"])) return false;
  if (value.version !== 1 || typeof value.summary !== "string") return false;
  const produced = value.produced;
  if (!produced || typeof produced !== "object" || !exactKeys(produced, ["claimIds", "assessmentIds", "resolutionIds", "noteRevisionIds"])) return false;
  for (const key of ["claimIds", "assessmentIds", "resolutionIds", "noteRevisionIds"] as const) {
    if (!Array.isArray(produced[key])) return false;
    const ids = produced[key] as unknown[];
    if (!ids.every((id: unknown) => isUuid(id))) return false;
    if (new Set(ids).size !== ids.length) return false;
  }
  if (!Array.isArray(value.gaps)) return false;
  return value.gaps.every((gap: any) =>
    gap && typeof gap === "object" && exactKeys(gap, ["description", "status"])
    && typeof gap.description === "string" && OUTPUT_GAP_STATUSES.includes(gap.status));
}

function isResearchRunEnvironment(value: any): value is ResearchRunEnvironment {
  return !!value && typeof value === "object" && !Array.isArray(value) && isJsonSafe(value);
}

/** Privacy contract: available=false must expose ONLY {id,manifestSha256,itemCount,available}. */
export function isResearchRunEvidenceSnapshot(value: any): value is ResearchRunEvidenceSnapshot {
  if (!value || typeof value !== "object") return false;
  if (!isUuid(value.id) || typeof value.manifestSha256 !== "string" || !SHA256_RE.test(value.manifestSha256)) return false;
  if (!Number.isInteger(value.itemCount) || value.itemCount < 1) return false;
  if (value.available === false) return exactKeys(value, ["id", "manifestSha256", "itemCount", "available"]);
  if (value.available !== true) return false;
  if (!exactKeys(value, ["id", "manifestSha256", "itemCount", "available", "items"])) return false;
  if (!Array.isArray(value.items) || value.items.length !== value.itemCount) return false;
  return value.items.every((item: any, index: number) =>
    item && typeof item === "object" && exactKeys(item, ["ordinal", "role", "targetType", "note"])
    && item.ordinal === index + 1
    && EVIDENCE_ROLES.includes(item.role)
    && EVIDENCE_TARGET_TYPES.includes(item.targetType)
    && (item.note === null || typeof item.note === "string"));
}

export function isResearchRunSummary(value: any): value is ResearchRunSummary {
  if (!value || typeof value !== "object") return false;
  if (!exactKeys(value, ["runId", "issueId", "status", "replayOf", "startedAtMicros", "startedAt", "completedAt", "evidenceManifest"])) return false;
  if (!isUuid(value.runId) || !isUuid(value.issueId)) return false;
  if (!RESEARCH_RUN_STATUSES.includes(value.status)) return false;
  if (value.replayOf !== null && !isUuid(value.replayOf)) return false;
  if (typeof value.startedAtMicros !== "string" || !MICROS_RE.test(value.startedAtMicros) || value.startedAtMicros === "0") return false;
  if (typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) return false;
  const terminal = value.status !== "RUNNING";
  if (terminal && !isIsoOrNull(value.completedAt, false)) return false;
  if (!terminal && value.completedAt !== null) return false;
  return isResearchRunEvidenceSnapshot(value.evidenceManifest);
}

function isResearchRunDetailPayload(value: any, projectId: string, issueId: string): value is ResearchRunDetailResponse {
  if (!value || typeof value !== "object") return false;
  if (!exactKeys(value, ["run", "evidenceManifest", "ancestors"])) return false;
  const run = value.run;
  if (!run || typeof run !== "object") return false;
  if (!exactKeys(run, ["runId", "projectId", "issueId", "status", "evidenceManifestId", "replayOf", "procedure", "executionContract", "environment", "output", "knowledgeCutoff", "startedAt", "completedAt", "createdAt"])) return false;

  if (!isUuid(run.runId) || !isUuid(run.evidenceManifestId)) return false;
  if (run.projectId.toLowerCase() !== projectId.toLowerCase() || run.issueId.toLowerCase() !== issueId.toLowerCase()) return false;
  if (!RESEARCH_RUN_STATUSES.includes(run.status)) return false;
  if (run.replayOf !== null && !isUuid(run.replayOf)) return false;
  if (!isResearchRunProcedure(run.procedure)) return false;
  if (!isResearchRunExecutionContract(run.executionContract)) return false;
  if (!isResearchRunEnvironment(run.environment)) return false;
  if (run.knowledgeCutoff !== null && typeof run.knowledgeCutoff !== "string") return false;
  if (typeof run.startedAt !== "string" || !Number.isFinite(Date.parse(run.startedAt))) return false;
  if (typeof run.createdAt !== "string" || !Number.isFinite(Date.parse(run.createdAt))) return false;
  if (run.status === "RUNNING") {
    if (run.output !== null || run.completedAt !== null) return false;
  } else if (run.status === "SUCCEEDED") {
    if (!isResearchRunOutput(run.output)) return false;
    if (!isIsoOrNull(run.completedAt, false)) return false;
  } else {
    if (run.output !== null && !isResearchRunOutput(run.output)) return false;
    if (!isIsoOrNull(run.completedAt, false)) return false;
  }
  if (!isResearchRunEvidenceSnapshot(value.evidenceManifest)) return false;
  if (value.evidenceManifest.id.toLowerCase() !== run.evidenceManifestId.toLowerCase()) return false;
  if (process.env.VV_DEBUG) process.stdout.write(`DBG reached lineage: arr=${Array.isArray(value.ancestors)} every=${Array.isArray(value.ancestors) ? value.ancestors.every(isResearchRunSummary) : "-"} lineage=${Array.isArray(value.ancestors) && value.ancestors.every(isResearchRunSummary) ? isResearchRunLineage(run, value.ancestors) : "-"}\n`);
  return Array.isArray(value.ancestors)
    && value.ancestors.every((ancestor: any) => isResearchRunSummary(ancestor) && ancestor.issueId.toLowerCase() === issueId.toLowerCase())
    && isResearchRunLineage(run, value.ancestors);
}

/** Lineage invariants: unique ids, oldest-first chain, terminal-only, replayOf linkage, cap 100. */
function isResearchRunLineage(run: ResearchRunRecord, ancestors: ResearchRunSummary[]): boolean {
  if (ancestors.length > MAX_LINEAGE_DEPTH) return false;
  const ids = new Set<string>();
  for (const ancestor of ancestors) {
    if (ids.has(ancestor.runId)) return false;
    ids.add(ancestor.runId);
    if (ancestor.runId === run.runId) return false;
    if (ancestor.status === "RUNNING") return false;
  }
  if (run.replayOf === null) return ancestors.length === 0;
  if (ancestors.length === 0) return false;
  if (ancestors[ancestors.length - 1].runId !== run.replayOf) return false;
  for (let i = 1; i < ancestors.length; i += 1) {
    if (ancestors[i].replayOf !== ancestors[i - 1].runId) return false;
  }
  return ancestors[0].replayOf === null;
}

export function startResearchRun(projectId: string, issueId: string, idempotencyKey: string, input: StartResearchRunInput, signal?: AbortSignal): Promise<ResearchRunCommandResponse> {
  return researchRunRequest<ResearchRunCommandResponse>(
    researchRunPath(projectId, issueId),
    { method: "POST", input, signal, idempotencyKey },
    (body, status) => isResearchRunCommandResponse(body)
      && ((status === 201 && body.status === "created") || (status === 200 && body.status === "replayed")),
  );
}

export function listResearchRuns(projectId: string, issueId: string, query?: { limit?: number; cursor?: string | null }, signal?: AbortSignal): Promise<ResearchRunListResponse> {
  const params = new URLSearchParams();
  if (query?.limit !== undefined) params.set("limit", String(query.limit));
  if (query?.cursor != null) params.set("cursor", query.cursor);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  const requestedIssueId = issueId;
  return researchRunRequest<ResearchRunListResponse>(
    `${researchRunPath(projectId, issueId)}${suffix}`,
    { signal },
    (body, status) => status === 200
      && !!body && typeof body === "object" && exactKeys(body, ["runs", "nextCursor"])
      && (body.nextCursor === null || (typeof body.nextCursor === "string" && body.nextCursor.length > 0))
      && Array.isArray(body.runs)
      && body.runs.every((run: any) => isResearchRunSummary(run) && run.issueId.toLowerCase() === requestedIssueId.toLowerCase())
      && new Set(body.runs.map((run: ResearchRunSummary) => run.runId)).size === body.runs.length,
  );
}

export function getResearchRun(projectId: string, issueId: string, runId: string, signal?: AbortSignal): Promise<ResearchRunDetailResponse> {
  return researchRunRequest<ResearchRunDetailResponse>(
    `${researchRunPath(projectId, issueId)}/${encodeURIComponent(runId)}`,
    { signal },
    (body, status) => status === 200 && isResearchRunDetailPayload(body, projectId, issueId),
  );
}

function isResearchRunCommandResponse(value: any): value is ResearchRunCommandResponse {
  return !!value && typeof value === "object" && exactKeys(value, ["status", "runId"])
    && (value.status === "created" || value.status === "replayed") && isUuid(value.runId);
}

function transitionResearchRun(
  projectId: string, issueId: string, runId: string, idempotencyKey: string,
  action: "complete" | "fail" | "cancel", output: ResearchRunOutput | null, signal?: AbortSignal,
): Promise<ResearchRunCommandResponse> {
  return researchRunRequest<ResearchRunCommandResponse>(
    `${researchRunPath(projectId, issueId)}/${encodeURIComponent(runId)}/${action}`,
    { method: "POST", input: { output }, signal, idempotencyKey },
    (body, status) => status === 200 && isResearchRunCommandResponse(body) && body.runId.toLowerCase() === runId.toLowerCase(),
  );
}

export function completeResearchRun(projectId: string, issueId: string, runId: string, idempotencyKey: string, output: ResearchRunOutput, signal?: AbortSignal): Promise<ResearchRunCommandResponse> {
  return transitionResearchRun(projectId, issueId, runId, idempotencyKey, "complete", output, signal);
}
export function failResearchRun(projectId: string, issueId: string, runId: string, idempotencyKey: string, output: ResearchRunOutput | null, signal?: AbortSignal): Promise<ResearchRunCommandResponse> {
  return transitionResearchRun(projectId, issueId, runId, idempotencyKey, "fail", output, signal);
}
export function cancelResearchRun(projectId: string, issueId: string, runId: string, idempotencyKey: string, output: ResearchRunOutput | null, signal?: AbortSignal): Promise<ResearchRunCommandResponse> {
  return transitionResearchRun(projectId, issueId, runId, idempotencyKey, "cancel", output, signal);
}

export function replayResearchRun(projectId: string, issueId: string, priorRunId: string, idempotencyKey: string, input: ReplayResearchRunInput, signal?: AbortSignal): Promise<ResearchRunCommandResponse> {
  return researchRunRequest<ResearchRunCommandResponse>(
    `${researchRunPath(projectId, issueId)}/${encodeURIComponent(priorRunId)}/replay`,
    { method: "POST", input, signal, idempotencyKey },
    (body, status) => isResearchRunCommandResponse(body)
      && ((status === 201 && body.status === "created") || (status === 200 && body.status === "replayed")),
  );
}
