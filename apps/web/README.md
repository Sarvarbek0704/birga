# @birga/web

The Birga editor — a Next.js app with **two collaborative modes per document**:

- **Plain text** — bound to the from-scratch [`@birga/crdt`](../../packages/crdt)
  through [`@birga/client`](../../packages/client)'s `PlainTextRoom`. Every
  keystroke is an RGA op synced over the Birga protocol. This is the surface that
  proves the hand-written CRDT runs live.
- **Rich text** — TipTap/ProseMirror on **Yjs**, synced over the *same* server
  via [`BirgaYjsProvider`](lib/birga-yjs-provider.ts), which base64-tunnels Yjs
  updates and awareness through the CRDT-agnostic protocol.

Both modes have **live presence** (cursors/labels) and are **offline-first**
(IndexedDB persistence; edit offline, converge on reconnect).

## Run it

Start the sync server, then the app:

```bash
# terminal 1 — sync server
pnpm --filter @birga/server dev

# terminal 2 — build the workspace libs once, then the web app
pnpm --filter @birga/crdt --filter @birga/protocol --filter @birga/client build
pnpm --filter @birga/web dev
```

Open http://localhost:3000, create a doc, and open the same URL in a second
window. Type in both — including with one window offline (DevTools ▸ Network ▸
Offline) — and watch them converge on reconnect.

Point at a different server with `NEXT_PUBLIC_BIRGA_WS` (see `.env.example`).

## Layout

- [`app/page.tsx`](app/page.tsx) — open/create a document.
- [`app/doc/[id]/page.tsx`](app/doc/%5Bid%5D/page.tsx) — editor with a plain/rich toggle.
- [`components/PlainTextEditor.tsx`](components/PlainTextEditor.tsx) — `@birga/crdt` surface.
- [`components/RichTextEditor.tsx`](components/RichTextEditor.tsx) — TipTap + Yjs surface.
- [`lib/birga-yjs-provider.ts`](lib/birga-yjs-provider.ts) — Yjs ⇆ Birga protocol bridge.
