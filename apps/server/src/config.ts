export interface ServerConfig {
  readonly port: number;
  readonly databaseUrl: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const rawPort = env.PORT ?? "8787";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid PORT: ${rawPort}`);
  }
  return { port, databaseUrl: env.DATABASE_URL ?? null };
}
