import type { QualityInterval, QualityKind, Snapshot } from "../shared/types.ts";
import type { QualityStore } from "./store.ts";

export const QUALITY_KINDS: QualityKind[] = [
  "bitrate.over",
  "bitrate.under",
  "pressure.render",
  "pressure.encode",
  "pressure.network",
  "pressure.mixed",
];

export type QualityChange = {
  interval: QualityInterval;
  status: "opened" | "closed";
};

type Track = {
  pendingSince: number;
  intervalId: number | null;
  peakKbps: number;
  minKbps: number;
  sumKbps: number;
  samples: number;
};

export class QualityTracker {
  private machines = new Map<string, Map<QualityKind, Track>>();

  constructor(
    private readonly store: QualityStore,
    private readonly minKbps: number,
    private readonly maxKbps: number,
    private readonly holdMs: number,
  ) {}

  observe(machineId: string, snap: Snapshot): QualityChange[] {
    const changes: QualityChange[] = [];
    if (!snap.stream.active) {
      return this.closeMachine(machineId, snap.ts);
    }

    const active = activeKinds(snap, this.minKbps, this.maxKbps);
    const tracks = this.tracksFor(machineId);
    const kbps = snap.stream.bitrateKbps;

    for (const kind of QUALITY_KINDS) {
      const on = active.has(kind);
      let track = tracks.get(kind);
      if (on) {
        if (!track) {
          track = newTrack(snap.ts, kbps);
          const existing = this.store.findOpen(machineId, kind);
          if (existing) {
            track.intervalId = existing.id;
            track.pendingSince = existing.startedAt;
            track.peakKbps = Math.max(existing.peakKbps, kbps);
            track.minKbps = Math.min(existing.minKbps, kbps);
            track.sumKbps = existing.avgKbps * Math.max(existing.samples, 1) + kbps;
            track.samples = existing.samples + 1;
          }
          tracks.set(kind, track);
        } else {
          noteSample(track, kbps);
          if (track.intervalId != null) this.persistLive(track);
        }
        if (track.intervalId == null && snap.ts - track.pendingSince >= this.holdMs) {
          const opened = this.store.open({
            machineId,
            kind,
            startedAt: track.pendingSince,
            peakKbps: track.peakKbps,
            minKbps: track.minKbps,
            avgKbps: avg(track),
            samples: track.samples,
          });
          track.intervalId = opened.id;
          changes.push({ interval: opened, status: "opened" });
        }
      } else if (track) {
        const closed = this.finish(track, snap.ts);
        tracks.delete(kind);
        if (closed) changes.push({ interval: closed, status: "closed" });
      }
    }
    return changes;
  }

  closeMachine(machineId: string, ts: number): QualityChange[] {
    const tracks = this.machines.get(machineId);
    if (!tracks) return this.store.closeMachine(machineId, ts).map((interval) => ({ interval, status: "closed" as const }));
    const changes: QualityChange[] = [];
    for (const track of tracks.values()) {
      const closed = this.finish(track, ts);
      if (closed) changes.push({ interval: closed, status: "closed" });
    }
    this.machines.delete(machineId);
    return changes;
  }

  private tracksFor(machineId: string): Map<QualityKind, Track> {
    let tracks = this.machines.get(machineId);
    if (!tracks) {
      tracks = new Map();
      this.machines.set(machineId, tracks);
    }
    return tracks;
  }

  private persistLive(track: Track): void {
    if (track.intervalId == null) return;
    this.store.update(track.intervalId, {
      peakKbps: track.peakKbps,
      minKbps: track.minKbps,
      avgKbps: avg(track),
      samples: track.samples,
    });
  }

  private finish(track: Track, ts: number): QualityInterval | null {
    this.persistLive(track);
    if (track.intervalId == null) return null;
    return this.store.close(track.intervalId, ts);
  }
}

export function activeKinds(snap: Snapshot, minKbps: number, maxKbps: number): Set<QualityKind> {
  const kinds = new Set<QualityKind>();
  if (!snap.stream.active) return kinds;
  if (snap.stream.bitrateKbps > maxKbps) kinds.add("bitrate.over");
  else if (snap.stream.bitrateKbps < minKbps) kinds.add("bitrate.under");
  if (snap.pressure === "render") kinds.add("pressure.render");
  if (snap.pressure === "encode") kinds.add("pressure.encode");
  if (snap.pressure === "network") kinds.add("pressure.network");
  if (snap.pressure === "mixed") kinds.add("pressure.mixed");
  return kinds;
}

export function notifies(kind: QualityKind): boolean {
  return kind === "bitrate.over";
}

function newTrack(ts: number, kbps: number): Track {
  return {
    pendingSince: ts,
    intervalId: null,
    peakKbps: kbps,
    minKbps: kbps,
    sumKbps: kbps,
    samples: 1,
  };
}

function noteSample(track: Track, kbps: number): void {
  track.peakKbps = Math.max(track.peakKbps, kbps);
  track.minKbps = Math.min(track.minKbps, kbps);
  track.sumKbps += kbps;
  track.samples += 1;
}

function avg(track: Track): number {
  return track.samples > 0 ? track.sumKbps / track.samples : 0;
}
