import WebSocket from "ws";
import { PROTOCOL_VERSION, parseServerMessage } from "@converge/shared";
import type { ClientMessage, ServerMessage } from "@converge/shared";

/** Thin scripted WebSocket client for integration tests. */
export class TestClient {
  private readonly ws: WebSocket;
  private readonly received: ServerMessage[] = [];
  private readonly consumed = new Set<number>();
  private notify: (() => void) | null = null;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const raw = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : data.toString("utf8");
      const msg = parseServerMessage(raw);
      if (msg === null) throw new Error(`server sent unparseable message: ${raw}`);
      this.received.push(msg);
      this.notify?.();
    });
  }

  static async connect(port: number): Promise<TestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    return new TestClient(ws);
  }

  send(msg: ClientMessage): void {
    this.ws.send(JSON.stringify(msg));
  }

  hello(docId: string, siteId: string, lastSeenSeq = 0, name = siteId): void {
    this.send({ type: "hello", protocolVersion: PROTOCOL_VERSION, docId, siteId, name, lastSeenSeq });
  }

  /** Next unconsumed message matching `pred`; throws on timeout. */
  async expectMsg(pred: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<ServerMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      for (let i = 0; i < this.received.length; i++) {
        const m = this.received[i];
        if (m !== undefined && !this.consumed.has(i) && pred(m)) {
          this.consumed.add(i);
          return m;
        }
      }
      if (Date.now() > deadline) {
        const seen = this.received.map((m) => m.type).join(", ") || "(none)";
        throw new Error(`timeout waiting for message; received so far: ${seen}`);
      }
      await new Promise<void>((resolve) => {
        this.notify = resolve;
        setTimeout(resolve, 25);
      });
    }
  }

  /** All ops messages consumed so far plus new ones until `pred` on total. */
  allReceived(): readonly ServerMessage[] {
    return this.received;
  }

  close(): Promise<void> {
    if (this.ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}
