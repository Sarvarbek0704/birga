import { RGA } from "@birga/crdt";
import * as Y from "yjs";
import { prosemirrorToYDoc } from "y-prosemirror";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { DocStore } from "./store.js";
import { DocumentsRepo, type Role } from "./documents.js";
import { signUser } from "./auth.js";
import { DEMO_USERS } from "./demo-users.js";

/**
 * Demo data so a first-time visitor sees a populated, working app: three users
 * with a realistic spread of owner/editor/viewer roles, and documents that
 * already have content in both editing modes (plain-text on `@birga/crdt`,
 * rich-text on Yjs). Safe to re-run — everything is upserted.
 */

export { DEMO_USERS } from "./demo-users.js";
export type { DemoUser } from "./demo-users.js";

type PMContent = Array<Record<string, unknown>>;

interface DemoDoc {
  id: string;
  title: string;
  owner: string;
  shares: Array<[userId: string, role: Exclude<Role, "owner">]>;
  plain: string;
  rich: PMContent;
}

const p = (text: string): Record<string, unknown> => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});
const h = (level: number, text: string): Record<string, unknown> => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});
const bullets = (...items: string[]): Record<string, unknown> => ({
  type: "bulletList",
  content: items.map((t) => ({
    type: "listItem",
    content: [{ type: "paragraph", content: [{ type: "text", text: t }] }],
  })),
});

export const DEMO_DOCS: DemoDoc[] = [
  {
    id: "welcome",
    title: "👋 Welcome to Birga",
    owner: "demo-ada",
    shares: [
      ["demo-ben", "editor"],
      ["demo-carol", "viewer"],
    ],
    plain: [
      "Welcome to Birga — many people, one document, no conflicts.",
      "",
      "Open this same URL in a second window and type in both at once. Pull one",
      "window offline (DevTools ▸ Network ▸ Offline), keep typing, reconnect —",
      "and both windows converge to the identical text. Every time.",
      "",
      "This pane is driven by a CRDT written from scratch (@birga/crdt). Each",
      "keystroke is an operation with a globally-unique id; the merge logic is",
      "owned, not imported. Switch to Rich mode to see the Yjs-backed editor.",
    ].join("\n"),
    rich: [
      h(1, "Welcome to Birga"),
      p("Many people, one document, no conflicts — even offline."),
      h(2, "Try it"),
      bullets(
        "Open this URL in two windows and type in both at once.",
        "Take one window offline, keep editing, then reconnect.",
        "Watch live cursors and presence as collaborators join.",
      ),
      p("The plain-text mode runs on a hand-written CRDT; this rich-text mode runs on Yjs."),
    ],
  },
  {
    id: "crdt-notes",
    title: "How the CRDT converges",
    owner: "demo-ada",
    shares: [["demo-ben", "viewer"]],
    plain: [
      "Why concurrent edits never conflict",
      "==================================",
      "",
      "Every character is a node with a unique id (replica, counter) and a parent",
      "— the character it was typed after. The document is a depth-first walk of",
      "that tree, siblings ordered by id (descending), tombstoned nodes skipped.",
      "",
      "The whole state is three order-insensitive structures: a set of nodes, each",
      "parent's children kept sorted, and a set of tombstones. Apply the same ops",
      "in any order, on any replica, and you get byte-identical text.",
      "",
      "The property tests prove it over thousands of randomised interleavings.",
    ].join("\n"),
    rich: [
      h(1, "How the CRDT converges"),
      p("A short tour of the from-scratch sequence CRDT that powers plain-text mode."),
      bullets(
        "Every character has a stable, globally-unique id.",
        "Deletes are tombstones — characters are never renumbered.",
        "Convergence falls out of three order-insensitive structures.",
      ),
    ],
  },
  {
    id: "team-sync",
    title: "Team sync — notes",
    owner: "demo-ben",
    shares: [
      ["demo-ada", "editor"],
      ["demo-carol", "viewer"],
    ],
    plain: [
      "Team sync — agenda & notes",
      "",
      "1. Shipping: two-window live edit works end-to-end.",
      "2. Offline: edit while disconnected, converge on reconnect. Done.",
      "3. Persistence: snapshots + periodic op-log compaction landed.",
      "4. Sharing: owner / editor / viewer roles via share links.",
      "",
      "Action items:",
      "- Ada: polish the presence cursors.",
      "- Ben: write the deploy guide.",
      "- Carol: review the docs.",
    ].join("\n"),
    rich: [
      h(1, "Team sync"),
      h(2, "Agenda"),
      bullets("Live edit", "Offline reconciliation", "Persistence & compaction", "Sharing"),
      h(2, "Action items"),
      bullets("Ada — presence cursors", "Ben — deploy guide", "Carol — docs review"),
    ],
  },
  {
    id: "roadmap",
    title: "Product roadmap",
    owner: "demo-ada",
    shares: [["demo-carol", "editor"]],
    plain: [
      "Roadmap",
      "",
      "Now:    real-time editing, presence, offline-first, sharing.",
      "Next:   inline remote cursors in plain-text mode; real accounts.",
      "Later:  comments, version history, mobile.",
      "",
      "Non-goals: Operational Transform (we picked CRDTs and own them).",
    ].join("\n"),
    rich: [
      h(1, "Product roadmap"),
      h(2, "Now"),
      bullets("Real-time editing", "Presence", "Offline-first", "Sharing"),
      h(2, "Next"),
      bullets("Inline remote cursors (plain mode)", "Real accounts"),
    ],
  },
  {
    id: "design-doc",
    title: "Design doc (shared)",
    owner: "demo-ben",
    shares: [
      ["demo-ada", "viewer"],
      ["demo-carol", "editor"],
    ],
    plain: [
      "Design doc",
      "",
      "The sync server is CRDT-agnostic: it relays and persists opaque ops, so the",
      "same server carries both @birga/crdt operations and Yjs updates.",
      "",
      "Late joiners load a snapshot instead of replaying history; a background",
      "sweep compacts the op log so it never grows without bound.",
    ].join("\n"),
    rich: [
      h(1, "Design doc"),
      p("The sync server is CRDT-agnostic — it relays and persists opaque ops."),
      bullets(
        "One server carries @birga/crdt ops and Yjs updates alike.",
        "Late joiners load from a snapshot.",
        "A background sweep compacts the op log.",
      ),
    ],
  },
];

