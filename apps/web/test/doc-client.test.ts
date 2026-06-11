import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RGA } from "@converge/crdt";
import type { Op } from "@converge/crdt";
import { isClientMessage, tryParseJson } from "@converge/shared";
import type { ClientMessage, SeqOp, ServerMessage } from "@converge/shared";
import { DocClient } from "../src/client/doc-client";
import type { OutboxStore, SocketLike } from "../src/client/doc-client";

class FakeSocket implements SocketLike {
  readyState = 0; // CONNECTING
  sent: ClientMessage[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    const msg = tryParseJson(data);
    if (!isClientMessage(msg)) throw new Error(`client sent invalid message: ${data}`);
    this.sent.push(msg);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.();
  }

  // ---- test-side controls
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  serverSend(msg: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  serverDrop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  helloMessage(): Extract<ClientMessage, { type: "hello" }> {
    const hello = this.sent.find((m) => m.type === "hello");
    if (hello === undefined || hello.type !== "hello") throw new Error("no hello sent");
    return hello;
  }

  opsSent(): Op[] {
    return this.sent.flatMap((m) => (m.type === "ops" ? [...m.ops] : []));
  }
}

function memoryOutbox(): OutboxStore & { stored: Op[] } {
  const box = {
    stored: [] as Op[],
    load: (): Op[] => [...box.stored],
    save: (ops: readonly Op[]): void => {
      box.stored = [...ops];
    },
  };
  return box;
}

function seqTag(ops: readonly Op[], startSeq: number): SeqOp[] {
  return ops.map((op, i) => ({ seq: startSeq + i, op }));
}

describe("DocClient", () => {
  const sockets: FakeSocket[] = [];
  const factory = (): SocketLike => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const newClient = (opts?: { outboxStore?: OutboxStore; siteId?: string }): DocClient =>
    new DocClient({
      url: "ws://test",
      docId: "doc",
      siteId: opts?.siteId ?? "site-1",
      name: "tester",
      socketFactory: factory,
      outboxStore: opts?.outboxStore,
    });

  beforeEach(() => {
    vi.useFakeTimers();
    sockets.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies local edits instantly and queues them while offline", () => {
    const client = newClient();
    client.applyLocalSplice(0, 0, "hello");
    expect(client.text()).toBe("hello"); // no network involved
    expect(client.queuedCount()).toBe(5);
    expect(client.status()).toBe("offline");
  });

  it("sends hello then flushes the queue on connect; echoes ack the queue", () => {
    const client = newClient();
    client.applyLocalSplice(0, 0, "hi");
    client.connect();
    const socket = sockets[0];
    if (socket === undefined) throw new Error("no socket");
    socket.serverOpen();

    expect(socket.helloMessage().lastSeenSeq).toBe(0);
    const flushed = socket.opsSent();
    expect(flushed).toHaveLength(2);

    // Server persists and echoes with seqs => outbox drains, status online.
    socket.serverSend({ type: "ops", ops: seqTag(flushed, 1) });
    expect(client.queuedCount()).toBe(0);
    expect(client.status()).toBe("online");
    expect(client.text()).toBe("hi");
  });

  it("applies remote ops and reports the merged text", () => {
    const client = newClient();
    client.connect();
    const socket = sockets[0];
    if (socket === undefined) throw new Error("no socket");
    socket.serverOpen();

    const remote = new RGA("site-2");
    socket.serverSend({ type: "ops", ops: seqTag(remote.localInsertText(0, "abc"), 1) });
    expect(client.text()).toBe("abc");

    client.applyLocalSplice(3, 0, "!");
    expect(client.text()).toBe("abc!");
  });

  it("reconnects with backoff and resumes from lastSeenSeq", () => {
    const client = newClient();
    client.connect();
    const first = sockets[0];
    if (first === undefined) throw new Error("no socket");
    first.serverOpen();
    const remote = new RGA("site-2");
    first.serverSend({ type: "ops", ops: seqTag(remote.localInsertText(0, "abc"), 1) });
    expect(client.status()).toBe("online");

    first.serverDrop();
    expect(client.status()).toBe("offline");

    client.applyLocalSplice(3, 0, "X"); // typed while down
    expect(client.text()).toBe("abcX");

    vi.advanceTimersByTime(2000); // backoff elapses -> new socket
    const second = sockets[1];
    if (second === undefined) throw new Error("no reconnect socket");
    second.serverOpen();
    expect(second.helloMessage().lastSeenSeq).toBe(3); // catch-up cursor
    expect(second.opsSent()).toHaveLength(1); // offline op replayed
  });

  it("restores a persisted outbox after a 'reload' and converges once deps arrive", () => {
    const outbox = memoryOutbox();

    // Session 1: receive "ab", type "c" after it, never get an ack.
    const session1 = newClient({ outboxStore: outbox, siteId: "site-1" });
    session1.connect();
    const s1 = sockets[0];
    if (s1 === undefined) throw new Error("no socket");
    s1.serverOpen();
    const remote = new RGA("site-2");
    const baseOps = remote.localInsertText(0, "ab");
    s1.serverSend({ type: "ops", ops: seqTag(baseOps, 1) });
    session1.applyLocalSplice(2, 0, "c");
    expect(session1.text()).toBe("abc");
    expect(outbox.stored).toHaveLength(1);
    session1.destroy();

    // Session 2 (fresh siteId, same tab storage): op waits in the causal
    // buffer until catch-up brings its dependency, then everything merges.
    const session2 = newClient({ outboxStore: outbox, siteId: "site-1b" });
    expect(session2.queuedCount()).toBe(1);
    session2.connect();
    const s2 = sockets[1];
    if (s2 === undefined) throw new Error("no socket");
    s2.serverOpen();
    expect(s2.opsSent()).toHaveLength(1); // queued op replayed on connect
    s2.serverSend({ type: "ops", ops: seqTag(baseOps, 1) }); // catch-up
    expect(session2.text()).toBe("abc");

    // Ack clears storage for good.
    const queued = s2.opsSent();
    s2.serverSend({ type: "ops", ops: seqTag(queued, 3) });
    expect(session2.queuedCount()).toBe(0);
    expect(outbox.stored).toHaveLength(0);
  });

  it("adopts a snapshot and re-applies its own unacked ops on top", () => {
    const outbox = memoryOutbox();
    const serverDoc = new RGA("site-2");
    serverDoc.localInsertText(0, "snapshot base");

    const client = newClient({ outboxStore: outbox });
    client.applyLocalSplice(0, 0, "Z"); // offline edit before first load
    client.connect();
    const socket = sockets[0];
    if (socket === undefined) throw new Error("no socket");
    socket.serverOpen();

    socket.serverSend({ type: "snapshot", seq: 13, snapshot: serverDoc.toSnapshot() });
    socket.serverSend({ type: "ops", ops: [] });
    // "Z" was inserted at the root CONCURRENTLY with the snapshot's
    // content; concurrent root siblings order by id descending, and
    // site-2's ops win. An op-log replay of the same set produces the
    // same byte-identical result — that's the convergence guarantee.
    expect(client.text()).toBe("snapshot baseZ");
    expect(client.queuedCount()).toBe(1); // still unacked, still queued

    const next = sockets.length;
    socket.serverDrop();
    vi.advanceTimersByTime(2000);
    const second = sockets[next];
    if (second === undefined) throw new Error("no reconnect socket");
    second.serverOpen();
    expect(second.helloMessage().lastSeenSeq).toBe(13); // snapshot seq adopted
  });

  it("tracks peers from presence messages", () => {
    const client = newClient();
    client.connect();
    const socket = sockets[0];
    if (socket === undefined) throw new Error("no socket");
    socket.serverOpen();

    socket.serverSend({ type: "presence", siteId: "p1", name: "Ada", color: "#e05252", cursor: null, selection: null });
    expect(client.peers().map((p) => p.name)).toEqual(["Ada"]);

    socket.serverSend({ type: "presence-leave", siteId: "p1" });
    expect(client.peers()).toEqual([]);
  });
});
