import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { api } from '../api/client';
import type { User } from '../types';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (inviteCode: string, username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const token = api.getToken();
    if (token) {
      api.get<{ user: User }>('/auth/me')
        .then(({ user }) => setUser(user))
        .catch(() => api.setToken(null))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (username: string, password: string) => {
    const { token, user } = await api.post<{ token: string; user: User }>('/auth/login', { username, password });
    api.setToken(token);
    setUser(user);
  };

  const register = async (inviteCode: string, username: string, password: string) => {
    const { token, user } = await api.post<{ token: string; user: User }>('/auth/register', { inviteCode, username, password });
    api.setToken(token);
    setUser(user);
  };

  const logout = () => {
    api.setToken(null);
    setUser(null);
  };

  // Refresh the user object from /auth/me. Called after actions that change
  // display name or other presentation fields so the top nav and other
  // user-binding UI reflect the update without a full page reload.
  const refreshUser = async () => {
    try {
      const { user: fresh } = await api.get<{ user: User }>('/auth/me');
      setUser(fresh);
    } catch {
      // silent — if refresh fails, keep the stale user object rather than logging out
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
