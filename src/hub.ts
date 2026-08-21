import { existsSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import { postWebhook } from "./alerts/webhook.ts";
import { LoginGate } from "./auth/rate-limit.ts";
import { registerAuth } from "./auth/routes.ts";
import { SessionStore } from "./auth/session.ts";
import { UserStore } from "./auth/users.ts";
import { loadHubConfig, projectRoot } from "./config.ts";
import { FleetRegistry } from "./hub/registry.ts";
import { lanUrls } from "./lan.ts";
import { LogStore } from "./logs/store.ts";
import { QualityStore } from "./quality/store.ts";
import { notifies, QualityTracker } from "./quality/tracker.ts";
import type {
  AgentToHub,
  AlertState,
  BrowserToHub,
  FleetMachine,
  HubToAgent,
  HubToBrowser,
  LogCategory,
  LogLevel,
  QualityInterval,
  Snapshot,
} from "./shared/types.ts";

const config = loadHubConfig();
const root = projectRoot();
const dataDir = join(root, "data");
const users = new UserStore(dataDir);
await users.ensureSeed(config.admin);
const sessions = new SessionStore(7 * 24 * 60 * 60 * 1000);
const loginGate = new LoginGate();
const logStore = new LogStore(dataDir);
const qualityStore = new QualityStore(dataDir);
const quality = new QualityTracker(
  qualityStore,
  config.quality.minKbps,
  config.quality.maxKbps,
  config.quality.holdSec * 1000,
);
const qualityNotifyAt = new Map<string, number>();
const qualityNotified = new Set<number>();
const fleet = new FleetRegistry(config.staleSec * 1000, config.quality);
const agentSockets = new Map<string, WebSocket>();
const browsers = new Set<{ socket: WebSocket; watch: string | null }>();

const app = Fastify({ logger: { level: "warn" }, trustProxy: true });
await app.register(cors, { origin: false });
await app.register(websocket);

registerAuth(app, {
  users,
  sessions,
  loginGate,
  meta: () => ({
    webhookConfigured: Boolean(config.alerts.webhookUrl),
    quality: config.quality,
  }),
});

app.get("/api/health", async () => ({ ok: true }));

app.get("/api/fleet", async () => fleet.summaries());

app.get("/api/snapshot/:machineId", async (req, reply) => {
  const { machineId } = req.params as { machineId: string };
  const slot = fleet.get(machineId);
  if (!slot?.snapshot) return reply.code(404).send({ error: "machine not found" });
  return slot.snapshot;
});

app.get("/api/logs", async (req) => {
  const query = req.query as {
    machineId?: string;
    q?: string;
    category?: string;
    level?: string;
    limit?: string;
  };
  const category = (query.category ?? "") as LogCategory | "";
  const level = (query.level ?? "") as LogLevel | "";
  const allowed = new Set([
    "connection",
    "encoder",
    "render",
    "audio",
    "source",
    "system",
    "alert",
    "other",
  ]);
  return logStore.query({
    machineId: query.machineId ?? "",
    q: query.q ?? "",
    category: allowed.has(category) ? category : "",
    level: level === "info" || level === "warn" || level === "error" ? level : "",
    limit: Number(query.limit ?? 200) || 200,
  });
});

app.get("/api/quality", async (req, reply) => {
  const { machineId } = req.query as { machineId?: string };
  if (!machineId) return reply.code(400).send({ error: "machineId required" });
  return qualityStore.query(machineId, config.quality);
});

app.post("/api/alerts/test", async (req, reply) => {
  if (!req.account?.admin) {
    return reply.code(403).send({ error: "需要管理员" });
  }
  if (!config.alerts.webhookUrl) {
    return reply.code(400).send({ error: "未配置 alerts.webhookUrl" });
  }
  const now = Date.now();
  await postWebhook(
    config.alerts.webhookUrl,
    {
      key: "obs.disconnected",
      severity: "P0",
      status: "firing",
      title: "Webhook 测试",
      message: "来自 OBS Monitor 中心的测试通知",
      since: now,
      updatedAt: now,
    },
    { displayName: "hub" },
  );
  return { ok: true };
});

app.get("/agent", { websocket: true }, (socket) => {
  let machineId: string | null = null;
  socket.on("message", (raw) => {
    let msg: AgentToHub;
    try {
      msg = JSON.parse(String(raw)) as AgentToHub;
    } catch {
      return;
    }
    if (msg.type === "hello") {
      if (!config.token || msg.token !== config.token) {
        sendAgent(socket, { type: "hello_reject", reason: "token 无效" });
        socket.close();
        return;
      }
      if (machineId && machineId !== msg.machineId) {
        agentSockets.delete(machineId);
        fleet.disconnect(machineId);
      }
      const prev = agentSockets.get(msg.machineId);
      if (prev && prev !== socket) {
        try {
          prev.close();
        } catch {
          /* ignore */
        }
      }
      machineId = msg.machineId;
      agentSockets.set(machineId, socket);
      const recovered = fleet.hello(msg.machineId, msg.displayName, msg.hostname);
      sendAgent(socket, { type: "hello_ok" });
      if (recovered) {
        const now = Date.now();
        void notify(
          {
            key: "agent.stale",
            severity: "P0",
            title: "采集器失联",
            message: "采集器已重新接入",
            status: "resolved",
            since: now,
            updatedAt: now,
          },
          msg.machineId,
          msg.displayName,
        );
      }
      broadcastFleet();
      return;
    }
    if (!machineId) return;
    if (msg.type === "snapshot") {
      fleet.snapshot(machineId, msg.payload);
      applyQuality(machineId, msg.payload, fleet.get(machineId)?.displayName);
      pushSnapshot(machineId, fleet.get(machineId)?.snapshot ?? msg.payload);
      broadcastFleet();
      return;
    }
    if (msg.type === "logs") {
      logStore.append(machineId, msg.payload);
      return;
    }
    if (msg.type === "alert") {
      const slot = fleet.get(machineId);
      void notify(msg.payload, slot?.machineId, slot?.displayName);
    }
  });
  socket.on("close", () => {
    if (!machineId) return;
    if (agentSockets.get(machineId) === socket) {
      agentSockets.delete(machineId);
      fleet.disconnect(machineId);
      broadcastFleet();
    }
  });
});

app.get("/api/ws", { websocket: true }, (socket, req) => {
  const session = sessions.fromRequest(req);
  if (!session) {
    socket.close(4401, "unauthorized");
    return;
  }
  const client = { socket, watch: null as string | null };
  browsers.add(client);
  sendBrowser(socket, { type: "fleet", payload: fleet.summaries() });
  socket.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw)) as BrowserToHub;
      if (msg.type === "watch") {
        client.watch = msg.machineId ?? null;
        if (client.watch) {
          const snap = fleet.get(client.watch)?.snapshot;
          if (snap) sendBrowser(socket, { type: "snapshot", machineId: client.watch, payload: snap });
        }
      }
    } catch {
      /* ignore */
    }
  });
  socket.on("close", () => browsers.delete(client));
});

