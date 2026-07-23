import { RGA, key, type Op } from "@birga/crdt";
import type { ServerMessage } from "@birga/protocol";
import type { Connection } from "./connection.js";
import { MemoryStorage, type Storage, type PersistedDoc } from "./storage.js";

export type PresenceMap = ReadonlyMap<string, unknown>;

export interface RoomEvents {
  /** The document text changed (local edit or remote op). */
  change: (text: string) => void;
  /** Presence changed (someone updated awareness or left). */
  presence: (presence: PresenceMap) => void;
  /** Connection status changed. */
  status: (connected: boolean) => void;
}

export interface RoomOptions {
  docId: string;
  replica: string;
  /** Factory invoked on every (re)connect. Lets the room reopen a fresh socket. */
  connect: () => Connection;
  storage?: Storage;
  /** Reconnect automatically on drop. Disable in tests for determinism. */
  autoReconnect?: boolean;
  /** Base reconnect delay (ms); grows with consecutive failures, capped at 10s. */
  reconnectDelayMs?: number;
}

/**
 * Binds `@birga/crdt` to the Birga wire protocol for a single plain-text
 * document. Handles the three hard client concerns from the spec:
 *
 *  - **offline-first** — every local edit is applied immediately and queued in an
 *    outbox; edits made while disconnected flush on reconnect.
 *  - **reconnect** — rejoin with `since = head` to fetch only missed ops, then
 *    resend the outbox. Idempotent + order-independent ops make this safe.
 *  - **awareness** — ephemeral presence relayed separately from the document.
 *
 * The document itself always converges because the underlying CRDT does; this
 * class only manages transport and persistence.
 */
export class PlainTextRoom {
  readonly docId: string;
  readonly replica: string;

  private doc = new RGA("pending");
  private head = 0;
  /** Local ops awaiting server confirmation (keyed by op id). */
  private readonly outbox = new Map<string, Op>();

  private readonly storage: Storage;
  private readonly makeConnection: () => Connection;
  private conn: Connection | null = null;
  private connected = false;
  private closedByUser = false;
  private reconnectAttempts = 0;
  private readonly autoReconnect: boolean;
  private readonly baseDelay: number;

  private readonly presenceMap = new Map<string, unknown>();
  private readonly listeners: { [K in keyof RoomEvents]: Set<RoomEvents[K]> } = {
    change: new Set(),
    presence: new Set(),
    status: new Set(),
  };

  private loaded = false;

