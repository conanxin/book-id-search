import { normalizeCandidateClaimDraft } from "./candidate-claim-draft";
export interface Project {
  id: string;
  name: string;
  description: string | null;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}
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
};
const statusMessages: Record<number, string> = {
  400: "请检查项目或书目输入。",
  409: "项目或书目状态冲突，请刷新后再试。",
  422: "书目元数据无法加入研究。",
  401: "请输入研究项目访问凭据。",
  403: "访问凭据不正确，请清除后重新输入。",
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
type RequestOptions = { method?: "GET" | "POST" | "DELETE"; input?: unknown; signal?: AbortSignal; idempotencyKey?: string };
async function request<T>(token: string, path: string, options: RequestOptions, valid: (body: any) => boolean): Promise<T> {
  const { method = "GET", input, signal, idempotencyKey } = options;
  const response = await fetch(`${S32_ROOT}${path}`, {
    method, cache: "no-store", signal,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(input !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const code = typeof body?.error?.code === "string" ? body.error.code : undefined;
    const known = code && Object.hasOwn(errorCodes, code) ? errorCodes[code] : undefined;
    if (known?.status === response.status) throw new ProjectApiError(response.status, known.message, code);
    throw new ProjectApiError(response.status, statusMessages[response.status] ?? "项目请求失败，请稍后再试。");
  }
  if (method === "DELETE") {
    if (response.status !== 204) throw new ProjectApiError(502, "项目服务响应异常，请稍后再试。");
    return undefined as T;
  }
  const body = await response.json().catch(() => null);
  if (!body || !valid(body)) throw new ProjectApiError(502, "项目服务响应异常，请稍后再试。");
  return body as T;
}
export const listProjects = (token: string, signal?: AbortSignal) => request<{ projects: Project[] }>(token, "/projects", { signal }, b => Array.isArray(b.projects));
export const getProject = (token: string, id: string, signal?: AbortSignal) => request<{ project: Project }>(token, `/projects/${encodeURIComponent(id)}`, { signal }, b => !!b.project);
export const createProject = (token: string, input: { name: string; description: string | null }, signal?: AbortSignal) => request<{ project: Project }>(token, "/projects", { method: "POST", input: { name: input.name, description: input.description }, signal }, b => !!b.project);

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
export const addCatalogBookToProject = (token: string, projectId: string, bookId: string, signal?: AbortSignal) =>
  request<AddProjectItemResult>(token, `/projects/${encodeURIComponent(projectId)}/catalog-books`, { method: "POST", input: { bookId }, signal },
    b => ["created", "existing"].includes(b.promotionStatus) && ["created", "existing"].includes(b.bindingStatus) && isItem(b.item));
export const listProjectItems = (token: string, projectId: string, signal?: AbortSignal) =>
  request<{ items: ProjectResearchItem[] }>(token, `/projects/${encodeURIComponent(projectId)}/items`, { signal }, b => Array.isArray(b.items) && b.items.every(isItem));
export const removeProjectItem = (token: string, projectId: string, bindingId: string, signal?: AbortSignal) =>
  request<void>(token, `/projects/${encodeURIComponent(projectId)}/items/${encodeURIComponent(bindingId)}`, { method: "DELETE", signal }, () => false);

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
export const getProjectItemNote = (token: string, projectId: string, bindingId: string, signal?: AbortSignal) =>
  request<{ note: ProjectItemNote | null }>(token, notePath(projectId, bindingId), { signal }, b => b.note === null || isNote(b.note));
export const createProjectItemNote = (token: string, projectId: string, bindingId: string, content: string, signal?: AbortSignal) =>
  request<{ note: ProjectItemNote }>(token, notePath(projectId, bindingId), { method: "POST", input: { content }, signal }, b => isNote(b.note));
export const appendProjectItemNoteRevision = (token: string, projectId: string, bindingId: string, baseRevisionId: string, content: string, signal?: AbortSignal) =>
  request<{ note: ProjectItemNote }>(token, `${notePath(projectId, bindingId)}/revisions`, { method: "POST", input: { baseRevisionId, content }, signal }, b => isNote(b.note));
export const getProjectItemNoteRevision = (token: string, projectId: string, bindingId: string, revisionId: string, signal?: AbortSignal) =>
  request<{ revision: ProjectItemNoteRevision }>(token, `${notePath(projectId, bindingId)}/revisions/${encodeURIComponent(revisionId)}`, { signal }, b => isRevision(b.revision));

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

export const getResearchMemberships = (token: string, bookIds: string[], signal?: AbortSignal) =>
  request<MembershipResponse>(token, "/research-memberships/catalog-books", { method: "POST", input: { bookIds }, signal },
    body => isMembershipResponse(body, bookIds));

export const getProjectOverview = (token: string, projectId: string, signal?: AbortSignal) =>
  request<ProjectOverview>(token, `/projects/${encodeURIComponent(projectId)}/overview`, { signal }, isProjectOverview);

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
  token: string,
  projectId: string,
  idempotencyKey: string,
  input: { title: string; question: string },
  signal?: AbortSignal,
) => request<ResearchIssueDetailResponse>(
  token,
  `/projects/${encodeURIComponent(projectId)}/issues`,
  { method: "POST", input: { title: input.title, question: input.question }, signal, idempotencyKey },
  isResearchIssueDetailResponse,
);

export const listResearchIssues = (token: string, projectId: string, signal?: AbortSignal) =>
  request<ResearchIssueListResponse>(token, `/projects/${encodeURIComponent(projectId)}/issues`, { signal }, isResearchIssueListResponse);

export const getResearchIssue = (token: string, projectId: string, issueId: string, signal?: AbortSignal) =>
  request<ResearchIssueDetailResponse>(token, `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}`, { signal }, isResearchIssueDetailResponse);

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
export const listCandidateClaims = (token: string, projectId: string, issueId: string, signal?: AbortSignal) =>
  request<{ claims: CandidateClaim[] }>(token, `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims`, { signal }, b => Array.isArray(b.claims) && b.claims.every(isCandidateClaim));
export async function createCandidateClaim(token: string, projectId: string, issueId: string, idempotencyKey: string, statement: string, signal?: AbortSignal): Promise<{ claim: CandidateClaim }> {
  try {
    return await request<{ claim: CandidateClaim }>(token, `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims`, { method: "POST", input: { statement }, signal, idempotencyKey }, b => isCandidateClaim(b.claim));
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
export const listEvidenceCandidates = (token: string, projectId: string, issueId: string, claimId: string, signal?: AbortSignal) =>
  request<{ claim: EvidenceClaimContext; candidates: EvidenceCandidate[] }>(
    token,
    `/projects/${encodeURIComponent(projectId)}/issues/${encodeURIComponent(issueId)}/claims/${encodeURIComponent(claimId)}/evidence-candidates`,
    { signal },
    b => isPlainObject(b) && isEvidenceClaimContext(b.claim) && Array.isArray(b.candidates) && b.candidates.every(isEvidenceCandidate),
  );
export async function previewEvidenceManifest(
  token: string,
  projectId: string,
  issueId: string,
  claimId: string,
  items: Array<{ role: EvidenceRole; targetType: EvidenceTargetType; targetId: string; note: string | null }>,
  signal?: AbortSignal,
): Promise<EvidencePreviewResponse> {
  try {
    return await request<EvidencePreviewResponse>(
      token,
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
