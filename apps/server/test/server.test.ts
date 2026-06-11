import { afterEach, describe, expect, it } from "vitest";
import { RGA } from "@converge/crdt";
import type { Op } from "@converge/crdt";
import type {
  SeqOp,
  ServerMessage,
  ServerOpsMessage,
  ServerPresenceMessage,
  ServerSnapshotMessage,
} from "@converge/shared";
import { MemoryOpStore } from "../src/store.js";
import { startSyncServer } from "../src/server.js";
import type { SyncServer } from "../src/server.js";
import { TestClient } from "./test-client.js";

const isOps = (m: ServerMessage): m is ServerOpsMessage => m.type === "ops";
const opsWithItems = (m: ServerMessage): m is ServerOpsMessage => m.type === "ops" && m.ops.length > 0;
const isSnapshot = (m: ServerMessage): m is ServerSnapshotMessage => m.type === "snapshot";

/** Fresh joiners of a non-empty doc receive their state as a snapshot. */
async function receiveSnapshot(client: TestClient, siteId: string): Promise<RGA> {
  const msg = await client.expectMsg(isSnapshot);
  if (!isSnapshot(msg)) throw new Error("unreachable");
  return RGA.fromSnapshot(siteId, msg.snapshot);
}

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function startServer(store = new MemoryOpStore()): Promise<{ server: SyncServer; store: MemoryOpStore }> {
  const server = await startSyncServer({ store, port: 0, host: "127.0.0.1" });
  cleanup.push(() => server.close());
  return { server, store };
}

async function connect(port: number, docId: string, siteId: string, lastSeenSeq = 0): Promise<TestClient> {
  const client = await TestClient.connect(port);
  cleanup.push(() => client.close());
  client.hello(docId, siteId, lastSeenSeq);
  return client;
}

function applySeqOps(rga: RGA, seqOps: readonly SeqOp[]): number {
  let max = 0;
  for (const { seq, op } of seqOps) {
    rga.apply(op);
    if (seq > max) max = seq;
  }
  return max;
}

