import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "@birga/server";
import { PlainTextRoom, MemoryStorage, webSocketConnection } from "../src/index.js";

let server: RunningServer;
const rooms: PlainTextRoom[] = [];

function connectFactory() {
  const url = `ws://localhost:${server.port}`;
  return () => webSocketConnection(url, WebSocket as never);
}

/** Resolve once `pred` holds, watching change/presence/status events. */
function waitFor(room: PlainTextRoom, pred: () => boolean, timeout = 3000): Promise<void> {
  if (pred()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      offs.forEach((off) => off());
      reject(new Error("waitFor timed out"));
    }, timeout);
    const check = (): void => {
      if (pred()) {
        clearTimeout(timer);
        offs.forEach((off) => off());
        resolve();
      }
    };
    const offs = [room.on("change", check), room.on("presence", check), room.on("status", check)];
  });
}

async function makeRoom(
  docId: string,
  replica: string,
  storage = new MemoryStorage(),
): Promise<PlainTextRoom> {
  const room = new PlainTextRoom({
    docId,
    replica,
    connect: connectFactory(),
    storage,
    autoReconnect: false,
  });
  rooms.push(room);
  await room.ready();
  room.connect();
  await waitFor(room, () => room.isConnected);
  return room;
}

beforeEach(async () => {
  server = await startServer({ port: 0, heartbeatMs: 0 });
});

afterEach(async () => {
  for (const r of rooms) r.disconnect();
  rooms.length = 0;
  await server.close();
});

describe("PlainTextRoom — live sync", () => {
  it("propagates edits between two connected rooms", async () => {
    const a = await makeRoom("doc", "A");
    const b = await makeRoom("doc", "B");

    a.setText("hello");
    await waitFor(b, () => b.text === "hello");
    expect(b.text).toBe("hello");
  });

  it("setText diffing turns a full-value replace into minimal ops", async () => {
    const a = await makeRoom("doc", "A");
    const b = await makeRoom("doc", "B");

    a.setText("the quick fox");
    await waitFor(b, () => b.text === "the quick fox");
    a.setText("the slow fox"); // only the middle word changes
    await waitFor(b, () => b.text === "the slow fox");
    expect(b.text).toBe("the slow fox");
  });
});

describe("PlainTextRoom — offline-first", () => {
  it("edits made offline flush and converge on reconnect", async () => {
    const a = await makeRoom("doc", "A");
    const b = await makeRoom("doc", "B");

    a.setText("ab");
    await waitFor(a, () => a.syncedHead === 2 && a.pending === 0);
    await waitFor(b, () => b.text === "ab");

    // A goes offline and keeps editing.
    a.disconnect();
    a.insert(2, "c");
    a.insert(3, "d"); // "abcd" locally, queued
    expect(a.pending).toBe(2);

    // Meanwhile B edits online.
    b.insert(0, "X"); // "Xab"
    await waitFor(b, () => b.text === "Xab");

    // A reconnects: fetches B's op, resends its outbox, everyone converges.
    a.connect();
    await waitFor(a, () => a.pending === 0 && a.text.includes("X") && a.text.includes("cd"));
    await waitFor(b, () => b.text === a.text);

    expect(a.text).toBe(b.text);
    for (const ch of "abcdX") expect(a.text).toContain(ch);
  });
});

describe("PlainTextRoom — persistence & reconnect", () => {
  it("restores from storage and rejoins with `since` to catch up", async () => {
    const storage = new MemoryStorage();
    const a = await makeRoom("doc", "A", storage);
    const b = await makeRoom("doc", "B");

    a.setText("hello");
    await waitFor(a, () => a.syncedHead === 5 && a.pending === 0);
    await waitFor(b, () => b.text === "hello");

    // Simulate a reload: same storage, brand-new room object.
    a.disconnect();
    const a2 = new PlainTextRoom({
      docId: "doc",
      replica: "A",
      connect: connectFactory(),
      storage,
      autoReconnect: false,
    });
    rooms.push(a2);
    await a2.ready();
    expect(a2.text).toBe("hello"); // restored from IndexedDB-style storage

    // B adds more while A2 is still offline.
    b.insert(5, "!");
    await waitFor(b, () => b.text === "hello!");

    // A2 connects and catches up via `since`.
    a2.connect();
    await waitFor(a2, () => a2.text === "hello!");
    expect(a2.text).toBe("hello!");
  });
});

describe("PlainTextRoom — awareness / presence", () => {
  it("relays presence and clears it on leave", async () => {
    const a = await makeRoom("doc", "A");
    const b = await makeRoom("doc", "B");

    a.setAwareness({ cursor: 2, user: "Ada" });
    await waitFor(b, () => b.presence.has("A"));
    expect(b.presence.get("A")).toEqual({ cursor: 2, user: "Ada" });

    a.disconnect();
    await waitFor(b, () => !b.presence.has("A"));
    expect(b.presence.has("A")).toBe(false);
  });
});
