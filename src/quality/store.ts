import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { QualityInterval, QualityKind, QualityQueryResult, QualityStats } from "../shared/types.ts";

const RETAIN_MS = 24 * 60 * 60 * 1000;
const MAX_ROWS = 20_000;
const COMPACT_MS = 5 * 60 * 1000;

export class QualityStore {
  private rows: QualityInterval[] = [];
  private seq = 0;
  private compactTimer: ReturnType<typeof setInterval> | null = null;
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "quality-24h.jsonl");
    mkdirSync(dataDir, { recursive: true });
    this.load();
    this.pruneMemory();
    this.compact();
    this.compactTimer = setInterval(() => this.compact(), COMPACT_MS);
  }

  stop(): void {
    if (this.compactTimer) clearInterval(this.compactTimer);
    this.compact();
  }

  open(input: Omit<QualityInterval, "id" | "endedAt" | "durationMs">): QualityInterval {
    const row: QualityInterval = {
      ...input,
      id: ++this.seq,
      endedAt: null,
      durationMs: 0,
    };
    this.rows.push(row);
    this.pruneMemory();
    return row;
  }

  update(id: number, patch: Partial<Pick<QualityInterval, "peakKbps" | "minKbps" | "avgKbps" | "samples">>): void {
    const row = this.rows.find((item) => item.id === id);
    if (!row || row.endedAt != null) return;
    Object.assign(row, patch);
  }

  close(id: number, endedAt: number): QualityInterval | null {
    const row = this.rows.find((item) => item.id === id);
    if (!row || row.endedAt != null) return null;
    row.endedAt = endedAt;
    row.durationMs = Math.max(0, endedAt - row.startedAt);
    return row;
  }

  closeMachine(machineId: string, endedAt: number): QualityInterval[] {
    const closed: QualityInterval[] = [];
    for (const row of this.rows) {
      if (row.machineId !== machineId || row.endedAt != null) continue;
      const done = this.close(row.id, endedAt);
      if (done) closed.push(done);
    }
    return closed;
  }

  closeAllOpen(endedAt: number): void {
    for (const row of this.rows) {
      if (row.endedAt == null) this.close(row.id, endedAt);
    }
  }

  findOpen(machineId: string, kind: QualityKind): QualityInterval | undefined {
    return this.rows.find((row) => row.machineId === machineId && row.kind === kind && row.endedAt == null);
  }

  openKinds(machineId: string): Set<QualityKind> {
    const kinds = new Set<QualityKind>();
    for (const row of this.rows) {
      if (row.machineId === machineId && row.endedAt == null) kinds.add(row.kind);
    }
    return kinds;
  }

  query(
    machineId: string,
    opts: { minKbps: number; maxKbps: number; holdSec: number },
  ): QualityQueryResult {
    this.pruneMemory();
    const now = Date.now();
    const matched = this.rows
      .filter((row) => row.machineId === machineId)
      .map((row) => hydrate(row, now))
      .sort((a, b) => b.startedAt - a.startedAt);
    return {
      minKbps: opts.minKbps,
      maxKbps: opts.maxKbps,
      holdSec: opts.holdSec,
      retainedHours: 24,
      stats: summarize(matched),
      intervals: matched.slice(0, 200),
    };
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, "utf8");
    const cutoff = Date.now() - RETAIN_MS;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as QualityInterval;
        if (row.startedAt >= cutoff) {
          this.rows.push(row);
          if (row.id > this.seq) this.seq = row.id;
        }
      } catch {
        /* skip bad row */
      }
    }
  }

  private pruneMemory(): void {
    const cutoff = Date.now() - RETAIN_MS;
    if (this.rows[0] && this.rows[0].startedAt < cutoff) {
      this.rows = this.rows.filter((row) => row.startedAt >= cutoff);
    }
    if (this.rows.length > MAX_ROWS) this.rows = this.rows.slice(-MAX_ROWS);
  }

  private compact(): void {
    this.pruneMemory();
    const tmp = `${this.file}.tmp`;
    const body = this.rows.map((row) => JSON.stringify(row)).join("\n");
    writeFileSync(tmp, body ? `${body}\n` : "", "utf8");
    try {
      unlinkSync(this.file);
    } catch {
      /* first compact */
    }
    try {
      renameSync(tmp, this.file);
    } catch {
      writeFileSync(this.file, body ? `${body}\n` : "", "utf8");
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
}

function hydrate(row: QualityInterval, now: number): QualityInterval {
  const endedAt = row.endedAt;
  return {
    ...row,
    durationMs: Math.max(0, (endedAt ?? now) - row.startedAt),
  };
}

function summarize(rows: QualityInterval[]): QualityStats {
  const stats: QualityStats = {
    overCount: 0,
    overMs: 0,
    underCount: 0,
    underMs: 0,
    pressureCount: 0,
    pressureMs: 0,
  };
  for (const row of rows) {
    if (row.kind === "bitrate.over") {
      stats.overCount += 1;
      stats.overMs += row.durationMs;
    } else if (row.kind === "bitrate.under") {
      stats.underCount += 1;
      stats.underMs += row.durationMs;
    } else {
      stats.pressureCount += 1;
      stats.pressureMs += row.durationMs;
    }
  }
  return stats;
}