describe("sync server", () => {
  it("broadcasts live ops and both clients converge", async () => {
    const { server } = await startServer();

    const a = await connect(server.port, "doc1", "site-a");
    await a.expectMsg(isOps); // empty catch-up: caught up

    const rgaA = new RGA("site-a");
    const opsHi: Op[] = rgaA.localInsertText(0, "hi");
    a.send({ type: "ops", ops: opsHi });

    // Sender receives its own ops back, tagged with seqs (the ack).
    const echo = await a.expectMsg(opsWithItems);
    if (!isOps(echo)) throw new Error("unreachable");
    expect(echo.ops.map((s) => s.seq)).toEqual([1, 2]);

    const b = await connect(server.port, "doc1", "site-b");
    const rgaB = await receiveSnapshot(b, "site-b");
    expect(rgaB.text()).toBe("hi");

    // Live broadcast flows both ways.
    const opsB = rgaB.localInsertText(2, "!");
    b.send({ type: "ops", ops: opsB });
    const live = await a.expectMsg(opsWithItems);
    if (!isOps(live)) throw new Error("unreachable");
    applySeqOps(rgaA, live.ops);
    expect(rgaA.text()).toBe("hi!");
  });

  it("catches up a reconnecting client from lastSeenSeq only", async () => {
    const { server } = await startServer();

    const a = await connect(server.port, "doc1", "site-a");
    await a.expectMsg(isOps);
    const rgaA = new RGA("site-a");
    a.send({ type: "ops", ops: rgaA.localInsertText(0, "abc") });
    const echo = await a.expectMsg(opsWithItems);
    if (!isOps(echo)) throw new Error("unreachable");
    const seenSeq = Math.max(...echo.ops.map((s) => s.seq)); // 3

    // More ops land while "b" is offline.
    a.send({ type: "ops", ops: rgaA.localInsertText(3, "def") });
    await a.expectMsg(opsWithItems);

    // b reconnects knowing seq 3; must receive exactly seqs 4..6.
    const b = await connect(server.port, "doc1", "site-b", seenSeq);
    const tail = await b.expectMsg(opsWithItems);
    if (!isOps(tail)) throw new Error("unreachable");
    expect(tail.ops.map((s) => s.seq)).toEqual([4, 5, 6]);
  });

  it("deduplicates replayed ops (at-least-once delivery is safe)", async () => {
    const { server } = await startServer();

    const a = await connect(server.port, "doc1", "site-a");
    await a.expectMsg(isOps);
    const rgaA = new RGA("site-a");
    const ops = rgaA.localInsertText(0, "xyz");
    a.send({ type: "ops", ops });
    await a.expectMsg(opsWithItems);

    // Replay the same batch (simulates an offline-queue resend).
    a.send({ type: "ops", ops });

    // A probe that knows seq 3 must find nothing new: no fresh seqs were minted.
    const probe = await connect(server.port, "doc1", "site-probe", 3);
    const caught = await probe.expectMsg(isOps);
    if (!isOps(caught)) throw new Error("unreachable");
    expect(caught.ops).toEqual([]);
  });

  it("buffers ops that arrive out of causal order", async () => {
    const { server } = await startServer();

    const rga = new RGA("site-a");
    const [first, second] = rga.localInsertText(0, "xy");
    if (first === undefined || second === undefined) throw new Error("expected ops");

    const a = await connect(server.port, "doc1", "site-a");
    await a.expectMsg(isOps);
    a.send({ type: "ops", ops: [second] }); // child before parent
    a.send({ type: "ops", ops: [first] });

    const b = await connect(server.port, "doc1", "site-b");
    const rgaB = await receiveSnapshot(b, "site-b");
    expect(rgaB.text()).toBe("xy");
    expect(rgaB.pendingOpsCount).toBe(0);
  });

  it("relays presence and announces departures", async () => {
    const { server } = await startServer();

    const a = await connect(server.port, "doc1", "site-a");
    await a.expectMsg(isOps);
    const rgaA = new RGA("site-a");
    a.send({ type: "ops", ops: rgaA.localInsertText(0, "hey") });
    await a.expectMsg(opsWithItems);

    const b = await connect(server.port, "doc1", "site-b");
    await b.expectMsg(isSnapshot);

    const anchor = rgaA.idAtVisibleIndex(2);
    a.send({ type: "presence", cursor: anchor, selection: null });

    // B may first receive A's join-time presence (cursor null) during
    // catch-up; wait for the update that carries the anchor.
    const presence = (await b.expectMsg(
      (m) => m.type === "presence" && m.cursor !== null,
    )) as ServerPresenceMessage;
    expect(presence.siteId).toBe("site-a");
    expect(presence.name).toBe("site-a");
    expect(presence.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(presence.cursor).toEqual(anchor);

    await a.close();
    const leave = await b.expectMsg((m) => m.type === "presence-leave");
    expect(leave).toEqual({ type: "presence-leave", siteId: "site-a" });
  });

  it("rebuilds rooms from the durable log after a server restart", async () => {
    const store = new MemoryOpStore();
    const first = await startSyncServer({ store, port: 0, host: "127.0.0.1" });

    const a = await TestClient.connect(first.port);
    a.hello("doc1", "site-a");
    await a.expectMsg(isOps);
    const rgaA = new RGA("site-a");
    a.send({ type: "ops", ops: rgaA.localInsertText(0, "durable") });
    await a.expectMsg(opsWithItems); // echo => persisted
    await a.close();
    await first.close();

    const { server: second } = await startServer(store);
    const b = await connect(second.port, "doc1", "site-b");
    const rgaB = await receiveSnapshot(b, "site-b");
    expect(rgaB.text()).toBe("durable");
  });

  it("writes periodic snapshots and cold-loads from snapshot + tail", async () => {
    const store = new MemoryOpStore();
    const first = await startSyncServer({ store, port: 0, host: "127.0.0.1", snapshotEvery: 5 });

    const a = await TestClient.connect(first.port);
    a.hello("doc1", "site-a");
    await a.expectMsg(isOps);
    const rgaA = new RGA("site-a");
    a.send({ type: "ops", ops: rgaA.localInsertText(0, "0123456") }); // 7 ops -> snapshot at 7
    await a.expectMsg(opsWithItems);
    a.send({ type: "ops", ops: rgaA.localInsertText(7, "89") }); // tail past snapshot
    await a.expectMsg(opsWithItems);
    await a.close();
    await first.close();

    const saved = await store.loadSnapshot("doc1");
    expect(saved).not.toBeNull();
    expect(saved?.upToSeq).toBe(7);

    // Cold load must merge snapshot (seqs 1-7) with the log tail (8-9).
    const { server: second } = await startServer(store);
    const b = await connect(second.port, "doc1", "site-b");
    const rgaB = await receiveSnapshot(b, "site-b");
    expect(rgaB.text()).toBe("012345689"); // "0123456" + "89"
  });

  it("rejects garbage and pre-hello traffic with error messages", async () => {
    const { server } = await startServer();

    const raw = await TestClient.connect(server.port);
    cleanup.push(() => raw.close());

    raw.send({ type: "presence", cursor: null, selection: null });
    const err1 = await raw.expectMsg((m) => m.type === "error");
    expect(err1.type).toBe("error");

    raw.hello("doc1", "site-a");
    await raw.expectMsg(isOps);
    raw.hello("doc1", "site-a"); // duplicate hello
    const err2 = await raw.expectMsg((m) => m.type === "error");
    expect(err2.type).toBe("error");
  });
});
