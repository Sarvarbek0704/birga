import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from "y-protocols/awareness";
import { webSocketConnection, type Connection } from "@birga/client";
import type { Identity } from "./identity";

/**
 * A Yjs network provider that tunnels Yjs document updates and awareness over
 * the **Birga sync protocol** — the same CRDT-agnostic server used by the
 * from-scratch plain-text path. Yjs updates are opaque binary, so we base64them
 * into the protocol's `op` / `awareness` string payloads.
 *
 * Yjs is itself a CRDT: updates are commutative and idempotent, so replaying the
 * server's full op log (in any order) reconstructs the document. No server-side
 * Yjs knowledge is required.
 */
export interface BirgaYjsProviderOptions {
  url: string;
  docId: string;
  doc: Y.Doc;
  user: Identity;
  /** Bearer token sent with join, used when the server enforces permissions. */
  token?: string;
}

const toB64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
};

const fromB64 = (b64: string): Uint8Array => {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export class BirgaYjsProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  private conn: Connection | null = null;
  private connected = false;
  private destroyed = false;
  private readonly url: string;
  private readonly docId: string;
  private readonly token: string | undefined;
  private readonly statusCbs = new Set<(connected: boolean) => void>();

  constructor(opts: BirgaYjsProviderOptions) {
    this.doc = opts.doc;
    this.url = opts.url;
    this.docId = opts.docId;
    this.token = opts.token;
    this.awareness = new Awareness(this.doc);
    this.awareness.setLocalStateField("user", opts.user);

    this.doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", this.onUnload);
    }
    this.connect();
  }

  onStatus(cb: (connected: boolean) => void): () => void {
    this.statusCbs.add(cb);
    return () => this.statusCbs.delete(cb);
  }

  private emitStatus(connected: boolean): void {
    for (const cb of this.statusCbs) cb(connected);
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return; // update arrived from the network; don't echo
    this.send({ type: "op", docId: this.docId, op: toB64(update) });
  };

  private onAwarenessUpdate = (changes: {
    added: number[];
    updated: number[];
    removed: number[];
  }): void => {
    const clients = [...changes.added, ...changes.updated, ...changes.removed];
    const update = encodeAwarenessUpdate(this.awareness, clients);
    this.send({ type: "awareness", docId: this.docId, state: toB64(update) });
  };

  private onUnload = (): void => {
    removeAwarenessStates(this.awareness, [this.doc.clientID], "unload");
  };

  private connect(): void {
    const conn = webSocketConnection(this.url);
    this.conn = conn;

    conn.onOpen(() => {
      if (this.conn !== conn) return;
      this.connected = true;
      this.emitStatus(true);
      this.rawSend(conn, {
        type: "join",
        docId: this.docId,
        replica: String(this.doc.clientID),
        token: this.token,
      });
      // Push our current state (possibly restored from IndexedDB while offline)
      // so peers merge it, plus our awareness.
      this.rawSend(conn, {
        type: "op",
        docId: this.docId,
        op: toB64(Y.encodeStateAsUpdate(this.doc)),
      });
      this.rawSend(conn, {
        type: "awareness",
        docId: this.docId,
        state: toB64(encodeAwarenessUpdate(this.awareness, [this.doc.clientID])),
      });
    });

    conn.onMessage((data) => {
      if (this.conn === conn) this.onMessage(data);
    });

    conn.onClose(() => {
      if (this.conn !== conn) return;
      this.connected = false;
      this.conn = null;
      this.emitStatus(false);
      if (!this.destroyed) {
        setTimeout(() => {
          if (!this.destroyed && !this.conn) this.connect();
        }, 1000);
      }
    });
  }

  private onMessage(data: string): void {
    let msg: {
      type?: string;
      ops?: Array<{ op: string }>;
      op?: string;
      state?: string;
      snapshot?: string | null;
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        // A base snapshot (e.g. seeded content) is a full Yjs state update.
        if (typeof msg.snapshot === "string") Y.applyUpdate(this.doc, fromB64(msg.snapshot), this);
        for (const stored of msg.ops ?? []) Y.applyUpdate(this.doc, fromB64(stored.op), this);
        break;
      case "op":
        if (msg.op) Y.applyUpdate(this.doc, fromB64(msg.op), this);
        break;
      case "awareness":
        if (msg.state) applyAwarenessUpdate(this.awareness, fromB64(msg.state), this);
        break;
    }
  }

  private send(msg: Record<string, unknown>): void {
    if (this.connected && this.conn) this.rawSend(this.conn, msg);
  }

  private rawSend(conn: Connection, msg: Record<string, unknown>): void {
    conn.send(JSON.stringify(msg));
  }

  destroy(): void {
    this.destroyed = true;
    if (typeof window !== "undefined") window.removeEventListener("beforeunload", this.onUnload);
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    removeAwarenessStates(this.awareness, [this.doc.clientID], "destroy");
    this.conn?.close();
    this.conn = null;
  }
}
