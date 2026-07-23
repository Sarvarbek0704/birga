import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { StoredOp } from "@birga/protocol";
import type { DocStore, SnapshotRecord, CompactBuild } from "./store.js";
import type { Fanout, FanoutHandler, FanoutMessage } from "./fanout.js";

const FANOUT_CHANNEL = "birga:fanout";
const keyOps = (docId: string): string => `birga:{${docId}}:ops`;
const keySeq = (docId: string): string => `birga:{${docId}}:seq`;
const keySnap = (docId: string): string => `birga:{${docId}}:snap`;

/**
 * Cross-instance fan-out over Redis pub/sub. Every instance publishes room
 * messages to one channel and rebroadcasts peers' messages to its local rooms.
 * Messages are tagged with a per-instance id so we ignore our own echoes.
 */
export class RedisFanout implements Fanout {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly instanceId = randomUUID();
  private handler: FanoutHandler | null = null;

  constructor(url: string) {
    this.pub = new Redis(url);
    this.sub = new Redis(url);
  }

  publish(docId: string, msg: FanoutMessage): void {
    void this.pub.publish(FANOUT_CHANNEL, JSON.stringify({ from: this.instanceId, docId, msg }));
  }

  onMessage(handler: FanoutHandler): void {
    this.handler = handler;
    void this.sub.subscribe(FANOUT_CHANNEL);
    this.sub.on("message", (_channel, payload) => {
      try {
        const { from, docId, msg } = JSON.parse(payload) as {
          from: string;
          docId: string;
          msg: FanoutMessage;
        };
        if (from === this.instanceId) return; // our own echo
        this.handler?.(docId, msg);
      } catch {
        /* ignore malformed peer payloads */
      }
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([this.pub.quit(), this.sub.quit()]);
  }
}

/**
 * Shared op-log store in Redis, so multiple instances persist to and read from
 * one place (required for cross-instance late-join). The `{docId}` hash-tag
 * keeps a document's keys on the same cluster slot.
 */
export class RedisDocStore implements DocStore {
  private readonly redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url);
  }

  async append(docId: string, op: unknown, replica: string): Promise<StoredOp> {
    const seq = await this.redis.incr(keySeq(docId));
    const stored: StoredOp = { seq, replica, op };
    await this.redis.rpush(keyOps(docId), JSON.stringify(stored));
    return stored;
  }

  async since(docId: string, afterSeq: number): Promise<StoredOp[]> {
    const raw = await this.redis.lrange(keyOps(docId), 0, -1);
    const out: StoredOp[] = [];
    for (const line of raw) {
      const op = JSON.parse(line) as StoredOp;
      if (op.seq > afterSeq) out.push(op);
    }
    return out;
  }

  async head(docId: string): Promise<number> {
    const v = await this.redis.get(keySeq(docId));
    return v ? Number(v) : 0;
  }

  async loadSnapshot(docId: string): Promise<SnapshotRecord | null> {
    const v = await this.redis.get(keySnap(docId));
    return v ? (JSON.parse(v) as SnapshotRecord) : null;
  }

  async saveSnapshot(docId: string, version: number, snapshot: unknown): Promise<void> {
    await this.redis.set(keySnap(docId), JSON.stringify({ version, snapshot }));
  }

  async compact(docId: string, build: CompactBuild): Promise<number> {
    const prev = await this.loadSnapshot(docId);
    const base = prev?.version ?? 0;
    const ops = await this.since(docId, base);
    if (ops.length === 0) return base;

    const version = ops[ops.length - 1]!.seq;
    const snapshot = build(prev?.snapshot ?? null, ops);
    if (snapshot === null || snapshot === undefined) return base;

    // Save the snapshot first, then drop the ops we folded. A concurrent writer's
    // op keeps a higher seq, so trimming by count is safe here (single list).
    await this.saveSnapshot(docId, version, snapshot);
    await this.redis.ltrim(keyOps(docId), ops.length, -1);
    return version;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}
