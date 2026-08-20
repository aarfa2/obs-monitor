import { useEffect, useMemo, useState } from "react";
import type {
  HistoryPoint,
  HubToBrowser,
  LogCategory,
  LogLevel,
  LogQueryResult,
  Snapshot,
} from "../../src/shared/types.ts";
import { FleetPage } from "./Fleet";
import { monitorWsUrl } from "./wsUrl";

function useRoute(): { page: "fleet" } | { page: "machine"; id: string } {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (hash.startsWith("#/m/")) {
    return { page: "machine", id: decodeURIComponent(hash.slice(4)) };
  }
  return { page: "fleet" };
}

export function App() {
  const route = useRoute();
  if (route.page === "machine") return <MachineView machineId={route.id} />;
  return <FleetPage />;
}

function MachineView({ machineId }: { machineId: string }) {
  const { snap, uiConnected } = useSnapshot(machineId);
  const [webhookOk, setWebhookOk] = useState<boolean | null>(null);
  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "fail">("idle");

  useEffect(() => {
    void fetch("/api/health")
      .then((res) => res.json())
      .then((data: { webhookConfigured?: boolean }) => setWebhookOk(Boolean(data.webhookConfigured)))
      .catch(() => setWebhookOk(null));
  }, []);

  async function testWebhook() {
    setTestState("sending");
    try {
      const res = await fetch("/api/alerts/test", { method: "POST" });
      setTestState(res.ok ? "sent" : "fail");
    } catch {
      setTestState("fail");
    }
    window.setTimeout(() => setTestState("idle"), 2500);
  }

  if (!snap) {
    return (
      <div className="boot">
        <p>
          <a className="back" href="#/">
            返回机群
          </a>
        </p>
        <p>{uiConnected ? "这台采集器还没有上报快照…" : "正在连接监控中心…"}</p>
      </div>
    );
  }

  const streaming = snap.obs.state === "connected" && snap.stream.active;

  return (
    <div className="page">
      <header className="top">
        <div>
          <p className="kicker">
            <a className="back" href="#/">
              机群
            </a>
          </p>
          <h1>{snap.machine?.displayName ?? "OBS 单机"}</h1>
        </div>
        <div className="tally-row">
          <Tally on={uiConnected} label={uiConnected ? "看板已连接" : "看板断线"} />
          <Tally on={snap.obs.state === "connected"} label={obsStateLabel(snap.obs.state)} />
          <Tally on={streaming} warn={snap.stream.reconnecting} label={streamStateLabel(snap)} />
          <Tally on={snap.record.active} warn={snap.record.paused} label={recordLabel(snap)} />
        </div>
        <div className="top-meta">
          <span>{snap.obs.version ? `OBS ${snap.obs.version}` : "OBS 未连接"}</span>
          <span>{snap.obs.scene ?? "无场景"}</span>
          <span>{snap.machine?.hostname}</span>
          <span className="clock">{formatClock(snap.ts)}</span>
          <button type="button" onClick={() => void testWebhook()} disabled={testState === "sending" || webhookOk === false}>
            {testLabel(testState, webhookOk)}
          </button>
        </div>
      </header>

      <p className={`verdict ${snap.pressure}`}>{pressureText(snap)}</p>

      {snap.alerts.length > 0 && (
        <section className="alarms">
          {snap.alerts.map((alert) => (
            <article key={alert.key} className={alert.severity === "P0" ? "alarm p0" : "alarm p1"}>
              <strong>
                {alert.severity} {alert.title}
              </strong>
              <span>{alert.message}</span>
            </article>
          ))}
        </section>
      )}

      {snap.obs.lastError && snap.obs.state !== "connected" && (
        <p className="error-line">{snap.obs.lastError}</p>
      )}

      <section className="metrics">
        <Metric label="码率" value={formatBitrate(snap.stream.bitrateKbps)} series={pick(snap.history, "bitrateKbps")} />
        <Metric
          label="帧率"
          value={`${snap.stats.fps.toFixed(1)} / ${snap.stats.targetFps ? snap.stats.targetFps.toFixed(0) : "—"}`}
          series={pick(snap.history, "fps")}
        />
        <Metric
          label="拥塞"
          value={snap.stream.congestion.toFixed(2)}
          sub="0 畅通 · 1 堵死"
          tone={snap.stream.congestion >= 0.5 ? "warn" : undefined}
          series={pick(snap.history, "congestion")}
        />
        <Metric
          label="OBS CPU"
          value={`${snap.stats.cpuUsage.toFixed(1)}%`}
          sub={`内存 ${snap.stats.memoryMb.toFixed(0)} MB · 无 GPU% 接口`}
          series={pick(snap.history, "cpuUsage")}
        />
        <Metric
          label="渲染掉帧"
          value={pct(snap.stats.renderSkipRate)}
          sub={`${snap.stats.renderSkipped} / ${snap.stats.renderTotal} · 合成/显卡压力`}
          tone={snap.stats.renderSkipRate >= 0.01 ? "warn" : undefined}
          series={pick(snap.history, "renderSkipRate")}
        />
        <Metric
          label="编码掉帧"
          value={pct(snap.stats.encodeSkipRate)}
          sub={`${snap.stats.encodeSkipped} / ${snap.stats.encodeTotal} · 编码器过载`}
          tone={snap.stats.encodeSkipRate >= 0.01 ? "warn" : undefined}
          series={pick(snap.history, "encodeSkipRate")}
        />
        <Metric
          label="网络丢帧"
          value={pct(snap.stream.skipRate)}
          sub={`${snap.stream.skippedFrames} / ${snap.stream.totalFrames} · 上行不够`}
          tone={snap.stream.skipRate >= 0.01 ? "warn" : undefined}
          series={pick(snap.history, "skipRate")}
        />
        <Metric
          label="帧耗时"
          value={`${snap.stats.renderTimeMs.toFixed(2)} ms`}
          sub={
            snap.stats.frameBudgetMs
              ? `预算 ${snap.stats.frameBudgetMs.toFixed(1)} ms / 帧`
              : "尚未读取目标帧率"
          }
          tone={
            snap.stats.frameBudgetMs > 0 && snap.stats.renderTimeMs > snap.stats.frameBudgetMs * 1.1
              ? "warn"
              : undefined
          }
        />
      </section>

      <section className="mid">
        <div className="panel">
          <h2>会话</h2>
          <dl className="kv">
            <div>
              <dt>画布</dt>
              <dd>{snap.video.canvas}</dd>
            </div>
            <div>
              <dt>输出</dt>
              <dd>{snap.video.output} @ {snap.video.fps}</dd>
            </div>
            <div>
              <dt>配置</dt>
              <dd>{snap.obs.profile ?? "—"}</dd>
            </div>
            <div>
              <dt>推流服务</dt>
              <dd>{snap.video.streamService ?? "—"}</dd>
            </div>
            <div>
              <dt>推流时长</dt>
              <dd>{snap.stream.timecode}</dd>
            </div>
            <div>
              <dt>已发送</dt>
              <dd>{formatBytes(snap.stream.bytes)}</dd>
            </div>
            <div>
              <dt>录像</dt>
              <dd>{recordLabel(snap)} {snap.record.active ? snap.record.timecode : ""}</dd>
            </div>
            <div>
              <dt>磁盘剩余</dt>
              <dd>{snap.stats.availableDiskGb.toFixed(1)} GB</dd>
            </div>
            <div>
              <dt>系统</dt>
              <dd>{snap.obs.platform ?? "—"}</dd>
            </div>
          </dl>
        </div>
        <div className="panel">
          <h2>
            当前源
            {snap.sources.length > 0 && (
              <span className="h2-meta">
                视频 {snap.sources.filter((s) => s.group === "video").length} · 音频{" "}
                {snap.sources.filter((s) => s.group === "audio").length} · 其它{" "}
                {snap.sources.filter((s) => s.group === "other").length}
              </span>
            )}
          </h2>
          {snap.sources.length === 0 ? (
            <p className="muted">未读到源列表</p>
          ) : (
            <ul className="sources">
              {snap.sources.map((source) => (
                <li key={`${source.group}-${source.kind}-${source.name}`}>
                  <span>{source.name}</span>
                  <small>
                    {groupLabel(source.group)} · {source.kind}
                  </small>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <LogExplorer machineId={machineId} logFile={snap.logFile} />
    </div>
  );
}

const CATEGORY_TABS: Array<{ id: LogCategory | ""; label: string }> = [
  { id: "", label: "全部" },
  { id: "connection", label: "连接" },
  { id: "encoder", label: "编码" },
  { id: "render", label: "渲染" },
  { id: "audio", label: "音频" },
  { id: "source", label: "源" },
  { id: "system", label: "系统" },
  { id: "alert", label: "报警" },
  { id: "other", label: "其它" },
];

const LEVEL_TABS: Array<{ id: LogLevel | ""; label: string }> = [
  { id: "", label: "全部级别" },
  { id: "error", label: "错误" },
  { id: "warn", label: "警告" },
  { id: "info", label: "信息" },
];

function LogExplorer({ machineId, logFile }: { machineId: string; logFile: string | null }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState<LogCategory | "">("");
  const [level, setLevel] = useState<LogLevel | "">("");
  const [result, setResult] = useState<LogQueryResult | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(q), 250);
    return () => window.clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const params = new URLSearchParams();
      if (debounced) params.set("q", debounced);
      if (category) params.set("category", category);
      if (level) params.set("level", level);
      params.set("machineId", machineId);
      params.set("limit", "300");
      void fetch(`/api/logs?${params}`)
        .then((res) => res.json() as Promise<LogQueryResult>)
        .then((data) => {
          if (!cancelled) setResult(data);
        })
        .catch(() => {
          /* keep last */
        });
    };
    load();
    const timer = window.setInterval(load, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [debounced, category, level, machineId]);

  const allCount = result ? Object.values(result.counts).reduce((sum, n) => sum + n, 0) : 0;

  return (
    <section className="panel log explorer">
      <div className="log-head">
        <h2>日志 · 近 24 小时</h2>
        <input
          className="log-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索关键字，例如 nvenc、disconnected、静音"
        />
      </div>
      <div className="log-tools wrap">
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.label}
            type="button"
            className={category === tab.id ? "on" : ""}
            onClick={() => setCategory(tab.id)}
          >
            {tab.label}
            {result ? ` ${tab.id ? result.counts[tab.id] : allCount}` : ""}
          </button>
        ))}
      </div>
      <div className="log-tools">
        {LEVEL_TABS.map((tab) => (
          <button key={tab.label} type="button" className={level === tab.id ? "on" : ""} onClick={() => setLevel(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>
      <p className="log-file">
        保留 24 小时后自动删除。网页最多列出 {result?.shown ?? 0} / {result?.total ?? 0} 条。
        {logFile ? ` 正在读取 ${logFile}` : " 未找到 OBS 日志目录"}
      </p>
      <ul>
        {!result && <li className="muted">正在加载日志…</li>}
        {result && result.lines.length === 0 && <li className="muted">没有匹配的日志</li>}
        {result?.lines.map((line) => (
          <li key={line.id} className={line.level}>
            <time>{formatLogTime(line.ts)}</time>
            <span className="cat">{categoryLabel(line.category)}</span>
            <span className="log-text">{line.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Tally({ on, warn, label }: { on: boolean; warn?: boolean; label: string }) {
  const cls = warn ? "tally warn" : on ? "tally live" : "tally off";
  return (
    <span className={cls}>
      <i />
      {label}
    </span>
  );
}

function Metric({
  label,
  value,
  sub,
  series,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  series?: number[];
  tone?: "warn";
}) {
  return (
    <article className={tone === "warn" ? "metric warn" : "metric"}>
      <p className="metric-label">{label}</p>
      <p className="metric-value">{value}</p>
      {sub && <p className="metric-sub">{sub}</p>}
      {series && series.length > 1 && <Sparkline values={series} />}
    </article>
  );
}

function Sparkline({ values }: { values: number[] }) {
  const d = useMemo(() => pathFrom(values), [values]);
  return (
    <svg className="spark" viewBox="0 0 120 28" preserveAspectRatio="none" aria-hidden>
      <path d={d} />
    </svg>
  );
}

function pathFrom(values: number[]): string {
  const max = Math.max(...values, 0.0001);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 120;
      const y = 26 - ((v - min) / span) * 24;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function useSnapshot(machineId: string) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [uiConnected, setUiConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: number | undefined;

    const connect = () => {
      if (closed) return;
      ws = new WebSocket(monitorWsUrl());
      ws.onopen = () => {
        setUiConnected(true);
        ws?.send(JSON.stringify({ type: "watch", machineId }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as HubToBrowser;
        if (msg.type === "snapshot" && msg.machineId === machineId) setSnap(msg.payload);
      };
      ws.onclose = () => {
        setUiConnected(false);
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      ws?.close();
    };
  }, [machineId]);

  return { snap, uiConnected };
}

function pick(history: HistoryPoint[], key: keyof HistoryPoint): number[] {
  return history.map((p) => Number(p[key]));
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

function obsStateLabel(state: Snapshot["obs"]["state"]): string {
  if (state === "connected") return "OBS 在线";
  if (state === "exited") return "OBS 已退出";
  if (state === "connecting") return "正在连接 OBS";
  return "OBS 离线";
}

function streamStateLabel(snap: Snapshot): string {
  if (snap.stream.reconnecting) return "推流重连中";
  if (snap.stream.active) return "推流中";
  return "未推流";
}

function recordLabel(snap: Snapshot): string {
  if (snap.record.paused) return "录像暂停";
  if (snap.record.active) return "录像中";
  return "未录像";
}

function pressureText(snap: Snapshot): string {
  switch (snap.pressure) {
    case "render":
      return "压力在渲染：合成跟不上（场景过重/浏览器源/滤镜）。OBS 不提供 GPU%，这项比 GPU 占用更有用。";
    case "encode":
      return "压力在编码：编码器过载，可降分辨率、码率或换 NVENC/QSV。";
    case "network":
      return "压力在网络：拥塞或丢帧，多半是上行不够或服务器在重连。";
    case "mixed":
      return "多处同时告警：渲染 / 编码 / 网络不止一项偏高，先看掉帧最高的那一列。";
    default:
      return "当前正常。OBS WebSocket 没有 GPU 占用；卡顿请看渲染掉帧、编码掉帧、网络丢帧三列。";
  }
}

function formatBitrate(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mbps`;
  return `${kbps.toFixed(0)} kbps`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

function formatLogTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function categoryLabel(category: LogCategory): string {
  return CATEGORY_TABS.find((tab) => tab.id === category)?.label ?? category;
}

function groupLabel(group: "video" | "audio" | "other"): string {
  if (group === "video") return "视频";
  if (group === "audio") return "音频";
  return "其它";
}

function testLabel(state: "idle" | "sending" | "sent" | "fail", webhookOk: boolean | null): string {
  if (webhookOk === false) return "未配置 Webhook";
  if (state === "sending") return "发送中…";
  if (state === "sent") return "已发送";
  if (state === "fail") return "发送失败";
  return "测试 Webhook";
}
