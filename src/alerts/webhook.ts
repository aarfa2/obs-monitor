import type { AlertState } from "../shared/types.ts";

export async function postWebhook(
  url: string,
  alert: AlertState,
  extra?: { machineId?: string; displayName?: string },
): Promise<void> {
  if (!url) return;
  const who = extra?.displayName ? `${extra.displayName} ` : "";
  const text = `[${alert.severity}] ${who}${alert.status === "firing" ? "报警" : "恢复"} ${alert.title}: ${alert.message}`;
  const body = {
    text,
    source: "obs-monitor",
    event: alert.key,
    severity: alert.severity,
    status: alert.status,
    title: alert.title,
    message: alert.message,
    machineId: extra?.machineId ?? null,
    displayName: extra?.displayName ?? null,
    since: new Date(alert.since).toISOString(),
    at: new Date(alert.updatedAt).toISOString(),
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`webhook ${res.status} ${res.statusText}`);
  }
}
