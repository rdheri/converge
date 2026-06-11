import { RGA, nodeIdKey } from "@converge/crdt";
import type { Op } from "@converge/crdt";
import {
  PROTOCOL_VERSION,
  isOp,
  parseServerMessage,
  tryParseJson,
} from "@converge/shared";
import type {
  CursorAnchor,
  SelectionRange,
  SeqOp,
  ServerMessage,
} from "@converge/shared";

export type ConnectionStatus = "connecting" | "online" | "offline";

export interface PeerPresence {
  readonly siteId: string;
  readonly name: string;
  readonly color: string;
  readonly cursor: CursorAnchor;
  readonly selection: SelectionRange | null;
}

/** Minimal structural slice of the browser WebSocket, for testability. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  readonly readyState: number;
}

export type SocketFactory = (url: string) => SocketLike;

/** Durable home for unacknowledged ops (survives tab reloads). */
export interface OutboxStore {
  load(): Op[];
  save(ops: readonly Op[]): void;
}

export interface DocClientOptions {
  readonly url: string;
  readonly docId: string;
  readonly siteId: string;
  readonly name: string;
  readonly socketFactory?: SocketFactory;
  readonly outboxStore?: OutboxStore;
}

const SOCKET_OPEN = 1;
const MAX_OPS_PER_MESSAGE = 4096;
const PRESENCE_THROTTLE_MS = 80;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 15_000;

function opIdentity(op: Op): string {
  return `${op.kind}|${nodeIdKey(op.id)}`;
}

export function localStorageOutbox(docId: string, tabId: string): OutboxStore {
  const key = `converge:outbox:${docId}:${tabId}`;
  return {
    load(): Op[] {
      const raw = localStorage.getItem(key);
      if (raw === null) return [];
      const parsed = tryParseJson(raw);
      return Array.isArray(parsed) ? parsed.filter(isOp) : [];
    },
    save(ops: readonly Op[]): void {
      if (ops.length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(ops));
    },
  };
}

/**
 * One document replica wired to the sync server.
 *
 * Local-first: edits apply to the local RGA synchronously and are queued
 * in the outbox; the network only ever drains the queue. An op leaves
 * the outbox when its echo (with a server seq) comes back — until then
 * it is resent on every reconnect, and the server's dedupe makes the
 * resends harmless. The outbox is persisted, so a tab reload (even
 * offline) loses nothing: restored ops sit in the RGA's causal buffer
 * until catch-up delivers their dependencies.
 */
export class DocClient {
  readonly docId: string;
  readonly siteId: string;

  private rga: RGA; // reassigned only on snapshot adoption
  private readonly url: string;
  private readonly socketFactory: SocketFactory;
  private readonly outboxStore: OutboxStore | null;
  private nameValue: string;

  private outbox: Op[] = [];
  private lastSeenSeq = 0;
  private socket: SocketLike | null = null;
  private statusValue: ConnectionStatus = "offline";
  private readonly peersMap = new Map<string, PeerPresence>();

  private versionCounter = 0;
  private readonly listeners = new Set<() => void>();

  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualOffline = false;
  private destroyed = false;

