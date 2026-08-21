import type { FastifyReply, FastifyRequest } from "fastify";

export const SESSION_COOKIE = "obs_monitor_sid";

export function cookieSecure(req: FastifyRequest): boolean {
  const forwarded = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim();
  return req.protocol === "https" || forwarded === "https";
}

export function readCookie(req: FastifyRequest, name: string): string | undefined {
  const header = req.headers.cookie;
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return part.slice(idx + 1).trim();
    }
  }
  return undefined;
}

export function setSessionCookie(
  reply: FastifyReply,
  id: string,
  opts: { maxAgeSec: number; secure: boolean },
): void {
  reply.header("Set-Cookie", serialize(SESSION_COOKIE, id, opts));
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.header("Set-Cookie", serialize(SESSION_COOKIE, "", { maxAgeSec: 0, secure }));
}

function serialize(name: string, value: string, opts: { maxAgeSec: number; secure: boolean }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSec))}`,
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}
