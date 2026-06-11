import { loadConfig } from "./config.js";
import { PgOpStore } from "./pg-store.js";
import { MemoryOpStore } from "./store.js";
import type { OpStore } from "./store.js";
import { startSyncServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  let store: OpStore;
  if (config.databaseUrl !== null) {
    store = new PgOpStore(config.databaseUrl);
  } else {
    console.warn(
      "[server] DATABASE_URL not set — using in-memory op store; all documents are lost on restart",
    );
    store = new MemoryOpStore();
  }

  const server = await startSyncServer({ store, port: config.port });
  console.log(`[server] converge sync server listening on :${server.port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received, shutting down`);
    await server.close();
    await store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[server] fatal:", err);
  process.exit(1);
});
