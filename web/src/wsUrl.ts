/** Dev: talk to hub WS directly so Vite's /api proxy does not abort upgrades. */
export function monitorWsUrl(): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  if (import.meta.env.DEV) {
    return `${proto}//${location.hostname}:8787/api/ws`;
  }
  return `${proto}//${location.host}/api/ws`;
}