  constructor(opts: RoomOptions) {
    this.docId = opts.docId;
    this.replica = opts.replica;
    this.makeConnection = opts.connect;
    this.storage = opts.storage ?? new MemoryStorage();
    this.autoReconnect = opts.autoReconnect ?? true;
    this.baseDelay = opts.reconnectDelayMs ?? 500;
    this.doc = new RGA(opts.replica);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────

  /** Restore any locally-persisted state. Call once before editing. */
  async ready(): Promise<void> {
    if (this.loaded) return;
    const persisted = await this.storage.load(this.docId);
    if (persisted) {
      this.doc = RGA.fromSnapshot(this.replica, persisted.snapshot);
      this.head = persisted.head;
      for (const op of persisted.outbox) this.outbox.set(key(idOf(op)), op);
    }
    this.loaded = true;
    this.emit("change", this.text);
  }

  connect(): void {
    this.closedByUser = false;
    if (this.conn) return;
    const conn = this.makeConnection();
    this.conn = conn;
    // Guard against a stale socket: a previous connection's delayed close/message
    // must not touch state once we've moved on to a new one.
    conn.onOpen(() => {
      if (this.conn === conn) this.onOpen();
    });
    conn.onMessage((data) => {
      if (this.conn === conn) this.onServerMessage(data);
    });
    conn.onClose(() => {
      if (this.conn === conn) this.onClose();
    });
  }

  /** Disconnect without tearing down local state (offline mode). */
  disconnect(): void {
    this.closedByUser = true;
    this.connected = false;
    const conn = this.conn;
    this.conn = null; // any later event from `conn` is now ignored by the guards
    conn?.close();
    this.emit("status", false);
  }

  private onOpen(): void {
    this.connected = true;
    this.reconnectAttempts = 0;
    // Fresh join (no prior sync) omits `since` to receive a snapshot; a
    // reconnect passes the last applied seq to fetch only what it missed.
    const since = this.head > 0 ? this.head : undefined;
    this.conn?.send(JSON.stringify({ type: "join", docId: this.docId, replica: this.replica, since }));
    this.emit("status", true);
  }

  private onClose(): void {
    this.connected = false;
    this.conn = null;
    this.emit("status", false);
    if (this.autoReconnect && !this.closedByUser) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(this.baseDelay * 2 ** this.reconnectAttempts, 10_000);
    this.reconnectAttempts += 1;
    setTimeout(() => {
      if (!this.closedByUser && !this.conn) this.connect();
    }, delay);
  }

  // ── server messages ───────────────────────────────────────────────────

  private onServerMessage(data: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome": {
        if (msg.snapshot !== null) this.doc.mergeSnapshot(msg.snapshot as never);
        for (const stored of msg.ops) this.integrate(stored.op as Op, stored.seq);
        this.head = Math.max(this.head, msg.head);
        // Resend anything the server never acknowledged.
        for (const op of this.outbox.values()) this.sendOp(op);
        this.emit("change", this.text);
        void this.persist();
        break;
      }
      case "op":
        this.integrate(msg.op as Op, msg.seq);
        this.emit("change", this.text);
        void this.persist();
        break;
      case "awareness":
        this.presenceMap.set(msg.replica, msg.state);
        this.emit("presence", this.presenceMap);
        break;
      case "leave":
        if (this.presenceMap.delete(msg.replica)) this.emit("presence", this.presenceMap);
        break;
      case "error":
        // Surface via console; callers can add richer handling later.
        console.warn(`[birga] server error: ${msg.message}`);
        break;
    }
  }

  /** Apply a server op and mark any matching local op confirmed. */
  private integrate(op: Op, seq: number): void {
    this.doc.apply(op);
    this.outbox.delete(key(idOf(op)));
    this.head = Math.max(this.head, seq);
  }

  // ── local editing ─────────────────────────────────────────────────────

  private afterLocal(op: Op): void {
    this.outbox.set(key(idOf(op)), op);
    this.sendOp(op);
    this.emit("change", this.text);
    void this.persist();
  }

  private sendOp(op: Op): void {
    if (this.connected && this.conn) {
      this.conn.send(JSON.stringify({ type: "op", docId: this.docId, op }));
    }
  }

  insert(index: number, ch: string): void {
    this.afterLocal(this.doc.insertAt(index, ch));
  }

  delete(index: number): void {
    this.afterLocal(this.doc.deleteAt(index));
  }

  /**
   * Reconcile the document to `next` by diffing against current text: shared
   * prefix/suffix are kept, the differing middle is deleted then re-inserted.
   * Lets a plain `<textarea>` drive the CRDT with its full value.
   */
  setText(next: string): void {
    const cur = this.text;
    if (cur === next) return;
    let p = 0;
    const max = Math.min(cur.length, next.length);
    while (p < max && cur[p] === next[p]) p++;
    let s = 0;
    while (s < max - p && cur[cur.length - 1 - s] === next[next.length - 1 - s]) s++;

    const delCount = cur.length - p - s;
    // Deleting at the same index repeatedly removes the whole differing middle.
    for (let i = 0; i < delCount; i++) this.delete(p);
    const inserted = next.slice(p, next.length - s);
    for (let i = 0; i < inserted.length; i++) this.insert(p + i, inserted[i]!);
  }

  /** Broadcast ephemeral presence (cursor/selection/user). Never persisted. */
  setAwareness(state: unknown): void {
    if (this.connected && this.conn) {
      this.conn.send(JSON.stringify({ type: "awareness", docId: this.docId, state }));
    }
  }

  // ── reads ─────────────────────────────────────────────────────────────

  get text(): string {
    return this.doc.toString();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Highest server seq applied — what a reconnect passes as `since`. */
  get syncedHead(): number {
    return this.head;
  }

  /** Count of local ops not yet confirmed by the server. */
  get pending(): number {
    return this.outbox.size;
  }

  get presence(): PresenceMap {
    return this.presenceMap;
  }

  // ── events ────────────────────────────────────────────────────────────

  on<K extends keyof RoomEvents>(event: K, cb: RoomEvents[K]): () => void {
    this.listeners[event].add(cb);
    return () => this.listeners[event].delete(cb);
  }

  private emit<K extends keyof RoomEvents>(event: K, arg: Parameters<RoomEvents[K]>[0]): void {
    for (const cb of this.listeners[event]) (cb as (a: typeof arg) => void)(arg);
  }

  private async persist(): Promise<void> {
    if (!this.loaded) return;
    const doc: PersistedDoc = {
      snapshot: this.doc.snapshot(),
      head: this.head,
      outbox: [...this.outbox.values()],
    };
    await this.storage.save(this.docId, doc);
  }
}

/** Both op kinds carry an `id`. */
function idOf(op: Op): { replica: string; counter: number } {
  return op.id;
}
