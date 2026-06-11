import { RGA } from "../src/index.js";
import type { Op } from "../src/index.js";

/** Deterministic PRNG so every failure is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(input: readonly T[], rand: () => number): T[] {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const a = arr[i];
    const b = arr[j];
    if (a === undefined || b === undefined) throw new Error("unreachable");
    arr[i] = b;
    arr[j] = a;
  }
  return arr;
}

const CHARSET = "abcdefghijXYZ012 ";

export interface HistoryOptions {
  readonly sites: readonly string[];
  readonly rounds: number;
  readonly maxOpsPerRound: number;
  /** Probability an undelivered op reaches a given replica between rounds. */
  readonly gossipProbability: number;
}

export interface HistoryResult {
  /** Every op generated, in generation order. */
  readonly ops: Op[];
  /** The replicas that generated the history, after full delivery. */
  readonly replicas: RGA[];
}

/**
 * Simulate `sites.length` replicas concurrently editing one document.
 * Each round every replica generates local ops, then receives a random
 * subset of everyone's ops in random order (creating real concurrency
 * and causal depth). Finally every op is delivered everywhere.
 */
export function randomConcurrentHistory(seed: number, opts: HistoryOptions): HistoryResult {
  const rand = mulberry32(seed);
  const peers = opts.sites.map((siteId) => ({
    replica: new RGA(siteId),
    seen: new Set<number>(), // indices into allOps
  }));
  const allOps: Op[] = [];

  for (let round = 0; round < opts.rounds; round++) {
    for (const peer of peers) {
      const nOps = 1 + Math.floor(rand() * opts.maxOpsPerRound);
      for (let k = 0; k < nOps; k++) {
        const len = peer.replica.visibleLength;
        const doInsert = len === 0 || rand() < 0.7;
        let op: Op;
        if (doInsert) {
          const index = Math.floor(rand() * (len + 1));
          const ch = CHARSET.charAt(Math.floor(rand() * CHARSET.length));
          op = peer.replica.localInsert(index, ch);
        } else {
          op = peer.replica.localDelete(Math.floor(rand() * len));
        }
        peer.seen.add(allOps.length);
        allOps.push(op);
      }
    }

    for (const peer of peers) {
      const undelivered: number[] = [];
      for (let i = 0; i < allOps.length; i++) {
        if (!peer.seen.has(i) && rand() < opts.gossipProbability) undelivered.push(i);
      }
      for (const i of shuffle(undelivered, rand)) {
        const op = allOps[i];
        if (op === undefined) throw new Error("unreachable");
        peer.replica.apply(op);
        peer.seen.add(i);
      }
    }
  }

  // Full delivery: every replica ends up with the complete op set.
  for (const peer of peers) {
    const rest: number[] = [];
    for (let i = 0; i < allOps.length; i++) {
      if (!peer.seen.has(i)) rest.push(i);
    }
    for (const i of shuffle(rest, rand)) {
      const op = allOps[i];
      if (op === undefined) throw new Error("unreachable");
      peer.replica.apply(op);
    }
  }

  return { ops: allOps, replicas: peers.map((p) => p.replica) };
}
