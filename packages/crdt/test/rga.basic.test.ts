import { describe, expect, it } from "vitest";
import { RGA, sameNodeId } from "../src/index.js";

describe("RGA basics", () => {
  it("local typing builds the document", () => {
    const doc = new RGA("A");
    doc.localInsertText(0, "hello");
    expect(doc.text()).toBe("hello");
    doc.localInsertText(5, " world");
    expect(doc.text()).toBe("hello world");
    doc.localInsert(0, ">");
    expect(doc.text()).toBe(">hello world");
    expect(doc.visibleLength).toBe(12);
  });

  it("local delete tombstones without removing nodes", () => {
    const doc = new RGA("A");
    doc.localInsertText(0, "abc");
    doc.localDelete(1);
    expect(doc.text()).toBe("ac");
    expect(doc.visibleLength).toBe(2);
    expect(doc.nodeCount).toBe(3); // tombstone retained
  });

  it("localDeleteRange deletes a contiguous run", () => {
    const doc = new RGA("A");
    doc.localInsertText(0, "abcdef");
    const ops = doc.localDeleteRange(1, 3);
    expect(ops).toHaveLength(3);
    expect(doc.text()).toBe("aef");
  });

  it("rejects out-of-bounds local edits", () => {
    const doc = new RGA("A");
    expect(() => doc.localInsert(1, "x")).toThrow(RangeError);
    expect(() => doc.localDelete(0)).toThrow(RangeError);
    expect(() => doc.localInsert(0, "ab")).toThrow();
  });

  it("maps ids to visible indices and back", () => {
    const doc = new RGA("A");
    const ops = doc.localInsertText(0, "abc");
    const idB = ops[1]?.id;
    if (idB === undefined) throw new Error("expected op");
    expect(doc.visibleIndexOf(idB)).toBe(1);
    const atOne = doc.idAtVisibleIndex(1);
    expect(atOne !== null && sameNodeId(atOne, idB)).toBe(true);

    doc.localDelete(0); // delete "a"; "b" is now visible index 0
    expect(doc.visibleIndexOf(idB)).toBe(0);
    expect(doc.visibleIndexOf({ lamport: 999, siteId: "Z" })).toBe(-1);
  });

  it("caretIndexAfter survives tombstoned anchors", () => {
    const doc = new RGA("A");
    const ops = doc.localInsertText(0, "abc");
    const idA = ops[0]?.id;
    const idB = ops[1]?.id;
    if (idA === undefined || idB === undefined) throw new Error("expected ops");

    expect(doc.caretIndexAfter(idB)).toBe(2); // caret after "b"
    doc.localDelete(1); // tombstone "b": caret holds its ground
    expect(doc.caretIndexAfter(idB)).toBe(1);
    expect(doc.caretIndexAfter(idA)).toBe(1);
    expect(doc.caretIndexAfter({ lamport: 999, siteId: "Z" })).toBe(-1);
  });

  it("ops from one replica replay identically on another", () => {
    const a = new RGA("A");
    const ops = [
      ...a.localInsertText(0, "converge"),
      a.localDelete(0),
      ...a.localInsertText(0, "C"),
    ];
    const b = new RGA("B");
    b.applyAll(ops);
    expect(b.text()).toBe("Converge");
    expect(b.stateDigest()).toBe(a.stateDigest());
  });

  it("snapshot round-trips full state including tombstones", () => {
    const a = new RGA("A");
    a.localInsertText(0, "abc");
    a.localDelete(1);
    const restored = RGA.fromSnapshot("B", a.toSnapshot());
    expect(restored.text()).toBe("ac");
    expect(restored.stateDigest()).toBe(a.stateDigest());

    // New local edits on the restored replica use fresh lamports.
    const op = restored.localInsert(0, "z");
    expect(op.id.lamport).toBeGreaterThan(3);
  });

  it("snapshot preserves buffered ops", () => {
    const a = new RGA("A");
    const ops = a.localInsertText(0, "xy");
    const opX = ops[0];
    const opY = ops[1];
    if (opX === undefined || opY === undefined) throw new Error("expected ops");

    const b = new RGA("B");
    b.apply(opY); // depends on opX, which hasn't arrived
    expect(b.pendingOpsCount).toBe(1);

    const restored = RGA.fromSnapshot("C", b.toSnapshot());
    expect(restored.pendingOpsCount).toBe(1);
    restored.apply(opX);
    expect(restored.text()).toBe("xy");
    expect(restored.pendingOpsCount).toBe(0);
  });
});
