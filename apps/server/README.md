# @birga/server

The Birga **WebSocket sync server**. It is a **CRDT-agnostic relay**: it accepts
opaque `op` payloads, assigns each a per-document sequence number, persists it,
and delivers it to every current and future member of the document room. It never
interprets ops — concurrent-edit correctness lives in the CRDT at the client
edges. The same server therefore carries `@birga/crdt` ops *and* Yjs updates.

## Protocol

Clients speak [`@birga/protocol`](../../packages/protocol) over JSON text frames.

| client → server | meaning |
| --------------- | ------- |
| `join { docId, replica, since? }` | enter a room; `since` = highest seq already applied (reconnect) |
| `op { docId, op }` | submit a local op for relay + persistence |
| `awareness { docId, state }` | ephemeral presence (cursor/selection/user) |

| server → client | meaning |
| --------------- | ------- |
| `welcome { snapshot, snapshotVersion, ops, head }` | catch-up state after a join |
| `op { docId, seq, replica, op }` | a relayed op (echoed to the author too, so it learns its seq) |
| `awareness { docId, replica, state }` | relayed presence |
| `leave { docId, replica }` | a replica disconnected — clear its presence |
| `error { message }` | malformed input or op-before-join |

**Late joiners** get a snapshot plus the ops recorded after it. **Reconnecting**
clients pass `since` and receive only the ops they missed — no snapshot. Because
the CRDT is idempotent and order-independent, the server only has to guarantee
*delivery*; it never worries about ordering.

## Running

```bash
pnpm --filter @birga/server dev     # tsx watch, port 8080
PORT=9000 pnpm --filter @birga/server start
```

Single instance uses an in-memory store. Two env vars scale it out:

```bash
# durable snapshots + op log
DATABASE_URL=postgres://user:pass@localhost:5432/birga pnpm --filter @birga/server start

# pub/sub fan-out across instances (+ shared op log when no Postgres)
REDIS_URL=redis://localhost:6379 pnpm --filter @birga/server start
```

- `REDIS_URL` → **pub/sub fan-out** so ops/awareness/leaves reach rooms on every
  instance. Presence is Redis-only and TTL'd — never persisted.
- `DATABASE_URL` → **Postgres persistence** ([`postgres.ts`](src/postgres.ts)):
  the op log and snapshots live in JSONB tables; `migrate()` runs on boot.

### Persistence & compaction

`PostgresDocStore` stores every op and supports **op-log compaction**: fold the
ops after the current snapshot into a new one and prune them, atomically (a
writable-CTE `INSERT … ON CONFLICT` + `DELETE` in one statement, so a late joiner
never sees a gap). `compact(docId, build)` is CRDT-agnostic — `build` folds the
prior snapshot + new ops into the next snapshot; the tests use an `@birga/crdt`
folder and prove the document is still perfectly reconstructable afterwards.

[`documents.ts`](src/documents.ts) (`DocumentsRepo`) owns document metadata and
**share permissions** (`owner` / `editor` / `viewer`): create, list-for-user
(with role), rename, delete (cascades), grant/revoke, and `canEdit` checks.

### WebSocket access control (opt-in)

By default the relay is open. Set `ENFORCE_PERMISSIONS=1` (with `DATABASE_URL`)
to check the bearer token clients send in `join`: read is required to join,
write to submit ops ([`authz.ts`](src/authz.ts)). **Unclaimed** documents (no
permission rows) stay open so ad-hoc rooms keep working; once a document is
created/shared, its roles apply — across both `plain:` and `rich:` editor rooms.

## Architecture

- [`store.ts`](src/store.ts) — `DocStore` interface + `InMemoryDocStore`.
- [`fanout.ts`](src/fanout.ts) — `Fanout` interface + `LocalFanout`.
- [`redis.ts`](src/redis.ts) — `RedisFanout` + `RedisDocStore` (loaded lazily when `REDIS_URL` is set).
- [`hub.ts`](src/hub.ts) — the transport-independent relay core (rooms, persistence, fan-out).
- [`server.ts`](src/server.ts) — wires `ws` + heartbeats; `startServer()` returns the bound port.

## Tests

`test/sync.test.ts` drives real `ws` clients that interpret ops with `@birga/crdt`,
asserting on converged document text: op relay, document isolation, late-join
catch-up, snapshot-based catch-up, reconnect-with-`since`, awareness relay
(not persisted), leave notifications, and three-replica convergence through the
relay.

```bash
pnpm --filter @birga/server test
```
