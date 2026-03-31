const API_BASE = import.meta.env.VITE_API_URL || '/api';

class ApiClient {
  private token: string | null = null;
  private workspaceId: string | null = null;
  private tokenRefreshed = false;

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
  }

  getToken(): string | null {
    if (!this.token) {
      this.token = localStorage.getItem('token');
    }
    return this.token;
  }

  setWorkspaceId(id: string | null) {
    this.workspaceId = id;
    if (id) {
      localStorage.setItem('maria-workspace-id', id);
    } else {
      localStorage.removeItem('maria-workspace-id');
    }
  }

  getWorkspaceId(): string | null {
    if (!this.workspaceId) {
      this.workspaceId = localStorage.getItem('maria-workspace-id');
    }
    return this.workspaceId;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const wsId = this.getWorkspaceId();
    if (wsId) {
      headers['x-workspace-id'] = wsId;
    }

    const res = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    });

    if (res.status === 401) {
      this.setToken(null);
      window.location.href = '/login';
      throw new Error('Authentication required');
    }

    // Sliding window token refresh: silently update if backend issued a fresh token
    // Only accept the first refresh per page load to avoid races from parallel requests
    const refreshedToken = res.headers.get('x-refreshed-token');
    if (refreshedToken && !this.tokenRefreshed) {
      this.tokenRefreshed = true;
      this.setToken(refreshedToken);
    }

    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || `Request failed: ${res.status}`);
    }

    return data as T;
  }

  get<T>(path: string) {
    return this.request<T>(path);
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  put<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
  }

  patch<T>(path: string, body?: unknown) {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }
}

export const api = new ApiClient();
