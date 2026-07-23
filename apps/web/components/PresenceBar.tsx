import type { Identity } from "@/lib/identity";

export interface Peer {
  id: string;
  user: Identity;
}

export function PresenceBar({ connected, peers }: { connected: boolean; peers: Peer[] }) {
  return (
    <div className="flex items-center gap-3 text-sm">
      <span className="flex items-center gap-1.5">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${
            connected ? "bg-green-500" : "bg-slate-400"
          }`}
          aria-hidden
        />
        <span className="text-slate-600 dark:text-slate-400">
          {connected ? "Connected" : "Offline"}
        </span>
      </span>

      <span className="text-slate-300 dark:text-slate-700">·</span>

      <div className="flex items-center gap-1.5">
        {peers.length === 0 && <span className="text-slate-400">No one else here</span>}
        {peers.map((p) => (
          <span
            key={p.id}
            title={p.user.name}
            className="inline-flex h-6 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-white"
            style={{ backgroundColor: p.user.color }}
          >
            {p.user.name}
          </span>
        ))}
      </div>
    </div>
  );
}
