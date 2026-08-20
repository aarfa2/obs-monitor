import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export type HubConfig = {
  listen: { host: string; port: number };
  token: string;
  staleSec: number;
  alerts: {
    webhookUrl: string;
    cooldownSec: number;
  };
};

export type AgentConfig = {
  token: string;
  hubUrl: string;
  displayName: string;
  machineId: string;
  hostname: string;
  obs: { url: string; password: string };
  alerts: {
    obsDisconnectHoldSec: number;
    reconnectHoldSec: number;
    cooldownSec: number;
  };
};

type FileShape = {
  listen?: { host?: string; port?: number };
  token?: string;
  staleSec?: number;
  hubUrl?: string;
  displayName?: string;
  obs?: { url?: string; password?: string };
  alerts?: {
    webhookUrl?: string;
    cooldownSec?: number;
    obsDisconnectHoldSec?: number;
    reconnectHoldSec?: number;
  };
};

function readJson(path: string): FileShape {
  return JSON.parse(readFileSync(path, "utf8")) as FileShape;
}

export function projectRoot(): string {
  if (process.env.OBS_MONITOR_HOME) return process.env.OBS_MONITOR_HOME;
  if (existsSync(join(process.cwd(), "config.json"))) return process.cwd();
  const nextToNode = dirname(process.execPath);
  if (existsSync(join(nextToNode, "config.json"))) return nextToNode;
  const fromFile = join(dirname(fileURLToPath(import.meta.url)), "..");
  if (existsSync(join(fromFile, "package.json"))) return fromFile;
  return process.cwd();
}

function configPath(): string {
  return join(projectRoot(), "config.json");
}

function loadFile(): FileShape {
  const path = configPath();
  if (!existsSync(path)) {
    console.warn(`未找到 ${path}，使用默认配置`);
    return {};
  }
  return readJson(path);
}

export function loadHubConfig(): HubConfig {
  const file = loadFile();
  const token = process.env.OBS_MONITOR_TOKEN ?? file.token ?? "";
  if (!token) console.warn("未配置 token，Agent 将无法接入（config.json token 或 OBS_MONITOR_TOKEN）");
  return {
    listen: {
      host: file.listen?.host ?? "0.0.0.0",
      port: Number(process.env.PORT ?? file.listen?.port ?? 8787),
    },
    token,
    staleSec: file.staleSec ?? 15,
    alerts: {
      webhookUrl: process.env.ALERT_WEBHOOK_URL ?? file.alerts?.webhookUrl ?? "",
      cooldownSec: file.alerts?.cooldownSec ?? 300,
    },
  };
}

export function loadAgentConfig(): AgentConfig {
  const file = loadFile();
  const token = process.env.OBS_MONITOR_TOKEN ?? file.token ?? "";
  const hubUrl =
    process.env.OBS_MONITOR_HUB ?? file.hubUrl ?? "ws://127.0.0.1:8787/agent";
  const host = hostname();
  return {
    token,
    hubUrl,
    displayName: file.displayName || host,
    machineId: loadOrCreateMachineId(),
    hostname: host,
    obs: {
      url: process.env.OBS_WS_URL ?? file.obs?.url ?? "ws://127.0.0.1:4455",
      password: process.env.OBS_WS_PASSWORD ?? file.obs?.password ?? "",
    },
    alerts: {
      obsDisconnectHoldSec: file.alerts?.obsDisconnectHoldSec ?? 5,
      reconnectHoldSec: file.alerts?.reconnectHoldSec ?? 15,
      cooldownSec: file.alerts?.cooldownSec ?? 300,
    },
  };
}

function loadOrCreateMachineId(): string {
  const dir = join(projectRoot(), "data");
  const path = join(dir, "machine-id.txt");
  mkdirSync(dir, { recursive: true });
  if (existsSync(path)) {
    const id = readFileSync(path, "utf8").trim();
    if (id) return id;
  }
  const id = randomUUID();
  writeFileSync(path, `${id}\n`, "utf8");
  return id;
}
