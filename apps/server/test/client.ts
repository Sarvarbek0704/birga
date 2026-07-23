import { WebSocket } from "ws";
import { RGA } from "@birga/crdt";
import type { Op } from "@birga/crdt";
import type { ServerMessage, WelcomeMessage } from "@birga/protocol";

/**
 * A test client that speaks the Birga protocol and interprets ops with the real
 * `@birga/crdt`, so tests assert on actual converged document text.
 */
export class TestClient {
  private readonly ws: WebSocket;
  private doc: RGA | null = null;
  replica = "?";
  docId = "";
  head = 0;
  welcomed = false;

  readonly awareness: Array<{ replica: string; state: unknown }> = [];
  readonly leaves: string[] = [];
  lastWelcome: WelcomeMessage | null = null;
  lastError: string | null = null;

  private readonly checks: Array<{ pred: () => boolean; resolve: () => void }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => this.onMessage(JSON.parse(data.toString()) as ServerMessage));
  }

  static async connect(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://localhost:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return new TestClient(ws);
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome": {
        this.lastWelcome = msg;
        if (msg.snapshot !== null) {
          this.doc = RGA.fromSnapshot(this.replica, msg.snapshot as never);
        } else if (!this.doc) {
          this.doc = new RGA(this.replica);
        }
        for (const stored of msg.ops) {
          this.doc.apply(stored.op as Op);
          this.head = Math.max(this.head, stored.seq);
        }
        this.head = Math.max(this.head, msg.head);
        this.welcomed = true;
        break;
      }
      case "op":
        this.doc?.apply(msg.op as Op);
        this.head = Math.max(this.head, msg.seq);
        break;
      case "awareness":
        this.awareness.push({ replica: msg.replica, state: msg.state });
        break;
      case "leave":
        this.leaves.push(msg.replica);
        break;
      case "error":
        this.lastError = msg.message;
        break;
    }
    this.pump();
  }

  private pump(): void {
    for (let i = this.checks.length - 1; i >= 0; i--) {
      const c = this.checks[i]!;
      if (c.pred()) {
        this.checks.splice(i, 1);
        c.resolve();
      }
    }
  }

  waitUntil(pred: () => boolean, timeout = 3000): Promise<void> {
    if (pred()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitUntil timed out")), timeout);
      this.checks.push({
        pred,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  async join(docId: string, replica: string, since?: number): Promise<void> {
    this.docId = docId;
    this.replica = replica;
    if (!this.doc) this.doc = new RGA(replica);
    this.welcomed = false;
    this.ws.send(JSON.stringify({ type: "join", docId, replica, since }));
    await this.waitUntil(() => this.welcomed);
  }

  insert(index: number, ch: string): void {
    const op = this.doc!.insertAt(index, ch);
    this.ws.send(JSON.stringify({ type: "op", docId: this.docId, op }));
  }

  /** Type a string at the end of the local document, one op per character. */
  typeEnd(text: string): void {
    for (const ch of text) this.insert(this.doc!.length, ch);
  }

  delete(index: number): void {
    const op = this.doc!.deleteAt(index);
    this.ws.send(JSON.stringify({ type: "op", docId: this.docId, op }));
  }

  sendAwareness(state: unknown): void {
    this.ws.send(JSON.stringify({ type: "awareness", docId: this.docId, state }));
  }

  text(): string {
    return this.doc?.toString() ?? "";
  }

  waitForText(expected: string, timeout = 3000): Promise<void> {
    return this.waitUntil(() => this.text() === expected, timeout);
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
