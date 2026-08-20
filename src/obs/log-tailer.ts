import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import type { LogSink } from "../shared/types.ts";
import { classifyCategory, classifyLevel, parseObsLineTime, redact } from "../logs/classify.ts";
import { readCursor, writeCursor } from "../logs/store.ts";

export class ObsLogTailer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private offset = 0;
  private file: string | null = null;

  constructor(
    private readonly store: LogSink,
    private readonly dataDir: string,
  ) {}

  start(): void {
    const cursor = readCursor(this.dataDir);
    this.file = cursor.file;
    this.offset = cursor.offset;
    this.tick();
    this.timer = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.saveCursor();
  }

  snapshot(): { file: string | null } {
    return { file: this.file };
  }

  private tick(): void {
    const dir = logsDir();
    if (!dir || !existsSync(dir)) {
      this.file = null;
      this.offset = 0;
      return;
    }
    const latest = latestLogFile(dir);
    if (!latest) return;

    if (latest !== this.file) {
      this.file = latest;
      this.offset = 0;
    }

    const size = statSync(latest).size;
    if (size < this.offset) this.offset = 0;
    if (size === this.offset) return;

    const chunk = readSlice(latest, this.offset, size);
    this.offset = size;
    this.ingest(latest, chunk);
    this.saveCursor();
  }

  private ingest(path: string, text: string): void {
    const name = basename(path);
    const now = Date.now();
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => {
        const redacted = redact(line);
        return {
          ts: parseObsLineTime(name, redacted, now),
          level: classifyLevel(redacted),
          category: classifyCategory(redacted),
          source: "obs" as const,
          text: redacted,
        };
      });
    this.store.append(rows);
  }

  private saveCursor(): void {
    writeCursor(this.dataDir, { file: this.file, offset: this.offset });
  }
}

export function pruneOldObsLogs(keepFile: string | null, retainMs = 24 * 60 * 60 * 1000): number {
  const dir = logsDir();
  if (!dir || !existsSync(dir)) return 0;
  const cutoff = Date.now() - retainMs;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".txt")) continue;
    const path = join(dir, name);
    if (keepFile && path === keepFile) continue;
    try {
      if (statSync(path).mtimeMs >= cutoff) continue;
      unlinkSync(path);
      removed += 1;
    } catch {
      /* OBS 可能正占用文件 */
    }
  }
  return removed;
}

function logsDir(): string | null {
  const appdata = process.env.APPDATA;
  if (!appdata) return null;
  return join(appdata, "obs-studio", "logs");
}

function latestLogFile(dir: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".txt")) continue;
    const path = join(dir, name);
    const mtime = statSync(path).mtimeMs;
    if (!best || mtime > best.mtime) best = { path, mtime };
  }
  return best?.path ?? null;
}

function readSlice(path: string, start: number, end: number): string {
  if (end <= start) return "";
  return readFileSync(path).subarray(start, end).toString("utf8");
}
