import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import type { LogCategory, LogLineInput, LogQuery, LogQueryResult, StoredLog } from "../shared/types.ts";

const RETAIN_MS = 24 * 60 * 60 * 1000;
const MAX_LINES = 200_000;
const COMPACT_MS = 5 * 60 * 1000;

export class LogStore {
  private lines: StoredLog[] = [];
  private seq = 0;
  private compactTimer: ReturnType<typeof setInterval> | null = null;
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "logs-24h.jsonl");
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

  append(machineId: string, entries: LogLineInput[]): StoredLog[] {
    if (entries.length === 0) return [];
    const added: StoredLog[] = [];
    const rows: string[] = [];
    const cutoff = Date.now() - RETAIN_MS;
    for (const entry of entries) {
      if (entry.ts < cutoff) continue;
      const row: StoredLog = { ...entry, id: ++this.seq, machineId };
      this.lines.push(row);
      added.push(row);
      rows.push(JSON.stringify(row));
    }
    if (rows.length > 0) appendFileSync(this.file, `${rows.join("\n")}\n`, "utf8");
    this.pruneMemory();
    return added;
  }

  query(q: LogQuery): LogQueryResult {
    this.pruneMemory();
    const needle = q.q.trim().toLowerCase();
    const matched = this.lines.filter((line) => {
      if (line.machineId !== q.machineId) return false;
      if (q.level && line.level !== q.level) return false;
      if (q.category && line.category !== q.category) return false;
      if (needle && !line.text.toLowerCase().includes(needle)) return false;
      return true;
    });
    const counts = emptyCounts();
    for (const line of this.lines) {
      if (line.machineId === q.machineId) counts[line.category] += 1;
    }
    const limit = Math.min(Math.max(q.limit, 1), 500);
    const newestFirst = matched.slice(-limit).reverse();
    return {
      total: matched.length,
      retainedHours: 24,
      shown: newestFirst.length,
      counts,
      lines: newestFirst,
    };
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    const raw = readFileSync(this.file, "utf8");
    const cutoff = Date.now() - RETAIN_MS;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as StoredLog;
        if (row.ts >= cutoff) {
          this.lines.push(row);
          if (row.id > this.seq) this.seq = row.id;
        }
      } catch {
        /* skip bad row */
      }
    }
  }

  private pruneMemory(): void {
    const cutoff = Date.now() - RETAIN_MS;
    if (this.lines[0] && this.lines[0].ts < cutoff) {
      this.lines = this.lines.filter((line) => line.ts >= cutoff);
    }
    if (this.lines.length > MAX_LINES) {
      this.lines = this.lines.slice(-MAX_LINES);
    }
  }

  private compact(): void {
    this.pruneMemory();
    const tmp = `${this.file}.tmp`;
    const body = this.lines.map((line) => JSON.stringify(line)).join("\n");
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

function emptyCounts(): Record<LogCategory, number> {
  return {
    connection: 0,
    encoder: 0,
    render: 0,
    audio: 0,
    source: 0,
    system: 0,
    alert: 0,
    other: 0,
  };
}

export function cursorPath(dataDir: string): string {
  return join(dataDir, "log-cursor.json");
}

export type LogCursor = { file: string | null; offset: number };

export function readCursor(dataDir: string): LogCursor {
  const path = cursorPath(dataDir);
  if (!existsSync(path)) return { file: null, offset: 0 };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LogCursor;
  } catch {
    return { file: null, offset: 0 };
  }
}

export function writeCursor(dataDir: string, cursor: LogCursor): void {
  writeFileSync(cursorPath(dataDir), JSON.stringify(cursor), "utf8");
}
