"use client";

import { useEffect, useRef, useState } from "react";
import { PlainTextRoom, IndexedDBStorage, webSocketConnection } from "@birga/client";
import { wsUrl } from "@/lib/config";
import { getIdentity, newReplicaId, type Identity } from "@/lib/identity";
import { PresenceBar, type Peer } from "./PresenceBar";

interface RemoteCursor {
  user: Identity;
  cursor: number;
}

/**
 * Plain-text collaborative editor driven by the **from-scratch `@birga/crdt`**
 * through `PlainTextRoom`. This is the surface that proves the hand-written CRDT
 * runs live: every keystroke is an RGA op synced over the Birga protocol.
 */
export function PlainTextEditor({ docId }: { docId: string }) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const roomRef = useRef<PlainTextRoom | null>(null);
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    const identity = getIdentity();
    const room = new PlainTextRoom({
      docId,
      replica: newReplicaId(),
      connect: () => webSocketConnection(wsUrl()),
      storage: new IndexedDBStorage(),
    });
    roomRef.current = room;

    const offChange = room.on("change", (text) => {
      const ta = taRef.current;
      if (!ta || ta.value === text) return;
      // Remote edit: replace value, best-effort caret preservation.
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = text;
      ta.setSelectionRange(start, end);
    });

    const offPresence = room.on("presence", (presence) => {
      const list: Peer[] = [];
      for (const [replica, state] of presence) {
        const s = state as RemoteCursor | undefined;
        if (s?.user) list.push({ id: replica, user: s.user });
      }
      setPeers(list);
    });

    const offStatus = room.on("status", setConnected);

    void room.ready().then(() => {
      if (taRef.current) taRef.current.value = room.text;
      room.connect();
    });

    // Broadcast our cursor as awareness.
    const broadcast = (): void => {
      const ta = taRef.current;
      if (ta) room.setAwareness({ user: identity, cursor: ta.selectionStart });
    };
    const ta = taRef.current;
    ta?.addEventListener("keyup", broadcast);
    ta?.addEventListener("click", broadcast);

    return () => {
      offChange();
      offPresence();
      offStatus();
      ta?.removeEventListener("keyup", broadcast);
      ta?.removeEventListener("click", broadcast);
      room.disconnect();
      roomRef.current = null;
    };
  }, [docId]);

  const onInput = (e: React.FormEvent<HTMLTextAreaElement>): void => {
    roomRef.current?.setText(e.currentTarget.value);
  };

  return (
    <div className="flex flex-col gap-3">
      <PresenceBar connected={connected} peers={peers} />
      <textarea
        ref={taRef}
        onInput={onInput}
        spellCheck={false}
        placeholder="Start typing — every character is an RGA op…"
        className="min-h-[60vh] w-full resize-none rounded-lg border border-slate-300 bg-white p-4 font-mono text-sm leading-relaxed text-slate-900 shadow-sm outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      />
      <p className="text-xs text-slate-500">
        This pane is bound to the hand-written CRDT (<code>@birga/crdt</code>). Open the same URL in
        another window and edit simultaneously — offline too.
      </p>
    </div>
  );
}
