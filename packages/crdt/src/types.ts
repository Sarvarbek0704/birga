import type { OpId } from "./id.js";

/**
 * Insert `value` immediately after the element identified by `parent`
 * (or `ROOT` to insert at the very start). `id` is the new element's id.
 */
export interface InsertOp {
  readonly type: "insert";
  readonly id: OpId;
  readonly parent: OpId;
  /** A single user-perceived character. */
  readonly value: string;
}

/** Tombstone the element identified by `id`. Deletes are never un-done. */
export interface DeleteOp {
  readonly type: "delete";
  readonly id: OpId;
}

export type Op = InsertOp | DeleteOp;

/** Internal node of the causal tree. Tombstoned nodes are retained forever. */
export interface RgaNode {
  readonly id: OpId;
  readonly parent: OpId;
  readonly value: string;
  deleted: boolean;
}

/** A serialized point-in-time copy of the whole document, for late joiners. */
export interface Snapshot {
  readonly version: 1;
  readonly nodes: ReadonlyArray<{
    readonly id: OpId;
    readonly parent: OpId;
    readonly value: string;
    readonly deleted: boolean;
  }>;
}
