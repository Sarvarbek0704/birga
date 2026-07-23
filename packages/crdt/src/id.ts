/**
 * A globally-unique, causally-ordered identifier for a single CRDT element.
 *
 * Lamport-style: `(replica, counter)`. The counter is a Lamport clock — every
 * replica keeps its own counter ahead of the highest counter it has ever seen,
 * so ids issued after observing an operation always sort after it. Because the
 * `replica` component is unique per client, no two elements ever share an id,
 * even when two clients pick the same counter concurrently.
 */
export interface OpId {
  readonly replica: string;
  readonly counter: number;
}

/**
 * The virtual origin every document hangs off. Real inserts reference `ROOT`
 * when they belong at the very start of the document. It is never rendered.
 */
export const ROOT: OpId = { replica: "", counter: 0 };

export function isRoot(id: OpId): boolean {
  return id.counter === 0 && id.replica === "";
}

/** Stable string key for use in Maps/Sets. Follows the `counter@replica` convention. */
export function key(id: OpId): string {
  return `${id.counter}@${id.replica}`;
}

export function eqId(a: OpId, b: OpId): boolean {
  return a.counter === b.counter && a.replica === b.replica;
}

/**
 * A total order over ids, identical on every replica.
 *
 * Ordering is by Lamport `counter`, tie-broken by `replica` lexicographically.
 * This determinism is the whole game: two replicas that hold the same set of
 * concurrent siblings will always sort them the same way, so they render the
 * same text.
 *
 * @returns `> 0` if `a` sorts after `b`, `< 0` if before, `0` if equal.
 */
export function compareId(a: OpId, b: OpId): number {
  if (a.counter !== b.counter) return a.counter - b.counter;
  if (a.replica < b.replica) return -1;
  if (a.replica > b.replica) return 1;
  return 0;
}
