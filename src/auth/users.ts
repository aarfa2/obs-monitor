import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AccountUser } from "../shared/types.ts";
import { hashPassword, verifyPassword } from "./password.ts";

export type StoredUser = AccountUser & { passwordHash: string };

type FileShape = { users: StoredUser[] };

const USERNAME_RE = /^[a-zA-Z0-9._-]{2,32}$/;

export class UserStore {
  private users = new Map<string, StoredUser>();
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "users.json");
    mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  list(): AccountUser[] {
    return [...this.users.values()]
      .map(publicUser)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): StoredUser | undefined {
    return this.users.get(id);
  }

  findByUsername(username: string): StoredUser | undefined {
    const key = username.trim().toLowerCase();
    for (const user of this.users.values()) {
      if (user.username.toLowerCase() === key) return user;
    }
    return undefined;
  }

  async authenticate(username: string, password: string): Promise<AccountUser | null> {
    const user = this.findByUsername(username);
    if (!user) {
      await hashPassword(password);
      return null;
    }
    if (!(await verifyPassword(password, user.passwordHash))) return null;
    return publicUser(user);
  }

  async create(username: string, password: string, admin: boolean): Promise<AccountUser> {
    const name = normalizeUsername(username);
    assertPassword(password);
    if (this.findByUsername(name)) throw new UserError("用户名已存在");
    const user: StoredUser = {
      id: randomUUID(),
      username: name,
      passwordHash: await hashPassword(password),
      admin,
      createdAt: Date.now(),
    };
    this.users.set(user.id, user);
    this.save();
    return publicUser(user);
  }

  async update(
    id: string,
    patch: { password?: string; admin?: boolean },
  ): Promise<AccountUser> {
    const user = this.users.get(id);
    if (!user) throw new UserError("用户不存在");
    if (patch.password !== undefined) {
      assertPassword(patch.password);
      user.passwordHash = await hashPassword(patch.password);
    }
    if (patch.admin !== undefined) {
      if (user.admin && !patch.admin && this.adminCount() <= 1) {
        throw new UserError("不能取消最后一名管理员");
      }
      user.admin = patch.admin;
    }
    this.save();
    return publicUser(user);
  }

  remove(id: string): void {
    const user = this.users.get(id);
    if (!user) throw new UserError("用户不存在");
    if (user.admin && this.adminCount() <= 1) {
      throw new UserError("不能删除最后一名管理员");
    }
    this.users.delete(id);
    this.save();
  }

  async ensureSeed(admin: { username: string; password: string }): Promise<void> {
    if (this.users.size > 0) return;
    const username = admin.username.trim();
    const password = admin.password;
    if (!username || !password) {
      console.warn("用户表为空：请在 config.json 填写 admin.username / admin.password，或运行 npm run user:add");
      return;
    }
    try {
      await this.create(username, password, true);
      console.log(`已创建初始管理员 ${username}`);
    } catch (err) {
      if (err instanceof UserError) {
        console.warn(`无法创建初始管理员: ${err.message}`);
        return;
      }
      throw err;
    }
  }

  private adminCount(): number {
    let n = 0;
    for (const user of this.users.values()) if (user.admin) n += 1;
    return n;
  }

  private load(): void {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as FileShape;
      for (const user of parsed.users ?? []) {
        if (!user?.id || !user.username || !user.passwordHash) continue;
        this.users.set(user.id, user);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`无法读取 ${this.file}: ${message}`);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const body: FileShape = { users: [...this.users.values()] };
    writeFileSync(this.file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  }
}

export class UserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserError";
  }
}

function publicUser(user: StoredUser): AccountUser {
  return {
    id: user.id,
    username: user.username,
    admin: user.admin,
    createdAt: user.createdAt,
  };
}

function normalizeUsername(username: string): string {
  const name = username.trim();
  if (!USERNAME_RE.test(name)) {
    throw new UserError("用户名需为 2–32 位字母、数字、点、下划线或短横线");
  }
  return name;
}

function assertPassword(password: string): void {
  if (password.length < 8 || password.length > 200) {
    throw new UserError("密码长度需为 8–200 位");
  }
}
