# Birga — Technical Spec (TZ)

> A real-time collaborative editor built on CRDTs — including a sequence CRDT written and tested
> from scratch. This document is the contract. Build to it.

---

## 0. For the engineer picking this up

The value of this project is **distributed-state correctness**, not a pretty editor. Two deliverables
sit side by side:

1. **`@birga/crdt`** — a small, dependency-free **sequence CRDT implemented from scratch**, with a
   property-based test suite that *proves convergence*: any set of operations, applied in any order,
   on any number of replicas, yields the same document. This is the portfolio centrepiece.
2. **The app** — a real collaborative editor. For the shipping product you may use a mature CRDT
   library (Yjs) so the editor is reliable; the from-scratch CRDT is the teaching/credibility layer,
   wired into at least a "plain text" mode so it's genuinely used, not shelved.

**Definition of excellent:** you can open two browsers, type in the same paragraph simultaneously,
pull the network cable on one, keep typing on both, reconnect — and both converge to the identical
document, every time. And the from-scratch CRDT's test suite passes thousands of randomised
interleavings.

## 1. Why this project (portfolio + money)

- **Portfolio:** CRDTs are the senior end of real-time. Convergence, causality, tombstones,
  garbage collection, offline reconciliation — none of it appears in a CRUD app. A from-scratch,
  tested CRDT is a rare, high-trust signal.
- **Money:** less direct than the others, but real niches exist — collaborative notes/wikis for
  teams, shared docs for a vertical (e.g., collaborative lesson plans, shared case files). Ship the
  editor as a product for one niche later; for now it's a **credibility** project. Be honest about that.

## 2. Core concepts

- **Replica** — a client (or the server) holding a copy of the document.
- **Operation** — an insert/delete with a globally-unique, causally-ordered id.
- **Convergence** — all replicas that have seen the same ops are byte-identical, regardless of order.
- **Awareness** — ephemeral presence state (cursor, selection, user), not part of the document CRDT.

## 3. MVP scope (build in this order)

### Phase 1 — `@birga/crdt` (the centrepiece, build FIRST)
1. Implement a **sequence CRDT** for text. Recommended: **RGA (Replicated Growable Array)** or a
   Logoot/LSEQ-style ordered-identifier list. Operations: `insert(afterId, char)`, `delete(id)`.
2. Unique ids: `(replicaId, counter)` (Lamport-style). Deterministic tie-break for concurrent
   inserts at the same position.
3. **Property-based tests** (fast-check): generate random op sets, apply in random orders across N
   replicas, assert identical final state. Include the classic "two inserts at same position",
   "insert into deleted region", "concurrent delete" cases. This test suite is the deliverable.
4. Snapshot + op-log serialization (for persistence and late joiners).

### Phase 2 — Sync server
5. A **WebSocket server** (Node) that relays ops between replicas in a document room and persists
   them. Late joiner: send snapshot + ops since snapshot. Handle reconnect (resync missed ops).
6. **Redis** pub/sub for fan-out (so it can run multiple server instances) and for presence.

### Phase 3 — The editor app
7. **Next.js + TipTap/ProseMirror** editor. For the reliable product path, bind to **Yjs**
   (`y-prosemirror`, `y-websocket`-style) so rich text is solid. Also ship a **plain-text mode bound
   to `@birga/crdt`** so the from-scratch CRDT is actually driving a live surface.
8. **Awareness:** live remote cursors + selections + user labels/colours.
9. **Offline-first:** local persistence (IndexedDB), edit offline, converge on reconnect.

### Phase 4 — Docs & persistence
10. Document list, share links, permissions (owner/editor/viewer). Snapshots to Postgres; periodic
    compaction of the op log.

## 4. Architecture

```
 browser A ─┐                      ┌─ Postgres (snapshots + op log)
 browser B ─┼─ WebSocket ─▶ Sync server ─┤
 browser C ─┘   (ops + awareness)   └─ Redis (pub/sub fan-out + presence)

 each browser: editor ⇄ CRDT (Yjs for rich text; @birga/crdt for plain-text mode) ⇄ IndexedDB
```

## 5. The genuinely hard parts (these ARE the portfolio)

1. **A correct sequence CRDT** — convergence under concurrency; the property tests that prove it.
2. **Causal delivery & reconnect** — a replica that missed ops catches up without gaps or dupes.
3. **Snapshots + compaction** — late joiners load fast without replaying the entire history; the
   op log doesn't grow forever.
4. **Awareness vs. document state** — presence is ephemeral and must not pollute the CRDT.
5. **Offline reconciliation** — edit while disconnected, merge cleanly on return.

## 6. Data model (sketch)

- `documents(id, owner_id, title, snapshot bytea, snapshot_version, updated_at)`
- `document_ops(id, document_id, replica_id, seq, op bytea, created_at)` (compacted periodically)
- `permissions(document_id, user_id, role)`
- Presence: Redis only, TTL'd, never persisted.

## 7. Non-goals (v1)

Operational Transform (you're doing CRDTs — pick one and own it). Rich media/embeds. Comments/
suggestions mode. Mobile apps. Federated multi-server consensus. Keep the surface small, the core deep.

## 8. Tech stack (locked)

TypeScript · `@birga/crdt` (own, zero-dep) · **fast-check** (property tests) · Node WebSocket server
(`ws`) · **Yjs** for the production rich-text path · Redis (pub/sub + presence) · Postgres (snapshots)
· Next.js + TipTap/ProseMirror + Tailwind · IndexedDB for offline.

## 9. Definition of done

- `@birga/crdt` converges under thousands of randomised interleavings (CI-green property tests).
- Two-browser live edit works; offline-edit-then-reconnect converges.
- Live cursors + presence.
- Late joiner loads via snapshot quickly on a long document.
- README explains **why** the CRDT converges (with a small diagram), and links the test suite.

## 10. Portfolio artifact

A write-up: **"I wrote a CRDT from scratch — here's why concurrent edits never conflict."** Show the
convergence property test and one worked concurrent-insert example. This is the shareable proof.
