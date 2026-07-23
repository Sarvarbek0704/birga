import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PostgresDocStore } from "../src/postgres.js";
import { DocumentsRepo } from "../src/documents.js";
import { startApi, type RunningApi } from "../src/api.js";

let api: RunningApi;
let base: string;

beforeEach(async () => {
  const store = new PostgresDocStore(new PGlite());
  await store.migrate();
  const repo = new DocumentsRepo(store.queryable);
  api = await startApi({ repo, secret: "test-secret", port: 0 });
  base = `http://localhost:${api.port}`;
});

afterEach(async () => {
  await api.close();
});

/** A tiny typed fetch helper carrying an optional bearer token. */
async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = res.status === 204 ? null : await res.json();
  return { status: res.status, json };
}

async function guest(name: string): Promise<{ token: string; userId: string }> {
  const { json } = await call("POST", "/api/auth/guest", { body: { name } });
  return { token: json.token, userId: json.user.userId };
}

describe("REST API — auth", () => {
  it("issues a guest token and rejects unauthenticated access", async () => {
    const { status, json } = await call("POST", "/api/auth/guest", { body: { name: "Ada" } });
    expect(status).toBe(200);
    expect(json.user.name).toBe("Ada");
    expect(typeof json.token).toBe("string");

    expect((await call("GET", "/api/docs")).status).toBe(401);
    expect((await call("GET", "/api/docs", { token: "garbage.sig" })).status).toBe(401);
  });
});

describe("REST API — documents", () => {
  it("creates and lists documents scoped to the owner", async () => {
    const ada = await guest("Ada");
    const created = await call("POST", "/api/docs", { token: ada.token, body: { title: "Notes" } });
    expect(created.status).toBe(201);
    const id = created.json.doc.id;

    const list = await call("GET", "/api/docs", { token: ada.token });
    expect(list.json.docs).toHaveLength(1);
    expect(list.json.docs[0]).toMatchObject({ id, title: "Notes", role: "owner" });

    // Another user sees nothing and is forbidden from the doc.
    const linus = await guest("Linus");
    expect((await call("GET", "/api/docs", { token: linus.token })).json.docs).toHaveLength(0);
    expect((await call("GET", `/api/docs/${id}`, { token: linus.token })).status).toBe(403);
  });

  it("rejects a duplicate document id", async () => {
    const ada = await guest("Ada");
    await call("POST", "/api/docs", { token: ada.token, body: { id: "dup" } });
    const again = await call("POST", "/api/docs", { token: ada.token, body: { id: "dup" } });
    expect(again.status).toBe(409);
  });

  it("enforces roles on rename and delete", async () => {
    const ada = await guest("Ada");
    const { json } = await call("POST", "/api/docs", { token: ada.token, body: { id: "d1" } });
    const id = json.doc.id;
    const linus = await guest("Linus");

    // Stranger cannot rename or delete.
    expect((await call("PATCH", `/api/docs/${id}`, { token: linus.token, body: { title: "x" } })).status).toBe(403);
    expect((await call("DELETE", `/api/docs/${id}`, { token: linus.token })).status).toBe(403);

    // Owner can.
    expect((await call("PATCH", `/api/docs/${id}`, { token: ada.token, body: { title: "Renamed" } })).status).toBe(200);
    expect((await call("GET", `/api/docs/${id}`, { token: ada.token })).json.doc.title).toBe("Renamed");
    expect((await call("DELETE", `/api/docs/${id}`, { token: ada.token })).status).toBe(200);
    expect((await call("GET", `/api/docs/${id}`, { token: ada.token })).status).toBe(403);
  });
});

describe("REST API — share links", () => {
  it("owner shares a viewer link; redeemer gains read-only access", async () => {
    const ada = await guest("Ada");
    const { json: made } = await call("POST", "/api/docs", { token: ada.token, body: { id: "doc" } });
    const id = made.doc.id;

    // Non-owner cannot mint a share link.
    const grace = await guest("Grace");
    expect((await call("POST", `/api/docs/${id}/share`, { token: grace.token, body: { role: "viewer" } })).status).toBe(403);

    // Owner mints a viewer link; Grace redeems it.
    const share = await call("POST", `/api/docs/${id}/share`, { token: ada.token, body: { role: "viewer" } });
    expect(share.json.role).toBe("viewer");
    const accept = await call("POST", "/api/share/accept", { token: grace.token, body: { token: share.json.token } });
    expect(accept.json).toMatchObject({ docId: id, role: "viewer" });

    // Grace now sees the doc (read-only) but cannot edit it.
    const graceList = await call("GET", "/api/docs", { token: grace.token });
    expect(graceList.json.docs[0]).toMatchObject({ id, role: "viewer" });
    expect((await call("PATCH", `/api/docs/${id}`, { token: grace.token, body: { title: "no" } })).status).toBe(403);

    // Owner sees both permissions.
    const perms = await call("GET", `/api/docs/${id}/permissions`, { token: ada.token });
    expect(perms.json.permissions).toEqual(
      expect.arrayContaining([
        { userId: ada.userId, role: "owner" },
        { userId: grace.userId, role: "viewer" },
      ]),
    );
  });

  it("an editor share link grants write access", async () => {
    const ada = await guest("Ada");
    const { json } = await call("POST", "/api/docs", { token: ada.token, body: { id: "doc" } });
    const id = json.doc.id;
    const grace = await guest("Grace");

    const share = await call("POST", `/api/docs/${id}/share`, { token: ada.token, body: { role: "editor" } });
    await call("POST", "/api/share/accept", { token: grace.token, body: { token: share.json.token } });

    expect((await call("PATCH", `/api/docs/${id}`, { token: grace.token, body: { title: "ok" } })).status).toBe(200);
  });

  it("rejects a tampered share token", async () => {
    const grace = await guest("Grace");
    const bad = await call("POST", "/api/share/accept", { token: grace.token, body: { token: "nope.nope" } });
    expect(bad.status).toBe(400);
  });
});
