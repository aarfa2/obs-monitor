import { parseArgs } from "node:util";
import { join } from "node:path";
import { projectRoot } from "./config.ts";
import { UserError, UserStore } from "./auth/users.ts";

const { values } = parseArgs({
  options: {
    username: { type: "string", short: "u" },
    password: { type: "string", short: "p" },
    admin: { type: "boolean", default: false },
  },
  allowPositionals: true,
});

const username = values.username ?? "";
const password = values.password ?? "";
if (!username || !password) {
  console.error("用法: npm run user:add -- --username 名 --password 密码 [--admin]");
  process.exit(1);
}

try {
  const users = new UserStore(join(projectRoot(), "data"));
  if (users.findByUsername(username)) {
    console.error(`用户 ${username} 已存在`);
    process.exit(1);
  }
  const user = await users.create(username, password, Boolean(values.admin));
  console.log(`已创建 ${user.admin ? "管理员" : "用户"} ${user.username}`);
} catch (err) {
  const message = err instanceof UserError || err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
}
