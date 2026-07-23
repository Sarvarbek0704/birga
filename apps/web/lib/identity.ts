export interface Identity {
  name: string;
  color: string;
}

const COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

const NAMES = ["Ada", "Alan", "Grace", "Linus", "Edsger", "Barbara", "Ken", "Radia"];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/**
 * A stable per-browser identity (name + colour) for presence, persisted in
 * localStorage. Returns a neutral placeholder during SSR.
 */
export function getIdentity(): Identity {
  if (typeof window === "undefined") return { name: "…", color: "#64748b" };
  const raw = window.localStorage.getItem("birga:identity");
  if (raw) {
    try {
      return JSON.parse(raw) as Identity;
    } catch {
      /* fall through and regenerate */
    }
  }
  const identity: Identity = {
    name: `${pick(NAMES)}-${Math.floor(100 + Math.random() * 900)}`,
    color: pick(COLORS),
  };
  window.localStorage.setItem("birga:identity", JSON.stringify(identity));
  return identity;
}

/** A fresh, unique replica id for this tab/session. */
export function newReplicaId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `r-${Math.random().toString(36).slice(2)}`;
}
