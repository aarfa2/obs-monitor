import type { AccountUser, AuthMe } from "../../src/shared/types.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type") && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(path, { ...init, credentials: "include", headers });
  if (res.status === 401) {
    window.dispatchEvent(new Event("auth:required"));
    throw new ApiError(401, "未登录");
  }
  let data: { error?: string } | null = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text) as { error?: string };
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.error ?? res.statusText);
  }
  return data as T;
}

export function login(username: string, password: string): Promise<AuthMe> {
  return api<AuthMe>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return api("/api/auth/logout", { method: "POST" });
}

export function fetchMe(): Promise<AuthMe> {
  return api<AuthMe>("/api/auth/me");
}

export function fetchUsers(): Promise<{ users: AccountUser[] }> {
  return api("/api/users");
}

export function createUser(body: { username: string; password: string; admin: boolean }): Promise<{ user: AccountUser }> {
  return api("/api/users", { method: "POST", body: JSON.stringify(body) });
}

export function patchUser(
  id: string,
  body: { password?: string; admin?: boolean },
): Promise<{ user: AccountUser }> {
  return api(`/api/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteUser(id: string): Promise<{ ok: boolean }> {
  return api(`/api/users/${encodeURIComponent(id)}`, { method: "DELETE" });
}
