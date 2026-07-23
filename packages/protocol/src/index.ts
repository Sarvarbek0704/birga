/**
 * Birga wire protocol.
 *
 * The sync server is **CRDT-agnostic**: it relays and persists opaque `op`
 * payloads without interpreting them. The same protocol therefore carries
 * `@birga/crdt` operations *and* Yjs updates. Interpretation happens only at the
 * client edges.
 *
 * All messages travel as JSON text frames.
 */

/** An operation as persisted by the server: opaque payload + assigned sequence. */
export interface StoredOp {
  /** Server-assigned, per-document, strictly increasing sequence number. */
  readonly seq: number;
  /** The replica that authored the op. */
  readonly replica: string;
  /** Opaque op payload (a serialized CRDT operation). */
  readonly op: unknown;
}

// ── client → server ───────────────────────────────────────────────────────

/**
 * Join (or rejoin) a document room.
 * - Omit `since` for a fresh join: the server replies with a snapshot plus the
 *   ops after it.
 * - Pass `since` (the highest seq already applied) to reconnect: the server
 *   replies with only the ops you missed — no snapshot.
 */
export interface JoinMessage {
  readonly type: "join";
  readonly docId: string;
  readonly replica: string;
  readonly since?: number;
  /** Bearer token identifying the user, checked when the server enforces access. */
  readonly token?: string;
}

/** Submit a local op for relay + persistence. The server stamps the replica. */
export interface OpMessage {
  readonly type: "op";
  readonly docId: string;
  readonly op: unknown;
}

/** Ephemeral presence (cursor, selection, user). Relayed, never persisted. */
export interface AwarenessMessage {
  readonly type: "awareness";
  readonly docId: string;
  readonly state: unknown;
}

export type ClientMessage = JoinMessage | OpMessage | AwarenessMessage;

// ── server → client ───────────────────────────────────────────────────────

/** Reply to a join: enough state to reconstruct the document locally. */
export interface WelcomeMessage {
  readonly type: "welcome";
  readonly docId: string;
  /** Base snapshot to load first, or `null` (reconnect, or empty document). */
  readonly snapshot: unknown | null;
  /** The seq the snapshot corresponds to (0 when there is none). */
  readonly snapshotVersion: number;
  /** Ops to apply on top of the snapshot (or on top of `since`). */
  readonly ops: readonly StoredOp[];
  /** Latest seq the server holds for this document. */
  readonly head: number;
}

/** A relayed op authored by some replica in the room. */
export interface ServerOpMessage {
  readonly type: "op";
  readonly docId: string;
  readonly seq: number;
  readonly replica: string;
  readonly op: unknown;
}

/** A relayed presence update from another replica. */
export interface ServerAwarenessMessage {
  readonly type: "awareness";
  readonly docId: string;
  readonly replica: string;
  readonly state: unknown;
}

/** A replica left the room (disconnected). Clear its presence. */
export interface LeaveMessage {
  readonly type: "leave";
  readonly docId: string;
  readonly replica: string;
}

export interface ErrorMessage {
  readonly type: "error";
  readonly message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | ServerOpMessage
  | ServerAwarenessMessage
  | LeaveMessage
  | ErrorMessage;

// ── parsing / validation ────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Parse and shape-validate a raw text frame from a client.
 * Returns the typed message, or `null` if it is malformed (caller should reject).
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(data) || typeof data["type"] !== "string") return null;

  switch (data["type"]) {
    case "join": {
      if (typeof data["docId"] !== "string" || typeof data["replica"] !== "string") return null;
      const since = data["since"];
      if (since !== undefined && typeof since !== "number") return null;
      const token = data["token"];
      if (token !== undefined && typeof token !== "string") return null;
      return { type: "join", docId: data["docId"], replica: data["replica"], since, token };
    }
    case "op": {
      if (typeof data["docId"] !== "string" || !("op" in data)) return null;
      return { type: "op", docId: data["docId"], op: data["op"] };
    }
    case "awareness": {
      if (typeof data["docId"] !== "string" || !("state" in data)) return null;
      return { type: "awareness", docId: data["docId"], state: data["state"] };
    }
    default:
      return null;
  }
}
