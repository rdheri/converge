# converge

A real-time collaborative plain-text editor built on a **hand-written RGA
(Replicated Growable Array) sequence CRDT** — no Yjs, no Automerge, no
ShareDB. Multiple people edit the same document in their browsers; edits
merge with zero conflicts and no central lock. Go offline, keep typing,
reconnect — everything merges cleanly. Live cursors and presence show who
else is in the doc.

```
packages/crdt     pure, dependency-free RGA implementation + property tests
packages/shared   wire protocol, message validation, presence helpers
apps/server       Node + ws sync server, Postgres op log + snapshots
apps/web          Vite + React editor (local-first, offline queue, live cursors)
```

TypeScript end-to-end, one pnpm workspace. The `crdt` package is
deliberately isolated and has **zero runtime dependencies**, so it could be
ported to Rust/WASM later without touching the rest of the stack.

## Quickstart

```bash
corepack enable                       # pnpm ships with Node >= 20
pnpm install
pnpm build && pnpm test               # 46 tests, incl. convergence properties

docker compose up -d postgres         # or point DATABASE_URL at any Postgres
cd apps/server
cp .env.example .env                  # set DATABASE_URL if not using compose
pnpm migrate
pnpm dev                              # ws://localhost:8787

# second terminal
cd apps/web && pnpm dev               # http://localhost:5173
```

### Two-minute demo: offline merge

1. Open `http://localhost:5173` in **two tabs**, side by side (the
   default document is `welcome`; pick any other with `?doc=<name>`).
2. Type in either tab — keystrokes appear in the other in ~10ms, with a
   colored caret and name label for each participant.
3. Click **Go offline** in tab A. The status pill flips to *offline*.
4. Edit the **same word** in both tabs. Tab A's pill counts queued edits.
5. Click **Reconnect** in tab A. Both tabs converge to the identical
   document — both sets of edits survive, in a deterministic order, with
   no lost keystrokes and no conflict dialog.

Offline edits even survive a tab reload: the queue is persisted per-tab
and replayed on the next connect.

## The CRDT

### Model

Every character is a node with a globally unique id `(lamport, siteId)`,
totally ordered by lamport then siteId. Two operations:

- **`insert(afterId, id, value)`** — place a node immediately to the right
  of `afterId` (`null` = head of document).
- **`delete(id)`** — tombstone the node. Nodes are never physically
  removed, so concurrent ops can always still reference them.

The visible document is the values of non-tombstoned nodes in list order.
Integration of an insert walks right from `afterId`, skips every node with
a **greater** id, and splices before the first smaller one — so concurrent
siblings of the same parent land in descending id order on every replica.

An op whose dependency hasn't arrived yet (an insert's `afterId`, a
delete's target) is buffered and applied automatically once the dependency
lands ("causal readiness"). All ops are idempotent, so at-least-once
delivery is safe.

### Why identical op-set ⇒ identical document

The convergence argument, in four steps:

1. **Fresh timestamps.** A replica's Lamport clock is `max` of everything
   it has ever seen; local inserts use `clock + 1`. So a node's id is
   strictly greater than the id of every node its author had applied when
   creating it — including its parent and any sibling it knew about.
2. **Deterministic sibling order.** Concurrent inserts after the same
   parent compare by id, a total order. Every replica sorts them
   identically (descending), whatever order they arrived in.
3. **Subtrees stay intact.** Could the integration scan skip past a
   sibling *subtree* and split it? No: if sibling `s` has a greater id
   than incoming node `n`, every descendant of `s` has a lamport greater
   than `s`'s (by step 1, applied transitively), hence an id greater than
   `n`'s — so the scan skips the whole subtree or none of it. And the scan
   stops at the first smaller sibling, before any *smaller* subtree.
4. **Deletes commute.** Tombstoning is monotone (never undone) and
   targets an immutable node, so delete/delete and delete/insert pairs
   commute trivially.

Insert placement therefore depends only on the *set* of ops applied, never
on arrival order; buffering handles missing dependencies; idempotency
handles duplicates. Two replicas with the same op set hold the same node
list — byte-identical documents.

