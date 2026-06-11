/**
 * Identifier of a single character node. Globally unique and totally
 * orderable: compare `lamport` first, then `siteId` (plain code-unit
 * string comparison — never locale-dependent) as the tiebreak.
 */
export interface NodeId {
  readonly lamport: number;
  readonly siteId: string;
}

/** Total order over NodeIds: lamport, then siteId. Returns -1 | 0 | 1. */
export function compareNodeIds(a: NodeId, b: NodeId): number {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  if (a.siteId !== b.siteId) return a.siteId < b.siteId ? -1 : 1;
  return 0;
}

/**
 * Stable map key for a NodeId. Unambiguous because lamport is a number,
 * so the first ":" always separates the two components.
 */
export function nodeIdKey(id: NodeId): string {
  return `${id.lamport}:${id.siteId}`;
}

export function sameNodeId(a: NodeId, b: NodeId): boolean {
  return a.lamport === b.lamport && a.siteId === b.siteId;
}

/**
 * Insert `value` immediately to the right of the node `afterId`.
 * `afterId === null` means "insert at the head of the document".
 * `value` is exactly one UTF-16 code unit.
 */
export interface InsertOp {
  readonly kind: "insert";
  readonly id: NodeId;
  readonly afterId: NodeId | null;
  readonly value: string;
}

/** Tombstone the node `id`. The node is never physically removed. */
export interface DeleteOp {
  readonly kind: "delete";
  readonly id: NodeId;
}

export type Op = InsertOp | DeleteOp;
