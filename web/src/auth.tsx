import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AccountUser, AuthMe } from "../../src/shared/types.ts";
import { fetchMe, login as loginRequest, logout as logoutRequest } from "./api";

type AuthState = {
  loading: boolean;
  user: AccountUser | null;
  webhookConfigured: boolean | null;
  quality: AuthMe["quality"];
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const defaultQuality = { minKbps: 2000, maxKbps: 3100, holdSec: 5 };

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AccountUser | null>(null);
  const [webhookConfigured, setWebhookConfigured] = useState<boolean | null>(null);
  const [quality, setQuality] = useState(defaultQuality);

  function apply(data: AuthMe): void {
    setUser(data.user);
    setWebhookConfigured(data.webhookConfigured);
    setQuality(data.quality);
  }

  useEffect(() => {
    let cancelled = false;
    void fetchMe()
      .then((data) => {
        if (!cancelled) apply(data);
      })
      .catch(() => {
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const onNeed = () => setUser(null);
    window.addEventListener("auth:required", onNeed);
    return () => {
      cancelled = true;
      window.removeEventListener("auth:required", onNeed);
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      loading,
      user,
      webhookConfigured,
      quality,
      login: async (username, password) => {
        apply(await loginRequest(username, password));
      },
      logout: async () => {
        try {
          await logoutRequest();
        } finally {
          setUser(null);
        }
      },
    }),
    [loading, user, webhookConfigured, quality],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 需要 AuthProvider");
  return ctx;
}
