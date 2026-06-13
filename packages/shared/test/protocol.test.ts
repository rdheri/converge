import { describe, expect, it } from "vitest";
import { RGA } from "@converge/crdt";
import {
  colorForSite,
  generateSiteId,
  isRGASnapshot,
  parseClientMessage,
  parseServerMessage,
} from "../src/index.js";
import type { ClientMessage, ServerMessage } from "../src/index.js";

const id = (lamport: number, siteId: string) => ({ lamport, siteId });

describe("client message validation", () => {
  it("accepts a well-formed hello", () => {
    const msg: ClientMessage = {
      type: "hello",
      protocolVersion: 1,
      docId: "doc-1",
      siteId: "site-a",
      name: "Raghav",
      lastSeenSeq: 0,
    };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it("accepts ops batches and presence", () => {
    const ops: ClientMessage = {
      type: "ops",
      ops: [
        { kind: "insert", id: id(1, "a"), afterId: null, value: "x" },
        { kind: "insert", id: id(2, "a"), afterId: id(1, "a"), value: "y" },
        { kind: "delete", id: id(1, "a") },
      ],
    };
    expect(parseClientMessage(JSON.stringify(ops))).toEqual(ops);

    const presence: ClientMessage = {
      type: "presence",
      cursor: id(2, "a"),
      selection: { anchor: null, head: id(2, "a") },
    };
    expect(parseClientMessage(JSON.stringify(presence))).toEqual(presence);
  });

  it("rejects malformed payloads", () => {
    const bad = [
      "not json{",
      "null",
      "42",
      JSON.stringify({ type: "nope" }),
      JSON.stringify({ type: "hello", docId: "", siteId: "s", name: "", lastSeenSeq: 0, protocolVersion: 1 }),
      JSON.stringify({ type: "hello", docId: "d", siteId: "s", name: "n", lastSeenSeq: -1, protocolVersion: 1 }),
      // insert with multi-char value
      JSON.stringify({ type: "ops", ops: [{ kind: "insert", id: id(1, "a"), afterId: null, value: "ab" }] }),
      // insert missing afterId entirely
      JSON.stringify({ type: "ops", ops: [{ kind: "insert", id: id(1, "a"), value: "a" }] }),
      // lamport 0 is invalid (clock starts at 1)
      JSON.stringify({ type: "ops", ops: [{ kind: "delete", id: id(0, "a") }] }),
      // non-integer lamport
      JSON.stringify({ type: "ops", ops: [{ kind: "delete", id: { lamport: 1.5, siteId: "a" } }] }),
    ];
    for (const raw of bad) {
      expect(parseClientMessage(raw), raw).toBeNull();
    }
  });
});

describe("server message validation", () => {
  it("round-trips ops, presence, and errors", () => {
    const msgs: ServerMessage[] = [
      { type: "ops", ops: [{ seq: 1, op: { kind: "insert", id: id(1, "a"), afterId: null, value: "x" } }] },
      { type: "presence", siteId: "s", name: "N", color: "#268bd2", cursor: null, selection: null },
      { type: "presence-leave", siteId: "s" },
      { type: "error", message: "boom" },
    ];
    for (const msg of msgs) {
      expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
    }
  });

  it("validates a real RGA snapshot end-to-end", () => {
    const doc = new RGA("site-a");
    doc.localInsertText(0, "hello");
    doc.localDelete(4);
    const snapshot = doc.toSnapshot();
    expect(isRGASnapshot(snapshot)).toBe(true);

    const msg: ServerMessage = { type: "snapshot", seq: 6, snapshot };
    const parsed = parseServerMessage(JSON.stringify(msg));
    expect(parsed).toEqual(msg);
    if (parsed === null || parsed.type !== "snapshot") throw new Error("expected snapshot");
    expect(RGA.fromSnapshot("site-b", parsed.snapshot).text()).toBe("hell");
  });

  it("rejects garbage", () => {
    expect(parseServerMessage(JSON.stringify({ type: "ops", ops: [{ seq: 0, op: null }] }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "snapshot", seq: 1, snapshot: {} }))).toBeNull();
  });

  it("round-trips emoji ops (lone surrogates) through JSON text", () => {
    // The CRDT is granular to UTF-16 code units, so "👋" becomes two
    // nodes each holding one surrogate. A lone surrogate is invalid in
    // Postgres jsonb but fine in a JS string and in escaped JSON text —
    // which is exactly why the op log is stored as text. This guards
    // that path: the ops must survive serialize -> validate -> apply.
    const doc = new RGA("site-a");
    const ops = doc.localInsertText(0, "hi 👋");
    expect(ops).toHaveLength(5); // h, i, space, high surrogate, low surrogate

    const wire: ServerMessage = {
      type: "ops",
      ops: ops.map((op, i) => ({ seq: i + 1, op })),
    };
    // JSON.stringify must produce well-formed JSON even for lone
    // surrogates (escaped as \udXXX), and parse back identically.
    const parsed = parseServerMessage(JSON.stringify(wire));
    expect(parsed).toEqual(wire);
    if (parsed === null || parsed.type !== "ops") throw new Error("expected ops");

    const replica = new RGA("site-b");
    for (const { op } of parsed.ops) replica.apply(op);
    expect(replica.text()).toBe("hi 👋");
  });
});

describe("presence helpers", () => {
  it("colorForSite is deterministic and from the palette", () => {
    const c1 = colorForSite("some-site");
    expect(colorForSite("some-site")).toBe(c1);
    expect(c1).toMatch(/^#[0-9a-f]{6}$/);
    expect(colorForSite("another-site")).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("generateSiteId produces distinct, non-empty ids", () => {
    const a = generateSiteId();
    const b = generateSiteId();
    expect(a.length).toBeGreaterThan(8);
    expect(a).not.toBe(b);
  });
});
