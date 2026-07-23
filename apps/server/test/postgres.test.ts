import { describe, it, expect, beforeEach } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { RGA } from "@birga/crdt";
import type { StoredOp } from "@birga/protocol";
import { InMemoryDocStore } from "../src/store.js";
import { PostgresDocStore } from "../src/postgres.js";
import { DocumentsRepo } from "../src/documents.js";
import { runStoreContract } from "./store-contract.js";

// ── contract parity: both stores behave identically ─────────────────────────

runStoreContract("InMemoryDocStore", () => new InMemoryDocStore());

runStoreContract("PostgresDocStore (PGlite)", async () => {
  const store = new PostgresDocStore(new PGlite());
  await store.migrate();
  return store;
});

// ── compaction ──────────────────────────────────────────────────────────────

/** Fold @birga/crdt ops (over an optional prior snapshot) into a new snapshot. */
function foldPlainText(prev: unknown | null, ops: StoredOp[]): unknown {
  const doc = prev ? RGA.fromSnapshot("compactor", prev as never) : new RGA("compactor");
  for (const s of ops) doc.apply(s.op as never);
  return doc.snapshot();
}

describe("PostgresDocStore — op-log compaction", () => {
  let db: PGlite;
  let store: PostgresDocStore;

  beforeEach(async () => {
    db = new PGlite();
    store = new PostgresDocStore(db);
    await store.migrate();
  });

  it("folds ops into a snapshot, prunes them, and stays reconstructable", async () => {
    // Author "hello world" as real RGA ops through the store.
    const author = new RGA("A");
    for (const ch of "hello world") {
      const op = author.insertAt(author.length, ch);
      await store.append("doc", op, "A");
    }
    expect((await store.since("doc", 0)).length).toBe(11);

    const version = await store.compact("doc", foldPlainText);
    expect(version).toBe(11);

    // Ops are gone; a snapshot stands in their place.
    expect(await store.since("doc", 0)).toHaveLength(0);
    const snap = await store.loadSnapshot("doc");
    expect(snap?.version).toBe(11);
    expect(await store.head("doc")).toBe(11);

    // A late joiner reconstructs the exact text from snapshot + (no) ops.
    const joiner = RGA.fromSnapshot("J", snap!.snapshot as never);
    expect(joiner.toString()).toBe("hello world");
  });

  it("compacts incrementally over an existing snapshot without losing history", async () => {
    const author = new RGA("A");
    for (const ch of "abc") await store.append("doc", author.insertAt(author.length, ch), "A");
    await store.compact("doc", foldPlainText); // snapshot @3

    // More edits after the snapshot.
    for (const ch of "de") await store.append("doc", author.insertAt(author.length, ch), "A");
    const v2 = await store.compact("doc", foldPlainText); // folds "de" onto snapshot
    expect(v2).toBe(5);

    const snap = await store.loadSnapshot("doc");
    const joiner = RGA.fromSnapshot("J", snap!.snapshot as never);
    expect(joiner.toString()).toBe("abcde");
    expect(await store.since("doc", 0)).toHaveLength(0);
  });

  it("compacting an empty document is a no-op", async () => {
    expect(await store.compact("empty", foldPlainText)).toBe(0);
    expect(await store.loadSnapshot("empty")).toBeNull();
  });
});

// ── documents + permissions ───────────────────────────────────────────────

describe("DocumentsRepo — documents & permissions", () => {
  let db: PGlite;
  let repo: DocumentsRepo;

  beforeEach(async () => {
    db = new PGlite();
    const store = new PostgresDocStore(db);
    await store.migrate();
    repo = new DocumentsRepo(db);
  });

  it("creates a document owned by its creator", async () => {
    const doc = await repo.create("d1", "ada", "Design notes");
    expect(doc).toMatchObject({ id: "d1", ownerId: "ada", title: "Design notes" });
    expect(await repo.roleFor("d1", "ada")).toBe("owner");
    expect(await repo.canEdit("d1", "ada")).toBe(true);
  });

  it("lists documents a user can see, with their role, newest first", async () => {
    await repo.create("d1", "ada", "One");
    await repo.create("d2", "linus", "Two");
    await repo.setRole("d2", "ada", "viewer");

    const forAda = await repo.listForUser("ada");
    expect(forAda.map((d) => d.id).sort()).toEqual(["d1", "d2"]);
    expect(forAda.find((d) => d.id === "d1")?.role).toBe("owner");
    expect(forAda.find((d) => d.id === "d2")?.role).toBe("viewer");

    const forLinus = await repo.listForUser("linus");
    expect(forLinus.map((d) => d.id)).toEqual(["d2"]);
  });

  it("enforces edit rights by role", async () => {
    await repo.create("d1", "ada");
    await repo.setRole("d1", "grace", "editor");
    await repo.setRole("d1", "ken", "viewer");

    expect(await repo.canEdit("d1", "grace")).toBe(true);
    expect(await repo.canEdit("d1", "ken")).toBe(false);
    expect(await repo.canEdit("d1", "stranger")).toBe(false);
  });

  it("revokes shares but never the owner", async () => {
    await repo.create("d1", "ada");
    await repo.setRole("d1", "grace", "editor");
    await repo.revoke("d1", "grace");
    expect(await repo.roleFor("d1", "grace")).toBeNull();

    await repo.revoke("d1", "ada"); // owner is protected
    expect(await repo.roleFor("d1", "ada")).toBe("owner");
  });

  it("cascades permissions when a document is deleted", async () => {
    await repo.create("d1", "ada");
    await repo.setRole("d1", "grace", "editor");
    await repo.remove("d1");
    expect(await repo.get("d1")).toBeNull();
    expect(await repo.roleFor("d1", "grace")).toBeNull();
  });
});
