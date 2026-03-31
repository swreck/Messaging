import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

interface Workspace {
  id: string;
  name: string;
  role: string;
  offeringCount: number;
  audienceCount: number;
}

interface WorkspaceContextType {
  workspaces: Workspace[];
  activeWorkspace: Workspace | null;
  switchWorkspace: (id: string) => void;
  loading: boolean;
  reload: () => Promise<void>;
}

const WorkspaceCtx = createContext<WorkspaceContextType>({
  workspaces: [],
  activeWorkspace: null,
  switchWorkspace: () => {},
  loading: true,
  reload: async () => {},
});

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => api.getWorkspaceId());
  const [loading, setLoading] = useState(true);

  const loadWorkspaces = useCallback(async () => {
    if (!user) return;
    try {
      const { workspaces: ws } = await api.get<{ workspaces: Workspace[] }>('/workspaces');
      setWorkspaces(ws);

      // If no active workspace set, or active workspace no longer exists, pick the first one
      const currentId = api.getWorkspaceId();
      const valid = ws.find(w => w.id === currentId);
      if (!valid && ws.length > 0) {
        api.setWorkspaceId(ws[0].id);
        setActiveId(ws[0].id);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => { loadWorkspaces(); }, [loadWorkspaces]);

  const switchWorkspace = useCallback((id: string) => {
    api.setWorkspaceId(id);
    setActiveId(id);
    // Reload the page to refresh all data for the new workspace
    window.location.reload();
  }, []);

  const activeWorkspace = workspaces.find(w => w.id === activeId) || null;

  return (
    <WorkspaceCtx.Provider value={{ workspaces, activeWorkspace, switchWorkspace, loading, reload: loadWorkspaces }}>
      {children}
    </WorkspaceCtx.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceCtx);
}
