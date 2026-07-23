import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PostgresDocStore } from "../src/postgres.js";
import { DocumentsRepo } from "../src/documents.js";
import { startApi, type RunningApi } from "../src/api.js";
import { seed } from "../src/seed.js";

let api: RunningApi;
let base: string;

async function get(path: string, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(base + path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, json: res.status === 204 ? null : await res.json() };
}

beforeEach(async () => {
  const store = new PostgresDocStore(new PGlite());
  await store.migrate();
  const repo = new DocumentsRepo(store.queryable);
  await seed(store, repo, "demo-secret");
  api = await startApi({ repo, secret: "demo-secret", port: 0 });
  base = `http://localhost:${api.port}`;
});

afterEach(async () => {
  await api.close();
  delete process.env["DEMO_ACCOUNTS"];
});

describe("demo login end-to-end", () => {
  it("hides demo accounts unless DEMO_ACCOUNTS=1", async () => {
    delete process.env["DEMO_ACCOUNTS"];
    expect((await get("/api/demo/accounts")).status).toBe(404);
  });

  it("a demo token lists the seeded documents with the persona's roles", async () => {
    process.env["DEMO_ACCOUNTS"] = "1";
    const accounts = (await get("/api/demo/accounts")).json.accounts as Array<{
      userId: string;
      name: string;
      token: string;
    }>;
    expect(accounts.map((a) => a.userId)).toEqual(["demo-ada", "demo-ben", "demo-carol"]);

    const ada = accounts.find((a) => a.userId === "demo-ada")!;
    const list = (await get("/api/docs", ada.token)).json.docs as Array<{ id: string; role: string }>;
    // Ada owns several docs and is an editor on the team-sync doc.
    const byId = Object.fromEntries(list.map((d) => [d.id, d.role]));
    expect(byId["welcome"]).toBe("owner");
    expect(byId["team-sync"]).toBe("editor");

    // Carol is mostly a viewer.
    const carol = accounts.find((a) => a.userId === "demo-carol")!;
    const carolList = (await get("/api/docs", carol.token)).json.docs as Array<{ id: string; role: string }>;
    expect(carolList.find((d) => d.id === "welcome")?.role).toBe("viewer");
  });
});
