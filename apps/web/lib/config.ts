/** WebSocket URL of the Birga sync server. */
export function wsUrl(): string {
  return process.env.NEXT_PUBLIC_BIRGA_WS ?? "ws://localhost:8080";
}
