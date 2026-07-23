<h1 align="center">Birga</h1>

<p align="center"><b>Many people, one document, no conflicts.</b> A real-time collaborative editor built on CRDTs — including a CRDT written from scratch.</p>

---

Birga is a collaborative editor where several people edit the same document at once — live cursors,
instant updates, and edits that **merge without conflicts**, even offline. Two people typing in the
same place never clobber each other; a client that reconnects after an hour catches up cleanly.

The interesting part is not the editor UI — it's the **synchronisation**. Birga contains a small
**CRDT (Conflict-free Replicated Data Type) implemented from scratch** for sequences (text), so the
merge logic is understood and owned, not imported. On top of that, a production-grade editor uses a
battle-tested CRDT library, so the app is real, not a demo.

## Why this project

Real-time collaboration is where "I know Socket.io" ends and "I understand distributed state" begins.
CRDTs are the hard, senior part: convergence, causal ordering, tombstones, offline reconciliation.
Building one from scratch — and being able to explain why it converges — is a signal almost no
junior portfolio carries.

## What it does (target)

- **Collaborative editing** of rich text — multiple users, one doc, live.
- **Presence / awareness** — live cursors, selections, who's here.
- **Offline-first** — edit offline, reconnect, converge automatically.
- **Persistence** — documents survive server restarts; late joiners load fast (snapshots).
- **From-scratch CRDT** — a documented sequence CRDT (RGA/Logoot-style) with a test suite proving
  convergence, used to teach the concept; the full editor runs on a mature CRDT for reliability.

## Stack

TypeScript · a hand-written CRDT core (own package) · WebSocket sync server (Node) · Next.js editor
(TipTap/ProseMirror) · Redis for presence/fan-out · Postgres for document snapshots.

## Status

🛠️ **In progress.** Full technical spec: [`docs/TZ.md`](docs/TZ.md).

| package | what it is | state |
| ------- | ---------- | ----- |
| [`@birga/crdt`](packages/crdt) | from-scratch RGA sequence CRDT + convergence property tests | ✅ 16 tests |
| [`@birga/protocol`](packages/protocol) | CRDT-agnostic wire protocol | ✅ |
| [`@birga/server`](apps/server) | WS sync server · Redis fan-out · Postgres persistence + compaction · REST API (auth, docs, share links) | ✅ 29 tests |
| [`@birga/client`](packages/client) | offline-first sync engine (CRDT ⇆ protocol) | ✅ 5 tests |
| [`@birga/web`](apps/web) | Next.js editor — plain text (`@birga/crdt`) + rich text (Yjs) · doc list · sharing | ✅ builds |

```bash
pnpm install
pnpm -r build && pnpm -r test    # 50 tests green
```

Every phase of the spec's MVP scope is implemented: from-scratch CRDT, sync
server, editor (both CRDT paths), persistence + compaction, and documents with
guest auth + share links. Remaining polish: real accounts (guest identities
today) and richer conflict-free rich-text schemas.

## License

MIT.
