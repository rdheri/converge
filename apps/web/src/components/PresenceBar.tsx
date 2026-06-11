import { useState, useSyncExternalStore } from "react";
import { colorForSite } from "@converge/shared";
import type { DocClient } from "../client/doc-client";

interface PresenceBarProps {
  client: DocClient;
  onNameChange: (name: string) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) ?? "?";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? "") : (parts[0]?.charAt(1) ?? "");
  return (first + second).toUpperCase();
}

/** Stacked avatar circles; click your own to rename. */
export function PresenceBar({ client, onNameChange }: PresenceBarProps) {
  useSyncExternalStore(client.subscribe, client.getVersion);
  const peers = client.peers();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(client.name());
  const ownColor = colorForSite(client.siteId);

  const commitName = (): void => {
    setEditing(false);
    const name = draft.trim();
    if (name !== "" && name !== client.name()) onNameChange(name);
  };

  return (
    <div className="presence-bar">
      <div className="avatar-stack">
        <button
          className="avatar avatar-self"
          style={{ backgroundColor: ownColor }}
          title={`${client.name()} (you) — click to rename`}
          onClick={() => {
            setDraft(client.name());
            setEditing(true);
          }}
        >
          {initials(client.name())}
        </button>
        {peers.map((peer) => (
          <span key={peer.siteId} className="avatar" style={{ backgroundColor: peer.color }} title={peer.name}>
            {initials(peer.name)}
          </span>
        ))}
      </div>
      {editing ? (
        <input
          className="presence-name-input"
          value={draft}
          autoFocus
          maxLength={24}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitName();
            if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <button className="presence-name" onClick={() => setEditing(true)} title="Click to rename">
          {client.name()}
        </button>
      )}
    </div>
  );
}
