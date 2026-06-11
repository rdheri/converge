import { useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { CursorAnchor } from "@converge/shared";
import type { DocClient } from "../client/doc-client";
import { diffTexts } from "../client/diff";

interface EditorProps {
  client: DocClient;
}

interface AnchoredSelection {
  anchor: CursorAnchor;
  head: CursorAnchor;
}

/**
 * Textarea-based editor. Typing is applied to the local CRDT
 * synchronously (never blocked by the network); remote edits re-render
 * the value while the local caret is restored from CRDT anchors, so it
 * holds position even when concurrent edits land before it.
 *
 * Remote carets are rendered in a metrics-identical overlay: an
 * invisible "ghost" of the text up to each peer's caret position flows
 * a colored caret element to exactly the right spot, including wraps.
 */
export function Editor({ client }: EditorProps) {
  useSyncExternalStore(client.subscribe, client.getVersion);
  const text = client.text();
  const peers = client.peers();

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<AnchoredSelection | null>(null);

  const recordSelection = (): void => {
    const ta = textareaRef.current;
    if (ta === null) return;
    const anchor = client.anchorForCaret(ta.selectionStart);
    const head = client.anchorForCaret(ta.selectionEnd);
    selectionRef.current = { anchor, head };
    client.sendPresence(head, ta.selectionStart === ta.selectionEnd ? null : { anchor, head });
  };

  const handleChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const splice = diffTexts(client.text(), event.currentTarget.value);
    if (splice !== null) {
      client.applyLocalSplice(splice.start, splice.removed, splice.inserted);
    }
    recordSelection();
  };

  const syncScroll = (): void => {
    const ta = textareaRef.current;
    const overlay = overlayRef.current;
    if (ta !== null && overlay !== null) {
      overlay.scrollTop = ta.scrollTop;
      overlay.scrollLeft = ta.scrollLeft;
    }
  };

  // After any document change, put the local caret back where its CRDT
  // anchors say it belongs (remote edits above the caret shift indices).
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    const sel = selectionRef.current;
    if (ta === null || sel === null || document.activeElement !== ta) return;
    const start = client.caretForAnchor(sel.anchor);
    const end = client.caretForAnchor(sel.head);
    if (start < 0 || end < 0) return;
    if (ta.selectionStart !== start || ta.selectionEnd !== end) {
      ta.setSelectionRange(start, end);
    }
  });

  return (
    <div className="editor-shell">
      <textarea
        ref={textareaRef}
        className="editor-input"
        value={text}
        onChange={handleChange}
        onSelect={recordSelection}
        onScroll={syncScroll}
        placeholder="Start typing — open this URL in another tab to collaborate…"
        spellCheck={false}
        autoFocus
      />
      <div className="editor-overlay" ref={overlayRef} aria-hidden="true">
        {peers.map((peer) => {
          const caret = client.caretForAnchor(peer.cursor);
          if (caret < 0) return null; // anchor not known here yet
          return (
            <div key={peer.siteId} className="peer-layer">
              <span className="peer-ghost">{text.slice(0, caret)}</span>
              <span className="peer-marker">
                <span className="peer-caret" style={{ backgroundColor: peer.color }} />
                <span className="peer-label" style={{ backgroundColor: peer.color }}>
                  {peer.name}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
