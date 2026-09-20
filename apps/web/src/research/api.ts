export interface Project {
  id: string;
  name: string;
  description: string | null;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}
export class ProjectApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
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

const S32_PROJECTS_ROOT = "/api/private/s32/projects";
type RequestOptions = { method?: "GET" | "POST" | "DELETE"; input?: unknown; signal?: AbortSignal };
async function request<T>(token: string, path: string, options: RequestOptions, valid: (body: any) => boolean): Promise<T> {
  const { method = "GET", input, signal } = options;
  const response = await fetch(`${S32_PROJECTS_ROOT}${path}`, {
    method, cache: "no-store", signal,
    headers: { Authorization: `Bearer ${token}`, ...(input !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
  });
  if (!response.ok) throw new ProjectApiError(response.status, statusMessages[response.status] ?? "项目请求失败，请稍后再试。");
  if (method === "DELETE") {
    if (response.status !== 204) throw new ProjectApiError(502, "项目服务响应异常，请稍后再试。");
    return undefined as T;
  }
  const body = await response.json().catch(() => null);
  if (!body || !valid(body)) throw new ProjectApiError(502, "项目服务响应异常，请稍后再试。");
  return body as T;
}
export const listProjects = (token: string, signal?: AbortSignal) => request<{ projects: Project[] }>(token, "", { signal }, b => Array.isArray(b.projects));
export const getProject = (token: string, id: string, signal?: AbortSignal) => request<{ project: Project }>(token, `/${encodeURIComponent(id)}`, { signal }, b => !!b.project);
export const createProject = (token: string, input: { name: string; description: string | null }, signal?: AbortSignal) => request<{ project: Project }>(token, "", { method: "POST", input: { name: input.name, description: input.description }, signal }, b => !!b.project);

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
  request<AddProjectItemResult>(token, `/${encodeURIComponent(projectId)}/catalog-books`, { method: "POST", input: { bookId }, signal },
    b => ["created", "existing"].includes(b.promotionStatus) && ["created", "existing"].includes(b.bindingStatus) && isItem(b.item));
export const listProjectItems = (token: string, projectId: string, signal?: AbortSignal) =>
  request<{ items: ProjectResearchItem[] }>(token, `/${encodeURIComponent(projectId)}/items`, { signal }, b => Array.isArray(b.items) && b.items.every(isItem));
export const removeProjectItem = (token: string, projectId: string, bindingId: string, signal?: AbortSignal) =>
  request<void>(token, `/${encodeURIComponent(projectId)}/items/${encodeURIComponent(bindingId)}`, { method: "DELETE", signal }, () => false);
