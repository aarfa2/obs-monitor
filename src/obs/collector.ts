import { EventEmitter } from "node:events";
import OBSWebSocket, {
  EventSubscription,
  type OBSResponseTypes,
} from "obs-websocket-js";
import type {
  HistoryPoint,
  LogSink,
  MonitorEvent,
  ObsConnectionState,
  ObsSource,
  Snapshot,
} from "../shared/types.ts";
import { ObsLogTailer, pruneOldObsLogs } from "./log-tailer.ts";
import { classifyCategory } from "../logs/classify.ts";

const POLL_MS = 1000;
const SLOW_EVERY = 10;
const HISTORY_MAX = 120;
const EVENTS_MAX = 40;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10_000;

const READ_ONLY_REQUESTS = new Set([
  "GetVersion",
  "GetStats",
  "GetStreamStatus",
  "GetRecordStatus",
  "GetVideoSettings",
  "GetCurrentProgramScene",
  "GetProfileList",
  "GetInputList",
  "GetStreamServiceSettings",
]);

type InputRow = { inputName?: unknown; inputKind?: unknown; unversionedInputKind?: unknown };

export class ObsCollector extends EventEmitter<{
  snapshot: [Snapshot];
  event: [MonitorEvent];
}> {
  private obs = new OBSWebSocket();
  private logs: ObsLogTailer;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private stopped = false;
  private eventSeq = 0;
  private pollN = 0;
  private prevBytes: { ts: number; bytes: number } | null = null;
  private streamSkip = new Delta();
  private renderSkip = new Delta();
  private encodeSkip = new Delta();
  private sawStreaming = false;
  private exitStarted = false;
  private everConnected = false;

  private obsState: ObsConnectionState = "connecting";
  private version: string | null = null;
  private websocketVersion: string | null = null;
  private platform: string | null = null;
  private lastError: string | null = null;
  private scene: string | null = null;
  private profile: string | null = null;
  private streamService: string | null = null;
  private canvas = "—";
  private outputRes = "—";
  private fpsLabel = "—";
  private sources: ObsSource[] = [];
  private stream: Snapshot["stream"] = emptyStream();
  private record: Snapshot["record"] = emptyRecord();
  private stats: Snapshot["stats"] = emptyStats();
  private events: MonitorEvent[] = [];
  private history: HistoryPoint[] = [];

  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string,
    private readonly password: string,
    private readonly store: LogSink,
    private readonly dataDir: string,
  ) {
    super();
    this.logs = new ObsLogTailer(store, dataDir);
    this.obs.on("ConnectionClosed", () => {
      this.handleDisconnect("OBS WebSocket 已断开");
    });
    this.obs.on("ConnectionError", (err) => {
      this.lastError = err.message;
    });
    this.obs.on("ExitStarted", () => {
      this.exitStarted = true;
      this.obsState = "exited";
      this.pushEvent("warn", "OBS 正在退出");
    });
    this.obs.on("StreamStateChanged", (data) => {
      const state = data.outputState.replace(/^OBS_WEBSOCKET_OUTPUT_/, "");
      this.pushEvent(
        data.outputActive ? "info" : "warn",
        `推流状态: ${state}${data.outputActive ? "（输出中）" : ""}`,
      );
      if (data.outputActive) this.sawStreaming = true;
    });
    this.obs.on("RecordStateChanged", (data) => {
      const state = data.outputState.replace(/^OBS_WEBSOCKET_OUTPUT_/, "");
      this.pushEvent("info", `录像状态: ${state}`);
    });
    this.obs.on("CurrentProgramSceneChanged", (data) => {
      this.scene = data.sceneName;
      this.pushEvent("info", `当前场景: ${data.sceneName}`);
    });
    this.obs.on("InputMuteStateChanged", (data) => {
      this.pushEvent(
        data.inputMuted ? "warn" : "info",
        `源「${data.inputName}」${data.inputMuted ? "已静音" : "取消静音"}`,
      );
    });
    this.obs.on("InputCreated", (data) => {
      this.pushEvent("info", `新增源「${data.inputName}」（${data.unversionedInputKind || data.inputKind}）`);
      void this.refreshSlow().catch(() => undefined);
    });
    this.obs.on("InputRemoved", (data) => {
      this.pushEvent("warn", `移除源「${data.inputName}」`);
      void this.refreshSlow().catch(() => undefined);
    });
  }

  start(): void {
    this.stopped = false;
    this.logs.start();
    pruneOldObsLogs(this.logs.snapshot().file);
    this.pruneTimer = setInterval(() => {
      pruneOldObsLogs(this.logs.snapshot().file);
    }, 60 * 60 * 1000);
    void this.connect();
    this.timer = setInterval(() => {
      void this.poll();
    }, POLL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.logs.stop();
    if (this.timer) clearInterval(this.timer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    void this.obs.disconnect();
  }

  note(level: MonitorEvent["level"], message: string): void {
    this.pushEvent(level, message);
  }

  snapshot(): Snapshot {
    const log = this.logs.snapshot();
    return {
      ts: Date.now(),
      obs: {
        state: this.obsState,
        version: this.version,
        websocketVersion: this.websocketVersion,
        lastError: this.lastError,
        scene: this.scene,
        profile: this.profile,
        platform: this.platform,
      },
      video: {
        canvas: this.canvas,
        output: this.outputRes,
        fps: this.fpsLabel,
        streamService: this.streamService,
      },
      stream: this.stream,
      record: this.record,
      stats: this.stats,
      sources: this.sources,
      pressure: pressureOf(this.stats, this.stream),
      alerts: [],
      events: this.events,
      logFile: log.file,
      history: this.history,
    };
  }

  get everConnectedOnce(): boolean {
    return this.everConnected;
  }

  get sawStreamingOnce(): boolean {
    return this.sawStreaming;
  }

  get didExitCleanly(): boolean {
    return this.exitStarted;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.obsState = this.everConnected ? "disconnected" : "connecting";
    this.exitStarted = false;
    try {
      await this.obs.connect(this.url, this.password || undefined, {
        eventSubscriptions:
          EventSubscription.General |
          EventSubscription.Outputs |
          EventSubscription.Scenes |
          EventSubscription.Inputs,
        rpcVersion: 1,
      });
      this.everConnected = true;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.lastError = null;
      this.obsState = "connected";
      this.renderSkip.reset();
      this.encodeSkip.reset();
      this.streamSkip.reset();
      this.pushEvent("info", `已连接 OBS (${this.url})`);
      try {
        await this.identify();
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.pushEvent("warn", `读取 OBS 信息失败: ${this.lastError}`);
      }
      await this.poll();
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.obsState = this.everConnected ? "disconnected" : "connecting";
      if (this.reconnectDelay === RECONNECT_MIN_MS) {
        this.pushEvent("error", `连接 OBS 失败: ${this.lastError}`);
      }
      this.emitSnapshot();
      this.scheduleReconnect();
    }
  }

  private handleDisconnect(message: string): void {
    if (this.stopped) return;
    if (this.obsState === "connected") {
      this.pushEvent(this.exitStarted ? "warn" : "error", message);
    }
    this.stream = emptyStream();
    this.record = emptyRecord();
    this.prevBytes = null;
    if (!this.exitStarted) this.obsState = "disconnected";
    this.emitSnapshot();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private async identify(): Promise<void> {
    const version = await this.call("GetVersion");
    this.version = version.obsVersion;
    this.websocketVersion = version.obsWebSocketVersion;
    this.platform = version.platformDescription;
    await this.refreshSlow();
  }

  private async poll(): Promise<void> {
    if (this.obsState !== "connected") {
      this.emitSnapshot();
      return;
    }
    try {
      const results = await this.obs.callBatch([
        { requestType: "GetStats" },
        { requestType: "GetStreamStatus" },
        { requestType: "GetRecordStatus" },
      ]);
      const stats = unwrap<OBSResponseTypes["GetStats"]>(results[0], "GetStats");
      const stream = unwrap<OBSResponseTypes["GetStreamStatus"]>(results[1], "GetStreamStatus");
      const record = unwrap<OBSResponseTypes["GetRecordStatus"]>(results[2], "GetRecordStatus");

      const now = Date.now();
      const bitrateKbps = this.bitrate(now, stream.outputBytes);
      const net = this.streamSkip.next(stream.outputActive, stream.outputSkippedFrames, stream.outputTotalFrames);
      const render = this.renderSkip.next(true, stats.renderSkippedFrames, stats.renderTotalFrames);
      const encode = this.encodeSkip.next(true, stats.outputSkippedFrames, stats.outputTotalFrames);
      const targetFps = this.stats.targetFps;
      const frameBudgetMs = targetFps > 0 ? 1000 / targetFps : 0;

      this.stats = {
        cpuUsage: stats.cpuUsage,
        memoryMb: stats.memoryUsage,
        fps: stats.activeFps,
        targetFps,
        renderTimeMs: stats.averageFrameRenderTime,
        frameBudgetMs,
        renderSkipped: render.skipped,
        renderTotal: render.total,
        renderSkipRate: render.rate,
        encodeSkipped: encode.skipped,
        encodeTotal: encode.total,
        encodeSkipRate: encode.rate,
        availableDiskGb: stats.availableDiskSpace / 1024,
      };
      this.stream = {
        active: stream.outputActive,
        reconnecting: stream.outputReconnecting,
        timecode: stream.outputTimecode,
        durationMs: stream.outputDuration,
        congestion: stream.outputCongestion,
        bytes: stream.outputBytes,
        bitrateKbps,
        skippedFrames: net.skipped,
        totalFrames: net.total,
        skipRate: net.rate,
      };
      this.record = {
        active: record.outputActive,
        paused: record.outputPaused,
        timecode: record.outputTimecode,
      };
      if (stream.outputActive) this.sawStreaming = true;

      this.history.push({
        ts: now,
        bitrateKbps,
        fps: stats.activeFps,
        cpuUsage: stats.cpuUsage,
        congestion: stream.outputCongestion,
        skipRate: net.rate,
        renderSkipRate: render.rate,
        encodeSkipRate: encode.rate,
      });
      if (this.history.length > HISTORY_MAX) this.history.shift();

      this.pollN += 1;
      if (this.pollN % SLOW_EVERY === 0) {
        await this.refreshSlow();
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
    this.emitSnapshot();
  }

  private async refreshSlow(): Promise<void> {
    const video = await this.call("GetVideoSettings");
    this.stats.targetFps = video.fpsNumerator / video.fpsDenominator;
    this.stats.frameBudgetMs = this.stats.targetFps > 0 ? 1000 / this.stats.targetFps : 0;
    this.canvas = `${video.baseWidth}×${video.baseHeight}`;
    this.outputRes = `${video.outputWidth}×${video.outputHeight}`;
    this.fpsLabel = `${video.fpsNumerator}/${video.fpsDenominator}`;
    const scene = await this.call("GetCurrentProgramScene");
    this.scene = scene.sceneName;
    const profile = await this.call("GetProfileList");
    this.profile = profile.currentProfileName;
    const inputs = await this.call("GetInputList");
    this.sources = (inputs.inputs as InputRow[])
      .map((input) => {
        const kind = String(input.unversionedInputKind ?? input.inputKind ?? "");
        return {
          name: String(input.inputName ?? ""),
          kind,
          group: sourceGroup(kind),
        };
      })
      .sort((a, b) => groupOrder(a.group) - groupOrder(b.group) || a.name.localeCompare(b.name, "zh"));
    try {
      const service = await this.call("GetStreamServiceSettings");
      this.streamService = service.streamServiceType;
    } catch {
      this.streamService = null;
    }
  }

  private bitrate(now: number, bytes: number): number {
    if (!this.prevBytes) {
      this.prevBytes = { ts: now, bytes };
      return 0;
    }
    const dt = (now - this.prevBytes.ts) / 1000;
    const db = bytes - this.prevBytes.bytes;
    this.prevBytes = { ts: now, bytes };
    if (dt <= 0 || db < 0) return 0;
    return (db * 8) / 1000 / dt;
  }

  private async call<T extends keyof OBSResponseTypes>(
    requestType: T,
  ): Promise<OBSResponseTypes[T]> {
    if (!READ_ONLY_REQUESTS.has(requestType)) {
      throw new Error(`blocked non-readonly OBS request: ${requestType}`);
    }
    return this.obs.call(requestType);
  }

  private pushEvent(level: MonitorEvent["level"], message: string): void {
    const event: MonitorEvent = {
      id: ++this.eventSeq,
      ts: Date.now(),
      level,
      message,
    };
    this.events.unshift(event);
    if (this.events.length > EVENTS_MAX) this.events.pop();
    this.store.append([
      {
        ts: event.ts,
        level,
        category: classifyCategory(message),
        source: "monitor",
        text: message,
      },
    ]);
    this.emit("event", event);
  }

  private emitSnapshot(): void {
    this.emit("snapshot", this.snapshot());
  }
}

class Delta {
  private base: { skipped: number; total: number } | null = null;

  reset(): void {
    this.base = null;
  }

  next(active: boolean, skipped: number, total: number): { skipped: number; total: number; rate: number } {
    if (!active) {
      this.base = null;
      return { skipped: 0, total: 0, rate: 0 };
    }
    if (!this.base) this.base = { skipped, total };
    const dSkip = Math.max(0, skipped - this.base.skipped);
    const dTotal = Math.max(0, total - this.base.total);
    return { skipped: dSkip, total: dTotal, rate: dTotal > 0 ? dSkip / dTotal : 0 };
  }
}

function sourceGroup(kind: string): ObsSource["group"] {
  const k = kind.toLowerCase();
  if (
    /dshow|av_capture|v4l2|game_capture|window_capture|monitor_capture|screen_capture|video_capture/.test(
      k,
    )
  ) {
    return "video";
  }
  if (/wasapi|coreaudio|pulse|alsa|audio_capture|mic/.test(k)) return "audio";
  return "other";
}

function groupOrder(group: ObsSource["group"]): number {
  if (group === "video") return 0;
  if (group === "audio") return 1;
  return 2;
}

function pressureOf(stats: Snapshot["stats"], stream: Snapshot["stream"]): Snapshot["pressure"] {
  const render = stats.renderSkipRate >= 0.01 || (stats.frameBudgetMs > 0 && stats.renderTimeMs > stats.frameBudgetMs * 1.1);
  const encode = stats.encodeSkipRate >= 0.01;
  const network = stream.skipRate >= 0.01 || stream.congestion >= 0.5 || stream.reconnecting;
  const count = Number(render) + Number(encode) + Number(network);
  if (count === 0) return "ok";
  if (count > 1) return "mixed";
  if (render) return "render";
  if (encode) return "encode";
  return "network";
}

function unwrap<T>(
  result: { requestStatus: { result: boolean; comment?: string }; responseData?: unknown },
  name: string,
): T {
  if (!result.requestStatus.result || result.responseData == null) {
    throw new Error(`${name} failed: ${result.requestStatus.comment ?? "no data"}`);
  }
  return result.responseData as T;
}

function emptyStream(): Snapshot["stream"] {
  return {
    active: false,
    reconnecting: false,
    timecode: "00:00:00.000",
    durationMs: 0,
    congestion: 0,
    bytes: 0,
    bitrateKbps: 0,
    skippedFrames: 0,
    totalFrames: 0,
    skipRate: 0,
  };
}

function emptyRecord(): Snapshot["record"] {
  return { active: false, paused: false, timecode: "00:00:00.000" };
}

function emptyStats(): Snapshot["stats"] {
  return {
    cpuUsage: 0,
    memoryMb: 0,
    fps: 0,
    targetFps: 0,
    renderTimeMs: 0,
    frameBudgetMs: 0,
    renderSkipped: 0,
    renderTotal: 0,
    renderSkipRate: 0,
    encodeSkipped: 0,
    encodeTotal: 0,
    encodeSkipRate: 0,
    availableDiskGb: 0,
  };
}
