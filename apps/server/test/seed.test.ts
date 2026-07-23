import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { RGA } from "@birga/crdt";
import * as Y from "yjs";
import { PostgresDocStore } from "../src/postgres.js";
import { DocumentsRepo } from "../src/documents.js";
import { verifyUser } from "../src/auth.js";
import { seed, DEMO_DOCS, DEMO_USERS } from "../src/seed.js";

const SECRET = "seed-secret";

describe("seed — demo dataset", () => {
  let store: PostgresDocStore;
  let repo: DocumentsRepo;

  beforeEach(async () => {
    const db = new PGlite();
    store = new PostgresDocStore(db);
    await store.migrate();
    repo = new DocumentsRepo(store.queryable);
  });

  it("creates the demo documents with the right owners and shared roles", async () => {
    await seed(store, repo, SECRET);

    const welcome = await repo.get("welcome");
    expect(welcome).toMatchObject({ id: "welcome", ownerId: "demo-ada", title: "👋 Welcome to Birga" });
    expect(await repo.roleFor("welcome", "demo-ada")).toBe("owner");
    expect(await repo.roleFor("welcome", "demo-ben")).toBe("editor");
    expect(await repo.roleFor("welcome", "demo-carol")).toBe("viewer");

    // Every demo user can see at least one document, across roles.
    for (const u of DEMO_USERS) {
      const docs = await repo.listForUser(u.userId);
      expect(docs.length).toBeGreaterThan(0);
    }
  });

  it("seeds plain-text content that reconstructs from the CRDT snapshot", async () => {
    await seed(store, repo, SECRET);
    const snap = await store.loadSnapshot("plain:welcome");
    expect(snap).not.toBeNull();
    const doc = RGA.fromSnapshot("t", snap!.snapshot as never);
    expect(doc.toString()).toContain("Welcome to Birga");
    expect(doc.toString()).toBe(DEMO_DOCS.find((d) => d.id === "welcome")!.plain);
  });

  it("seeds rich-text content as a valid Yjs update", async () => {
    await seed(store, repo, SECRET);
    const snap = await store.loadSnapshot("rich:welcome");
    expect(snap).not.toBeNull();

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, Uint8Array.from(Buffer.from(snap!.snapshot as string, "base64")));
    expect(ydoc.getXmlFragment("default").toString()).toContain("Welcome to Birga");
  });

  it("returns working demo tokens for each persona", async () => {
    const result = await seed(store, repo, SECRET);
    expect(result.accounts).toHaveLength(DEMO_USERS.length);
    for (const acc of result.accounts) {
      const user = verifyUser(acc.token, SECRET);
      expect(user).toEqual({ userId: acc.userId, name: acc.name });
    }
  });

  it("is idempotent — re-running does not duplicate or error", async () => {
    await seed(store, repo, SECRET);
    await seed(store, repo, SECRET);
    // Still exactly one row per demo doc for the owner's listing.
    const adaDocs = await repo.listForUser("demo-ada");
    const ids = adaDocs.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
