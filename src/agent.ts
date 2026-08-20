import { hostname } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { AlertEngine, defaultRules } from "./alerts/engine.ts";
import { loadAgentConfig, projectRoot } from "./config.ts";
import { ObsCollector } from "./obs/collector.ts";
import type { AgentToHub, HubToAgent, LogLineInput, LogSink, Snapshot } from "./shared/types.ts";

const config = loadAgentConfig();
const dataDir = join(projectRoot(), "data");
const pendingLogs: LogLineInput[] = [];
let socket: WebSocket | null = null;
let identified = false;
let reconnectDelay = 1000;
let connectGen = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

const sink: LogSink = {
  append(entries) {
    if (entries.length === 0) return;
    if (identified && socket?.readyState === WebSocket.OPEN) {
      send({ type: "logs", payload: entries });
      return;
    }
    pendingLogs.push(...entries);
    if (pendingLogs.length > 2000) pendingLogs.splice(0, pendingLogs.length - 2000);
  },
};

const collector = new ObsCollector(config.obs.url, config.obs.password, sink, dataDir);
const engine = new AlertEngine(
  defaultRules({
    obsDisconnectHoldSec: config.alerts.obsDisconnectHoldSec,
    reconnectHoldSec: config.alerts.reconnectHoldSec,
  }),
  config.alerts.cooldownSec * 1000,
);

collector.on("snapshot", (snap) => {
  const { snapshot, changes } = engine.evaluate(snap, {
    everConnected: collector.everConnectedOnce,
    sawStreaming: collector.sawStreamingOnce,
    didExitCleanly: collector.didExitCleanly,
  });
  for (const change of changes) {
    const verb = change.alert.status === "firing" ? "报警" : "恢复";
    collector.note(
      change.alert.status === "firing" ? "error" : "info",
      `${verb} ${change.alert.title}: ${change.alert.message}`,
    );
    snapshot.events = collector.snapshot().events;
    send({ type: "alert", payload: change.alert });
  }
  sendSnapshot(snapshot);
});

collector.start();
connectHub();

console.log(`采集器 ${config.displayName} (${config.machineId})`);
console.log(`OBS ${config.obs.url}`);
console.log(`中心 ${config.hubUrl}`);
console.log(`本机 ${hostname()} — 无界面，日志推送到中心，本地只保留读取游标`);

function connectHub(): void {
  const gen = ++connectGen;
  identified = false;
  const ws = new WebSocket(config.hubUrl);
  socket = ws;
  ws.on("open", () => {
    if (gen !== connectGen) return;
    send({
      type: "hello",
      token: config.token,
      machineId: config.machineId,
      displayName: config.displayName,
      hostname: config.hostname,
    });
  });
  ws.on("message", (raw) => {
    let msg: HubToAgent;
    try {
      msg = JSON.parse(String(raw)) as HubToAgent;
    } catch {
      return;
    }
    if (msg.type === "hello_ok") {
      identified = true;
      reconnectDelay = 1000;
      console.log("已接入中心");
      flushLogs();
      sendSnapshot(collector.snapshot());
    }
    if (msg.type === "hello_reject") {
      console.error(`中心拒绝接入: ${msg.reason}`);
    }
  });
  ws.on("close", () => {
    if (gen !== connectGen) return;
    identified = false;
    scheduleReconnect();
  });
  ws.on("error", () => {
    /* close handler reconnects */
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectHub();
  }, delay);
}

function sendSnapshot(snapshot: Snapshot): void {
  send({
    type: "snapshot",
    payload: {
      ...snapshot,
      machine: {
        machineId: config.machineId,
        displayName: config.displayName,
        hostname: config.hostname,
      },
    },
  });
}

function flushLogs(): void {
  if (pendingLogs.length === 0) return;
  const batch = pendingLogs.splice(0, pendingLogs.length);
  send({ type: "logs", payload: batch });
}

function send(msg: AgentToHub): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (msg.type !== "hello" && !identified) return;
  socket.send(JSON.stringify(msg));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    collector.stop();
    socket?.close();
    process.exit(0);
  });
}
