import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { generateSiteId } from "@converge/shared";
import { DocClient, localStorageOutbox } from "./client/doc-client";
import { Editor } from "./components/Editor";
import { PresenceBar } from "./components/PresenceBar";
import { StatusPill } from "./components/StatusPill";

const WS_URL: string = import.meta.env.VITE_WS_URL ?? "ws://localhost:8787";

function docIdFromUrl(): string {
  return new URLSearchParams(window.location.search).get("doc") ?? "welcome";
}

/**
 * Display name is per-tab (sessionStorage survives refreshes but is not
 * shared between tabs), with localStorage only seeding NEW tabs. Keeping
 * it in localStorage alone made every tab adopt the last rename on
 * refresh — two "users" in one browser kept clobbering each other.
 */
function storedName(): string {
  const own = sessionStorage.getItem("converge:name");
  if (own !== null && own !== "") return own;
  const fallback = localStorage.getItem("converge:name");
  const name = fallback !== null && fallback !== "" ? fallback : `user-${Math.random().toString(36).slice(2, 6)}`;
  sessionStorage.setItem("converge:name", name);
  localStorage.setItem("converge:name", name);
  return name;
}

function saveName(name: string): void {
  sessionStorage.setItem("converge:name", name); // this tab, authoritative
  localStorage.setItem("converge:name", name); // default for future tabs
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

  useEffect(() => {
    document.title = `${docId} · converge`;
  }, [docId]);

  useSyncExternalStore(client.subscribe, client.getVersion);

  const [copied, setCopied] = useState(false);
  const shareLink = (): void => {
    const url = `${window.location.origin}${window.location.pathname}?doc=${encodeURIComponent(docId)}`;
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  };

  const charCount = client.text().length;
  const peerCount = client.peers().length + 1;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <span className="logo-mark" aria-hidden="true" />
          <h1 className="logo">converge</h1>
          <span className="doc-badge" title="Document id — change with ?doc= in the URL">
            {docId}
          </span>
        </div>
        <div className="topbar-right">
          <PresenceBar
            client={client}
            onNameChange={(name) => {
              saveName(name);
              client.updateName(name);
            }}
          />
          <StatusPill client={client} />
          <button className={`btn share-btn${copied ? " is-copied" : ""}`} onClick={shareLink}>
            {copied ? "Copied ✓" : "Share"}
          </button>
          <button
            className="btn offline-toggle"
            onClick={() => client.setManualOffline(!client.isManualOffline())}
            title="Simulate going offline — edits queue locally and merge on reconnect"
          >
            {client.isManualOffline() ? "Reconnect" : "Go offline"}
          </button>
        </div>
      </header>
      <main className="main">
        <Editor client={client} />
      </main>
      <footer className="statusbar">
        <span>
          {charCount.toLocaleString()} character{charCount === 1 ? "" : "s"}
        </span>
        <span className="statusbar-divider" />
        <span>
          {peerCount} editor{peerCount === 1 ? "" : "s"} in doc
        </span>
        <span className="statusbar-spacer" />
        <span className="statusbar-hint">
          conflict-free merges via a hand-written RGA CRDT — try two tabs
        </span>
      </footer>
    </div>
  );
}
