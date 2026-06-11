import { compareNodeIds, nodeIdKey } from "./types.js";
import type { DeleteOp, InsertOp, NodeId, Op } from "./types.js";

/**
 * A node in the replicated sequence. Tombstoned nodes stay in the list
 * forever so concurrent ops can still reference them.
 */
interface ListNode {
  readonly id: NodeId;
  readonly value: string;
  deleted: boolean;
  next: ListNode | null;
}

/** Anything a node can be linked after: the root sentinel or another node. */
interface LinkPoint {
  next: ListNode | null;
}

export type ApplyResult = "applied" | "buffered" | "duplicate";

export interface SnapshotNode {
  readonly id: NodeId;
  readonly value: string;
  readonly deleted: boolean;
}

export interface RGASnapshot {
  readonly clock: number;
  /** All nodes (including tombstones) in converged list order. */
  readonly nodes: readonly SnapshotNode[];
  /** Ops that were still waiting on a missing dependency. */
  readonly pending: readonly Op[];
}

/**
 * Replicated Growable Array over UTF-16 code units.
 *
 * Convergence argument, in brief: every node id carries a Lamport
 * timestamp that is strictly greater than the timestamp of every node its
 * author had applied when generating it. Integration of an insert scans
 * right from `afterId`, skipping nodes with a greater id, and splices the
 * new node before the first node with a smaller id. Concurrent siblings
 * of the same parent therefore land in descending id order on every
 * replica, and a node inserted after X can never jump over X's
 * descendants (their timestamps are all greater than X's, hence greater
 * than any concurrent sibling's). Deletes are monotone tombstones. Both
 * op kinds are idempotent and commute once causally ready, and causal
 * readiness is enforced by buffering — so any replica that has applied
 * the same SET of ops holds the identical node list.
 */
export class RGA {
  readonly siteId: string;

  private clock = 0;
  private readonly root: LinkPoint = { next: null };
  private readonly nodes = new Map<string, ListNode>();
  /** missing-dependency key -> ops waiting for that node to arrive */
  private readonly pending = new Map<string, Op[]>();

  constructor(siteId: string) {
    if (siteId.length === 0) throw new Error("siteId must be non-empty");
    this.siteId = siteId;
  }

  // ------------------------------------------------------------------
  // Local operations (generate an op AND apply it immediately)
  // ------------------------------------------------------------------

  /**
   * Insert one UTF-16 code unit at visible index `index` (0 = head,
   * visibleLength = append). Returns the op to broadcast.
   */
  localInsert(index: number, value: string): InsertOp {
    if (value.length !== 1) {
      throw new Error(`localInsert value must be exactly 1 code unit, got ${value.length}`);
    }
    const afterId = this.anchorForIndex(index);
    this.clock += 1;
    const op: InsertOp = {
      kind: "insert",
      id: { lamport: this.clock, siteId: this.siteId },
      afterId,
      value,
    };
    this.integrate(op);
    return op;
  }

  /** Insert a multi-character string; returns one op per code unit. */
  localInsertText(index: number, text: string): InsertOp[] {
    const ops: InsertOp[] = [];
    for (let i = 0; i < text.length; i++) {
      ops.push(this.localInsert(index + i, text.charAt(i)));
    }
    return ops;
  }

  /** Tombstone the visible character at `index`. Returns the op to broadcast. */
  localDelete(index: number): DeleteOp {
    const node = this.visibleNodeAt(index);
    if (node === null) {
      throw new RangeError(`localDelete index ${index} out of bounds (length ${this.visibleLength})`);
    }
    node.deleted = true;
    return { kind: "delete", id: node.id };
  }

  /** Tombstone `count` visible characters starting at `index`. */
  localDeleteRange(index: number, count: number): DeleteOp[] {
    const ops: DeleteOp[] = [];
    for (let i = 0; i < count; i++) {
      ops.push(this.localDelete(index)); // each delete shifts the rest left
    }
    return ops;
  }

