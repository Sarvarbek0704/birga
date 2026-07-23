import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RGA } from "@birga/crdt";
import type { StoredOp } from "@birga/protocol";
import { InMemoryDocStore } from "../src/store.js";
import { rgaCompactor } from "../src/compactor.js";
import { startServer, type RunningServer } from "../src/server.js";
import { TestClient } from "./client.js";

const foldPlainText = (prev: unknown | null, ops: StoredOp[]): unknown => {
  const doc = prev ? RGA.fromSnapshot("c", prev as never) : new RGA("c");
  for (const s of ops) doc.apply(s.op as never);
  return doc.snapshot();
};

async function until(pred: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeout) throw new Error("until timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("InMemoryDocStore — compaction", () => {
  it("folds ops into a snapshot, prunes them, stays reconstructable", async () => {
    const store = new InMemoryDocStore();
    const author = new RGA("A");
    for (const ch of "hello") await store.append("doc", author.insertAt(author.length, ch), "A");
    expect((await store.since("doc", 0)).length).toBe(5);

    const version = await store.compact("doc", foldPlainText);
    expect(version).toBe(5);
    expect(await store.since("doc", 0)).toHaveLength(0);
    expect(await store.head("doc")).toBe(5);

    const joiner = RGA.fromSnapshot("J", (await store.loadSnapshot("doc"))!.snapshot as never);
    expect(joiner.toString()).toBe("hello");
  });

  it("skips a document the builder does not recognise (null build)", async () => {
    const store = new InMemoryDocStore();
    await store.append("rich:doc", { anything: true }, "A");
    // rgaCompactor only folds plain: docs, so this is a no-op that keeps ops.
    const version = await store.compact("rich:doc", (prev, ops) => rgaCompactor("rich:doc", prev, ops));
    expect(version).toBe(0);
    expect(await store.since("rich:doc", 0)).toHaveLength(1);
  });
});

describe("sync server — automatic compaction sweep", () => {
  let server: RunningServer;
  const clients: TestClient[] = [];

  const client = async (): Promise<TestClient> => {
    const c = await TestClient.connect(server.port);
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    server = await startServer({
      port: 0,
      heartbeatMs: 0,
      compaction: { intervalMs: 30, minOps: 3, build: rgaCompactor },
    });
  });
  afterEach(async () => {
    await Promise.all(clients.map((c) => c.close()));
    clients.length = 0;
    await server.close();
  });

  it("compacts an active plain-text doc so late joiners load from a snapshot", async () => {
    const a = await client();
    await a.join("plain:doc", "A");
    a.typeEnd("hello world"); // 11 ops
    await a.waitUntil(() => a.head === 11);

    // The sweep should fold the ops into a snapshot.
    await until(async () => (await server.store.since("plain:doc", 0)).length === 0);
    const snap = await server.store.loadSnapshot("plain:doc");
    expect(snap?.version).toBe(11);

    // A late joiner reconstructs the text from snapshot + (zero) remaining ops.
    const b = await client();
    await b.join("plain:doc", "B");
    expect(b.text()).toBe("hello world");
    expect(b.lastWelcome?.ops.length).toBe(0);
    expect(b.lastWelcome?.snapshotVersion).toBe(11);
  });

  it("leaves rich-text (Yjs) docs untouched — their ops are not foldable", async () => {
    const a = await client();
    await a.join("rich:doc", "A");
    a.typeEnd("abcd");
    await a.waitUntil(() => a.head === 4);

    // Give the sweep several chances; the op log must stay intact.
    await new Promise((r) => setTimeout(r, 120));
    expect((await server.store.since("rich:doc", 0)).length).toBe(4);
    expect(await server.store.loadSnapshot("rich:doc")).toBeNull();
  });
});
