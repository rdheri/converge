// @converge/shared — wire protocol and presence types shared by the
// sync server and the web client. CRDT types re-exported for convenience.

export type { DeleteOp, InsertOp, NodeId, Op, RGASnapshot, SnapshotNode } from "@converge/crdt";

export {
  PROTOCOL_VERSION,
  isClientMessage,
  isNodeId,
  isOp,
  isRGASnapshot,
  isSeqOp,
  isServerMessage,
  parseClientMessage,
  parseServerMessage,
  tryParseJson,
} from "./protocol.js";
export type {
  ClientMessage,
  ClientOpsMessage,
  ClientPresenceMessage,
  CursorAnchor,
  HelloMessage,
  SelectionRange,
  SeqOp,
  ServerErrorMessage,
  ServerMessage,
  ServerOpsMessage,
  ServerPresenceLeaveMessage,
  ServerPresenceMessage,
  ServerSnapshotMessage,
} from "./protocol.js";

export { colorForSite, generateSiteId } from "./presence.js";
