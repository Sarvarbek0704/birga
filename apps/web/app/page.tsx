"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

function slugId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID().slice(0, 8);
  }
  return Math.random().toString(36).slice(2, 10);
}

export default function Home() {
  const router = useRouter();
  const [docId, setDocId] = useState("");

  const open = (id: string): void => {
    const clean = id.trim() || slugId();
    router.push(`/doc/${encodeURIComponent(clean)}`);
  };

  return (
    <main className="flex flex-col gap-6">
      <section>
        <h1 className="text-2xl font-bold tracking-tight">Open a document</h1>
        <p className="mt-1 text-slate-600 dark:text-slate-400">
          Share the URL to collaborate. Two people can type in the same paragraph at once — edits
          merge without conflicts, even offline.
        </p>
      </section>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          open(docId);
        }}
      >
        <input
          value={docId}
          onChange={(e) => setDocId(e.target.value)}
          placeholder="document id (blank = new)"
          className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900"
        />
        <button
          type="submit"
          className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
        >
          Open
        </button>
      </form>

      <section className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
        <p className="font-medium text-slate-800 dark:text-slate-200">Two editing modes per doc:</p>
        <ul className="mt-2 list-disc pl-5">
          <li>
            <b>Plain text</b> — driven by the from-scratch <code>@birga/crdt</code> (RGA).
          </li>
          <li>
            <b>Rich text</b> — TipTap on Yjs, synced over the same server.
          </li>
        </ul>
      </section>
    </main>
  );
}