  // ------------------------------------------------------------------
  // Remote operations
  // ------------------------------------------------------------------

  /**
   * Apply a remote op. If a dependency (insert's `afterId`, delete's
   * target) has not arrived yet, the op is buffered and replayed
   * automatically once the dependency is applied. Safe to call with
   * duplicates, including echoes of this replica's own ops.
   */
  apply(op: Op): ApplyResult {
    const result = this.applyOne(op);
    if (result === "applied" && op.kind === "insert") {
      this.drainFrom(nodeIdKey(op.id));
    }
    return result;
  }

  applyAll(ops: readonly Op[]): void {
    for (const op of ops) this.apply(op);
  }

  private applyOne(op: Op): ApplyResult {
    if (op.kind === "insert") {
      // Lamport receive rule: track the highest timestamp ever seen, even
      // for buffered/duplicate ops, so our next local id is globally fresh.
      this.clock = Math.max(this.clock, op.id.lamport);
      if (this.nodes.has(nodeIdKey(op.id))) return "duplicate";
      if (op.afterId !== null && !this.nodes.has(nodeIdKey(op.afterId))) {
        return this.buffer(nodeIdKey(op.afterId), op) ? "buffered" : "duplicate";
      }
      this.integrate(op);
      return "applied";
    }
    const target = this.nodes.get(nodeIdKey(op.id));
    if (target === undefined) {
      return this.buffer(nodeIdKey(op.id), op) ? "buffered" : "duplicate";
    }
    if (target.deleted) return "duplicate";
    target.deleted = true;
    return "applied";
  }

  /** Iteratively apply every buffered op unblocked by `startKey` arriving. */
  private drainFrom(startKey: string): void {
    const queue: string[] = [startKey];
    while (queue.length > 0) {
      const key = queue.pop();
      if (key === undefined) break;
      const waiting = this.pending.get(key);
      if (waiting === undefined) continue;
      this.pending.delete(key);
      for (const op of waiting) {
        if (this.applyOne(op) === "applied" && op.kind === "insert") {
          queue.push(nodeIdKey(op.id));
        }
      }
    }
  }

  /** Returns false if an op with the same identity was already buffered. */
  private buffer(depKey: string, op: Op): boolean {
    const list = this.pending.get(depKey);
    if (list === undefined) {
      this.pending.set(depKey, [op]);
      return true;
    }
    const opKey = nodeIdKey(op.id);
    if (list.some((o) => o.kind === op.kind && nodeIdKey(o.id) === opKey)) {
      return false;
    }
    list.push(op);
    return true;
  }

  /**
   * RGA integration: walk right from the anchor, skip every node with an
   * id greater than the new node's, splice before the first smaller one.
   */
  private integrate(op: InsertOp): void {
    const anchor: LinkPoint | undefined =
      op.afterId === null ? this.root : this.nodes.get(nodeIdKey(op.afterId));
    if (anchor === undefined) {
      throw new Error("integrate called before dependency arrived (bug: caller must buffer)");
    }
    let prev: LinkPoint = anchor;
    let cur = anchor.next;
    while (cur !== null && compareNodeIds(cur.id, op.id) > 0) {
      prev = cur;
      cur = cur.next;
    }
    const node: ListNode = { id: op.id, value: op.value, deleted: false, next: cur };
    prev.next = node;
    this.nodes.set(nodeIdKey(op.id), node);
  }

  // ------------------------------------------------------------------
  // Reads
  // ------------------------------------------------------------------

  /** The visible document: values of non-tombstoned nodes, in order. */
  text(): string {
    let out = "";
    for (let cur = this.root.next; cur !== null; cur = cur.next) {
      if (!cur.deleted) out += cur.value;
    }
    return out;
  }

  get visibleLength(): number {
    let n = 0;
    for (let cur = this.root.next; cur !== null; cur = cur.next) {
      if (!cur.deleted) n++;
    }
    return n;
  }