This isn't just argued, it's **tested as a property**
([rga.convergence.property.test.ts](packages/crdt/test/rga.convergence.property.test.ts)):
80 seeded random histories of 3 concurrent replicas editing while only
partially synced, each replayed onto fresh replicas in many shuffled
delivery orders (plus duplicated delivery), asserting identical full state
— order, values, and tombstones, not just visible text. Classic edge cases
(same-index offline inserts, interleaved typing runs, insert-after-deleted,
concurrent same-node deletes) are pinned with exact expected strings.

## Sync protocol

- The server assigns each accepted op a per-document, strictly increasing
  **seq** — a delivery cursor only; it plays no role in CRDT ordering.
  Clients catch up with `hello { lastSeenSeq }`. (Lamport timestamps can't
  do this job: they're not totally ordered across sites, so "everything
  with lamport > X" can miss concurrent ops that reached the server late.)
- The server persists, **then** broadcasts, serialized per room — seq N is
  never observable before N−1 is durable, so `lastSeenSeq` can never skip
  a hole.
- The echo of your own op (with its seq) is the ack. Clients keep ops in a
  persisted **outbox** until acked and replay the outbox on every
  reconnect; the server's RGA dedupes replays and never re-persists or
  re-sequences them. At-least-once delivery in, exactly-once effect out.
- Fresh clients get current state as one **snapshot** message instead of a
  full log replay; the server also persists a snapshot every 500 ops, so a
  cold room load is snapshot + tail.
- Cursors travel as **node ids**, not indices, so remote carets stay
  correct under concurrent edits (and survive the anchor being deleted).

## Persistence

Postgres, schema in
[apps/server/migrations/001_init.sql](apps/server/migrations/001_init.sql):
`documents`, an append-only `operations` log keyed `(doc_id, seq)` (with
lamport/site denormalized for ad-hoc queries), and one `snapshots` row per
doc (`state` jsonb, `up_to_seq`). The log is never pruned. Connection
pooling via `pg.Pool`; `DATABASE_URL` from the environment; without it the
server falls back to an in-memory store for quick demos.

## Load test

```bash
cd apps/server
node scripts/load-test.mjs --clients 100 --rate 5 --duration 15
```

Spins up K WebSocket clients on one doc, each holding a real RGA replica
and inserting at random positions; measures **echo latency** (send → seq'd
broadcast back, i.e. validate + apply + Postgres write + fan-out) and then
asserts all K replicas are byte-identical. On an M-series laptop against
local Postgres:

| clients | aggregate ops/s | p50 | p95 | p99 | converged |
|--------:|----------------:|------:|------:|-------:|:---------:|
| 50      | ~250            | 14ms  | 57ms  | 136ms  | ✓ |
| 100     | ~500            | 7ms   | 60ms  | 75ms   | ✓ |
| 200     | ~950            | 1.4s  | 3.1s  | 3.4s   | ✓ |

The 200-client wall is broadcast fan-out (~190k JSON sends/sec, one
message per op per client); batching broadcasts would push it further.
Convergence holds at every scale.

## Deploy

- **Server → Fly.io**: [apps/server/Dockerfile](apps/server/Dockerfile)
  (multi-stage, repo-root context) + [fly.toml](fly.toml). Migrations run
  as the release command. `fly secrets set DATABASE_URL=...`, `fly deploy`.
- **Web → Vercel**: set the project root to `apps/web`
  ([vercel.json](apps/web/vercel.json) handles the workspace build); set
  `VITE_WS_URL=wss://<your-fly-app>.fly.dev`.

## Development

```bash
pnpm test         # all suites (crdt properties, protocol, server integration, client)
pnpm typecheck    # strict TS everywhere, no `any` in packages/crdt
pnpm lint
```

Known limits, by design: rooms stay resident once loaded (safe eviction
needs join fencing — seq assignment must never split-brain); presence
renders carets but not selection highlights; a single server owns seq
assignment (horizontal scale-out would shard docs across nodes).
