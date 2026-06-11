import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import { PROTOCOL_VERSION, colorForSite, parseClientMessage } from "@converge/shared";
import type { ClientMessage, HelloMessage, ServerMessage } from "@converge/shared";
import { DocRoom, RoomManager } from "./room.js";
import type { RoomClient } from "./room.js";
import type { OpStore } from "./store.js";

const HEARTBEAT_MS = 30_000;
const MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_HELLO_BACKLOG = 256;

export interface SyncServer {
  readonly port: number;
  close(): Promise<void>;
}

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

export async function startSyncServer(opts: {
  store: OpStore;
  port: number;
  host?: string;
  /** Persist a full snapshot every N ops (default 500). */
  snapshotEvery?: number;
}): Promise<SyncServer> {
  const manager = new RoomManager(opts.store, opts.snapshotEvery);

  const http = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: http, maxPayload: MAX_PAYLOAD_BYTES });
  const alive = new WeakMap<WebSocket, boolean>();

  wss.on("connection", (ws) => {
    let room: DocRoom | null = null;
    let conn: RoomClient | null = null;
    let helloInProgress = false;
    let socketClosed = false;
    const backlog: ClientMessage[] = [];

    const send = (msg: ServerMessage): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    const handleHello = async (msg: HelloMessage): Promise<void> => {
      if (msg.protocolVersion !== PROTOCOL_VERSION) {
        send({ type: "error", message: `unsupported protocol version ${msg.protocolVersion}` });
        ws.close();
        return;
      }
      helloInProgress = true;
      try {
        const loaded = await manager.get(msg.docId);
        if (socketClosed) return;
        const client: RoomClient = {
          siteId: msg.siteId,
          name: msg.name.trim() === "" ? "anonymous" : msg.name,
          color: colorForSite(msg.siteId),
          cursor: null,
          selection: null,
          send,
          close: () => ws.close(),
        };
        loaded.join(client, msg.lastSeenSeq);
        room = loaded;
        conn = client;
        for (const queued of backlog.splice(0)) handleMessage(queued);
      } catch (err) {
        console.error(`[server] failed to load doc ${msg.docId}:`, err);
        send({ type: "error", message: "failed to load document" });
        ws.close();
      } finally {
        helloInProgress = false;
      }
    };

    const handleMessage = (msg: ClientMessage): void => {
      if (msg.type === "hello") {
        if (room !== null || helloInProgress) {
          send({ type: "error", message: "duplicate hello" });
          return;
        }
        void handleHello(msg);
        return;
      }
      if (room === null || conn === null) {
        // ops/presence racing ahead of an in-flight hello are queued
        if (helloInProgress && backlog.length < MAX_HELLO_BACKLOG) {
          backlog.push(msg);
          return;
        }
        send({ type: "error", message: "hello required before other messages" });
        return;
      }
      if (msg.type === "ops") {
        room.submitOps(msg.ops);
      } else {
        room.updatePresence(conn, msg.cursor, msg.selection);
      }
    };

    ws.on("message", (data) => {
      const msg = parseClientMessage(rawDataToString(data));
      if (msg === null) {
        send({ type: "error", message: "invalid message" });
        return;
      }
      handleMessage(msg);
    });

    ws.on("close", () => {
      socketClosed = true;
      if (room !== null && conn !== null) room.leave(conn);
    });

    ws.on("error", (err) => {
      console.error("[server] socket error:", err.message);
    });

    // Heartbeat bookkeeping
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  await new Promise<void>((resolve) => {
    http.listen(opts.port, opts.host ?? "0.0.0.0", resolve);
  });
  const address = http.address();
  const port = typeof address === "object" && address !== null ? address.port : opts.port;

  return {
    port,
    close: async () => {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(err) : resolve()));
      });
      await manager.settleAll();
    },
  };
}
