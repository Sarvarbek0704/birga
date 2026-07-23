"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type DocWithRole } from "@/lib/api";
import { useSession } from "@/lib/session";

function slugId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().slice(0, 8);
  return Math.random().toString(36).slice(2, 10);
}

export default function Home() {
  const router = useRouter();
  const { session, ready, signIn, signOut } = useSession();
  const [name, setName] = useState("");

  if (!ready) return <p className="text-slate-500">Loading…</p>;

  if (!session) {
    return (
      <main className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
        <p className="text-slate-600 dark:text-slate-400">
          Pick a display name to start collaborating. No password — this is a guest identity.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void signIn(name);
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="your name"
            className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900"
          />
          <button
            type="submit"
            className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900"
          >
            Continue
          </button>
        </form>
      </main>
    );
  }

  return <DocumentList onSignOut={signOut} token={session.token} userName={session.user.name} router={router} makeId={slugId} />;
}

function DocumentList({
  token,
  userName,
  onSignOut,
  router,
  makeId,
}: {
  token: string;
  userName: string;
  onSignOut: () => void;
  router: ReturnType<typeof useRouter>;
  makeId: () => string;
}) {
  const [docs, setDocs] = useState<DocWithRole[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [openId, setOpenId] = useState("");

  const refresh = useCallback(async () => {
    try {
      const { docs } = await api.listDocs(token);
      setDocs(docs);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setDocs([]);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async (): Promise<void> => {
    try {
      const { doc } = await api.createDoc(token, { title: title.trim() || "Untitled" });
      router.push(`/doc/${encodeURIComponent(doc.id)}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  return (
    <main className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Your documents</h1>
          <p className="text-sm text-slate-500">
            Signed in as <b>{userName}</b>
          </p>
        </div>
        <button onClick={onSignOut} className="text-sm text-slate-500 hover:underline">
          Sign out
        </button>
      </div>

      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New document title"
          className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900"
        />
        <button
          type="submit"
          className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900"
        >
          Create
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {error}
        </div>
      )}

      {docs && docs.length > 0 && (
        <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200 dark:divide-slate-800 dark:border-slate-800">
          {docs.map((d) => (
            <li key={d.id}>
              <a
                href={`/doc/${encodeURIComponent(d.id)}`}
                className="flex items-center justify-between px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-900"
              >
                <span className="font-medium">{d.title}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {d.role}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      {docs && docs.length === 0 && !error && (
        <p className="text-slate-500">No documents yet — create one above.</p>
      )}

      <div className="border-t border-slate-200 pt-4 dark:border-slate-800">
        <p className="mb-2 text-sm text-slate-500">Or open any document id directly:</p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            router.push(`/doc/${encodeURIComponent(openId.trim() || makeId())}`);
          }}
        >
          <input
            value={openId}
            onChange={(e) => setOpenId(e.target.value)}
            placeholder="document id (blank = new)"
            className="flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 outline-none focus:border-slate-400 dark:border-slate-700 dark:bg-slate-900"
          />
          <button type="submit" className="rounded-lg border border-slate-300 px-4 py-2 dark:border-slate-700">
            Open
          </button>
        </form>
      </div>
    </main>
  );
}
