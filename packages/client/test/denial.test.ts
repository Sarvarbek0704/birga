import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { startServer, type RunningServer } from "@birga/server";
import { PlainTextRoom, MemoryStorage, webSocketConnection } from "../src/index.js";

let server: RunningServer;
const rooms: PlainTextRoom[] = [];

function waitFor(room: PlainTextRoom, pred: () => boolean, timeout = 3000): Promise<void> {
  if (pred()) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      offs.forEach((o) => o());
      reject(new Error("waitFor timed out"));
    }, timeout);
    const check = (): void => {
      if (pred()) {
        clearTimeout(timer);
        offs.forEach((o) => o());
        resolve();
      }
    };
    const offs = [room.on("change", check), room.on("presence", check), room.on("status", check)];
  });
}

function room(replica: string, token: string): PlainTextRoom {
  const r = new PlainTextRoom({
    docId: "doc",
    replica,
    connect: () => webSocketConnection(`ws://localhost:${server.port}`, WebSocket as never),
    storage: new MemoryStorage(),
    token,
    autoReconnect: false,
  });
  rooms.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rooms) r.disconnect();
  rooms.length = 0;
  await server.close();
});

describe("PlainTextRoom — permission denial", () => {
  it("rolls back to server truth and goes read-only when a write is denied", async () => {
    // A server that lets anyone read but only "writer" write.
    server = await startServer({
      port: 0,
      heartbeatMs: 0,
      authorize: (_doc, token, need) => (need === "read" ? true : token === "writer"),
    });

    const writer = room("W", "writer");
    const viewer = room("V", "viewer");

    await writer.ready();
    writer.connect();
    await waitFor(writer, () => writer.isConnected);
    await viewer.ready();
    viewer.connect();
    await waitFor(viewer, () => viewer.isConnected);

    writer.setText("hello");
    await waitFor(writer, () => writer.syncedHead >= 5 && writer.pending === 0);
    await waitFor(viewer, () => viewer.text === "hello");

    // The viewer's optimistic edit is rejected; it must roll back to "hello".
    const denied = new Promise<string>((resolve) => {
      const off = viewer.on("denied", (reason) => {
        off();
        resolve(reason);
      });
    });
    viewer.insert(0, "X");
    expect(await denied).toBe("write");

    await waitFor(viewer, () => viewer.readOnly && viewer.text === "hello");
    expect(viewer.text).toBe("hello"); // the stray "X" was discarded

    // Further local edits are ignored while read-only.
    viewer.insert(0, "Y");
    expect(viewer.text).toBe("hello");

    // The writer never saw the viewer's rejected op.
    expect(writer.text).toBe("hello");
  });
});
