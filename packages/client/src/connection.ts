/**
 * A transport the {@link PlainTextRoom} drives. Kept minimal so it works over a
 * browser `WebSocket`, the Node `ws` client, or an in-memory pipe in tests.
 */
export interface Connection {
  send(data: string): void;
  close(): void;
  onOpen(cb: () => void): void;
  onMessage(cb: (data: string) => void): void;
  onClose(cb: () => void): void;
}

/** Minimal shape shared by browser `WebSocket` and the `ws` package. */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

/**
 * Wrap a WebSocket implementation as a {@link Connection}. Defaults to the
 * global `WebSocket` (browsers); pass `Ctor` to use `ws` in Node/tests.
 */
export function webSocketConnection(url: string, Ctor?: WebSocketCtor): Connection {
  const WS = Ctor ?? (globalThis as unknown as { WebSocket: WebSocketCtor }).WebSocket;
  if (!WS) throw new Error("No WebSocket implementation available; pass one explicitly.");
  const ws = new WS(url);
  return {
    send: (data) => ws.send(data),
    close: () => ws.close(),
    onOpen: (cb) => ws.addEventListener("open", () => cb()),
    onMessage: (cb) => ws.addEventListener("message", (ev) => cb(String(ev.data))),
    onClose: (cb) => ws.addEventListener("close", () => cb()),
  };
}
