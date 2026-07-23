import { WebSocketServer, type WebSocket } from "ws";
import { Hub } from "./hub.js";
import { InMemoryDocStore, type DocStore } from "./store.js";
import { LocalFanout, type Fanout } from "./fanout.js";

export interface ServerOptions {
  /** TCP port. Use 0 for an ephemeral port (handy in tests). */
  port?: number;
  host?: string;
  store?: DocStore;
  fanout?: Fanout;
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
  const hub = new Hub(store, fanout);

  const wss = new WebSocketServer({ port: options.port ?? 8080, host: options.host });

  wss.on("connection", (socket: Alive) => {
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });
    hub.addConnection(socket);
  });

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
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await fanout.close();
      await store.close();
    },
  };
}