  /** Total nodes including tombstones. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  get pendingOpsCount(): number {
    let n = 0;
    for (const list of this.pending.values()) n += list.length;
    return n;
  }

  /** Id of the visible character at `index`, or null if out of bounds. */
  idAtVisibleIndex(index: number): NodeId | null {
    const node = this.visibleNodeAt(index);
    return node === null ? null : node.id;
  }

  /**
   * Visible index of node `id`: the count of visible nodes strictly before
   * it. For a tombstoned node this is the index its position maps to
   * (useful for cursor stability). Returns -1 for unknown ids.
   */
  visibleIndexOf(id: NodeId): number {
    const targetKey = nodeIdKey(id);
    if (!this.nodes.has(targetKey)) return -1;
    let index = 0;
    for (let cur = this.root.next; cur !== null; cur = cur.next) {
      if (nodeIdKey(cur.id) === targetKey) return index;
      if (!cur.deleted) index++;
    }
    return -1;
  }

  /**
   * Caret index for a cursor anchored "after node `id`": the number of
   * visible characters up to and including that node. Tombstoned anchors
   * map to the position the node used to occupy, so a caret never jumps
   * when the character left of it is deleted remotely. -1 for unknown ids.
   */
  caretIndexAfter(id: NodeId): number {
    const target = this.nodes.get(nodeIdKey(id));
    if (target === undefined) return -1;
    let index = 0;
    for (let cur = this.root.next; cur !== null; cur = cur.next) {
      if (cur === target) return index + (cur.deleted ? 0 : 1);
      if (!cur.deleted) index++;
    }
    return -1;
  }

  /**
   * Full-state fingerprint (order, values, tombstones — not the clock or
   * pending buffer). Two replicas converged iff digests are equal.
   */
  stateDigest(): string {
    const parts: string[] = [];
    for (let cur = this.root.next; cur !== null; cur = cur.next) {
      parts.push(`${cur.id.lamport}:${cur.id.siteId}:${cur.deleted ? 1 : 0}:${cur.value}`);
    }
    return parts.join("|");
  }

  // ------------------------------------------------------------------
  // Snapshots
  // ------------------------------------------------------------------

  toSnapshot(): RGASnapshot {
    const nodes: SnapshotNode[] = [];
    for (let cur = this.root.next; cur !== null; cur = cur.next) {
      nodes.push({ id: cur.id, value: cur.value, deleted: cur.deleted });
    }
    const pending: Op[] = [];
    for (const list of this.pending.values()) pending.push(...list);
    return { clock: this.clock, nodes, pending };
  }

  static fromSnapshot(siteId: string, snapshot: RGASnapshot): RGA {
    const rga = new RGA(siteId);
    let prev: LinkPoint = rga.root;
    for (const n of snapshot.nodes) {
      const node: ListNode = { id: n.id, value: n.value, deleted: n.deleted, next: null };
      prev.next = node;
      prev = node;
      rga.nodes.set(nodeIdKey(n.id), node);
      rga.clock = Math.max(rga.clock, n.id.lamport);
    }
    rga.clock = Math.max(rga.clock, snapshot.clock);
    rga.applyAll(snapshot.pending);
    return rga;
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /** Anchor id for inserting at visible index `index` (null = head). */
  private anchorForIndex(index: number): NodeId | null {
    if (index < 0 || index > this.visibleLength) {
      throw new RangeError(`insert index ${index} out of bounds (length ${this.visibleLength})`);
    }
    if (index === 0) return null;
    const node = this.visibleNodeAt(index - 1);
    if (node === null) throw new Error("unreachable: bounds checked above");
    return node.id;
  }

  private visibleNodeAt(index: number): ListNode | null {
    if (index < 0) return null;
    let i = 0;
    for (let cur = this.root.next; cur !== null; cur = cur.next) {
      if (cur.deleted) continue;
      if (i === index) return cur;
      i++;
    }
    return null;
  }
}
