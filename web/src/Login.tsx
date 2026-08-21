import { useState, type FormEvent } from "react";
import { ApiError } from "./api";
import { useAuth } from "./auth";

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={(event) => void onSubmit(event)}>
        <p className="kicker">OBS MONITOR</p>
        <h1>登录</h1>
        <p className="muted">内部值班账号，采集器仍用中心 token 接入。</p>
        <label>
          用户名
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          密码
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <p className="error-line">{error}</p>}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? "登录中…" : "进入看板"}
        </button>
      </form>
    </div>
  );
}
