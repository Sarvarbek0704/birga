"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { useSession } from "@/lib/session";

export const dynamic = "force-dynamic";

function AcceptInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { ensure } = useSession();
  const [status, setStatus] = useState("Redeeming share link…");

  useEffect(() => {
    const shareToken = params.get("token");
    if (!shareToken) {
      setStatus("Missing share token.");
      return;
    }
    void (async () => {
      try {
        const session = await ensure();
        const { docId, role } = await api.accept(session.token, shareToken);
        setStatus(`Access granted (${role}). Opening…`);
        router.replace(`/doc/${encodeURIComponent(docId)}`);
      } catch (e) {
        setStatus(e instanceof ApiError ? e.message : String(e));
      }
    })();
  }, [params, ensure, router]);

  return <p className="text-slate-600 dark:text-slate-400">{status}</p>;
}

export default function AcceptPage() {
  return (
    <main>
      <h1 className="mb-2 text-xl font-semibold">Share link</h1>
      <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
        <AcceptInner />
      </Suspense>
    </main>
  );
}
