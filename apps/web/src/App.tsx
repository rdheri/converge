import { useEffect, useMemo, useSyncExternalStore } from "react";
import { generateSiteId } from "@converge/shared";
import { DocClient, localStorageOutbox } from "./client/doc-client";
import { Editor } from "./components/Editor";
import { PresenceBar } from "./components/PresenceBar";
import { StatusPill } from "./components/StatusPill";

const WS_URL: string = import.meta.env.VITE_WS_URL ?? "ws://localhost:8787";

function docIdFromUrl(): string {
  return new URLSearchParams(window.location.search).get("doc") ?? "demo";
}

function storedName(): string {
  const existing = localStorage.getItem("converge:name");
  if (existing !== null && existing !== "") return existing;
  const name = `user-${Math.random().toString(36).slice(2, 6)}`;
  localStorage.setItem("converge:name", name);
  return name;
}

/** Stable per-tab id (sessionStorage survives reloads, not new tabs). */
function tabId(): string {
  const existing = sessionStorage.getItem("converge:tab");
  if (existing !== null) return existing;
  const id = Math.random().toString(36).slice(2, 10);
  sessionStorage.setItem("converge:tab", id);
  return id;
}

export function App() {
  const docId = useMemo(docIdFromUrl, []);
  const client = useMemo(
    () =>
      new DocClient({
        url: WS_URL,
        docId,
        // Fresh siteId per page load: lamport clocks restart at 0, so
        // reusing a siteId across sessions could mint colliding ids.
        // Restored outbox ops keep the ids they were minted with.
        siteId: generateSiteId(),
        name: storedName(),
        outboxStore: localStorageOutbox(docId, tabId()),
      }),
    [docId],
  );

  useEffect(() => {
    client.connect();
    return () => client.destroy();
  }, [client]);

  useSyncExternalStore(client.subscribe, client.getVersion);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <h1 className="logo">converge</h1>
          <span className="doc-badge">doc: {docId}</span>
        </div>
        <div className="topbar-right">
          <PresenceBar
            client={client}
            onNameChange={(name) => {
              localStorage.setItem("converge:name", name);
              client.updateName(name);
            }}
          />
          <StatusPill client={client} />
          <button
            className="offline-toggle"
            onClick={() => client.setManualOffline(!client.isManualOffline())}
          >
            {client.isManualOffline() ? "Reconnect" : "Go offline"}
          </button>
        </div>
      </header>
      <main className="main">
        <Editor client={client} />
      </main>
    </div>
  );
}
