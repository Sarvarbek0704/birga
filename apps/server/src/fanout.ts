import type { ServerMessage } from "@birga/protocol";

/** A message that must reach clients in a room on *every* server instance. */
export type FanoutMessage = Extract<
  ServerMessage,
  { type: "op" } | { type: "awareness" } | { type: "leave" }
>;

export type FanoutHandler = (docId: string, msg: FanoutMessage) => void;

/**
 * Cross-instance fan-out. A single instance broadcasts to its own room members
 * directly; the fan-out carries the same message to peer instances so their
 * local members see it too.
 */
export interface Fanout {
  /** Publish a message authored on this instance to all peers. */
  publish(docId: string, msg: FanoutMessage): void;
  /** Register the handler that delivers peer messages to local rooms. */
  onMessage(handler: FanoutHandler): void;
  close(): Promise<void>;
}

/** No-op fan-out for a single server instance. */
export class LocalFanout implements Fanout {
  publish(): void {
    /* nothing to do — the Hub already broadcast locally */
  }
  onMessage(): void {
    /* no peers */
  }
  async close(): Promise<void> {}
}
