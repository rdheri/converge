import { describe, expect, it } from "vitest";
import { RGA } from "../src/index.js";
import type { Op } from "../src/index.js";

/** Two replicas that already agree on a base document. */
function syncedPair(base: string): { a: RGA; b: RGA } {
  const a = new RGA("A");
  const ops = a.localInsertText(0, base);
  const b = new RGA("B");
  b.applyAll(ops);
  return { a, b };
}

describe("RGA classic edge cases", () => {
  it("two users insert at the same index offline, then merge identically", () => {
    const { a, b } = syncedPair("ab");

    // Both offline: each inserts at visible index 1.
    const opA = a.localInsert(1, "X"); // id (3, A)
    const opB = b.localInsert(1, "Y"); // id (3, B)
    expect(a.text()).toBe("aXb");
    expect(b.text()).toBe("aYb");

    // Reconnect: cross-deliver.
    a.apply(opB);
    b.apply(opA);

    // Concurrent siblings of "a" sort by id descending: (3,B) before (3,A).
    expect(a.text()).toBe("aYXb");
    expect(b.text()).toBe("aYXb");
    expect(a.stateDigest()).toBe(b.stateDigest());
  });

  it("interleaved typing runs do not shuffle into each other", () => {
    const a = new RGA("A");
    const b = new RGA("B");
    const opsA = a.localInsertText(0, "111");
    const opsB = b.localInsertText(0, "222");

    a.applyAll(opsB);
    b.applyAll(opsA);

    // Each run stays contiguous; B's head char wins the tiebreak at the root.
    expect(a.text()).toBe("222111");
    expect(b.text()).toBe("222111");
    expect(a.stateDigest()).toBe(b.stateDigest());
  });

  it("insert after a node that was concurrently deleted", () => {
    const { a, b } = syncedPair("abc");

    const del = a.localDelete(1); // A tombstones "b"
    const ins = b.localInsert(2, "X"); // B inserts after "b" (anchor is b's id)

    a.apply(ins); // anchor "b" is a tombstone here — must still work
    b.apply(del);

    expect(a.text()).toBe("aXc");
    expect(b.text()).toBe("aXc");
    expect(a.stateDigest()).toBe(b.stateDigest());
  });

  it("concurrent delete of the same node is idempotent", () => {
    const { a, b } = syncedPair("abc");

    const delA = a.localDelete(1);
    const delB = b.localDelete(1); // same target node

    expect(a.apply(delB)).toBe("duplicate");
    expect(b.apply(delA)).toBe("duplicate");
    expect(a.text()).toBe("ac");
    expect(b.text()).toBe("ac");
    expect(a.stateDigest()).toBe(b.stateDigest());
  });

  it("buffers an insert until its afterId arrives (causal readiness)", () => {
    const a = new RGA("A");
    const ops = a.localInsertText(0, "12");
    const first = ops[0];
    const second = ops[1];
    if (first === undefined || second === undefined) throw new Error("expected ops");

    const c = new RGA("C");
    expect(c.apply(second)).toBe("buffered"); // depends on first
    expect(c.apply(second)).toBe("duplicate"); // re-buffering is detected
    expect(c.text()).toBe("");
    expect(c.pendingOpsCount).toBe(1);

    expect(c.apply(first)).toBe("applied"); // drains the buffer
    expect(c.text()).toBe("12");
    expect(c.pendingOpsCount).toBe(0);
  });

  it("buffers a delete that arrives before its target insert", () => {
    const a = new RGA("A");
    const ins = a.localInsert(0, "x");
    const del = a.localDelete(0);

    const c = new RGA("C");
    expect(c.apply(del)).toBe("buffered");
    expect(c.apply(ins)).toBe("applied"); // insert lands, buffered delete fires
    expect(c.text()).toBe("");
    expect(c.nodeCount).toBe(1); // tombstone present
    expect(c.pendingOpsCount).toBe(0);
  });

  it("drains long dependency chains delivered in reverse", () => {
    const a = new RGA("A");
    const ops: Op[] = a.localInsertText(0, "abcdefghij");

    const c = new RGA("C");
    for (const op of [...ops].reverse()) c.apply(op);
    expect(c.text()).toBe("abcdefghij");
    expect(c.pendingOpsCount).toBe(0);
    expect(c.stateDigest()).toBe(a.stateDigest());
  });

  it("duplicate delivery never changes state", () => {
    const { a, b } = syncedPair("hi");
    const op = a.localInsert(2, "!");
    b.apply(op);
    const digest = b.stateDigest();

    expect(b.apply(op)).toBe("duplicate");
    b.apply(op);
    expect(b.stateDigest()).toBe(digest);
    expect(b.text()).toBe("hi!");
  });
});
