import { RGA } from "@converge/crdt";
import type { Op } from "@converge/crdt";
import type { CursorAnchor, SelectionRange, SeqOp, ServerMessage } from "@converge/shared";
import type { OpStore } from "./store.js";

export interface RoomClient {
  readonly siteId: string;
  readonly name: string;
  readonly color: string;
  cursor: CursorAnchor;
  selection: SelectionRange | null;
  send(msg: ServerMessage): void;
  close(): void;
}

const CATCHUP_CHUNK = 2000;
const DEFAULT_SNAPSHOT_EVERY = 500;

/**
 * One live document. Holds the server's own RGA replica (used to dedupe
 * ops and to know the current text), the connected clients, and a write
 * chain that serializes persist-then-broadcast. The chain matters:
 * clients track a contiguous `lastSeenSeq`, so seq N must never be
 * broadcast (or made readable by a catch-up) before seq N-1 is durable.
 */
export class DocRoom {
  readonly docId: string;
  private readonly store: OpStore;
  private rga: RGA; // reassigned only during snapshot cold-load
  private lastSeq = 0;
  private lastSnapshotSeq = 0;
  private readonly snapshotEvery: number;
  private readonly clients = new Set<RoomClient>();
  private chain: Promise<void> = Promise.resolve();
  private failed = false;

  private constructor(docId: string, store: OpStore, snapshotEvery: number) {
    this.docId = docId;
    this.store = store;
    this.snapshotEvery = snapshotEvery;
    this.rga = new RGA(`server:${docId}`);
  }

  /**
   * Rebuild the room's replica: adopt the latest snapshot if one exists,
   * then replay only the log tail past it.
   */
  static async load(
    docId: string,
    store: OpStore,
    snapshotEvery: number = DEFAULT_SNAPSHOT_EVERY,
  ): Promise<DocRoom> {
    const room = new DocRoom(docId, store, snapshotEvery);
    await store.ensureDoc(docId);
    const snapshot = await store.loadSnapshot(docId);
    if (snapshot !== null) {
      room.rga = RGA.fromSnapshot(`server:${docId}`, snapshot.state);
      room.lastSeq = snapshot.upToSeq;
      room.lastSnapshotSeq = snapshot.upToSeq;
    }
    for (const { seq, op } of await store.loadOps(docId, room.lastSeq)) {
      room.rga.apply(op);
      if (seq > room.lastSeq) room.lastSeq = seq;
    }
    return room;
  }

  get hasFailed(): boolean {
    return this.failed;
  }

  get isEmpty(): boolean {
    return this.clients.size === 0;
  }

  get clientCount(): number {
    return this.clients.size;
  }

  text(): string {
    return this.rga.text();
  }

  /**
   * Register a client and queue its catch-up. Registration happens
   * before the chained read, so: every op persisted before this point is
   * in the catch-up read, and every op enqueued after will reach the
   * client as a live broadcast. No gaps, no misses.
   */
  join(client: RoomClient, lastSeenSeq: number): void {
    this.clients.add(client);
    this.enqueue(async () => {
      if (lastSeenSeq === 0 && this.lastSeq > 0) {
        // Fresh client: ship the current state as one snapshot instead
        // of replaying the whole log. Taken inside the chain, so it is
        // consistent with the broadcast stream the client now receives.
        client.send({ type: "snapshot", seq: this.lastSeq, snapshot: this.rga.toSnapshot() });
        client.send({ type: "ops", ops: [] }); // caught-up marker
      } else {
        const ops = await this.store.loadOps(this.docId, lastSeenSeq);
        if (ops.length === 0) {
          client.send({ type: "ops", ops: [] }); // caught-up marker
        }
        for (let i = 0; i < ops.length; i += CATCHUP_CHUNK) {
          client.send({ type: "ops", ops: ops.slice(i, i + CATCHUP_CHUNK) });
        }
      }
      for (const other of this.clients) {
        if (other === client || other.siteId === client.siteId) continue;
        client.send({
          type: "presence",
          siteId: other.siteId,
          name: other.name,
          color: other.color,
          cursor: other.cursor,
          selection: other.selection,
        });
      }
    });
  }