  private pendingPresence: { cursor: CursorAnchor; selection: SelectionRange | null } | null = null;
  private presenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: DocClientOptions) {
    this.docId = opts.docId;
    this.siteId = opts.siteId;
    this.url = opts.url;
    this.nameValue = opts.name;
    this.socketFactory = opts.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
    this.outboxStore = opts.outboxStore ?? null;
    this.rga = new RGA(opts.siteId);

    // Restore ops queued by a previous session of this tab. They may
    // reference nodes we don't have yet; the causal buffer holds them
    // until catch-up arrives.
    if (this.outboxStore !== null) {
      const restored = this.outboxStore.load();
      for (const op of restored) this.rga.apply(op);
      this.outbox = restored;
    }
  }

  // ------------------------------------------------------------------
  // Reads (stable function identities for useSyncExternalStore)
  // ------------------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.versionCounter;

  text(): string {
    return this.rga.text();
  }

  status(): ConnectionStatus {
    return this.statusValue;
  }

  name(): string {
    return this.nameValue;
  }

  queuedCount(): number {
    return this.outbox.length;
  }

  isManualOffline(): boolean {
    return this.manualOffline;
  }

  peers(): PeerPresence[] {
    return [...this.peersMap.values()].sort((a, b) => (a.siteId < b.siteId ? -1 : 1));
  }

  /** Anchor for a caret sitting at visible index `index`. */
  anchorForCaret(index: number): CursorAnchor {
    if (index <= 0) return null;
    return this.rga.idAtVisibleIndex(Math.min(index, Math.max(0, this.rga.visibleLength)) - 1);
  }

  /** Caret index for an anchor; -1 when the anchor isn't known yet. */
  caretForAnchor(anchor: CursorAnchor): number {
    if (anchor === null) return 0;
    return this.rga.caretIndexAfter(anchor);
  }

  // ------------------------------------------------------------------
  // Connection lifecycle
  // ------------------------------------------------------------------

  connect(): void {
    // React StrictMode mounts effects twice (connect/destroy/connect),
    // so a destroyed client must be revivable.
    this.destroyed = false;
    if (this.manualOffline || this.socket !== null) return;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.setStatus("connecting");

    const socket = this.socketFactory(this.url);
    this.socket = socket;

    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          docId: this.docId,
          siteId: this.siteId,
          name: this.nameValue,
          lastSeenSeq: this.lastSeenSeq,
        }),
      );
      this.sendOps(this.outbox); // replay everything unacknowledged
      if (this.pendingPresence !== null) this.flushPresence();
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const msg = parseServerMessage(event.data);
      if (msg === null) return;
      this.handleServerMessage(msg);
    };

    socket.onclose = () => {
      this.socket = null;
      this.peersMap.clear();
      if (this.destroyed) return;
      this.setStatus("offline");
      this.scheduleReconnect();
      this.bump();
    };

    socket.onerror = () => {
      // close always follows; nothing to do here
    };
  }

  /** Demo/offline toggle: true = drop the connection and stay down. */
  setManualOffline(offline: boolean): void {
    this.manualOffline = offline;
    if (offline) {
      this.socket?.close();
      this.setStatus("offline");
    } else {
      this.reconnectAttempts = 0;
      this.connect();
    }
    this.bump();
  }

  updateName(name: string): void {
    this.nameValue = name;
    // name travels in hello; cycle the socket to re-introduce ourselves
    this.socket?.close();
    if (!this.manualOffline) this.connect();
    this.bump();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.presenceTimer !== null) {
      clearTimeout(this.presenceTimer);
      this.presenceTimer = null;
    }
    this.socket?.close();
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.manualOffline || this.reconnectTimer !== null) return;
    const exp = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    const delay = exp + Math.random() * 250;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ------------------------------------------------------------------
  // Local edits (synchronous, never blocked by the network)
  // ------------------------------------------------------------------

  applyLocalSplice(start: number, removed: number, inserted: string): void {
    if (removed === 0 && inserted.length === 0) return;
    const ops: Op[] = [
      ...this.rga.localDeleteRange(start, removed),
      ...this.rga.localInsertText(start, inserted),
    ];
    this.outbox.push(...ops);
    this.persistOutbox();
    this.sendOps(ops);
    this.bump();
  }

  sendPresence(cursor: CursorAnchor, selection: SelectionRange | null): void {
    this.pendingPresence = { cursor, selection };
    if (this.presenceTimer !== null) return;
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.flushPresence();
    }, PRESENCE_THROTTLE_MS);
  }

  private flushPresence(): void {
    if (this.pendingPresence === null) return;
    if (this.socket === null || this.socket.readyState !== SOCKET_OPEN) return;
    this.socket.send(JSON.stringify({ type: "presence", ...this.pendingPresence }));
  }

  private sendOps(ops: readonly Op[]): void {
    if (ops.length === 0) return;
    if (this.socket === null || this.socket.readyState !== SOCKET_OPEN) return;
    for (let i = 0; i < ops.length; i += MAX_OPS_PER_MESSAGE) {
      this.socket.send(JSON.stringify({ type: "ops", ops: ops.slice(i, i + MAX_OPS_PER_MESSAGE) }));
    }
  }

  // ------------------------------------------------------------------
  // Server messages
  // ------------------------------------------------------------------

  private handleServerMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case "ops": {
        for (const { seq, op } of msg.ops) {
          if (seq > this.lastSeenSeq) this.lastSeenSeq = seq;
          this.rga.apply(op); // own echoes dedupe to "duplicate"
        }
        this.ackOutbox(msg.ops);
        if (this.statusValue !== "online") {
          this.reconnectAttempts = 0;
          this.setStatus("online");
        }
        this.bump();
        return;
      }
      case "snapshot": {
        // Fast cold load: adopt the snapshot, then re-apply anything of
        // ours that wasn't in it (unacked outbox ops re-enter the
        // causal buffer or integrate directly). Never adopt a snapshot
        // older than what we've already applied.
        if (msg.seq < this.lastSeenSeq) return;
        this.rga = RGA.fromSnapshot(this.siteId, msg.snapshot);
        for (const op of this.outbox) this.rga.apply(op);
        if (msg.seq > this.lastSeenSeq) this.lastSeenSeq = msg.seq;
        this.bump();
        return;
      }
      case "presence": {
        if (msg.siteId === this.siteId) return;
        this.peersMap.set(msg.siteId, {
          siteId: msg.siteId,
          name: msg.name,
          color: msg.color,
          cursor: msg.cursor,
          selection: msg.selection,
        });
        this.bump();
        return;
      }
      case "presence-leave": {
        if (this.peersMap.delete(msg.siteId)) this.bump();
        return;
      }
      case "error": {
        console.warn(`[converge] server error: ${msg.message}`);
        return;
      }
    }
  }

  private ackOutbox(seqOps: readonly SeqOp[]): void {
    if (this.outbox.length === 0) return;
    const acked = new Set(seqOps.map((s) => opIdentity(s.op)));
    const remaining = this.outbox.filter((op) => !acked.has(opIdentity(op)));
    if (remaining.length !== this.outbox.length) {
      this.outbox = remaining;
      this.persistOutbox();
    }
  }

  private persistOutbox(): void {
    this.outboxStore?.save(this.outbox);
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.statusValue !== status) {
      this.statusValue = status;
      this.bump();
    }
  }

  private bump(): void {
    this.versionCounter++;
    for (const listener of this.listeners) listener();
  }
}
