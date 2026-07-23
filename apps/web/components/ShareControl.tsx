"use client";

import { useState } from "react";
import { api, ApiError, type Role } from "@/lib/api";
import { loadSession } from "@/lib/session";

/**
 * Owner-only share control: mints a signed share link for a role and copies it.
 * The API rejects non-owners with 403, surfaced here as a message.
 */
export function ShareControl({ docId }: { docId: string }) {
  const [role, setRole] = useState<Exclude<Role, "owner">>("editor");
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const makeLink = async (): Promise<void> => {
    const session = loadSession();
    if (!session) {
      setError("Sign in first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { token } = await api.share(session.token, docId, role);
      const url = `${window.location.origin}/accept?token=${encodeURIComponent(token)}`;
      setLink(url);
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        /* clipboard may be blocked; the link is shown regardless */
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as Exclude<Role, "owner">)}
          className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="editor">can edit</option>
          <option value="viewer">can view</option>
        </select>
        <button
          onClick={() => void makeLink()}
          disabled={busy}
          className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-900"
        >
          {busy ? "…" : "Share link"}
        </button>
      </div>
      {link && <span className="max-w-xs truncate text-xs text-green-600" title={link}>Copied: {link}</span>}
      {error && <span className="text-xs text-amber-600">{error}</span>}
    </div>
  );
}
