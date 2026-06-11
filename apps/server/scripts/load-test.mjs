#!/usr/bin/env node
// Load test: K simulated clients hammering one document.
//
//   node scripts/load-test.mjs --clients 50 --rate 5 --duration 15 \
//     --url ws://localhost:8787 [--doc <id>]
//
// Each client keeps its own RGA replica, inserts `rate` random chars/sec
// at random positions, and measures ECHO LATENCY: the time from sending
// an op to receiving it back with a server seq (i.e. validate + apply +
// Postgres write + broadcast). After the run, all replicas must converge
// to the byte-identical document — checked with stateDigest().

import WebSocket from "ws";
import { RGA } from "@converge/crdt";
import { PROTOCOL_VERSION } from "@converge/shared";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const CLIENTS = Number(arg("clients", "25"));
const RATE = Number(arg("rate", "5")); // ops per second per client
const DURATION_S = Number(arg("duration", "15"));
const URL = arg("url", "ws://localhost:8787");
const DOC = arg("doc", `loadtest-${Date.now().toString(36)}`);
const CHARSET = "abcdefghijklmnopqrstuvwxyz ";

const opKey = (op) => `${op.kind}|${op.id.lamport}:${op.id.siteId}`;

class SimClient {
  constructor(index) {
    this.siteId = `lt-${index}-${Math.random().toString(36).slice(2, 8)}`;
    this.rga = new RGA(this.siteId);
    this.inflight = new Map(); // opKey -> sentAt (ms)
    this.latencies = [];
    this.opsSent = 0;
    this.caughtUp = false;
    this.timer = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL);
      this.ws.on("error", reject);
      this.ws.on("open", () => {
        this.ws.send(JSON.stringify({
          type: "hello", protocolVersion: PROTOCOL_VERSION,
          docId: DOC, siteId: this.siteId, name: this.siteId, lastSeenSeq: 0,
        }));
      });
      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "snapshot") {
          this.rga = RGA.fromSnapshot(this.siteId, msg.snapshot);
          return;
        }
        if (msg.type !== "ops") return;
        const now = performance.now();
        for (const { op } of msg.ops) {
          this.rga.apply(op);
          const sentAt = this.inflight.get(opKey(op));
          if (sentAt !== undefined) {
            this.latencies.push(now - sentAt);
            this.inflight.delete(opKey(op));
          }
        }
        if (!this.caughtUp) {
          this.caughtUp = true;
          resolve();
        }
      });
    });
  }

  startTyping() {
    this.timer = setInterval(() => {
      const len = this.rga.visibleLength;
      const index = Math.floor(Math.random() * (len + 1));
      const ch = CHARSET[Math.floor(Math.random() * CHARSET.length)];
      const op = this.rga.localInsert(index, ch);
      this.inflight.set(opKey(op), performance.now());
      this.opsSent += 1;
      this.ws.send(JSON.stringify({ type: "ops", ops: [op] }));
    }, 1000 / RATE);
  }

  stopTyping() {
    if (this.timer !== null) clearInterval(this.timer);
  }

  close() {
    this.ws.close();
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

async function main() {
  console.log(`doc=${DOC} clients=${CLIENTS} rate=${RATE} ops/s/client duration=${DURATION_S}s`);
  console.log(`target: ${URL}\n`);

  const clients = Array.from({ length: CLIENTS }, (_, i) => new SimClient(i));
  const t0 = performance.now();
  await Promise.all(clients.map((c) => c.connect()));
  console.log(`all ${CLIENTS} clients connected + caught up in ${Math.round(performance.now() - t0)}ms`);

  for (const c of clients) c.startTyping();
  await new Promise((r) => setTimeout(r, DURATION_S * 1000));
  for (const c of clients) c.stopTyping();

  // Quiesce: wait until every replica has identical state (or timeout).
  const quiesceStart = performance.now();
  let converged = false;
  while (performance.now() - quiesceStart < 15_000) {
    await new Promise((r) => setTimeout(r, 250));
    const digests = new Set(clients.map((c) => c.rga.stateDigest()));
    const inflight = clients.reduce((n, c) => n + c.inflight.size, 0);
    if (digests.size === 1 && inflight === 0) {
      converged = true;
      break;
    }
  }
  const quiesceMs = Math.round(performance.now() - quiesceStart);
  for (const c of clients) c.close();

  const all = clients.flatMap((c) => c.latencies).sort((a, b) => a - b);
  const totalSent = clients.reduce((n, c) => n + c.opsSent, 0);
  const fmt = (x) => `${x.toFixed(1)}ms`;

  console.log(`\n=== results ===`);
  console.log(`ops sent          ${totalSent} (${(totalSent / DURATION_S).toFixed(0)} ops/sec aggregate)`);
  console.log(`echo latency p50  ${fmt(percentile(all, 50))}`);
  console.log(`echo latency p95  ${fmt(percentile(all, 95))}`);
  console.log(`echo latency p99  ${fmt(percentile(all, 99))}`);
  console.log(`echo latency max  ${fmt(percentile(all, 100))}`);
  console.log(`doc length        ${clients[0].rga.visibleLength} chars`);
  console.log(`quiesce time      ${quiesceMs}ms`);
  console.log(`convergence       ${converged ? "OK — all replicas byte-identical" : "FAILED"}`);
  process.exit(converged ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
