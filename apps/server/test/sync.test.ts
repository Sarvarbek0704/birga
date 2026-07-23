import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { RGA } from "@birga/crdt";
import { startServer, type RunningServer } from "../src/server.js";
import { TestClient } from "./client.js";

let server: RunningServer;
const clients: TestClient[] = [];

async function client(): Promise<TestClient> {
  const c = await TestClient.connect(server.port);
  clients.push(c);
  return c;
}

beforeEach(async () => {
  // Ephemeral port, no heartbeat noise during tests.
  server = await startServer({ port: 0, heartbeatMs: 0 });
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  clients.length = 0;
  await server.close();
});

describe("sync server — relay", () => {
  it("relays an op from one replica to another in the same room", async () => {
    const a = await client();
    const b = await client();
    await a.join("doc1", "A");
    await b.join("doc1", "B");

    a.typeEnd("hi");
    await b.waitForText("hi");
    expect(b.text()).toBe("hi");
  });

  it("does not cross documents", async () => {
    const a = await client();
    const b = await client();
    await a.join("docA", "A");
    await b.join("docB", "B");

    a.typeEnd("secret");
    // Give it a moment; b must NOT receive it.
    await new Promise((r) => setTimeout(r, 100));
    expect(b.text()).toBe("");
  });
});

describe("sync server — persistence & late joiners", () => {
  it("a late joiner catches up on the full history", async () => {
    const a = await client();
    await a.join("doc", "A");
    a.typeEnd("hello");
    // Ensure the server persisted all five ops (a sees its own echoes).
    await a.waitUntil(() => a.head === 5);

    const b = await client();
    await b.join("doc", "B");
    expect(b.text()).toBe("hello");
    expect(b.lastWelcome?.ops.length).toBe(5);
  });

  it("serves a late joiner from a snapshot without replaying history", async () => {
    const a = await client();
    await a.join("doc", "A");
    a.typeEnd("hello world");
    await a.waitUntil(() => a.head === 11);

    // Compact: store a snapshot at the current head, as periodic compaction would.
    const authoritative = new RGA("srv");
    const ops = await server.store.since("doc", 0);
    for (const o of ops) authoritative.apply(o.op as never);
    await server.store.saveSnapshot("doc", a.head, authoritative.snapshot());

    const b = await client();
    await b.join("doc", "B");
    expect(b.text()).toBe("hello world");
    expect(b.lastWelcome?.snapshotVersion).toBe(11);
    // Nothing after the snapshot → no ops replayed.
    expect(b.lastWelcome?.ops.length).toBe(0);
  });
});

describe("sync server — reconnect", () => {
  it("sends only missed ops when reconnecting with `since`", async () => {
    const a = await client();
    const b = await client();
    await a.join("doc", "A");
    await b.join("doc", "B");

    a.typeEnd("ab"); // seq 1,2
    await b.waitForText("ab");
    const aHead = a.head; // A has seen up to seq 2

    await a.close();
    clients.splice(clients.indexOf(a), 1);

    b.typeEnd("c"); // seq 3, while A is away
    await b.waitForText("abc");

    // A reconnects and asks only for what it missed.
    const a2 = await client();
    a2.replica = "A";
    // Seed A2 with A's prior state by replaying nothing — reconnect brings only seq>since.
    await a2.join("doc", "A", aHead);
    // The welcome carried exactly one op (seq 3), no snapshot.
    expect(a2.lastWelcome?.snapshot).toBeNull();
    expect(a2.lastWelcome?.ops.map((o) => o.seq)).toEqual([3]);
  });
});

describe("sync server — awareness (presence)", () => {
  it("relays presence but never persists it", async () => {
    const a = await client();
    const b = await client();
    await a.join("doc", "A");
    await b.join("doc", "B");

    a.sendAwareness({ cursor: 3, user: "Ada" });
    await b.waitUntil(() => b.awareness.length === 1);
    expect(b.awareness[0]).toEqual({ replica: "A", state: { cursor: 3, user: "Ada" } });

    // Awareness is not an op: head stays 0 and a fresh joiner sees no ops.
    expect(await server.store.head("doc")).toBe(0);
    const c = await client();
    await c.join("doc", "C");
    expect(c.lastWelcome?.ops.length).toBe(0);
    expect(c.awareness.length).toBe(0);
  });

  it("notifies the room when a replica leaves", async () => {
    const a = await client();
    const b = await client();
    await a.join("doc", "A");
    await b.join("doc", "B");

    await a.close();
    clients.splice(clients.indexOf(a), 1);
    await b.waitUntil(() => b.leaves.includes("A"));
    expect(b.leaves).toContain("A");
  });
});

describe("sync server — convergence through the relay", () => {
  it("three replicas editing concurrently converge to one document", async () => {
    const a = await client();
    const b = await client();
    const c = await client();
    await a.join("doc", "A");
    await b.join("doc", "B");
    await c.join("doc", "C");

    // Interleaved edits from all three at the front of the document.
    a.insert(0, "a");
    b.insert(0, "b");
    c.insert(0, "c");
    a.insert(0, "A");
    b.insert(0, "B");

    // Each client re-checks only on its own inbound messages, so wait per client.
    await a.waitUntil(() => a.head === 5);
    await b.waitUntil(() => b.head === 5);
    await c.waitUntil(() => c.head === 5);

    // All three must agree, and the order is deterministic (id tie-break).
    expect(a.text()).toBe(b.text());
    expect(b.text()).toBe(c.text());
    expect(a.text().length).toBe(5);
  });
});