  leave(client: RoomClient): void {
    if (!this.clients.delete(client)) return;
    this.broadcast({ type: "presence-leave", siteId: client.siteId });
  }

  /**
   * Apply client ops to the server replica, assign seqs to the fresh
   * ones, persist, then broadcast (to everyone INCLUDING the sender —
   * the echo is the sender's ack and advances its lastSeenSeq).
   * Duplicates (offline-queue replays, network retries) are dropped by
   * the RGA and never re-persisted, giving at-least-once delivery
   * exactly-once effect.
   */
  submitOps(ops: readonly Op[]): void {
    if (this.failed) return;
    const fresh: SeqOp[] = [];
    for (const op of ops) {
      if (this.rga.apply(op) === "duplicate") continue;
      this.lastSeq += 1;
      fresh.push({ seq: this.lastSeq, op });
    }
    if (fresh.length === 0) return;
    this.enqueue(async () => {
      await this.store.appendOps(this.docId, fresh);
      this.broadcast({ type: "ops", ops: fresh });
      if (this.lastSeq - this.lastSnapshotSeq >= this.snapshotEvery) {
        // rga and lastSeq always move together (both updated
        // synchronously in submitOps), so this pair is consistent even
        // if later submits already advanced past `fresh`.
        const upToSeq = this.lastSeq;
        await this.store.saveSnapshot(this.docId, { state: this.rga.toSnapshot(), upToSeq });
        this.lastSnapshotSeq = upToSeq;
      }
    });
  }

  updatePresence(client: RoomClient, cursor: CursorAnchor, selection: SelectionRange | null): void {
    client.cursor = cursor;
    client.selection = selection;
    this.broadcastExcept(client, {
      type: "presence",
      siteId: client.siteId,
      name: client.name,
      color: client.color,
      cursor,
      selection,
    });
  }

  /** Wait for all queued persistence work to flush. */
  async settle(): Promise<void> {
    await this.chain;
  }

  private broadcast(msg: ServerMessage): void {
    for (const client of this.clients) client.send(msg);
  }

  private broadcastExcept(skip: RoomClient, msg: ServerMessage): void {
    for (const client of this.clients) {
      if (client !== skip) client.send(msg);
    }
  }

  private enqueue(task: () => Promise<void>): void {
    this.chain = this.chain.then(task).catch((err: unknown) => {
      if (this.failed) return;
      this.failed = true;
      console.error(`[room ${this.docId}] persistence failure:`, err);
      // Fail loudly: clients reconnect and the room is rebuilt from the
      // durable log, rather than serving state that was never persisted.
      this.broadcast({ type: "error", message: "server persistence failure; please reconnect" });
      for (const client of [...this.clients]) client.close();
      this.clients.clear();
    });
  }
}

/**
 * Rooms stay resident once loaded (no eviction): evicting safely
 * requires fencing against in-flight joins, and a split-brain room pair
 * would assign colliding seqs. Snapshot-based memory bounds are a
 * Phase 5 concern.
 */
export class RoomManager {
  private readonly store: OpStore;
  private readonly snapshotEvery: number;
  private readonly rooms = new Map<string, Promise<DocRoom>>();

  constructor(store: OpStore, snapshotEvery: number = DEFAULT_SNAPSHOT_EVERY) {
    this.store = store;
    this.snapshotEvery = snapshotEvery;
  }

  async get(docId: string): Promise<DocRoom> {
    const existing = this.rooms.get(docId);
    if (existing !== undefined) {
      const room = await existing;
      if (!room.hasFailed) return room;
      this.rooms.delete(docId);
    }
    const loading = DocRoom.load(docId, this.store, this.snapshotEvery);
    this.rooms.set(docId, loading);
    try {
      return await loading;
    } catch (err) {
      this.rooms.delete(docId);
      throw err;
    }
  }

  async settleAll(): Promise<void> {
    for (const promise of this.rooms.values()) {
      const room = await promise.catch(() => null);
      if (room !== null) await room.settle();
    }
  }
}
