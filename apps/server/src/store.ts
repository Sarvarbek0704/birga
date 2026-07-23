import type { StoredOp } from "@birga/protocol";

export interface SnapshotRecord {
  readonly version: number;
  readonly snapshot: unknown;
}

/**
 * Persistence for a document's op log and snapshots. The server is a dumb relay,
 * so a store only needs to append opaque ops, hand back the ops after a given
 * seq (for late joiners and reconnects), and hold an optional snapshot.
 *
 * Implementations: {@link InMemoryDocStore} (single instance) and, when a shared
 * backend is configured, a Redis- or Postgres-backed store.
 */
export interface DocStore {
  /** Append an op, assigning the next per-document seq. */
  append(docId: string, op: unknown, replica: string): Promise<StoredOp>;
  /** Every op with `seq > afterSeq`, in ascending seq order. */
  since(docId: string, afterSeq: number): Promise<StoredOp[]>;
  /** Highest seq for the document (0 if empty). */
  head(docId: string): Promise<number>;
  loadSnapshot(docId: string): Promise<SnapshotRecord | null>;
  saveSnapshot(docId: string, version: number, snapshot: unknown): Promise<void>;
  close(): Promise<void>;
}

interface DocState {
  ops: StoredOp[];
  seq: number;
  snapshot: SnapshotRecord | null;
}

/** In-memory store — perfect for a single server instance and for tests. */
export class InMemoryDocStore implements DocStore {
  private readonly docs = new Map<string, DocState>();

  private state(docId: string): DocState {
    let s = this.docs.get(docId);
    if (!s) {
      s = { ops: [], seq: 0, snapshot: null };
      this.docs.set(docId, s);
    }
    return s;
  }

  async append(docId: string, op: unknown, replica: string): Promise<StoredOp> {
    const s = this.state(docId);
    s.seq += 1;
    const stored: StoredOp = { seq: s.seq, replica, op };
    s.ops.push(stored);
    return stored;
  }

  async since(docId: string, afterSeq: number): Promise<StoredOp[]> {
    const s = this.docs.get(docId);
    if (!s) return [];
    // ops are appended in seq order, so a filter preserves order.
    return s.ops.filter((o) => o.seq > afterSeq);
  }

  async head(docId: string): Promise<number> {
    const s = this.docs.get(docId);
    if (!s) return 0;
    // Floor at the snapshot version so head stays correct even if ops were pruned.
    return Math.max(s.seq, s.snapshot?.version ?? 0);
  }

  async loadSnapshot(docId: string): Promise<SnapshotRecord | null> {
    return this.docs.get(docId)?.snapshot ?? null;
  }

  async saveSnapshot(docId: string, version: number, snapshot: unknown): Promise<void> {
    this.state(docId).snapshot = { version, snapshot };
  }

  async close(): Promise<void> {
    this.docs.clear();
  }
}
