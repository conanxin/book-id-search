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
  400: "请检查项目名称和研究目的。",
  401: "请输入研究项目访问凭据。",
  403: "访问凭据不正确，请清除后重新输入。",
  404: "项目不存在，或研究项目功能尚未开启。",
  503: "研究项目服务暂不可用，请稍后再试。",
};
async function request<T>(token: string, path: string, signal?: AbortSignal, input?: { name: string; description: string | null }): Promise<T> {
  const response = await fetch(`/api/private/s32/projects${path}`, {
    method: input ? "POST" : "GET", cache: "no-store", signal,
    headers: { Authorization: `Bearer ${token}`, ...(input ? { "Content-Type": "application/json" } : {}) },
    ...(input ? { body: JSON.stringify({ name: input.name, description: input.description }) } : {}),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    // Use user-facing messages; never reflect a proxy/database error or credentials.
    throw new ProjectApiError(response.status, statusMessages[response.status] ?? "项目请求失败，请稍后再试。");
  }
  if (!body || (path === "" && !input ? !Array.isArray(body.projects) : !body.project)) {
    throw new ProjectApiError(502, "项目服务响应异常，请稍后再试。");
  }
  return body as T;
}
export const listProjects = (token: string, signal?: AbortSignal) => request<{ projects: Project[] }>(token, "", signal);
export const getProject = (token: string, id: string, signal?: AbortSignal) => request<{ project: Project }>(token, `/${encodeURIComponent(id)}`, signal);
export const createProject = (token: string, input: { name: string; description: string | null }, signal?: AbortSignal) => request<{ project: Project }>(token, "", signal, input);
