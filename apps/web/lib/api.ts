export interface SessionUser {
  userId: string;
  name: string;
}

export type Role = "owner" | "editor" | "viewer";

export interface DocMeta {
  id: string;
  ownerId: string;
  title: string;
  updatedAt: string;
}

export interface DocWithRole extends DocMeta {
  role: Role;
}

export interface Permission {
  userId: string;
  role: Role;
}

export function apiUrl(): string {
  return process.env.NEXT_PUBLIC_BIRGA_API ?? "http://localhost:8787";
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl() + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Cannot reach the Birga API. Is the server running with a database?");
  }
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

export interface DemoAccount extends SessionUser {
  note: string;
  token: string;
}

export const api = {
  guest: (name: string) =>
    req<{ token: string; user: SessionUser }>("POST", "/api/auth/guest", { body: { name } }),
  demoAccounts: () => req<{ accounts: DemoAccount[] }>("GET", "/api/demo/accounts"),
  listDocs: (token: string) => req<{ docs: DocWithRole[] }>("GET", "/api/docs", { token }),
  createDoc: (token: string, body: { id?: string; title?: string }) =>
    req<{ doc: DocMeta }>("POST", "/api/docs", { token, body }),
  getDoc: (token: string, id: string) =>
    req<{ doc: DocMeta; role: Role }>("GET", `/api/docs/${encodeURIComponent(id)}`, { token }),
  rename: (token: string, id: string, title: string) =>
    req<{ ok: true }>("PATCH", `/api/docs/${encodeURIComponent(id)}`, { token, body: { title } }),
  remove: (token: string, id: string) =>
    req<{ ok: true }>("DELETE", `/api/docs/${encodeURIComponent(id)}`, { token }),
  share: (token: string, id: string, role: Exclude<Role, "owner">) =>
    req<{ token: string; role: Role }>("POST", `/api/docs/${encodeURIComponent(id)}/share`, {
      token,
      body: { role },
    }),
  accept: (token: string, shareToken: string) =>
    req<{ docId: string; role: Role }>("POST", "/api/share/accept", {
      token,
      body: { token: shareToken },
    }),
  permissions: (token: string, id: string) =>
    req<{ permissions: Permission[] }>(
      "GET",
      `/api/docs/${encodeURIComponent(id)}/permissions`,
      { token },
    ),
};
