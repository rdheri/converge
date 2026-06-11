import { useSyncExternalStore } from "react";
import type { DocClient } from "../client/doc-client";

interface StatusPillProps {
  client: DocClient;
}

export function StatusPill({ client }: StatusPillProps) {
  useSyncExternalStore(client.subscribe, client.getVersion);
  const status = client.status();
  const queued = client.queuedCount();

  const label =
    status === "online"
      ? "online"
      : status === "connecting"
        ? "reconnecting…"
        : queued > 0
          ? `offline — ${queued} edit${queued === 1 ? "" : "s"} queued`
          : "offline";

  return (
    <span className={`status-pill status-${status}`}>
      <span className="status-dot" />
      {label}
    </span>
  );
}
