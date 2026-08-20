export type ObsConnectionState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "exited";

export type AlertKey =
  | "obs.disconnected"
  | "stream.stopped"
  | "stream.reconnecting"
  | "agent.stale"
  | "quality.bitrate_over";

export type AlertSeverity = "P0" | "P1";
export type AlertStatus = "firing" | "resolved";

export type LogLevel = "info" | "warn" | "error";

export type LogCategory =
  | "connection"
  | "encoder"
  | "render"
  | "audio"
  | "source"
  | "system"
  | "alert"
  | "other";

export type AlertState = {
  key: AlertKey;
  severity: AlertSeverity;
  status: AlertStatus;
  title: string;
  message: string;
  since: number;
  updatedAt: number;
};

export type MonitorEvent = {
  id: number;
  ts: number;
  level: LogLevel;
  message: string;
};

export type LogLineInput = {
  ts: number;
  level: LogLevel;
  category: LogCategory;
  source: "obs" | "monitor";
  text: string;
};

export type StoredLog = LogLineInput & {
  id: number;
  machineId: string;
};

export type LogQuery = {
  machineId: string;
  q: string;
  category: LogCategory | "";
  level: LogLevel | "";
  limit: number;
};

export type LogQueryResult = {
  total: number;
  retainedHours: number;
  shown: number;
  counts: Record<LogCategory, number>;
  lines: StoredLog[];
};

export type ObsSource = {
  name: string;
  kind: string;
  group: "video" | "audio" | "other";
};

export type HistoryPoint = {
  ts: number;
  bitrateKbps: number;
  fps: number;
  cpuUsage: number;
  congestion: number;
  skipRate: number;
  renderSkipRate: number;
  encodeSkipRate: number;
};

export type MachineIdentity = {
  machineId: string;
  displayName: string;
  hostname: string;
};

export type Snapshot = {
  ts: number;
  machine?: MachineIdentity;
  obs: {
    state: ObsConnectionState;
    version: string | null;
    websocketVersion: string | null;
    lastError: string | null;
    scene: string | null;
    profile: string | null;
    platform: string | null;
  };
  video: {
    canvas: string;
    output: string;
    fps: string;
    streamService: string | null;
  };
  stream: {
    active: boolean;
    reconnecting: boolean;
    timecode: string;
    durationMs: number;
    congestion: number;
    bytes: number;
    bitrateKbps: number;
    skippedFrames: number;
    totalFrames: number;
    skipRate: number;
  };
  record: {
    active: boolean;
    paused: boolean;
    timecode: string;
  };
  stats: {
    cpuUsage: number;
    memoryMb: number;
    fps: number;
    targetFps: number;
    renderTimeMs: number;
    frameBudgetMs: number;
    renderSkipped: number;
    renderTotal: number;
    renderSkipRate: number;
    encodeSkipped: number;
    encodeTotal: number;
    encodeSkipRate: number;
    availableDiskGb: number;
  };
  sources: ObsSource[];
  pressure: "ok" | "render" | "encode" | "network" | "mixed";
  alerts: AlertState[];
  events: MonitorEvent[];
  logFile: string | null;
  history: HistoryPoint[];
};

export type QualityKind =
  | "bitrate.over"
  | "bitrate.under"
  | "pressure.render"
  | "pressure.encode"
  | "pressure.network"
  | "pressure.mixed";

export type QualityInterval = {
  id: number;
  machineId: string;
  kind: QualityKind;
  startedAt: number;
  endedAt: number | null;
  durationMs: number;
  peakKbps: number;
  minKbps: number;
  avgKbps: number;
  samples: number;
};

export type QualityStats = {
  overCount: number;
  overMs: number;
  underCount: number;
  underMs: number;
  pressureCount: number;
  pressureMs: number;
};

export type QualityQueryResult = {
  minKbps: number;
  maxKbps: number;
  holdSec: number;
  retainedHours: number;
  stats: QualityStats;
  intervals: QualityInterval[];
};

export type FleetMachine = {
  machineId: string;
  displayName: string;
  hostname: string;
  online: boolean;
  lastSeen: number;
  obsState: ObsConnectionState | "offline";
  streaming: boolean;
  reconnecting: boolean;
  recording: boolean;
  pressure: Snapshot["pressure"] | "offline";
  alertCount: number;
  videoSources: number;
  bitrateKbps: number;
  bitrateBand: "ok" | "over" | "under";
  cpuUsage: number;
  lastError: string | null;
};

export type LogSink = {
  append(entries: LogLineInput[]): void;
};

export type AgentToHub =
  | {
      type: "hello";
      token: string;
      machineId: string;
      displayName: string;
      hostname: string;
    }
  | { type: "snapshot"; payload: Snapshot }
  | { type: "logs"; payload: LogLineInput[] }
  | { type: "alert"; payload: AlertState };

export type HubToAgent = { type: "hello_ok" } | { type: "hello_reject"; reason: string };

export type BrowserToHub = { type: "watch"; machineId?: string };

export type HubToBrowser =
  | { type: "fleet"; payload: FleetMachine[] }
  | { type: "snapshot"; machineId: string; payload: Snapshot };
