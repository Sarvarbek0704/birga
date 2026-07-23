"use client";

import { useEffect, useMemo, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import { BirgaYjsProvider } from "@/lib/birga-yjs-provider";
import { wsUrl } from "@/lib/config";
import { getIdentity } from "@/lib/identity";

/**
 * Rich-text collaborative editor on the **production path**: TipTap/ProseMirror
 * bound to a Yjs document, synced through {@link BirgaYjsProvider} over the same
 * Birga server. Uses a mature CRDT (Yjs) so rich text is reliable; the
 * from-scratch CRDT drives the plain-text pane instead.
 */
export function RichTextEditor({ docId }: { docId: string }) {
  const identity = useMemo(() => getIdentity(), []);
  const ydoc = useMemo(() => new Y.Doc(), [docId]);
  const [provider, setProvider] = useState<BirgaYjsProvider | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const persistence = new IndexeddbPersistence(`birga:rich:${docId}`, ydoc);
    const p = new BirgaYjsProvider({ url: wsUrl(), docId, doc: ydoc, user: identity });
    const off = p.onStatus(setConnected);
    setProvider(p);
    return () => {
      off();
      p.destroy();
      void persistence.destroy();
      ydoc.destroy();
      setProvider(null);
    };
  }, [docId, ydoc, identity]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        StarterKit.configure({ history: false }), // history comes from Yjs
        Collaboration.configure({ document: ydoc }),
        ...(provider
          ? [CollaborationCursor.configure({ provider, user: identity })]
          : []),
      ],
      editorProps: {
        attributes: {
          class:
            "min-h-[60vh] w-full rounded-lg border border-slate-300 bg-white p-4 text-slate-900 shadow-sm outline-none focus:border-slate-400 prose-birga dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100",
        },
      },
    },
    [provider],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-sm">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            connected ? "bg-green-500" : "bg-slate-400"
          }`}
          aria-hidden
        />
        <span className="text-slate-600 dark:text-slate-400">
          {connected ? "Connected" : "Offline"}
        </span>
      </div>
      <EditorContent editor={editor} />
      <p className="text-xs text-slate-500">
        This pane runs on Yjs + TipTap, synced over the same Birga server via a custom provider.
        Live cursors show collaborators; edits persist offline in IndexedDB.
      </p>
    </div>
  );
}
