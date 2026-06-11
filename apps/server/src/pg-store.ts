import pg from "pg";
import { isOp, isRGASnapshot } from "@converge/shared";
import type { SeqOp } from "@converge/shared";
import type { OpStore, SnapshotRecord } from "./store.js";

export class PgOpStore implements OpStore {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 10,
      idleTimeoutMillis: 30_000,
    });
  }

  async ensureDoc(docId: string): Promise<void> {
    await this.pool.query("INSERT INTO documents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING", [
      docId,
    ]);
  }

  async appendOps(docId: string, ops: readonly SeqOp[]): Promise<void> {
    if (ops.length === 0) return;
    const rows: string[] = [];
    const values: unknown[] = [];
    ops.forEach((s, i) => {
      const base = i * 5;
      rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      values.push(docId, s.seq, s.op.id.lamport, s.op.id.siteId, JSON.stringify(s.op));
    });
    await this.pool.query(
      `INSERT INTO operations (doc_id, seq, lamport, site_id, payload)
       VALUES ${rows.join(", ")}
       ON CONFLICT (doc_id, seq) DO NOTHING`,
      values,
    );
  }

  async loadOps(docId: string, afterSeq: number): Promise<SeqOp[]> {
    const res = await this.pool.query<{ seq: string; payload: unknown }>(
      "SELECT seq, payload FROM operations WHERE doc_id = $1 AND seq > $2 ORDER BY seq ASC",
      [docId, afterSeq],
    );
    return res.rows.map((row) => {
      const op: unknown = row.payload;
      if (!isOp(op)) {
        throw new Error(`corrupt op in log for doc ${docId} at seq ${row.seq}`);
      }
      return { seq: Number(row.seq), op };
    });
  }

  async loadSnapshot(docId: string): Promise<SnapshotRecord | null> {
    const res = await this.pool.query<{ state: unknown; up_to_seq: string }>(
      "SELECT state, up_to_seq FROM snapshots WHERE doc_id = $1",
      [docId],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    if (!isRGASnapshot(row.state)) {
      throw new Error(`corrupt snapshot for doc ${docId}`);
    }
    return { state: row.state, upToSeq: Number(row.up_to_seq) };
  }

  async saveSnapshot(docId: string, record: SnapshotRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshots (doc_id, state, up_to_seq, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (doc_id) DO UPDATE
         SET state = EXCLUDED.state, up_to_seq = EXCLUDED.up_to_seq, updated_at = now()`,
      [docId, JSON.stringify(record.state), record.upToSeq],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
