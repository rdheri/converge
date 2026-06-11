// @converge/crdt — hand-written RGA sequence CRDT.
// Deliberately zero runtime dependencies so this package stays portable
// (e.g. to Rust/WASM).

export { compareNodeIds, nodeIdKey, sameNodeId } from "./types.js";
export type { DeleteOp, InsertOp, NodeId, Op } from "./types.js";
export { RGA } from "./rga.js";
export type { ApplyResult, RGASnapshot, SnapshotNode } from "./rga.js";
