import { useEffect, useState } from "react";
import type { FleetMachine, HubToBrowser } from "../../src/shared/types.ts";
import { monitorWsUrl } from "./wsUrl";

export function FleetPage() {
  const { fleet, connected } = useFleet();
  const [webhookOk, setWebhookOk] = useState<boolean | null>(null);
  const [testState, setTestState] = useState<"idle" | "sending" | "sent" | "fail">("idle");

  useEffect(() => {
    void fetch("/api/health")
      .then((res) => res.json())
      .then((data: { webhookConfigured?: boolean }) => setWebhookOk(Boolean(data.webhookConfigured)))
      .catch(() => setWebhookOk(null));
  }, []);

  const online = fleet.filter((m) => m.online).length;
  const streaming = fleet.filter((m) => m.streaming).length;
  const alarms = fleet.filter((m) => !m.online || m.reconnecting || m.alertCount > 0).length;

  return (
    <div className="page">
      <header className="top fleet-top">
        <div>
          <p className="kicker">LAN FLEET</p>
          <h1>OBS 机群</h1>
        </div>
        <div className="tally-row">
          <span className="tally live">
            <i />
            在线 {online}/{fleet.length}
          </span>
          <span className="tally live">
            <i />
            推流 {streaming}
          </span>
          <span className={alarms ? "tally off" : "tally live"}>
            <i />
            异常 {alarms}
          </span>
          <span className={connected ? "tally live" : "tally off"}>
            <i />
            {connected ? "中心已连接" : "中心断线"}
          </span>
        </div>
        <div className="top-meta">
          <button
            type="button"
            disabled={testState === "sending" || webhookOk === false}
            onClick={() => {
              setTestState("sending");
              void fetch("/api/alerts/test", { method: "POST" })
                .then((res) => setTestState(res.ok ? "sent" : "fail"))
                .catch(() => setTestState("fail"))
                .finally(() => window.setTimeout(() => setTestState("idle"), 2000));
            }}
          >
            {webhookOk === false ? "未配置 Webhook" : testState === "idle" ? "测试 Webhook" : testState === "sending" ? "发送中…" : testState === "sent" ? "已发送" : "失败"}
          </button>
        </div>
      </header>

      {fleet.length === 0 ? (
        <p className="verdict">还没有采集器接入。在 OBS 电脑上运行采集器，指向本中心的 ws://IP:8787/agent。</p>
      ) : (
        <section className="fleet-grid">
          {fleet.map((machine) => (
            <a key={machine.machineId} className={`fleet-card ${cardTone(machine)}`} href={`#/m/${encodeURIComponent(machine.machineId)}`}>
              <div className="fleet-card-head">
                <strong>{machine.displayName}</strong>
                <span>{statusLabel(machine)}</span>
              </div>
              <p className="muted">{machine.hostname}</p>
              <dl className="fleet-kv">
                <div>
                  <dt>推流</dt>
                  <dd>{machine.streaming ? `${formatBitrate(machine.bitrateKbps)}` : machine.reconnecting ? "重连" : "未推"}</dd>
                </div>
                <div>
                  <dt>压力</dt>
                  <dd>{pressureLabel(machine)}</dd>
                </div>
                <div>
                  <dt>视频源</dt>
                  <dd>{machine.videoSources}</dd>
                </div>
                <div>
                  <dt>CPU</dt>
                  <dd>{machine.online ? `${machine.cpuUsage.toFixed(0)}%` : "—"}</dd>
                </div>
              </dl>
              {machine.lastError && !machine.online && <p className="error-line">{machine.lastError}</p>}
            </a>
          ))}
        </section>
      )}
    </div>
  );
}

function useFleet() {
  const [fleet, setFleet] = useState<FleetMachine[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: number | undefined;
    const connect = () => {
      if (closed) return;
      ws = new WebSocket(monitorWsUrl());
      ws.onopen = () => {
        setConnected(true);
        ws?.send(JSON.stringify({ type: "watch" }));
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data) as HubToBrowser;
        if (msg.type === "fleet") setFleet(msg.payload);
      };
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) window.clearTimeout(retry);
      ws?.close();
    };
  }, []);

  return { fleet, connected };
}

function cardTone(machine: FleetMachine): string {
  if (!machine.online) return "bad";
  if (machine.reconnecting || machine.alertCount > 0) return "hot";
  if (machine.pressure !== "ok") return "hot";
  return "ok";
}

function statusLabel(machine: FleetMachine): string {
  if (!machine.online) return "离线";
  if (machine.reconnecting) return "重连";
  if (machine.streaming) return "推流中";
  return "在线";
}

function pressureLabel(machine: FleetMachine): string {
  if (!machine.online) return "离线";
  if (machine.pressure === "ok") return "正常";
  if (machine.pressure === "render") return "渲染";
  if (machine.pressure === "encode") return "编码";
  if (machine.pressure === "network") return "网络";
  if (machine.pressure === "mixed") return "多项";
  return machine.pressure;
}

function formatBitrate(kbps: number): string {
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(2)} Mbps`;
  return `${kbps.toFixed(0)} kbps`;
}
