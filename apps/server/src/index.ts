import { startServer } from "./server.js";
import { InMemoryDocStore, type DocStore } from "./store.js";
import { LocalFanout, type Fanout } from "./fanout.js";

/**
 * Production entry point. Single instance by default (in-memory store); set
 * `REDIS_URL` to fan out across instances and share the op log.
 */
async function main(): Promise<void> {
  const port = Number(process.env["PORT"] ?? 8080);
  const host = process.env["HOST"];
  const redisUrl = process.env["REDIS_URL"];
  const databaseUrl = process.env["DATABASE_URL"];

  let store: DocStore = new InMemoryDocStore();
  let fanout: Fanout = new LocalFanout();

  if (databaseUrl) {
    // Durable snapshots + op log in Postgres (lazily loads `pg`).
    const { PostgresDocStore } = await import("./postgres.js");
    store = await PostgresDocStore.connect(databaseUrl);
    console.log(`[birga] Postgres persistence enabled`);
  } else if (redisUrl) {
    // Shared op log in Redis when there's no Postgres (multi-instance).
    const { RedisDocStore } = await import("./redis.js");
    store = new RedisDocStore(redisUrl);
  }

  if (redisUrl) {
    // Redis pub/sub fan-out lets multiple instances share document rooms.
    const { RedisFanout } = await import("./redis.js");
    fanout = new RedisFanout(redisUrl);
    console.log(`[birga] Redis fan-out enabled (${redisUrl})`);
  }

  const server = await startServer({ port, host, store, fanout });
  console.log(`[birga] sync server listening on ws://${host ?? "localhost"}:${server.port}`);

  const shutdown = async (): Promise<void> => {
    console.log("[birga] shutting down…");
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main();
