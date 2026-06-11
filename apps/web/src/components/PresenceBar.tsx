import { useState, useSyncExternalStore } from "react";
import { colorForSite } from "@converge/shared";
import type { DocClient } from "../client/doc-client";

interface PresenceBarProps {
  client: DocClient;
  onNameChange: (name: string) => void;
}

export function PresenceBar({ client, onNameChange }: PresenceBarProps) {
  useSyncExternalStore(client.subscribe, client.getVersion);
  const peers = client.peers();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(client.name());

  const commitName = (): void => {
    setEditing(false);
    const name = draft.trim();
    if (name !== "" && name !== client.name()) onNameChange(name);
  };

  return (
    <div className="presence-bar">
      <span className="presence-chip" style={{ borderColor: colorForSite(client.siteId) }}>
        <span className="presence-dot" style={{ backgroundColor: colorForSite(client.siteId) }} />
        {editing ? (
          <input
            className="presence-name-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <button className="presence-name" onClick={() => setEditing(true)} title="Click to rename">
            {client.name()} (you)
          </button>
        )}
      </span>
      {peers.map((peer) => (
        <span key={peer.siteId} className="presence-chip" style={{ borderColor: peer.color }}>
          <span className="presence-dot" style={{ backgroundColor: peer.color }} />
          {peer.name}
        </span>
      ))}
    </div>
  );
}
