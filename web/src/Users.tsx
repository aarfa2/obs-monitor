import { useEffect, useState, type FormEvent } from "react";
import type { AccountUser } from "../../src/shared/types.ts";
import { ApiError, createUser, deleteUser, fetchUsers, patchUser } from "./api";
import { useAuth } from "./auth";
import { AccountBar } from "./AccountBar";

export function UsersPage() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AccountUser[]>([]);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [admin, setAdmin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [resetId, setResetId] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  async function reload() {
    const data = await fetchUsers();
    setUsers(data.users);
  }

  useEffect(() => {
    void reload().catch((err) => {
      setError(err instanceof ApiError ? err.message : "无法加载用户");
    });
  }, []);

  async function onCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await createUser({ username, password, admin });
      setUsername("");
      setPassword("");
      setAdmin(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function toggleAdmin(user: AccountUser) {
    setError("");
    try {
      await patchUser(user.id, { admin: !user.admin });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "更新失败");
    }
  }

  async function onReset(id: string) {
    setError("");
    try {
      await patchUser(id, { password: resetPassword });
      setResetId(null);
      setResetPassword("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "重置失败");
    }
  }

  async function onDelete(user: AccountUser) {
    if (!window.confirm(`删除用户 ${user.username}？`)) return;
    setError("");
    try {
      await deleteUser(user.id);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "删除失败");
    }
  }

  return (
    <div className="page">
      <header className="top">
        <div>
          <p className="kicker">
            <a className="back" href="#/">
              机群
            </a>
          </p>
          <h1>用户</h1>
        </div>
        <AccountBar />
      </header>

      <section className="panel users-panel">
        <h2>新建账号</h2>
        <form className="user-form" onSubmit={(event) => void onCreate(event)}>
          <input
            placeholder="用户名"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <input
            placeholder="密码（至少 8 位）"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className="check">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} />
            管理员
          </label>
          <button type="submit" disabled={busy || !username || !password}>
            {busy ? "创建中…" : "创建"}
          </button>
        </form>
        <p className="muted">普通用户只能看看板。管理员可以管账号、测试 Webhook。</p>
        {error && <p className="error-line">{error}</p>}
      </section>

      <section className="panel users-panel">
        <h2>已有账号</h2>
        <table className="users-table">
          <thead>
            <tr>
              <th>用户名</th>
              <th>角色</th>
              <th>创建时间</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>
                  {user.username}
                  {user.id === me?.id ? <span className="muted"> · 当前</span> : null}
                </td>
                <td>{user.admin ? "管理员" : "值班"}</td>
                <td>{formatTime(user.createdAt)}</td>
                <td className="user-actions">
                  <button type="button" onClick={() => void toggleAdmin(user)}>
                    {user.admin ? "取消管理员" : "设为管理员"}
                  </button>
                  {resetId === user.id ? (
                    <span className="reset-inline">
                      <input
                        type="password"
                        placeholder="新密码"
                        value={resetPassword}
                        onChange={(e) => setResetPassword(e.target.value)}
                      />
                      <button type="button" disabled={resetPassword.length < 8} onClick={() => void onReset(user.id)}>
                        保存
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setResetId(null);
                          setResetPassword("");
                        }}
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setResetId(user.id);
                        setResetPassword("");
                      }}
                    >
                      重置密码
                    </button>
                  )}
                  <button type="button" disabled={user.id === me?.id} onClick={() => void onDelete(user)}>
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { hour12: false });
}
