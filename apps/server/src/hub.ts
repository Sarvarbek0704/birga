import type { WebSocket } from "ws";
import {
  parseClientMessage,
  type ServerMessage,
  type JoinMessage,
  type OpMessage,
  type AwarenessMessage,
} from "@birga/protocol";
import type { DocStore } from "./store.js";
import type { Fanout, FanoutMessage } from "./fanout.js";

/** Per-connection state: which replica this socket speaks for, per document. */
interface Conn {
  readonly socket: WebSocket;
  readonly replicaByDoc: Map<string, string>;
  /** The auth token supplied at join time, per document (for op-time checks). */
  readonly tokenByDoc: Map<string, string | undefined>;
}

const OPEN = 1; // WebSocket.OPEN

/**
 * Decides whether a token may `read` (join) or `write` (submit ops) a document.
 * When no authorizer is configured the Hub is fully open (the default).
 */
export type Authorize = (
  docId: string,
  token: string | undefined,
  need: "read" | "write",
) => boolean | Promise<boolean>;

/**
 * The relay core, independent of transport wiring. It owns rooms (the set of
 * local sockets per document), persists ops via a {@link DocStore}, and mirrors
 * ops/awareness/leaves to peer instances through a {@link Fanout}.
 *
 * The server never interprets ops. Correctness of concurrent editing lives in
 * the CRDT at the client edges; the Hub only guarantees *delivery*: every op is
 * persisted once and reaches every current and future room member.
 */
export class Hub {
  private readonly conns = new Map<WebSocket, Conn>();
  private readonly rooms = new Map<string, Set<Conn>>();

  constructor(
    private readonly store: DocStore,
    private readonly fanout: Fanout,
    private readonly authorize: Authorize | null = null,
  ) {
    // Deliver peer messages to our local room members.
    this.fanout.onMessage((docId, msg) => this.broadcastLocal(docId, msg, null));
  }

  addConnection(socket: WebSocket): void {
    const conn: Conn = { socket, replicaByDoc: new Map(), tokenByDoc: new Map() };
    this.conns.set(socket, conn);
    socket.on("message", (data) => {
      void this.onMessage(conn, data.toString());
    });
    socket.on("close", () => this.onClose(conn));
    socket.on("error", () => this.onClose(conn));
  }

  private async onMessage(conn: Conn, raw: string): Promise<void> {
    const msg = parseClientMessage(raw);
    if (!msg) {
      this.send(conn, { type: "error", message: "malformed message" });
      return;
    }
    try {
      switch (msg.type) {
        case "join":
          await this.onJoin(conn, msg);
          break;
        case "op":
          await this.onOp(conn, msg);
          break;
        case "awareness":
          this.onAwareness(conn, msg);
          break;
      }
    } catch (err) {
      this.send(conn, { type: "error", message: (err as Error).message });
    }
  }

  private async onJoin(conn: Conn, msg: JoinMessage): Promise<void> {
    if (this.authorize && !(await this.authorize(msg.docId, msg.token, "read"))) {
      this.send(conn, {
        type: "error",
        code: "forbidden-read",
        message: `not authorized to read ${msg.docId}`,
      });
      return;
    }
    conn.replicaByDoc.set(msg.docId, msg.replica);
    conn.tokenByDoc.set(msg.docId, msg.token);
    this.roomOf(msg.docId).add(conn);

    const head = await this.store.head(msg.docId);

    if (msg.since === undefined) {
      // Fresh join: snapshot (if any) plus the ops recorded after it.
      const snap = await this.store.loadSnapshot(msg.docId);
      const base = snap?.version ?? 0;
      const ops = await this.store.since(msg.docId, base);
      this.send(conn, {
        type: "welcome",
        docId: msg.docId,
        snapshot: snap?.snapshot ?? null,
        snapshotVersion: base,
        ops,
        head,
      });
    } else {
      // Reconnect: only the ops missed since `since`. No snapshot needed.
      const ops = await this.store.since(msg.docId, msg.since);
      this.send(conn, {
        type: "welcome",
        docId: msg.docId,
        snapshot: null,
        snapshotVersion: 0,
        ops,
        head,
      });
    }
  }

  private async onOp(conn: Conn, msg: OpMessage): Promise<void> {
    const replica = conn.replicaByDoc.get(msg.docId);
    if (!replica) {
      this.send(conn, { type: "error", message: `op before join for doc ${msg.docId}` });
      return;
    }
    if (this.authorize) {
      const token = conn.tokenByDoc.get(msg.docId);
      if (!(await this.authorize(msg.docId, token, "write"))) {
        this.send(conn, {
          type: "error",
          code: "forbidden-write",
          message: `not authorized to write ${msg.docId}`,
        });
        return;
      }
    }
    const stored = await this.store.append(msg.docId, msg.op, replica);
    const out: FanoutMessage = {
      type: "op",
      docId: msg.docId,
      seq: stored.seq,
      replica,
      op: msg.op,
    };
    // Echo to the whole room, author included: the author re-applies it
    // idempotently but learns the server-assigned seq, which it needs to pass as
    // `since` on reconnect. (Awareness and leaves still skip their origin.)
    this.broadcastLocal(msg.docId, out, null);
    this.fanout.publish(msg.docId, out);
  }

  private onAwareness(conn: Conn, msg: AwarenessMessage): void {
    const replica = conn.replicaByDoc.get(msg.docId);
    if (!replica) return; // presence before join is meaningless; drop it
    const out: FanoutMessage = {
      type: "awareness",
      docId: msg.docId,
      replica,
      state: msg.state,
    };
    this.broadcastLocal(msg.docId, out, conn);
    this.fanout.publish(msg.docId, out);
  }

  private onClose(conn: Conn): void {
    if (!this.conns.delete(conn.socket)) return; // already handled
    for (const [docId, replica] of conn.replicaByDoc) {
      const room = this.rooms.get(docId);
      room?.delete(conn);
      if (room && room.size === 0) this.rooms.delete(docId);
      const leave: FanoutMessage = { type: "leave", docId, replica };
      this.broadcastLocal(docId, leave, conn);
      this.fanout.publish(docId, leave);
    }
  }

  /** Send `msg` to every local socket in the room, optionally skipping `except`. */
  private broadcastLocal(docId: string, msg: ServerMessage, except: Conn | null): void {
    const room = this.rooms.get(docId);
    if (!room) return;
    for (const conn of room) {
      if (conn === except) continue;
      this.send(conn, msg);
    }
  }

  private roomOf(docId: string): Set<Conn> {
    let room = this.rooms.get(docId);
    if (!room) {
      room = new Set();
      this.rooms.set(docId, room);
    }
    return room;
  }

  private send(conn: Conn, msg: ServerMessage): void {
    if (conn.socket.readyState !== OPEN) return;
    conn.socket.send(JSON.stringify(msg));
  }

  /** Live room count, for diagnostics/tests. */
  get roomCount(): number {
    return this.rooms.size;
  }

  /** Document ids with at least one connected member — the compaction targets. */
  activeDocIds(): string[] {
    return [...this.rooms.keys()];
  }
}
