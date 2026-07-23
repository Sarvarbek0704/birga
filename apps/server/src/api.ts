import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { DocumentsRepo, type Role } from "./documents.js";
import { issueGuest, verifyUser, signShare, verifyShare, signUser, type User } from "./auth.js";
import { DEMO_USERS } from "./demo-users.js";

export interface ApiOptions {
  repo: DocumentsRepo;
  secret: string;
  port?: number;
  host?: string;
}

export interface RunningApi {
  port: number;
  close(): Promise<void>;
}

/**
 * Minimal REST API over {@link DocumentsRepo}: guest auth, document CRUD, and
 * share links. Auth is a stateless HMAC bearer token (no user table). It runs on
 * its own port beside the WebSocket sync server.
 */
export async function startApi(opts: ApiOptions): Promise<RunningApi> {
  const server = createServer((req, res) => {
    void handle(req, res, opts).catch(() => send(res, 500, { error: "internal error" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8787, opts.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 0);
  return {
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: ApiOptions): Promise<void> {
  const { repo, secret } = opts;
  cors(res);
  if (req.method === "OPTIONS") return void res.writeHead(204).end();

  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Public: mint a guest identity.
  if (method === "POST" && path === "/api/auth/guest") {
    const body = await json(req);
    const name = (typeof body.name === "string" && body.name.trim().slice(0, 40)) || "Guest";
    return send(res, 200, issueGuest(name, secret));
  }

  // Public (demo only): one-click sign-in tokens for the seeded personas.
  if (method === "GET" && path === "/api/demo/accounts") {
    if (process.env["DEMO_ACCOUNTS"] !== "1") return send(res, 404, { error: "not found" });
    const accounts = DEMO_USERS.map((u) => ({
      userId: u.userId,
      name: u.name,
      note: u.note,
      token: signUser({ userId: u.userId, name: u.name }, secret),
    }));
    return send(res, 200, { accounts });
  }

  // Everything else needs a valid bearer token.
  const user = bearerUser(req, secret);
  if (!user) return send(res, 401, { error: "unauthorized" });

  if (method === "GET" && path === "/api/docs") {
    return send(res, 200, { docs: await repo.listForUser(user.userId) });
  }

  if (method === "POST" && path === "/api/docs") {
    const body = await json(req);
    const id = (typeof body.id === "string" && body.id.trim()) || randomUUID().slice(0, 8);
    const title = typeof body.title === "string" ? body.title : "Untitled";
    try {
      return send(res, 201, { doc: await repo.create(id, user.userId, title) });
    } catch (err) {
      if (isDuplicate(err)) return send(res, 409, { error: "document already exists" });
      throw err;
    }
  }

  const docId = match(path, /^\/api\/docs\/([^/]+)$/);
  if (docId) {
    const role = await repo.roleFor(docId, user.userId);
    if (method === "GET") {
      if (!role) return send(res, 403, { error: "forbidden" });
      return send(res, 200, { doc: await repo.get(docId), role });
    }
    if (method === "PATCH") {
      if (role !== "owner" && role !== "editor") return send(res, 403, { error: "forbidden" });
      const body = await json(req);
      await repo.rename(docId, typeof body.title === "string" ? body.title : "Untitled");
      return send(res, 200, { ok: true });
    }
    if (method === "DELETE") {
      if (role !== "owner") return send(res, 403, { error: "forbidden" });
      await repo.remove(docId);
      return send(res, 200, { ok: true });
    }
  }

  const shareId = match(path, /^\/api\/docs\/([^/]+)\/share$/);
  if (shareId && method === "POST") {
    if ((await repo.roleFor(shareId, user.userId)) !== "owner")
      return send(res, 403, { error: "forbidden" });
    const body = await json(req);
    const role: Exclude<Role, "owner"> = body.role === "editor" ? "editor" : "viewer";
    return send(res, 200, { token: signShare(shareId, role, secret), role });
  }

  const permId = match(path, /^\/api\/docs\/([^/]+)\/permissions$/);
  if (permId && method === "GET") {
    if ((await repo.roleFor(permId, user.userId)) !== "owner")
      return send(res, 403, { error: "forbidden" });
    return send(res, 200, { permissions: await repo.listPermissions(permId) });
  }

  if (method === "POST" && path === "/api/share/accept") {
    const body = await json(req);
    const share = verifyShare(typeof body.token === "string" ? body.token : "", secret);
    if (!share) return send(res, 400, { error: "invalid share token" });
    // Never downgrade an existing owner.
    if ((await repo.roleFor(share.docId, user.userId)) === "owner") {
      return send(res, 200, { docId: share.docId, role: "owner" });
    }
    await repo.setRole(share.docId, user.userId, share.role);
    return send(res, 200, { docId: share.docId, role: share.role });
  }

  return send(res, 404, { error: "not found" });
}

// ── helpers ────────────────────────────────────────────────────────────────

function match(path: string, re: RegExp): string | null {
  const m = path.match(re);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
}

function bearerUser(req: IncomingMessage, secret: string): User | null {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return null;
  return verifyUser(auth.slice(7), secret);
}

async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString());
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

function cors(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization,content-type");
}

function isDuplicate(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "23505" || String((err as Error)?.message ?? "").includes("duplicate key");
}
