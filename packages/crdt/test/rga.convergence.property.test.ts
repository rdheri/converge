import { describe, expect, it } from "vitest";
import { RGA } from "../src/index.js";
import { mulberry32, randomConcurrentHistory, shuffle } from "./helpers.js";

/**
 * The convergence guarantee, tested as a property: any two replicas that
 * applied the same SET of ops produce byte-identical documents, no matter
 * the delivery ORDER. Histories are generated with real concurrency
 * (replicas edit while only partially synced), then replayed onto fresh
 * replicas in many shuffled orders.
 */
describe("property: convergence", () => {
  it("80 random concurrent histories converge under shuffled delivery", () => {
    for (let seed = 1; seed <= 80; seed++) {
      const { ops, replicas } = randomConcurrentHistory(seed, {
        sites: ["A", "B", "C"],
        rounds: 3,
        maxOpsPerRound: 3,
        gossipProbability: 0.5,
      });

      const reference = replicas[0];
      if (reference === undefined) throw new Error("unreachable");
      const expectedText = reference.text();
      const expectedDigest = reference.stateDigest();

      // The generator replicas themselves must agree.
      for (const r of replicas) {
        expect(r.pendingOpsCount, `seed=${seed}`).toBe(0);
        expect(r.text(), `seed=${seed}`).toBe(expectedText);
        expect(r.stateDigest(), `seed=${seed}`).toBe(expectedDigest);
      }

      // Fresh replicas receiving the same op set in arbitrary orders
      // must produce the identical document.
      const rand = mulberry32(seed * 7919);
      for (let s = 0; s < 5; s++) {
        const replica = new RGA(`fresh-${s}`);
        replica.applyAll(shuffle(ops, rand));
        expect(replica.pendingOpsCount, `seed=${seed} shuffle=${s}`).toBe(0);
        expect(replica.text(), `seed=${seed} shuffle=${s}`).toBe(expectedText);
        expect(replica.stateDigest(), `seed=${seed} shuffle=${s}`).toBe(expectedDigest);
      }
    }
  });

  it("soak: 5 replicas, hundreds of ops, 10 shuffled replays", () => {
    const seed = 424242;
    const { ops, replicas } = randomConcurrentHistory(seed, {
      sites: ["A", "B", "C", "D", "E"],
      rounds: 10,
      maxOpsPerRound: 6,
      gossipProbability: 0.35,
    });
    expect(ops.length).toBeGreaterThan(150);

    const reference = replicas[0];
    if (reference === undefined) throw new Error("unreachable");
    const expectedText = reference.text();
    const expectedDigest = reference.stateDigest();
    for (const r of replicas) {
      expect(r.stateDigest()).toBe(expectedDigest);
    }

    const rand = mulberry32(seed);
    for (let s = 0; s < 10; s++) {
      const replica = new RGA(`fresh-${s}`);
      replica.applyAll(shuffle(ops, rand));
      expect(replica.pendingOpsCount, `shuffle=${s}`).toBe(0);
      expect(replica.text(), `shuffle=${s}`).toBe(expectedText);
      expect(replica.stateDigest(), `shuffle=${s}`).toBe(expectedDigest);
    }
  });

  it("duplicated and re-shuffled delivery (at-least-once) still converges", () => {
    const seed = 1337;
    const { ops, replicas } = randomConcurrentHistory(seed, {
      sites: ["A", "B", "C"],
      rounds: 4,
      maxOpsPerRound: 4,
      gossipProbability: 0.5,
    });
    const reference = replicas[0];
    if (reference === undefined) throw new Error("unreachable");

    const rand = mulberry32(seed);
    const replica = new RGA("dup");
    // Deliver the whole op set three times, shuffled differently each time.
    for (let pass = 0; pass < 3; pass++) {
      replica.applyAll(shuffle(ops, rand));
    }
    expect(replica.pendingOpsCount).toBe(0);
    expect(replica.text()).toBe(reference.text());
    expect(replica.stateDigest()).toBe(reference.stateDigest());
  });
});
