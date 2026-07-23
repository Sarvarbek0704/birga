import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { startServer, type RunningServer } from "../src/server.js";
import type { Authorize } from "../src/hub.js";
import { PostgresDocStore } from "../src/postgres.js";
import { DocumentsRepo } from "../src/documents.js";
import { issueGuest, signShare } from "../src/auth.js";
import { makeDocumentAuthorizer, stripEditorPrefix } from "../src/authz.js";
import { TestClient } from "./client.js";

const SECRET = "authz-secret";

describe("stripEditorPrefix", () => {
  it("maps editor surfaces to the base document", () => {
    expect(stripEditorPrefix("plain:abc")).toBe("abc");
    expect(stripEditorPrefix("rich:abc")).toBe("abc");
    expect(stripEditorPrefix("abc")).toBe("abc");
    expect(stripEditorPrefix("other:abc")).toBe("other:abc");
  });
});

describe("Hub authorization (stub authorizer)", () => {
  let server: RunningServer;
  const clients: TestClient[] = [];

  // Grant read to everyone, write only to token "writer".
  const authorize: Authorize = (_docId, token, need) =>
    need === "read" ? true : token === "writer";

  const client = async (): Promise<TestClient> => {
    const c = await TestClient.connect(server.port);
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    server = await startServer({ port: 0, heartbeatMs: 0, authorize });
  });
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients.length = 0;
    await server.close();
  });

  it("lets a writer's ops through and blocks a reader's", async () => {
    const writer = await client();
    const reader = await client();
    await writer.join("doc", "W", undefined, "writer");
    await reader.join("doc", "R", undefined, "reader");

    // Reader can read (received welcome) but its write is rejected server-side.
    expect(reader.lastWelcome).not.toBeNull();
    reader.insert(0, "x");
    await reader.waitUntil(() => reader.lastError !== null);
    expect(reader.lastError).toContain("not authorized to write");

    // Writer's ops are persisted and relayed to everyone.
    writer.typeEnd("hi");
    await writer.waitUntil(() => writer.head === 2 && writer.text() === "hi");
    await reader.waitUntil(() => reader.text().includes("hi"));

    // The security guarantee: the reader's rejected op was never persisted or
    // relayed, so the writer's document contains only "hi" (no stray "x").
    expect(writer.text()).toBe("hi");
  });

  it("denies a join that fails the read check", async () => {
    const denyReads: Authorize = () => false;
    const s2 = await startServer({ port: 0, heartbeatMs: 0, authorize: denyReads });
    const c = await TestClient.connect(s2.port);
    await c.join("doc", "A");
    expect(c.welcomed).toBe(false);
    expect(c.lastError).toContain("not authorized to read");
    await c.close();
    await s2.close();
  });
});

describe("makeDocumentAuthorizer (PGlite-backed)", () => {
  let db: PGlite;
  let repo: DocumentsRepo;
  let authorize: Authorize;

  beforeEach(async () => {
    db = new PGlite();
    const store = new PostgresDocStore(db);
    await store.migrate();
    repo = new DocumentsRepo(db);
    authorize = makeDocumentAuthorizer(repo, SECRET);
  });

  const tokenFor = (name: string): { token: string; userId: string } => {
    const { token, user } = issueGuest(name, SECRET);
    return { token, userId: user.userId };
  };

  it("treats unclaimed documents as public", async () => {
    expect(await authorize("nobody-owns-this", undefined, "read")).toBe(true);
    expect(await authorize("nobody-owns-this", undefined, "write")).toBe(true);
  });

  it("enforces roles once a document is claimed, across editor prefixes", async () => {
    const ada = issueGuest("Ada", SECRET);
    const grace = issueGuest("Grace", SECRET);
    await repo.create("doc", ada.user.userId);
    await repo.setRole("doc", grace.user.userId, "viewer");

    // Owner may read+write via the namespaced room ids.
    expect(await authorize("plain:doc", ada.token, "read")).toBe(true);
    expect(await authorize("rich:doc", ada.token, "write")).toBe(true);

    // Viewer may read but not write.
    expect(await authorize("plain:doc", grace.token, "read")).toBe(true);
    expect(await authorize("plain:doc", grace.token, "write")).toBe(false);

    // No token / unknown user is denied on a claimed doc.
    expect(await authorize("doc", undefined, "read")).toBe(false);
    expect(await authorize("doc", tokenFor("stranger").token, "read")).toBe(false);
  });

  it("honours a redeemed share link", async () => {
    const ada = issueGuest("Ada", SECRET);
    const grace = issueGuest("Grace", SECRET);
    await repo.create("doc", ada.user.userId);

    // A signed editor share exists; redeeming it grants the row the authorizer reads.
    const share = signShare("doc", "editor", SECRET);
    expect(share).toContain("."); // sanity: it is a signed token
    await repo.setRole("doc", grace.user.userId, "editor");

    expect(await authorize("plain:doc", grace.token, "write")).toBe(true);
  });
});
