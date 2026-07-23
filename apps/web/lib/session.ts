import { useCallback, useEffect, useState } from "react";
import { api, type SessionUser } from "./api";

export interface Session {
  token: string;
  user: SessionUser;
}

const KEY = "birga:session";

export function loadSession(): Session | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(s: Session): void {
  window.localStorage.setItem(KEY, JSON.stringify(s));
}

export function clearSession(): void {
  window.localStorage.removeItem(KEY);
}

/**
 * React hook exposing the current guest session. `signIn` mints a guest identity
 * via the API; `ensure` returns an existing session or creates a "Guest" one.
 */
export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSession(loadSession());
    setReady(true);
  }, []);

  const signIn = useCallback(async (name: string): Promise<Session> => {
    const { token, user } = await api.guest(name.trim() || "Guest");
    const s = { token, user };
    saveSession(s);
    setSession(s);
    return s;
  }, []);

  const ensure = useCallback(
    async (name = "Guest"): Promise<Session> => {
      const existing = loadSession();
      if (existing) {
        setSession(existing);
        return existing;
      }
      return signIn(name);
    },
    [signIn],
  );

  const signOut = useCallback(() => {
    clearSession();
    setSession(null);
  }, []);

  return { session, ready, signIn, ensure, signOut };
}
