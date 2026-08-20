import type { LogCategory, LogLevel } from "../shared/types.ts";

const ERROR_RE =
  /\b(error|failed|failure|crash|fatal|disconnected|disconnect|overload|timed out|timeout|cannot|couldn't|unable)\b|失败|断开|崩溃|过载/i;
const WARN_RE =
  /\b(warning|warn|lag|skipped|dropped|congestion|reconnect|stalled|retry)\b|警告|重连|掉帧|拥塞/i;

const CATEGORY_RULES: Array<[LogCategory, RegExp]> = [
  ["alert", /报警|恢复|webhook/i],
  [
    "connection",
    /rtmp|websocket|reconnect|disconnect|socket|failed to connect|connection|streaming|output.*(?:start|stop)|推流|重连|失联/i,
  ],
  ["encoder", /encoder|nvenc|qsv|amf|x264|x265|ffmpeg|bitrate|encode|编码器|码率/i],
  ["render", /render|lagged|skipped frames|d3d|dwm|gpu|compositor|渲染|掉帧/i],
  ["audio", /wasapi|audio|mute|monitoring|sample rate|mic|音频|静音/i],
  [
    "source",
    /dshow|device|browser|capture|source|game capture|window capture|media source|failed to open|源/i,
  ],
  ["system", /\bobs\b|plugin|crash|exception|hotkey|profile|recording|插件|崩溃|配置/i],
];

export function classifyLevel(line: string): LogLevel {
  if (ERROR_RE.test(line)) return "error";
  if (WARN_RE.test(line)) return "warn";
  return "info";
}

export function classifyCategory(line: string): LogCategory {
  for (const [category, re] of CATEGORY_RULES) {
    if (re.test(line)) return category;
  }
  return "other";
}

export function redact(line: string): string {
  return line
    .replace(/(rtmps?:\/\/[^\s/]+\/[^\s]*\/)[^\s]+/gi, "$1***")
    .replace(/(stream[_-]?key|password|token|secret|key)\s*[:=]\s*\S+/gi, "$1=***")
    .replace(/([?&](?:key|psk|password|token|sk)=)[^&\s]+/gi, "$1***");
}

export function parseObsLineTime(fileName: string, line: string, fallback: number): number {
  const date = fileName.match(/^(\d{4}-\d{2}-\d{2})/);
  const time = line.match(/^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!date || !time) return fallback;
  const ms = Number((time[4] ?? "0").padEnd(3, "0").slice(0, 3));
  const ts = new Date(`${date[1]}T${time[1]}:${time[2]}:${time[3]}.${String(ms).padStart(3, "0")}`).getTime();
  return Number.isNaN(ts) ? fallback : ts;
}
