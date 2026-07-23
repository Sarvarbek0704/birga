import type { StoredOp } from "@birga/protocol";
import type { DocStore, SnapshotRecord, CompactBuild } from "./store.js";

/**
 * The minimal query surface both `pg` (`Pool`/`Client`) and PGlite satisfy.
 * Parameters use Postgres `$1, $2, …` placeholders.
 */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** Schema, one statement per entry (PGlite's `query` runs a single statement). */
const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS document_ops (
     document_id TEXT   NOT NULL,
     seq         BIGINT NOT NULL,
     replica_id  TEXT   NOT NULL,
     op          JSONB  NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (document_id, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS document_snapshots (
     document_id TEXT   PRIMARY KEY,
     version     BIGINT NOT NULL,
     snapshot    JSONB  NOT NULL,
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS documents (
     id         TEXT PRIMARY KEY,
     owner_id   TEXT NOT NULL,
     title      TEXT NOT NULL DEFAULT 'Untitled',
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS permissions (
     document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
     user_id     TEXT NOT NULL,
     role        TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
     PRIMARY KEY (document_id, user_id)
   )`,
];

interface HeadRow {
  head: string | number;
}
interface SeqRow {
  seq: string | number;
}
interface OpRow {
  seq: string | number;
  replica_id: string;
  op: unknown;
}
interface SnapRow {
  version: string | number;
  snapshot: unknown;
}

const num = (v: string | number): number => (typeof v === "number" ? v : Number(v));

/**
 * Postgres-backed op log + snapshots. Ops and snapshots are stored as JSONB
 * (our protocol payloads are JSON), decoupled from the `documents`/`permissions`
 * metadata handled by {@link DocumentsRepo}. Supports **op-log compaction**: fold
 * the log into a snapshot and prune the folded ops in one atomic statement.
 */
export class PostgresDocStore implements DocStore {
  private pool: { end(): Promise<void> } | null = null;

  constructor(private readonly db: Queryable) {}

  /** The underlying connection, so a `DocumentsRepo` can share it. */
  get queryable(): Queryable {
    return this.db;
  }

  /** Open a production store from a connection string (lazily loads `pg`). */
  static async connect(connectionString: string): Promise<PostgresDocStore> {
    const pg = await import("pg");
    const pool = new pg.Pool({ connectionString });
    const store = new PostgresDocStore(pool as unknown as Queryable);
    store.pool = pool;
    await store.migrate();
    return store;
  }

  async migrate(): Promise<void> {
    for (const stmt of SCHEMA) await this.db.query(stmt);
  }

  private async nextHead(docId: string): Promise<number> {
    const { rows } = await this.db.query<HeadRow>(
      `SELECT GREATEST(
         COALESCE((SELECT version FROM document_snapshots WHERE document_id = $1), 0),
         COALESCE((SELECT MAX(seq) FROM document_ops       WHERE document_id = $1), 0)
       ) AS head`,
      [docId],
    );
    return rows[0] ? num(rows[0].head) : 0;
  }

  async append(docId: string, op: unknown, replica: string): Promise<StoredOp> {
    // Next seq = head + 1. Under concurrent writers the (document_id, seq) PK
    // rejects a loser, so retry a few times.
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const { rows } = await this.db.query<SeqRow>(
          `WITH h AS (
             SELECT GREATEST(
               COALESCE((SELECT version FROM document_snapshots WHERE document_id = $1), 0),
               COALESCE((SELECT MAX(seq) FROM document_ops       WHERE document_id = $1), 0)
             ) + 1 AS seq
           )
           INSERT INTO document_ops (document_id, seq, replica_id, op)
           SELECT $1, h.seq, $2, $3::jsonb FROM h
           RETURNING seq`,
          [docId, replica, JSON.stringify(op)],
        );
        return { seq: num(rows[0]!.seq), replica, op };
      } catch (err) {
        if (attempt === 5 || !isUniqueViolation(err)) throw err;
      }
    }
    throw new Error("unreachable");
  }

  async since(docId: string, afterSeq: number): Promise<StoredOp[]> {
    const { rows } = await this.db.query<OpRow>(
      `SELECT seq, replica_id, op FROM document_ops
       WHERE document_id = $1 AND seq > $2 ORDER BY seq ASC`,
      [docId, afterSeq],
    );
    return rows.map((r) => ({ seq: num(r.seq), replica: r.replica_id, op: r.op }));
  }

  async head(docId: string): Promise<number> {
    return this.nextHead(docId);
  }

  async loadSnapshot(docId: string): Promise<SnapshotRecord | null> {
    const { rows } = await this.db.query<SnapRow>(
      `SELECT version, snapshot FROM document_snapshots WHERE document_id = $1`,
      [docId],
    );
    return rows[0] ? { version: num(rows[0].version), snapshot: rows[0].snapshot } : null;
  }

  async saveSnapshot(docId: string, version: number, snapshot: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO document_snapshots (document_id, version, snapshot)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (document_id)
       DO UPDATE SET version = EXCLUDED.version, snapshot = EXCLUDED.snapshot, updated_at = now()`,
      [docId, version, JSON.stringify(snapshot)],
    );
  }

  /**
   * Compact the op log: fold the ops recorded after the current snapshot into a
   * new snapshot, then delete those ops — all in one atomic, writable-CTE
   * statement so a late joiner never sees a gap. `build` is CRDT-aware: it
   * receives the previous snapshot (or null) and the ops after it, and returns
   * the new snapshot payload. Returns the version compacted through.
   */
  async compact(docId: string, build: CompactBuild): Promise<number> {
    const prev = await this.loadSnapshot(docId);
    const base = prev?.version ?? 0;
    const ops = await this.since(docId, base);
    if (ops.length === 0) return base; // nothing new to fold

    const version = ops[ops.length - 1]!.seq;
    const snapshot = build(prev?.snapshot ?? null, ops);
    if (snapshot === null || snapshot === undefined) return base; // unrecognised type

    await this.db.query(
      `WITH snap AS (
         INSERT INTO document_snapshots (document_id, version, snapshot)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (document_id)
         DO UPDATE SET version = EXCLUDED.version, snapshot = EXCLUDED.snapshot, updated_at = now()
       )
       DELETE FROM document_ops WHERE document_id = $1 AND seq <= $2`,
      [docId, version, JSON.stringify(snapshot)],
    );
    return version;
  }

  async close(): Promise<void> {
    await this.pool?.end();
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "23505" || String((err as Error)?.message ?? "").includes("duplicate key");
}
