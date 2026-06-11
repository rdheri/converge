import type { NodeId, Op, RGASnapshot } from "@converge/crdt";

export const PROTOCOL_VERSION = 1;

/**
 * A caret position, anchored to the CRDT rather than to a numeric index:
 * the id of the visible node the caret sits immediately AFTER, or null
 * for the very start of the document. Id anchors survive concurrent
 * edits; indices do not.
 */
export type CursorAnchor = NodeId | null;

export interface SelectionRange {
  readonly anchor: CursorAnchor;
  readonly head: CursorAnchor;
}

/**
 * An op tagged with the server-assigned, per-document, strictly
 * increasing sequence number. Catch-up is by seq, not by lamport:
 * lamport timestamps are not totally ordered across sites, so
 * "everything with lamport > X" can miss concurrent ops that reached
 * the server late. The seq is a server-side delivery cursor only — it
 * plays no part in CRDT ordering.
 */
export interface SeqOp {
  readonly seq: number;
  readonly op: Op;
}

// ----------------------------------------------------------------------
// Client -> Server
// ----------------------------------------------------------------------

export interface HelloMessage {
  readonly type: "hello";
  readonly protocolVersion: number;
  readonly docId: string;
  readonly siteId: string;
  readonly name: string;
  /** Highest server seq this client has applied; 0 for a fresh client. */
  readonly lastSeenSeq: number;
}

/** Batched so an offline queue replays as a single message. */
export interface ClientOpsMessage {
  readonly type: "ops";
  readonly ops: readonly Op[];
}

export interface ClientPresenceMessage {
  readonly type: "presence";
  readonly cursor: CursorAnchor;
  readonly selection: SelectionRange | null;
}

export type ClientMessage = HelloMessage | ClientOpsMessage | ClientPresenceMessage;

// ----------------------------------------------------------------------
// Server -> Client
// ----------------------------------------------------------------------

/** Catch-up (after hello) and live broadcast share one message shape. */
export interface ServerOpsMessage {
  readonly type: "ops";
  readonly ops: readonly SeqOp[];
}

/** Fast initial load: full state up to `seq`, then ops stream from there. */
export interface ServerSnapshotMessage {
  readonly type: "snapshot";
  readonly seq: number;
  readonly snapshot: RGASnapshot;
}

export interface ServerPresenceMessage {
  readonly type: "presence";
  readonly siteId: string;
  readonly name: string;
  readonly color: string;
  readonly cursor: CursorAnchor;
  readonly selection: SelectionRange | null;
}

export interface ServerPresenceLeaveMessage {
  readonly type: "presence-leave";
  readonly siteId: string;
}

export interface ServerErrorMessage {
  readonly type: "error";
  readonly message: string;
}

export type ServerMessage =
  | ServerOpsMessage
  | ServerSnapshotMessage
  | ServerPresenceMessage
  | ServerPresenceLeaveMessage
  | ServerErrorMessage;

// ----------------------------------------------------------------------
// Validation (hand-rolled, dependency-free). The server must never trust
// a socket payload, so every client message gets a full structural check.
// ----------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isNodeId(v: unknown): v is NodeId {
  return (
    isRecord(v) &&
    typeof v.lamport === "number" &&
    Number.isInteger(v.lamport) &&
    v.lamport >= 1 &&
    typeof v.siteId === "string" &&
    v.siteId.length > 0
  );
}

export function isOp(v: unknown): v is Op {
  if (!isRecord(v)) return false;
  if (v.kind === "insert") {
    return (
      isNodeId(v.id) &&
      (v.afterId === null || isNodeId(v.afterId)) &&
      typeof v.value === "string" &&
      v.value.length === 1
    );
  }
  if (v.kind === "delete") {
    return isNodeId(v.id);
  }
  return false;
}

function isCursorAnchor(v: unknown): v is CursorAnchor {
  return v === null || isNodeId(v);
}

function isSelectionRange(v: unknown): v is SelectionRange {
  return isRecord(v) && isCursorAnchor(v.anchor) && isCursorAnchor(v.head);
}

export function isClientMessage(v: unknown): v is ClientMessage {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case "hello":
      return (
        typeof v.protocolVersion === "number" &&
        typeof v.docId === "string" &&
        v.docId.length > 0 &&
        v.docId.length <= 128 &&
        typeof v.siteId === "string" &&
        v.siteId.length > 0 &&
        v.siteId.length <= 64 &&
        typeof v.name === "string" &&
        v.name.length <= 64 &&
        typeof v.lastSeenSeq === "number" &&
        Number.isInteger(v.lastSeenSeq) &&
        v.lastSeenSeq >= 0
      );
    case "ops":
      return Array.isArray(v.ops) && v.ops.length <= 4096 && v.ops.every(isOp);
    case "presence":
      return isCursorAnchor(v.cursor) && (v.selection === null || isSelectionRange(v.selection));
    default:
      return false;
  }
}

export function isSeqOp(v: unknown): v is SeqOp {
  return isRecord(v) && typeof v.seq === "number" && Number.isInteger(v.seq) && v.seq >= 1 && isOp(v.op);
}

export function isRGASnapshot(v: unknown): v is RGASnapshot {
  if (!isRecord(v)) return false;
  if (typeof v.clock !== "number" || !Array.isArray(v.nodes) || !Array.isArray(v.pending)) {
    return false;
  }
  return (
    v.nodes.every(
      (n: unknown) =>
        isRecord(n) && isNodeId(n.id) && typeof n.value === "string" && typeof n.deleted === "boolean",
    ) && v.pending.every(isOp)
  );
}

export function isServerMessage(v: unknown): v is ServerMessage {
  if (!isRecord(v)) return false;
  switch (v.type) {
    case "ops":
      return Array.isArray(v.ops) && v.ops.every(isSeqOp);
    case "snapshot":
      return typeof v.seq === "number" && v.seq >= 0 && isRGASnapshot(v.snapshot);
    case "presence":
      return (
        typeof v.siteId === "string" &&
        typeof v.name === "string" &&
        typeof v.color === "string" &&
        isCursorAnchor(v.cursor) &&
        (v.selection === null || isSelectionRange(v.selection))
      );
    case "presence-leave":
      return typeof v.siteId === "string";
    case "error":
      return typeof v.message === "string";
    default:
      return false;
  }
}

/** JSON.parse that returns null instead of throwing. */
export function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  const v = tryParseJson(raw);
  return isClientMessage(v) ? v : null;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const v = tryParseJson(raw);
  return isServerMessage(v) ? v : null;
}
