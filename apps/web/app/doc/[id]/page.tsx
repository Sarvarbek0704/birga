"use client";

import { useState } from "react";
import { PlainTextEditor } from "@/components/PlainTextEditor";
import { RichTextEditor } from "@/components/RichTextEditor";

type Mode = "plain" | "rich";

export default function DocPage({ params }: { params: { id: string } }) {
  const docId = decodeURIComponent(params.id);
  const [mode, setMode] = useState<Mode>("plain");

  return (
    <main className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">
            <span className="text-slate-400">doc / </span>
            {docId}
          </h1>
        </div>
        <div className="inline-flex overflow-hidden rounded-lg border border-slate-300 text-sm dark:border-slate-700">
          <button
            onClick={() => setMode("plain")}
            className={`px-3 py-1.5 ${
              mode === "plain"
                ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                : "bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-300"
            }`}
          >
            Plain (@birga/crdt)
          </button>
          <button
            onClick={() => setMode("rich")}
            className={`px-3 py-1.5 ${
              mode === "rich"
                ? "bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900"
                : "bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-300"
            }`}
          >
            Rich (Yjs)
          </button>
        </div>
      </div>

      {mode === "plain" ? (
        <PlainTextEditor key={`plain:${docId}`} docId={`plain:${docId}`} />
      ) : (
        <RichTextEditor key={`rich:${docId}`} docId={`rich:${docId}`} />
      )}
    </main>
  );
}
