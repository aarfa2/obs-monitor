import type { AlertKey, AlertSeverity, AlertState, Snapshot } from "../shared/types.ts";

export type AlertChange = {
  alert: AlertState;
};

type Rule = {
  key: AlertKey;
  severity: AlertSeverity;
  title: string;
  holdMs: number;
  condition: (snap: Snapshot, ctx: AlertContext) => boolean;
  message: (snap: Snapshot) => string;
};

export type AlertContext = {
  everConnected: boolean;
  sawStreaming: boolean;
  didExitCleanly: boolean;
};

type Track = {
  since: number;
  firing: boolean;
  notified: boolean;
};

export class AlertEngine {
  private tracks = new Map<AlertKey, Track>();
  private current = new Map<AlertKey, AlertState>();
  private lastNotifyAt = new Map<AlertKey, number>();

  constructor(
    private readonly rules: Rule[],
    private readonly cooldownMs: number,
  ) {}

  evaluate(snap: Snapshot, ctx: AlertContext): { snapshot: Snapshot; changes: AlertChange[] } {
    const now = snap.ts;
    const changes: AlertChange[] = [];

    for (const rule of this.rules) {
      const matches = rule.condition(snap, ctx);
      let track = this.tracks.get(rule.key);

      if (matches) {
        if (!track) {
          track = { since: now, firing: false, notified: false };
          this.tracks.set(rule.key, track);
        }
        const alert: AlertState = {
          key: rule.key,
          severity: rule.severity,
          status: "firing",
          title: rule.title,
          message: rule.message(snap),
          since: track.since,
          updatedAt: now,
        };
        if (!track.firing && now - track.since >= rule.holdMs) {
          track.firing = true;
          this.current.set(rule.key, alert);
          const last = this.lastNotifyAt.get(rule.key) ?? 0;
          if (now - last >= this.cooldownMs) {
            this.lastNotifyAt.set(rule.key, now);
            track.notified = true;
            changes.push({ alert });
          }
        } else if (track.firing) {
          this.current.set(rule.key, alert);
        }
      } else if (track) {
        if (track.firing && track.notified) {
          changes.push({
            alert: {
              key: rule.key,
              severity: rule.severity,
              status: "resolved",
              title: rule.title,
              message: this.current.get(rule.key)?.message ?? rule.message(snap),
              since: track.since,
              updatedAt: now,
            },
          });
        }
        this.tracks.delete(rule.key);
        this.current.delete(rule.key);
      }
    }

    return {
      snapshot: { ...snap, alerts: [...this.current.values()] },
      changes,
    };
  }
}

export function defaultRules(opts: {
  obsDisconnectHoldSec: number;
  reconnectHoldSec: number;
}): Rule[] {
  return [
    {
      key: "obs.disconnected",
      severity: "P0",
      title: "OBS 失联",
      holdMs: opts.obsDisconnectHoldSec * 1000,
      condition: (snap, ctx) =>
        ctx.everConnected &&
        !ctx.didExitCleanly &&
        (snap.obs.state === "disconnected" || snap.obs.state === "connecting"),
      message: (snap) =>
        snap.obs.lastError
          ? `OBS WebSocket 断开：${snap.obs.lastError}`
          : "OBS WebSocket 断开，且未收到正常退出事件",
    },
    {
      key: "stream.stopped",
      severity: "P0",
      title: "推流意外停止",
      holdMs: 2000,
      condition: (snap, ctx) =>
        ctx.sawStreaming &&
        snap.obs.state === "connected" &&
        !snap.stream.active &&
        !snap.stream.reconnecting,
      message: () => "此前推流在进行，现已停止",
    },
    {
      key: "stream.reconnecting",
      severity: "P1",
      title: "推流持续重连",
      holdMs: opts.reconnectHoldSec * 1000,
      condition: (snap) => snap.obs.state === "connected" && snap.stream.reconnecting,
      message: (snap) => `输出处于重连状态（拥塞 ${snap.stream.congestion.toFixed(2)}）`,
    },
  ];
}
