import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AccountUser, AuthMe } from "../shared/types.ts";
import { clearSessionCookie, cookieSecure, setSessionCookie } from "./cookie.ts";
import { LoginGate } from "./rate-limit.ts";
import { SessionStore } from "./session.ts";
import { UserError, UserStore } from "./users.ts";

export type AuthContext = {
  users: UserStore;
  sessions: SessionStore;
  loginGate: LoginGate;
  meta: () => Omit<AuthMe, "user">;
};

export function isPublicPath(url: string, method: string): boolean {
  const path = url.split("?")[0];
  if (path === "/api/health") return true;
  if (path === "/api/auth/login" && method === "POST") return true;
  if (path === "/api/auth/logout" && method === "POST") return true;
  if (path === "/agent") return true;
  if (!path.startsWith("/api")) return true;
  return false;
}

export function registerAuth(app: FastifyInstance, ctx: AuthContext): void {
  app.addHook("preHandler", async (req, reply) => {
    if (isPublicPath(req.url, req.method)) return;
    const session = ctx.sessions.fromRequest(req);
    if (!session) {
      return reply.code(401).send({ error: "未登录" });
    }
    req.account = session.user;
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    if (!username || !password) {
      return reply.code(400).send({ error: "请输入用户名和密码" });
    }
    const ipKey = `ip:${req.ip}`;
    const userKey = `user:${username.toLowerCase()}`;
    if (ctx.loginGate.blocked(ipKey) || ctx.loginGate.blocked(userKey)) {
      return reply.code(429).send({ error: "尝试次数过多，请稍后再试" });
    }
    const user = await ctx.users.authenticate(username, password);
    if (!user) {
      ctx.loginGate.fail(ipKey);
      ctx.loginGate.fail(userKey);
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    ctx.loginGate.ok(ipKey);
    ctx.loginGate.ok(userKey);
    const session = ctx.sessions.create(user);
    setSessionCookie(reply, session.id, {
      maxAgeSec: ctx.sessions.ttlSec,
      secure: cookieSecure(req),
    });
    return { user, ...ctx.meta() } satisfies AuthMe;
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const session = ctx.sessions.fromRequest(req);
    ctx.sessions.revoke(session?.id);
    clearSessionCookie(reply, cookieSecure(req));
    return { ok: true };
  });

  app.get("/api/auth/me", async (req, reply) => {
    if (!req.account) return reply.code(401).send({ error: "未登录" });
    return { user: req.account, ...ctx.meta() } satisfies AuthMe;
  });

  app.get("/api/users", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    return { users: ctx.users.list() };
  });

  app.post("/api/users", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { username?: string; password?: string; admin?: boolean };
    try {
      const user = await ctx.users.create(String(body.username ?? ""), String(body.password ?? ""), Boolean(body.admin));
      return { user };
    } catch (err) {
      return userError(reply, err);
    }
  });

  app.patch("/api/users/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { password?: string; admin?: boolean };
    try {
      const user = await ctx.users.update(id, {
        password: body.password ? body.password : undefined,
        admin: body.admin,
      });
      ctx.sessions.touchUser(user);
      if (body.password) ctx.sessions.revokeUser(id);
      return { user };
    } catch (err) {
      return userError(reply, err);
    }
  });

  app.delete("/api/users/:id", async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    if (id === req.account?.id) {
      return reply.code(400).send({ error: "不能删除当前登录账号" });
    }
    try {
      ctx.users.remove(id);
      ctx.sessions.revokeUser(id);
      return { ok: true };
    } catch (err) {
      return userError(reply, err);
    }
  });
}

function requireAdmin(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.account?.admin) {
    void reply.code(403).send({ error: "需要管理员" });
    return false;
  }
  return true;
}

function userError(reply: FastifyReply, err: unknown) {
  if (err instanceof UserError) return reply.code(400).send({ error: err.message });
  throw err;
}

declare module "fastify" {
  interface FastifyRequest {
    account?: AccountUser;
  }
}
