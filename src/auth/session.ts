import { randomBytes } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AccountUser } from "../shared/types.ts";
import { SESSION_COOKIE, readCookie } from "./cookie.ts";

export type Session = {
  id: string;
  user: AccountUser;
  expiresAt: number;
};

export class SessionStore {
  private sessions = new Map<string, Session>();

  constructor(private readonly ttlMs: number) {}

  get ttlSec(): number {
    return Math.floor(this.ttlMs / 1000);
  }

  create(user: AccountUser): Session {
    const session: Session = {
      id: randomBytes(24).toString("hex"),
      user: { ...user },
      expiresAt: Date.now() + this.ttlMs,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (Date.now() >= session.expiresAt) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  fromRequest(req: FastifyRequest): Session | undefined {
    return this.get(readCookie(req, SESSION_COOKIE));
  }

  revoke(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  revokeUser(userId: string): void {
    for (const [id, session] of this.sessions) {
      if (session.user.id === userId) this.sessions.delete(id);
    }
  }

  touchUser(user: AccountUser): void {
    for (const session of this.sessions.values()) {
      if (session.user.id === user.id) session.user = { ...user };
    }
  }
}
