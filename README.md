<h1 align="center">Birga</h1>

<p align="center"><b>Many people, one document, no conflicts.</b> A real-time collaborative editor built on CRDTs — including a CRDT written from scratch.</p>

<p align="center">
  <a href="https://github.com/Sarvarbek0704/birga/actions/workflows/ci.yml"><img src="https://github.com/Sarvarbek0704/birga/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/tests-61%20passing-brightgreen" alt="tests">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

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

TypeScript · a hand-written CRDT core (own package) · WebSocket sync server (Node, `ws`) · Next.js +
TipTap editor · Yjs for the rich-text path · Redis for presence/fan-out · Postgres for snapshots.

## Architecture

```mermaid
graph LR
  A[browser A] -- ops + awareness --> S[["@birga/server<br/>WebSocket relay"]]
  B[browser B] -- ops + awareness --> S
  S --- PG[(Postgres<br/>snapshots + op log)]
  S --- R[(Redis<br/>pub/sub + presence)]
```

Each browser runs an editor bound to a CRDT — the **from-scratch `@birga/crdt`**
for plain-text mode, **Yjs** for rich text — persists locally to **IndexedDB**
(offline-first), and syncs ops through a CRDT-agnostic relay that stores them and
fans out across instances.

## Quickstart

```bash
pnpm install
pnpm build && pnpm test          # 61 tests green (incl. the CRDT property suite)

# run the app (builds libs, then server + web in parallel)
pnpm dev                         # web on :3000, sync server on :8080
```

Open <http://localhost:3000>, create a document, open the same URL in a second
window, and type in both — including with one window offline. They converge.

**Durable / multi-instance (optional):**

```bash
pnpm db:up                       # Postgres + Redis via docker compose
DATABASE_URL=postgres://birga:birga@localhost:5432/birga \
REDIS_URL=redis://localhost:6379 \
  pnpm dev:server                # persistence, REST API, fan-out
```

## Status

**Every phase of the spec's MVP scope is implemented and tested** — the full
pipeline (`build · typecheck · test · web build`) passes, and CI
([`ci.yml`](.github/workflows/ci.yml)) runs it on every push. Full technical
spec: [`docs/TZ.md`](docs/TZ.md).

| package | what it is | tests |
| ------- | ---------- | ----- |
| [`@birga/crdt`](packages/crdt) | from-scratch RGA sequence CRDT + convergence property suite | 16 |
| [`@birga/protocol`](packages/protocol) | CRDT-agnostic wire protocol | — |
| [`@birga/server`](apps/server) | WS relay · Redis fan-out · Postgres persistence + auto-compaction · REST API (auth, docs, share links) · opt-in access control | 39 |
| [`@birga/client`](packages/client) | offline-first sync engine (CRDT ⇆ protocol) · reconnect · rollback | 6 |
| [`@birga/web`](apps/web) | Next.js editor — plain (`@birga/crdt`) + rich (Yjs) · presence · doc list · sharing | build |

**How it maps to the spec's Definition of Done (§9):** the CRDT converges under
thousands of randomised interleavings (a green property suite); two-window live edit and
offline-edit-then-reconnect converge; live cursors + presence; late joiners load
from a snapshot on long docs (periodic compaction); and the README explains
**why** the CRDT converges with a diagram — see the portfolio write-up,
[**docs/CRDT.md**](docs/CRDT.md).

Remaining polish (beyond the spec): real accounts (guest identities today) and a
richer rich-text schema.

## License

MIT.
