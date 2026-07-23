# I wrote a CRDT from scratch — here's why concurrent edits never conflict

This is the story of [`@birga/crdt`](../packages/crdt): a small, dependency-free
**sequence CRDT** for text that two people can edit at the same time — offline,
even — and always end up with the *identical* document. No “last write wins”, no
lost characters, no merge dialog. And it's backed by a property-based test suite
that proves convergence over thousands of randomised interleavings.

## The problem

Two people share a document that reads `Helo`. Both notice the typo. At the same
instant:

- **Ada** inserts an `l` to make `Hello`.
- **Ben** also inserts an `l` to make `Hello`.

Their edits cross on the wire. What should the result be? With naïve
“last-write-wins” you keep one edit and drop the other → `Hello` (one `l` lost is
fine here, but the same race on *different* insertions silently destroys text).
With a lock, one of them can't type. Neither is acceptable for real-time editing.

The problem is that **a position in a string is not stable**. “Insert at index 3”
means different things to Ada and Ben once either of them has edited. We need a
way to name a place in the document that *every* replica agrees on, forever.

## The idea: name every character, and never move it

`@birga/crdt` models the document as a **causal tree** (this is the RGA family of
CRDTs). Every character is a **node** with:

- a globally-unique id `(replica, counter)` — a Lamport timestamp, so ids issued
  after seeing someone else's edit always sort *after* it; the `replica` part
  keeps ids unique even under a dead heat;
- a **parent**: the id of the character it was typed *after* (a virtual `ROOT`
  for the very start).

Characters are never deleted or renumbered — a delete just flips a `deleted`
flag (a *tombstone*). So once a character has an id and a parent, those never
change. That's the stable coordinate we were missing.

The document text is the **pre-order depth-first traversal** of the tree, with
two rules:

1. **siblings** (children of the same parent) are ordered by their id,
   **descending** — a total order that is identical on every replica;
2. tombstoned nodes are skipped.

## The worked example

Back to Ada and Ben editing `Helo`. Say the `o` has id `4@ada`. Both insert an
`l` *after the second `l`*… actually after the `e`. Both new characters share the
same parent, and get concurrent ids — Ada's `l` is `5@ada`, Ben's is `5@ben`.

Both replicas build the same tree (ids shown; `·` = ROOT):

```
        ·
        │
   H — e — l — o          (the original "Helo", each linked to the previous)
        │
   ┌────┴────┐
 5@ben     5@ada          two concurrent children of "e"
  "l"       "l"
```

Sibling order is “by id, descending”. Both new nodes have counter `5`; the tie
breaks on replica id, and `"ben" > "ada"`, so **`5@ben` comes before `5@ada`** —
*on both replicas*, because they're applying the exact same rule to the exact
same ids. The traversal yields:

```
H e [5@ben:l] [5@ada:l] l o   →   "Hellllo"?
```

…which shows the *honest* behaviour: with two genuinely concurrent insertions you
get **both** characters, in a deterministic order — never a lost one, never a
crash, and never a disagreement between replicas. (For the single-typo case both
users really did each add a letter; a CRDT preserves intent rather than guessing
that they “meant” the same `l`.) The point that matters is the one the tests
nail down: **whatever the operations and whatever the order they arrive in, every
replica computes the same string.**

## Why it converges (the actual argument)

The whole state is three structures, and every one of them is **insensitive to
order and duplicates**:

| structure    | what it holds                     | why order/duplication doesn't matter          |
| ------------ | --------------------------------- | ---------------------------------------------- |
| `nodes`      | a *set* of `id → node` (inserts)  | inserting the same id twice is a no-op         |
| `children`   | each parent's kids, sorted by id  | a total order sorted incrementally is stable   |
| `tombstones` | a *set* of deleted ids            | set union is commutative + idempotent          |

A character is visible **iff** it's in `nodes` and not in `tombstones`, and the
traversal is a *pure function* of these three. Therefore any two replicas that
have applied the **same set** of operations — in any order, with any duplicates —
produce byte-identical text. Delivery order is never required:

- a **delete that arrives before its insert** is remembered and applied when the
  insert lands;
- an **insert that arrives before its parent** waits in the parent's child
  bucket, invisible until the parent reconnects it to `ROOT`.

Everything self-heals once the full set of operations is present — which is
exactly what “offline edit, reconnect, converge” needs.

## The proof: property-based tests

Words are cheap; the [test suite](../packages/crdt/test) is the receipt.
[`convergence.property.test.ts`](../packages/crdt/test/convergence.property.test.ts)
uses [fast-check](https://github.com/dubzzz/fast-check) to *generate* random
multi-replica editing sessions — including offline concurrency — and asserts:

```ts
it("order independence: the same op log in any order yields the same document", () => {
  fc.assert(
    fc.property(
      fc.integer({ min: 2, max: 4 }),          // number of replicas
      fc.array(commandArb, { maxLength: 120 }), // random inserts/deletes
      fc.array(fc.nat(), { maxLength: 120 }),   // which replica runs each
      fc.array(fc.integer({ min: 1 }), { minLength: 3 }), // permutation seeds
      (numReplicas, commands, assignments, permSeeds) => {
        const { log } = simulateOffline(numReplicas, commands, assignments);
        // Replay the identical op log under several independent shuffles…
        const texts = permSeeds.map((seed) => {
          const doc = new RGA("Z");
          doc.applyAll(shuffle(log, seed));
          return doc.toString();
        });
        // …every permutation must agree.
        for (const t of texts) expect(t).toBe(texts[0]);
      },
    ),
    { numRuns: 300 },
  );
});
```

Alongside it, [`rga.test.ts`](../packages/crdt/test/rga.test.ts) pins the named
hard cases from the literature: two concurrent inserts at one position, insert
into a deleted region, concurrent delete, and offline-edit-then-reconnect.

```bash
pnpm --filter @birga/crdt test
```

## Where it runs

The from-scratch CRDT isn't shelved — it drives the **plain-text mode** of the
[Birga editor](../apps/web): every keystroke is an RGA operation synced over a
[WebSocket relay](../apps/server) and persisted, with periodic
[compaction](../apps/server/src/compactor.ts) so late joiners load from a
snapshot instead of replaying history. The production rich-text mode runs on a
mature CRDT (Yjs) for reliability — but the merge logic that makes concurrent
editing *possible* is the one written, and proven, here.
