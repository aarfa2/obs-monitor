import type { FleetMachine, Snapshot } from "../shared/types.ts";

const STALE_DEFAULT = 15_000;

type Slot = {
  machineId: string;
  displayName: string;
  hostname: string;
  snapshot: Snapshot | null;
  lastSeen: number;
  connected: boolean;
  staleSince: number | null;
};

export class FleetRegistry {
  private slots = new Map<string, Slot>();

  constructor(
    private readonly staleMs = STALE_DEFAULT,
    private readonly quality = { minKbps: 2000, maxKbps: 3100 },
  ) {}

  hello(machineId: string, displayName: string, hostname: string): boolean {
    const prev = this.slots.get(machineId);
    const recovered = Boolean(prev && prev.staleSince != null);
    this.slots.set(machineId, {
      machineId,
      displayName,
      hostname,
      snapshot: prev?.snapshot ?? null,
      lastSeen: Date.now(),
      connected: true,
      staleSince: null,
    });
    return recovered;
  }

  snapshot(machineId: string, snapshot: Snapshot): void {
    const slot = this.slots.get(machineId);
    if (!slot) return;
    slot.snapshot = {
      ...snapshot,
      machine: {
        machineId,
        displayName: slot.displayName,
        hostname: slot.hostname,
      },
    };
    slot.lastSeen = Date.now();
    slot.connected = true;
    slot.staleSince = null;
  }

  disconnect(machineId: string): void {
    const slot = this.slots.get(machineId);
    if (!slot) return;
    slot.connected = false;
    slot.lastSeen = Date.now();
  }

  get(machineId: string): Slot | undefined {
    return this.slots.get(machineId);
  }

  summaries(): FleetMachine[] {
    const now = Date.now();
    const rows = [...this.slots.values()].map((slot) => this.toSummary(slot, now));
    rows.sort((a, b) => rank(a) - rank(b) || a.displayName.localeCompare(b.displayName, "zh"));
    return rows;
  }

  markStale(): Array<{ slot: Slot; becameStale: boolean }> {
    const now = Date.now();
    const out: Array<{ slot: Slot; becameStale: boolean }> = [];
    for (const slot of this.slots.values()) {
      const stale = !slot.connected || now - slot.lastSeen >= this.staleMs;
      if (stale && slot.staleSince == null) {
        slot.staleSince = now;
        out.push({ slot, becameStale: true });
      }
      if (!stale) slot.staleSince = null;
    }
    return out;
  }

  private toSummary(slot: Slot, now: number): FleetMachine {
    const online = slot.connected && now - slot.lastSeen < this.staleMs;
    const snap = slot.snapshot;
    return {
      machineId: slot.machineId,
      displayName: slot.displayName,
      hostname: slot.hostname,
      online,
      lastSeen: slot.lastSeen,
      obsState: online ? (snap?.obs.state ?? "connecting") : "offline",
      streaming: Boolean(online && snap?.stream.active),
      reconnecting: Boolean(online && snap?.stream.reconnecting),
      recording: Boolean(online && snap?.record.active),
      pressure: online ? (snap?.pressure ?? "ok") : "offline",
      alertCount: snap?.alerts.length ?? 0,
      videoSources: snap?.sources.filter((s) => s.group === "video").length ?? 0,
      bitrateKbps: snap?.stream.bitrateKbps ?? 0,
      bitrateBand: liveBand(online && snap?.stream.active ? snap.stream.bitrateKbps : null, this.quality),
      cpuUsage: snap?.stats.cpuUsage ?? 0,
      lastError: snap?.obs.lastError ?? null,
    };
  }
}

function liveBand(kbps: number | null, quality: { minKbps: number; maxKbps: number }): "ok" | "over" | "under" {
  if (kbps == null) return "ok";
  if (kbps > quality.maxKbps) return "over";
  if (kbps < quality.minKbps) return "under";
  return "ok";
}

function rank(row: FleetMachine): number {
  if (!row.online) return 0;
  if (row.reconnecting || row.alertCount > 0) return 1;
  if (row.pressure !== "ok" || row.bitrateBand === "over") return 2;
  if (!row.streaming) return 3;
  return 4;
}
