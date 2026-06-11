import type { RGASnapshot, SeqOp } from "@converge/shared";

export interface SnapshotRecord {
  readonly state: RGASnapshot;
  readonly upToSeq: number;
}

/**
 * Append-only op log, keyed by (docId, seq), plus an optional one-row
 * full-state snapshot per doc for fast cold loads (snapshot + tail
 * instead of full replay). The server assigns seqs in memory; the store
 * only persists and replays them. The log is never pruned.
 */
export interface OpStore {
  ensureDoc(docId: string): Promise<void>;
  appendOps(docId: string, ops: readonly SeqOp[]): Promise<void>;
  /** Ops with seq > afterSeq, ascending. afterSeq = 0 loads everything. */
  loadOps(docId: string, afterSeq: number): Promise<SeqOp[]>;
  loadSnapshot(docId: string): Promise<SnapshotRecord | null>;
  saveSnapshot(docId: string, record: SnapshotRecord): Promise<void>;
  close(): Promise<void>;
}

/** Used by tests and as a no-Postgres fallback for quick local demos. */
export class MemoryOpStore implements OpStore {
  private readonly docs = new Map<string, SeqOp[]>();
  private readonly snapshots = new Map<string, SnapshotRecord>();

  ensureDoc(docId: string): Promise<void> {
    if (!this.docs.has(docId)) this.docs.set(docId, []);
    return Promise.resolve();
  }

  appendOps(docId: string, ops: readonly SeqOp[]): Promise<void> {
    const log = this.docs.get(docId);
    if (log === undefined) return Promise.reject(new Error(`unknown doc ${docId}`));
    log.push(...ops);
    return Promise.resolve();
  }

  loadOps(docId: string, afterSeq: number): Promise<SeqOp[]> {
    const log = this.docs.get(docId) ?? [];
    return Promise.resolve(log.filter((s) => s.seq > afterSeq));
  }

  loadSnapshot(docId: string): Promise<SnapshotRecord | null> {
    return Promise.resolve(this.snapshots.get(docId) ?? null);
  }

  saveSnapshot(docId: string, record: SnapshotRecord): Promise<void> {
    this.snapshots.set(docId, record);
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
