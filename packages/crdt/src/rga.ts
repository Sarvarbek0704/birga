import { type OpId, ROOT, key, compareId } from "./id.js";
import type { Op, InsertOp, DeleteOp, RgaNode, Snapshot } from "./types.js";

/**
 * An RGA (Replicated Growable Array) sequence CRDT for text, modelled as a
 * **causal tree**: every character is a node whose `parent` is the character it
 * was typed after (`ROOT` at the start). The document is the pre-order DFS of
 * that tree, with siblings ordered by their id (descending) and tombstoned
 * nodes skipped.
 *
 * ## Why it converges
 * The state is three order-insensitive structures:
 *   1. `nodes`      — a *set* of `(id → node)`, built from insert ops. Inserting
 *                     the same id twice is a no-op, so it is idempotent and the
 *                     final map depends only on *which* ops were seen, not when.
 *   2. `children`   — each parent's children kept sorted by {@link compareId}.
 *                     A total order sorted incrementally yields the same final
 *                     sequence regardless of insertion order.
 *   3. `tombstones` — a *set* of deleted ids (union is commutative/idempotent).
 *
 * A node is visible iff it is in `nodes` and not in `tombstones`. The traversal
 * is a pure function of these three. Therefore any two replicas that have
 * applied the *same set* of operations — in any order, with any duplicates —
 * produce byte-identical text. That is the property the test suite proves.
 *
 * Delivery order is not required: a delete may arrive before its insert (the
 * tombstone is remembered and applied when the insert lands), and an insert may
 * arrive before its parent (it waits in the parent's child bucket, invisible
 * until the parent connects it back to ROOT). Everything self-heals once the
 * full op set is present.
 */
export class RGA {
  readonly replica: string;
  private counter = 0;

  /** id.key → node (every node ever inserted, tombstones included). */
  private readonly nodes = new Map<string, RgaNode>();
  /** parent.key → children, kept sorted descending by id. */
  private readonly children = new Map<string, RgaNode[]>();
  /** Deleted ids — held even if the matching insert has not arrived yet. */
  private readonly tombstones = new Set<string>();

  constructor(replica: string) {
    if (replica === "") throw new Error("replica id must be non-empty");
    this.replica = replica;
    this.children.set(key(ROOT), []);
  }

  // ── local editing: mutate + return the op to broadcast ──────────────────

  private nextId(): OpId {
    this.counter += 1;
    return { replica: this.replica, counter: this.counter };
  }

  /** Insert `value` at visible position `index` (clamped to `[0, length]`). */
  insertAt(index: number, value: string): InsertOp {
    const visible = this.visibleNodes();
    const i = Math.max(0, Math.min(index, visible.length));
    const parent: OpId = i === 0 ? ROOT : visible[i - 1]!.id;
    const op: InsertOp = { type: "insert", id: this.nextId(), parent, value };
    this.apply(op);
    return op;
  }

  /** Delete the visible element at position `index`. */
  deleteAt(index: number): DeleteOp {
    const visible = this.visibleNodes();
    const node = visible[index];
    if (!node) {
      throw new RangeError(`deleteAt(${index}) out of range (length ${visible.length})`);
    }
    const op: DeleteOp = { type: "delete", id: node.id };
    this.apply(op);
    return op;
  }

  // ── applying ops (remote or replay); safe in any order, idempotent ──────

  apply(op: Op): void {
    if (op.type === "insert") this.applyInsert(op);
    else this.applyDelete(op);
  }

  applyAll(ops: Iterable<Op>): void {
    for (const op of ops) this.apply(op);
  }

  private applyInsert(op: InsertOp): void {
    // Keep our Lamport clock ahead of anything we've observed.
    if (op.id.counter > this.counter) this.counter = op.id.counter;

    const k = key(op.id);
    if (this.nodes.has(k)) return; // idempotent

    const node: RgaNode = {
      id: op.id,
      parent: op.parent,
      value: op.value,
      deleted: this.tombstones.has(k), // a delete may have raced ahead
    };
    this.nodes.set(k, node);
    this.linkChild(node);
  }

  private applyDelete(op: DeleteOp): void {
    this.tombstones.add(key(op.id)); // idempotent; works before the insert too
    const node = this.nodes.get(key(op.id));
    if (node) node.deleted = true;
  }

  /** Splice `node` into its parent's child list, keeping it sorted (desc by id). */
  private linkChild(node: RgaNode): void {
    const pk = key(node.parent);
    let list = this.children.get(pk);
    if (!list) {
      list = [];
      this.children.set(pk, list);
    }
    // Binary search for the first slot whose id sorts before ours.
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareId(list[mid]!.id, node.id) > 0) lo = mid + 1;
      else hi = mid;
    }
    list.splice(lo, 0, node);
  }

  // ── materialization (iterative pre-order DFS — no recursion depth limit) ─

  /** Every node in document order, tombstones included. */
  private ordered(): RgaNode[] {
    const out: RgaNode[] = [];
    const stack: RgaNode[] = [];
    const pushChildren = (parentKey: string): void => {
      const kids = this.children.get(parentKey);
      if (!kids) return;
      // Push in reverse so the leftmost child is processed first.
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    };
    pushChildren(key(ROOT));
    while (stack.length > 0) {
      const node = stack.pop()!;
      out.push(node);
      pushChildren(key(node.id));
    }
    return out;
  }

  private visibleNodes(): RgaNode[] {
    return this.ordered().filter((n) => !n.deleted);
  }

  toString(): string {
    let s = "";
    for (const node of this.ordered()) {
      if (!node.deleted) s += node.value;
    }
    return s;
  }

  /** Number of visible characters. */
  get length(): number {
    let n = 0;
    for (const node of this.ordered()) if (!node.deleted) n++;
    return n;
  }

  // ── serialization (snapshots for persistence & late joiners) ────────────

  snapshot(): Snapshot {
    const nodes = this.ordered().map((n) => ({
      id: n.id,
      parent: n.parent,
      value: n.value,
      deleted: n.deleted,
    }));
    return { version: 1, nodes };
  }

  /**
   * Merge a snapshot into *this* document. Unlike {@link fromSnapshot}, it keeps
   * whatever is already here — so a client that edited offline can fold in the
   * server's base state without losing its local ops. Idempotent.
   */
  mergeSnapshot(snap: Snapshot): void {
    for (const n of snap.nodes) {
      this.applyInsert({ type: "insert", id: n.id, parent: n.parent, value: n.value });
      if (n.deleted) this.applyDelete({ type: "delete", id: n.id });
    }
  }

  static fromSnapshot(replica: string, snap: Snapshot): RGA {
    const doc = new RGA(replica);
    // Sort by id so parents are guaranteed present before children — purely for
    // tidiness; the structure would converge from any order regardless.
    const sorted = [...snap.nodes].sort((a, b) => compareId(a.id, b.id));
    for (const n of sorted) {
      doc.applyInsert({ type: "insert", id: n.id, parent: n.parent, value: n.value });
      if (n.deleted) doc.applyDelete({ type: "delete", id: n.id });
    }
    return doc;
  }
}