const webDist = join(root, "web", "dist");
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/agent")) {
      return reply.code(404).send({ error: "not found" });
    }
    return reply.sendFile("index.html");
  });
} else {
  app.get("/", async (_req, reply) => {
    reply.type("text/plain; charset=utf-8");
    return "开发模式请打开看板: http://127.0.0.1:5173";
  });
  console.log("未找到 web/dist，看板请打开 http://127.0.0.1:5173");
}

setInterval(() => {
  const stale = fleet.markStale();
  for (const { slot, becameStale } of stale) {
    if (!becameStale) continue;
    const now = Date.now();
    quality.closeMachine(slot.machineId, now);
    const alert: AlertState = {
      key: "agent.stale",
      severity: "P0",
      title: "采集器失联",
      message: "超过心跳窗口未上报",
      status: "firing",
      since: now,
      updatedAt: now,
    };
    void notify(alert, slot.machineId, slot.displayName);
  }
  broadcastFleet();
}, 2000);

try {
  await app.listen({ host: config.listen.host, port: config.listen.port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

console.log("OBS Monitor 中心已启动");
for (const url of lanUrls(config.listen.port)) console.log(`  看板 ${url}`);
console.log(`Token: ${config.token ? "已配置" : "未配置"}`);
console.log(`Webhook: ${config.alerts.webhookUrl ? "已配置" : "未配置"}`);
console.log(`登录用户: ${users.list().length}（看板需登录；采集器仍用 token）`);

function sendAgent(socket: WebSocket, msg: HubToAgent): void {
  socket.send(JSON.stringify(msg));
}

function sendBrowser(socket: WebSocket, msg: HubToBrowser): void {
  socket.send(JSON.stringify(msg));
}

function broadcastFleet(): void {
  const payload: FleetMachine[] = fleet.summaries();
  const data = JSON.stringify({ type: "fleet", payload } satisfies HubToBrowser);
  for (const client of browsers) {
    try {
      client.socket.send(data);
    } catch {
      browsers.delete(client);
    }
  }
}

function pushSnapshot(machineId: string, payload: Snapshot): void {
  const data = JSON.stringify({ type: "snapshot", machineId, payload } satisfies HubToBrowser);
  for (const client of browsers) {
    if (client.watch !== machineId) continue;
    try {
      client.socket.send(data);
    } catch {
      browsers.delete(client);
    }
  }
}

async function notify(alert: AlertState, machineId?: string, displayName?: string): Promise<void> {
  if (!config.alerts.webhookUrl) {
    console.warn(`[alert] ${displayName ?? machineId ?? "hub"} ${alert.key} ${alert.status}`);
    return;
  }
  try {
    await postWebhook(config.alerts.webhookUrl, alert, { machineId, displayName });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[alert] webhook 失败: ${message}`);
  }
}

function applyQuality(machineId: string, snap: Snapshot, displayName?: string): void {
  const changes = quality.observe(machineId, snap);
  for (const change of changes) {
    if (!notifies(change.interval.kind)) continue;
    if (change.status === "opened") {
      if (!qualityCooldownOk(machineId, snap.ts)) continue;
      qualityNotifyAt.set(machineId, snap.ts);
      qualityNotified.add(change.interval.id);
    } else if (!qualityNotified.delete(change.interval.id)) {
      continue;
    }
    void notify(qualityAlert(change.interval, change.status, snap.ts), machineId, displayName);
  }
}

function qualityCooldownOk(machineId: string, now: number): boolean {
  const last = qualityNotifyAt.get(machineId) ?? 0;
  return now - last >= config.alerts.cooldownSec * 1000;
}

function qualityAlert(interval: QualityInterval, status: "opened" | "closed", now: number): AlertState {
  const peak = (interval.peakKbps / 1000).toFixed(2);
  const max = (config.quality.maxKbps / 1000).toFixed(2);
  return {
    key: "quality.bitrate_over",
    severity: "P1",
    status: status === "opened" ? "firing" : "resolved",
    title: "码率越上限",
    message:
      status === "opened"
        ? `推流码率持续高于 ${max} Mbps（峰值 ${peak} Mbps）`
        : `码率已回到 ${max} Mbps 以下（峰值 ${peak} Mbps）`,
    since: interval.startedAt,
    updatedAt: now,
  };
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    qualityStore.closeAllOpen(Date.now());
    qualityStore.stop();
    logStore.stop();
    void app.close().then(() => process.exit(0));
  });
}
