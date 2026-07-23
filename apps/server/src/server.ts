import { WebSocketServer, type WebSocket } from "ws";
import { Hub, type Authorize } from "./hub.js";
import { InMemoryDocStore, type DocStore } from "./store.js";
import { LocalFanout, type Fanout } from "./fanout.js";
import type { CompactionBuild } from "./compactor.js";

export interface CompactionOptions {
  /** How often to sweep active documents. */
  intervalMs: number;
  /** Only compact when ops-since-snapshot ≥ this. Default 200. */
  minOps?: number;
  /** Folds a document's ops into a snapshot (or returns null to skip). */
  build: CompactionBuild;
}

export interface ServerOptions {
  /** TCP port. Use 0 for an ephemeral port (handy in tests). */
  port?: number;
  host?: string;
  store?: DocStore;
  fanout?: Fanout;
  /** Access control. When omitted the server is fully open (default). */
  authorize?: Authorize;
  /** Periodic op-log compaction. When omitted, no automatic compaction runs. */
  compaction?: CompactionOptions;
  /** Heartbeat interval (ms) for dropping dead sockets. 0 disables. */
  heartbeatMs?: number;
}

export interface RunningServer {
  readonly hub: Hub;
  readonly store: DocStore;
  /** The bound port (resolved even when `port: 0` was requested). */
  readonly port: number;
  close(): Promise<void>;
}

/** Track liveness so we can terminate sockets that stop answering pings. */
interface Alive extends WebSocket {
  isAlive?: boolean;
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const store = options.store ?? new InMemoryDocStore();
  const fanout = options.fanout ?? new LocalFanout();
  const hub = new Hub(store, fanout, options.authorize ?? null);

  const wss = new WebSocketServer({ port: options.port ?? 8080, host: options.host });

  wss.on("connection", (socket: Alive) => {
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    hub.addConnection(socket);
  });

  // Periodic op-log compaction over currently-active documents, so late joiners
  // load from a small snapshot instead of replaying a long history.
  let compaction: ReturnType<typeof setInterval> | null = null;
  if (options.compaction) {
    const { intervalMs, minOps = 200, build } = options.compaction;
    compaction = setInterval(() => {
      void (async () => {
        for (const docId of hub.activeDocIds()) {
          try {
            const [head, snap] = await Promise.all([store.head(docId), store.loadSnapshot(docId)]);
            if (head - (snap?.version ?? 0) < minOps) continue;
            await store.compact(docId, (prev, ops) => build(docId, prev, ops));
          } catch {
            /* a failed compaction is non-fatal; try again next sweep */
          }
        }
      })();
    }, intervalMs);
    compaction.unref?.();
  }

  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          for (const socket of wss.clients as Set<Alive>) {
            if (socket.isAlive === false) {
              socket.terminate();
              continue;
            }
            socket.isAlive = false;
            socket.ping();
          }
        }, heartbeatMs)
      : null;
  heartbeat?.unref?.();

  // Wait until the server is listening, then read the resolved port.
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);

  return {
    hub,
    store,
    port,
    async close() {
      if (heartbeat) clearInterval(heartbeat);
      if (compaction) clearInterval(compaction);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await fanout.close();
      await store.close();
    },
  };
}
