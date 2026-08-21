import { useAuth } from "./auth";

export function AccountBar() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <div className="account-bar">
      <span className="muted">
        {user.username}
        {user.admin ? " · 管理员" : ""}
      </span>
      {user.admin && (
        <a className="back" href="#/users">
          用户
        </a>
      )}
      <button type="button" onClick={() => void logout()}>
        退出
      </button>
    </div>
  );
}
