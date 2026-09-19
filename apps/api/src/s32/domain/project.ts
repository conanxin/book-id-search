export interface Project {
  id: string;
  name: string;
  description: string | null;
  lifecycleState: "ACTIVE" | "ARCHIVED";
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name: string;
  description: string | null;
}

export class InvalidProjectInputError extends Error {}

export function readProjectInput(value: unknown): ProjectInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidProjectInputError("项目输入必须是对象。");
  }
  const { name, description } = value as Record<string, unknown>;
  if (typeof name !== "string" || !name.trim() || [...name.trim()].length > 120) {
    throw new InvalidProjectInputError("项目名称不能为空，且不能超过 120 个字符。");
  }
  if (description != null && (typeof description !== "string" || [...description.trim()].length > 2000)) {
    throw new InvalidProjectInputError("研究目的必须是文本，且不能超过 2000 个字符。");
  }
  return { name: name.trim(), description: typeof description === "string" ? description.trim() || null : null };
}

export function readProjectId(id: unknown): string {
  if (typeof id !== "string" || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) {
    throw new InvalidProjectInputError("项目 ID 格式不正确。");
  }
  return id;
}