const schema = getSchema([StarterKit]);

/** Store plain-text content as a from-scratch CRDT snapshot. */
async function seedPlain(store: DocStore, id: string, text: string): Promise<void> {
  const doc = new RGA("seed");
  const chars = [...text];
  for (const ch of chars) doc.insertAt(doc.length, ch);
  await store.saveSnapshot(`plain:${id}`, chars.length, doc.snapshot());
}

/** Store rich-text content as a Yjs state update (base64), matching the client. */
async function seedRich(store: DocStore, id: string, content: PMContent): Promise<void> {
  const pmDoc = schema.nodeFromJSON({ type: "doc", content });
  const ydoc = prosemirrorToYDoc(pmDoc, "default");
  const update = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();
  await store.saveSnapshot(`rich:${id}`, 1, Buffer.from(update).toString("base64"));
}

export interface SeedResult {
  accounts: Array<{ userId: string; name: string; note: string; token: string }>;
  documents: number;
}

/** Populate a store + repo with the demo dataset. Idempotent. */
export async function seed(store: DocStore, repo: DocumentsRepo, secret: string): Promise<SeedResult> {
  for (const d of DEMO_DOCS) {
    const existing = await repo.get(d.id);
    if (!existing) await repo.create(d.id, d.owner, d.title);
    else await repo.rename(d.id, d.title);
    for (const [userId, role] of d.shares) await repo.setRole(d.id, userId, role);

    await seedPlain(store, d.id, d.plain);
    try {
      await seedRich(store, d.id, d.rich);
    } catch (err) {
      // Rich seeding is best-effort; plain content is the primary surface.
      console.warn(`[seed] rich content skipped for ${d.id}: ${(err as Error).message}`);
    }
  }

  return {
    documents: DEMO_DOCS.length,
    accounts: DEMO_USERS.map((u) => ({
      ...u,
      token: signUser({ userId: u.userId, name: u.name }, secret),
    })),
  };
}
