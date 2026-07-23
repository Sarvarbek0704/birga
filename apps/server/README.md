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

Single instance uses an in-memory store. Set `REDIS_URL` to scale out:

```bash
REDIS_URL=redis://localhost:6379 pnpm --filter @birga/server start
```

That enables **Redis pub/sub fan-out** (ops/awareness/leaves reach rooms on every
instance) backed by a **shared Redis op log** (so late joiners on any instance
catch up). Presence is Redis-only and TTL'd — never persisted.

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
