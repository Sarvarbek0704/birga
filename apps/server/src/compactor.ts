import { RGA, type Op, type Snapshot } from "@birga/crdt";
import type { StoredOp } from "@birga/protocol";

/**
 * Decides how to fold a document's ops into a snapshot. Returns `null` to skip
 * (the document type isn't understood, so its ops are kept intact).
 */
export type CompactionBuild = (
  docId: string,
  prevSnapshot: unknown | null,
  ops: StoredOp[],
) => unknown | null;

/**
 * Compaction for the from-scratch plain-text path. Rooms are namespaced
 * `plain:<id>`; only those carry `@birga/crdt` ops we can fold. Rich-text
 * (`rich:<id>`, Yjs) and anything else are skipped — their ops stay in the log.
 */
export const rgaCompactor: CompactionBuild = (docId, prevSnapshot, ops) => {
  if (!docId.startsWith("plain:")) return null;
  const doc = prevSnapshot
    ? RGA.fromSnapshot("compactor", prevSnapshot as Snapshot)
    : new RGA("compactor");
  for (const stored of ops) doc.apply(stored.op as Op);
  return doc.snapshot();
};
