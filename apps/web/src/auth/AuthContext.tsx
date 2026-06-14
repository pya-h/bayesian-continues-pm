// Auth state. The token lives in localStorage; on mount we re-hydrate the user
// from `/auth/me` if a token is present, so a refresh keeps you logged in.

import { type ReactNode, createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, getToken, setToken, setUnauthorizedHandler } from '../lib/api.ts';
import type { PublicUser } from '../lib/types.ts';

interface AuthState {
  user: PublicUser | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
  setUser: (u: PublicUser) => void;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  // A 401 on any authenticated request (mount-time /auth/me, or mid-session token
  // expiry) clears the React session; the api client has already dropped the token.
  // RequireAuth then bounces to /login. Network/5xx failures don't reach here, so a
  // transient blip can't log a valid session out.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((r) => setUser(r.user))
      // The api client drops the token only on a genuine 401; a network/5xx failure
      // here keeps it, so the session re-hydrates on the next reachable request.
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const r = await api.login(username, password);
    setToken(r.token);
    setUser(r.user);
  }, []);

  const register = useCallback(async (username: string, password: string) => {
    const r = await api.register(username, password);
    setToken(r.token);
    setUser(r.user);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, login, register, logout, setUser }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}
